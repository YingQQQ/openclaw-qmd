import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createQmdReader, addLineNumbers, type QmdReader } from "./src/qmd-reader.js";
import { createMemoryStore, type MemoryStore } from "./src/memory-store.js";
import { createRecallHook, createCaptureHook } from "./src/memory-hooks.js";

const qmdSubSearchSchema = Type.Object({
  type: Type.Union([Type.Literal("lex"), Type.Literal("vec"), Type.Literal("hyde")], {
    description: "qmd sub-query type.",
  }),
  query: Type.String({
    minLength: 1,
    description: "Sub-query text.",
  }),
});

const pluginConfigSchema = Type.Object({
  indexName: Type.Optional(
    Type.String({
      description: "Optional qmd index name.",
    }),
  ),
  dbPath: Type.Optional(
    Type.String({
      description: "Override path to qmd SQLite database.",
    }),
  ),
  configDir: Type.Optional(
    Type.String({
      description: "Override path to qmd config directory.",
    }),
  ),
  memoryDir: Type.Optional(
    Type.String({
      description: "Directory for memory markdown files. Enables memory features when set.",
    }),
  ),
  autoRecallLimit: Type.Optional(
    Type.Number({
      default: 5,
      minimum: 1,
      maximum: 20,
      description: "Maximum memories to recall per prompt.",
    }),
  ),
  autoRecallMinScore: Type.Optional(
    Type.Number({
      default: 0.3,
      minimum: 0,
      maximum: 1,
      description: "Minimum relevance score for recall.",
    }),
  ),
  autoCapture: Type.Optional(
    Type.Boolean({
      default: true,
      description: "Automatically capture facts/decisions from conversations.",
    }),
  ),
});

type PluginConfig = Static<typeof pluginConfigSchema>;

const statusParameters = Type.Object({});

const queryParameters = Type.Object({
  query: Type.Optional(
    Type.String({
      minLength: 1,
      description: "Plain qmd query string.",
    }),
  ),
  searches: Type.Optional(
    Type.Array(qmdSubSearchSchema, {
      minItems: 1,
      maxItems: 10,
      description: "Structured qmd sub-queries. Only 'lex' type is supported in code mode.",
    }),
  ),
  collections: Type.Optional(
    Type.Array(Type.String(), {
      minItems: 1,
      description: "Restrict results to one or more collections.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: 50,
      default: 10,
      description: "Maximum result count.",
    }),
  ),
  minScore: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: 1,
      description: "Minimum score threshold.",
    }),
  ),
  full: Type.Optional(
    Type.Boolean({
      description: "Return full document content instead of snippets.",
    }),
  ),
  lineNumbers: Type.Optional(
    Type.Boolean({
      description: "Include line numbers in text output.",
    }),
  ),
});

const getParameters = Type.Object({
  file: Type.String({
    minLength: 1,
    description: "Document path, qmd:// URI, or docid accepted by qmd get.",
  }),
  fromLine: Type.Optional(
    Type.Number({
      minimum: 1,
      description: "Start reading from this line number.",
    }),
  ),
  maxLines: Type.Optional(
    Type.Number({
      minimum: 1,
      description: "Maximum number of lines to return.",
    }),
  ),
  lineNumbers: Type.Optional(
    Type.Boolean({
      description: "Include line numbers in output.",
    }),
  ),
});

const multiGetParameters = Type.Object({
  pattern: Type.String({
    minLength: 1,
    description: "Glob pattern or comma-separated file list.",
  }),
  maxLines: Type.Optional(
    Type.Number({
      minimum: 1,
      description: "Maximum lines per file.",
    }),
  ),
  maxBytes: Type.Optional(
    Type.Number({
      minimum: 1,
      description: "Skip files larger than this many bytes.",
    }),
  ),
  lineNumbers: Type.Optional(
    Type.Boolean({
      description: "Include line numbers in output.",
    }),
  ),
});

function resolveConfig(pluginConfig: unknown): PluginConfig {
  const input = (pluginConfig ?? {}) as Partial<PluginConfig>;
  return {
    indexName: input.indexName,
    dbPath: input.dbPath,
    configDir: input.configDir,
    memoryDir: input.memoryDir,
    autoRecallLimit: input.autoRecallLimit ?? 5,
    autoRecallMinScore: input.autoRecallMinScore ?? 0.3,
    autoCapture: input.autoCapture ?? true,
  };
}

function buildQueryText(params: Static<typeof queryParameters>): string {
  if (params.searches?.length) {
    // Only lex queries are supported; vec/hyde need LLM
    const lexQueries = params.searches.filter((s) => s.type === "lex");
    if (lexQueries.length > 0) {
      return lexQueries.map((s) => s.query).join(" ");
    }
    return params.searches.map((s) => s.query).join(" ");
  }
  return params.query ?? "";
}

const memorySearchParameters = Type.Object({
  query: Type.String({
    minLength: 1,
    description: "Semantic search query for memories.",
  }),
  limit: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: 20,
      default: 5,
      description: "Maximum results.",
    }),
  ),
  minScore: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: 1,
      default: 0.3,
      description: "Minimum relevance score.",
    }),
  ),
});

const memoryGetParameters = Type.Object({
  id: Type.String({
    minLength: 1,
    description: "Memory entry id.",
  }),
});

const memoryWriteParameters = Type.Object({
  content: Type.String({
    minLength: 1,
    description: "Memory content to store.",
  }),
  category: Type.Optional(
    Type.String({
      description: "Category like 'decision', 'fact', 'preference'.",
    }),
  ),
  tags: Type.Optional(
    Type.Array(Type.String(), {
      description: "Tags for the memory.",
    }),
  ),
  title: Type.Optional(
    Type.String({
      description: "Short title for the memory file name.",
    }),
  ),
});

function registerMemoryFeatures(api: OpenClawPluginApi, config: PluginConfig, store: MemoryStore) {
  api.registerTool(
    {
      name: "memory_search",
      label: "Memory Search",
      description: "Semantically search stored memories.",
      parameters: memorySearchParameters,
      async execute(_id, params) {
        const results = await store.search(
          params.query as string,
          (params.limit as number) ?? config.autoRecallLimit!,
          (params.minScore as number) ?? config.autoRecallMinScore!,
        );
        if (!results.length) {
          return {
            content: [{ type: "text", text: "No matching memories found." }],
            details: [],
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
          details: results,
        };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "memory_get",
      label: "Memory Get",
      description: "Read a specific memory entry by id.",
      parameters: memoryGetParameters,
      async execute(_id, params) {
        const entry = await store.get(params.id as string);
        if (!entry) {
          // Graceful degradation: return empty text instead of error (per OpenClaw spec)
          return {
            content: [{ type: "text", text: "" }],
            details: { text: "", path: params.id },
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(entry, null, 2) }],
          details: entry,
        };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "memory_write",
      label: "Memory Write",
      description: "Write a new memory entry.",
      parameters: memoryWriteParameters,
      async execute(_id, params) {
        const entry = await store.write(
          params.content as string,
          params.category as string | undefined,
          params.tags as string[] | undefined,
          params.title as string | undefined,
        );
        return {
          content: [{ type: "text", text: `Memory stored: ${entry.id}` }],
          details: entry,
        };
      },
    },
    { optional: true },
  );

  api.on("before_prompt_build", createRecallHook(store, {
    autoRecallLimit: config.autoRecallLimit!,
    autoRecallMinScore: config.autoRecallMinScore!,
  }));

  if (config.autoCapture) {
    api.on("agent_end", createCaptureHook(store));
  }
}

function registerQmdTools(api: OpenClawPluginApi, reader: QmdReader) {
  api.registerTool(
    {
      name: "qmd_status",
      label: "QMD Status",
      description: "Check qmd index status: collections, document counts, embedding status.",
      parameters: statusParameters,
      async execute() {
        try {
          const status = reader.getStatus();
          return {
            content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
            details: status,
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: `Failed to get status: ${error}` }],
            isError: true,
            details: { error: String(error) },
          };
        }
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "qmd_query",
      label: "QMD Query",
      description: "Search qmd using BM25 full-text search. Supports plain query or structured lex sub-queries.",
      parameters: queryParameters,
      async execute(_id, params) {
        const queryText = buildQueryText(params);
        if (!queryText.trim()) {
          return {
            content: [{ type: "text", text: "qmd_query requires either query or searches." }],
            isError: true,
            details: { reason: "missing_query" },
          };
        }

        const limit = (params.limit as number) ?? 10;
        const minScore = params.minScore as number | undefined;
        const collection = (params.collections as string[] | undefined)?.[0];

        let results = reader.query(queryText, limit, collection);
        if (minScore !== undefined) {
          results = results.filter((r) => r.score >= minScore);
        }

        if (params.full) {
          const fullResults = results.map((r) => {
            let body = reader.getDocumentBody(r.id) ?? r.content;
            if (params.lineNumbers) {
              body = addLineNumbers(body);
            }
            return { ...r, content: body };
          });
          return {
            content: [{ type: "text", text: JSON.stringify(fullResults, null, 2) }],
            details: fullResults,
          };
        }

        return {
          content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
          details: results,
        };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "qmd_get",
      label: "QMD Get",
      description: "Read a qmd document by file path, qmd URI, or docid.",
      parameters: getParameters,
      async execute(_id, params) {
        const file = params.file as string;
        const result = reader.findDocument(file);

        if ("error" in result) {
          let msg = `Document not found: ${result.query}`;
          if (result.similarFiles.length > 0) {
            msg += `\nDid you mean: ${result.similarFiles.join(", ")}?`;
          }
          return {
            content: [{ type: "text", text: msg }],
            isError: true,
            details: result,
          };
        }

        const fromLine = params.fromLine as number | undefined;
        const maxLines = params.maxLines as number | undefined;
        let body = reader.getDocumentBody(result.filepath, fromLine, maxLines);

        if (body === null) {
          return {
            content: [{ type: "text", text: `Document found but body not available: ${result.filepath}` }],
            isError: true,
            details: result,
          };
        }

        if (params.lineNumbers) {
          body = addLineNumbers(body, fromLine ?? 1);
        }

        const header = [
          `# ${result.displayPath}`,
          result.context ? `Context: ${result.context}` : null,
          `Collection: ${result.collectionName} | docid: ${result.docid}`,
          "",
        ].filter((l) => l !== null).join("\n");

        return {
          content: [{ type: "text", text: header + body }],
          details: { ...result, body },
        };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "qmd_multi_get",
      label: "QMD Multi-Get",
      description: "Read multiple qmd documents by glob pattern or comma-separated file list.",
      parameters: multiGetParameters,
      async execute(_id, params) {
        const pattern = params.pattern as string;
        const maxBytes = params.maxBytes as number | undefined;
        const maxLines = params.maxLines as number | undefined;

        const result = reader.findDocuments(pattern, { maxBytes, includeBody: true });

        const output: string[] = [];

        for (const { doc, skipped, skipReason } of result.docs) {
          if (skipped) {
            output.push(`--- ${doc.displayPath} (SKIPPED: ${skipReason}) ---`);
            continue;
          }

          let body = doc.body ?? reader.getDocumentBody(doc.filepath) ?? "";
          if (maxLines) {
            body = body.split("\n").slice(0, maxLines).join("\n");
          }
          if (params.lineNumbers) {
            body = addLineNumbers(body);
          }

          output.push(`--- ${doc.displayPath} ---\n${body}`);
        }

        for (const err of result.errors) {
          output.push(`ERROR: ${err}`);
        }

        const json = {
          files: result.docs.map(({ doc, skipped, skipReason }) => ({
            filepath: doc.filepath,
            displayPath: doc.displayPath,
            title: doc.title,
            docid: doc.docid,
            skipped,
            skipReason,
          })),
          errors: result.errors,
        };

        return {
          content: [{ type: "text", text: output.join("\n\n") || "(no results)" }],
          details: json,
        };
      },
    },
    { optional: true },
  );
}

const plugin = {
  id: "qmd",
  name: "QMD",
  kind: "memory" as const,
  description: "OpenClaw plugin for querying a local qmd knowledge base with optional memory backend.",
  configSchema: pluginConfigSchema,
  register(api: OpenClawPluginApi) {
    const config = resolveConfig(api.pluginConfig);

    // 初始化 qmd reader（直接读取 qmd 的 SQLite 数据库，无需 CLI）
    createQmdReader({
      indexName: config.indexName,
      dbPath: config.dbPath,
      configDir: config.configDir,
    }).then((reader) => {
      registerQmdTools(api, reader);
    }).catch((err) => {
      // qmd 数据库不存在时静默跳过，只注册 memory 功能
      if (String(err).includes("SQLITE_CANTOPEN") || String(err).includes("ENOENT")) {
        return;
      }
      throw err;
    });

    // Memory 功能
    if (config.memoryDir) {
      createMemoryStore({
        memoryDir: config.memoryDir,
      }).then((store) => {
        registerMemoryFeatures(api, config, store);
      });
    }
  },
};

export default plugin;

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
  captureMode: Type.Optional(
    Type.Union([Type.Literal("semantic"), Type.Literal("keyword")], {
      default: "keyword",
      description: "Capture mode: 'semantic' captures all non-noise text; 'keyword' uses trigger patterns.",
    }),
  ),
  captureMaxLength: Type.Optional(
    Type.Number({
      default: 500,
      minimum: 50,
      maximum: 10000,
      description: "Maximum text length for auto-capture.",
    }),
  ),
  scope: Type.Optional(
    Type.String({
      description: "Memory scope (e.g. 'global', 'project:<path>'). Isolates memories by scope.",
    }),
  ),
  learningsDir: Type.Optional(
    Type.String({
      description: "Directory for agent self-improvement files (LEARNINGS.md, ERRORS.md).",
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
    captureMode: input.captureMode ?? "keyword",
    captureMaxLength: input.captureMaxLength ?? 500,
    scope: input.scope,
    learningsDir: input.learningsDir,
  };
}

function buildQueryText(params: Static<typeof queryParameters>): string {
  if (params.searches?.length) {
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
      description: "Category: profile, preference, entity, event, case, pattern.",
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

const memoryForgetParameters = Type.Object({
  id: Type.Optional(
    Type.String({
      description: "Exact memory id to delete.",
    }),
  ),
  query: Type.Optional(
    Type.String({
      description: "Search query to find memory to delete.",
    }),
  ),
});

function registerMemoryFeatures(api: OpenClawPluginApi, config: PluginConfig, store: MemoryStore) {
  api.registerTool(
    {
      name: "memory_search",
      label: "Memory Search",
      description: "Search stored memories using BM25 full-text search.",
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
      description: "Write a new memory entry. Automatically deduplicates (skip/update/merge) against existing memories.",
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

  api.registerTool(
    {
      name: "memory_forget",
      label: "Memory Forget",
      description: "Delete a memory by id, or search for a memory to delete.",
      parameters: memoryForgetParameters,
      async execute(_id, params) {
        const directId = params.id as string | undefined;
        if (directId) {
          const deleted = await store.delete(directId);
          if (deleted) {
            return {
              content: [{ type: "text", text: `Forgotten: ${directId}` }],
              details: { action: "deleted", id: directId },
            };
          }
          return {
            content: [{ type: "text", text: `Memory not found: ${directId}` }],
            details: { action: "not_found", id: directId },
          };
        }

        const query = params.query as string | undefined;
        if (!query) {
          return {
            content: [{ type: "text", text: "Provide id or query." }],
            details: { error: "missing_param" },
          };
        }

        const candidates = await store.search(query, 5, 0.3);
        if (!candidates.length) {
          return {
            content: [{ type: "text", text: "No matching memories found." }],
            details: { action: "none" },
          };
        }

        // 高分单一匹配自动删除
        if (candidates.length === 1 && candidates[0].score >= 0.85) {
          const deleted = await store.delete(candidates[0].id);
          return {
            content: [{ type: "text", text: deleted ? `Forgotten: ${candidates[0].id}` : `Failed to delete: ${candidates[0].id}` }],
            details: { action: deleted ? "deleted" : "failed", id: candidates[0].id },
          };
        }

        // 多条候选：返回列表
        const list = candidates
          .map((c) => `- ${c.id} (${(c.score * 100).toFixed(0)}%) [${c.category ?? "memory"}] ${c.content.slice(0, 80)}`)
          .join("\n");
        return {
          content: [{ type: "text", text: `Found ${candidates.length} candidates. Specify id:\n${list}` }],
          details: { action: "candidates", candidates },
        };
      },
    },
    { optional: true },
  );

  api.on("before_prompt_build", createRecallHook(store, {
    autoRecallLimit: config.autoRecallLimit!,
    autoRecallMinScore: config.autoRecallMinScore!,
    learningsDir: config.learningsDir,
  }));

  if (config.autoCapture) {
    api.on("agent_end", createCaptureHook(store, {
      captureMode: config.captureMode,
      captureMaxLength: config.captureMaxLength,
      learningsDir: config.learningsDir,
    }));
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
  description: "OpenClaw plugin for querying a local qmd knowledge base with memory backend.",
  configSchema: pluginConfigSchema,
  register(api: OpenClawPluginApi) {
    const config = resolveConfig(api.pluginConfig);

    // 初始化 qmd reader
    createQmdReader({
      indexName: config.indexName,
      dbPath: config.dbPath,
      configDir: config.configDir,
    }).then((reader) => {
      registerQmdTools(api, reader);
    }).catch((err) => {
      if (String(err).includes("SQLITE_CANTOPEN") || String(err).includes("ENOENT")) {
        return;
      }
      throw err;
    });

    // Memory 功能
    if (config.memoryDir) {
      createMemoryStore({
        memoryDir: config.memoryDir,
        scope: config.scope,
      }).then((store) => {
        registerMemoryFeatures(api, config, store);
      });
    }
  },
};

export default plugin;

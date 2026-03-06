import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { runQmd } from "./src/qmd.js";

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
  command: Type.String({
    default: "qmd",
    description: "Path to the qmd executable or wrapper script.",
  }),
  cwd: Type.Optional(
    Type.String({
      description: "Default working directory for qmd commands.",
    }),
  ),
  indexName: Type.Optional(
    Type.String({
      description: "Optional qmd index name passed as --index.",
    }),
  ),
  timeoutMs: Type.Number({
    default: 30000,
    minimum: 1000,
    maximum: 300000,
    description: "Maximum execution time for qmd commands.",
  }),
});

type PluginConfig = Static<typeof pluginConfigSchema>;

const statusParameters = Type.Object({
  cwd: Type.Optional(
    Type.String({
      description: "Override working directory for this call.",
    }),
  ),
});

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
      description: "Structured qmd sub-queries. Converted to the multiline query document format.",
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
  cwd: Type.Optional(
    Type.String({
      description: "Override working directory for this call.",
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
  cwd: Type.Optional(
    Type.String({
      description: "Override working directory for this call.",
    }),
  ),
});

const multiGetParameters = Type.Object({
  pattern: Type.String({
    minLength: 1,
    description: "Glob pattern or comma-separated file list accepted by qmd multi-get.",
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
  cwd: Type.Optional(
    Type.String({
      description: "Override working directory for this call.",
    }),
  ),
});

function resolveConfig(pluginConfig: unknown): PluginConfig {
  const input = (pluginConfig ?? {}) as Partial<PluginConfig>;
  return {
    command: input.command ?? "qmd",
    cwd: input.cwd,
    indexName: input.indexName,
    timeoutMs: input.timeoutMs ?? 30000,
  };
}

function buildBaseArgs(config: PluginConfig): string[] {
  return config.indexName ? ["--index", config.indexName] : [];
}

function buildQueryDocument(params: Static<typeof queryParameters>): string {
  if (params.searches?.length) {
    return params.searches.map((entry) => `${entry.type}: ${entry.query}`).join("\n");
  }
  return params.query ?? "";
}

const plugin = {
  id: "qmd",
  name: "QMD",
  description: "OpenClaw tools for querying a local qmd knowledge base.",
  configSchema: pluginConfigSchema,
  register(api: OpenClawPluginApi) {
    const config = resolveConfig(api.pluginConfig);

    api.registerTool(
      {
        name: "qmd_status",
        label: "QMD Status",
        description: "Check qmd availability and show index status.",
        parameters: statusParameters,
        async execute(_id, params) {
          return runQmd({
            command: config.command,
            args: [...buildBaseArgs(config), "status"],
            cwd: params.cwd ?? config.cwd,
            timeoutMs: config.timeoutMs,
          });
        },
      },
      { optional: true },
    );

    api.registerTool(
      {
        name: "qmd_query",
        label: "QMD Query",
        description: "Search qmd using a plain query string or structured lex/vec/hyde sub-queries.",
        parameters: queryParameters,
        async execute(_id, params) {
          const queryDocument = buildQueryDocument(params);
          if (!queryDocument.trim()) {
            return {
              content: [
                {
                  type: "text",
                  text: "qmd_query requires either query or searches.",
                },
              ],
              isError: true,
              details: {
                reason: "missing_query",
              },
            };
          }

          const args = [...buildBaseArgs(config), "query", queryDocument, "--json"];
          if (params.limit) {
            args.push("-n", String(params.limit));
          }
          if (params.minScore !== undefined) {
            args.push("--min-score", String(params.minScore));
          }
          if (params.full) {
            args.push("--full");
          }
          if (params.lineNumbers) {
            args.push("--line-numbers");
          }
          for (const collection of params.collections ?? []) {
            args.push("--collection", collection);
          }

          return runQmd({
            command: config.command,
            args,
            cwd: params.cwd ?? config.cwd,
            timeoutMs: config.timeoutMs,
          });
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
          const args = [...buildBaseArgs(config), "get", params.file];
          if (params.fromLine) {
            args.push("--from", String(params.fromLine));
          }
          if (params.maxLines) {
            args.push("-l", String(params.maxLines));
          }
          if (params.lineNumbers) {
            args.push("--line-numbers");
          }

          return runQmd({
            command: config.command,
            args,
            cwd: params.cwd ?? config.cwd,
            timeoutMs: config.timeoutMs,
          });
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
          const args = [...buildBaseArgs(config), "multi-get", params.pattern, "--json"];
          if (params.maxLines) {
            args.push("-l", String(params.maxLines));
          }
          if (params.maxBytes) {
            args.push("--max-bytes", String(params.maxBytes));
          }
          if (params.lineNumbers) {
            args.push("--line-numbers");
          }

          return runQmd({
            command: config.command,
            args,
            cwd: params.cwd ?? config.cwd,
            timeoutMs: config.timeoutMs,
          });
        },
      },
      { optional: true },
    );
  },
};

export default plugin;

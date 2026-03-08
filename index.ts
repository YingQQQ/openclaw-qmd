import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createQmdReader, addLineNumbers, type QmdReader } from "./src/qmd-reader.js";
import { createMemoryStore, type MemoryStore } from "./src/memory-store.js";
import { createRecallHook, createCaptureHook } from "./src/memory-hooks.js";
import { buildQueryVariants, searchWithQueryVariants } from "./src/query-rewrite.js";
import { inferCategoryWeights } from "./src/query-intent.js";
import { postProcess, type ScoredResult } from "./src/post-process.js";

const qmdSubSearchSchema = Type.Object({
  type: Type.Union([Type.Literal("lex"), Type.Literal("vec"), Type.Literal("hyde")], {
    description: "qmd sub-query type.",
  }),
  query: Type.String({
    minLength: 1,
    description: "Sub-query text.",
  }),
});

const compactPolicySchema = Type.Object({
  promoteOccurrences: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })),
  promoteConfidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  promoteImportance: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  archiveAfterDays: Type.Optional(Type.Number({ minimum: 1, maximum: 3650 })),
  summarizeBeforeArchive: Type.Optional(Type.Boolean()),
});

const preconsciousPolicySchema = Type.Object({
  shortlistSize: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })),
  importanceWeight: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  confidenceWeight: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  recencyWeight: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  maxAgeDays: Type.Optional(Type.Number({ minimum: 1, maximum: 3650 })),
  categoryBoosts: Type.Optional(Type.Record(Type.String(), Type.Number({ minimum: 0, maximum: 1 }))),
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
  hybridEnabled: Type.Optional(
    Type.Boolean({
      default: true,
      description: "Enable hybrid memory retrieval (BM25 + semantic scan fusion).",
    }),
  ),
  hybridScanLimit: Type.Optional(
    Type.Number({
      default: 250,
      minimum: 0,
      maximum: 5000,
      description: "Maximum number of memories to scan in the semantic branch.",
    }),
  ),
  hybridLexicalWeight: Type.Optional(
    Type.Number({
      default: 0.7,
      minimum: 0,
      maximum: 1,
      description: "Fusion weight for lexical/BM25 matches.",
    }),
  ),
  hybridSemanticWeight: Type.Optional(
    Type.Number({
      default: 0.3,
      minimum: 0,
      maximum: 1,
      description: "Fusion weight for semantic-scan matches.",
    }),
  ),
  compactPolicy: Type.Optional(
    Type.Object({
      default: Type.Optional(compactPolicySchema),
      profile: Type.Optional(compactPolicySchema),
      preference: Type.Optional(compactPolicySchema),
      entity: Type.Optional(compactPolicySchema),
      event: Type.Optional(compactPolicySchema),
      case: Type.Optional(compactPolicySchema),
      pattern: Type.Optional(compactPolicySchema),
    }, {
      description: "Optional compaction policy overrides. Supports a global default and per-category overrides.",
    }),
  ),
  preconsciousPolicy: Type.Optional(
    Type.Object({
      ...preconsciousPolicySchema.properties,
    }, {
      description: "Optional preconscious shortlist ranking and sizing policy.",
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
  collection: Type.Optional(
    Type.String({
      description: "Restrict results to a single collection name.",
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
    hybridEnabled: input.hybridEnabled ?? true,
    hybridScanLimit: input.hybridScanLimit ?? 250,
    hybridLexicalWeight: input.hybridLexicalWeight ?? 0.7,
    hybridSemanticWeight: input.hybridSemanticWeight ?? 0.3,
    compactPolicy: input.compactPolicy,
    preconsciousPolicy: input.preconsciousPolicy,
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
  includeArchived: Type.Optional(
    Type.Boolean({
      description: "Include archived memories in historical search mode.",
    }),
  ),
});

const memoryStatsParameters = Type.Object({});
const memoryObservationListParameters = Type.Object({
  limit: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: 50,
      default: 10,
      description: "Maximum observation entries to return.",
    }),
  ),
  minConfidence: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: 1,
      default: 0,
      description: "Only include observations with confidence at or above this threshold.",
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
  importance: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: 1,
      description: "Optional importance score.",
    }),
  ),
  confidence: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: 1,
      description: "Optional confidence score.",
    }),
  ),
  expiresAt: Type.Optional(
    Type.String({
      description: "Optional ISO timestamp after which this memory should expire.",
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

const memoryCompactParameters = Type.Object({});
const memoryObservationReviewParameters = Type.Object({
  id: Type.String({
    minLength: 1,
    description: "Observation id to review.",
  }),
  action: Type.Union([
    Type.Literal("promote"),
    Type.Literal("drop"),
    Type.Literal("archive"),
  ], {
    description: "Review action to apply to the observation.",
  }),
});

function registerMemoryFeatures(api: OpenClawPluginApi, config: PluginConfig, store: MemoryStore) {
  api.registerTool(
    {
      name: "memory_search",
      label: "Memory Search",
      description: "Search stored memories using hybrid retrieval, metadata-aware reranking, and summaries.",
      parameters: memorySearchParameters,
      async execute(_id, params) {
        const limit = (params.limit as number) ?? config.autoRecallLimit!;
        const minScore = (params.minScore as number) ?? config.autoRecallMinScore!;
        const query = params.query as string;
        const includeArchived = (params.includeArchived as boolean | undefined) ?? false;
        const candidateLimit = includeArchived ? Math.max(limit * 3, 10) : limit;
        const { variants, results: rawResults } = await searchWithQueryVariants(
          includeArchived ? store.searchWithArchived : store.search,
          query,
          candidateLimit,
          minScore,
        );
        const scored = postProcess(
          rawResults.map((r) => ({
            id: r.id,
            content: r.content,
            category: r.category,
            score: r.score,
            created: r.created,
            accessCount: r.accessCount,
            lastAccessedAt: r.lastAccessedAt,
            importance: r.importance,
            confidence: r.confidence,
            sourceType: r.sourceType,
            expiresAt: r.expiresAt,
          })),
          {
            minScore,
            categoryWeights: inferCategoryWeights(query),
          },
        );
        const recalledMap = new Map(rawResults.map((r) => [r.id, r]));
        const results = scored
          .map((item) => {
            const original = recalledMap.get(item.id);
            return original ? { ...original, score: item.score } : null;
          })
          .filter((item): item is NonNullable<typeof item> => item !== null)
          .slice(0, limit);
        await store.recordAccess(results.map((item) => item.id));
        if (!results.length) {
          return {
            content: [{ type: "text", text: "No matching memories found." }],
            details: [],
          };
        }
        // 返回分层摘要而非全文，减少 token 消耗；agent 可用 memory_get 获取完整内容
        const summaryResults = results.map((r) => ({
          id: r.id,
          category: r.category,
          archived: r.archived ?? false,
          score: r.score,
          created: r.created,
          summary: r.summary ?? r.abstract ?? (r.content.length > 200 ? r.content.slice(0, 200) + "..." : r.content),
        }));
        return {
          content: [{ type: "text", text: JSON.stringify(summaryResults, null, 2) }],
          details: {
            variants,
            results,
          },
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
        const memoryId = params.id as string;
        const entry = await store.get(memoryId);
        if (!entry) {
          return {
            content: [{ type: "text", text: "" }],
            details: { text: "", path: params.id },
          };
        }
        await store.recordAccess([memoryId]);
        const refreshed = await store.get(memoryId);
        return {
          content: [{ type: "text", text: JSON.stringify(refreshed ?? entry, null, 2) }],
          details: refreshed ?? entry,
        };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "memory_search_archived",
      label: "Memory Search Archived",
      description: "Search archived long-term memories for historical context and compaction audit.",
      parameters: memorySearchParameters,
      async execute(_id, params) {
        const limit = (params.limit as number) ?? config.autoRecallLimit!;
        const minScore = (params.minScore as number) ?? config.autoRecallMinScore!;
        const query = params.query as string;
        const candidateLimit = Math.max(limit * 3, 10);
        const { variants, results: rawResults } = await searchWithQueryVariants(
          store.searchArchived,
          query,
          candidateLimit,
          minScore,
        );
        const scored = postProcess(
          rawResults.map((r) => ({
            id: r.id,
            content: r.content,
            category: r.category,
            score: r.score,
            created: r.created,
            accessCount: r.accessCount,
            lastAccessedAt: r.lastAccessedAt,
            importance: r.importance,
            confidence: r.confidence,
            sourceType: r.sourceType,
            expiresAt: r.expiresAt,
          })),
          {
            minScore,
            categoryWeights: inferCategoryWeights(query),
          },
        );
        const recalledMap = new Map(rawResults.map((r) => [r.id, r]));
        const finalResults = scored
          .map((item) => {
            const original = recalledMap.get(item.id);
            return original ? { ...original, score: item.score } : null;
          })
          .filter((item): item is NonNullable<typeof item> => item !== null)
          .slice(0, limit);
        await store.recordAccess(finalResults.map((item) => item.id));
        if (!finalResults.length) {
          return {
            content: [{ type: "text", text: "No matching archived memories found." }],
            details: [],
          };
        }
        const summaryResults = finalResults.map((r) => ({
          id: r.id,
          category: r.category,
          archived: r.archived ?? false,
          score: r.score,
          created: r.created,
          summary: r.summary ?? r.abstract ?? (r.content.length > 200 ? r.content.slice(0, 200) + "..." : r.content),
        }));
        return {
          content: [{ type: "text", text: JSON.stringify(summaryResults, null, 2) }],
          details: {
            variants,
            results: finalResults,
          },
        };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "memory_stats",
      label: "Memory Stats",
      description: "Show memory totals, archived counts, stage distribution, and category-level observability.",
      parameters: memoryStatsParameters,
      async execute() {
        const stats = await store.getStats();
        return {
          content: [{ type: "text", text: JSON.stringify(stats, null, 2) }],
          details: stats,
        };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "memory_observation_list",
      label: "Observation List",
      description: "List active staged observations for manual review.",
      parameters: memoryObservationListParameters,
      async execute(_id, params) {
        const limit = (params.limit as number | undefined) ?? 10;
        const minConfidence = (params.minConfidence as number | undefined) ?? 0;
        const items = await store.listObservations(limit, minConfidence);
        if (!items.length) {
          return {
            content: [{ type: "text", text: "No active observations found." }],
            details: [],
          };
        }
        const summary = items.map((item) => ({
          id: item.id,
          category: item.category,
          confidence: item.confidence,
          importance: item.importance,
          created: item.created,
          summary: item.summary ?? item.abstract ?? (item.content.length > 160 ? item.content.slice(0, 160) + "..." : item.content),
        }));
        return {
          content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
          details: items,
        };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "memory_observation_review",
      label: "Observation Review",
      description: "Manually promote, archive, or drop a staged observation.",
      parameters: memoryObservationReviewParameters,
      async execute(_id, params) {
        const result = await store.reviewObservation(
          params.id as string,
          params.action as "promote" | "drop" | "archive",
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
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
          {
            importance: params.importance as number | undefined,
            confidence: params.confidence as number | undefined,
            expiresAt: params.expiresAt as string | undefined,
          },
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
      name: "memory_compact",
      label: "Memory Compact",
      description: "Promote staged observations, archive stale or expired memories, and refresh long-term memory quality.",
      parameters: memoryCompactParameters,
      async execute() {
        const report = await store.compact();
        return {
          content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
          details: report,
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
    preconsciousLimit: (config.preconsciousPolicy as Record<string, unknown> | undefined)?.shortlistSize as number | undefined,
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
        const collection = params.collection as string | undefined;
        const variants = buildQueryVariants(queryText);
        const merged = new Map<string, ReturnType<QmdReader["query"]>[number]>();
        const perQueryLimit = Math.max(limit, Math.min(limit * 2, 20));

        for (const variant of variants) {
          const hits = reader.query(variant, perQueryLimit, collection);
          for (const hit of hits) {
            const existing = merged.get(hit.id);
            if (!existing || hit.score > existing.score) {
              merged.set(hit.id, hit);
            }
          }
        }

        let results = [...merged.values()]
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);
        if (minScore !== undefined) {
          results = results.filter((r) => r.score >= minScore);
        }
        const reranked = postProcess(
          results.map((r) => ({
            id: r.id,
            content: r.content,
            title: r.title,
            score: r.score,
          }) satisfies ScoredResult),
          {
            minScore,
          },
        );
        const resultMap = new Map(results.map((r) => [r.id, r]));
        results = reranked
          .map((item) => resultMap.get(item.id))
          .filter((item): item is NonNullable<typeof item> => item !== undefined);

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
            details: { variants, results: fullResults },
          };
        }

        // 非 full 模式：返回 snippet（前 200 字符）而非全文，减少 token 消耗
        const snippetResults = results.map((r) => ({
          id: r.id,
          title: r.title,
          collection: r.collection,
          score: r.score,
          snippet: r.content.length > 200 ? r.content.slice(0, 200) + "..." : r.content,
        }));

        return {
          content: [{ type: "text", text: JSON.stringify(snippetResults, null, 2) }],
          details: { variants, results: snippetResults },
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
  async register(api: OpenClawPluginApi) {
    const config = resolveConfig(api.pluginConfig);

    // 并行初始化，但 await 两者完成后再返回，保证工具和 hook 在 register() 返回前全部就绪
    const qmdReaderPromise = createQmdReader({
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

    const memoryPromise = config.memoryDir
      ? createMemoryStore({
          memoryDir: config.memoryDir,
          scope: config.scope,
          hybridEnabled: config.hybridEnabled,
          hybridScanLimit: config.hybridScanLimit,
          hybridLexicalWeight: config.hybridLexicalWeight,
          hybridSemanticWeight: config.hybridSemanticWeight,
          compactPolicy: (config.compactPolicy as Record<string, unknown> | undefined)?.default as any,
          compactCategoryPolicies: config.compactPolicy as any,
          preconsciousPolicy: config.preconsciousPolicy as any,
        }).then((store) => {
          registerMemoryFeatures(api, config, store);
        })
      : Promise.resolve();

    await Promise.all([qmdReaderPromise, memoryPromise]);
  },
};

export default plugin;

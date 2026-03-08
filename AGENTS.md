# Repository Guidelines

## Project Overview

This is an OpenClaw memory plugin (`kind: "memory"`) that combines:
- direct SQLite access to qmd's existing index for local knowledge-base retrieval
- a separate SQLite + Markdown memory store for long-term memory
- lightweight retrieval enhancements on top of BM25, including query rewriting, hybrid lexical/semantic fusion, post-processing re-ranking, and layered memory context formatting

The project is intentionally local-first: no qmd CLI calls at runtime, no vector database, and no network/API dependency for retrieval.

## Project Structure

```
AGENTS.md                  Repo guidance for coding agents
index.ts                   Plugin entry; config schema, tool, and hook registration
openclaw.plugin.json       Plugin manifest and UI hints
scripts/
  locomo-eval.ts           Local evaluation script
src/
  qmd-lite.ts              Minimal SQLite/FTS layer for qmd + memory tables
  qmd-reader.ts            Direct reader for qmd's index database and YAML config
  memory-store.ts          Memory storage (SQLite + Markdown dual-write)
  memory-hooks.ts          Auto-recall and auto-capture lifecycle hooks
  memory-format.ts         Memory file format utilities (frontmatter, slugify)
  hybrid-retrieval.ts      Lightweight semantic scan + score fusion
  query-rewrite.ts         Query variant generation for natural-language questions
  query-intent.ts          Query intent -> category weighting
  post-process.ts          Re-ranking pipeline (recency, weights, MMR, etc.)
  layered-context.ts       L0/L1/L2 memory summarization and prompt formatting
  adaptive-retrieval.ts    Heuristics to skip or force retrieval
  noise-filter.ts          Filters low-value auto-capture inputs
  session-tracker.ts       Session-level dedupe for recalled/captured items
  memory-dedup.ts          Skip/update/merge logic for similar memories
  memory-reflection.ts     Extracts reflective memory entries from long sessions
  self-improvement.ts      Maintains LEARNINGS.md and ERRORS.md files
tests/
  plugin.test.ts           Tool registration and plugin-level behavior
  qmd-reader.test.ts       Tests for qmd index reader
  memory-store.test.ts     Tests for memory store (uses real temp SQLite)
  memory-hooks.test.ts     Tests for hooks (mock store, injection detection)
  memory-format.test.ts    Tests for format utilities (pure functions)
  hybrid-retrieval.test.ts Tests for semantic ranking + fusion
  query-rewrite.test.ts    Tests for query rewriting
  query-intent.test.ts     Tests for intent-based weighting
  post-process.test.ts     Tests for ranking pipeline
  layered-context.test.ts  Tests for layered memory formatting
  adaptive-retrieval.test.ts
  noise-filter.test.ts
  session-tracker.test.ts
  memory-dedup.test.ts
  memory-reflection.test.ts
  self-improvement.test.ts
  integration.test.ts      End-to-end test (currently skipped in CI)
```

## Build, Test, and Development Commands

- `npm install`: install dependencies
- `npm run check`: TypeScript type check (`tsc --noEmit`)
- `npm test`: run all tests (`vitest run`)
- `npm run build`: compile TypeScript
- `npm run locomo:eval`: run the local evaluation script

## Key Dependencies

- `better-sqlite3`: SQLite bindings (supports Node.js and Bun)
- `@sinclair/typebox`: JSON Schema / TypeBox for tool parameter definitions
- `yaml`: parse qmd's YAML collection config
- `picomatch`: glob matching for `qmd_multi_get`
- `openclaw` (peer): OpenClaw plugin SDK
- `tsx`: run local TypeScript scripts in development

## Coding Style & Naming Conventions

- TypeScript strict mode, ES2022 target, NodeNext modules
- 2 spaces indentation
- `camelCase` for variables/functions, `PascalCase` for types, `kebab-case` for filenames
- All source in `src/`, tests in `tests/`
- Use `vi.fn()` mocks in tests, real temp SQLite databases for store tests
- Comments in Chinese are acceptable (existing codebase convention)

## Architecture Decisions

1. **In-process SQLite over CLI**: All qmd access is direct SQLite; no shelling out to qmd CLI at runtime.
2. **Dual-write memory**: Each memory is written to SQLite for retrieval and Markdown for human inspection/editing.
3. **Hybrid retrieval without embeddings**: Retrieval is still local-only, but no longer BM25-only in practice. The code fuses FTS/BM25 results with a lightweight semantic scan based on token overlap, stemming, and a small synonym map.
4. **Query rewriting before retrieval**: Natural-language questions are expanded into keyword-style variants before qmd and memory search.
5. **Post-processing after retrieval**: Search results are re-ranked with recency boosts, category weighting, length normalization, time decay, and optional MMR diversity.
6. **Layered recall output**: Recalled memories are formatted as L0/L1/L2 context using abstract, summary, or full content based on score.
7. **User-only capture**: Auto-capture only processes `role: "user"` messages to avoid model self-poisoning.
8. **Session-aware dedupe**: Recall and capture avoid repeating the same items within a session.
9. **Memory dedup on write**: New memory writes may `skip`, `update`, or `merge` against similar existing memories.
10. **Learning files for agent self-improvement**: The plugin can append structured records to `LEARNINGS.md` and `ERRORS.md`, then inject recent learnings during recall.
11. **Lazy async init with register-time readiness**: `createQmdReader()` and `createMemoryStore()` are async; `register()` awaits initialization before returning so tools/hooks are ready.
12. **Process exit cleanup**: Reader/store register close handlers for process shutdown to avoid dangling SQLite handles.

## Testing Guidelines

- Place tests under `tests/`, name as `*.test.ts`
- Memory store tests use real temp directories with `mkdtempSync`
- Hook tests use mock stores with `vi.fn()`
- Plugin tests create real SQLite databases and wait for async tool registration
- Retrieval-related modules have focused unit tests and should stay cheap to run
- All tests must pass before commit: `npm test`

## Security Notes

- Prompt injection detection in auto-capture (`looksLikePromptInjection`)
- HTML escaping for recalled memory content (`escapeMemoryForPrompt`)
- Recalled memories wrapped in `<recalled-memories>` with explicit untrusted-data warning
- Auto-capture skips assistant content to reduce self-poisoning risk
- Noise filtering and session dedupe reduce low-value memory accumulation
- No secrets or API keys in this plugin; retrieval is local-only and does not require embedding APIs

## Commit Style

Use short, imperative subjects with conventional prefixes:

- `feat: add memory search tool`
- `fix: handle missing qmd database`
- `chore: update .gitignore`
- `test: add injection detection tests`

## OpenClaw Plugin Spec Compliance

- `openclaw.plugin.json` manifest with `kind: "memory"` and `configSchema`
- Tools registered via `api.registerTool()` with `{ optional: true }`
- Hooks registered via `api.on("before_prompt_build")` and `api.on("agent_end")`
- `memory_get` returns `{ text: "", path }` on miss (graceful degradation)
- Recalled memories wrapped in `<recalled-memories>` with untrusted data warning
- qmd tools are only registered when the qmd database can be opened
- memory tools/hooks are only registered when `memoryDir` is configured

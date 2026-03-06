# Repository Guidelines

## Project Overview

This is an OpenClaw memory plugin (`kind: "memory"`) that uses SQLite FTS5 (BM25) for both knowledge base queries and memory storage. It reads from qmd's existing SQLite index and maintains its own memory database. No CLI or network dependencies at runtime.

## Project Structure

```
index.ts                   Plugin entry, tool + hook registration
openclaw.plugin.json       Plugin manifest (required by OpenClaw)
src/
  qmd-lite.ts              Minimal SQLite FTS5 layer (extracted from qmd)
  qmd-reader.ts            Direct reader for qmd's index database
  memory-store.ts          Memory storage (SQLite + Markdown dual-write)
  memory-hooks.ts          Auto-recall and auto-capture lifecycle hooks
  memory-format.ts         Memory file format utilities (frontmatter, slugify)
tests/
  qmd-reader.test.ts       Tests for qmd index reader
  memory-store.test.ts     Tests for memory store (uses real temp SQLite)
  memory-hooks.test.ts     Tests for hooks (mock store, injection detection)
  memory-format.test.ts    Tests for format utilities (pure functions)
  plugin.test.ts           Integration tests for tool registration
  integration.test.ts      End-to-end test (skipped in CI)
```

## Build, Test, and Development Commands

- `npm install`: install dependencies
- `npm run check`: TypeScript type check (`tsc --noEmit`)
- `npm test`: run all tests (`vitest run`)
- `npm run build`: compile TypeScript

## Key Dependencies

- `better-sqlite3`: SQLite bindings (supports Node.js and Bun)
- `@sinclair/typebox`: JSON Schema / TypeBox for tool parameter definitions
- `yaml`: parse qmd's YAML collection config
- `picomatch`: glob matching for `qmd_multi_get`
- `openclaw` (peer): OpenClaw plugin SDK

## Coding Style & Naming Conventions

- TypeScript strict mode, ES2022 target, NodeNext modules
- 2 spaces indentation
- `camelCase` for variables/functions, `PascalCase` for types, `kebab-case` for filenames
- All source in `src/`, tests in `tests/`
- Use `vi.fn()` mocks in tests, real temp SQLite databases for store tests
- Comments in Chinese are acceptable (existing codebase convention)

## Architecture Decisions

1. **In-process SQLite over CLI**: All qmd queries use direct SQLite access, no `execFile`. This eliminates 150-700ms overhead per query.
2. **Dual-write memory**: Each memory is written to both SQLite (for search) and a Markdown file (for human readability).
3. **FTS5 only**: No vector search or embedding. BM25 is sufficient for memory retrieval without requiring `node-llama-cpp` or external APIs.
4. **User-only capture**: Auto-capture only processes `role: "user"` messages to prevent model self-poisoning (aligned with official `memory-lancedb` plugin).
5. **Lazy async init**: `createQmdReader()` and `createMemoryStore()` are async (dynamic import of better-sqlite3). Tools are registered after init completes.
6. **Process exit cleanup**: Both reader and store register `process.on("exit")` handlers with proper `removeListener` on close to prevent listener leaks.

## Testing Guidelines

- Place tests under `tests/`, name as `*.test.ts`
- Memory store tests use real temp directories with `mkdtempSync`
- Hook tests use mock stores with `vi.fn()`
- Plugin tests create real SQLite databases and wait for async tool registration
- All tests must pass before commit: `npm test`

## Security Notes

- Prompt injection detection in auto-capture (`looksLikePromptInjection`)
- HTML escaping for recalled memory content (`escapeMemoryForPrompt`)
- UUID validation in memory IDs
- No secrets or API keys in this plugin (BM25-only, no embedding API)

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

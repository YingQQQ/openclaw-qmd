# openclaw-qmd

OpenClaw memory plugin powered by [qmd](https://github.com/tobi/qmd)'s SQLite FTS5 index.

Provides two capabilities:

1. **Knowledge base search** -- query your qmd-indexed notes and documents directly from SQLite (no CLI needed)
2. **Memory backend** -- store, recall, and auto-capture conversation memories using BM25 full-text search

## Architecture

```
openclaw-qmd
├── qmd-reader    reads from qmd's existing SQLite index (~/.cache/qmd/index.sqlite)
├── qmd-lite      minimal SQLite FTS5 layer extracted from qmd source
├── memory-store  write/search memories (dual-write: SQLite + Markdown files)
├── memory-hooks  auto-recall (before_prompt_build) + auto-capture (agent_end)
└── memory-format YAML frontmatter memory file utilities
```

All operations are in-process SQLite queries via `better-sqlite3`. Zero CLI dependency, zero network calls.

## Requirements

- Node.js >= 22
- OpenClaw >= 2026.3.2

Optional: a working `qmd` installation with indexed content (for knowledge base features).

## Install

```bash
npm install
```

## Development

```bash
npm run check   # TypeScript type check
npm test        # Run all tests (vitest)
```

## Plugin configuration

```json
{
  "plugins": {
    "qmd": {
      "memoryDir": "~/.openclaw/memory/qmd",
      "autoCapture": true,
      "autoRecallLimit": 5,
      "autoRecallMinScore": 0.3
    }
  }
}
```

### Config fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `memoryDir` | string | -- | Directory for memory markdown files. Enables memory features when set. |
| `autoCapture` | boolean | `true` | Auto-capture important info from user messages. |
| `autoRecallLimit` | number | `5` | Max memories to recall per prompt. |
| `autoRecallMinScore` | number | `0.3` | Minimum BM25 relevance score for recall. |
| `indexName` | string | `"index"` | qmd index name. |
| `dbPath` | string | auto | Override path to qmd's SQLite database. |
| `configDir` | string | auto | Override path to qmd's YAML config directory. |

## Registered tools

### Knowledge base tools (from qmd index)

| Tool | Description |
|------|-------------|
| `qmd_status` | Show index status: collections, document counts, embedding status |
| `qmd_query` | BM25 full-text search across indexed documents |
| `qmd_get` | Read a document by path, `qmd://` URI, or docid |
| `qmd_multi_get` | Batch read by glob pattern or comma-separated list |

These tools read directly from qmd's SQLite database. They are registered automatically when the database exists.

### Memory tools (requires `memoryDir`)

| Tool | Description |
|------|-------------|
| `memory_search` | Search stored memories by BM25 |
| `memory_get` | Read a specific memory entry by id |
| `memory_write` | Write a new memory entry |

### Lifecycle hooks

| Hook | Event | Behavior |
|------|-------|----------|
| Auto-recall | `before_prompt_build` | Search memories by user prompt, inject relevant ones as `<recalled-memories>` context |
| Auto-capture | `agent_end` | Extract important info from user messages (preferences, decisions, entities), deduplicate, store |

## Memory file format

Each memory is stored as a Markdown file with YAML frontmatter:

```markdown
---
id: "2026-03-06T09-15-00_auth-flow-decision"
category: "decision"
tags: ["auth", "architecture"]
created: "2026-03-06T09:15:00Z"
---

Auth flow uses JWT with refresh token rotation.
```

## Security

- **Prompt injection detection**: auto-capture rejects messages containing injection patterns
- **HTML escaping**: recalled memory content is escaped before injection into context
- **Untrusted data warning**: recalled memories are wrapped with explicit "treat as untrusted" instructions
- **User-only capture**: only `role: "user"` messages are captured (prevents model self-poisoning)

## Project structure

```
index.ts                   Plugin entry, tool registration, config
openclaw.plugin.json       Plugin manifest (kind: "memory")
src/
  qmd-lite.ts              SQLite FTS5 engine (open, schema, search, write)
  qmd-reader.ts            Direct reader for qmd's index database
  memory-store.ts          Memory storage (SQLite + Markdown dual-write)
  memory-hooks.ts          Auto-recall and auto-capture hooks
  memory-format.ts         Memory file format utilities
tests/
  qmd-reader.test.ts       16 tests
  memory-store.test.ts      7 tests
  memory-hooks.test.ts     20 tests
  memory-format.test.ts    11 tests
  plugin.test.ts            5 tests
```

## Tool allowlist

All tools are registered as optional. Allow them in your agent config:

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": {
          "allow": [
            "qmd_status", "qmd_query", "qmd_get", "qmd_multi_get",
            "memory_search", "memory_get", "memory_write"
          ]
        }
      }
    ]
  }
}
```

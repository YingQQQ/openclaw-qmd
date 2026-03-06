# openclaw-qmd

`openclaw-qmd` is a small OpenClaw plugin that exposes a local `qmd` CLI as optional agent tools.

It does not replace `qmd`. It wraps the real `qmd` commands so OpenClaw can query your indexed notes and documents.

## What this plugin provides

The plugin registers these optional tools:

- `qmd_status`
- `qmd_query`
- `qmd_get`
- `qmd_multi_get`

All tools shell out to the local `qmd` binary. If `qmd` is missing, the tool returns a clear runtime error.

## Requirements

- Node.js `>= 22`
- OpenClaw `2026.3.2` or compatible
- A working local `qmd` installation

This repository only contains the plugin. You still need to install and configure `qmd` itself.

## Install dependencies

```bash
npm install
```

## Development checks

```bash
npm run check
npm test
```

## Plugin configuration

Example OpenClaw plugin config:

```json
{
  "plugins": {
    "qmd": {
      "command": "qmd",
      "cwd": "/home/yingq/notes",
      "indexName": "index",
      "timeoutMs": 30000
    }
  }
}
```

Config fields:

- `command`: path to the `qmd` executable
- `cwd`: default working directory for `qmd`
- `indexName`: optional value passed as `--index <name>`
- `timeoutMs`: process timeout in milliseconds

If `qmd` is not in `PATH`, set `command` to an absolute path such as:

```json
{
  "plugins": {
    "qmd": {
      "command": "/home/yingq/.local/bin/qmd"
    }
  }
}
```

## Tool allowlist

These tools are registered as optional tools, so they must be explicitly allowed.

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": {
          "allow": [
            "qmd",
            "qmd_status",
            "qmd_query",
            "qmd_get",
            "qmd_multi_get"
          ]
        }
      }
    ]
  }
}
```

## Tool behavior

### `qmd_status`

Runs:

```bash
qmd status
```

Use this to verify that `qmd` is installed and the selected index is healthy.

### `qmd_query`

Runs:

```bash
qmd query "<query>" --json
```

You can call it in two modes:

1. Plain query string
2. Structured `searches` array, converted into qmd's multiline query-document format

Example plain query:

```json
{
  "query": "how does auth work",
  "limit": 5
}
```

Example structured query:

```json
{
  "searches": [
    { "type": "lex", "query": "\"connection pool\" timeout -redis" },
    { "type": "vec", "query": "why do database connections time out under load" }
  ],
  "collections": ["notes"],
  "limit": 8,
  "minScore": 0.2
}
```

### `qmd_get`

Runs:

```bash
qmd get <file>
```

Supports:

- relative file paths
- `qmd://` paths
- docids accepted by `qmd`
- `fromLine`
- `maxLines`
- `lineNumbers`

Example:

```json
{
  "file": "qmd://notes/auth/design.md",
  "fromLine": 20,
  "maxLines": 80
}
```

### `qmd_multi_get`

Runs:

```bash
qmd multi-get "<pattern>" --json
```

Use it for batch retrieval by glob or comma-separated file list.

Example:

```json
{
  "pattern": "journals/2026-03*.md",
  "maxLines": 40,
  "maxBytes": 12000
}
```

## Recommended qmd workflow

Before this plugin is useful, initialize `qmd` itself:

```bash
qmd collection add /home/yingq/notes --name notes
qmd update
qmd embed
qmd status
```

Then OpenClaw can use this plugin against the indexed content.

## Project structure

- `index.ts`: plugin entrypoint and tool registration
- `src/qmd.ts`: local `qmd` process runner and error handling
- `tests/qmd.test.ts`: unit tests for command execution behavior

## Notes

- The plugin is intentionally thin. It mirrors the real `qmd` CLI instead of inventing another protocol.
- Tool results return plain text plus structured `details` when JSON output is available.
- This project does not auto-install `qmd`.

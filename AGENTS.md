# Repository Guidelines

## Project Structure & Module Organization
This repository is currently in bootstrap state. Keep the top level tidy and introduce structure early:

- `src/` for application code and reusable modules
- `tests/` for unit and integration tests
- `scripts/` for local automation and setup helpers
- `docs/` for design notes, research, and integration decisions
- `assets/` for static files only if they are required by the project

Prefer small, focused modules. Group code by feature first, then by technical layer when the codebase grows.

## Build, Test, and Development Commands
Add a single documented command per task and keep them stable.

- `npm install` or `pnpm install`: install dependencies after a package manifest exists
- `npm run dev`: start the local development entrypoint
- `npm test`: run the full automated test suite
- `npm run lint`: run static checks
- `npm run build`: produce a production build

If you introduce another toolchain, update this file in the same change.

## Coding Style & Naming Conventions
Use 2 spaces for JSON, YAML, and Markdown examples. For source files, follow the formatter for the chosen language and avoid manual style drift.

- TypeScript/JavaScript: `camelCase` for variables/functions, `PascalCase` for classes/types, `kebab-case` for filenames
- Python: `snake_case` for functions/files, `PascalCase` for classes
- Keep modules small and prefer explicit imports over wildcard imports
- Write comments only where intent is not obvious from code

## Testing Guidelines
Place tests under `tests/` and mirror the source layout where practical.

- Name tests `*.test.ts`, `test_*.py`, or the idiomatic form for the chosen framework
- Cover new behavior and at least one failure path
- Prefer deterministic unit tests over network-dependent tests

When adding a new dependency or external integration, include a smoke test or fixture-based test.

## Commit & Pull Request Guidelines
Use short, imperative commit subjects:

- `feat: add qmd collection bootstrap`
- `fix: handle missing workspace config`
- `docs: clarify OpenClaw integration`

Pull requests should include:

- a clear summary of the change
- any setup or migration steps
- test evidence (`npm test`, screenshots, sample output) when relevant

## Security & Configuration Tips
Do not commit API keys, tokens, wallets, or local `.env` files. Keep machine-specific settings in ignored local config files. Treat OpenClaw session logs, memory files, and indexed notes as sensitive data unless explicitly intended for sharing.

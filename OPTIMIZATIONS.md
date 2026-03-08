# Optimization Notes

This file tracks memory-system optimization work that has already landed and the next set of improvements worth pursuing.

## Completed

### 1. Observation Staging

- Auto-capture no longer writes directly into long-term memory by default.
- Candidate items are first stored as `stage: "observation"`.
- This reduces long-term memory pollution from one-off statements and low-confidence turns.

Relevant files:
- `src/memory-hooks.ts`
- `src/memory-store.ts`
- `src/qmd-lite.ts`

### 2. Metadata-Aware Memory Entries

Memory entries now support additional retrieval and lifecycle metadata:

- `confidence`
- `sourceType`
- `expiresAt`
- `archived`
- `aliases`

These fields are stored in SQLite and used in ranking/compaction logic.

Relevant files:
- `src/qmd-lite.ts`
- `src/memory-format.ts`
- `src/post-process.ts`

### 3. Compaction and Promotion

- Added `memory_compact` tool
- Repeated or high-confidence observations can be promoted into long-term memory
- Old or expired memories can be archived
- Old `event` / `case` clusters can be summarized before archive

Relevant files:
- `index.ts`
- `src/memory-store.ts`

### 4. Preconscious Buffer

- Recall now injects a small high-importance shortlist before normal search-based recall
- This acts like a lightweight "currently relevant working memory" layer

Relevant files:
- `src/memory-hooks.ts`
- `src/memory-store.ts`

### 5. Session Recovery

- Pending capture candidates are persisted to disk
- They are recovered on the next prompt build if the prior session ended before normal consolidation

Relevant files:
- `src/memory-hooks.ts`
- `src/memory-store.ts`

### 6. Configurable Compaction Policy

Compaction is no longer purely hardcoded.

Config now supports:

- global default compact policy
- per-category compact policy overrides

Supported knobs:

- `promoteOccurrences`
- `promoteConfidence`
- `promoteImportance`
- `archiveAfterDays`
- `summarizeBeforeArchive`

Relevant files:
- `index.ts`
- `src/memory-store.ts`
- `openclaw.plugin.json`

### 7. Archive Observability

- Added `memory_search_archived` for querying archived long-term memories
- Added `memory_stats` for active/archived totals, stage distribution, source-type totals, and category-level stats
- This makes compaction outcomes visible instead of leaving archive state as an internal-only mechanism

Relevant files:
- `index.ts`
- `src/memory-store.ts`
- `src/qmd-lite.ts`

### 8. SQLite-Truth `memory_get`

- `memory_get` now reads current metadata from SQLite first, instead of treating the Markdown file as the canonical state
- This keeps `archived`, `stage`, `importance`, `confidence`, and related fields accurate after compaction or metadata-only updates
- Markdown files remain useful for human readability and compatibility, but not as the primary system-state source

Relevant files:
- `src/memory-store.ts`
- `src/qmd-lite.ts`
- `index.ts`

### 9. Configurable Preconscious Policy

- Preconscious shortlist ranking is now configurable instead of hardcoded
- Supported knobs include `shortlistSize`, `importanceWeight`, `confidenceWeight`, `recencyWeight`, `maxAgeDays`, and `categoryBoosts`
- This makes the working-memory layer tunable without changing source code

Relevant files:
- `src/memory-store.ts`
- `src/memory-hooks.ts`
- `index.ts`
- `openclaw.plugin.json`

### 10. Observation Review Queue

- Added `memory_observation_list` to expose active staged observations
- Added `memory_observation_review` for manual `promote`, `archive`, and `drop`
- This turns observation staging into a visible queue instead of a write-only internal buffer

Relevant files:
- `src/memory-store.ts`
- `index.ts`
- `tests/memory-store.test.ts`
- `tests/integration.test.ts`

### 11. Access Reinforcement and Historical Recall

- Search and `memory_get` now update access counters in SQLite
- Post-processing includes a small reinforcement boost for frequently/recently used memories
- Historical prompts can use archived-aware recall, and `memory_search` supports `includeArchived`

Relevant files:
- `src/memory-store.ts`
- `src/memory-hooks.ts`
- `src/post-process.ts`
- `index.ts`

### 12. Stronger Alias Generation and Compaction Explainability

- Alias generation now incorporates title/abstract/summary-derived terms instead of only category/tags/first sentence
- `memory_compact` now returns per-item IDs and reasoned action records, not just aggregate counts

Relevant files:
- `src/memory-store.ts`
- `tests/memory-store.test.ts`
- `README.md`

### 13. Comprehensive Security and Robustness Hardening

Two-pass code review and fix cycle covering security, correctness, error handling, and test coverage.

**Security fixes:**
- Path traversal prevention: `sanitizeId()` in `memory-store.ts` strips directory separators and `..` sequences from user-supplied memory IDs
- Expanded prompt injection detection: added ChatML (`<|im_start|>`/`<|im_end|>`), HTML comment (`<!-- system -->`), and Llama (`[INST]`/`[/INST]`) patterns to `memory-hooks.ts`
- SQL identifier validation: `ensureColumn()` in `qmd-lite.ts` now validates table/column names against `^[a-zA-Z_][a-zA-Z0-9_]*$`
- Removed `memory_forget` auto-delete: search results always return candidate list for explicit user confirmation

**Correctness fixes:**
- Fixed expiry penalty direction in `post-process.ts`: near-expiry memories now correctly receive a score penalty (`1 - penalty`) instead of a boost (`1 + penalty`)
- Fixed `trimFileEntries()` in `self-improvement.ts`: proper separator handling when truncating LEARNINGS.md/ERRORS.md

**Robustness improvements:**
- All 9 memory tools and `qmd_query` wrapped in try-catch with `toolError()` for graceful error responses
- `compact()` DB operations wrapped in `db.transaction()` for atomicity, with counters/actions updated outside the transaction
- `memoryPromise` initialization chain has `.catch()` for graceful degradation
- Added `Database.transaction()` to the `qmd-lite.ts` interface
- LEARNINGS.md/ERRORS.md auto-trimmed to 200 entries max

**Code quality:**
- Extracted `executeMemorySearch()` to eliminate duplication between `memory_search` and `memory_search_archived`
- Replaced 3 `as any` casts with proper `Partial<CompactPolicyConfig>` / `Partial<PreconsciousPolicyConfig>` types

**Test coverage (221 → 278 tests):**
- New `tests/qmd-lite.test.ts` (24 tests): openDatabase, schema, CRUD, FTS search, transactions
- New `tests/edge-cases.test.ts` (28 tests): boundary values for query-rewrite, query-intent, adaptive-retrieval, memory-dedup, prompt injection, post-process, memory-format
- New `sanitizeId` security tests in `memory-store.test.ts` (5 tests): path traversal, absolute paths, empty IDs

Relevant files:
- `index.ts`
- `src/memory-store.ts`
- `src/memory-hooks.ts`
- `src/post-process.ts`
- `src/qmd-lite.ts`
- `src/self-improvement.ts`
- `tests/qmd-lite.test.ts`
- `tests/edge-cases.test.ts`
- `tests/memory-store.test.ts`

## Good Next Steps

### 1. Better Stemming for Hybrid Retrieval

Current stemming in `hybrid-retrieval.ts` is a naive suffix-stripping approach. Words like "string" can be incorrectly reduced to "str".

Potential improvement:
- Implement a proper Porter stemmer or use a lightweight stemming library
- Add stemming-aware unit tests with known edge cases

Suggested files:
- `src/hybrid-retrieval.ts`
- `tests/hybrid-retrieval.test.ts`

### 2. File-DB Synchronization

SQLite and Markdown files can drift apart. Currently `memory_get` uses SQLite as truth but falls back to file content.

Potential improvement:
- Add a `memory_fsck` tool that detects and repairs inconsistencies
- Log warnings when file/DB content diverges

Suggested files:
- `src/memory-store.ts`
- `index.ts`

### 3. YAML Format Hardening

Memory file frontmatter uses simple quote escaping. Content containing `---` or YAML special characters could break parsing.

Potential improvement:
- Use block scalar syntax (`|`) for multi-line values
- Or switch to a proper YAML serialization library

Suggested files:
- `src/memory-format.ts`
- `tests/memory-format.test.ts`

### 4. Adaptive Access Reinforcement

Current access reinforcement treats all access signals equally. Distinguishing "seen" from "useful" would improve ranking over time.

Potential improvement:
- Track explicit user references (e.g., `memory_get` after `memory_search`) as stronger signals
- Decay stale access counts

Suggested files:
- `src/post-process.ts`
- `src/memory-store.ts`

### 5. Error Recovery and Resilience

Database corruption, permission errors, and disk-full scenarios are not handled gracefully.

Potential improvement:
- Detect corrupted SQLite files and offer automatic rebuild from Markdown files
- Add read-only fallback mode when write operations fail
- Implement `recordAccess` error isolation (currently one failure aborts the loop)

Suggested files:
- `src/memory-store.ts`
- `src/qmd-lite.ts`

## Validation Status

As of 2026-03-08:

- `npm run check` passes
- `npm test` passes
- Full test suite: 278 tests across 19 test files

## Open Questions

- For archived/historical recall, should archived memories only participate when explicitly requested, or should some query intents allow low-weight archived candidates by default?
- Should `sanitizeId` use a strict whitelist (`[a-zA-Z0-9_\-.]`) instead of relying on `path.basename()`?
- Is the current 200-entry limit for LEARNINGS.md/ERRORS.md appropriate, or should it be configurable?

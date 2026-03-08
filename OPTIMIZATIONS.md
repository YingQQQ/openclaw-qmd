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

## Good Next Steps

### 1. Configurable Preconscious Policy

Current preconscious selection is still hardcoded.

Useful config knobs:

- shortlist size
- importance weight
- confidence weight
- recency weight
- category boosts
- max age

Suggested files:
- `src/memory-store.ts`
- `src/memory-hooks.ts`
- `index.ts`
- `openclaw.plugin.json`

### 2. Access Reinforcement

Current ranking uses recency, category, confidence, importance, and expiry, but does not strongly learn from repeated successful recall/use.

Potential improvement:

- increase score or half-life for repeatedly useful memories
- distinguish "seen often" from "useful often"

Suggested files:
- `src/qmd-lite.ts`
- `src/post-process.ts`
- `src/memory-hooks.ts`

### 3. Stronger Alias Generation

Current alias generation is intentionally lightweight.

Potential improvement:

- generate aliases from title, tags, category, first sentence, and compact summaries
- optionally add a dedicated alias-expansion utility

Suggested files:
- `src/memory-store.ts`
- `src/query-rewrite.ts`

### 4. Observation Aging / Review Queue

Observation staging exists, but there is no dedicated review queue.

Potential improvement:

- observations older than a threshold could be:
  - promoted
  - archived
  - dropped
  - surfaced for manual review

Suggested files:
- `src/memory-store.ts`
- `index.ts`

### 5. Compaction Explainability

Compaction returns counts, but not detailed reasons.

Potential improvement:

- emit richer compact reports:
  - which ids were promoted
  - which ids were archived
  - why each action happened

Suggested files:
- `src/memory-store.ts`
- `index.ts`

## Validation Status

At the time this file was written:

- `npm run check` passes
- `npm test` passes
- full test suite passes with 221 tests

## Open Questions

- For archived/historical recall, should archived memories only participate when explicitly requested, or should some query intents allow low-weight archived candidates by default?

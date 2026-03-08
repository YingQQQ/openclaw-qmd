import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  deleteDocument,
  ensureSchema,
  findDocumentByPath,
  hashContent,
  insertContent,
  insertDocumentExtended,
  openDatabase,
  scanDocumentsExtended,
  searchFTSExtended,
  updateAccessCount,
  updateDocument,
  type Database,
  type DocumentScanRow,
  type FTSResultExtended,
} from "./qmd-lite.js";
import {
  formatMemoryFile,
  generateMemoryId,
  parseMemoryFile,
  type MemoryEntry,
} from "./memory-format.js";
import { fuseRankedResults, rankSemanticMatches } from "./hybrid-retrieval.js";
import { generateAbstract, generateSummary } from "./layered-context.js";
import { getDedupeDecision, mergeContents, type ExistingMatch } from "./memory-dedup.js";

export type MemoryStoreConfig = {
  memoryDir: string;
  dbPath?: string;
  collection?: string;
  scope?: string;
  hybridEnabled?: boolean;
  hybridScanLimit?: number;
  hybridLexicalWeight?: number;
  hybridSemanticWeight?: number;
  compactPolicy?: Partial<CompactPolicyConfig>;
  compactCategoryPolicies?: Partial<Record<string, Partial<CompactPolicyConfig>>>;
  preconsciousPolicy?: Partial<PreconsciousPolicyConfig>;
};

export type CompactPolicyConfig = {
  promoteOccurrences: number;
  promoteConfidence: number;
  promoteImportance: number;
  archiveAfterDays: number;
  summarizeBeforeArchive: boolean;
};

export type PreconsciousPolicyConfig = {
  importanceWeight: number;
  confidenceWeight: number;
  recencyWeight: number;
  maxAgeDays: number;
  categoryBoosts: Record<string, number>;
};

export type MemoryWriteOptions = {
  importance?: number;
  confidence?: number;
  sourceType?: string;
  stage?: "memory" | "observation";
  expiresAt?: string;
  aliases?: string[];
  skipDedupe?: boolean;
};

export type RecalledMemory = {
  id: string;
  content: string;
  title?: string;
  category?: string;
  score: number;
  docId?: number;
  accessCount?: number;
  lastAccessedAt?: string;
  abstract?: string;
  summary?: string;
  created?: string;
  importance?: number;
  confidence?: number;
  sourceType?: string;
  stage?: "memory" | "observation";
  expiresAt?: string;
  archived?: boolean;
  aliases?: string[];
};

export type CompactReport = {
  promoted: number;
  archived: number;
  skipped: number;
  summarized: number;
  promotedIds: string[];
  archivedIds: string[];
  skippedIds: string[];
  summarizedIds: string[];
  actions: Array<{
    action: "promote" | "archive" | "skip" | "summarize";
    id: string;
    reason: string;
    stage?: string;
    category?: string;
  }>;
};

export type PreconsciousItem = {
  id: string;
  content: string;
  category?: string;
  score: number;
  abstract?: string;
  summary?: string;
  created?: string;
};

export type PendingSessionPayload = {
  storedAt: string;
  entries: Array<{
    content: string;
    category?: string;
    tags?: string[];
    title?: string;
    confidence?: number;
    importance?: number;
  }>;
};

export type MemoryStats = {
  total: number;
  active: number;
  archived: number;
  memory: number;
  observations: number;
  expiredActive: number;
  categories: Record<string, {
    total: number;
    active: number;
    archived: number;
    memory: number;
    observations: number;
  }>;
  stages: Record<string, number>;
  sourceTypes: Record<string, number>;
};

export type MemoryStore = {
  write(content: string, category?: string, tags?: string[], title?: string, options?: MemoryWriteOptions): Promise<MemoryEntry>;
  writeObservation(content: string, category?: string, tags?: string[], title?: string, options?: MemoryWriteOptions): Promise<MemoryEntry>;
  search(query: string, limit: number, minScore: number): Promise<RecalledMemory[]>;
  searchWithArchived(query: string, limit: number, minScore: number): Promise<RecalledMemory[]>;
  searchArchived(query: string, limit: number, minScore: number): Promise<RecalledMemory[]>;
  listObservations(limit: number, minConfidence?: number): Promise<RecalledMemory[]>;
  reviewObservation(id: string, action: "promote" | "drop" | "archive"): Promise<{ action: string; reviewed: boolean; promotedId?: string }>;
  get(id: string): Promise<MemoryEntry | null>;
  getStats(): Promise<MemoryStats>;
  delete(id: string): Promise<boolean>;
  ensureCollection(): void;
  reindex(): Promise<void>;
  compact(): Promise<CompactReport>;
  buildPreconscious(limit: number): Promise<PreconsciousItem[]>;
  persistPendingSession(payload: PendingSessionPayload): Promise<void>;
  clearPendingSession(): Promise<void>;
  recoverPendingSession(): Promise<number>;
  recordAccess(ids: string[]): Promise<void>;
  close(): void;
};

const DEFAULT_COLLECTION = "memories";
const PENDING_SESSION_FILE = "pending-session.json";
const MAX_SUMMARY_ITEMS_PER_CLUSTER = 4;
const processClosers = new Set<() => void>();
let exitHookInstalled = false;

const CATEGORY_POLICIES: Record<string, CompactPolicyConfig> = {
  profile: { promoteOccurrences: 1, promoteConfidence: 0.75, promoteImportance: 0.75, archiveAfterDays: 365, summarizeBeforeArchive: false },
  preference: { promoteOccurrences: 1, promoteConfidence: 0.65, promoteImportance: 0.7, archiveAfterDays: 240, summarizeBeforeArchive: false },
  entity: { promoteOccurrences: 1, promoteConfidence: 0.7, promoteImportance: 0.7, archiveAfterDays: 180, summarizeBeforeArchive: false },
  event: { promoteOccurrences: 2, promoteConfidence: 0.8, promoteImportance: 0.8, archiveAfterDays: 45, summarizeBeforeArchive: true },
  case: { promoteOccurrences: 1, promoteConfidence: 0.72, promoteImportance: 0.82, archiveAfterDays: 90, summarizeBeforeArchive: true },
  pattern: { promoteOccurrences: 2, promoteConfidence: 0.7, promoteImportance: 0.75, archiveAfterDays: 300, summarizeBeforeArchive: false },
  default: { promoteOccurrences: 2, promoteConfidence: 0.72, promoteImportance: 0.72, archiveAfterDays: 120, summarizeBeforeArchive: false },
};

const DEFAULT_PRECONSCIOUS_POLICY: PreconsciousPolicyConfig = {
  importanceWeight: 0.5,
  confidenceWeight: 0.3,
  recencyWeight: 0.2,
  maxAgeDays: 30,
  categoryBoosts: {
    case: 0.12,
    event: 0.08,
    preference: 0.05,
    profile: 0.04,
    entity: 0.03,
    pattern: 0.06,
  },
};

function installProcessExitHook() {
  if (exitHookInstalled) return;
  process.on("exit", () => {
    for (const close of [...processClosers]) {
      try {
        close();
      } catch (err) {
        console.error("memory-store: exit handler error:", err);
      }
    }
  });
  exitHookInstalled = true;
}

function resolveDbPath(config: MemoryStoreConfig): string {
  return config.dbPath ?? path.join(config.memoryDir, "memories.db");
}

function normalizeKey(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function parseStoredDocumentContent(text: string): { content: string; tags?: string[]; aliases?: string[] } {
  const lines = text.split("\n");
  let headerEnd = 0;
  let tagsLine: string | undefined;
  let aliasesLine: string | undefined;

  // Header is at most the first 3 lines: [category], tags: ..., aliases: ...
  for (let i = 0; i < Math.min(lines.length, 4); i++) {
    const trimmed = lines[i].trim();
    if (i === 0 && /^\[[^\]]+\]$/.test(trimmed)) {
      headerEnd = i + 1;
      continue;
    }
    if (headerEnd > 0 || i === 0) {
      if (/^tags:\s+/i.test(trimmed)) {
        tagsLine = trimmed;
        headerEnd = i + 1;
        continue;
      }
      if (/^aliases:\s+/i.test(trimmed)) {
        aliasesLine = trimmed;
        headerEnd = i + 1;
        continue;
      }
    }
    break;
  }

  const content = lines.slice(headerEnd).join("\n").trim();

  const tags = tagsLine
    ? tagsLine.replace(/^tags:\s+/i, "").split(/\s+/).map((item) => item.trim()).filter(Boolean)
    : undefined;
  const aliases = aliasesLine
    ? aliasesLine.replace(/^aliases:\s+/i, "").split("|").map((item) => item.trim()).filter(Boolean)
    : undefined;

  return { content, tags, aliases };
}

function normalizeStoredContent(text: string): string {
  return normalizeKey(parseStoredDocumentContent(text).content);
}

function clamp01(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, Number(value)));
}

function daysBetween(from: string, to = new Date().toISOString()): number {
  return Math.max(0, (new Date(to).getTime() - new Date(from).getTime()) / (1000 * 60 * 60 * 24));
}

function summarizeCluster(items: DocumentScanRow[]): string {
  const sorted = [...items]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, MAX_SUMMARY_ITEMS_PER_CLUSTER);
  return [
    `Compaction summary for ${sorted[0]?.category ?? "memory"} items:`,
    ...sorted.map((item) => {
      const date = item.createdAt.slice(0, 10);
      const text = item.summary ?? item.abstract ?? item.content.slice(0, 160);
      return `- ${date}: ${text}`;
    }),
  ].join("\n");
}

function extractAliasTerms(text: string, limit = 8): string[] {
  return [...new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff]+/u)
      .map((item) => item.trim())
      .filter((item) => item.length >= 4),
  )].slice(0, limit);
}

export async function createMemoryStore(config: MemoryStoreConfig): Promise<MemoryStore> {
  const collection = config.collection ?? DEFAULT_COLLECTION;
  const scope = config.scope;
  const hybridEnabled = config.hybridEnabled ?? true;
  const hybridScanLimit = config.hybridScanLimit ?? 250;
  const hybridLexicalWeight = config.hybridLexicalWeight ?? 0.7;
  const hybridSemanticWeight = config.hybridSemanticWeight ?? 0.3;
  const preconsciousPolicy: PreconsciousPolicyConfig = {
    ...DEFAULT_PRECONSCIOUS_POLICY,
    ...(config.preconsciousPolicy ?? {}),
    categoryBoosts: {
      ...DEFAULT_PRECONSCIOUS_POLICY.categoryBoosts,
      ...(config.preconsciousPolicy?.categoryBoosts ?? {}),
    },
  };
  const resolvedPolicyDefaults = { ...CATEGORY_POLICIES.default, ...(config.compactPolicy ?? {}) };
  const resolvedCategoryPolicies = new Map<string, CompactPolicyConfig>();
  let db: Database;

  for (const [category, policy] of Object.entries(CATEGORY_POLICIES)) {
    resolvedCategoryPolicies.set(category, { ...resolvedPolicyDefaults, ...policy });
  }
  for (const [category, overrides] of Object.entries(config.compactCategoryPolicies ?? {})) {
    const existing = resolvedCategoryPolicies.get(category) ?? resolvedPolicyDefaults;
    resolvedCategoryPolicies.set(category, { ...existing, ...(overrides ?? {}) });
  }

  async function initDb(): Promise<void> {
    db = await openDatabase(resolveDbPath(config));
    ensureSchema(db);
  }

  function ensureCollection(): void {
    mkdirSync(config.memoryDir, { recursive: true });
  }

  function sanitizeId(id: string): string {
    const base = path.basename(id).replace(/\.\./g, "");
    if (!base) throw new Error(`Invalid memory id: ${JSON.stringify(id)}`);
    return base;
  }

  function memoryFilePath(id: string): string {
    return path.join(config.memoryDir, `${sanitizeId(id)}.md`);
  }

  function pendingSessionPath(): string {
    return path.join(config.memoryDir, PENDING_SESSION_FILE);
  }

  function buildAliases(
    content: string,
    category?: string,
    tags?: string[],
    aliases?: string[],
    title?: string,
    abstract?: string,
    summary?: string,
  ): string[] {
    const derived = new Set<string>();
    if (category) derived.add(category);
    for (const tag of tags ?? []) derived.add(tag);
    for (const alias of aliases ?? []) {
      const normalized = alias.trim();
      if (normalized) derived.add(normalized);
    }
    const firstSentence = content.split(/[\r\n。！？!?]/)[0]?.trim();
    if (firstSentence && firstSentence.length <= 80) derived.add(firstSentence);
    for (const term of extractAliasTerms(title ?? "")) derived.add(term);
    for (const term of extractAliasTerms(firstSentence ?? "")) derived.add(term);
    for (const term of extractAliasTerms(abstract ?? "")) derived.add(term);
    for (const term of extractAliasTerms(summary ?? "")) derived.add(term);
    return [...derived];
  }

  function buildFullContent(content: string, category?: string, tags?: string[], aliases?: string[]): string {
    return [
      category ? `[${category}]` : "",
      tags?.length ? `tags: ${tags.join(" ")}` : "",
      aliases?.length ? `aliases: ${aliases.join(" | ")}` : "",
      content,
    ]
      .filter(Boolean)
      .join("\n");
  }

  function getDocContent(hash: string): string | null {
    const row = db.prepare(`SELECT doc FROM content WHERE hash = ?`).get(hash) as { doc: string } | undefined;
    return row?.doc ?? null;
  }

  function writeEntryFile(entry: MemoryEntry): void {
    writeFileSync(memoryFilePath(entry.id), formatMemoryFile(entry), "utf-8");
  }

  function rowToMemory(row: FTSResultExtended | DocumentScanRow, score: number): RecalledMemory {
    const parsed = parseStoredDocumentContent(row.content);
    return {
      id: row.id,
      content: parsed.content,
      title: row.title,
      category: row.category ?? undefined,
      score,
      docId: row.docId,
      accessCount: row.accessCount,
      lastAccessedAt: row.lastAccessedAt ?? undefined,
      abstract: row.abstract ?? undefined,
      summary: row.summary ?? undefined,
      created: row.createdAt,
      importance: row.importance,
      confidence: row.confidence,
      sourceType: row.sourceType,
      stage: row.stage as "memory" | "observation",
      expiresAt: row.expiresAt ?? undefined,
      archived: Boolean(row.archived),
      aliases: row.aliases ? row.aliases.split("|").map((item) => item.trim()).filter(Boolean) : undefined,
    };
  }

  async function syncEntryFileFromDb(id: string): Promise<void> {
    const entry = await get(id);
    if (!entry) return;
    writeEntryFile(entry);
  }

  async function recordAccess(ids: string[]): Promise<void> {
    const txn = db.transaction(() => {
      for (const id of ids) {
        const doc = findDocumentByPath(db, collection, id);
        if (!doc) continue;
        updateAccessCount(db, doc.id);
      }
    });
    txn();
  }

  function searchStage(
    query: string,
    limit: number,
    minScore: number,
    stage: "memory" | "observation",
    archivedFilter: "active" | "archived" | "all" = "active",
  ): RecalledMemory[] {
    const lexicalResults = searchFTSExtended(db, query, Math.max(limit * 3, 10), collection, scope, stage, archivedFilter)
      .filter((item) => item.stage === stage);
    if (!hybridEnabled || hybridScanLimit <= 0) {
      return lexicalResults
        .filter((hit) => hit.score >= minScore)
        .slice(0, limit)
        .map((hit) => rowToMemory(hit, hit.score));
    }

    const semanticCandidates = scanDocumentsExtended(db, hybridScanLimit, collection, scope, stage, archivedFilter);
    const semanticResults = rankSemanticMatches(
      query,
      semanticCandidates.map((item) => ({
        id: item.id,
        title: item.title,
        content: item.content,
        abstract: item.abstract ?? undefined,
        summary: item.summary ?? undefined,
      })),
      Math.max(limit * 3, 10),
    );
    const fused = fuseRankedResults(
      lexicalResults.map((hit) => ({ id: hit.id, score: hit.score })),
      semanticResults,
      Math.max(limit * 3, 10),
      hybridLexicalWeight,
      hybridSemanticWeight,
    );

    const lexicalMap = new Map(lexicalResults.map((item) => [item.id, item]));
    const candidateMap = new Map(semanticCandidates.map((item) => [item.id, item]));

    return fused
      .map((item) => {
        const lexical = lexicalMap.get(item.id);
        if (lexical) return rowToMemory(lexical, item.score);
        const semantic = candidateMap.get(item.id);
        return semantic ? rowToMemory(semantic, item.score) : null;
      })
      .filter((hit): hit is RecalledMemory => hit !== null)
      .filter((hit) => hit.score >= minScore)
      .slice(0, limit);
  }

  async function storeEntry(
    content: string,
    category?: string,
    tags?: string[],
    title?: string,
    options: MemoryWriteOptions = {},
  ): Promise<MemoryEntry> {
    if (!content || !content.trim()) {
      throw new Error("memory content must not be empty");
    }
    const stage = options.stage ?? "memory";
    const importance = clamp01(options.importance, stage === "observation" ? 0.45 : 0.7);
    const confidence = clamp01(options.confidence, stage === "observation" ? 0.55 : 1);
    const sourceType = options.sourceType ?? (stage === "observation" ? "capture" : "manual");
    const abstract = generateAbstract(content);
    const summary = generateSummary(content);
    const aliases = buildAliases(content, category, tags, options.aliases, title, abstract, summary);

    if (stage === "memory" && !options.skipDedupe) {
      const existingResults = searchStage(content, 3, 0.5, "memory");
      const matches: ExistingMatch[] = existingResults.map((r) => ({
        id: r.id,
        content: r.content,
        category: r.category,
        score: r.score,
      }));
      const dedup = getDedupeDecision(content, category, matches);
      if (dedup.decision === "skip") {
        const existing = await get(dedup.matchId!);
        if (existing) return existing;
      }

      if ((dedup.decision === "update" || dedup.decision === "merge") && dedup.matchId) {
        const existingDoc = findDocumentByPath(db, collection, dedup.matchId);
        if (existingDoc) {
          const existingRaw = getDocContent(existingDoc.hash);
          const existingParsed = existingRaw ? parseStoredDocumentContent(existingRaw) : null;
          const existingContent = existingParsed?.content ?? null;
          const nextContent = dedup.decision === "merge" && existingContent
            ? mergeContents(existingContent, content)
            : content;
          const mergedTags = [...new Set([...(existingParsed?.tags ?? []), ...(tags ?? [])])];
          const now = new Date().toISOString();
          const abstract = generateAbstract(nextContent);
          const summary = generateSummary(nextContent);
          const mergedAliases = buildAliases(
            nextContent,
            category ?? existingDoc.category ?? undefined,
            mergedTags.length > 0 ? mergedTags : undefined,
            options.aliases,
            title ?? existingDoc.title ?? undefined,
            abstract,
            summary,
          );
          const effectiveTags = mergedTags.length > 0 ? mergedTags : undefined;
          const fullContent = buildFullContent(nextContent, category ?? existingDoc.category ?? undefined, effectiveTags, mergedAliases);
          const newHash = hashContent(fullContent);

          try {
            insertContent(db, newHash, fullContent, now);
            updateDocument(db, existingDoc.id, {
              hash: newHash,
              title: title ?? nextContent.slice(0, 80),
              category: category ?? existingDoc.category ?? undefined,
              importance: Math.max(existingDoc.importance, importance),
              confidence: Math.max(existingDoc.confidence, confidence),
              abstract,
              summary,
              scope,
              sourceType,
              stage: "memory",
              expiresAt: options.expiresAt ?? existingDoc.expiresAt,
              aliases: mergedAliases.join("|"),
              modifiedAt: now,
            });
          } catch (err) {
            console.error(`memory-store: failed to update document ${dedup.matchId}:`, err);
            throw err;
          }

          const updated: MemoryEntry = {
            id: dedup.matchId,
            content: nextContent,
            title: title ?? existingDoc.title,
            category: category ?? existingDoc.category ?? undefined,
            tags: effectiveTags,
            created: existingDoc.createdAt,
            importance: Math.max(existingDoc.importance, importance),
            confidence: Math.max(existingDoc.confidence, confidence),
            abstract,
            summary,
            scope,
            sourceType,
            stage: "memory",
            expiresAt: options.expiresAt ?? existingDoc.expiresAt ?? undefined,
            aliases: mergedAliases,
          };
          writeEntryFile(updated);
          return updated;
        }
      }
    }

    const id = generateMemoryId(content, title);
    const created = new Date().toISOString();
    const docTitle = title ?? content.slice(0, 80);
    const entry: MemoryEntry = {
      id,
      content,
      title: docTitle,
      category,
      tags,
      created,
      importance,
      confidence,
      abstract,
      summary,
      scope,
      sourceType,
      stage,
      expiresAt: options.expiresAt,
      aliases,
    };

    writeEntryFile(entry);

    const fullContent = buildFullContent(content, category, tags, aliases);
    const hash = hashContent(fullContent);
    insertContent(db, hash, fullContent, created);
    insertDocumentExtended(db, collection, id, docTitle, hash, created, created, {
      category,
      importance,
      abstract,
      summary,
      scope,
      confidence,
      sourceType,
      stage,
      expiresAt: options.expiresAt ?? null,
      aliases: aliases.join("|"),
    });

    return entry;
  }

  async function write(
    content: string,
    category?: string,
    tags?: string[],
    title?: string,
    options: MemoryWriteOptions = {},
  ): Promise<MemoryEntry> {
    return storeEntry(content, category, tags, title, { ...options, stage: "memory" });
  }

  async function writeObservation(
    content: string,
    category?: string,
    tags?: string[],
    title?: string,
    options: MemoryWriteOptions = {},
  ): Promise<MemoryEntry> {
    const existing = searchStage(content, 1, 0.95, "observation")[0];
    if (existing?.id) {
      const current = await get(existing.id);
      const doc = findDocumentByPath(db, collection, existing.id);
      if (current && doc) {
        const nextConfidence = Math.max(current.confidence ?? 0.55, options.confidence ?? 0.55);
        const nextImportance = Math.max(current.importance ?? 0.45, options.importance ?? 0.45);
        const nextCategory = category ?? current.category;
        const nextTitle = title ?? current.title;
        const nextTags = tags?.length ? [...new Set([...(current.tags ?? []), ...tags])] : current.tags;
        const nextAbstract = generateAbstract(current.content);
        const nextSummary = generateSummary(current.content);
        const nextAliases = buildAliases(current.content, nextCategory, nextTags, undefined, nextTitle, nextAbstract, nextSummary);
        const nextFullContent = buildFullContent(current.content, nextCategory, nextTags, nextAliases);
        const nextHash = hashContent(nextFullContent);
        const now = new Date().toISOString();
        insertContent(db, nextHash, nextFullContent, now);
        updateDocument(db, doc.id, {
          hash: nextHash,
          confidence: nextConfidence,
          importance: nextImportance,
          category: nextCategory,
          title: nextTitle,
          aliases: nextAliases.join("|"),
          abstract: nextAbstract,
          summary: nextSummary,
          modifiedAt: now,
        });
        const updated: MemoryEntry = {
          ...current,
          confidence: nextConfidence,
          importance: nextImportance,
          category: nextCategory,
          title: nextTitle,
          tags: nextTags,
          abstract: nextAbstract,
          summary: nextSummary,
          aliases: nextAliases,
        };
        writeEntryFile(updated);
        return updated;
      }
    }
    return storeEntry(content, category, tags, title, {
      ...options,
      stage: "observation",
      sourceType: options.sourceType ?? "capture",
      confidence: options.confidence ?? 0.55,
      importance: options.importance ?? 0.45,
      skipDedupe: true,
    });
  }

  async function get(id: string): Promise<MemoryEntry | null> {
    const doc = findDocumentByPath(db, collection, id);

    if (doc) {
      const stored = getDocContent(doc.hash);
      const parsedStored = stored ? parseStoredDocumentContent(stored) : null;

      return {
        id,
        content: parsedStored?.content ?? "",
        title: doc.title,
        category: doc.category ?? undefined,
        tags: parsedStored?.tags,
        created: doc.createdAt,
        importance: doc.importance,
        confidence: doc.confidence,
        accessCount: doc.accessCount,
        abstract: doc.abstract ?? undefined,
        summary: doc.summary ?? undefined,
        scope: doc.scope ?? undefined,
        sourceType: doc.sourceType ?? undefined,
        stage: (doc.stage as "memory" | "observation") ?? undefined,
        expiresAt: doc.expiresAt ?? undefined,
        archived: Boolean(doc.archived),
        lastAccessedAt: doc.lastAccessedAt ?? undefined,
        aliases: doc.aliases
          ? doc.aliases.split("|").map((item) => item.trim()).filter(Boolean)
          : parsedStored?.aliases,
      };
    }

    const filePath = memoryFilePath(id);
    if (existsSync(filePath)) {
      try {
        return parseMemoryFile(readFileSync(filePath, "utf-8"));
      } catch (err) {
        console.error(`memory-store: failed to parse memory file ${filePath}:`, err);
        return null;
      }
    }

    return null;
  }

  async function deleteMemory(id: string): Promise<boolean> {
    const doc = findDocumentByPath(db, collection, id);
    if (doc) {
      deleteDocument(db, doc.id);
    }
    const filePath = memoryFilePath(id);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      return true;
    }
    return doc !== null;
  }

  async function reindex(): Promise<void> {

  }

  async function getStats(): Promise<MemoryStats> {
    type Row = {
      category: string | null;
      stage: string;
      sourceType: string;
      archived: number;
      expiresAt: string | null;
      total: number;
    };

    const rows = db.prepare(
      `SELECT
         category,
         stage,
         source_type as sourceType,
         archived,
         expires_at as expiresAt,
         COUNT(*) as total
       FROM documents
       WHERE collection = ? AND active = 1
       GROUP BY category, stage, source_type, archived, expires_at`,
    ).all(collection) as Row[];

    const stats: MemoryStats = {
      total: 0,
      active: 0,
      archived: 0,
      memory: 0,
      observations: 0,
      expiredActive: 0,
      categories: {},
      stages: {},
      sourceTypes: {},
    };
    const now = Date.now();

    for (const row of rows) {
      const count = Number(row.total) || 0;
      const category = row.category ?? "uncategorized";
      const bucket = stats.categories[category] ?? {
        total: 0,
        active: 0,
        archived: 0,
        memory: 0,
        observations: 0,
      };

      stats.total += count;
      bucket.total += count;

      if (row.archived) {
        stats.archived += count;
        bucket.archived += count;
      } else {
        stats.active += count;
        bucket.active += count;
        if (row.expiresAt && new Date(row.expiresAt).getTime() <= now) {
          stats.expiredActive += count;
        }
      }

      if (row.stage === "observation") {
        stats.observations += count;
        bucket.observations += count;
      } else {
        stats.memory += count;
        bucket.memory += count;
      }

      stats.categories[category] = bucket;
      stats.stages[row.stage] = (stats.stages[row.stage] ?? 0) + count;
      stats.sourceTypes[row.sourceType] = (stats.sourceTypes[row.sourceType] ?? 0) + count;
    }

    return stats;
  }

  async function listObservations(limit: number, minConfidence = 0): Promise<RecalledMemory[]> {
    const oversample = minConfidence > 0 ? Math.max(limit * 5, 50) : Math.max(limit, 1);
    return scanDocumentsExtended(db, oversample, collection, scope, "observation")
      .filter((item) => item.confidence >= minConfidence)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit)
      .map((item) => rowToMemory(item, item.confidence));
  }

  async function reviewObservation(
    id: string,
    action: "promote" | "drop" | "archive",
  ): Promise<{ action: string; reviewed: boolean; promotedId?: string }> {
    const doc = findDocumentByPath(db, collection, id);
    if (!doc || doc.stage !== "observation" || doc.archived) {
      return { action, reviewed: false };
    }

    if (action === "drop") {
      const deleted = await deleteMemory(id);
      return { action, reviewed: deleted };
    }

    if (action === "archive") {
      updateDocument(db, doc.id, {
        archived: 1,
        modifiedAt: new Date().toISOString(),
      });
      await syncEntryFileFromDb(id);
      return { action, reviewed: true };
    }

    const entry = await get(id);
    if (!entry) {
      return { action, reviewed: false };
    }

    const promoted = await write(
      entry.content,
      entry.category,
      entry.tags,
      doc.title,
      {
        importance: entry.importance,
        confidence: entry.confidence,
        sourceType: entry.sourceType,
        expiresAt: entry.expiresAt,
        aliases: entry.aliases,
      },
    );
    updateDocument(db, doc.id, {
      archived: 1,
      modifiedAt: new Date().toISOString(),
    });
    await syncEntryFileFromDb(id);
    return { action, reviewed: true, promotedId: promoted.id };
  }

  async function compact(): Promise<CompactReport> {
    const currentTime = Date.now();
    const observations = scanDocumentsExtended(db, 500, collection, scope, "observation")
      .filter((item) => !item.expiresAt || new Date(item.expiresAt).getTime() > currentTime);
    const groups = new Map<string, DocumentScanRow[]>();
    for (const item of observations) {
      const key = normalizeStoredContent(item.content);
      const bucket = groups.get(key) ?? [];
      bucket.push(item);
      groups.set(key, bucket);
    }

    let promoted = 0;
    let archived = 0;
    let skipped = 0;
    let summarized = 0;
    const promotedIds: string[] = [];
    const archivedIds: string[] = [];
    const skippedIds: string[] = [];
    const summarizedIds: string[] = [];
    const actions: CompactReport["actions"] = [];
    const now = new Date().toISOString();

    for (const items of groups.values()) {
      const latest = [...items].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
      const maxConfidence = Math.max(...items.map((item) => item.confidence));
      const maxImportance = Math.max(...items.map((item) => item.importance));
      const policy = resolvedCategoryPolicies.get(latest.category ?? "") ?? resolvedCategoryPolicies.get("default")!;
      const shouldPromote =
        items.length >= policy.promoteOccurrences ||
        maxConfidence >= policy.promoteConfidence ||
        maxImportance >= policy.promoteImportance;

      if (shouldPromote) {
        const parsedLatest = parseStoredDocumentContent(latest.content);
        const promotedEntry = await write(
          parsedLatest.content,
          latest.category ?? undefined,
          parsedLatest.tags,
          latest.title,
          {
            confidence: maxConfidence,
            importance: maxImportance,
            sourceType: latest.sourceType,
            aliases: latest.aliases ? latest.aliases.split("|").filter(Boolean) : undefined,
            expiresAt: latest.expiresAt ?? undefined,
          },
        );
        promoted += 1;
        promotedIds.push(promotedEntry.id);
        actions.push({
          action: "promote",
          id: promotedEntry.id,
          reason: `observation matched compact policy: occurrences=${items.length}, confidence=${maxConfidence.toFixed(2)}, importance=${maxImportance.toFixed(2)}`,
          stage: "observation",
          category: latest.category ?? undefined,
        });
        const archivedInTxn: typeof items = [];
        const archiveObservations = db.transaction(() => {
          for (const item of items) {
            const doc = findDocumentByPath(db, collection, item.id);
            if (doc) {
              updateDocument(db, doc.id, {
                archived: 1,
                modifiedAt: now,
              });
              archivedInTxn.push(item);
            }
          }
        });
        archiveObservations();
        for (const item of archivedInTxn) {
          archived += 1;
          archivedIds.push(item.id);
          actions.push({
            action: "archive",
            id: item.id,
            reason: `observation archived after promotion into ${promotedEntry.id}`,
            stage: "observation",
            category: item.category ?? undefined,
          });
          await syncEntryFileFromDb(item.id);
        }
      } else {
        skipped += items.length;
        skippedIds.push(...items.map((item) => item.id));
        for (const item of items) {
          actions.push({
            action: "skip",
            id: item.id,
            reason: `observation below compact thresholds: occurrences=${items.length}, confidence=${maxConfidence.toFixed(2)}, importance=${maxImportance.toFixed(2)}`,
            stage: "observation",
            category: item.category ?? undefined,
          });
        }
      }
    }

    const memoryItems = scanDocumentsExtended(db, 500, collection, scope, "memory");
    const archiveCandidatesByCategory = new Map<string, DocumentScanRow[]>();
    for (const item of memoryItems) {
      const policy = resolvedCategoryPolicies.get(item.category ?? "") ?? resolvedCategoryPolicies.get("default")!;
      const expired = item.expiresAt ? new Date(item.expiresAt).getTime() <= Date.now() : false;
      const stale = daysBetween(item.createdAt, now) > policy.archiveAfterDays && (item.importance ?? 0.5) < 0.75;
      if (!expired && !stale) continue;
      const key = item.category ?? "default";
      const bucket = archiveCandidatesByCategory.get(key) ?? [];
      bucket.push(item);
      archiveCandidatesByCategory.set(key, bucket);
    }

    for (const [category, items] of archiveCandidatesByCategory.entries()) {
      const policy = resolvedCategoryPolicies.get(category) ?? resolvedCategoryPolicies.get("default")!;
      if (policy.summarizeBeforeArchive && items.length >= 2) {
        const summaryContent = summarizeCluster(items);
        const summaryEntry = await write(
          summaryContent,
          category === "event" ? "pattern" : category,
          ["compaction", "summary"],
          `compact-${category}-summary`,
          {
            importance: 0.78,
            confidence: 0.82,
            sourceType: "compaction",
            aliases: [category, "summary", "archive"],
            skipDedupe: true,
          },
        );
        summarized += 1;
        summarizedIds.push(summaryEntry.id);
        actions.push({
          action: "summarize",
          id: summaryEntry.id,
          reason: `created compaction summary for ${items.length} ${category} items before archiving`,
          stage: "memory",
          category,
        });
      }

      const archivedMemsInTxn: typeof items = [];
      const archiveMemories = db.transaction(() => {
        for (const item of items) {
          const doc = findDocumentByPath(db, collection, item.id);
          if (!doc) continue;
          updateDocument(db, doc.id, {
            archived: 1,
            modifiedAt: now,
          });
          archivedMemsInTxn.push(item);
        }
      });
      archiveMemories();
      for (const item of archivedMemsInTxn) {
        archived += 1;
        archivedIds.push(item.id);
        actions.push({
          action: "archive",
          id: item.id,
          reason: item.expiresAt && new Date(item.expiresAt).getTime() <= Date.now()
            ? "memory expired"
            : "memory became stale under compact policy",
          stage: "memory",
          category: item.category ?? undefined,
        });
        await syncEntryFileFromDb(item.id);
      }
    }

    return { promoted, archived, skipped, summarized, promotedIds, archivedIds, skippedIds, summarizedIds, actions };
  }

  async function buildPreconscious(limit: number): Promise<PreconsciousItem[]> {
    const candidates = scanDocumentsExtended(db, Math.max(limit * 6, 20), collection, scope, "memory");
    const ranked = candidates
      .filter((item) => !item.expiresAt || new Date(item.expiresAt).getTime() > Date.now())
      .filter((item) => daysBetween(item.createdAt) <= preconsciousPolicy.maxAgeDays)
      .map((item) => {
        const recencyBoost = Math.max(0, 1 - (daysBetween(item.createdAt) / Math.max(preconsciousPolicy.maxAgeDays, 1)));
        const categoryBoost = preconsciousPolicy.categoryBoosts[item.category ?? ""] ?? 0;
        const score =
          (item.importance * preconsciousPolicy.importanceWeight) +
          (item.confidence * preconsciousPolicy.confidenceWeight) +
          (recencyBoost * preconsciousPolicy.recencyWeight) +
          categoryBoost;
        return {
          id: item.id,
          content: parseStoredDocumentContent(item.content).content,
          category: item.category ?? undefined,
          score,
          abstract: item.abstract ?? undefined,
          summary: item.summary ?? undefined,
          created: item.createdAt,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return ranked;
  }

  async function persistPendingSession(payload: PendingSessionPayload): Promise<void> {
    writeFileSync(pendingSessionPath(), JSON.stringify(payload, null, 2), "utf-8");
  }

  async function clearPendingSession(): Promise<void> {
    const filePath = pendingSessionPath();
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  }

  async function recoverPendingSession(): Promise<number> {
    const filePath = pendingSessionPath();
    if (!existsSync(filePath)) return 0;
    let parsed: PendingSessionPayload | null = null;
    try {
      parsed = JSON.parse(readFileSync(filePath, "utf-8")) as PendingSessionPayload;
    } catch {
      unlinkSync(filePath);
      return 0;
    }

    let recovered = 0;
    const existingNormalized = new Set<string>([
      ...scanDocumentsExtended(db, 1000, collection, scope, "observation", "all").map((item) => normalizeStoredContent(item.content)),
      ...scanDocumentsExtended(db, 1000, collection, scope, "memory", "all").map((item) => normalizeStoredContent(item.content)),
    ]);
    for (const entry of parsed.entries ?? []) {
      const normalized = normalizeKey(entry.content);
      if (existingNormalized.has(normalized)) continue;
      await writeObservation(entry.content, entry.category, entry.tags, entry.title, {
        confidence: entry.confidence ?? 0.55,
        importance: entry.importance ?? 0.45,
        sourceType: "recovery",
      });
      existingNormalized.add(normalized);
      recovered += 1;
    }

    unlinkSync(filePath);
    return recovered;
  }

  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    processClosers.delete(close);
    try {
      db?.close();
    } catch {

    }
  }

  ensureCollection();
  await initDb();
  installProcessExitHook();
  processClosers.add(close);

  return {
    write,
    writeObservation,
    search: (q, l, m) => Promise.resolve(searchStage(q, l, m, "memory")),
    searchWithArchived: async (q, l, m) => {
      const active = searchStage(q, Math.max(l * 2, 10), m, "memory", "active");
      const archivedResults = searchStage(q, Math.max(l * 2, 10), m, "memory", "archived")
        .map((item) => ({ ...item, score: item.score * 0.82 }));
      const merged = [...active];
      const seen = new Set(active.map((item) => item.id));
      for (const item of archivedResults) {
        if (!seen.has(item.id)) merged.push(item);
      }
      return merged
        .sort((a, b) => b.score - a.score)
        .slice(0, l);
    },
    searchArchived: (q, l, m) => Promise.resolve(searchStage(q, l, m, "memory", "archived")),
    listObservations,
    reviewObservation,
    get,
    getStats,
    delete: deleteMemory,
    ensureCollection,
    reindex,
    compact,
    buildPreconscious,
    persistPendingSession,
    clearPendingSession,
    recoverPendingSession,
    recordAccess,
    close,
  };
}

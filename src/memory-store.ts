import { writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import {
  openDatabase,
  ensureSchema,
  searchFTSExtended,
  hashContent,
  insertContent,
  insertDocumentExtended,
  updateDocument,
  updateAccessCount,
  deleteDocument,
  findDocumentByPath,
  type Database,
  type FTSResultExtended,
} from "./qmd-lite.js";
import {
  generateMemoryId,
  formatMemoryFile,
  parseMemoryFile,
  type MemoryEntry,
} from "./memory-format.js";
import { generateAbstract, generateSummary } from "./layered-context.js";
import {
  getDedupeDecision,
  mergeContents,
  type ExistingMatch,
} from "./memory-dedup.js";

export type MemoryStoreConfig = {
  memoryDir: string;
  dbPath?: string;
  collection?: string;
  scope?: string;
};

export type RecalledMemory = {
  id: string;
  content: string;
  category?: string;
  score: number;
  docId?: number;
  accessCount?: number;
  lastAccessedAt?: string;
  abstract?: string;
  summary?: string;
  created?: string;
};

export type MemoryStore = {
  write(content: string, category?: string, tags?: string[], title?: string): Promise<MemoryEntry>;
  search(query: string, limit: number, minScore: number): Promise<RecalledMemory[]>;
  get(id: string): Promise<MemoryEntry | null>;
  delete(id: string): Promise<boolean>;
  ensureCollection(): void;
  reindex(): Promise<void>;
  close(): void;
};

const DEFAULT_COLLECTION = "memories";

function resolveDbPath(config: MemoryStoreConfig): string {
  return config.dbPath ?? path.join(config.memoryDir, "memories.db");
}

export async function createMemoryStore(config: MemoryStoreConfig): Promise<MemoryStore> {
  const collection = config.collection ?? DEFAULT_COLLECTION;
  const scope = config.scope;
  let db: Database;

  async function initDb(): Promise<void> {
    db = await openDatabase(resolveDbPath(config));
    ensureSchema(db);
  }

  function ensureCollection(): void {
    mkdirSync(config.memoryDir, { recursive: true });
  }

  async function write(
    content: string,
    category?: string,
    tags?: string[],
    title?: string,
  ): Promise<MemoryEntry> {
    // 去重检查
    const existingResults = searchMemories(content, 3, 0.5);
    const matches: ExistingMatch[] = existingResults.map((r) => ({
      id: r.id,
      content: r.content,
      category: r.category,
      score: r.score,
    }));

    const dedup = getDedupeDecision(content, category, matches);

    if (dedup.decision === "skip") {
      // 返回已有记忆
      const existing = await get(dedup.matchId!);
      if (existing) return existing;
    }

    if (dedup.decision === "update" && dedup.matchId) {
      // 更新已有记忆
      const existingDoc = findDocumentByPath(db, collection, dedup.matchId);
      if (existingDoc) {
        const now = new Date().toISOString();
        const newHash = hashContent(content);
        const newAbstract = generateAbstract(content);
        const newSummary = generateSummary(content);

        insertContent(db, newHash, buildFullContent(content, category, tags), now);
        updateDocument(db, existingDoc.id, {
          hash: newHash,
          title: title ?? content.slice(0, 80),
          category,
          abstract: newAbstract,
          summary: newSummary,
          modifiedAt: now,
        });

        const entry: MemoryEntry = {
          id: dedup.matchId,
          content,
          category,
          tags,
          created: existingDoc.createdAt,
          abstract: newAbstract,
          summary: newSummary,
          scope,
        };
        // 更新 md 文件
        const filePath = path.join(config.memoryDir, `${dedup.matchId}.md`);
        writeFileSync(filePath, formatMemoryFile(entry), "utf-8");
        return entry;
      }
    }

    if (dedup.decision === "merge" && dedup.matchId) {
      // 合并内容
      const existingDoc = findDocumentByPath(db, collection, dedup.matchId);
      if (existingDoc) {
        const existingContent = getDocContent(existingDoc.hash);
        if (existingContent) {
          const merged = mergeContents(existingContent, content);
          const now = new Date().toISOString();
          const newHash = hashContent(merged);
          const newAbstract = generateAbstract(merged);
          const newSummary = generateSummary(merged);

          insertContent(db, newHash, buildFullContent(merged, category ?? existingDoc.category ?? undefined, tags), now);
          updateDocument(db, existingDoc.id, {
            hash: newHash,
            title: title ?? merged.slice(0, 80),
            abstract: newAbstract,
            summary: newSummary,
            modifiedAt: now,
          });

          const entry: MemoryEntry = {
            id: dedup.matchId,
            content: merged,
            category: category ?? existingDoc.category ?? undefined,
            tags,
            created: existingDoc.createdAt,
            abstract: newAbstract,
            summary: newSummary,
            scope,
          };
          const filePath = path.join(config.memoryDir, `${dedup.matchId}.md`);
          writeFileSync(filePath, formatMemoryFile(entry), "utf-8");
          return entry;
        }
      }
    }

    // CREATE 新记忆
    const id = generateMemoryId(content, title);
    const created = new Date().toISOString();
    const abstract = generateAbstract(content);
    const summary = generateSummary(content);
    const entry: MemoryEntry = {
      id,
      content,
      category,
      tags,
      created,
      abstract,
      summary,
      scope,
    };

    // 写 markdown 文件
    const filePath = path.join(config.memoryDir, `${id}.md`);
    writeFileSync(filePath, formatMemoryFile(entry), "utf-8");

    // 写入 SQLite FTS 索引
    const fullContent = buildFullContent(content, category, tags);
    const hash = hashContent(fullContent);
    const docTitle = title ?? content.slice(0, 80);

    insertContent(db, hash, fullContent, created);
    insertDocumentExtended(db, collection, id, docTitle, hash, created, created, {
      category,
      abstract,
      summary,
      scope,
    });

    return entry;
  }

  function buildFullContent(content: string, category?: string, tags?: string[]): string {
    return [
      category ? `[${category}]` : "",
      tags?.length ? `tags: ${tags.join(" ")}` : "",
      content,
    ]
      .filter(Boolean)
      .join("\n");
  }

  function getDocContent(hash: string): string | null {
    const row = db.prepare(`SELECT doc FROM content WHERE hash = ?`).get(hash) as
      | { doc: string }
      | undefined;
    return row?.doc ?? null;
  }

  function searchMemories(
    query: string,
    limit: number,
    minScore: number,
  ): RecalledMemory[] {
    const results = searchFTSExtended(db, query, limit, collection, scope);

    return results
      .filter((hit) => hit.score >= minScore)
      .map((hit: FTSResultExtended) => ({
        id: hit.id,
        content: hit.content,
        category: hit.category ?? undefined,
        score: hit.score,
        docId: hit.docId,
        accessCount: hit.accessCount,
        lastAccessedAt: hit.lastAccessedAt ?? undefined,
        abstract: hit.abstract ?? undefined,
        summary: hit.summary ?? undefined,
        created: hit.createdAt,
      }));
  }

  async function get(id: string): Promise<MemoryEntry | null> {
    const filePath = path.join(config.memoryDir, `${id}.md`);
    if (!existsSync(filePath)) return null;
    try {
      const raw = readFileSync(filePath, "utf-8");
      return parseMemoryFile(raw);
    } catch {
      return null;
    }
  }

  async function deleteMemory(id: string): Promise<boolean> {
    const doc = findDocumentByPath(db, collection, id);
    if (doc) {
      deleteDocument(db, doc.id);
    }
    const filePath = path.join(config.memoryDir, `${id}.md`);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      return true;
    }
    return doc !== null;
  }

  async function reindex(): Promise<void> {
    // SQLite FTS 索引在写入时自动更新，无需手动 reindex
  }

  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    process.removeListener("exit", close);
    try {
      db?.close();
    } catch {
      // 忽略关闭错误
    }
  }

  // 初始化
  ensureCollection();
  await initDb();

  // 进程退出时自动关闭数据库
  process.on("exit", close);

  return {
    write,
    search: (q, l, m) => Promise.resolve(searchMemories(q, l, m)),
    get,
    delete: deleteMemory,
    ensureCollection,
    reindex,
    close,
  };
}

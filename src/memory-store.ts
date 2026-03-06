import { writeFileSync, mkdirSync } from "node:fs";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import {
  openDatabase,
  ensureSchema,
  searchFTS,
  hashContent,
  insertContent,
  insertDocument,
  findActiveDocument,
  type Database,
} from "./qmd-lite.js";
import {
  generateMemoryId,
  formatMemoryFile,
  parseMemoryFile,
  type MemoryEntry,
  type RecalledMemory,
} from "./memory-format.js";

export type MemoryStoreConfig = {
  memoryDir: string;
  dbPath?: string;
  collection?: string;
};

export type MemoryStore = {
  write(content: string, category?: string, tags?: string[], title?: string): Promise<MemoryEntry>;
  search(query: string, limit: number, minScore: number): Promise<RecalledMemory[]>;
  get(id: string): Promise<MemoryEntry | null>;
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
    const id = generateMemoryId(content, title);
    const created = new Date().toISOString();
    const entry: MemoryEntry = { id, content, category, tags, created };

    // 写 markdown 文件（人可读）
    const filePath = path.join(config.memoryDir, `${id}.md`);
    writeFileSync(filePath, formatMemoryFile(entry), "utf-8");

    // 写入 SQLite FTS 索引
    const fullContent = [
      category ? `[${category}]` : "",
      tags?.length ? `tags: ${tags.join(" ")}` : "",
      content,
    ]
      .filter(Boolean)
      .join("\n");

    const hash = hashContent(fullContent);
    const docTitle = title ?? content.slice(0, 80);

    insertContent(db, hash, fullContent, created);
    insertDocument(db, collection, id, docTitle, hash, created, created);

    return entry;
  }

  async function searchMemories(
    query: string,
    limit: number,
    minScore: number,
  ): Promise<RecalledMemory[]> {
    const results = searchFTS(db, query, limit, collection);

    return results
      .filter((hit) => hit.score >= minScore)
      .map((hit) => ({
        id: hit.id,
        content: hit.content,
        category: extractCategory(hit.content),
        score: hit.score,
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

  // 进程退出时自动关闭数据库，防止 WAL/SHM 残留
  process.on("exit", close);

  return { write, search: searchMemories, get, ensureCollection, reindex, close };
}

function extractCategory(content: string): string | undefined {
  const match = content.match(/^\[(\w+)\]/);
  return match?.[1];
}

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

export interface Statement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
  transaction(fn: (...args: any[]) => any): (...args: any[]) => any;
}

let _DatabaseCtor: new (path: string) => Database;

async function loadDatabaseCtor(): Promise<void> {
  if (_DatabaseCtor) return;

  if (typeof (globalThis as Record<string, unknown>).Bun !== "undefined") {
    const bunSqlite = "bun:" + "sqlite";
    _DatabaseCtor = (await import(/* @vite-ignore */ bunSqlite)).Database;
  } else {
    _DatabaseCtor = (await import("better-sqlite3")).default;
  }
}

export async function openDatabase(dbPath: string): Promise<Database> {
  await loadDatabaseCtor();
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new _DatabaseCtor(dbPath);

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA cache_size = -4000");
  db.exec("PRAGMA wal_autocheckpoint = 1000");

  return db;
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS content (
    hash TEXT PRIMARY KEY,
    doc TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collection TEXT NOT NULL,
    path TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    modified_at TEXT NOT NULL,
    category TEXT,
    importance REAL NOT NULL DEFAULT 0.5,
    access_count INTEGER NOT NULL DEFAULT 0,
    last_accessed_at TEXT,
    abstract TEXT,
    summary TEXT,
    scope TEXT,
    confidence REAL NOT NULL DEFAULT 1,
    source_type TEXT NOT NULL DEFAULT 'manual',
    stage TEXT NOT NULL DEFAULT 'memory',
    expires_at TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    aliases TEXT,
    FOREIGN KEY (hash) REFERENCES content(hash)
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
    title,
    doc,
    content=''
  );

  CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents
  WHEN new.active = 1
  BEGIN
    INSERT INTO documents_fts(rowid, title, doc)
    SELECT new.id, new.title, content.doc
    FROM content WHERE content.hash = new.hash;
  END;

  CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents
  BEGIN
    INSERT INTO documents_fts(documents_fts, rowid, title, doc)
    SELECT 'delete', old.id, old.title, content.doc
    FROM content WHERE content.hash = old.hash;
  END;

  CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE OF hash, active ON documents
  BEGIN
    INSERT INTO documents_fts(documents_fts, rowid, title, doc)
    SELECT 'delete', old.id, old.title, content.doc
    FROM content WHERE content.hash = old.hash;
    INSERT INTO documents_fts(rowid, title, doc)
    SELECT new.id, new.title, content.doc
    FROM content WHERE content.hash = new.hash
    AND new.active = 1;
  END;
`;

export function ensureSchema(db: Database): void {
  db.exec(SCHEMA_SQL);
  ensureColumn(db, "documents", "confidence", "REAL NOT NULL DEFAULT 1");
  ensureColumn(db, "documents", "source_type", "TEXT NOT NULL DEFAULT 'manual'");
  ensureColumn(db, "documents", "stage", "TEXT NOT NULL DEFAULT 'memory'");
  ensureColumn(db, "documents", "expires_at", "TEXT");
  ensureColumn(db, "documents", "archived", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "documents", "aliases", "TEXT");
}

const VALID_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function ensureColumn(
  db: Database,
  table: string,
  column: string,
  definition: string,
): void {
  if (!VALID_IDENTIFIER.test(table)) throw new Error(`Invalid table name: ${table}`);
  if (!VALID_IDENTIFIER.test(column)) throw new Error(`Invalid column name: ${column}`);
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((item) => item.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function sanitizeFTS5Term(term: string): string {
  return term.replace(/[^\p{L}\p{N}']/gu, "").toLowerCase();
}

function buildFTS5Query(query: string): string | null {
  const terms = query
    .split(/\s+/)
    .map((t) => sanitizeFTS5Term(t))
    .filter((t) => t.length > 0);
  if (terms.length === 0) return null;
  if (terms.length === 1) return `"${terms[0]}"*`;
  return terms.map((t) => `"${t}"*`).join(" AND ");
}

export type FTSResult = {
  id: string;
  content: string;
  title: string;
  collection: string;
  score: number;
};

export function searchFTS(
  db: Database,
  query: string,
  limit = 20,
  collectionName?: string,
): FTSResult[] {
  const ftsQuery = buildFTS5Query(query);
  if (!ftsQuery) return [];

  let sql = `
    SELECT
      d.id,
      d.collection,
      d.path,
      d.title,
      content.doc as body,
      d.hash,
      bm25(documents_fts, 10.0, 1.0) as bm25_score
    FROM documents_fts f
    JOIN documents d ON d.id = f.rowid
    JOIN content ON content.hash = d.hash
    WHERE documents_fts MATCH ? AND d.active = 1
  `;
  const params: unknown[] = [ftsQuery];

  if (collectionName) {
    sql += ` AND d.collection = ?`;
    params.push(collectionName);
  }

  sql += ` ORDER BY bm25_score ASC LIMIT ?`;
  params.push(limit);

  type Row = {
    id: number;
    collection: string;
    path: string;
    title: string;
    body: string;
    hash: string;
    bm25_score: number;
  };

  const rows = db.prepare(sql).all(...params) as Row[];

  return rows.map((row) => {
    const score = Math.abs(row.bm25_score) / (1 + Math.abs(row.bm25_score));
    return {
      id: row.path,
      content: row.body,
      title: row.title,
      collection: row.collection,
      score,
    };
  });
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function insertContent(
  db: Database,
  hash: string,
  content: string,
  createdAt: string,
): void {
  db.prepare(`INSERT OR IGNORE INTO content (hash, doc, created_at) VALUES (?, ?, ?)`).run(
    hash,
    content,
    createdAt,
  );
}

export function insertDocument(
  db: Database,
  collection: string,
  docPath: string,
  title: string,
  hash: string,
  createdAt: string,
  modifiedAt: string,
): void {
  db.prepare(
    `INSERT INTO documents (collection, path, title, hash, active, created_at, modified_at) VALUES (?, ?, ?, ?, 1, ?, ?)`,
  ).run(collection, docPath, title, hash, createdAt, modifiedAt);
}

export function findActiveDocument(
  db: Database,
  collection: string,
  docPath: string,
): { id: number; hash: string } | null {
  return (
    (db
      .prepare(`SELECT id, hash FROM documents WHERE collection = ? AND path = ? AND active = 1`)
      .get(collection, docPath) as { id: number; hash: string } | undefined) ?? null
  );
}

export function updateAccessCount(db: Database, docId: number): void {
  db.prepare(
    `UPDATE documents SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?`,
  ).run(new Date().toISOString(), docId);
}

export function updateDocument(
  db: Database,
  docId: number,
  fields: {
    hash?: string;
    title?: string;
    category?: string;
    importance?: number;
    abstract?: string;
    summary?: string;
    scope?: string;
    confidence?: number;
    sourceType?: string;
    stage?: string;
    expiresAt?: string | null;
    archived?: number;
    aliases?: string | null;
    modifiedAt?: string;
  },
): void {
  const sets: string[] = [];
  const params: unknown[] = [];

  if (fields.hash !== undefined) { sets.push("hash = ?"); params.push(fields.hash); }
  if (fields.title !== undefined) { sets.push("title = ?"); params.push(fields.title); }
  if (fields.category !== undefined) { sets.push("category = ?"); params.push(fields.category); }
  if (fields.importance !== undefined) { sets.push("importance = ?"); params.push(fields.importance); }
  if (fields.abstract !== undefined) { sets.push("abstract = ?"); params.push(fields.abstract); }
  if (fields.summary !== undefined) { sets.push("summary = ?"); params.push(fields.summary); }
  if (fields.scope !== undefined) { sets.push("scope = ?"); params.push(fields.scope); }
  if (fields.confidence !== undefined) { sets.push("confidence = ?"); params.push(fields.confidence); }
  if (fields.sourceType !== undefined) { sets.push("source_type = ?"); params.push(fields.sourceType); }
  if (fields.stage !== undefined) { sets.push("stage = ?"); params.push(fields.stage); }
  if (fields.expiresAt !== undefined) { sets.push("expires_at = ?"); params.push(fields.expiresAt); }
  if (fields.archived !== undefined) { sets.push("archived = ?"); params.push(fields.archived); }
  if (fields.aliases !== undefined) { sets.push("aliases = ?"); params.push(fields.aliases); }
  if (fields.modifiedAt !== undefined) { sets.push("modified_at = ?"); params.push(fields.modifiedAt); }

  if (sets.length === 0) return;
  params.push(docId);
  db.prepare(`UPDATE documents SET ${sets.join(", ")} WHERE id = ?`).run(...params);
}

export function deleteDocument(db: Database, docId: number): void {
  db.prepare(`DELETE FROM documents WHERE id = ?`).run(docId);
}

export function findDocumentByPath(
  db: Database,
  collection: string,
  docPath: string,
): {
  id: number;
  hash: string;
  title: string;
  category: string | null;
  importance: number;
  accessCount: number;
  lastAccessedAt: string | null;
  abstract: string | null;
  summary: string | null;
  scope: string | null;
  confidence: number;
  sourceType: string;
  stage: string;
  expiresAt: string | null;
  archived: number;
  aliases: string | null;
  createdAt: string;
} | null {
  return (
    (db
      .prepare(
        `SELECT id, hash, title, category, importance, access_count as accessCount, last_accessed_at as lastAccessedAt, abstract, summary, scope,
                confidence, source_type as sourceType, stage, expires_at as expiresAt,
                archived, aliases, created_at as createdAt
         FROM documents WHERE collection = ? AND path = ? AND active = 1`,
      )
      .get(collection, docPath) as {
      id: number;
      hash: string;
      title: string;
      category: string | null;
      importance: number;
      accessCount: number;
      lastAccessedAt: string | null;
      abstract: string | null;
      summary: string | null;
      scope: string | null;
      confidence: number;
      sourceType: string;
      stage: string;
      expiresAt: string | null;
      archived: number;
      aliases: string | null;
      createdAt: string;
    } | undefined) ?? null
  );
}

export type FTSResultExtended = FTSResult & {
  docId: number;
  category: string | null;
  importance: number;
  accessCount: number;
  lastAccessedAt: string | null;
  abstract: string | null;
  summary: string | null;
  scope: string | null;
  confidence: number;
  sourceType: string;
  stage: string;
  expiresAt: string | null;
  archived: number;
  aliases: string | null;
  createdAt: string;
};

export type DocumentScanRow = {
  id: string;
  docId: number;
  title: string;
  content: string;
  category: string | null;
  importance: number;
  accessCount: number;
  lastAccessedAt: string | null;
  abstract: string | null;
  summary: string | null;
  scope: string | null;
  confidence: number;
  sourceType: string;
  stage: string;
  expiresAt: string | null;
  archived: number;
  aliases: string | null;
  createdAt: string;
};

export type ArchivedFilter = "active" | "archived" | "all";

export function searchFTSExtended(
  db: Database,
  query: string,
  limit = 20,
  collectionName?: string,
  scope?: string,
  stage: "memory" | "observation" = "memory",
  archivedFilter: ArchivedFilter = "active",
): FTSResultExtended[] {
  const ftsQuery = buildFTS5Query(query);
  if (!ftsQuery) return [];

  let sql = `
    SELECT
      d.id as docId,
      d.collection,
      d.path,
      d.title,
      content.doc as body,
      d.hash,
      d.category,
      d.importance,
      d.access_count as accessCount,
      d.last_accessed_at as lastAccessedAt,
      d.abstract,
      d.summary,
      d.scope,
      d.confidence,
      d.source_type as sourceType,
      d.stage,
      d.expires_at as expiresAt,
      d.archived,
      d.aliases,
      d.created_at as createdAt,
      bm25(documents_fts, 10.0, 1.0) as bm25_score
    FROM documents_fts f
    JOIN documents d ON d.id = f.rowid
    JOIN content ON content.hash = d.hash
    WHERE documents_fts MATCH ? AND d.active = 1 AND d.stage = ?
  `;
  const params: unknown[] = [ftsQuery, stage];

  if (archivedFilter === "active") {
    sql += ` AND d.archived = 0`;
  } else if (archivedFilter === "archived") {
    sql += ` AND d.archived = 1`;
  }

  if (collectionName) {
    sql += ` AND d.collection = ?`;
    params.push(collectionName);
  }

  if (scope) {
    sql += ` AND d.scope = ?`;
    params.push(scope);
  }

  sql += ` ORDER BY bm25_score ASC LIMIT ?`;
  params.push(limit);

  type Row = {
    docId: number;
    collection: string;
    path: string;
    title: string;
    body: string;
    hash: string;
    category: string | null;
    importance: number;
    accessCount: number;
    lastAccessedAt: string | null;
    abstract: string | null;
    summary: string | null;
    scope: string | null;
    confidence: number;
    sourceType: string;
    stage: string;
    expiresAt: string | null;
    archived: number;
    aliases: string | null;
    createdAt: string;
    bm25_score: number;
  };

  const rows = db.prepare(sql).all(...params) as Row[];

  return rows.map((row) => {
    const score = Math.abs(row.bm25_score) / (1 + Math.abs(row.bm25_score));
    return {
      id: row.path,
      content: row.body,
      title: row.title,
      collection: row.collection,
      score,
      docId: row.docId,
      category: row.category,
      importance: row.importance,
      accessCount: row.accessCount,
      lastAccessedAt: row.lastAccessedAt,
      abstract: row.abstract,
      summary: row.summary,
      scope: row.scope,
      confidence: row.confidence,
      sourceType: row.sourceType,
      stage: row.stage,
      expiresAt: row.expiresAt,
      archived: row.archived,
      aliases: row.aliases,
      createdAt: row.createdAt,
    };
  });
}

export function scanDocumentsExtended(
  db: Database,
  limit = 200,
  collectionName?: string,
  scope?: string,
  stage: "memory" | "observation" = "memory",
  archivedFilter: ArchivedFilter = "active",
): DocumentScanRow[] {
  let sql = `
    SELECT
      d.path as id,
      d.id as docId,
      d.title,
      content.doc as content,
      d.category,
      d.importance,
      d.access_count as accessCount,
      d.last_accessed_at as lastAccessedAt,
      d.abstract,
      d.summary,
      d.scope,
      d.confidence,
      d.source_type as sourceType,
      d.stage,
      d.expires_at as expiresAt,
      d.archived,
      d.aliases,
      d.created_at as createdAt
    FROM documents d
    JOIN content ON content.hash = d.hash
    WHERE d.active = 1 AND d.stage = ?
  `;
  const params: unknown[] = [stage];

  if (archivedFilter === "active") {
    sql += ` AND d.archived = 0`;
  } else if (archivedFilter === "archived") {
    sql += ` AND d.archived = 1`;
  }

  if (collectionName) {
    sql += ` AND d.collection = ?`;
    params.push(collectionName);
  }

  if (scope) {
    sql += ` AND d.scope = ?`;
    params.push(scope);
  }

  sql += ` ORDER BY d.modified_at DESC LIMIT ?`;
  params.push(limit);

  return db.prepare(sql).all(...params) as DocumentScanRow[];
}

export function insertDocumentExtended(
  db: Database,
  collection: string,
  docPath: string,
  title: string,
  hash: string,
  createdAt: string,
  modifiedAt: string,
  extra?: {
    category?: string;
    importance?: number;
    abstract?: string;
    summary?: string;
    scope?: string;
    confidence?: number;
    sourceType?: string;
    stage?: "memory" | "observation";
    expiresAt?: string | null;
    aliases?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO documents (collection, path, title, hash, active, created_at, modified_at, category, importance, abstract, summary, scope, confidence, source_type, stage, expires_at, archived, aliases)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  ).run(
    collection,
    docPath,
    title,
    hash,
    createdAt,
    modifiedAt,
    extra?.category ?? null,
    extra?.importance ?? 0.5,
    extra?.abstract ?? null,
    extra?.summary ?? null,
    extra?.scope ?? null,
    extra?.confidence ?? 1,
    extra?.sourceType ?? "manual",
    extra?.stage ?? "memory",
    extra?.expiresAt ?? null,
    extra?.aliases ?? null,
  );
}

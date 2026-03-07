/**
 * qmd-reader.ts — 直接从 qmd 的 SQLite 数据库和 YAML 配置读取数据。
 *
 * 替代 qmd CLI 调用，实现 4 个只读工具：
 * - qmd_status
 * - qmd_query (FTS/BM25 模式)
 * - qmd_get
 * - qmd_multi_get
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import YAML from "yaml";
import picomatch from "picomatch";
import {
  openDatabase,
  searchFTS,
  type Database,
  type FTSResult,
} from "./qmd-lite.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QmdReaderConfig = {
  indexName?: string;
  dbPath?: string;
  configDir?: string;
};

export type QmdCollection = {
  name: string;
  path: string;
  pattern: string;
  context?: Record<string, string>;
};

export type QmdDocument = {
  filepath: string;
  displayPath: string;
  title: string;
  hash: string;
  docid: string;
  collectionName: string;
  modifiedAt: string;
  bodyLength: number;
  context: string | null;
  body?: string;
};

export type QmdStatus = {
  totalDocuments: number;
  needsEmbedding: number;
  hasVectorIndex: boolean;
  collections: {
    name: string;
    path: string;
    pattern: string;
    documents: number;
    lastUpdated: string;
  }[];
};

export type FindDocumentResult =
  | QmdDocument
  | { error: "not_found"; query: string; similarFiles: string[] };

export type FindDocumentsResult = {
  docs: {
    doc: QmdDocument;
    skipped: boolean;
    skipReason?: string;
  }[];
  errors: string[];
};

// ---------------------------------------------------------------------------
// YAML config reader (from qmd collections.js)
// ---------------------------------------------------------------------------

function getConfigDir(config: QmdReaderConfig): string {
  if (config.configDir) return config.configDir;
  if (process.env.QMD_CONFIG_DIR) return process.env.QMD_CONFIG_DIR;
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, "qmd");
  // Windows: use LOCALAPPDATA; Unix: use ~/.config
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "qmd");
  }
  return path.join(homedir(), ".config", "qmd");
}

function getConfigFilePath(config: QmdReaderConfig): string {
  const indexName = config.indexName ?? "index";
  return path.join(getConfigDir(config), `${indexName}.yml`);
}

function loadCollections(config: QmdReaderConfig): QmdCollection[] {
  const configPath = getConfigFilePath(config);
  if (!existsSync(configPath)) return [];

  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = YAML.parse(raw) as { collections?: Record<string, { path: string; pattern?: string; context?: Record<string, string> }> };
    if (!parsed?.collections) return [];

    return Object.entries(parsed.collections).map(([name, coll]) => ({
      name,
      path: coll.path,
      pattern: coll.pattern ?? "**/*.md",
      context: coll.context,
    }));
  } catch {
    return [];
  }
}

function loadGlobalContext(config: QmdReaderConfig): string | undefined {
  const configPath = getConfigFilePath(config);
  if (!existsSync(configPath)) return undefined;

  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = YAML.parse(raw) as { global_context?: string };
    return parsed?.global_context;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Helper functions (extracted from qmd store.js)
// ---------------------------------------------------------------------------

function getDocid(hash: string): string {
  return hash.slice(0, 6);
}

function normalizeDocid(docid: string): string {
  let normalized = docid.trim();
  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    normalized = normalized.slice(1, -1);
  }
  if (normalized.startsWith("#")) {
    normalized = normalized.slice(1);
  }
  return normalized;
}

function isDocid(input: string): boolean {
  const normalized = normalizeDocid(input);
  return normalized.length >= 6 && /^[a-f0-9]+$/i.test(normalized);
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0) as number[]);
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
    }
  }
  return dp[m]![n]!;
}

export function addLineNumbers(text: string, startLine = 1): string {
  const lines = text.split("\n");
  return lines.map((line, i) => `${startLine + i}: ${line}`).join("\n");
}

const DEFAULT_MULTI_GET_MAX_BYTES = 10 * 1024;

// ---------------------------------------------------------------------------
// Database query functions
// ---------------------------------------------------------------------------

type DocRow = {
  virtual_path: string;
  display_path: string;
  title: string;
  hash: string;
  collection: string;
  modified_at: string;
  body_length: number;
  body?: string;
};

const SELECT_COLS = `
  'qmd://' || d.collection || '/' || d.path as virtual_path,
  d.collection || '/' || d.path as display_path,
  d.title,
  d.hash,
  d.collection,
  d.modified_at,
  LENGTH(content.doc) as body_length
`;

const SELECT_COLS_WITH_BODY = `
  ${SELECT_COLS},
  content.doc as body
`;

function findDocumentByDocid(db: Database, docid: string): { filepath: string; hash: string } | null {
  const shortHash = normalizeDocid(docid);
  if (shortHash.length < 1) return null;
  const doc = db.prepare(`
    SELECT 'qmd://' || d.collection || '/' || d.path as filepath, d.hash
    FROM documents d
    WHERE d.hash LIKE ? AND d.active = 1
    LIMIT 1
  `).get(`${shortHash}%`) as { filepath: string; hash: string } | undefined;
  return doc ?? null;
}

function findSimilarFiles(db: Database, query: string, maxDistance = 3, limit = 5): string[] {
  const allFiles = db.prepare(`SELECT d.path FROM documents d WHERE d.active = 1`).all() as { path: string }[];
  const queryLower = query.toLowerCase();
  return allFiles
    .map((f) => ({ path: f.path, dist: levenshtein(f.path.toLowerCase(), queryLower) }))
    .filter((f) => f.dist <= maxDistance)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, limit)
    .map((f) => f.path);
}

function matchFilesByGlob(
  db: Database,
  pattern: string,
): { filepath: string; displayPath: string; bodyLength: number }[] {
  const allFiles = db.prepare(`
    SELECT
      'qmd://' || d.collection || '/' || d.path as virtual_path,
      LENGTH(content.doc) as body_length,
      d.path,
      d.collection
    FROM documents d
    JOIN content ON content.hash = d.hash
    WHERE d.active = 1
  `).all() as { virtual_path: string; body_length: number; path: string; collection: string }[];

  const isMatch = picomatch(pattern);
  return allFiles
    .filter((f) => isMatch(f.virtual_path) || isMatch(f.path))
    .map((f) => ({
      filepath: f.virtual_path,
      displayPath: f.path,
      bodyLength: f.body_length,
    }));
}

function getContextForFile(
  config: QmdReaderConfig,
  filepath: string,
): string | null {
  if (!filepath) return null;

  const collections = loadCollections(config);
  const globalContext = loadGlobalContext(config);

  let collectionName: string | null = null;
  let relativePath: string | null = null;

  if (filepath.startsWith("qmd://")) {
    const match = filepath.match(/^qmd:\/\/([^/]+)\/?(.*)$/);
    if (match?.[1]) {
      collectionName = match[1];
      relativePath = match[2] ?? "";
    }
  } else {
    const normalizedFilepath = filepath.replace(/\\/g, "/");
    for (const coll of collections) {
      const normalizedCollPath = coll.path.replace(/\\/g, "/");
      if (normalizedFilepath.startsWith(normalizedCollPath + "/") || normalizedFilepath === normalizedCollPath) {
        collectionName = coll.name;
        relativePath = normalizedFilepath.startsWith(normalizedCollPath + "/")
          ? normalizedFilepath.slice(normalizedCollPath.length + 1)
          : "";
        break;
      }
    }
  }

  if (!collectionName || relativePath === null) return globalContext ?? null;

  const coll = collections.find((c) => c.name === collectionName);
  if (!coll?.context) return globalContext ?? null;

  const matches: { prefix: string; context: string }[] = [];
  for (const [prefix, context] of Object.entries(coll.context)) {
    const normalizedPath = relativePath.startsWith("/") ? relativePath : `/${relativePath}`;
    const normalizedPrefix = prefix.startsWith("/") ? prefix : `/${prefix}`;
    if (normalizedPath.startsWith(normalizedPrefix)) {
      matches.push({ prefix: normalizedPrefix, context });
    }
  }

  if (matches.length > 0) {
    matches.sort((a, b) => b.prefix.length - a.prefix.length);
    return matches[0]!.context;
  }

  return globalContext ?? null;
}

function rowToDocument(row: DocRow, config: QmdReaderConfig): QmdDocument {
  const virtualPath = row.virtual_path || `qmd://${row.collection}/${row.display_path}`;
  return {
    filepath: virtualPath,
    displayPath: row.display_path,
    title: row.title || row.display_path.split("/").pop() || row.display_path,
    hash: row.hash,
    docid: getDocid(row.hash),
    collectionName: row.collection,
    modifiedAt: row.modified_at,
    bodyLength: row.body_length,
    context: getContextForFile(config, virtualPath),
    ...(row.body !== undefined && { body: row.body }),
  };
}

// ---------------------------------------------------------------------------
// QmdReader — public API
// ---------------------------------------------------------------------------

export type QmdReader = {
  getStatus(): QmdStatus;
  query(query: string, limit?: number, collectionName?: string): FTSResult[];
  findDocument(filename: string, includeBody?: boolean): FindDocumentResult;
  getDocumentBody(filepath: string, fromLine?: number, maxLines?: number): string | null;
  findDocuments(pattern: string, options?: { maxBytes?: number; includeBody?: boolean }): FindDocumentsResult;
  close(): void;
};

export async function createQmdReader(config: QmdReaderConfig = {}): Promise<QmdReader> {
  const dbPath = config.dbPath ?? resolveDefaultDbPath(config);
  const db = await openDatabase(dbPath);

  function resolveDefaultDbPath(cfg: QmdReaderConfig): string {
    let cacheDir: string;
    if (process.env.XDG_CACHE_HOME) {
      cacheDir = process.env.XDG_CACHE_HOME;
    } else if (process.platform === "win32" && process.env.LOCALAPPDATA) {
      cacheDir = path.join(process.env.LOCALAPPDATA, "cache");
    } else {
      cacheDir = path.join(homedir(), ".cache");
    }
    const indexName = cfg.indexName ?? "index";
    return path.join(cacheDir, "qmd", `${indexName}.sqlite`);
  }

  function getStatus(): QmdStatus {
    const yamlCollections = loadCollections(config);

    const collections = yamlCollections.map((col) => {
      const stats = db.prepare(`
        SELECT COUNT(*) as active_count, MAX(modified_at) as last_doc_update
        FROM documents WHERE collection = ? AND active = 1
      `).get(col.name) as { active_count: number; last_doc_update: string | null };

      return {
        name: col.name,
        path: col.path,
        pattern: col.pattern,
        documents: stats.active_count,
        lastUpdated: stats.last_doc_update || new Date().toISOString(),
      };
    });

    collections.sort((a, b) => {
      if (!a.lastUpdated) return 1;
      if (!b.lastUpdated) return -1;
      return new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime();
    });

    const totalDocs = (db.prepare(`SELECT COUNT(*) as c FROM documents WHERE active = 1`).get() as { c: number }).c;

    let needsEmbedding = totalDocs;
    try {
      const result = db.prepare(`
        SELECT COUNT(DISTINCT d.hash) as count
        FROM documents d
        LEFT JOIN content_vectors v ON d.hash = v.hash AND v.seq = 0
        WHERE d.active = 1 AND v.hash IS NULL
      `).get() as { count: number };
      needsEmbedding = result.count;
    } catch {
      // content_vectors table may not exist if qmd never ran embed
    }

    const hasVectors = !!db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`,
    ).get();

    return { totalDocuments: totalDocs, needsEmbedding, hasVectorIndex: hasVectors, collections };
  }

  function query(queryStr: string, limit = 10, collectionName?: string): FTSResult[] {
    return searchFTS(db, queryStr, limit, collectionName);
  }

  function findDoc(filename: string, includeBody = false): FindDocumentResult {
    let filepath = filename;

    // Strip trailing :linenum
    const colonMatch = filepath.match(/:(\d+)$/);
    if (colonMatch) {
      filepath = filepath.slice(0, -colonMatch[0].length);
    }

    // Docid lookup
    if (isDocid(filepath)) {
      const docidMatch = findDocumentByDocid(db, filepath);
      if (docidMatch) {
        filepath = docidMatch.filepath;
      } else {
        return { error: "not_found", query: filename, similarFiles: [] };
      }
    }

    if (filepath.startsWith("~/")) {
      filepath = path.join(homedir(), filepath.slice(2));
    }

    const cols = includeBody ? SELECT_COLS_WITH_BODY : SELECT_COLS;

    // Try virtual path exact match
    let doc = db.prepare(`
      SELECT ${cols}
      FROM documents d JOIN content ON content.hash = d.hash
      WHERE 'qmd://' || d.collection || '/' || d.path = ? AND d.active = 1
    `).get(filepath) as DocRow | undefined;

    // Try fuzzy virtual path match
    if (!doc) {
      doc = db.prepare(`
        SELECT ${cols}
        FROM documents d JOIN content ON content.hash = d.hash
        WHERE 'qmd://' || d.collection || '/' || d.path LIKE ? AND d.active = 1
        LIMIT 1
      `).get(`%${filepath}`) as DocRow | undefined;
    }

    // Try absolute path via YAML collections
    if (!doc && !filepath.startsWith("qmd://")) {
      const collections = loadCollections(config);
      const normalizedFp = filepath.replace(/\\/g, "/");
      for (const coll of collections) {
        let relativePath: string | null = null;
        const normalizedCollPath = coll.path.replace(/\\/g, "/");
        if (normalizedFp.startsWith(normalizedCollPath + "/")) {
          relativePath = normalizedFp.slice(normalizedCollPath.length + 1);
        } else if (!path.isAbsolute(filepath)) {
          relativePath = filepath;
        }
        if (relativePath) {
          doc = db.prepare(`
            SELECT ${cols}
            FROM documents d JOIN content ON content.hash = d.hash
            WHERE d.collection = ? AND d.path = ? AND d.active = 1
          `).get(coll.name, relativePath) as DocRow | undefined;
          if (doc) break;
        }
      }
    }

    if (!doc) {
      const similar = findSimilarFiles(db, filepath, 5, 5);
      return { error: "not_found", query: filename, similarFiles: similar };
    }

    return rowToDocument(doc, config);
  }

  function getBody(filepath: string, fromLine?: number, maxLines?: number): string | null {
    let row: { body: string } | undefined;

    if (filepath.startsWith("qmd://")) {
      row = db.prepare(`
        SELECT content.doc as body
        FROM documents d JOIN content ON content.hash = d.hash
        WHERE 'qmd://' || d.collection || '/' || d.path = ? AND d.active = 1
      `).get(filepath) as { body: string } | undefined;
    }

    if (!row) {
      const collections = loadCollections(config);
      const normalizedFp = filepath.replace(/\\/g, "/");
      for (const coll of collections) {
        const normalizedCollPath = coll.path.replace(/\\/g, "/");
        if (normalizedFp.startsWith(normalizedCollPath + "/")) {
          const relativePath = normalizedFp.slice(normalizedCollPath.length + 1);
          row = db.prepare(`
            SELECT content.doc as body
            FROM documents d JOIN content ON content.hash = d.hash
            WHERE d.collection = ? AND d.path = ? AND d.active = 1
          `).get(coll.name, relativePath) as { body: string } | undefined;
          if (row) break;
        }
      }
    }

    if (!row) return null;

    let body = row.body;
    if (fromLine !== undefined || maxLines !== undefined) {
      const lines = body.split("\n");
      const start = (fromLine || 1) - 1;
      const end = maxLines !== undefined ? start + maxLines : lines.length;
      body = lines.slice(start, end).join("\n");
    }
    return body;
  }

  function findDocs(
    pattern: string,
    options: { maxBytes?: number; includeBody?: boolean } = {},
  ): FindDocumentsResult {
    const maxBytes = options.maxBytes ?? DEFAULT_MULTI_GET_MAX_BYTES;
    const errors: string[] = [];
    const isCommaSeparated = pattern.includes(",") && !pattern.includes("*") && !pattern.includes("?");
    const cols = options.includeBody ? SELECT_COLS_WITH_BODY : SELECT_COLS;

    let fileRows: DocRow[];

    if (isCommaSeparated) {
      const names = pattern.split(",").map((s) => s.trim()).filter(Boolean);
      fileRows = [];
      for (const name of names) {
        let doc = db.prepare(`
          SELECT ${cols}
          FROM documents d JOIN content ON content.hash = d.hash
          WHERE 'qmd://' || d.collection || '/' || d.path = ? AND d.active = 1
        `).get(name) as DocRow | undefined;

        if (!doc) {
          doc = db.prepare(`
            SELECT ${cols}
            FROM documents d JOIN content ON content.hash = d.hash
            WHERE 'qmd://' || d.collection || '/' || d.path LIKE ? AND d.active = 1
            LIMIT 1
          `).get(`%${name}`) as DocRow | undefined;
        }

        if (doc) {
          fileRows.push(doc);
        } else {
          const similar = findSimilarFiles(db, name, 5, 3);
          let msg = `File not found: ${name}`;
          if (similar.length > 0) {
            msg += ` (did you mean: ${similar.join(", ")}?)`;
          }
          errors.push(msg);
        }
      }
    } else {
      const matched = matchFilesByGlob(db, pattern);
      if (matched.length === 0) {
        errors.push(`No files matched pattern: ${pattern}`);
        return { docs: [], errors };
      }
      const virtualPaths = matched.map((m) => m.filepath);
      const placeholders = virtualPaths.map(() => "?").join(",");
      fileRows = db.prepare(`
        SELECT ${cols}
        FROM documents d JOIN content ON content.hash = d.hash
        WHERE 'qmd://' || d.collection || '/' || d.path IN (${placeholders}) AND d.active = 1
      `).all(...virtualPaths) as DocRow[];
    }

    const docs = fileRows.map((row) => {
      if (row.body_length > maxBytes) {
        return {
          doc: rowToDocument(row, config),
          skipped: true,
          skipReason: `File too large (${Math.round(row.body_length / 1024)}KB > ${Math.round(maxBytes / 1024)}KB)`,
        };
      }
      return { doc: rowToDocument(row, config), skipped: false };
    });

    return { docs, errors };
  }

  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    process.removeListener("exit", close);
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
  process.on("exit", close);

  return {
    getStatus,
    query,
    findDocument: findDoc,
    getDocumentBody: getBody,
    findDocuments: findDocs,
    close,
  };
}

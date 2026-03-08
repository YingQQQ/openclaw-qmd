import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  openDatabase,
  ensureSchema,
  hashContent,
  insertContent,
  insertDocument,
  findActiveDocument,
  findDocumentByPath,
  searchFTS,
  searchFTSExtended,
  updateDocument,
  updateAccessCount,
  deleteDocument,
  scanDocumentsExtended,
  type Database,
} from "../src/qmd-lite.js";

function createTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "qmd-lite-test-"));
}

const tempDirs: string[] = [];

function trackDir(dir: string): string {
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true }); } catch { /* ignore */ }
  }
  tempDirs.length = 0;
});

async function createDb() {
  const dir = trackDir(createTempDir());
  const dbPath = path.join(dir, "test.sqlite");
  const db = await openDatabase(dbPath);
  ensureSchema(db);
  return { db, dir, dbPath };
}

describe("qmd-lite", () => {
  describe("openDatabase + ensureSchema", () => {
    it("creates a usable database", async () => {
      const { db } = await createDb();
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
      const tableNames = tables.map((t) => t.name);
      expect(tableNames).toContain("content");
      expect(tableNames).toContain("documents");
      db.close();
    });

    it("ensureSchema is idempotent", async () => {
      const { db } = await createDb();
      // Call again should not throw
      ensureSchema(db);
      ensureSchema(db);
      db.close();
    });
  });

  describe("hashContent", () => {
    it("produces consistent SHA-256 hashes", () => {
      const hash1 = hashContent("hello world");
      const hash2 = hashContent("hello world");
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64);
    });

    it("produces different hashes for different content", () => {
      expect(hashContent("a")).not.toBe(hashContent("b"));
    });

    it("handles empty string", () => {
      const hash = hashContent("");
      expect(hash).toHaveLength(64);
    });
  });

  describe("insertContent + insertDocument", () => {
    it("inserts and retrieves content", async () => {
      const { db } = await createDb();
      const hash = hashContent("test body");
      const now = new Date().toISOString();
      insertContent(db, hash, "test body", now);

      const row = db.prepare("SELECT doc FROM content WHERE hash = ?").get(hash) as { doc: string };
      expect(row.doc).toBe("test body");
      db.close();
    });

    it("insertContent ignores duplicates", async () => {
      const { db } = await createDb();
      const hash = hashContent("dup");
      const now = new Date().toISOString();
      insertContent(db, hash, "dup", now);
      insertContent(db, hash, "dup", now); // should not throw
      const count = db.prepare("SELECT COUNT(*) as c FROM content WHERE hash = ?").get(hash) as { c: number };
      expect(count.c).toBe(1);
      db.close();
    });

    it("inserts a document linked to content", async () => {
      const { db } = await createDb();
      const hash = hashContent("body");
      const now = new Date().toISOString();
      insertContent(db, hash, "body", now);
      insertDocument(db, "col1", "doc.md", "Title", hash, now, now);

      const doc = findActiveDocument(db, "col1", "doc.md");
      expect(doc).not.toBeNull();
      expect(doc!.hash).toBe(hash);
      db.close();
    });
  });

  describe("findActiveDocument", () => {
    it("returns null for non-existent document", async () => {
      const { db } = await createDb();
      expect(findActiveDocument(db, "col", "missing.md")).toBeNull();
      db.close();
    });
  });

  describe("findDocumentByPath", () => {
    it("returns full document metadata", async () => {
      const { db } = await createDb();
      const hash = hashContent("content");
      const now = new Date().toISOString();
      insertContent(db, hash, "content", now);
      insertDocument(db, "memories", "test-id", "Test Title", hash, now, now);

      const doc = findDocumentByPath(db, "memories", "test-id");
      expect(doc).not.toBeNull();
      expect(doc!.title).toBe("Test Title");
      expect(doc!.importance).toBe(0.5);
      expect(doc!.confidence).toBe(1);
      expect(doc!.stage).toBe("memory");
      expect(doc!.archived).toBe(0);
      db.close();
    });

    it("returns null for wrong collection", async () => {
      const { db } = await createDb();
      const hash = hashContent("x");
      const now = new Date().toISOString();
      insertContent(db, hash, "x", now);
      insertDocument(db, "col-a", "id-1", "T", hash, now, now);

      expect(findDocumentByPath(db, "col-b", "id-1")).toBeNull();
      db.close();
    });
  });

  describe("searchFTS", () => {
    it("finds documents by content keyword", async () => {
      const { db } = await createDb();
      const body = "TypeScript is a typed superset of JavaScript";
      const hash = hashContent(body);
      const now = new Date().toISOString();
      insertContent(db, hash, body, now);
      insertDocument(db, "docs", "ts.md", "TypeScript", hash, now, now);

      const results = searchFTS(db, "TypeScript");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].id).toBe("ts.md");
      expect(results[0].score).toBeGreaterThan(0);
      db.close();
    });

    it("returns empty for no match", async () => {
      const { db } = await createDb();
      const hash = hashContent("hello world");
      const now = new Date().toISOString();
      insertContent(db, hash, "hello world", now);
      insertDocument(db, "docs", "a.md", "A", hash, now, now);

      const results = searchFTS(db, "zzzznonexistent");
      expect(results).toEqual([]);
      db.close();
    });

    it("returns empty for empty query", async () => {
      const { db } = await createDb();
      expect(searchFTS(db, "")).toEqual([]);
      expect(searchFTS(db, "   ")).toEqual([]);
      db.close();
    });

    it("filters by collection", async () => {
      const { db } = await createDb();
      const now = new Date().toISOString();
      for (const [col, id] of [["alpha", "a.md"], ["beta", "b.md"]] as const) {
        const body = "shared keyword testing";
        const hash = hashContent(body + col);
        insertContent(db, hash, body, now);
        insertDocument(db, col, id, "Doc", hash, now, now);
      }

      const all = searchFTS(db, "testing");
      expect(all.length).toBe(2);

      const filtered = searchFTS(db, "testing", 20, "alpha");
      expect(filtered.length).toBe(1);
      expect(filtered[0].collection).toBe("alpha");
      db.close();
    });
  });

  describe("searchFTSExtended", () => {
    it("returns extended metadata fields", async () => {
      const { db } = await createDb();
      const body = "React hooks are powerful for state management";
      const hash = hashContent(body);
      const now = new Date().toISOString();
      insertContent(db, hash, body, now);
      insertDocument(db, "mem", "react.md", "React", hash, now, now);
      updateDocument(db, 1, { category: "entity", importance: 0.9 });

      const results = searchFTSExtended(db, "React hooks", 10, "mem");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].category).toBe("entity");
      expect(results[0].importance).toBe(0.9);
      expect(results[0]).toHaveProperty("stage");
      expect(results[0]).toHaveProperty("confidence");
      db.close();
    });

    it("filters by stage", async () => {
      const { db } = await createDb();
      const now = new Date().toISOString();

      const body1 = "observation about dark mode";
      const hash1 = hashContent(body1);
      insertContent(db, hash1, body1, now);
      insertDocument(db, "mem", "obs1.md", "Obs", hash1, now, now);
      updateDocument(db, 1, { stage: "observation" });

      const body2 = "memory about dark mode preference";
      const hash2 = hashContent(body2);
      insertContent(db, hash2, body2, now);
      insertDocument(db, "mem", "mem1.md", "Mem", hash2, now, now);

      const obs = searchFTSExtended(db, "dark mode", 10, "mem", undefined, "observation");
      expect(obs.every((r) => r.stage === "observation")).toBe(true);

      const mems = searchFTSExtended(db, "dark mode", 10, "mem", undefined, "memory");
      expect(mems.every((r) => r.stage === "memory")).toBe(true);
      db.close();
    });
  });

  describe("updateDocument", () => {
    it("updates specified fields only", async () => {
      const { db } = await createDb();
      const hash = hashContent("c");
      const now = new Date().toISOString();
      insertContent(db, hash, "c", now);
      insertDocument(db, "col", "d.md", "D", hash, now, now);

      updateDocument(db, 1, { importance: 0.99, category: "event" });
      const doc = findDocumentByPath(db, "col", "d.md");
      expect(doc!.importance).toBe(0.99);
      expect(doc!.category).toBe("event");
      expect(doc!.title).toBe("D"); // unchanged
      db.close();
    });

    it("no-op when fields is empty", async () => {
      const { db } = await createDb();
      const hash = hashContent("c");
      const now = new Date().toISOString();
      insertContent(db, hash, "c", now);
      insertDocument(db, "col", "d.md", "D", hash, now, now);

      updateDocument(db, 1, {}); // should not throw
      const doc = findDocumentByPath(db, "col", "d.md");
      expect(doc!.title).toBe("D");
      db.close();
    });
  });

  describe("updateAccessCount", () => {
    it("increments access count and sets timestamp", async () => {
      const { db } = await createDb();
      const hash = hashContent("body");
      const now = new Date().toISOString();
      insertContent(db, hash, "body", now);
      insertDocument(db, "col", "x.md", "X", hash, now, now);

      updateAccessCount(db, 1);
      updateAccessCount(db, 1);
      const doc = findDocumentByPath(db, "col", "x.md");
      expect(doc!.accessCount).toBe(2);
      expect(doc!.lastAccessedAt).toBeTruthy();
      db.close();
    });
  });

  describe("deleteDocument", () => {
    it("removes the document", async () => {
      const { db } = await createDb();
      const hash = hashContent("rm");
      const now = new Date().toISOString();
      insertContent(db, hash, "rm", now);
      insertDocument(db, "col", "rm.md", "RM", hash, now, now);

      expect(findActiveDocument(db, "col", "rm.md")).not.toBeNull();
      deleteDocument(db, 1);
      expect(findActiveDocument(db, "col", "rm.md")).toBeNull();
      db.close();
    });
  });

  describe("scanDocumentsExtended", () => {
    it("scans documents with stage filter", async () => {
      const { db } = await createDb();
      const now = new Date().toISOString();

      for (let i = 0; i < 3; i++) {
        const body = `doc content ${i}`;
        const hash = hashContent(body);
        insertContent(db, hash, body, now);
        insertDocument(db, "mem", `d${i}.md`, `D${i}`, hash, now, now);
        if (i === 2) updateDocument(db, i + 1, { stage: "observation" });
      }

      const memories = scanDocumentsExtended(db, 100, "mem", undefined, "memory");
      expect(memories.length).toBe(2);

      const observations = scanDocumentsExtended(db, 100, "mem", undefined, "observation");
      expect(observations.length).toBe(1);
      db.close();
    });

    it("respects limit", async () => {
      const { db } = await createDb();
      const now = new Date().toISOString();
      for (let i = 0; i < 10; i++) {
        const body = `item ${i}`;
        const hash = hashContent(body);
        insertContent(db, hash, body, now);
        insertDocument(db, "mem", `i${i}.md`, `I${i}`, hash, now, now);
      }

      const limited = scanDocumentsExtended(db, 3, "mem");
      expect(limited.length).toBe(3);
      db.close();
    });
  });

  describe("transaction support", () => {
    it("db.transaction wraps operations atomically", async () => {
      const { db } = await createDb();
      const now = new Date().toISOString();

      const hash = hashContent("txn body");
      insertContent(db, hash, "txn body", now);

      const insertTwo = db.transaction(() => {
        insertDocument(db, "col", "t1.md", "T1", hash, now, now);
        insertDocument(db, "col", "t2.md", "T2", hash, now, now);
      });
      insertTwo();

      expect(findActiveDocument(db, "col", "t1.md")).not.toBeNull();
      expect(findActiveDocument(db, "col", "t2.md")).not.toBeNull();
      db.close();
    });
  });
});

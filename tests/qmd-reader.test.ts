import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createQmdReader, addLineNumbers } from "../src/qmd-reader.js";
import {
  openDatabase,
  ensureSchema,
  insertContent,
  insertDocument,
  hashContent,
} from "../src/qmd-lite.js";

function createTempDir() {
  return mkdtempSync(path.join(tmpdir(), "qmd-reader-test-"));
}

async function createTestDb(dir: string) {
  const dbPath = path.join(dir, "test.sqlite");
  const db = await openDatabase(dbPath);
  ensureSchema(db);
  return { dbPath, db };
}

function insertTestDoc(
  db: ReturnType<typeof import("../src/qmd-lite.js")["openDatabase"]> extends Promise<infer T> ? T : never,
  collection: string,
  docPath: string,
  title: string,
  body: string,
) {
  const hash = hashContent(body);
  const now = new Date().toISOString();
  insertContent(db, hash, body, now);
  insertDocument(db, collection, docPath, title, hash, now, now);
}

describe("createQmdReader", () => {
  describe("query", () => {
    it("searches documents by BM25", async () => {
      const dir = createTempDir();
      const { dbPath, db } = await createTestDb(dir);

      insertTestDoc(db, "notes", "auth.md", "Auth Design", "JWT with refresh token rotation for authentication");
      insertTestDoc(db, "notes", "db.md", "Database", "PostgreSQL for persistent storage");
      insertTestDoc(db, "docs", "react.md", "Frontend", "React with TypeScript for the UI");

      const reader = await createQmdReader({ dbPath });

      const results = reader.query("JWT auth token", 5);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.content).toContain("JWT");

      reader.close();
    });

    it("filters by collection", async () => {
      const dir = createTempDir();
      const { dbPath, db } = await createTestDb(dir);

      insertTestDoc(db, "notes", "auth.md", "Auth", "JWT for auth");
      insertTestDoc(db, "docs", "auth2.md", "Auth2", "JWT for auth system");

      const reader = await createQmdReader({ dbPath });

      const allResults = reader.query("JWT auth", 10);
      const notesOnly = reader.query("JWT auth", 10, "notes");

      expect(allResults.length).toBeGreaterThanOrEqual(2);
      expect(notesOnly.length).toBe(1);
      expect(notesOnly[0]!.collection).toBe("notes");

      reader.close();
    });
  });

  describe("findDocument", () => {
    it("finds by virtual path", async () => {
      const dir = createTempDir();
      const { dbPath, db } = await createTestDb(dir);

      insertTestDoc(db, "notes", "auth.md", "Auth Design", "JWT content");

      const reader = await createQmdReader({ dbPath });
      const result = reader.findDocument("qmd://notes/auth.md");

      expect("error" in result).toBe(false);
      if (!("error" in result)) {
        expect(result.filepath).toBe("qmd://notes/auth.md");
        expect(result.title).toBe("Auth Design");
        expect(result.docid).toHaveLength(6);
      }

      reader.close();
    });

    it("finds by fuzzy virtual path", async () => {
      const dir = createTempDir();
      const { dbPath, db } = await createTestDb(dir);

      insertTestDoc(db, "notes", "deep/nested/auth.md", "Auth", "content");

      const reader = await createQmdReader({ dbPath });
      const result = reader.findDocument("auth.md");

      expect("error" in result).toBe(false);
      if (!("error" in result)) {
        expect(result.filepath).toBe("qmd://notes/deep/nested/auth.md");
      }

      reader.close();
    });

    it("finds by docid", async () => {
      const dir = createTempDir();
      const { dbPath, db } = await createTestDb(dir);

      const body = "JWT content for docid test";
      const hash = hashContent(body);
      const shortHash = hash.slice(0, 6);
      insertTestDoc(db, "notes", "auth.md", "Auth", body);

      const reader = await createQmdReader({ dbPath });
      const result = reader.findDocument(`#${shortHash}`);

      expect("error" in result).toBe(false);
      if (!("error" in result)) {
        expect(result.docid).toBe(shortHash);
      }

      reader.close();
    });

    it("returns not_found with similar files", async () => {
      const dir = createTempDir();
      const { dbPath, db } = await createTestDb(dir);

      insertTestDoc(db, "notes", "auth.md", "Auth", "content");

      const reader = await createQmdReader({ dbPath });
      const result = reader.findDocument("qmd://notes/auht.md");

      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error).toBe("not_found");
      }

      reader.close();
    });
  });

  describe("getDocumentBody", () => {
    it("returns full body", async () => {
      const dir = createTempDir();
      const { dbPath, db } = await createTestDb(dir);

      insertTestDoc(db, "notes", "auth.md", "Auth", "line1\nline2\nline3\nline4\nline5");

      const reader = await createQmdReader({ dbPath });
      const body = reader.getDocumentBody("qmd://notes/auth.md");

      expect(body).toBe("line1\nline2\nline3\nline4\nline5");

      reader.close();
    });

    it("slices by fromLine and maxLines", async () => {
      const dir = createTempDir();
      const { dbPath, db } = await createTestDb(dir);

      insertTestDoc(db, "notes", "auth.md", "Auth", "line1\nline2\nline3\nline4\nline5");

      const reader = await createQmdReader({ dbPath });
      const body = reader.getDocumentBody("qmd://notes/auth.md", 2, 2);

      expect(body).toBe("line2\nline3");

      reader.close();
    });

    it("returns null for non-existent document", async () => {
      const dir = createTempDir();
      const { dbPath } = await createTestDb(dir);

      const reader = await createQmdReader({ dbPath });
      const body = reader.getDocumentBody("qmd://notes/nonexistent.md");

      expect(body).toBeNull();

      reader.close();
    });
  });

  describe("findDocuments", () => {
    it("finds by comma-separated list", async () => {
      const dir = createTempDir();
      const { dbPath, db } = await createTestDb(dir);

      insertTestDoc(db, "notes", "auth.md", "Auth", "auth content");
      insertTestDoc(db, "notes", "db.md", "DB", "db content");
      insertTestDoc(db, "notes", "react.md", "React", "react content");

      const reader = await createQmdReader({ dbPath });
      const result = reader.findDocuments("qmd://notes/auth.md,qmd://notes/db.md");

      expect(result.docs.length).toBe(2);
      expect(result.errors.length).toBe(0);

      reader.close();
    });

    it("finds by glob pattern", async () => {
      const dir = createTempDir();
      const { dbPath, db } = await createTestDb(dir);

      insertTestDoc(db, "notes", "auth.md", "Auth", "auth content");
      insertTestDoc(db, "notes", "db.md", "DB", "db content");
      insertTestDoc(db, "docs", "guide.txt", "Guide", "guide content");

      const reader = await createQmdReader({ dbPath });
      const result = reader.findDocuments("**/*.md");

      expect(result.docs.length).toBe(2);
      expect(result.errors.length).toBe(0);

      reader.close();
    });

    it("reports errors for missing files in comma list", async () => {
      const dir = createTempDir();
      const { dbPath, db } = await createTestDb(dir);

      insertTestDoc(db, "notes", "auth.md", "Auth", "content");

      const reader = await createQmdReader({ dbPath });
      const result = reader.findDocuments("qmd://notes/auth.md,qmd://notes/missing.md");

      expect(result.docs.length).toBe(1);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0]).toContain("File not found");

      reader.close();
    });

    it("skips files exceeding maxBytes", async () => {
      const dir = createTempDir();
      const { dbPath, db } = await createTestDb(dir);

      const bigBody = "x".repeat(2000);
      insertTestDoc(db, "notes", "big.md", "Big", bigBody);
      insertTestDoc(db, "notes", "small.md", "Small", "tiny");

      const reader = await createQmdReader({ dbPath });
      const result = reader.findDocuments("**/*.md", { maxBytes: 100 });

      const skipped = result.docs.filter((d) => d.skipped);
      const notSkipped = result.docs.filter((d) => !d.skipped);

      expect(skipped.length).toBe(1);
      expect(notSkipped.length).toBe(1);

      reader.close();
    });
  });

  describe("getStatus", () => {
    it("returns status with document counts", async () => {
      const dir = createTempDir();
      const { dbPath, db } = await createTestDb(dir);
      const configDir = path.join(dir, "config");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        path.join(configDir, "index.yml"),
        "collections:\n  notes:\n    path: /tmp/notes\n    pattern: '**/*.md'\n",
      );

      insertTestDoc(db, "notes", "auth.md", "Auth", "content");
      insertTestDoc(db, "notes", "db.md", "DB", "content2");

      const reader = await createQmdReader({ dbPath, configDir });
      const status = reader.getStatus();

      expect(status.totalDocuments).toBe(2);
      expect(status.collections.length).toBe(1);
      expect(status.collections[0]!.name).toBe("notes");
      expect(status.collections[0]!.documents).toBe(2);

      reader.close();
    });
  });
});

describe("addLineNumbers", () => {
  it("adds 1-indexed line numbers", () => {
    expect(addLineNumbers("a\nb\nc")).toBe("1: a\n2: b\n3: c");
  });

  it("respects startLine", () => {
    expect(addLineNumbers("a\nb", 5)).toBe("5: a\n6: b");
  });
});

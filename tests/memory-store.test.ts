import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../src/memory-store.js";
import { parseMemoryFile } from "../src/memory-format.js";

function createTempDir() {
  return mkdtempSync(path.join(tmpdir(), "memory-store-test-"));
}

describe("createMemoryStore", () => {
  describe("write", () => {
    it("creates a markdown file with frontmatter", async () => {
      const dir = createTempDir();
      const store = await createMemoryStore({ memoryDir: dir });

      const entry = await store.write("Auth uses JWT", "decision", ["auth"], "jwt-auth");

      expect(entry.id).toContain("jwt-auth");
      expect(entry.content).toBe("Auth uses JWT");
      expect(entry.category).toBe("decision");

      const filePath = path.join(dir, `${entry.id}.md`);
      expect(existsSync(filePath)).toBe(true);

      const raw = readFileSync(filePath, "utf-8");
      const parsed = parseMemoryFile(raw);
      expect(parsed?.content).toBe("Auth uses JWT");
      expect(parsed?.category).toBe("decision");
      expect(parsed?.tags).toEqual(["auth"]);
    });
  });

  describe("search", () => {
    it("finds inserted documents by BM25", async () => {
      const dir = createTempDir();
      const store = await createMemoryStore({ memoryDir: dir });

      await store.write("Auth flow uses JWT with refresh token rotation", "decision", ["auth"]);
      await store.write("Database uses PostgreSQL for persistence", "decision", ["db"]);
      await store.write("Frontend uses React with TypeScript", "decision", ["frontend"]);

      const results = await store.search("JWT auth token", 5, 0);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.content).toContain("JWT");
      expect(results[0]!.score).toBeGreaterThan(0);
    });

    it("returns empty array when nothing matches", async () => {
      const dir = createTempDir();
      const store = await createMemoryStore({ memoryDir: dir });

      await store.write("Auth flow uses JWT", "decision");

      const results = await store.search("xyznonexistent", 5, 0);
      expect(results).toEqual([]);
    });

    it("respects minScore filter", async () => {
      const dir = createTempDir();
      const store = await createMemoryStore({ memoryDir: dir });

      await store.write("Auth flow uses JWT", "decision");

      const allResults = await store.search("JWT", 5, 0);
      const highScoreResults = await store.search("JWT", 5, 0.99);
      expect(highScoreResults.length).toBeLessThanOrEqual(allResults.length);
    });
  });

  describe("get", () => {
    it("reads and parses an existing memory file", async () => {
      const dir = createTempDir();
      const store = await createMemoryStore({ memoryDir: dir });

      const written = await store.write("Some fact", "fact");
      const retrieved = await store.get(written.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.content).toBe("Some fact");
      expect(retrieved!.category).toBe("fact");
    });

    it("returns null for non-existent id", async () => {
      const dir = createTempDir();
      const store = await createMemoryStore({ memoryDir: dir });

      const result = await store.get("does-not-exist");
      expect(result).toBeNull();
    });
  });

  describe("persistence", () => {
    it("persists index in SQLite and survives new instance", async () => {
      const dir = createTempDir();

      const store1 = await createMemoryStore({ memoryDir: dir });
      await store1.write("Auth flow uses JWT with refresh tokens", "decision");

      const dbPath = path.join(dir, "memories.db");
      expect(existsSync(dbPath)).toBe(true);

      // 新实例应该能查到之前写入的数据
      const store2 = await createMemoryStore({ memoryDir: dir });
      const results = await store2.search("JWT auth", 5, 0);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.content).toContain("JWT");
    });
  });
});

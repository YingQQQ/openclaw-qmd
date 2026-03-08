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
      expect(parsed?.title).toBe("jwt-auth");
      expect(parsed?.category).toBe("decision");
      expect(parsed?.tags).toEqual(["auth"]);
      expect(parsed?.aliases?.some((alias) => alias.includes("jwt-auth") || alias.includes("auth"))).toBe(true);
    });

    it("stores observation-stage entries separately from searchable long-term memory", async () => {
      const dir = createTempDir();
      const store = await createMemoryStore({ memoryDir: dir });

      const entry = await store.writeObservation("User mentioned a possible auth migration", "event");

      expect(entry.stage).toBe("observation");
      const results = await store.search("possible auth migration", 5, 0);
      expect(results).toEqual([]);
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

    it("finds synonym-like matches through hybrid retrieval", async () => {
      const dir = createTempDir();
      const store = await createMemoryStore({ memoryDir: dir });

      await store.write("She wants to help kids in need and build a family.", "event");

      const results = await store.search("children family", 5, 0);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.content).toContain("kids");
    });

    it("respects minScore filter", async () => {
      const dir = createTempDir();
      const store = await createMemoryStore({ memoryDir: dir });

      await store.write("Auth flow uses JWT", "decision");

      const allResults = await store.search("JWT", 5, 0);
      const highScoreResults = await store.search("JWT", 5, 0.99);
      expect(highScoreResults.length).toBeLessThanOrEqual(allResults.length);
    });

    it("searches archived memories separately from active memory", async () => {
      const dir = createTempDir();
      const store = await createMemoryStore({ memoryDir: dir });

      const entry = await store.write("Legacy production incident from last year", "case", undefined, undefined, {
        importance: 0.2,
        confidence: 0.9,
      });

      const dbPath = path.join(dir, "memories.db");
      const { openDatabase } = await import("../src/qmd-lite.js");
      const db = await openDatabase(dbPath);
      db.prepare("UPDATE documents SET archived = 1 WHERE path = ?").run(entry.id);
      db.close();

      const activeResults = await store.search("production incident", 5, 0);
      const archivedResults = await store.searchArchived("production incident", 5, 0);

      expect(activeResults).toEqual([]);
      expect(archivedResults.length).toBeGreaterThan(0);
      expect(archivedResults[0]!.id).toBe(entry.id);
      expect(archivedResults[0]!.archived).toBe(true);
    });

    it("can search active and archived memories together in historical mode", async () => {
      const dir = createTempDir();
      const store = await createMemoryStore({ memoryDir: dir });

      const active = await store.write("Current deployment checklist", "case");
      const archived = await store.write("Legacy deployment checklist from 2024", "case");

      const dbPath = path.join(dir, "memories.db");
      const { openDatabase } = await import("../src/qmd-lite.js");
      const db = await openDatabase(dbPath);
      db.prepare("UPDATE documents SET archived = 1 WHERE path = ?").run(archived.id);
      db.close();

      const results = await store.searchWithArchived("deployment checklist", 10, 0);
      expect(results.some((item) => item.id === active.id)).toBe(true);
      expect(results.some((item) => item.id === archived.id)).toBe(true);
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
      expect(retrieved!.title).toBe("Some fact");
      expect(retrieved!.category).toBe("fact");
    });

    it("returns null for non-existent id", async () => {
      const dir = createTempDir();
      const store = await createMemoryStore({ memoryDir: dir });

      const result = await store.get("does-not-exist");
      expect(result).toBeNull();
    });

    it("returns SQLite metadata as the source of truth when file metadata is stale", async () => {
      const dir = createTempDir();
      const store = await createMemoryStore({ memoryDir: dir });

      const entry = await store.write("Release note for archived memory", "event", ["ops"]);
      const dbPath = path.join(dir, "memories.db");
      const { openDatabase } = await import("../src/qmd-lite.js");
      const db = await openDatabase(dbPath);
      db.prepare(
        "UPDATE documents SET archived = 1, stage = ?, importance = ?, confidence = ? WHERE path = ?",
      ).run("observation", 0.91, 0.66, entry.id);
      db.close();

      const retrieved = await store.get(entry.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.archived).toBe(true);
      expect(retrieved!.stage).toBe("observation");
      expect(retrieved!.importance).toBe(0.91);
      expect(retrieved!.confidence).toBe(0.66);
      expect(retrieved!.tags).toEqual(["ops"]);
      expect(retrieved!.content).toBe("Release note for archived memory");
    });

    it("preserves title-derived aliases after update/merge writes", async () => {
      const dir = createTempDir();
      const store = await createMemoryStore({ memoryDir: dir });

      const initial = await store.write("Service outage runbook", "case", undefined, "incident-playbook");
      await store.write("Service outage runbook with rollback details", "case", undefined, "incident-playbook", {
        confidence: 0.95,
      });

      const updated = await store.get(initial.id);
      expect(updated?.aliases?.some((alias) => alias.includes("incident"))).toBe(true);
      expect(updated?.aliases?.some((alias) => alias.includes("playbook"))).toBe(true);
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

  describe("compaction and recovery", () => {
    it("promotes repeated observations into long-term memory during compaction", async () => {
      const dir = createTempDir();
      const store = await createMemoryStore({ memoryDir: dir });

      await store.writeObservation("I always prefer TypeScript strict mode", "preference");
      await store.writeObservation("I always prefer TypeScript strict mode", "preference", undefined, "strict-pref-2", {
        confidence: 0.8,
      });

      const report = await store.compact();
      const results = await store.search("TypeScript strict mode", 5, 0);

      expect(report.promoted).toBeGreaterThan(0);
      expect(report.promotedIds.length).toBeGreaterThan(0);
      expect(report.actions.some((action) => action.action === "promote")).toBe(true);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.category).toBe("preference");
    });

    it("does not promote a single low-confidence event observation under category policy", async () => {
      const dir = createTempDir();
      const store = await createMemoryStore({ memoryDir: dir });

      await store.writeObservation("We might possibly ship next Tuesday", "event", undefined, undefined, {
        confidence: 0.55,
        importance: 0.55,
      });

      const report = await store.compact();
      const results = await store.search("ship next Tuesday", 5, 0);

      expect(report.promoted).toBe(0);
      expect(results).toEqual([]);
    });

    it("respects configurable compaction policy overrides", async () => {
      const dir = createTempDir();
      const store = await createMemoryStore({
        memoryDir: dir,
        compactCategoryPolicies: {
          event: {
            promoteOccurrences: 1,
            promoteConfidence: 0.5,
            promoteImportance: 0.5,
          },
        },
      });

      await store.writeObservation("We might possibly ship next Tuesday", "event", undefined, undefined, {
        confidence: 0.55,
        importance: 0.55,
      });

      const report = await store.compact();
      const results = await store.search("ship next Tuesday", 5, 0);

      expect(report.promoted).toBeGreaterThan(0);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.category).toBe("event");
    });

    it("builds a preconscious shortlist from recent important memories", async () => {
      const dir = createTempDir();
      const store = await createMemoryStore({ memoryDir: dir });

      await store.write("Critical production incident follow-up", "case", undefined, undefined, {
        importance: 0.95,
        confidence: 0.9,
      });
      await store.write("Minor style preference note", "preference", undefined, undefined, {
        importance: 0.2,
        confidence: 0.6,
      });

      const items = await store.buildPreconscious(1);
      expect(items).toHaveLength(1);
      expect(items[0]!.content).toContain("Critical production incident");
    });

    it("respects configurable preconscious policy weights and category boosts", async () => {
      const dir = createTempDir();
      const store = await createMemoryStore({
        memoryDir: dir,
        preconsciousPolicy: {
          importanceWeight: 0.1,
          confidenceWeight: 0.1,
          recencyWeight: 0.1,
          maxAgeDays: 365,
          categoryBoosts: {
            preference: 0.6,
          },
        },
      });

      await store.write("High-importance but neutral note", "entity", undefined, undefined, {
        importance: 0.95,
        confidence: 0.95,
      });
      await store.write("User strongly prefers concise responses", "preference", undefined, undefined, {
        importance: 0.5,
        confidence: 0.5,
      });

      const items = await store.buildPreconscious(1);
      expect(items).toHaveLength(1);
      expect(items[0]!.category).toBe("preference");
    });

    it("recovers pending session observations from disk", async () => {
      const dir = createTempDir();
      const store = await createMemoryStore({ memoryDir: dir });

      await store.persistPendingSession({
        storedAt: new Date().toISOString(),
        entries: [
          {
            content: "Remember that I prefer dark mode",
            category: "preference",
            confidence: 0.7,
            importance: 0.7,
          },
        ],
      });

      const recovered = await store.recoverPendingSession();
      const report = await store.compact();
      const results = await store.search("dark mode", 5, 0);

      expect(recovered).toBe(1);
      expect(report.promoted).toBeGreaterThan(0);
      expect(results.length).toBeGreaterThan(0);
    });

    it("does not recover pending entries that already exist in long-term memory", async () => {
      const dir = createTempDir();
      const store = await createMemoryStore({ memoryDir: dir });

      await store.write("Remember that I prefer dark mode", "preference", undefined, undefined, {
        confidence: 0.9,
        importance: 0.8,
      });
      await store.persistPendingSession({
        storedAt: new Date().toISOString(),
        entries: [
          {
            content: "Remember that I prefer dark mode",
            category: "preference",
            confidence: 0.7,
            importance: 0.7,
          },
        ],
      });

      const recovered = await store.recoverPendingSession();
      expect(recovered).toBe(0);
    });

    it("summarizes old event memories before archiving them", async () => {
      const dir = createTempDir();
      const store = await createMemoryStore({ memoryDir: dir });

      const oldDate = "2000-01-01T00:00:00.000Z";
      await store.write("Launch planning meeting happened and decisions were captured", "event", undefined, undefined, {
        importance: 0.4,
        confidence: 0.9,
      });
      await store.write("Follow-up deployment meeting resolved the remaining blockers", "event", undefined, undefined, {
        importance: 0.4,
        confidence: 0.9,
      });

      const first = await store.search("Launch planning meeting", 5, 0);
      const second = await store.search("deployment meeting", 5, 0);
      expect(first[0]).toBeDefined();
      expect(second[0]).toBeDefined();

      const dbPath = path.join(dir, "memories.db");
      const { openDatabase } = await import("../src/qmd-lite.js");
      const db = await openDatabase(dbPath);
      db.prepare("UPDATE documents SET created_at = ?, modified_at = ? WHERE path = ?").run(oldDate, oldDate, first[0]!.id);
      db.prepare("UPDATE documents SET created_at = ?, modified_at = ? WHERE path = ?").run(oldDate, oldDate, second[0]!.id);
      db.close();

      const report = await store.compact();
      const summaryResults = await store.search("compaction summary meeting", 10, 0);

      expect(report.summarized).toBeGreaterThan(0);
      expect(report.summarizedIds.length).toBeGreaterThan(0);
      expect(report.actions.some((action) => action.action === "archive")).toBe(true);
      expect(summaryResults.some((item) => item.content.includes("Compaction summary"))).toBe(true);
    });

    it("reports memory stats across active, archived, and observation stages", async () => {
      const dir = createTempDir();
      const store = await createMemoryStore({ memoryDir: dir });

      const archivedEntry = await store.write("Old deployment detail", "event");
      await store.write("Current stable preference", "preference");
      await store.writeObservation("Tentative migration note", "case");

      const dbPath = path.join(dir, "memories.db");
      const { openDatabase } = await import("../src/qmd-lite.js");
      const db = await openDatabase(dbPath);
      db.prepare("UPDATE documents SET archived = 1 WHERE path = ?").run(archivedEntry.id);
      db.close();

      const stats = await store.getStats();

      expect(stats.total).toBe(3);
      expect(stats.active).toBe(2);
      expect(stats.archived).toBe(1);
      expect(stats.memory).toBe(2);
      expect(stats.observations).toBe(1);
      expect(stats.categories.event?.archived).toBe(1);
      expect(stats.categories.preference?.active).toBe(1);
      expect(stats.categories.case?.observations).toBe(1);
      expect(stats.stages.memory).toBe(2);
      expect(stats.stages.observation).toBe(1);
    });

    it("lists active observations and supports manual promote/drop review", async () => {
      const dir = createTempDir();
      const store = await createMemoryStore({ memoryDir: dir });

      const first = await store.writeObservation("Possible API migration next quarter", "event", undefined, undefined, {
        confidence: 0.6,
      });
      const second = await store.writeObservation("Remember my preferred changelog format", "preference", undefined, "changelog-style", {
        confidence: 0.8,
        importance: 0.7,
      });

      const observations = await store.listObservations(10, 0.5);
      expect(observations.length).toBe(2);
      expect(observations.some((item) => item.id === first.id)).toBe(true);
      expect(observations.some((item) => item.id === second.id)).toBe(true);

      const promoteResult = await store.reviewObservation(second.id, "promote");
      expect(promoteResult.reviewed).toBe(true);
      expect(promoteResult.promotedId).toBeDefined();
      expect(promoteResult.promotedId).toContain("changelog-style");

      const promotedObservation = await store.get(second.id);
      expect(promotedObservation?.archived).toBe(true);

      const memoryResults = await store.search("preferred changelog format", 5, 0);
      expect(memoryResults.length).toBeGreaterThan(0);

      const dropResult = await store.reviewObservation(first.id, "drop");
      expect(dropResult.reviewed).toBe(true);

      const remaining = await store.listObservations(10, 0);
      expect(remaining).toEqual([]);
    });

    it("syncs archived state back to markdown files after manual archive", async () => {
      const dir = createTempDir();
      const store = await createMemoryStore({ memoryDir: dir });

      const observation = await store.writeObservation("Temporary migration note", "event");
      await store.reviewObservation(observation.id, "archive");

      const filePath = path.join(dir, `${observation.id}.md`);
      const raw = readFileSync(filePath, "utf-8");
      expect(raw).toContain("archived: true");
    });

    it("records access when explicitly requested", async () => {
      const dir = createTempDir();
      const store = await createMemoryStore({ memoryDir: dir });
      const entry = await store.write("Frequently reopened operational note", "case");

      await store.recordAccess([entry.id, entry.id]);
      const retrieved = await store.get(entry.id);

      expect(retrieved?.accessCount).toBe(2);
      expect(retrieved?.lastAccessedAt).toBeDefined();
    });
  });
});

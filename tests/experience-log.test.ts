import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  extractCorrections,
  recordInsight,
  recordMistake,
  loadInsights,
  loadMistakes,
  formatInsightsContext,
  type InsightRecord,
  type MistakeRecord,
} from "../src/experience-log.js";

function msg(role: string, content: string) {
  return { role, content };
}

describe("extractCorrections", () => {
  it("extracts records when error -> fix sequence exists", () => {
    const messages = [
      msg("user", "help me fix this"),
      msg("assistant", "I see an error: the module failed to load"),
      msg("user", "yes"),
      msg("assistant", "I fixed it by updating the import path, works now"),
    ];
    const records = extractCorrections(messages);
    expect(records.length).toBe(1);
    expect(records[0].description).toMatch(/error/i);
    expect(records[0].resolution).toMatch(/fixed/i);
  });

  it("returns empty when no errors exist", () => {
    const messages = [
      msg("user", "hello"),
      msg("assistant", "hi there, how can I help?"),
      msg("user", "tell me about TypeScript"),
      msg("assistant", "TypeScript is a typed superset of JavaScript"),
    ];
    const records = extractCorrections(messages);
    expect(records).toEqual([]);
  });
});

describe("file operations", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "openclaw-test-"));
  });

  // cleanup is best-effort
  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("recordInsight creates file and writes entry", () => {
    const record: InsightRecord = {
      timestamp: "2026-03-06T10:00:00Z",
      category: "pattern",
      content: "Use barrel exports for cleaner imports",
    };
    recordInsight(tmpDir, record);

    const records = loadInsights(tmpDir);
    expect(records.length).toBe(1);
    expect(records[0].category).toBe("pattern");
    expect(records[0].content).toBe("Use barrel exports for cleaner imports");
  });

  it("recordInsight appends to existing file", () => {
    recordInsight(tmpDir, {
      timestamp: "2026-03-06T10:00:00Z",
      category: "pattern",
      content: "First learning",
    });
    recordInsight(tmpDir, {
      timestamp: "2026-03-06T11:00:00Z",
      category: "error_fix",
      content: "Second learning",
    });

    const records = loadInsights(tmpDir);
    expect(records.length).toBe(2);
    expect(records[0].content).toBe("First learning");
    expect(records[1].content).toBe("Second learning");
  });

  it("recordMistake creates file and writes entry", () => {
    const record: MistakeRecord = {
      timestamp: "2026-03-06T10:00:00Z",
      description: "Module not found",
      resolution: "Added missing dependency",
    };
    recordMistake(tmpDir, record);

    const records = loadMistakes(tmpDir);
    expect(records.length).toBe(1);
    expect(records[0].description).toBe("Module not found");
    expect(records[0].resolution).toBe("Added missing dependency");
  });

  it("loadInsights parses written records correctly", () => {
    recordInsight(tmpDir, {
      timestamp: "2026-03-06T10:00:00Z",
      category: "optimization",
      content: "Cache DB queries to reduce latency",
    });

    const records = loadInsights(tmpDir);
    expect(records.length).toBe(1);
    expect(records[0].timestamp).toBe("2026-03-06T10:00:00Z");
    expect(records[0].category).toBe("optimization");
    expect(records[0].content).toBe("Cache DB queries to reduce latency");
  });

  it("loadMistakes parses written records correctly", () => {
    recordMistake(tmpDir, {
      timestamp: "2026-03-06T10:00:00Z",
      description: "Timeout on startup",
      resolution: "Increased connection timeout",
    });

    const records = loadMistakes(tmpDir);
    expect(records.length).toBe(1);
    expect(records[0].timestamp).toBe("2026-03-06T10:00:00Z");
    expect(records[0].description).toBe("Timeout on startup");
    expect(records[0].resolution).toBe("Increased connection timeout");
  });

  it("auto-creates learningsDir when it does not exist", () => {
    const nested = path.join(tmpDir, "deep", "nested", "dir");
    recordInsight(nested, {
      timestamp: "2026-03-06T10:00:00Z",
      category: "pattern",
      content: "test auto create",
    });
    const records = loadInsights(nested);
    expect(records.length).toBe(1);
  });
});

describe("formatInsightsContext", () => {
  it("formats output with agent-learnings tags", () => {
    const records: InsightRecord[] = [
      {
        timestamp: "2026-03-06T10:00:00Z",
        category: "pattern",
        content: "Use early returns",
      },
      {
        timestamp: "2026-03-06T11:00:00Z",
        category: "error_fix",
        content: "Check null before access",
      },
    ];
    const output = formatInsightsContext(records);
    expect(output).toContain("<agent-learnings>");
    expect(output).toContain("</agent-learnings>");
    expect(output).toContain("- [pattern] Use early returns");
    expect(output).toContain("- [error_fix] Check null before access");
  });

  it("maxRecords=2 returns only the most recent 2 records", () => {
    const records: InsightRecord[] = [
      { timestamp: "1", category: "a", content: "first" },
      { timestamp: "2", category: "b", content: "second" },
      { timestamp: "3", category: "c", content: "third" },
      { timestamp: "4", category: "d", content: "fourth" },
    ];
    const output = formatInsightsContext(records, 2);
    expect(output).not.toContain("first");
    expect(output).not.toContain("second");
    expect(output).toContain("- [c] third");
    expect(output).toContain("- [d] fourth");
  });
});

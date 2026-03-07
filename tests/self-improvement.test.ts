import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  detectErrorFixPattern,
  appendLearning,
  appendError,
  readLearnings,
  readErrors,
  formatLearningsContext,
  type LearningRecord,
  type ErrorRecord,
} from "../src/self-improvement.js";

function msg(role: string, content: string) {
  return { role, content };
}

describe("detectErrorFixPattern", () => {
  it("extracts records when error -> fix sequence exists", () => {
    const messages = [
      msg("user", "help me fix this"),
      msg("assistant", "I see an error: the module failed to load"),
      msg("user", "yes"),
      msg("assistant", "I fixed it by updating the import path, works now"),
    ];
    const records = detectErrorFixPattern(messages);
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
    const records = detectErrorFixPattern(messages);
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

  it("appendLearning creates file and writes entry", () => {
    const record: LearningRecord = {
      timestamp: "2026-03-06T10:00:00Z",
      category: "pattern",
      content: "Use barrel exports for cleaner imports",
    };
    appendLearning(tmpDir, record);

    const records = readLearnings(tmpDir);
    expect(records.length).toBe(1);
    expect(records[0].category).toBe("pattern");
    expect(records[0].content).toBe("Use barrel exports for cleaner imports");
  });

  it("appendLearning appends to existing file", () => {
    appendLearning(tmpDir, {
      timestamp: "2026-03-06T10:00:00Z",
      category: "pattern",
      content: "First learning",
    });
    appendLearning(tmpDir, {
      timestamp: "2026-03-06T11:00:00Z",
      category: "error_fix",
      content: "Second learning",
    });

    const records = readLearnings(tmpDir);
    expect(records.length).toBe(2);
    expect(records[0].content).toBe("First learning");
    expect(records[1].content).toBe("Second learning");
  });

  it("appendError creates file and writes entry", () => {
    const record: ErrorRecord = {
      timestamp: "2026-03-06T10:00:00Z",
      description: "Module not found",
      resolution: "Added missing dependency",
    };
    appendError(tmpDir, record);

    const records = readErrors(tmpDir);
    expect(records.length).toBe(1);
    expect(records[0].description).toBe("Module not found");
    expect(records[0].resolution).toBe("Added missing dependency");
  });

  it("readLearnings parses written records correctly", () => {
    appendLearning(tmpDir, {
      timestamp: "2026-03-06T10:00:00Z",
      category: "optimization",
      content: "Cache DB queries to reduce latency",
    });

    const records = readLearnings(tmpDir);
    expect(records.length).toBe(1);
    expect(records[0].timestamp).toBe("2026-03-06T10:00:00Z");
    expect(records[0].category).toBe("optimization");
    expect(records[0].content).toBe("Cache DB queries to reduce latency");
  });

  it("readErrors parses written records correctly", () => {
    appendError(tmpDir, {
      timestamp: "2026-03-06T10:00:00Z",
      description: "Timeout on startup",
      resolution: "Increased connection timeout",
    });

    const records = readErrors(tmpDir);
    expect(records.length).toBe(1);
    expect(records[0].timestamp).toBe("2026-03-06T10:00:00Z");
    expect(records[0].description).toBe("Timeout on startup");
    expect(records[0].resolution).toBe("Increased connection timeout");
  });

  it("auto-creates learningsDir when it does not exist", () => {
    const nested = path.join(tmpDir, "deep", "nested", "dir");
    appendLearning(nested, {
      timestamp: "2026-03-06T10:00:00Z",
      category: "pattern",
      content: "test auto create",
    });
    const records = readLearnings(nested);
    expect(records.length).toBe(1);
  });
});

describe("formatLearningsContext", () => {
  it("formats output with agent-learnings tags", () => {
    const records: LearningRecord[] = [
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
    const output = formatLearningsContext(records);
    expect(output).toContain("<agent-learnings>");
    expect(output).toContain("</agent-learnings>");
    expect(output).toContain("- [pattern] Use early returns");
    expect(output).toContain("- [error_fix] Check null before access");
  });

  it("maxRecords=2 returns only the most recent 2 records", () => {
    const records: LearningRecord[] = [
      { timestamp: "1", category: "a", content: "first" },
      { timestamp: "2", category: "b", content: "second" },
      { timestamp: "3", category: "c", content: "third" },
      { timestamp: "4", category: "d", content: "fourth" },
    ];
    const output = formatLearningsContext(records, 2);
    expect(output).not.toContain("first");
    expect(output).not.toContain("second");
    expect(output).toContain("- [c] third");
    expect(output).toContain("- [d] fourth");
  });
});

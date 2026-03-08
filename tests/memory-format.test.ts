import { describe, expect, it } from "vitest";
import {
  slugify,
  generateMemoryId,
  formatMemoryFile,
  parseMemoryFile,
  formatRecalledMemories,
  type MemoryEntry,
} from "../src/memory-format.js";

describe("slugify", () => {
  it("lowercases and replaces non-alphanumeric with dashes", () => {
    expect(slugify("Auth Flow Decision!")).toBe("auth-flow-decision");
  });

  it("trims leading/trailing dashes", () => {
    expect(slugify("--hello--world--")).toBe("hello-world");
  });

  it("truncates to 60 characters", () => {
    const long = "a".repeat(100);
    expect(slugify(long).length).toBeLessThanOrEqual(60);
  });

  it("handles empty string", () => {
    expect(slugify("")).toBe("");
  });
});

describe("generateMemoryId", () => {
  it("produces a timestamp + slug format", () => {
    const id = generateMemoryId("some content about auth", "Auth Decision");
    expect(id).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}_[a-z0-9]{4}_auth-decision$/);
  });

  it("falls back to content when no title", () => {
    const id = generateMemoryId("JWT tokens are used for authentication");
    expect(id).toContain("jwt-tokens-are-used-for-authentication");
  });
});

describe("formatMemoryFile / parseMemoryFile", () => {
  const entry: MemoryEntry = {
    id: "2026-03-06T09-15-00_auth-flow",
    content: "Auth flow uses JWT with refresh token rotation.",
    title: "Auth Flow",
    category: "decision",
    tags: ["auth", "architecture"],
    created: "2026-03-06T09:15:00Z",
  };

  it("roundtrips through format and parse", () => {
    const formatted = formatMemoryFile(entry);
    const parsed = parseMemoryFile(formatted);
    expect(parsed).toEqual(entry);
  });

  it("handles entries without category or tags", () => {
    const minimal: MemoryEntry = {
      id: "test-id",
      content: "Simple note.",
      created: "2026-01-01T00:00:00Z",
    };
    const formatted = formatMemoryFile(minimal);
    const parsed = parseMemoryFile(formatted);
    expect(parsed).toEqual(minimal);
  });

  it("roundtrips abstract and summary when present", () => {
    const enriched: MemoryEntry = {
      id: "rich-id",
      content: "Detailed memory body.",
      title: "Rich Entry",
      created: "2026-01-01T00:00:00Z",
      abstract: "Short abstract.",
      summary: "Longer summary.",
    };
    const formatted = formatMemoryFile(enriched);
    const parsed = parseMemoryFile(formatted);
    expect(parsed).toEqual(enriched);
  });

  it("returns null for invalid input", () => {
    expect(parseMemoryFile("not a frontmatter file")).toBeNull();
    expect(parseMemoryFile("---\nno id\n---\nbody")).toBeNull();
  });
});

describe("formatRecalledMemories", () => {
  it("returns empty string for no entries", () => {
    expect(formatRecalledMemories([])).toBe("");
  });

  it("formats entries with xml tags", () => {
    const result = formatRecalledMemories([
      { id: "mem-1", content: "JWT is used", category: "fact", score: 0.85 },
      { id: "mem-2", content: "Use postgres", score: 0.72 },
    ]);
    expect(result).toContain("<recalled-memories>");
    expect(result).toContain("</recalled-memories>");
    expect(result).toContain("[mem-1]");
    expect(result).toContain("(fact score=0.85)");
    expect(result).toContain("[mem-2]");
    expect(result).toContain("JWT is used");
  });
});

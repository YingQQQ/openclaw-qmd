import { describe, expect, it } from "vitest";
import {
  getDedupeDecision,
  mergeContents,
  type ExistingMatch,
} from "../src/memory-dedup.js";

describe("getDedupeDecision", () => {
  it("no matches → create", () => {
    const result = getDedupeDecision("new content", "fact", []);
    expect(result.decision).toBe("create");
  });

  it("score 0.96 → skip", () => {
    const matches: ExistingMatch[] = [
      { id: "e1", content: "old", category: "fact", score: 0.96 },
    ];
    const result = getDedupeDecision("new content", "fact", matches);
    expect(result.decision).toBe("skip");
    expect(result.matchId).toBe("e1");
    expect(result.reason).toBe("duplicate");
  });

  it("score 0.88 same category → update", () => {
    const matches: ExistingMatch[] = [
      { id: "e2", content: "old", category: "fact", score: 0.88 },
    ];
    const result = getDedupeDecision("new content", "fact", matches);
    expect(result.decision).toBe("update");
    expect(result.matchId).toBe("e2");
    expect(result.reason).toBe("high similarity, same category");
  });

  it("score 0.88 different category → create", () => {
    const matches: ExistingMatch[] = [
      { id: "e3", content: "old", category: "preference", score: 0.88 },
    ];
    const result = getDedupeDecision("new content", "fact", matches);
    expect(result.decision).toBe("create");
    expect(result.reason).toBe("distinct enough");
  });

  it("score 0.75 normal category → merge", () => {
    const matches: ExistingMatch[] = [
      { id: "e4", content: "old", category: "fact", score: 0.75 },
    ];
    const result = getDedupeDecision("new content", "fact", matches);
    expect(result.decision).toBe("merge");
    expect(result.matchId).toBe("e4");
    expect(result.reason).toBe("partial overlap");
  });

  it("score 0.75 event category → create (no merge for event)", () => {
    const matches: ExistingMatch[] = [
      { id: "e5", content: "old", category: "event", score: 0.75 },
    ];
    const result = getDedupeDecision("new content", "event", matches);
    expect(result.decision).toBe("create");
    expect(result.reason).toBe("distinct enough");
  });

  it("score 0.75 case category → create (no merge for case)", () => {
    const matches: ExistingMatch[] = [
      { id: "e6", content: "old", category: "case", score: 0.75 },
    ];
    const result = getDedupeDecision("new content", "case", matches);
    expect(result.decision).toBe("create");
    expect(result.reason).toBe("distinct enough");
  });

  it("score 0.5 → create", () => {
    const matches: ExistingMatch[] = [
      { id: "e7", content: "old", category: "fact", score: 0.5 },
    ];
    const result = getDedupeDecision("new content", "fact", matches);
    expect(result.decision).toBe("create");
    expect(result.reason).toBe("distinct enough");
  });
});

describe("mergeContents", () => {
  it("A contains B → returns A", () => {
    const a = "Hello world, this is a complete sentence.";
    const b = "this is a complete";
    expect(mergeContents(a, b)).toBe(a);
  });

  it("B contains A → returns B", () => {
    const a = "partial";
    const b = "This is a partial match.";
    expect(mergeContents(a, b)).toBe(b);
  });

  it("A and B different → returns A + separator + B", () => {
    const a = "First content";
    const b = "Second content";
    expect(mergeContents(a, b)).toBe("First content\n\n---\n\nSecond content");
  });

  it("merged result exceeding 5000 chars → truncated", () => {
    const a = "X".repeat(3000);
    const b = "Y".repeat(3000);
    const result = mergeContents(a, b);
    expect(result.length).toBe(5000);
  });
});

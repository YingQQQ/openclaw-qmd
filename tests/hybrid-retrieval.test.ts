import { describe, expect, it } from "vitest";
import { fuseRankedResults, rankSemanticMatches } from "../src/hybrid-retrieval.js";

describe("rankSemanticMatches", () => {
  it("matches synonyms such as children -> kids", () => {
    const results = rankSemanticMatches("children family", [
      {
        id: "a",
        content: "She wants to help kids and build a family.",
      },
      {
        id: "b",
        content: "He likes databases and indexing.",
      },
    ]);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.id).toBe("a");
  });
});

describe("fuseRankedResults", () => {
  it("includes semantic-only candidates in fused results", () => {
    const fused = fuseRankedResults(
      [{ id: "lex", score: 0.8 }],
      [{ id: "sem", score: 0.9 }],
      5,
    );

    expect(fused.map((item) => item.id)).toContain("lex");
    expect(fused.map((item) => item.id)).toContain("sem");
  });
});

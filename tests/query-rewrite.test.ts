import { describe, expect, it, vi } from "vitest";
import { buildQueryVariants, searchWithQueryVariants } from "../src/query-rewrite.js";

describe("buildQueryVariants", () => {
  it("keeps raw query and adds keyword variant", () => {
    const variants = buildQueryVariants("What did Caroline research?");
    expect(variants).toEqual([
      "What did Caroline research?",
      "caroline research",
    ]);
  });

  it("adds temporal hints for when-questions", () => {
    const variants = buildQueryVariants("When did Caroline go to the support group?");
    expect(variants).toContain("caroline go support group");
    expect(variants).toContain("caroline go support group date time");
    expect(variants).toContain("caroline go support group year month day");
  });
});

describe("searchWithQueryVariants", () => {
  it("merges unique results and keeps the highest score per id", async () => {
    const searchFn = vi.fn(async (query: string) => {
      if (query === "What did Caroline research?") {
        return [{ id: "a", score: 0.3 }, { id: "b", score: 0.2 }];
      }
      return [{ id: "a", score: 0.5 }, { id: "c", score: 0.4 }];
    });

    const { variants, results } = await searchWithQueryVariants(
      searchFn,
      "What did Caroline research?",
      5,
      0,
    );

    expect(variants).toEqual([
      "What did Caroline research?",
      "caroline research",
    ]);
    expect(results).toEqual([
      { id: "a", score: 0.5 },
      { id: "c", score: 0.4 },
      { id: "b", score: 0.2 },
    ]);
  });
});

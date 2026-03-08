import { describe, expect, it } from "vitest";
import { inferCategoryWeights } from "../src/query-intent.js";

describe("inferCategoryWeights", () => {
  it("boosts event-like categories for temporal questions", () => {
    expect(inferCategoryWeights("When did Caroline go to the support group?")).toEqual({
      event: 1.35,
      entity: 1.05,
    });
  });

  it("boosts profile and entity for identity questions", () => {
    expect(inferCategoryWeights("What is Caroline's identity?")).toEqual({
      profile: 1.35,
      entity: 1.2,
    });
  });

  it("returns undefined for generic questions", () => {
    expect(inferCategoryWeights("Tell me more")).toBeUndefined();
  });
});

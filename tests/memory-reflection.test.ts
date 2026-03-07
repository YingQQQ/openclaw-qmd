import { describe, it, expect } from "vitest";
import {
  extractReflections,
  jaccardSimilarity,
} from "../src/memory-reflection.js";

// Helper to build message arrays
function msg(role: string, content: string) {
  return { role, content };
}

function padMessages(
  extra: { role: string; content: string }[],
  total: number,
): { role: string; content: string }[] {
  const pad: { role: string; content: string }[] = [];
  for (let i = pad.length + extra.length; i < total; i++) {
    pad.push(msg(i % 2 === 0 ? "user" : "assistant", `filler message ${i}`));
  }
  return [...pad, ...extra];
}

describe("extractReflections", () => {
  it("returns empty entries when session length < 10", () => {
    const messages = [
      msg("user", "hello"),
      msg("assistant", "decided to use JWT for auth"),
    ];
    const result = extractReflections(messages);
    expect(result.entries).toEqual([]);
    expect(result.sessionLength).toBe(2);
  });

  it("extracts decision type from 'decided to use JWT'", () => {
    const messages = padMessages(
      [msg("assistant", "I decided to use JWT for authentication in this project")],
      11,
    );
    const result = extractReflections(messages);
    const decisions = result.entries.filter((e) => e.type === "decision");
    expect(decisions.length).toBeGreaterThanOrEqual(1);
    expect(decisions[0].content).toMatch(/JWT/i);
  });

  it("extracts user_model type from 'I prefer TypeScript'", () => {
    const messages = padMessages(
      [msg("user", "I prefer TypeScript over JavaScript for all projects")],
      11,
    );
    const result = extractReflections(messages);
    const models = result.entries.filter((e) => e.type === "user_model");
    expect(models.length).toBeGreaterThanOrEqual(1);
    expect(models[0].content).toMatch(/TypeScript/i);
  });

  it("extracts lesson type from error/fix pattern", () => {
    const messages = padMessages(
      [
        msg("assistant", "the bug was caused by a missing null check in the parser module"),
        msg("assistant", "fixed by adding a null guard before accessing the property value"),
      ],
      12,
    );
    const result = extractReflections(messages);
    const lessons = result.entries.filter((e) => e.type === "lesson");
    expect(lessons.length).toBeGreaterThanOrEqual(1);
  });

  it("extracts invariant type from 'always run tests before commit'", () => {
    const messages = padMessages(
      [msg("assistant", "always run tests before commit to catch regressions early")],
      11,
    );
    const result = extractReflections(messages);
    const invariants = result.entries.filter((e) => e.type === "invariant");
    expect(invariants.length).toBeGreaterThanOrEqual(1);
    expect(invariants[0].content).toMatch(/tests/i);
  });

  it("deduplicates similar decision entries", () => {
    const messages = padMessages(
      [
        msg("assistant", "decided to use JWT tokens for user authentication"),
        msg("assistant", "decided to use JWT tokens for the user authentication"),
      ],
      12,
    );
    const result = extractReflections(messages);
    const decisions = result.entries.filter((e) => e.type === "decision");
    expect(decisions.length).toBe(1);
  });

  it("extracts multiple types from mixed messages", () => {
    const messages = padMessages(
      [
        msg("assistant", "decided to use PostgreSQL for the database layer"),
        msg("user", "I prefer dark mode themes in all editors"),
        msg("assistant", "the issue was a race condition in the event loop handler"),
        msg("assistant", "always validate input before processing the request"),
      ],
      14,
    );
    const result = extractReflections(messages);
    const types = new Set(result.entries.map((e) => e.type));
    expect(types.size).toBeGreaterThanOrEqual(3);
  });
});

describe("jaccardSimilarity", () => {
  it("returns 1.0 for identical strings", () => {
    expect(jaccardSimilarity("hello world", "hello world")).toBe(1.0);
  });

  it("returns ~0.33 for partially overlapping strings", () => {
    const sim = jaccardSimilarity("hello world", "goodbye world");
    expect(sim).toBeCloseTo(1 / 3, 1);
  });

  it("returns 0 for two empty strings", () => {
    expect(jaccardSimilarity("", "")).toBe(0);
  });
});

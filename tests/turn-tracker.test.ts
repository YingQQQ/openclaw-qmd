import { describe, it, expect } from "vitest";
import { createTurnTracker, fnvLiteHash } from "../src/turn-tracker.js";

describe("TurnTracker", () => {
  it("markRecalled + wasRecalled: 标记后返回 true，未标记返回 false", () => {
    const tracker = createTurnTracker();
    expect(tracker.wasRecalled("mem-1")).toBe(false);
    tracker.markRecalled("mem-1");
    expect(tracker.wasRecalled("mem-1")).toBe(true);
    expect(tracker.wasRecalled("mem-2")).toBe(false);
  });

  it("markCaptured + wasCaptured: 标记后返回 true，未标记返回 false", () => {
    const tracker = createTurnTracker();
    const hash = fnvLiteHash("hello world");
    expect(tracker.wasCaptured(hash)).toBe(false);
    tracker.markCaptured(hash);
    expect(tracker.wasCaptured(hash)).toBe(true);
    expect(tracker.wasCaptured(fnvLiteHash("other text"))).toBe(false);
  });

  it("recalledCount: 标记 3 个后返回 3", () => {
    const tracker = createTurnTracker();
    tracker.markRecalled("a");
    tracker.markRecalled("b");
    tracker.markRecalled("c");
    expect(tracker.recalledCount()).toBe(3);
  });

  it("capturedCount: 标记 2 个后返回 2", () => {
    const tracker = createTurnTracker();
    tracker.markCaptured(fnvLiteHash("text-1"));
    tracker.markCaptured(fnvLiteHash("text-2"));
    expect(tracker.capturedCount()).toBe(2);
  });

  it("filterRecalled: 输入 [a, b, c]，标记 b 已召回 → 返回 [a, c]", () => {
    const tracker = createTurnTracker();
    tracker.markRecalled("b");

    const results = [
      { id: "a", score: 0.9 },
      { id: "b", score: 0.8 },
      { id: "c", score: 0.7 },
    ];

    const filtered = tracker.filterRecalled(results);
    expect(filtered).toEqual([
      { id: "a", score: 0.9 },
      { id: "c", score: 0.7 },
    ]);
  });

  it("clear: 清理后 count 为 0，was 返回 false", () => {
    const tracker = createTurnTracker();
    tracker.markRecalled("x");
    tracker.markCaptured(fnvLiteHash("y"));
    expect(tracker.recalledCount()).toBe(1);
    expect(tracker.capturedCount()).toBe(1);

    tracker.clear();
    expect(tracker.recalledCount()).toBe(0);
    expect(tracker.capturedCount()).toBe(0);
    expect(tracker.wasRecalled("x")).toBe(false);
    expect(tracker.wasCaptured(fnvLiteHash("y"))).toBe(false);
  });

  it("重复 markRecalled 同一 id 不增加 count", () => {
    const tracker = createTurnTracker();
    tracker.markRecalled("dup");
    tracker.markRecalled("dup");
    tracker.markRecalled("dup");
    expect(tracker.recalledCount()).toBe(1);
  });
});

describe("fnvLiteHash", () => {
  it("相同文本返回相同 hash", () => {
    expect(fnvLiteHash("hello")).toBe(fnvLiteHash("hello"));
  });

  it("不同文本返回不同 hash", () => {
    expect(fnvLiteHash("hello")).not.toBe(fnvLiteHash("world"));
  });

  it("空字符串有确定性结果", () => {
    const h1 = fnvLiteHash("");
    const h2 = fnvLiteHash("");
    expect(h1).toBe(h2);
    expect(typeof h1).toBe("string");
    expect(h1.length).toBeGreaterThan(0);
  });
});

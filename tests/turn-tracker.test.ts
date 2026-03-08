import { describe, it, expect } from "vitest";
import { createTurnTracker, djb2Hash } from "../src/turn-tracker.js";

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
    const hash = djb2Hash("hello world");
    expect(tracker.wasCaptured(hash)).toBe(false);
    tracker.markCaptured(hash);
    expect(tracker.wasCaptured(hash)).toBe(true);
    expect(tracker.wasCaptured(djb2Hash("other text"))).toBe(false);
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
    tracker.markCaptured(djb2Hash("text-1"));
    tracker.markCaptured(djb2Hash("text-2"));
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
    tracker.markCaptured(djb2Hash("y"));
    expect(tracker.recalledCount()).toBe(1);
    expect(tracker.capturedCount()).toBe(1);

    tracker.clear();
    expect(tracker.recalledCount()).toBe(0);
    expect(tracker.capturedCount()).toBe(0);
    expect(tracker.wasRecalled("x")).toBe(false);
    expect(tracker.wasCaptured(djb2Hash("y"))).toBe(false);
  });

  it("重复 markRecalled 同一 id 不增加 count", () => {
    const tracker = createTurnTracker();
    tracker.markRecalled("dup");
    tracker.markRecalled("dup");
    tracker.markRecalled("dup");
    expect(tracker.recalledCount()).toBe(1);
  });
});

describe("djb2Hash", () => {
  it("相同文本返回相同 hash", () => {
    expect(djb2Hash("hello")).toBe(djb2Hash("hello"));
  });

  it("不同文本返回不同 hash", () => {
    expect(djb2Hash("hello")).not.toBe(djb2Hash("world"));
  });

  it("空字符串有确定性结果", () => {
    const h1 = djb2Hash("");
    const h2 = djb2Hash("");
    expect(h1).toBe(h2);
    expect(typeof h1).toBe("string");
    expect(h1.length).toBeGreaterThan(0);
  });
});

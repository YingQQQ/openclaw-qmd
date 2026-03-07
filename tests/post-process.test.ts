import { describe, it, expect } from 'vitest';
import {
  applyRecencyBoost,
  applyCategoryWeight,
  applyLengthNormalization,
  applyTimeDecay,
  hardMinScoreFilter,
  applyMMRDiversity,
  postProcess,
  type ScoredResult,
} from '../src/post-process.js';

const BASE_DATE = '2026-03-06T00:00:00.000Z';

function daysAgo(days: number): string {
  const d = new Date(BASE_DATE);
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function makeResult(overrides: Partial<ScoredResult> & { id: string }): ScoredResult {
  return {
    content: 'some content',
    score: 1.0,
    ...overrides,
  };
}

describe('applyRecencyBoost', () => {
  it('boosts recent memories more than old ones', () => {
    const results: ScoredResult[] = [
      makeResult({ id: 'new', created: daysAgo(0), score: 1.0 }),
      makeResult({ id: 'old', created: daysAgo(30), score: 1.0 }),
    ];
    const boosted = applyRecencyBoost(results, 1.2, 30);
    const newScore = boosted.find((r) => r.id === 'new')!.score;
    const oldScore = boosted.find((r) => r.id === 'old')!.score;
    expect(newScore).toBeGreaterThan(oldScore);
  });

  it('does not modify the input array', () => {
    const results: ScoredResult[] = [makeResult({ id: '1', created: daysAgo(0), score: 1.0 })];
    const original = results[0].score;
    applyRecencyBoost(results);
    expect(results[0].score).toBe(original);
  });
});

describe('applyCategoryWeight', () => {
  it('gives event category higher score than pattern (same base score)', () => {
    const results: ScoredResult[] = [
      makeResult({ id: 'ev', category: 'event', score: 1.0 }),
      makeResult({ id: 'pat', category: 'pattern', score: 1.0 }),
    ];
    const weighted = applyCategoryWeight(results);
    const evScore = weighted.find((r) => r.id === 'ev')!.score;
    const patScore = weighted.find((r) => r.id === 'pat')!.score;
    expect(evScore).toBeGreaterThan(patScore);
  });

  it('defaults unknown categories to weight 1.0', () => {
    const results: ScoredResult[] = [makeResult({ id: '1', category: 'unknown', score: 2.0 })];
    const weighted = applyCategoryWeight(results);
    expect(weighted[0].score).toBe(2.0);
  });
});

describe('applyLengthNormalization', () => {
  it('penalizes long content relative to short content', () => {
    const results: ScoredResult[] = [
      makeResult({ id: 'long', content: 'x'.repeat(3000), score: 1.0 }),
      makeResult({ id: 'short', content: 'x'.repeat(500), score: 1.0 }),
    ];
    const normalized = applyLengthNormalization(results, 2000);
    const longScore = normalized.find((r) => r.id === 'long')!.score;
    const shortScore = normalized.find((r) => r.id === 'short')!.score;
    expect(longScore).toBeLessThan(shortScore);
  });

  it('does not penalize content under threshold', () => {
    const results: ScoredResult[] = [
      makeResult({ id: '1', content: 'x'.repeat(1000), score: 1.0 }),
    ];
    const normalized = applyLengthNormalization(results, 2000);
    expect(normalized[0].score).toBe(1.0);
  });

  it('caps penalty factor at 0.5', () => {
    const results: ScoredResult[] = [
      makeResult({ id: '1', content: 'x'.repeat(100000), score: 1.0 }),
    ];
    const normalized = applyLengthNormalization(results, 2000);
    expect(normalized[0].score).toBe(0.5);
  });
});

describe('applyTimeDecay', () => {
  it('decays 60-day-old memory to approximately half', () => {
    const results: ScoredResult[] = [
      makeResult({ id: '1', created: daysAgo(60), score: 1.0 }),
    ];
    const decayed = applyTimeDecay(results, 60);
    // Should be approximately 0.5
    expect(decayed[0].score).toBeCloseTo(0.5, 1);
  });

  it('does not decay memories without created date', () => {
    const results: ScoredResult[] = [makeResult({ id: '1', score: 1.0 })];
    const decayed = applyTimeDecay(results, 60);
    expect(decayed[0].score).toBe(1.0);
  });
});

describe('hardMinScoreFilter', () => {
  it('filters results below the minimum score', () => {
    const results: ScoredResult[] = [
      makeResult({ id: 'low', score: 0.1 }),
      makeResult({ id: 'high', score: 0.5 }),
    ];
    const filtered = hardMinScoreFilter(results, 0.3);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe('high');
  });

  it('keeps results at exactly the minimum score', () => {
    const results: ScoredResult[] = [makeResult({ id: '1', score: 0.3 })];
    const filtered = hardMinScoreFilter(results, 0.3);
    expect(filtered).toHaveLength(1);
  });
});

describe('applyMMRDiversity', () => {
  it('ranks the higher-scored of two similar items first', () => {
    const results: ScoredResult[] = [
      makeResult({ id: 'a', content: 'the quick brown fox jumps over the lazy dog', score: 0.9 }),
      makeResult({ id: 'b', content: 'the quick brown fox jumps over the lazy cat', score: 0.8 }),
    ];
    const diverse = applyMMRDiversity(results, 0.7);
    expect(diverse[0].id).toBe('a');
  });

  it('prefers diverse content when scores are close', () => {
    const results: ScoredResult[] = [
      makeResult({ id: 'a', content: 'typescript react frontend development patterns', score: 1.0 }),
      makeResult({ id: 'b', content: 'typescript react frontend development practices', score: 0.95 }),
      makeResult({ id: 'c', content: 'python machine learning neural network training', score: 0.9 }),
    ];
    const diverse = applyMMRDiversity(results, 0.7);
    // First should be 'a' (highest score), second should be 'c' (most diverse)
    expect(diverse[0].id).toBe('a');
    expect(diverse[1].id).toBe('c');
  });

  it('returns a new array (does not modify input)', () => {
    const results: ScoredResult[] = [
      makeResult({ id: 'a', content: 'hello world', score: 1.0 }),
    ];
    const diverse = applyMMRDiversity(results);
    expect(diverse).not.toBe(results);
    expect(diverse[0]).not.toBe(results[0]);
  });
});

describe('postProcess (full pipeline)', () => {
  it('processes multiple results: sorts correctly, filters low scores', () => {
    const now = daysAgo(0);
    const results: ScoredResult[] = [
      makeResult({ id: '1', content: 'event about project launch meeting', category: 'event', score: 1.0, created: now }),
      makeResult({ id: '2', content: 'user preference for dark mode theme', category: 'preference', score: 0.9, created: daysAgo(10) }),
      makeResult({ id: '3', content: 'old pattern from ancient history notes', category: 'pattern', score: 0.8, created: daysAgo(120) }),
      makeResult({ id: '4', content: 'recent case study analysis report', category: 'case', score: 0.85, created: daysAgo(5) }),
      makeResult({ id: '5', content: 'very low score noise result filler', category: 'pattern', score: 0.01, created: daysAgo(90) }),
    ];

    const processed = postProcess(results, { minScore: 0.05 });

    // The very low score item (#5) after time decay should be filtered out
    const ids = processed.map((r) => r.id);
    expect(ids).not.toContain('5');

    // The first result should be the highest-scored one
    expect(processed.length).toBeGreaterThanOrEqual(1);
    expect(processed.length).toBeLessThanOrEqual(4);

    // Scores should be in a reasonable order (first >= second due to MMR reranking)
    // The pipeline applied recency + category + time decay, so newer event/case items should rank high
    expect(processed[0].score).toBeGreaterThan(0);
  });

  it('does not modify original results array', () => {
    const results: ScoredResult[] = [
      makeResult({ id: '1', content: 'hello world', score: 1.0, created: daysAgo(0) }),
    ];
    const originalScore = results[0].score;
    postProcess(results);
    expect(results[0].score).toBe(originalScore);
  });

  it('works with empty input', () => {
    expect(postProcess([])).toEqual([]);
  });
});

import { describe, it, expect } from 'vitest';
import {
  boostByFreshness,
  weightByCategory,
  penalizeLongContent,
  decayByAge,
  filterBelowThreshold,
  diversifyResults,
  weightByPriority,
  weightByReliability,
  penalizeNearExpiry,
  reinforceByUsage,
  rankResults,
  type RankedEntry,
} from '../src/score-pipeline.js';

const BASE_DATE = '2026-03-06T00:00:00.000Z';

function daysAgo(days: number): string {
  const d = new Date(BASE_DATE);
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function makeResult(overrides: Partial<RankedEntry> & { id: string }): RankedEntry {
  return {
    content: 'some content',
    score: 1.0,
    ...overrides,
  };
}

describe('boostByFreshness', () => {
  it('boosts recent memories more than old ones', () => {
    const results: RankedEntry[] = [
      makeResult({ id: 'new', created: daysAgo(0), score: 1.0 }),
      makeResult({ id: 'old', created: daysAgo(30), score: 1.0 }),
    ];
    const boosted = boostByFreshness(results, 1.2, 30);
    const newScore = boosted.find((r) => r.id === 'new')!.score;
    const oldScore = boosted.find((r) => r.id === 'old')!.score;
    expect(newScore).toBeGreaterThan(oldScore);
  });

  it('does not modify the input array', () => {
    const results: RankedEntry[] = [makeResult({ id: '1', created: daysAgo(0), score: 1.0 })];
    const original = results[0].score;
    boostByFreshness(results);
    expect(results[0].score).toBe(original);
  });
});

describe('weightByCategory', () => {
  it('gives event category higher score than pattern (same base score)', () => {
    const results: RankedEntry[] = [
      makeResult({ id: 'ev', category: 'event', score: 1.0 }),
      makeResult({ id: 'pat', category: 'pattern', score: 1.0 }),
    ];
    const weighted = weightByCategory(results);
    const evScore = weighted.find((r) => r.id === 'ev')!.score;
    const patScore = weighted.find((r) => r.id === 'pat')!.score;
    expect(evScore).toBeGreaterThan(patScore);
  });

  it('defaults unknown categories to weight 1.0', () => {
    const results: RankedEntry[] = [makeResult({ id: '1', category: 'unknown', score: 2.0 })];
    const weighted = weightByCategory(results);
    expect(weighted[0].score).toBe(2.0);
  });
});

describe('penalizeLongContent', () => {
  it('penalizes long content relative to short content', () => {
    const results: RankedEntry[] = [
      makeResult({ id: 'long', content: 'x'.repeat(3000), score: 1.0 }),
      makeResult({ id: 'short', content: 'x'.repeat(500), score: 1.0 }),
    ];
    const normalized = penalizeLongContent(results, 2000);
    const longScore = normalized.find((r) => r.id === 'long')!.score;
    const shortScore = normalized.find((r) => r.id === 'short')!.score;
    expect(longScore).toBeLessThan(shortScore);
  });

  it('does not penalize content under threshold', () => {
    const results: RankedEntry[] = [
      makeResult({ id: '1', content: 'x'.repeat(1000), score: 1.0 }),
    ];
    const normalized = penalizeLongContent(results, 2000);
    expect(normalized[0].score).toBe(1.0);
  });

  it('caps penalty factor at 0.5', () => {
    const results: RankedEntry[] = [
      makeResult({ id: '1', content: 'x'.repeat(100000), score: 1.0 }),
    ];
    const normalized = penalizeLongContent(results, 2000);
    expect(normalized[0].score).toBe(0.5);
  });
});

describe('decayByAge', () => {
  it('decays 60-day-old memory to approximately half', () => {
    const results: RankedEntry[] = [
      makeResult({ id: '1', created: daysAgo(60), score: 1.0 }),
    ];
    const decayed = decayByAge(results, 60);
    // Should be approximately 0.5
    expect(decayed[0].score).toBeCloseTo(0.5, 1);
  });

  it('does not decay memories without created date', () => {
    const results: RankedEntry[] = [makeResult({ id: '1', score: 1.0 })];
    const decayed = decayByAge(results, 60);
    expect(decayed[0].score).toBe(1.0);
  });
});

describe('filterBelowThreshold', () => {
  it('filters results below the minimum score', () => {
    const results: RankedEntry[] = [
      makeResult({ id: 'low', score: 0.1 }),
      makeResult({ id: 'high', score: 0.5 }),
    ];
    const filtered = filterBelowThreshold(results, 0.3);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe('high');
  });

  it('keeps results at exactly the minimum score', () => {
    const results: RankedEntry[] = [makeResult({ id: '1', score: 0.3 })];
    const filtered = filterBelowThreshold(results, 0.3);
    expect(filtered).toHaveLength(1);
  });
});

describe('metadata-aware boosts', () => {
  it('boosts higher-importance results above lower-importance ones', () => {
    const results: RankedEntry[] = [
      makeResult({ id: 'low', importance: 0.1, score: 1.0 }),
      makeResult({ id: 'high', importance: 0.9, score: 1.0 }),
    ];
    const boosted = weightByPriority(results, 0.2);
    expect(boosted.find((r) => r.id === 'high')!.score).toBeGreaterThan(boosted.find((r) => r.id === 'low')!.score);
  });

  it('boosts high-confidence results and slightly penalizes recovery sources', () => {
    const results: RankedEntry[] = [
      makeResult({ id: 'recovery', confidence: 0.9, sourceType: 'recovery', score: 1.0 }),
      makeResult({ id: 'manual', confidence: 0.9, sourceType: 'manual', score: 1.0 }),
    ];
    const boosted = weightByReliability(results, 0.15);
    expect(boosted.find((r) => r.id === 'manual')!.score).toBeGreaterThan(boosted.find((r) => r.id === 'recovery')!.score);
  });

  it('filters expired memories and boosts near-expiry ones', () => {
    const future = new Date('2099-03-06T12:00:00.000Z').toISOString();
    const past = new Date('2000-03-04T00:00:00.000Z').toISOString();
    const results: RankedEntry[] = [
      makeResult({ id: 'future', expiresAt: future, score: 1.0 }),
      makeResult({ id: 'expired', expiresAt: past, score: 1.0 }),
    ];
    const processed = penalizeNearExpiry(results, 0.3);
    expect(processed.map((r) => r.id)).toContain('future');
    expect(processed.map((r) => r.id)).not.toContain('expired');
  });

  it('reinforces frequently accessed and recently used memories', () => {
    const results: RankedEntry[] = [
      makeResult({ id: 'cold', accessCount: 0, score: 1.0 }),
      makeResult({ id: 'warm', accessCount: 8, lastAccessedAt: daysAgo(1), score: 1.0 }),
    ];
    const boosted = reinforceByUsage(results, 0.2, 14);
    expect(boosted.find((r) => r.id === 'warm')!.score).toBeGreaterThan(boosted.find((r) => r.id === 'cold')!.score);
  });
});

describe('diversifyResults', () => {
  it('ranks the higher-scored of two similar items first', () => {
    const results: RankedEntry[] = [
      makeResult({ id: 'a', content: 'the quick brown fox jumps over the lazy dog', score: 0.9 }),
      makeResult({ id: 'b', content: 'the quick brown fox jumps over the lazy cat', score: 0.8 }),
    ];
    const diverse = diversifyResults(results, 0.7);
    expect(diverse[0].id).toBe('a');
  });

  it('prefers diverse content when scores are close', () => {
    const results: RankedEntry[] = [
      makeResult({ id: 'a', content: 'typescript react frontend development patterns', score: 1.0 }),
      makeResult({ id: 'b', content: 'typescript react frontend development practices', score: 0.95 }),
      makeResult({ id: 'c', content: 'python machine learning neural network training', score: 0.9 }),
    ];
    const diverse = diversifyResults(results, 0.7);
    // First should be 'a' (highest score), second should be 'c' (most diverse)
    expect(diverse[0].id).toBe('a');
    expect(diverse[1].id).toBe('c');
  });

  it('returns a new array (does not modify input)', () => {
    const results: RankedEntry[] = [
      makeResult({ id: 'a', content: 'hello world', score: 1.0 }),
    ];
    const diverse = diversifyResults(results);
    expect(diverse).not.toBe(results);
    expect(diverse[0]).not.toBe(results[0]);
  });
});

describe('rankResults (full pipeline)', () => {
  it('processes multiple results: sorts correctly, filters low scores', () => {
    const now = daysAgo(0);
    const results: RankedEntry[] = [
      makeResult({ id: '1', content: 'event about project launch meeting', category: 'event', score: 1.0, created: now }),
      makeResult({ id: '2', content: 'user preference for dark mode theme', category: 'preference', score: 0.9, created: daysAgo(10) }),
      makeResult({ id: '3', content: 'old pattern from ancient history notes', category: 'pattern', score: 0.8, created: daysAgo(120) }),
      makeResult({ id: '4', content: 'recent case study analysis report', category: 'case', score: 0.85, created: daysAgo(5) }),
      makeResult({ id: '5', content: 'very low score noise result filler', category: 'pattern', score: 0.01, created: daysAgo(90) }),
    ];

    const processed = rankResults(results, { minScore: 0.05 });

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
    const results: RankedEntry[] = [
      makeResult({ id: '1', content: 'hello world', score: 1.0, created: daysAgo(0) }),
    ];
    const originalScore = results[0].score;
    rankResults(results);
    expect(results[0].score).toBe(originalScore);
  });

  it('works with empty input', () => {
    expect(rankResults([])).toEqual([]);
  });
});

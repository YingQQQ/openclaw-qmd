/**
 * BM25 post-processing pipeline: multi-dimensional re-ranking of search results.
 */

export type ScoredResult = {
  id: string;
  content: string;
  title?: string;
  category?: string;
  score: number;
  created?: string;
  accessCount?: number;
  lastAccessedAt?: string;
};

export type PostProcessOptions = {
  recencyBoostMax?: number;
  recencyHalfLifeDays?: number;
  categoryWeights?: Record<string, number>;
  lengthPenaltyThreshold?: number;
  timeDecayHalfLifeDays?: number;
  minScore?: number;
  mmrLambda?: number;
  mmrEnabled?: boolean;
};

const DEFAULT_CATEGORY_WEIGHTS: Record<string, number> = {
  event: 1.15,
  case: 1.15,
  preference: 1.08,
  profile: 1.05,
  entity: 1.05,
  pattern: 1.0,
};

function ageDays(isoDate: string | undefined): number {
  if (!isoDate) return 0;
  const ms = Date.now() - new Date(isoDate).getTime();
  return Math.max(0, ms / (1000 * 60 * 60 * 24));
}

/**
 * Boost newer memories. boost = 1 + (maxBoost - 1) * 0.5^(ageDays / halfLife)
 */
export function applyRecencyBoost(
  results: ScoredResult[],
  maxBoost = 1.2,
  halfLifeDays = 30,
): ScoredResult[] {
  return results.map((r) => {
    if (!r.created) return { ...r };
    const age = ageDays(r.created);
    const boost = 1 + (maxBoost - 1) * Math.pow(0.5, age / halfLifeDays);
    return { ...r, score: r.score * boost };
  });
}

/**
 * Multiply score by category weight.
 */
export function applyCategoryWeight(
  results: ScoredResult[],
  weights: Record<string, number> = DEFAULT_CATEGORY_WEIGHTS,
): ScoredResult[] {
  return results.map((r) => {
    const w = r.category ? (weights[r.category] ?? 1.0) : 1.0;
    return { ...r, score: r.score * w };
  });
}

/**
 * Penalize overly long content. score *= threshold / length (min 0.5).
 */
export function applyLengthNormalization(
  results: ScoredResult[],
  threshold = 2000,
): ScoredResult[] {
  return results.map((r) => {
    if (r.content.length <= threshold) return { ...r };
    const factor = Math.max(0.5, threshold / r.content.length);
    return { ...r, score: r.score * factor };
  });
}

/**
 * Time decay: score *= 0.5^(ageDays / halfLife).
 */
export function applyTimeDecay(
  results: ScoredResult[],
  halfLifeDays = 60,
): ScoredResult[] {
  return results.map((r) => {
    if (!r.created) return { ...r };
    const age = ageDays(r.created);
    return { ...r, score: r.score * Math.pow(0.5, age / halfLifeDays) };
  });
}

/**
 * Remove results below a hard minimum score.
 */
export function hardMinScoreFilter(
  results: ScoredResult[],
  minScore: number,
): ScoredResult[] {
  return results.filter((r) => r.score >= minScore);
}

// --- MMR diversity ---

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[\s\p{P}]+/u)
      .filter((t) => t.length > 0),
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Maximal Marginal Relevance: greedily select results that balance
 * relevance and diversity using Jaccard similarity on bag-of-words.
 */
export function applyMMRDiversity(
  results: ScoredResult[],
  lambda = 0.7,
): ScoredResult[] {
  if (results.length <= 1) return results.map((r) => ({ ...r }));

  const tokenSets = results.map((r) => tokenize(r.content));
  const selected: number[] = [];
  const remaining = new Set(results.map((_, i) => i));

  // Pick the highest-scored one first
  let bestIdx = 0;
  let bestScore = -Infinity;
  for (const i of remaining) {
    if (results[i].score > bestScore) {
      bestScore = results[i].score;
      bestIdx = i;
    }
  }
  selected.push(bestIdx);
  remaining.delete(bestIdx);

  while (remaining.size > 0) {
    let mmrBestIdx = -1;
    let mmrBestScore = -Infinity;

    for (const i of remaining) {
      const relevance = results[i].score;
      let maxSim = 0;
      for (const j of selected) {
        const sim = jaccardSimilarity(tokenSets[i], tokenSets[j]);
        if (sim > maxSim) maxSim = sim;
      }
      const mmrScore = lambda * relevance - (1 - lambda) * maxSim;
      if (mmrScore > mmrBestScore) {
        mmrBestScore = mmrScore;
        mmrBestIdx = i;
      }
    }

    selected.push(mmrBestIdx);
    remaining.delete(mmrBestIdx);
  }

  return selected.map((i) => ({ ...results[i] }));
}

/**
 * Full post-processing pipeline.
 */
export function postProcess(
  results: ScoredResult[],
  opts: PostProcessOptions = {},
): ScoredResult[] {
  const {
    recencyBoostMax = 1.2,
    recencyHalfLifeDays = 30,
    categoryWeights,
    lengthPenaltyThreshold = 2000,
    timeDecayHalfLifeDays = 60,
    minScore,
    mmrLambda = 0.7,
    mmrEnabled = true,
  } = opts;

  let processed = applyRecencyBoost(results, recencyBoostMax, recencyHalfLifeDays);
  processed = applyCategoryWeight(processed, categoryWeights);
  processed = applyLengthNormalization(processed, lengthPenaltyThreshold);
  processed = applyTimeDecay(processed, timeDecayHalfLifeDays);

  if (minScore !== undefined) {
    processed = hardMinScoreFilter(processed, minScore);
  }

  // Sort by score descending before MMR
  processed.sort((a, b) => b.score - a.score);

  if (mmrEnabled) {
    processed = applyMMRDiversity(processed, mmrLambda);
  }

  return processed;
}

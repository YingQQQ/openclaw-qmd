export type ScoredResult = {
  id: string;
  content: string;
  title?: string;
  category?: string;
  score: number;
  created?: string;
  accessCount?: number;
  lastAccessedAt?: string;
  importance?: number;
  confidence?: number;
  sourceType?: string;
  expiresAt?: string;
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
  importanceWeight?: number;
  confidenceWeight?: number;
  expiryPenalty?: number;
  accessWeight?: number;
  accessRecencyHalfLifeDays?: number;
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

export function applyCategoryWeight(
  results: ScoredResult[],
  weights: Record<string, number> = DEFAULT_CATEGORY_WEIGHTS,
): ScoredResult[] {
  return results.map((r) => {
    const w = r.category ? (weights[r.category] ?? 1.0) : 1.0;
    return { ...r, score: r.score * w };
  });
}

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

export function hardMinScoreFilter(
  results: ScoredResult[],
  minScore: number,
): ScoredResult[] {
  return results.filter((r) => r.score >= minScore);
}

export function applyImportanceBoost(
  results: ScoredResult[],
  weight = 0.2,
): ScoredResult[] {
  return results.map((r) => {
    const importance = Math.max(0, Math.min(1, r.importance ?? 0.5));
    return { ...r, score: r.score * (1 + importance * weight) };
  });
}

export function applyConfidenceBoost(
  results: ScoredResult[],
  weight = 0.15,
): ScoredResult[] {
  return results.map((r) => {
    const confidence = Math.max(0, Math.min(1, r.confidence ?? 1));
    const sourcePenalty = r.sourceType === "recovery" ? 0.97 : 1;
    return { ...r, score: r.score * (1 + confidence * weight) * sourcePenalty };
  });
}

export function applyExpiryPenalty(
  results: ScoredResult[],
  penalty = 0.3,
): ScoredResult[] {
  return results
    .filter((r) => {
      if (!r.expiresAt) return true;
      return new Date(r.expiresAt).getTime() > Date.now();
    })
    .map((r) => {
      if (!r.expiresAt) return { ...r };
      const daysLeft = (new Date(r.expiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
      const nearExpiryFactor = daysLeft <= 1 ? 1 - penalty : 1;
      return { ...r, score: r.score * nearExpiryFactor };
    });
}

export function applyAccessReinforcement(
  results: ScoredResult[],
  weight = 0.12,
  lastAccessHalfLifeDays = 14,
): ScoredResult[] {
  return results.map((r) => {
    const accessCount = Math.max(0, r.accessCount ?? 0);
    const cappedAccess = Math.min(12, accessCount);
    const accessBoost = 1 + cappedAccess * weight * 0.05;
    const recencyBoost = r.lastAccessedAt
      ? 1 + (weight * 0.5 * Math.pow(0.5, ageDays(r.lastAccessedAt) / lastAccessHalfLifeDays))
      : 1;
    return { ...r, score: r.score * accessBoost * recencyBoost };
  });
}

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

export function applyMMRDiversity(
  results: ScoredResult[],
  lambda = 0.7,
): ScoredResult[] {
  if (results.length <= 1) return results.map((r) => ({ ...r }));

  const tokenSets = results.map((r) => tokenize(r.content));
  const selected: number[] = [];
  const remaining = new Set(results.map((_, i) => i));

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

  const simCache = new Map<string, number>();
  const simKey = (a: number, b: number) => a < b ? `${a}:${b}` : `${b}:${a}`;

  while (remaining.size > 0) {
    let mmrBestIdx = -1;
    let mmrBestScore = -Infinity;

    for (const i of remaining) {
      const relevance = results[i].score;
      let maxSim = 0;
      for (const j of selected) {
        const key = simKey(i, j);
        let sim = simCache.get(key);
        if (sim === undefined) {
          sim = jaccardSimilarity(tokenSets[i], tokenSets[j]);
          simCache.set(key, sim);
        }
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
    importanceWeight = 0.2,
    confidenceWeight = 0.15,
    expiryPenalty = 0.3,
    accessWeight = 0.12,
    accessRecencyHalfLifeDays = 14,
  } = opts;

  let processed = applyRecencyBoost(results, recencyBoostMax, recencyHalfLifeDays);
  processed = applyCategoryWeight(processed, categoryWeights);
  processed = applyImportanceBoost(processed, importanceWeight);
  processed = applyConfidenceBoost(processed, confidenceWeight);
  processed = applyLengthNormalization(processed, lengthPenaltyThreshold);
  processed = applyTimeDecay(processed, timeDecayHalfLifeDays);
  processed = applyExpiryPenalty(processed, expiryPenalty);
  processed = applyAccessReinforcement(processed, accessWeight, accessRecencyHalfLifeDays);

  if (minScore !== undefined) {
    processed = hardMinScoreFilter(processed, minScore);
  }

  processed.sort((a, b) => b.score - a.score);

  if (mmrEnabled) {
    processed = applyMMRDiversity(processed, mmrLambda);
  }

  return processed;
}

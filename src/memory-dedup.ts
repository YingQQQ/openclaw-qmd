export type DedupeDecision = "create" | "update" | "merge" | "skip";

export type ExistingMatch = {
  id: string;
  content: string;
  category?: string;
  score: number;
};

export type DedupeOptions = {
  skipThreshold?: number;
  updateThreshold?: number;
  mergeThreshold?: number;
  noMergeCategories?: string[];
};

const DEFAULT_OPTIONS: DedupeOptions = {
  skipThreshold: 0.95,
  updateThreshold: 0.85,
  mergeThreshold: 0.7,
  noMergeCategories: ["event", "case"],
};

export function getDedupeDecision(
  newContent: string,
  newCategory: string | undefined,
  matches: ExistingMatch[],
  opts?: DedupeOptions,
): { decision: DedupeDecision; matchId?: string; reason: string } {
  const o = { ...DEFAULT_OPTIONS, ...opts };

  if (matches.length === 0) {
    return { decision: "create", reason: "no existing matches" };
  }

  const best = matches.reduce((a, b) => (a.score >= b.score ? a : b));

  if (best.score >= o.skipThreshold!) {
    return { decision: "skip", matchId: best.id, reason: "duplicate" };
  }

  if (best.score >= o.updateThreshold!) {
    if (best.category === newCategory) {
      return {
        decision: "update",
        matchId: best.id,
        reason: "high similarity, same category",
      };
    }
    return { decision: "create", reason: "distinct enough" };
  }

  if (best.score >= o.mergeThreshold!) {
    const noMerge = o.noMergeCategories ?? [];
    if (newCategory && noMerge.includes(newCategory)) {
      return { decision: "create", reason: "distinct enough" };
    }
    return {
      decision: "merge",
      matchId: best.id,
      reason: "partial overlap",
    };
  }

  return { decision: "create", reason: "distinct enough" };
}

const MAX_MERGED_LENGTH = 5000;

export function mergeContents(existing: string, incoming: string): string {
  if (existing.includes(incoming)) {
    return existing;
  }
  if (incoming.includes(existing)) {
    return incoming;
  }
  const merged = existing + "\n\n---\n\n" + incoming;
  if (merged.length > MAX_MERGED_LENGTH) {
    const truncated = merged.slice(0, MAX_MERGED_LENGTH);
    const lastSentence = truncated.search(/[.!?。！？]\s*[^.!?。！？]*$/);
    if (lastSentence > MAX_MERGED_LENGTH * 0.8) {
      return truncated.slice(0, lastSentence + 1);
    }
    return truncated;
  }
  return merged;
}

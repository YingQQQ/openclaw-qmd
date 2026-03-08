export type QueryVariantOptions = {
  includeTemporalHints?: boolean;
};

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "to", "of", "in", "on", "at", "for", "from",
  "with", "about", "into", "through", "during", "before", "after", "over", "under",
  "again", "further", "then", "once", "did", "do", "does", "is", "are", "was", "were",
  "be", "been", "being", "have", "has", "had", "what", "when", "where", "who", "whom",
  "why", "how", "which", "would", "should", "could", "can", "may", "might", "will",
  "shall", "this", "that", "these", "those", "i", "you", "he", "she", "it", "we", "they",
  "me", "him", "her", "them", "my", "your", "his", "their", "our", "likely",
]);

function splitCJK(text: string): string {
  return text.replace(/([\u4e00-\u9fff\u3400-\u4dbf])/gu, " $1 ");
}

function normalizeTokens(text: string): string[] {
  return splitCJK(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 1 && !STOP_WORDS.has(token));
}

export function buildQueryVariants(
  query: string,
  options: QueryVariantOptions = {},
): string[] {
  const includeTemporalHints = options.includeTemporalHints ?? true;
  const variants: string[] = [];
  const seen = new Set<string>();

  const push = (value: string) => {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    variants.push(normalized);
  };

  push(query);

  const keywords = normalizeTokens(query);
  if (keywords.length > 0) {
    push(keywords.join(" "));
  }

  if (includeTemporalHints && /^\s*when\b/i.test(query) && keywords.length > 0) {
    push([...keywords, "date", "time"].join(" "));
    push([...keywords, "year", "month", "day"].join(" "));
  }

  return variants;
}

type SearchHit = {
  id: string;
  score: number;
};

export async function searchWithQueryVariants<T extends SearchHit>(
  searchFn: (query: string, limit: number, minScore: number) => Promise<T[]>,
  query: string,
  limit: number,
  minScore: number,
  options: QueryVariantOptions = {},
): Promise<{ variants: string[]; results: T[] }> {
  const variants = buildQueryVariants(query, options);
  const merged = new Map<string, T>();
  const perQueryLimit = Math.max(limit, Math.min(limit * 2, 20));

  for (const variant of variants) {
    const hits = await searchFn(variant, perQueryLimit, minScore);
    for (const hit of hits) {
      const existing = merged.get(hit.id);
      if (!existing || hit.score > existing.score) {
        merged.set(hit.id, hit);
      }
    }
  }

  const results = [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return { variants, results };
}

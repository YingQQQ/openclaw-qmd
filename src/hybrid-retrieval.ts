type HybridDoc = {
  id: string;
  title?: string;
  content: string;
  abstract?: string;
  summary?: string;
};

type RankedDoc = {
  id: string;
  score: number;
};

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "to", "of", "in", "on", "at", "for", "from",
  "with", "about", "into", "through", "during", "before", "after", "over", "under",
  "again", "further", "then", "once", "did", "do", "does", "is", "are", "was", "were",
  "be", "been", "being", "have", "has", "had", "what", "when", "where", "who", "whom",
  "why", "how", "which", "would", "should", "could", "can", "may", "might", "will",
  "shall", "this", "that", "these", "those", "i", "you", "he", "she", "it", "we", "they",
  "me", "him", "her", "them", "my", "your", "his", "their", "our",
]);

const SYNONYM_GROUPS = [
  ["kid", "kids", "child", "children", "family"],
  ["identity", "gender", "transgender", "woman", "man"],
  ["study", "studies", "studying", "research", "researching", "education", "school"],
  ["job", "career", "work", "profession"],
  ["support", "group", "community", "club"],
  ["adopt", "adoption", "adoptive", "family"],
];

const SYNONYM_MAP = new Map<string, string[]>();
for (const group of SYNONYM_GROUPS) {
  for (const token of group) {
    SYNONYM_MAP.set(token, group.filter((item) => item !== token));
  }
}

function stemToken(token: string): string {
  let value = token.toLowerCase();
  value = value.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, "");
  if (value.length > 5 && value.endsWith("ing")) return value.slice(0, -3);
  if (value.length > 4 && value.endsWith("ied")) return value.slice(0, -3) + "y";
  if (value.length > 4 && value.endsWith("ed")) return value.slice(0, -2);
  if (value.length > 4 && value.endsWith("es")) return value.slice(0, -2);
  if (value.length > 3 && value.endsWith("s")) return value.slice(0, -1);
  return value;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .map(stemToken)
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

function expandTokens(tokens: string[]): Set<string> {
  const expanded = new Set<string>();
  for (const token of tokens) {
    expanded.add(token);
    const synonyms = SYNONYM_MAP.get(token);
    if (synonyms) {
      for (const synonym of synonyms) {
        expanded.add(stemToken(synonym));
      }
    }
  }
  return expanded;
}

function overlapScore(queryTokens: Set<string>, docTokens: Set<string>): number {
  if (queryTokens.size === 0 || docTokens.size === 0) return 0;
  let matches = 0;
  for (const token of queryTokens) {
    if (docTokens.has(token)) matches++;
  }
  return matches / queryTokens.size;
}

export function rankSemanticMatches(
  query: string,
  docs: HybridDoc[],
  limit = 20,
): RankedDoc[] {
  const baseTokens = tokenize(query);
  const queryTokens = expandTokens(baseTokens);
  if (queryTokens.size === 0) return [];

  const ranked = docs
    .map((doc) => {
      const titleTokens = expandTokens(tokenize(doc.title ?? ""));
      const abstractTokens = expandTokens(tokenize(doc.abstract ?? ""));
      const summaryTokens = expandTokens(tokenize(doc.summary ?? ""));
      const contentTokens = expandTokens(tokenize(doc.content));

      const titleScore = overlapScore(queryTokens, titleTokens);
      const abstractScore = overlapScore(queryTokens, abstractTokens);
      const summaryScore = overlapScore(queryTokens, summaryTokens);
      const contentScore = overlapScore(queryTokens, contentTokens);

      const score = Math.max(
        titleScore * 1.25,
        abstractScore * 1.15,
        summaryScore * 1.1,
        contentScore,
      );

      return { id: doc.id, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return ranked;
}

export function fuseRankedResults(
  lexical: RankedDoc[],
  semantic: RankedDoc[],
  limit = 20,
  lexicalWeight = 0.7,
  semanticWeight = 0.3,
): RankedDoc[] {
  const fused = new Map<string, number>();
  const rrf = (rank: number) => 1 / (rank + 60);

  lexical.forEach((item, index) => {
    fused.set(item.id, (fused.get(item.id) ?? 0) + lexicalWeight * (item.score + rrf(index + 1)));
  });

  semantic.forEach((item, index) => {
    fused.set(item.id, (fused.get(item.id) ?? 0) + semanticWeight * (item.score + rrf(index + 1)));
  });

  return [...fused.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

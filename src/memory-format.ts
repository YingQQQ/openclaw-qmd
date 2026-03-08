export type MemoryCategory =
  | "profile"
  | "preference"
  | "entity"
  | "event"
  | "case"
  | "pattern";

export const MEMORY_CATEGORIES: readonly MemoryCategory[] = [
  "profile",
  "preference",
  "entity",
  "event",
  "case",
  "pattern",
];

export type MemoryEntry = {
  id: string;
  content: string;
  title?: string;
  category?: string;
  tags?: string[];
  created: string;
  importance?: number;
  confidence?: number;
  accessCount?: number;
  lastAccessedAt?: string;
  abstract?: string;
  summary?: string;
  scope?: string;
  sourceType?: string;
  stage?: "memory" | "observation";
  expiresAt?: string;
  archived?: boolean;
  aliases?: string[];
};

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function generateMemoryId(content: string, title?: string): string {
  const now = new Date();
  const ts = now.toISOString().replace(/:/g, "-").replace("Z", "");
  const rand = Math.random().toString(36).slice(2, 6);
  const slug = slugify(title ?? content.slice(0, 60));
  return `${ts}_${rand}_${slug}`;
}

export function formatMemoryFile(entry: MemoryEntry): string {
  const lines: string[] = ["---"];
  lines.push(`id: "${entry.id}"`);
  if (entry.title) {
    lines.push(`title: "${entry.title.replace(/"/g, '\\"')}"`);
  }
  if (entry.category) {
    lines.push(`category: "${entry.category}"`);
  }
  if (entry.tags?.length) {
    lines.push(`tags: [${entry.tags.map((t) => `"${t.replace(/"/g, '\\"')}"`).join(", ")}]`);
  }
  lines.push(`created: "${entry.created}"`);
  if (entry.importance !== undefined && entry.importance !== 0.5) {
    lines.push(`importance: ${entry.importance}`);
  }
  if (entry.confidence !== undefined && entry.confidence !== 1) {
    lines.push(`confidence: ${entry.confidence}`);
  }
  if (entry.scope) {
    lines.push(`scope: "${entry.scope}"`);
  }
  if (entry.abstract) {
    lines.push(`abstract: "${entry.abstract.replace(/"/g, '\\"')}"`);
  }
  if (entry.summary) {
    lines.push(`summary: "${entry.summary.replace(/"/g, '\\"')}"`);
  }
  if (entry.sourceType) {
    lines.push(`sourceType: "${entry.sourceType}"`);
  }
  if (entry.stage && entry.stage !== "memory") {
    lines.push(`stage: "${entry.stage}"`);
  }
  if (entry.expiresAt) {
    lines.push(`expiresAt: "${entry.expiresAt}"`);
  }
  if (entry.archived) {
    lines.push(`archived: true`);
  }
  if (entry.aliases?.length) {
    lines.push(`aliases: [${entry.aliases.map((t) => `"${t.replace(/"/g, '\\"')}"`).join(", ")}]`);
  }
  lines.push("---");
  lines.push("");
  lines.push(entry.content);
  lines.push("");
  return lines.join("\n");
}

export function parseMemoryFile(raw: string): MemoryEntry | null {
  const normalized = raw.replace(/\r\n/g, "\n");
  const fmMatch = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return null;

  const frontmatter = fmMatch[1]!;
  const body = fmMatch[2]!.trim();

  const idMatch = frontmatter.match(/^id:\s*"(.+)"$/m);
  const titleMatch = frontmatter.match(/^title:\s*"([\s\S]*?)"$/m);
  const categoryMatch = frontmatter.match(/^category:\s*"(.+)"$/m);
  const createdMatch = frontmatter.match(/^created:\s*"(.+)"$/m);
  const tagsMatch = frontmatter.match(/^tags:\s*\[(.+)\]$/m);
  const importanceMatch = frontmatter.match(/^importance:\s*(.+)$/m);
  const confidenceMatch = frontmatter.match(/^confidence:\s*(.+)$/m);
  const scopeMatch = frontmatter.match(/^scope:\s*"(.+)"$/m);
  const abstractMatch = frontmatter.match(/^abstract:\s*"([\s\S]*?)"$/m);
  const summaryMatch = frontmatter.match(/^summary:\s*"([\s\S]*?)"$/m);
  const sourceTypeMatch = frontmatter.match(/^sourceType:\s*"(.+)"$/m);
  const stageMatch = frontmatter.match(/^stage:\s*"(.+)"$/m);
  const expiresAtMatch = frontmatter.match(/^expiresAt:\s*"(.+)"$/m);
  const archivedMatch = frontmatter.match(/^archived:\s*(true|false)$/m);
  const aliasesMatch = frontmatter.match(/^aliases:\s*\[(.+)\]$/m);

  if (!idMatch || !createdMatch) return null;

  const tags = tagsMatch
    ? tagsMatch[1]!
        .split(",")
        .map((t) => t.trim().replace(/^"|"$/g, ""))
        .filter(Boolean)
    : undefined;

  const importance = importanceMatch ? parseFloat(importanceMatch[1]) : undefined;
  const confidence = confidenceMatch ? parseFloat(confidenceMatch[1]) : undefined;
  const aliases = aliasesMatch
    ? aliasesMatch[1]!
        .split(",")
        .map((t) => t.trim().replace(/^"|"$/g, ""))
        .filter(Boolean)
    : undefined;

  return {
    id: idMatch[1]!,
    content: body,
    ...(titleMatch?.[1] ? { title: titleMatch[1].replace(/\\"/g, '"') } : {}),
    ...(categoryMatch?.[1] ? { category: categoryMatch[1] } : {}),
    ...(tags ? { tags } : {}),
    created: createdMatch[1]!,
    ...(importance !== undefined && !isNaN(importance) ? { importance } : {}),
    ...(confidence !== undefined && !isNaN(confidence) ? { confidence } : {}),
    ...(scopeMatch?.[1] ? { scope: scopeMatch[1] } : {}),
    ...(abstractMatch?.[1] ? { abstract: abstractMatch[1].replace(/\\"/g, '"') } : {}),
    ...(summaryMatch?.[1] ? { summary: summaryMatch[1].replace(/\\"/g, '"') } : {}),
    ...(sourceTypeMatch?.[1] ? { sourceType: sourceTypeMatch[1] } : {}),
    ...(stageMatch?.[1] === "observation" ? { stage: "observation" as const } : {}),
    ...(expiresAtMatch?.[1] ? { expiresAt: expiresAtMatch[1] } : {}),
    ...(archivedMatch?.[1] === "true" ? { archived: true } : {}),
    ...(aliases ? { aliases } : {}),
  };
}

export type RecalledMemory = {
  id: string;
  content: string;
  category?: string;
  score?: number;
};

export function formatRecalledMemories(entries: RecalledMemory[]): string {
  if (!entries.length) return "";

  const lines = ["<recalled-memories>"];
  for (const entry of entries) {
    const meta = [entry.category, entry.score != null ? `score=${entry.score.toFixed(2)}` : ""]
      .filter(Boolean)
      .join(" ");
    lines.push(`[${entry.id}]${meta ? ` (${meta})` : ""}`);
    lines.push(entry.content);
    lines.push("");
  }
  lines.push("</recalled-memories>");
  return lines.join("\n");
}

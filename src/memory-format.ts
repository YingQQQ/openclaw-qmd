export type MemoryEntry = {
  id: string;
  content: string;
  category?: string;
  tags?: string[];
  created: string;
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
  const ts = now.toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "");
  const slug = slugify(title ?? content.slice(0, 60));
  return `${ts}_${slug}`;
}

export function formatMemoryFile(entry: MemoryEntry): string {
  const lines: string[] = ["---"];
  lines.push(`id: "${entry.id}"`);
  if (entry.category) {
    lines.push(`category: "${entry.category}"`);
  }
  if (entry.tags?.length) {
    lines.push(`tags: [${entry.tags.map((t) => `"${t}"`).join(", ")}]`);
  }
  lines.push(`created: "${entry.created}"`);
  lines.push("---");
  lines.push("");
  lines.push(entry.content);
  lines.push("");
  return lines.join("\n");
}

export function parseMemoryFile(raw: string): MemoryEntry | null {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return null;

  const frontmatter = fmMatch[1]!;
  const body = fmMatch[2]!.trim();

  const idMatch = frontmatter.match(/^id:\s*"(.+)"$/m);
  const categoryMatch = frontmatter.match(/^category:\s*"(.+)"$/m);
  const createdMatch = frontmatter.match(/^created:\s*"(.+)"$/m);
  const tagsMatch = frontmatter.match(/^tags:\s*\[(.+)\]$/m);

  if (!idMatch || !createdMatch) return null;

  const tags = tagsMatch
    ? tagsMatch[1]!
        .split(",")
        .map((t) => t.trim().replace(/^"|"$/g, ""))
        .filter(Boolean)
    : undefined;

  return {
    id: idMatch[1]!,
    content: body,
    category: categoryMatch?.[1],
    tags,
    created: createdMatch[1]!,
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

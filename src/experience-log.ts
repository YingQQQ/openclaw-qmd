import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export type MistakeRecord = {
  timestamp: string;
  description: string;
  resolution?: string;
};

export type InsightRecord = {
  timestamp: string;
  category: string;
  content: string;
};

const ERROR_KEYWORDS =
  /\b(?:error|failed|failure|bug|exception|crash|错误|失败|异常)\b/i;
const FIX_KEYWORDS =
  /\b(?:fixed|resolved|solved|works now|working now|修复|解决|搞定)\b/i;

function getRole(msg: unknown): string | undefined {
  if (typeof msg === "object" && msg !== null && "role" in msg) {
    return (msg as { role: string }).role;
  }
  return undefined;
}

function getContent(msg: unknown): string {
  if (typeof msg === "object" && msg !== null && "content" in msg) {
    const c = (msg as { content: unknown }).content;
    if (typeof c === "string") return c;
  }
  return "";
}

export function extractCorrections(messages: unknown[]): MistakeRecord[] {
  const records: MistakeRecord[] = [];
  const assistantMessages: { index: number; content: string }[] = [];

  for (let i = 0; i < messages.length; i++) {
    if (getRole(messages[i]) === "assistant") {
      const content = getContent(messages[i]);
      if (content) {
        assistantMessages.push({ index: i, content });
      }
    }
  }

  const usedFixIndices = new Set<number>();

  for (let i = 0; i < assistantMessages.length; i++) {
    if (!ERROR_KEYWORDS.test(assistantMessages[i].content)) continue;

    for (let j = i + 1; j < assistantMessages.length; j++) {
      if (usedFixIndices.has(j)) continue;
      if (FIX_KEYWORDS.test(assistantMessages[j].content)) {
        usedFixIndices.add(j);
        records.push({
          timestamp: new Date().toISOString(),
          description: assistantMessages[i].content.slice(0, 300),
          resolution: assistantMessages[j].content.slice(0, 300),
        });
        break;
      }
    }
  }

  return records;
}

const MAX_FILE_ENTRIES = 200;

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function escapeSeparator(text: string): string {
  return text.replace(/^---$/gm, "\\---");
}

function trimFileEntries(filePath: string, maxEntries: number): void {
  if (!existsSync(filePath)) return;
  const text = readFileSync(filePath, "utf-8");
  const blocks = text.split(/^---$/m).filter((b) => b.trim());
  if (blocks.length <= maxEntries) return;
  const kept = blocks.slice(-maxEntries);
  writeFileSync(filePath, kept.join("\n---\n") + "\n---\n\n", "utf-8");
}

export function recordInsight(
  learningsDir: string,
  record: InsightRecord,
): void {
  ensureDir(learningsDir);
  const filePath = path.join(learningsDir, "LEARNINGS.md");

  const entry = `## [${record.timestamp}] ${record.category}\n${escapeSeparator(record.content)}\n---\n\n`;

  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, "utf-8");
    writeFileSync(filePath, existing + entry, "utf-8");
  } else {
    writeFileSync(filePath, entry, "utf-8");
  }
  trimFileEntries(filePath, MAX_FILE_ENTRIES);
}

export function recordMistake(
  learningsDir: string,
  record: MistakeRecord,
): void {
  ensureDir(learningsDir);
  const filePath = path.join(learningsDir, "ERRORS.md");

  const resolutionLine = record.resolution
    ? `**Resolution:** ${escapeSeparator(record.resolution)}`
    : "**Resolution:** (none)";
  const entry = `## [${record.timestamp}]\n**Error:** ${escapeSeparator(record.description)}\n${resolutionLine}\n---\n\n`;

  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, "utf-8");
    writeFileSync(filePath, existing + entry, "utf-8");
  } else {
    writeFileSync(filePath, entry, "utf-8");
  }
  trimFileEntries(filePath, MAX_FILE_ENTRIES);
}

export function loadInsights(learningsDir: string): InsightRecord[] {
  const filePath = path.join(learningsDir, "LEARNINGS.md");
  if (!existsSync(filePath)) return [];

  const text = readFileSync(filePath, "utf-8").replace(/\r\n/g, "\n");
  const records: InsightRecord[] = [];

  const blocks = text.split(/^---$/m).filter((b) => b.trim());

  for (const block of blocks) {
    const headerMatch = block.match(
      /##\s+\[([^\]]+)\]\s+(\S+)/,
    );
    if (!headerMatch) continue;

    const timestamp = headerMatch[1];
    const category = headerMatch[2];
    const contentStart = block.indexOf("\n", block.indexOf(headerMatch[0]));
    const content =
      contentStart >= 0 ? block.slice(contentStart + 1).trim() : "";

    records.push({ timestamp, category, content });
  }

  return records;
}

export function loadMistakes(learningsDir: string): MistakeRecord[] {
  const filePath = path.join(learningsDir, "ERRORS.md");
  if (!existsSync(filePath)) return [];

  const text = readFileSync(filePath, "utf-8").replace(/\r\n/g, "\n");
  const records: MistakeRecord[] = [];

  const blocks = text.split(/^---$/m).filter((b) => b.trim());

  for (const block of blocks) {
    const tsMatch = block.match(/##\s+\[([^\]]+)\]/);
    if (!tsMatch) continue;

    const timestamp = tsMatch[1];

    const descMatch = block.match(/\*\*Error:\*\*\s*(.+)/);
    const description = descMatch ? descMatch[1].trim() : "";

    const resMatch = block.match(/\*\*Resolution:\*\*\s*(.+)/);
    const resolution = resMatch ? resMatch[1].trim() : undefined;

    records.push({
      timestamp,
      description,
      resolution: resolution === "(none)" ? undefined : resolution,
    });
  }

  return records;
}

export function formatInsightsContext(
  records: InsightRecord[],
  maxRecords = 10,
): string {
  const recent = records.slice(-maxRecords);

  if (recent.length === 0) {
    return "<agent-learnings>\n</agent-learnings>";
  }

  const lines = recent.map((r) => `- [${r.category}] ${r.content}`);
  return `<agent-learnings>\n${lines.join("\n")}\n</agent-learnings>`;
}

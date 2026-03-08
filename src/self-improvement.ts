/**
 * Self-improvement: maintain agent error records and learning files.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export type ErrorRecord = {
  timestamp: string;
  description: string;
  resolution?: string;
};

export type LearningRecord = {
  timestamp: string;
  category: string; // "error_fix" | "pattern" | "optimization"
  content: string;
};

// ---------------------------------------------------------------------------
// Error/fix pattern detection
// ---------------------------------------------------------------------------

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

/**
 * Detect error -> fix patterns in a conversation.
 * Scans assistant messages for error keywords, then looks for subsequent
 * fix keywords in later assistant messages.
 */
export function detectErrorFixPattern(messages: unknown[]): ErrorRecord[] {
  const records: ErrorRecord[] = [];
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

    // Look for a fix in subsequent messages
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

// ---------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------

const MAX_FILE_ENTRIES = 200;

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Trim a "---"-separated file to keep only the most recent entries.
 */
function trimFileEntries(filePath: string, maxEntries: number): void {
  if (!existsSync(filePath)) return;
  const text = readFileSync(filePath, "utf-8");
  const blocks = text.split(/^---$/m).filter((b) => b.trim());
  if (blocks.length <= maxEntries) return;
  const kept = blocks.slice(-maxEntries);
  writeFileSync(filePath, kept.join("\n---\n") + "\n---\n\n", "utf-8");
}

/**
 * Append a learning record to LEARNINGS.md.
 *
 * Format:
 * ## [timestamp] category
 * content
 * ---
 */
export function appendLearning(
  learningsDir: string,
  record: LearningRecord,
): void {
  ensureDir(learningsDir);
  const filePath = path.join(learningsDir, "LEARNINGS.md");

  const entry = `## [${record.timestamp}] ${record.category}\n${record.content}\n---\n\n`;

  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, "utf-8");
    writeFileSync(filePath, existing + entry, "utf-8");
  } else {
    writeFileSync(filePath, entry, "utf-8");
  }
  trimFileEntries(filePath, MAX_FILE_ENTRIES);
}

/**
 * Append an error record to ERRORS.md.
 *
 * Format:
 * ## [timestamp]
 * **Error:** description
 * **Resolution:** resolution
 * ---
 */
export function appendError(
  learningsDir: string,
  record: ErrorRecord,
): void {
  ensureDir(learningsDir);
  const filePath = path.join(learningsDir, "ERRORS.md");

  const resolutionLine = record.resolution
    ? `**Resolution:** ${record.resolution}`
    : "**Resolution:** (none)";
  const entry = `## [${record.timestamp}]\n**Error:** ${record.description}\n${resolutionLine}\n---\n\n`;

  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, "utf-8");
    writeFileSync(filePath, existing + entry, "utf-8");
  } else {
    writeFileSync(filePath, entry, "utf-8");
  }
  trimFileEntries(filePath, MAX_FILE_ENTRIES);
}

/**
 * Parse LEARNINGS.md and return structured records.
 */
export function readLearnings(learningsDir: string): LearningRecord[] {
  const filePath = path.join(learningsDir, "LEARNINGS.md");
  if (!existsSync(filePath)) return [];

  const text = readFileSync(filePath, "utf-8").replace(/\r\n/g, "\n");
  const records: LearningRecord[] = [];

  // Split on "---" separators
  const blocks = text.split(/^---$/m).filter((b) => b.trim());

  for (const block of blocks) {
    const headerMatch = block.match(
      /##\s+\[([^\]]+)\]\s+(\S+)/,
    );
    if (!headerMatch) continue;

    const timestamp = headerMatch[1];
    const category = headerMatch[2];
    // Content is everything after the header line
    const contentStart = block.indexOf("\n", block.indexOf(headerMatch[0]));
    const content =
      contentStart >= 0 ? block.slice(contentStart + 1).trim() : "";

    records.push({ timestamp, category, content });
  }

  return records;
}

/**
 * Parse ERRORS.md and return structured records.
 */
export function readErrors(learningsDir: string): ErrorRecord[] {
  const filePath = path.join(learningsDir, "ERRORS.md");
  if (!existsSync(filePath)) return [];

  const text = readFileSync(filePath, "utf-8").replace(/\r\n/g, "\n");
  const records: ErrorRecord[] = [];

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

/**
 * Format learning records as context injection text.
 *
 * Output:
 * <agent-learnings>
 * - [category] content
 * </agent-learnings>
 */
export function formatLearningsContext(
  records: LearningRecord[],
  maxRecords = 10,
): string {
  const recent = records.slice(-maxRecords);

  if (recent.length === 0) {
    return "<agent-learnings>\n</agent-learnings>";
  }

  const lines = recent.map((r) => `- [${r.category}] ${r.content}`);
  return `<agent-learnings>\n${lines.join("\n")}\n</agent-learnings>`;
}

import type { MemoryStore, RecalledMemory } from "./memory-store.js";
import { shouldSkipRetrieval, shouldForceRetrieve } from "./adaptive-retrieval.js";
import { isNoise, filterNoise } from "./noise-filter.js";
import { postProcess, type ScoredResult } from "./post-process.js";
import { formatLayeredContext, type LayeredMemory } from "./layered-context.js";
import { createSessionTracker, quickHash, type SessionTracker } from "./session-tracker.js";
import { extractReflections } from "./memory-reflection.js";
import { searchWithQueryVariants } from "./query-rewrite.js";
import { inferCategoryWeights } from "./query-intent.js";
import {
  detectErrorFixPattern,
  appendLearning,
  appendError,
  readLearnings,
  formatLearningsContext,
} from "./self-improvement.js";

export type RecallHookConfig = {
  autoRecallLimit: number;
  autoRecallMinScore: number;
  preconsciousLimit?: number;
  learningsDir?: string;
};

export type CaptureHookConfig = {
  captureMode?: "semantic" | "keyword";
  captureMaxLength?: number;
  learningsDir?: string;
};

// ---------------------------------------------------------------------------
// Prompt injection detection & content escaping
// ---------------------------------------------------------------------------

const PROMPT_INJECTION_PATTERNS = [
  /ignore\s+(all\s+|any\s+)?(previous|above|prior)?\s*instructions/i,
  /do not follow (the )?(system|developer)/i,
  /system\s+prompt/i,
  /developer\s+message/i,
  /<\s*(system|assistant|developer|tool|function|relevant-memories)\b/i,
  /\b(run|execute|call|invoke)\b.{0,40}\b(tool|command)\b/i,
  /<\|im_start\|>/i,
  /<\|im_end\|>/i,
  /<!--\s*(system|assistant|developer|instruction)/i,
  /\[INST\]/i,
  /\[\/INST\]/i,
];

const PROMPT_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function looksLikePromptInjection(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  return PROMPT_INJECTION_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function escapeMemoryForPrompt(text: string): string {
  return text.replace(/[&<>"']/g, (char) => PROMPT_ESCAPE_MAP[char] ?? char);
}

function shouldIncludeArchivedRecall(query: string): boolean {
  return /\b(history|historical|old|legacy|previously|earlier|before)\b/i.test(query)
    || /之前|以前|历史|旧的|早先|曾经/.test(query);
}

// ---------------------------------------------------------------------------
// Auto-recall hook (before_prompt_build)
// ---------------------------------------------------------------------------

function toLayeredMemories(results: RecalledMemory[]): LayeredMemory[] {
  return results.map((r) => ({
    id: r.id,
    content: escapeMemoryForPrompt(r.content),
    abstract: r.abstract ? escapeMemoryForPrompt(r.abstract) : undefined,
    summary: r.summary ? escapeMemoryForPrompt(r.summary) : undefined,
    category: r.category,
    score: r.score,
  }));
}

function toScoredResults(results: RecalledMemory[]): ScoredResult[] {
  return results.map((r) => ({
    id: r.id,
    content: r.content,
    category: r.category,
    score: r.score,
    created: r.created,
    accessCount: r.accessCount,
    lastAccessedAt: r.lastAccessedAt,
    importance: r.importance,
    confidence: r.confidence,
    sourceType: r.sourceType,
    expiresAt: r.expiresAt,
  }));
}

export function createRecallHook(store: MemoryStore, config: RecallHookConfig) {
  const session = createSessionTracker();

  return async (event: { prompt: string }): Promise<{ prependContext?: string } | void> => {
    const query = event.prompt?.trim();
    if (!query) return;

    const recovered = await store.recoverPendingSession();
    if (recovered > 0) {
      await store.compact();
    }

    // 自适应检索：跳过无意义查询（除非强制触发）
    if (!shouldForceRetrieve(query) && shouldSkipRetrieval(query)) return;

    const preconscious = await store.buildPreconscious(config.preconsciousLimit ?? 3);
    const includeArchived = shouldIncludeArchivedRecall(query);
    const searchFn = includeArchived ? store.searchWithArchived : store.search;
    const candidateLimit = includeArchived ? Math.max(config.autoRecallLimit * 3, 12) : config.autoRecallLimit * 2;
    const { results: rawResults } = await searchWithQueryVariants(
      searchFn,
      query,
      candidateLimit,
      config.autoRecallMinScore,
    );
    if (!rawResults.length && preconscious.length === 0) return;

    // 过滤已召回的记忆
    const unseenResults = session.filterRecalled(rawResults);
    if (!unseenResults.length && preconscious.length === 0) return;

    // 后处理管道
    const processed = postProcess(toScoredResults(unseenResults), {
      minScore: config.autoRecallMinScore,
      categoryWeights: inferCategoryWeights(query),
    });

    // 取 top N
    const topResults = processed.slice(0, config.autoRecallLimit);
    if (!topResults.length && preconscious.length === 0) return;

    // 重建 RecalledMemory（保留 abstract/summary）
    const recalledMap = new Map(unseenResults.map((r) => [r.id, r]));
    const finalResults: RecalledMemory[] = topResults
      .map((p) => {
        const orig = recalledMap.get(p.id);
        if (!orig) return null;
        return { ...orig, score: p.score };
      })
      .filter((r): r is RecalledMemory => r !== null);

    // 标记已召回
    for (const r of finalResults) {
      session.markRecalled(r.id);
    }
    await store.recordAccess(finalResults.map((item) => item.id));

    // L0/L1/L2 分层格式化
    const context = finalResults.length > 0 ? formatLayeredContext(toLayeredMemories(finalResults)) : "";
    const preconsciousBlock = preconscious.length > 0
      ? [
          "<preconscious-memory>",
          "Recent high-importance memories that may matter for the current turn:",
          ...preconscious.map((item) => `- [${item.category ?? "memory"}] ${escapeMemoryForPrompt(item.abstract ?? item.summary ?? item.content.slice(0, 180))}`),
          "</preconscious-memory>",
        ].join("\n")
      : "";

    if (!context && !preconsciousBlock) return;

    const parts: string[] = [];
    if (preconsciousBlock) parts.push(preconsciousBlock);
    if (context) parts.push(context);

    // 注入 agent learnings
    if (config.learningsDir) {
      const learnings = readLearnings(config.learningsDir);
      if (learnings.length > 0) {
        parts.push(formatLearningsContext(learnings, 5));
      }
    }

    return { prependContext: parts.join("\n\n") };
  };
}

// ---------------------------------------------------------------------------
// Auto-capture hook (agent_end)
// ---------------------------------------------------------------------------

const MEMORY_TRIGGERS = [
  /remember|zapamatuj/i,
  /prefer|radši|nechci/i,
  /i (like|prefer|hate|love|want|need)/i,
  /always|never|important/i,
  /my\s+\w+\s+is|is\s+my/i,
  /decided|will use|going to/i,
  /[\w.-]+@[\w.-]+\.\w+/,
  /\+\d{10,}/,
];

const DEFAULT_CAPTURE_MAX_CHARS = 500;

export function shouldCapture(
  text: string,
  mode: "semantic" | "keyword" = "keyword",
  maxChars = DEFAULT_CAPTURE_MAX_CHARS,
): boolean {
  if (text.length < 10 || text.length > maxChars) return false;
  if (text.includes("<relevant-memories>")) return false;
  if (text.includes("<recalled-memories>")) return false;
  if (text.startsWith("<") && text.includes("</")) return false;
  if (text.includes("**") && text.includes("\n-")) return false;
  const emojiCount = (text.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length;
  if (emojiCount > 3) return false;
  if (looksLikePromptInjection(text)) return false;
  if (isNoise(text)) return false;

  if (mode === "semantic") return true;
  return MEMORY_TRIGGERS.some((r) => r.test(text));
}

export function detectCategory(text: string): string {
  const lower = text.toLowerCase();
  if (/(?:我(?:是|叫|的名字)|my name is|i am a|i work)/i.test(lower)) return "profile";
  if (/prefer|like|love|hate|want|喜欢|偏好|习惯/i.test(lower)) return "preference";
  if (/decided|will use|going to|选择|决定|采用/i.test(lower)) return "event";
  if (/\+\d{10,}|@[\w.-]+\.\w+|is called/i.test(lower)) return "entity";
  if (/(?:bug|error|issue|fix|solved|错误|修复|解决)/i.test(lower)) return "case";
  if (/always|never|must|一定|永远|必须/i.test(lower)) return "pattern";
  if (/is|are|has|have/i.test(lower)) return "entity";
  return "entity";
}

export function createCaptureHook(store: MemoryStore, config?: CaptureHookConfig) {
  const captureMode = config?.captureMode ?? "keyword";
  const captureMaxLength = config?.captureMaxLength ?? DEFAULT_CAPTURE_MAX_CHARS;
  const session = createSessionTracker();

  return async (event: { messages: unknown[]; success: boolean }): Promise<void> => {
    if (!event.success) return;

    const texts = extractUserTexts(event.messages);

    // 噪声过滤
    const cleaned = filterNoise(texts);

    const toCapture = cleaned.filter((t) => shouldCapture(t, captureMode, captureMaxLength));
    if (!toCapture.length) return;

    await store.persistPendingSession({
      storedAt: new Date().toISOString(),
      entries: toCapture.slice(0, 5).map((content) => ({
        content,
        category: detectCategory(content),
        confidence: captureMode === "semantic" ? 0.6 : 0.7,
        importance: /always|never|important|must|prefer|decided/i.test(content) ? 0.75 : 0.55,
      })),
    });

    let stored = 0;
    let reflectionStored = 0;
    for (const text of toCapture.slice(0, 5)) {
      // 会话内去重
      const hash = quickHash(text);
      if (session.wasCaptured(hash)) continue;

      // 数据库去重
      const existing = await store.search(text, 1, 0.9);
      if (existing.length > 0) {
        session.markCaptured(hash);
        continue;
      }

      const category = detectCategory(text);
      await store.writeObservation(text, category, undefined, undefined, {
        confidence: captureMode === "semantic" ? 0.6 : 0.7,
        importance: /always|never|important|must|prefer|decided/i.test(text) ? 0.75 : 0.55,
        sourceType: "capture",
      });
      session.markCaptured(hash);
      stored++;
    }

    // 会话反思
    if (event.messages.length >= 10) {
      const reflections = extractReflections(event.messages);
      for (const entry of reflections.entries.slice(0, 3)) {
        const cat = entry.type === "user_model" ? "preference" : entry.type === "lesson" ? "case" : "pattern";
        await store.writeObservation(entry.content, cat, undefined, undefined, {
          confidence: entry.confidence,
          importance: entry.type === "lesson" ? 0.85 : 0.7,
          sourceType: "reflection",
        });
        reflectionStored++;
      }
    }

    // 自我改进：错误记录
    if (config?.learningsDir) {
      const errors = detectErrorFixPattern(event.messages);
      for (const err of errors) {
        appendError(config.learningsDir, err);
        appendLearning(config.learningsDir, {
          timestamp: err.timestamp,
          category: "error_fix",
          content: `${err.description} → ${err.resolution ?? "unknown fix"}`,
        });
      }
    }

    if (stored > 0 || reflectionStored > 0) {
      await store.compact();
      await store.reindex();
    }
    await store.clearPendingSession();
  };
}

function extractUserTexts(messages: unknown[]): string[] {
  const texts: string[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const msgObj = msg as Record<string, unknown>;

    if (msgObj.role !== "user") continue;

    const content = msgObj.content;
    if (typeof content === "string") {
      texts.push(content);
      continue;
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (
          block &&
          typeof block === "object" &&
          "type" in block &&
          (block as Record<string, unknown>).type === "text" &&
          "text" in block &&
          typeof (block as Record<string, unknown>).text === "string"
        ) {
          texts.push((block as Record<string, unknown>).text as string);
        }
      }
    }
  }
  return texts;
}

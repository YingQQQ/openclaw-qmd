import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import plugin from "../index.js";

type RegisteredTool = {
  name: string;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    details?: unknown;
    isError?: boolean;
  }>;
};

type LocomoQa = {
  question: string;
  answer: string;
  evidence: string[];
  category: number;
};

type ObservationMap = Record<string, Array<[string, string]>>;

type ConversationTurn = {
  speaker: string;
  dia_id: string;
  text: string;
};

type LocomoSample = {
  sample_id: string;
  qa: LocomoQa[];
  conversation: Record<string, string | ConversationTurn[]>;
  event_summary?: Record<string, Record<string, string[] | string>>;
  observation: Record<string, ObservationMap>;
  session_summary?: Record<string, string>;
};

type EvalRow = {
  sampleId: string;
  question: string;
  answer: string;
  evidence: string[];
  queryVariants: string[];
  retrievedEvidence: string[];
  hit: boolean;
  reciprocalRank: number;
  topResult?: {
    id: string;
    score?: number;
    summary?: string;
  };
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

function getArg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function getNumberArg(name: string, fallback: number): number {
  const raw = getArg(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function registerPluginAsync(pluginConfig: Record<string, unknown>) {
  const tools = new Map<string, RegisteredTool>();
  const hooks = new Map<string, Function>();

  let resolveReady: (() => void) | null = null;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  await (plugin as any).register({
    pluginConfig,
    logger: console,
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
      if (tools.has("memory_write") && tools.has("memory_search")) {
        resolveReady?.();
      }
    },
    on(event: string, handler: Function) {
      hooks.set(event, handler);
    },
  });

  await Promise.race([
    ready,
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error("Plugin registration timed out")), 5000),
    ),
  ]);

  return { tools, hooks };
}

type ObservationFactRow = {
  speaker: string;
  sessionKey: string;
  fact: string;
  evidence: string[];
};

type SessionContext = {
  sessionKey: string;
  dateTime?: string;
  summary?: string;
  speakerEvents: string[];
  utteranceById: Map<string, string>;
  participants: string[];
};

function iterObservationFacts(sample: LocomoSample): ObservationFactRow[] {
  const rows: ObservationFactRow[] = [];

  for (const [sessionKey, bySpeaker] of Object.entries(sample.observation)) {
    for (const [speaker, facts] of Object.entries(bySpeaker)) {
      for (const [fact, evidence] of facts) {
        rows.push({
          speaker,
          sessionKey,
          fact,
          evidence: Array.isArray(evidence) ? evidence : [evidence],
        });
      }
    }
  }

  return rows;
}

function parseEvidence(evidence: string) {
  const match = /^D(\d+):(\d+)$/i.exec(evidence.trim());
  if (!match) return undefined;
  return {
    sessionNumber: Number(match[1]),
    turnNumber: Number(match[2]),
  };
}

function toSessionContext(sample: LocomoSample, sessionKey: string): SessionContext {
  const sessionNumber = /session_(\d+)_observation$/.exec(sessionKey)?.[1];
  const baseSessionKey = sessionNumber ? `session_${sessionNumber}` : sessionKey;
  const dateTimeKey = `${baseSessionKey}_date_time`;
  const summaryKey = `${baseSessionKey}_summary`;
  const eventsKey = `events_${baseSessionKey}`;
  const dateTime = typeof sample.conversation[dateTimeKey] === "string"
    ? sample.conversation[dateTimeKey]
    : undefined;
  const summary = typeof sample.session_summary?.[summaryKey] === "string"
    ? sample.session_summary[summaryKey]
    : undefined;
  const eventSummary = sample.event_summary?.[eventsKey];
  const participants = [
    sample.conversation.speaker_a,
    sample.conversation.speaker_b,
  ].filter((value): value is string => typeof value === "string");

  const speakerEvents = Object.entries(eventSummary ?? {})
    .flatMap(([name, items]) => {
      if (name === "date") return [];
      if (!Array.isArray(items)) return [];
      return items.map((item) => `${name}: ${item}`);
    });

  const turns = Array.isArray(sample.conversation[baseSessionKey])
    ? sample.conversation[baseSessionKey] as ConversationTurn[]
    : [];
  const utteranceById = new Map<string, string>();
  for (const turn of turns) {
    utteranceById.set(turn.dia_id, `${turn.speaker}: ${turn.text}`);
  }

  return {
    sessionKey: baseSessionKey,
    dateTime,
    summary,
    speakerEvents,
    utteranceById,
    participants,
  };
}

function buildMemoryContent(row: ObservationFactRow, context: SessionContext) {
  const primaryEvidence = row.evidence[0];
  const evidenceMeta = primaryEvidence ? parseEvidence(primaryEvidence) : undefined;
  const lines = [
    `Fact: ${row.fact}`,
    `Speaker: ${row.speaker}`,
    `Participants: ${context.participants.join(", ")}`,
    `Session: ${context.sessionKey}`,
    `Evidence: ${row.evidence.join(", ")}`,
  ];

  if (context.dateTime) {
    lines.push(`DateTime: ${context.dateTime}`);
  }
  if (evidenceMeta) {
    lines.push(`Turn: ${evidenceMeta.turnNumber}`);
  }

  const utterance = primaryEvidence ? context.utteranceById.get(primaryEvidence) : undefined;
  if (utterance) {
    lines.push(`Dialogue: ${utterance}`);
  }
  if (context.summary) {
    lines.push(`SessionSummary: ${context.summary}`);
  }
  if (context.speakerEvents.length > 0) {
    lines.push(`EventSummary: ${context.speakerEvents.join(" | ")}`);
  }

  return lines.join("\n");
}

function normalizeTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

function buildSearchQueries(question: string): string[] {
  const queries: string[] = [];
  const seen = new Set<string>();

  const push = (value: string) => {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    queries.push(normalized);
  };

  push(question);

  const keywords = normalizeTokens(question);
  if (keywords.length > 0) {
    push(keywords.join(" "));
  }

  if (/^\s*when\b/i.test(question) && keywords.length > 0) {
    push([...keywords, "date", "time"].join(" "));
    push([...keywords, "year", "month", "day"].join(" "));
  }

  return queries;
}

function rankForEvidence(evidence: string[], retrievedEvidence: string[]): number {
  for (let i = 0; i < retrievedEvidence.length; i++) {
    if (evidence.includes(retrievedEvidence[i]!)) return i + 1;
  }
  return 0;
}

async function main() {
  const datasetPath = getArg("dataset");
  if (!datasetPath) {
    throw new Error("Missing --dataset <path-to-locomo10.json>");
  }

  const sampleLimit = getNumberArg("samples", 1);
  const qaLimit = getNumberArg("qas", 20);
  const topK = getNumberArg("top-k", 5);
  const minScore = getNumberArg("min-score", 0);

  const dataset = JSON.parse(
    await import("node:fs/promises").then((fs) => fs.readFile(datasetPath, "utf8")),
  ) as LocomoSample[];

  const selectedSamples = dataset.slice(0, sampleLimit);
  const rows: EvalRow[] = [];

  for (const sample of selectedSamples) {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-qmd-locomo-"));
    const memoryDir = path.join(root, "memories");

    try {
      const { tools } = await registerPluginAsync({
        memoryDir,
        autoCapture: false,
        autoRecallLimit: topK,
        autoRecallMinScore: minScore,
      });

      const memoryWrite = tools.get("memory_write");
      const memorySearch = tools.get("memory_search");
      if (!memoryWrite || !memorySearch) {
        throw new Error("memory tools not registered");
      }

      const memoryIdToEvidence = new Map<string, string[]>();
      for (const row of iterObservationFacts(sample)) {
        const context = toSessionContext(sample, row.sessionKey);
        const primaryEvidence = row.evidence[0] ?? "unknown";
        const result = await memoryWrite.execute(`write-${row.evidence}`, {
          content: buildMemoryContent(row, context),
          category: "entity",
          title: `${row.speaker} ${primaryEvidence}`,
          tags: [
            row.speaker,
            context.sessionKey,
            ...row.evidence,
            ...context.participants,
          ],
        });
        if (result.isError) {
          throw new Error(`memory_write failed for ${primaryEvidence}: ${result.content[0]?.text ?? ""}`);
        }
        const details = result.details as { id: string } | undefined;
        if (!details?.id) {
          throw new Error(`memory_write returned no id for ${primaryEvidence}`);
        }
        memoryIdToEvidence.set(details.id, row.evidence);
      }

      for (const qa of sample.qa.slice(0, qaLimit)) {
        const queryVariants = buildSearchQueries(qa.question);
        const mergedDetails: Array<{
          id: string;
          score?: number;
          summary?: string;
          abstract?: string;
          content?: string;
        }> = [];
        const seenIds = new Set<string>();

        for (const [index, query] of queryVariants.entries()) {
          const result = await memorySearch.execute(`search-${sample.sample_id}-${index}`, {
            query,
            limit: topK,
            minScore,
          });
          if (result.isError) {
            throw new Error(`memory_search failed for question: ${qa.question}`);
          }

          const detailList = (
            result.details &&
            typeof result.details === "object" &&
            Array.isArray((result.details as { results?: unknown[] }).results)
          )
            ? (result.details as { results: Array<{
                id: string;
                score?: number;
                summary?: string;
                abstract?: string;
                content?: string;
              }> }).results
            : Array.isArray(result.details)
              ? result.details as Array<{
                  id: string;
                  score?: number;
                  summary?: string;
                  abstract?: string;
                  content?: string;
                }>
              : [];

          const details = detailList;

          for (const item of details) {
            if (seenIds.has(item.id)) continue;
            seenIds.add(item.id);
            mergedDetails.push(item);
            if (mergedDetails.length >= topK) break;
          }
          if (mergedDetails.length >= topK) break;
        }

        const retrievedEvidence = mergedDetails
          .flatMap((item) => memoryIdToEvidence.get(item.id) ?? [])
          .filter((value, index, arr) => arr.indexOf(value) === index);

        const rank = rankForEvidence(qa.evidence, retrievedEvidence);
        rows.push({
          sampleId: sample.sample_id,
          question: qa.question,
          answer: qa.answer,
          evidence: qa.evidence,
          queryVariants,
          retrievedEvidence,
          hit: rank > 0,
          reciprocalRank: rank > 0 ? 1 / rank : 0,
          topResult: mergedDetails[0]
            ? {
                id: mergedDetails[0].id,
                score: mergedDetails[0].score,
                summary: mergedDetails[0].summary ?? mergedDetails[0].abstract ?? mergedDetails[0].content,
              }
            : undefined,
        });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const total = rows.length;
  const hits = rows.filter((row) => row.hit).length;
  const mrr = total > 0 ? rows.reduce((sum, row) => sum + row.reciprocalRank, 0) / total : 0;

  const report = {
    datasetPath,
    sampleCount: selectedSamples.length,
    qaCount: total,
    topK,
    minScore,
    hitRate: total > 0 ? hits / total : 0,
    mrr,
    examples: rows.slice(0, 5),
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});

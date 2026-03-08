export type DigestEntry = {
  type: "decision" | "user_model" | "lesson" | "invariant";
  content: string;
  confidence: number; // 0-1
};

export type DigestResult = {
  entries: DigestEntry[];
  sessionLength: number; // message turns
};

const MIN_SESSION_LENGTH = 10;

const DECISION_PATTERNS = [
  /(?:decided|chosen|going with|will use|选择了?|决定了?|采用了?)\s+(.{10,120})/i,
  /(?:let's|we'll|we should|我们?(?:应该|要))\s+(.{10,120})/i,
];

const USER_MODEL_PATTERNS = [
  /(?:i prefer|i like|i want|i need|i always|我(?:喜欢|偏好|习惯|总是|需要))\s+(.{5,120})/i,
  /(?:don't|never|avoid|不要|别|避免)\s+(.{5,80})/i,
];

const LESSON_PATTERNS = [
  /(?:the (?:issue|problem|bug|error) was|(?:问题|错误|bug)(?:是|在于))\s+(.{10,200})/i,
  /(?:fixed by|solved by|(?:通过|靠).*(?:解决|修复))\s+(.{10,200})/i,
  /(?:turns out|it was because|原来是?|因为)\s+(.{10,200})/i,
];

const INVARIANT_PATTERNS = [
  /(?:always|never|must|should always|必须|一定要|永远不要)\s+(.{5,120})/i,
  /(?:remember to|don't forget|注意|记住)\s+(.{5,120})/i,
];

export function tokenOverlap(a: string, b: string): number {
  const tokenize = (s: string): Set<string> => {
    const tokens = new Set<string>();
    const parts = s.toLowerCase().match(/[\u4e00-\u9fff]|[^\s\u4e00-\u9fff]+/g);
    if (parts) {
      for (const p of parts) {
        tokens.add(p);
      }
    }
    return tokens;
  };

  const setA = tokenize(a);
  const setB = tokenize(b);

  if (setA.size === 0 && setB.size === 0) return 0;

  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }

  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

type PatternGroup = {
  type: DigestEntry["type"];
  patterns: RegExp[];
  role: "assistant" | "user";
};

const PATTERN_GROUPS: PatternGroup[] = [
  { type: "decision", patterns: DECISION_PATTERNS, role: "assistant" },
  { type: "user_model", patterns: USER_MODEL_PATTERNS, role: "user" },
  { type: "lesson", patterns: LESSON_PATTERNS, role: "assistant" },
  { type: "invariant", patterns: INVARIANT_PATTERNS, role: "assistant" },
];

function getMessageRole(msg: unknown): string | undefined {
  if (typeof msg === "object" && msg !== null && "role" in msg) {
    return (msg as { role: string }).role;
  }
  return undefined;
}

function getMessageContent(msg: unknown): string {
  if (typeof msg === "object" && msg !== null && "content" in msg) {
    const c = (msg as { content: unknown }).content;
    if (typeof c === "string") return c;
  }
  return "";
}

function deduplicate(entries: DigestEntry[]): DigestEntry[] {
  const result: DigestEntry[] = [];
  for (const entry of entries) {
    let dominated = false;
    for (let i = 0; i < result.length; i++) {
      if (result[i].type === entry.type) {
        const sim = tokenOverlap(result[i].content, entry.content);
        if (sim > 0.8) {
          if (entry.confidence > result[i].confidence) {
            result[i] = entry;
          }
          dominated = true;
          break;
        }
      }
    }
    if (!dominated) {
      result.push(entry);
    }
  }
  return result;
}

export function extractDigest(messages: unknown[]): DigestResult {
  const sessionLength = messages.length;

  if (sessionLength < MIN_SESSION_LENGTH) {
    return { entries: [], sessionLength };
  }

  const entries: DigestEntry[] = [];

  for (const msg of messages) {
    const role = getMessageRole(msg);
    const content = getMessageContent(msg);
    if (!content) continue;

    for (const group of PATTERN_GROUPS) {
      if (role !== group.role) continue;

      for (const pattern of group.patterns) {
        const match = content.match(pattern);
        if (match && match[1]) {
          const captured = match[1].trim();
          const isFullSentence = /[.!?\u3002\uff01\uff1f]$/.test(captured);
          const confidence = isFullSentence ? 0.8 : 0.6;
          entries.push({
            type: group.type,
            content: captured,
            confidence,
          });
        }
      }
    }
  }

  return {
    entries: deduplicate(entries),
    sessionLength,
  };
}

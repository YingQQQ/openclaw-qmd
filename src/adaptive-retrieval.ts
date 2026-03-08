const SKIP_PATTERNS: RegExp[] = [
  /^(hi|hello|hey|你好|嗨|哈喽|早|晚安|good\s*(morning|evening|night))[\s!！.。]*$/i,
  /^(ok|okay|yes|no|sure|got it|好的?|是的?|嗯|行|可以|没问题|收到|对|不是?|understood)[\s!！.。]*$/i,
  /^[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\s]+$/u,
  /^(ping|pong|heartbeat|health)$/i,
];

const FORCE_RETRIEVE_PATTERNS: RegExp[] = [
  /remember|recall|forgot|忘了|记得|记住/i,
  /之前|上次|以前|earlier|previously|last\s+time/i,
  /我(说过|提过|告诉过)|i\s+(said|told|mentioned)/i,
  /你还记得|do you remember/i,
];

const CJK_RANGE =
  /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF\u{20000}-\u{2A6DF}\u{2A700}-\u{2B73F}\u{2B740}-\u{2B81F}\u{2B820}-\u{2CEAF}\u{2CEB0}-\u{2EBEF}\u{30000}-\u{3134F}\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\uFF00-\uFFEF]/u;

function hasCJK(text: string): boolean {
  return CJK_RANGE.test(text);
}

export function shouldSkipRetrieval(query: string, minLength?: number): boolean {
  const trimmed = query.trim();
  if (trimmed.length === 0) return true;

  for (const pattern of SKIP_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }

  if (minLength !== undefined) {
    return trimmed.length < minLength;
  }

  const minLen = hasCJK(trimmed) ? 6 : 15;
  return trimmed.length < minLen;
}

export function shouldForceRetrieve(query: string): boolean {
  const trimmed = query.trim();
  for (const pattern of FORCE_RETRIEVE_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }
  return false;
}

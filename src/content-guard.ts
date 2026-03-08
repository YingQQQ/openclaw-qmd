const DENIAL_PATTERNS: RegExp[] = [
  /i('m| am) (sorry|unable|not able|afraid)/i,
  /i can('t|not\b| not\b)/i,
  /as an ai/i,
  /对不起|抱歉|我(无法|不能|做不到)/,
];

const META_QUESTION_PATTERNS: RegExp[] = [
  /你是谁|who are you/i,
  /你(能|可以)做什么|what can you do/i,
  /how (do|does) (this|it) work/i,
];

const BOILERPLATE_PATTERNS: RegExp[] = [
  /^(好的?|没问题|收到|understood|got it|sure|okay|ok)[\s!！.。]*$/i,
  /^(谢谢|thanks?|thank you)[\s!！.。]*$/i,
  /^(是的?|对|right|correct|exactly)[\s!！.。]*$/i,
];

export function isRefusal(text: string): boolean {
  const trimmed = text.trim();
  return DENIAL_PATTERNS.some((p) => p.test(trimmed));
}

export function isIntrospective(text: string): boolean {
  const trimmed = text.trim();
  return META_QUESTION_PATTERNS.some((p) => p.test(trimmed));
}

export function isGenericOutput(text: string): boolean {
  const trimmed = text.trim();
  return BOILERPLATE_PATTERNS.some((p) => p.test(trimmed));
}

export function isLowQuality(text: string): boolean {
  return isRefusal(text) || isIntrospective(text) || isGenericOutput(text);
}

export function filterLowQuality(texts: string[]): string[] {
  return texts.filter((t) => !isLowQuality(t));
}

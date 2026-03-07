/**
 * Noise filter: filter out low-value text before capture.
 */

const DENIAL_PATTERNS: RegExp[] = [
  /i('m| am) (sorry|unable|not able|afraid)/i,
  /i can('t|not| not)/i,
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

export function isDenial(text: string): boolean {
  const trimmed = text.trim();
  return DENIAL_PATTERNS.some((p) => p.test(trimmed));
}

export function isMetaQuestion(text: string): boolean {
  const trimmed = text.trim();
  return META_QUESTION_PATTERNS.some((p) => p.test(trimmed));
}

export function isBoilerplate(text: string): boolean {
  const trimmed = text.trim();
  return BOILERPLATE_PATTERNS.some((p) => p.test(trimmed));
}

/**
 * Returns true if the text matches any noise pattern
 * (denial, meta question, or boilerplate).
 */
export function isNoise(text: string): boolean {
  return isDenial(text) || isMetaQuestion(text) || isBoilerplate(text);
}

/**
 * Filters out noise texts, returning only meaningful content.
 */
export function filterNoise(texts: string[]): string[] {
  return texts.filter((t) => !isNoise(t));
}

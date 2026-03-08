export function inferCategoryWeights(query: string): Record<string, number> | undefined {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return undefined;

  const weights: Record<string, number> = {};

  if (/\bwhen\b|时间|什么时候|哪天|日期|date|time|year|month|day/i.test(normalized)) {
    weights.event = 1.35;
    weights.entity = 1.05;
  }

  if (/\b(who|identity|name|called)\b|是谁|身份|名字|叫做/i.test(normalized)) {
    weights.profile = Math.max(weights.profile ?? 1, 1.35);
    weights.entity = Math.max(weights.entity ?? 1, 1.2);
  }

  if (/\b(prefer|preference|like|love|hate|want)\b|偏好|喜欢|讨厌|想要/i.test(normalized)) {
    weights.preference = Math.max(weights.preference ?? 1, 1.35);
  }

  if (/\b(bug|error|issue|fix|broken|failed)\b|错误|异常|修复|问题/i.test(normalized)) {
    weights.case = Math.max(weights.case ?? 1, 1.35);
  }

  if (/\b(always|never|habit|routine|usually|often)\b|总是|从不|习惯|通常/i.test(normalized)) {
    weights.pattern = Math.max(weights.pattern ?? 1, 1.25);
  }

  return Object.keys(weights).length > 0 ? weights : undefined;
}

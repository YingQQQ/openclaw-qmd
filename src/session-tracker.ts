export type SessionTracker = {
  /** 记录已召回的记忆 id */
  markRecalled(id: string): void;
  /** 记录已捕获的文本 hash */
  markCaptured(textHash: string): void;
  /** 检查是否已召回 */
  wasRecalled(id: string): boolean;
  /** 检查是否已捕获 */
  wasCaptured(textHash: string): boolean;
  /** 获取已召回数量 */
  recalledCount(): number;
  /** 获取已捕获数量 */
  capturedCount(): number;
  /** 过滤掉已召回的结果 */
  filterRecalled<T extends { id: string }>(results: T[]): T[];
  /** 清理（会话结束时调用） */
  clear(): void;
};

/**
 * djb2 hash 算法，返回 hex 字符串。
 * 轻量级、确定性，不需要 crypto 模块。
 */
export function quickHash(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    // hash * 33 + charCode
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  // 转为无符号 32 位再输出 hex
  return (hash >>> 0).toString(16);
}

export function createSessionTracker(): SessionTracker {
  const recalledIds = new Set<string>();
  const capturedHashes = new Set<string>();

  return {
    markRecalled(id: string): void {
      recalledIds.add(id);
    },

    markCaptured(textHash: string): void {
      capturedHashes.add(textHash);
    },

    wasRecalled(id: string): boolean {
      return recalledIds.has(id);
    },

    wasCaptured(textHash: string): boolean {
      return capturedHashes.has(textHash);
    },

    recalledCount(): number {
      return recalledIds.size;
    },

    capturedCount(): number {
      return capturedHashes.size;
    },

    filterRecalled<T extends { id: string }>(results: T[]): T[] {
      return results.filter((r) => !recalledIds.has(r.id));
    },

    clear(): void {
      recalledIds.clear();
      capturedHashes.clear();
    },
  };
}

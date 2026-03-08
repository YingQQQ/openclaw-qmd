export type SessionTracker = {
  markRecalled(id: string): void;
  markCaptured(textHash: string): void;
  wasRecalled(id: string): boolean;
  wasCaptured(textHash: string): boolean;
  recalledCount(): number;
  capturedCount(): number;
  filterRecalled<T extends { id: string }>(results: T[]): T[];
  clear(): void;
};

export function quickHash(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
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

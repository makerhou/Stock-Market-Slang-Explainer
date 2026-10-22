/** DJB2 字符串哈希 → 32 位无符号整数（浏览器 / Node / Edge 通用，零依赖） */
export function hashStr(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h >>> 0;
}

/** 7 位 base36 短哈希 */
export function shortHash(s: string): string {
  return hashStr(s).toString(36).padStart(7, "0").slice(0, 7);
}

/**
 * 由题目不变部分派生稳定 id（与展示顺序无关）。
 * 这样 answer 路由无状态重建题池后，能用同一 id 找回该题的 answerKey。
 */
export function questionIdFromParts(p: {
  type: string;
  termId: string;
  senseId: string | null;
  stem: string;
  optionTexts: string[];
}): string {
  const sorted = [...p.optionTexts].sort().join("|");
  return "q_" + shortHash(`${p.type}::${p.termId}::${p.senseId ?? ""}::${p.stem}::${sorted}`);
}

export function fingerprintFromParts(...parts: string[]): string {
  return shortHash(parts.join("::"));
}

/** 随机 token：优先 crypto.randomUUID，降级到 Math.random（仅用于 requestId，不参与判分） */
export function randomToken(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return "r" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

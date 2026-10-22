import { hashStr } from "./id";

/**
 * 确定性 Fisher-Yates 洗牌（xorshift32 伪随机，seed 可复现）。
 * 同一 seed 得到同一顺序 —— 用于「同 seed 同题序」复现与测试。
 */
export function shuffle<T>(arr: readonly T[], seed: string): T[] {
  const a = arr.slice();
  let h = hashStr(seed) >>> 0;
  const rand = () => {
    h ^= h << 13;
    h >>>= 0;
    h ^= h >> 17;
    h ^= h << 5;
    h >>>= 0;
    return h / 0xffffffff;
  };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const left = a[i];
    const right = a[j];
    if (left === undefined || right === undefined) continue; // 不可达兜底
    a[i] = right;
    a[j] = left;
  }
  return a;
}

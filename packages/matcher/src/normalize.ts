/**
 * 同构归一化（架构 §1.2 行 140 / backend-implementation §3.2）。
 * 流程：NFKC 全半角 → 小写折叠 → 空白压缩 → 截断至 200 字符。
 * 额外提供 normalizeWithMap：返回归一化串 + 字符级 offset 映射，
 * 供 AC 自动机把「归一化坐标」反查回「原始输入坐标」（toRawSpan，§3.2⑨）。
 */

/** 输入归一化上限（架构硬约束，纯计算 <1ms） */
export const MAX_INPUT = 200;

export interface NormalizedQuery {
  raw: string;
  norm: string; // 小写、去空格、全角转半角
  pinyinAbbr?: string; // 拼音首字母（由作者在 front-matter 提供，零运行时转换）
}

export interface NormalizedWithMap {
  norm: string;
  /** map[i] = 原始 raw 串中第 i 个归一化字符对应的下标（用于坐标反查） */
  map: number[];
}

const WS = /\s/;

function isWhitespace(ch: string): boolean {
  // 普通空白 + 全角空格（U+3000 经 NFKC 已转半角，这里兜底）
  return WS.test(ch) || ch === "　" || ch === " ";
}

/**
 * 生成归一化串并记录 offset 映射。
 * 多字符 NFKC 展开（如 ﬁ → f,i）会把每个产物映射到同一 raw 下标；
 * 空白压缩把连续空白折叠为一个空格，映射到首个空白下标。
 */
export function normalizeWithMap(raw: string): NormalizedWithMap {
  const cps = Array.from(raw);
  let out = "";
  const map: number[] = [];
  let prevWs = false;

  for (let i = 0; i < cps.length && out.length < MAX_INPUT; i++) {
    const ch = cps[i];
    if (ch === undefined) continue;
    if (isWhitespace(ch)) {
      if (!prevWs && out.length < MAX_INPUT) {
        out += " ";
        map.push(i);
      }
      prevWs = true;
      continue;
    }
    prevWs = false;
    const n = ch.normalize("NFKC").toLowerCase();
    for (const nc of n) {
      if (out.length >= MAX_INPUT) break;
      out += nc;
      map.push(i);
    }
  }

  // 去掉首尾空格（同步裁剪 map）
  const trimmed = out.trim();
  const lead = out.length - out.trimStart().length;
  const trail = out.length - out.trimEnd().length;
  const finalMap = map.slice(lead, map.length - trail);
  // map 长度防御性对齐
  return { norm: trimmed, map: finalMap.slice(0, trimmed.length) };
}

/** 单词/短查询归一化（无 offset 映射需求时使用） */
export function normalize(raw: string): NormalizedQuery {
  const { norm } = normalizeWithMap(raw);
  return { raw, norm };
}

/** 中文边界判定（§3.2④）：不含标点，仅 CJK 统一表意文字 */
export function isCJK(ch: string | undefined): boolean {
  if (!ch) return false;
  return /[一-鿿㐀-䶿]/.test(ch);
}

/** 英文/数字边界判定（§3.2⑤） */
export function isWordChar(ch: string | undefined): boolean {
  if (!ch) return false;
  return /[A-Za-z0-9]/.test(ch);
}

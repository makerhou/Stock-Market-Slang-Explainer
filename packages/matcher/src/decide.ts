/**
 * 整句模式裁决层（backend-implementation §3.2 ①~⑨）。
 * 必须自写（架构结论）：AC 自动机只产出 span，重叠/词边界/等长冲突由本层裁决。
 * 每个函数可独立单测；resolveSentenceSpans 为编排入口。
 */
import { isCJK, isWordChar } from "./normalize";
import type { AcSpan } from "./aho-corasick";

export interface SpanCandidate {
  /** 归一化坐标 */
  normStart: number;
  normEnd: number;
  /** 原始输入坐标（已反查） */
  start: number;
  end: number;
  /** 命中的归一化别名串 */
  key: string;
  /** 映射到的词条 slug（resolveEqualLengthConflict 后填充） */
  slug?: string;
}

export type AliasToTerms = Map<string, { slug: string; popularity: number }[]>;

/** ⑨ 反查为原始输入坐标 */
export function toRawSpan(span: AcSpan, offsetMap: number[]): {
  start: number;
  end: number;
} {
  const start = offsetMap[span.start] ?? 0;
  const last = offsetMap[span.end - 1];
  const end = (last === undefined ? offsetMap[offsetMap.length - 1] ?? 0 : last) + 1;
  return { start, end };
}

/** ② 排序：(长度 desc, 起点 asc) */
export function sortSpans(spans: SpanCandidate[]): SpanCandidate[] {
  return [...spans].sort(
    (a, b) =>
      b.normEnd - b.normStart - (a.normEnd - a.normStart) ||
      a.normStart - b.normStart,
  );
}

/** ③ 贪心取最长；与已选重叠则丢弃较短的 */
export function greedyLongest(spans: SpanCandidate[]): SpanCandidate[] {
  const kept: SpanCandidate[] = [];
  for (const s of spans) {
    const overlap = kept.some(
      (k) => s.normStart < k.normEnd && s.normEnd > k.normStart,
    );
    if (!overlap) kept.push(s);
  }
  return kept;
}

/** ④ 中文边界检查：相邻字符若仍是 CJK → 丢弃（「市盈率」不应命中「市」） */
export function chineseBoundaryCheck(
  raw: string,
  spans: SpanCandidate[],
): SpanCandidate[] {
  return spans.filter((s) => {
    const left = raw[s.start - 1];
    const right = raw[s.end];
    return !isCJK(left) && !isCJK(right);
  });
}

/** ⑤ 英文边界检查：相邻字符若仍是 [A-Za-z0-9] → 丢弃（「PE」不应命中「OPEN」内部） */
export function englishBoundaryCheck(
  raw: string,
  spans: SpanCandidate[],
): SpanCandidate[] {
  return spans.filter((s) => {
    const left = raw[s.start - 1];
    const right = raw[s.end];
    return !isWordChar(left) && !isWordChar(right);
  });
}

/** ⑥ 等长冲突：同位置多个候选 → 取 popularity 高者；仍相同 → slug 字典序 */
export function resolveEqualLengthConflict(
  spans: SpanCandidate[],
  aliasToTerms: AliasToTerms,
): SpanCandidate[] {
  const groups = new Map<string, SpanCandidate[]>();
  for (const s of spans) {
    const g = `${s.normStart}:${s.normEnd}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(s);
  }
  const out: SpanCandidate[] = [];
  for (const [, group] of groups) {
    if (group.length === 1) {
      const only = group[0];
      if (only) out.push(only);
      continue;
    }
    // 同一位置多个不同 key → 选映射 term 最优者（取 group 首个的代表 key）
    let best = group[0];
    if (!best) continue;
    for (const s of group) {
      const a = aliasToTerms.get(best.key)?.[0];
      const b = aliasToTerms.get(s.key)?.[0];
      const pa = a?.popularity ?? 0;
      const pb = b?.popularity ?? 0;
      if (pb > pa || (pb === pa && (b?.slug ?? "") < (a?.slug ?? ""))) {
        best = s;
      }
    }
    out.push(best);
  }
  return out;
}

/** 编排：AC span → 原始坐标 → 排序 → 最长优先 → 边界检查 → 等长冲突消解 */
export function resolveSentenceSpans(
  raw: string,
  offsetMap: number[],
  acSpans: AcSpan[],
  aliasToTerms: AliasToTerms,
): SpanCandidate[] {
  const withRaw: SpanCandidate[] = acSpans.map((s) => {
    const { start, end } = toRawSpan(s, offsetMap);
    return {
      normStart: s.start,
      normEnd: s.end,
      start,
      end,
      key: s.key,
    };
  });
  const sorted = sortSpans(withRaw);
  const longest = greedyLongest(sorted);
  const cnOk = chineseBoundaryCheck(raw, longest);
  const enOk = englishBoundaryCheck(raw, cnOk);
  // ⑦ 映射 slug
  for (const s of enOk) {
    const terms = aliasToTerms.get(s.key);
    s.slug = terms?.[0]?.slug;
  }
  return resolveEqualLengthConflict(enOk, aliasToTerms);
}

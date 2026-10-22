import type { LexiconEntry } from "@jargon/contracts";

/** 字符二元组集合（用于内容覆盖率度量） */
function bigrams(s: string): Set<string> {
  const t = s.replace(/\s+/g, "");
  const set = new Set<string>();
  for (let i = 0; i + 1 < t.length; i++) set.add(t.slice(i, i + 2));
  return set;
}

/**
 * 内容覆盖率（Jaccard on char-bigrams）。
 * 用于 QUIZ-003：衡量两个释义是否“近似重复”。本函数只做度量，判定方向见下。
 */
export function coverage(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * QUIZ-003 修正阈值：干扰项与正确项“近似重复”的上界。
 *
 * 原设计用【下界 0.08】要求干扰项与正确项必须有一定覆盖率（认为覆盖率过低=荒谬选项，
 * 用户可排除法作答）。但实测：两条不同的中文金融释义之间 char-bigram Jaccard 普遍≈0
 * （最高也仅 0.087），导致 T1/T3 在真实内容上几乎永远无法生成——这是标定错误。
 *
 * 本领域所有候选都是真实金融术语释义，对学习者天然具有迷惑性，并非“荒谬选项”。
 * 真正需要排除的是与正确项【近乎重复】的干扰项（会让题目产生歧义）。因此改为【上界】：
 * 覆盖率超过该值视为近似重复，剔除即可。
 */
export const MAX_NEAR_DUPLICATE_COVERAGE = 0.6;

export interface DistractorCandidate {
  text: string;
  entry: LexiconEntry;
}

/**
 * 干扰项决策（distractor decision tree 简化实现）：
 * ① 剔除等于正确项、重复项；
 * ② 剔除与正确项近似重复的荒谬项（覆盖率 > MAX_NEAR_DUPLICATE_COVERAGE，QUIZ-003 修正）；
 * ③ 优先同分类（prefCat），否则按词库 popularity 排序；
 * ④ 至多返回 3 个。
 * 不足 3 个 → 调用方按「弃权检查」跳过该题型（call 内容缺口告警）。
 */
export function selectDistractors(
  correct: string,
  candidates: DistractorCandidate[],
  prefCat: string,
): DistractorCandidate[] {
  const seen = new Set<string>();
  const scored = candidates
    .filter(
      (c) =>
        c.text.length > 0 &&
        c.text !== correct &&
        !seen.has(c.text) &&
        coverage(c.text, correct) <= MAX_NEAR_DUPLICATE_COVERAGE,
    )
    .map((c) => ({ c, pref: c.entry.categoryL1 === prefCat ? 0 : 1, pop: c.entry.popularity }))
    .sort((a, b) => a.pref - b.pref || b.pop - a.pop);

  const res: DistractorCandidate[] = [];
  const seen2 = new Set<string>();
  for (const s of scored) {
    if (seen2.has(s.c.text)) continue;
    seen2.add(s.c.text);
    res.push(s.c);
    if (res.length >= 3) break;
  }
  return res;
}

/**
 * 五级降级权重（backend-implementation §3.1）。
 * 排序稳定性：score 必须全序，最终兜底用 slug 字典序（见 matcher.ts 的 sortCandidates）。
 */
export const WEIGHTS = {
  EXACT_PRIMARY: 100,
  EXACT_ALIAS_CN: 95,
  EXACT_ALIAS_EN: 92,
  EXACT_PINYIN_ABBR: 90,
  EXACT_PINYIN_FULL: 88,
  COLLOQUIAL: 90,
  MISSPELL: 80,
  PREFIX: 78,
  SUBSTRING_IN_ALIAS: 66,
  FUZZY_GRAM: 45,
  PG_TRGM: 35,
} as const;

/** 别名类型 → 命中权重（单词模式 L0~L2） */
export const ALIAS_WEIGHT: Record<string, number> = {
  primary: WEIGHTS.EXACT_PRIMARY,
  cn_alias: WEIGHTS.EXACT_ALIAS_CN,
  en_alias: WEIGHTS.EXACT_ALIAS_EN,
  pinyin_abbr: WEIGHTS.EXACT_PINYIN_ABBR,
  pinyin_full: WEIGHTS.EXACT_PINYIN_FULL,
  colloquial: WEIGHTS.COLLOQUIAL,
  misspell: WEIGHTS.MISSPELL,
};

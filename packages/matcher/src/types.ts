import type { CategoryL1, TermDifficulty } from "@jargon/contracts";

export type InputKind = "word" | "sentence";

export type MatchType = "exact" | "alias" | "pinyin" | "prefix" | "fuzzy";

/** 已消解义项的命中词条（供搜索结果/整句高亮展示） */
export interface MatchedTerm {
  slug: string;
  headword: string;
  categoryL1: CategoryL1;
  categoryL2: string;
  difficulty: TermDifficulty;
  plainExplain: string; // 已消歧的展示释义
  riskNote?: string;
  senseKey: string;
  isLowConfidence: boolean;
  alternatives?: { senseKey: string; plainExplain: string }[];
  matchType: MatchType;
  level: number; // 0..3.5
}

/** 整句高亮 span（原始输入坐标） */
export interface SentenceSpan {
  start: number;
  end: number;
  raw: string;
  slug: string;
  senseKey: string;
  isLowConfidence: boolean;
}

export interface Suggestion {
  slug: string;
  headword: string;
  source: "edit_distance" | "same_category" | "popular";
  reason: string;
}

export interface SearchResponse {
  matched: MatchedTerm[];
  miss: boolean;
  inputKind: InputKind;
  level: number;
  suggestions: Suggestion[];
  indexChecksum: string;
  spans?: SentenceSpan[]; // 整句模式下的高亮区间
  degraded?: { reason?: string };
}

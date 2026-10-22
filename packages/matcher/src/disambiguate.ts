/**
 * 三级降级消歧（backend-implementation §3.3）。
 * 第一级：别名直连消解（需 alias.sense_id，当前 LexiconEntry 未携带，留作 v2 数据扩展，这里跳过）。
 * 第二级：上下文关键词加权打分（单词模式下 contextTokens 为空、adjacencyBonus=0，
 *         退化为「主义项偏置」——符合预期，因为单词查询本就是查默认含义）。
 * 第三级：低置信兜底，返回主义项 + alternatives 供 UI 切换（不打断、不弹窗）。
 */
import type { LexiconEntry, SenseFrequency, SenseView } from "@jargon/contracts";

const CTX_WEIGHT = 1; // 命中一个上下文关键词
const ADJ_BONUS = 1.5; // 关键词在命中词 ±10 字符窗口内
const PRIMARY_BIAS = 0.5;
const LOW_CONF_GAP = 0.3; // top 与次高分之差 < 0.3 → 低置信
const LOW_CONF_CAP = 0.69;

const FREQ_WEIGHT: Record<SenseFrequency, number> = { high: 3, mid: 2, low: 1 };

export interface SenseChoice {
  senseKey: string;
  confidence: number;
  isLowConfidence: boolean;
  alternatives?: { senseKey: string; plainExplain: string }[];
}

function senseWeight(s: SenseView): number {
  return FREQ_WEIGHT[s.frequency ?? "mid"];
}

function adjacencyHit(
  sense: SenseView,
  raw: string,
  hitStart: number,
): boolean {
  if (!sense.contextKeywords || sense.contextKeywords.length === 0) return false;
  for (const kw of sense.contextKeywords) {
    const idx = raw.indexOf(kw);
    if (idx >= 0 && Math.abs(idx - hitStart) <= 10) return true;
  }
  return false;
}

export function disambiguate(
  entry: LexiconEntry,
  opts: { contextTokens?: string[]; raw?: string; hitStart?: number } = {},
): SenseChoice {
  const senses = entry.senses;
  if (senses.length === 1) {
    const only = senses[0];
    if (only) return { senseKey: only.senseKey, confidence: 1, isLowConfidence: false };
  }

  const contextTokens = new Set(opts.contextTokens ?? []);
  const raw = opts.raw ?? "";
  const hitStart = opts.hitStart ?? 0;

  // 第二级打分
  const ranked = senses
    .map((s) => {
      let score = 0;
      const kw = s.contextKeywords ?? [];
      for (const k of kw) if (contextTokens.has(k)) score += CTX_WEIGHT;
      if (adjacencyHit(s, raw, hitStart)) score += ADJ_BONUS;
      if (s.isPrimary) score += PRIMARY_BIAS;
      return { sense: s, score };
    })
    .sort((a, b) => b.score - a.score || senseWeight(b.sense) - senseWeight(a.sense));

  const top = ranked[0];
  const second = ranked[1];
  if (!top) {
    // 不可达兜底：senses 非空时 ranked 至少一个
    const fallback = senses[0];
    return {
      senseKey: fallback ? fallback.senseKey : "",
      confidence: 0,
      isLowConfidence: true,
    };
  }
  const isLowConfidence = !second || top.score - second.score < LOW_CONF_GAP;

  // 第三级兜底
  if (isLowConfidence) {
    const primary = senses.find((s) => s.isPrimary) ?? top.sense;
    return {
      senseKey: primary.senseKey,
      confidence: Math.min(top.score, LOW_CONF_CAP),
      isLowConfidence: true,
      alternatives: ranked.map((r) => ({
        senseKey: r.sense.senseKey,
        plainExplain: r.sense.plainExplain,
      })),
    };
  }

  return {
    senseKey: top.sense.senseKey,
    confidence: top.score,
    isLowConfidence: false,
  };
}

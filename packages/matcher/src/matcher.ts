/**
 * 同构检索引擎核心（backend-implementation §3 / architecture §2.4 方案 D）。
 * - 内存词典：aliasByNorm / aliasToTerms 镜像（~200KB @2000 词条）
 * - Aho-Corasick 自动机：整句一次遍历产出 span
 * - 五级降级（单词 L0~L3）+ 三级消歧（§3.3）+ 未命中建议（§3.4）
 * 单例 loadLexicon/getMatcher 供服务端 SWR 双缓冲与客户端 IndexedDB 缓存共用。
 */
import type { LexiconEntry, LexiconManifest, SearchResultItem } from "@jargon/contracts";
import { AhoCorasick, type AcSpan } from "./aho-corasick";
import { resolveSentenceSpans, type AliasToTerms, type SpanCandidate } from "./decide";
import { disambiguate } from "./disambiguate";
import { normalize, normalizeWithMap } from "./normalize";
import { generateSuggestions } from "./suggestions";
import { ALIAS_WEIGHT, WEIGHTS } from "./weights";
import type { InputKind, MatchType, MatchedTerm, SearchResponse, SentenceSpan } from "./types";

interface AliasHit {
  slug: string;
  aliasType: string;
  normKey: string;
  score: number;
}

const PUNCT = /[，。、；：！？,.!?;:\s]/;

function aliasMatchType(aliasType: string): MatchType {
  switch (aliasType) {
    case "primary":
      return "exact";
    case "pinyin_abbr":
    case "pinyin_full":
      return "pinyin";
    default:
      return "alias"; // cn_alias / en_alias / colloquial / misspell
  }
}

function aliasLevel(aliasType: string): number {
  switch (aliasType) {
    case "primary":
      return 0;
    case "cn_alias":
    case "en_alias":
      return 1;
    case "pinyin_abbr":
    case "pinyin_full":
    case "colloquial":
    case "misspell":
      return 2;
    default:
      return 3;
  }
}

function isSentence(query: string): boolean {
  const n = normalize(query).norm;
  return n.length > 20 || PUNCT.test(query);
}

export class LexiconMatcher {
  readonly manifest: LexiconManifest;
  readonly checksum: string;
  private entriesBySlug = new Map<string, LexiconEntry>();
  private aliasByNorm = new Map<string, AliasHit[]>();
  private aliasToTerms: AliasToTerms = new Map();
  private ac: AhoCorasick;
  private allEntries: LexiconEntry[];
  private globalKeywords: string[] = [];

  constructor(manifest: LexiconManifest) {
    this.manifest = manifest;
    this.checksum = manifest.checksum;
    this.allEntries = manifest.entries;

    const normKeys = new Set<string>();
    for (const e of manifest.entries) {
      this.entriesBySlug.set(e.slug, e);
      for (const s of e.senses) {
        for (const kw of s.contextKeywords ?? []) {
          if (!this.globalKeywords.includes(kw)) this.globalKeywords.push(kw);
        }
      }
      for (const a of e.aliases) {
        const nk = normalize(a.raw).norm;
        if (!nk) continue;
        normKeys.add(nk);
        const score = ALIAS_WEIGHT[a.aliasType] ?? WEIGHTS.EXACT_ALIAS_CN;
        if (!this.aliasByNorm.has(nk)) this.aliasByNorm.set(nk, []);
        this.aliasByNorm.get(nk)!.push({
          slug: e.slug,
          aliasType: a.aliasType,
          normKey: nk,
          score,
        });
        if (!this.aliasToTerms.has(nk)) this.aliasToTerms.set(nk, []);
        this.aliasToTerms.get(nk)!.push({ slug: e.slug, popularity: e.popularity });
      }
    }

    // aliasToTerms 按 popularity desc / slug asc 排序，供裁决层取最优
    for (const [, list] of this.aliasToTerms) {
      list.sort((a, b) => b.popularity - a.popularity || a.slug.localeCompare(b.slug));
    }

    this.ac = new AhoCorasick(Array.from(normKeys));
  }

  /** 单词模式五级降级（L0 精确 → L1 别名 → L2 拼音/口语/错拼 → L3 前缀/子串） */
  resolveWord(query: string): MatchedTerm | null {
    const q = normalize(query).norm;
    if (!q) return null;
    const cands: (AliasHit & { level: number; matchType: MatchType })[] = [];
    for (const [nk, list] of this.aliasByNorm) {
      for (const h of list) {
        if (nk === q) {
          cands.push({ ...h, level: aliasLevel(h.aliasType), matchType: aliasMatchType(h.aliasType) });
        } else if (nk.startsWith(q) && q.length >= 2) {
          cands.push({ ...h, score: WEIGHTS.PREFIX, level: 3, matchType: "prefix" });
        } else if (q.startsWith(nk) && nk.length >= 2) {
          cands.push({ ...h, score: WEIGHTS.SUBSTRING_IN_ALIAS, level: 3, matchType: "alias" });
        }
      }
    }
    if (cands.length === 0) return null;
    // §3.1 稳定性：score → popularity → slug
    cands.sort(
      (a, b) =>
        b.score - a.score ||
        this.entriesBySlug.get(b.slug)!.popularity - this.entriesBySlug.get(a.slug)!.popularity ||
        a.slug.localeCompare(b.slug),
    );
    const best = cands[0];
    if (!best) return null;
    return this.toMatchedTerm(best.slug, best.level, best.matchType, {});
  }

  /** 整句模式：AC + 裁决层（§3.2） */
  scanSentence(text: string): { matched: MatchedTerm[]; spans: SentenceSpan[] } {
    const { norm, map } = normalizeWithMap(text);
    const acSpans: AcSpan[] = this.ac.collect(norm);
    const decided: SpanCandidate[] = resolveSentenceSpans(text, map, acSpans, this.aliasToTerms);

    const contextTokens = this.globalKeywords.filter((k) => norm.includes(k));
    const slugSet = new Set<string>();
    const matched: MatchedTerm[] = [];
    const spans: SentenceSpan[] = [];

    for (const sp of decided) {
      if (!sp.slug || slugSet.has(sp.slug)) continue;
      slugSet.add(sp.slug);
      const entry = this.entriesBySlug.get(sp.slug)!;
      const choice = disambiguate(entry, { contextTokens, raw: text, hitStart: sp.start });
      matched.push(
        this.toMatchedTerm(sp.slug, 0, "alias", {
          senseKey: choice.senseKey,
          isLowConfidence: choice.isLowConfidence,
          alternatives: choice.alternatives,
        }),
      );
      spans.push({
        start: sp.start,
        end: sp.end,
        raw: text.slice(sp.start, sp.end),
        slug: sp.slug,
        senseKey: choice.senseKey,
        isLowConfidence: choice.isLowConfidence,
      });
    }

    // 补充：整句也跑一次 L0 精确（整个 norm 作为词，§3.2 末段）
    const whole = this.resolveWord(norm);
    if (whole && !slugSet.has(whole.slug)) {
      slugSet.add(whole.slug);
      matched.push({ ...whole, matchType: "alias", level: 3 });
      const idx = norm.indexOf(whole.headword.toLowerCase());
      const last = matched[matched.length - 1];
      if (idx >= 0 && last) {
        const rs = map[idx] ?? 0;
        const re = (map[idx + whole.headword.length - 1] ?? rs) + 1;
        spans.push({
          start: rs,
          end: re,
          raw: text.slice(rs, re),
          slug: whole.slug,
          senseKey: last.senseKey,
          isLowConfidence: last.isLowConfidence,
        });
      }
    }

    return { matched, spans };
  }

  /** 顶层搜索：自动判定单词/整句 → 命中 / 未命中建议 */
  search(query: string): SearchResponse {
    const kind: InputKind = isSentence(query) ? "sentence" : "word";
    let matched: MatchedTerm[];
    let spans: SentenceSpan[] | undefined;
    if (kind === "sentence") {
      const r = this.scanSentence(query);
      matched = r.matched;
      spans = r.spans;
    } else {
      const m = this.resolveWord(query);
      matched = m ? [m] : [];
    }
    const miss = matched.length === 0;
    const suggestions = miss ? generateSuggestions(normalize(query).norm, this.allEntries) : [];
    return {
      matched,
      miss,
      inputKind: kind,
      level: matched[0]?.level ?? 3.5,
      suggestions,
      indexChecksum: this.checksum,
      spans,
    };
  }

  private toMatchedTerm(
    slug: string,
    level: number,
    matchType: MatchType,
    override: {
      senseKey?: string;
      isLowConfidence?: boolean;
      alternatives?: { senseKey: string; plainExplain: string }[];
    },
  ): MatchedTerm {
    const entry = this.entriesBySlug.get(slug)!;
    const choice = disambiguate(entry, {}); // 单词模式无上下文
    const senseKey = override.senseKey ?? choice.senseKey;
    const sense = entry.senses.find((s) => s.senseKey === senseKey) ?? entry.senses[0];
    return {
      slug: entry.slug,
      headword: entry.headword,
      categoryL1: entry.categoryL1,
      categoryL2: entry.categoryL2,
      difficulty: entry.difficulty,
      plainExplain: sense?.plainExplain ?? entry.summaryPlain,
      riskNote: entry.riskNote,
      senseKey,
      isLowConfidence: override.isLowConfidence ?? choice.isLowConfidence,
      alternatives: override.alternatives ?? choice.alternatives,
      matchType,
      level,
    };
  }
}

// ── 单例（服务端 SWR 双缓冲 / 客户端 IndexedDB 缓存共用）──────────────────
let _current: LexiconMatcher | null = null;

export function loadLexicon(manifest: LexiconManifest): LexiconMatcher {
  _current = new LexiconMatcher(manifest);
  return _current;
}

export function getMatcher(): LexiconMatcher {
  if (!_current) throw new Error("LexiconMatcher 未初始化：请先调用 loadLexicon(manifest)");
  return _current;
}

/** 兼容旧 normalize.match 的形态（SearchResultItem[] + level + miss） */
export function match(query: string): {
  items: SearchResultItem[];
  level: number;
  miss: boolean;
} {
  const r = getMatcher().search(query);
  return {
    items: r.matched.map((m) => ({
      slug: m.slug,
      headword: m.headword,
      plainExplain: m.plainExplain,
      categoryL1: m.categoryL1,
      difficulty: m.difficulty,
      matchType: m.matchType,
    })),
    level: r.level,
    miss: r.miss,
  };
}

import { test } from "node:test";
import assert from "node:assert/strict";
import type { LexiconEntry, LexiconManifest } from "@jargon/contracts";
import { AhoCorasick } from "./aho-corasick";
import {
  chineseBoundaryCheck,
  englishBoundaryCheck,
  greedyLongest,
  resolveSentenceSpans,
  type AliasToTerms,
  type SpanCandidate,
} from "./decide";
import { disambiguate } from "./disambiguate";
import { normalize, normalizeWithMap } from "./normalize";
import { generateSuggestions } from "./suggestions";
import { LexiconMatcher, loadLexicon } from "./matcher";

const fixture: LexiconEntry[] = [
  {
    slug: "shi-ying-lv",
    headword: "市盈率",
    categoryL1: "估值财务",
    categoryL2: "估值倍数",
    difficulty: "L2",
    summaryPlain: "股价除以每股收益",
    frequency: "high",
    popularity: 1000,
    senses: [
      { senseKey: "default", plainExplain: "股价/每股收益", isPrimary: true, frequency: "high" },
      {
        senseKey: "ttm",
        plainExplain: "滚动市盈率",
        isPrimary: false,
        frequency: "mid",
        contextKeywords: ["滚动", "TTM"],
      },
    ],
    aliases: [
      { raw: "市盈率", aliasType: "primary" },
      { raw: "PE", aliasType: "en_alias" },
      { raw: "本益比", aliasType: "cn_alias" },
    ],
  },
  {
    slug: "macd",
    headword: "MACD",
    categoryL1: "技术指标",
    categoryL2: "交叉与信号",
    difficulty: "L2",
    summaryPlain: "指数平滑异同移动平均线",
    frequency: "mid",
    popularity: 600,
    senses: [{ senseKey: "default", plainExplain: "指数平滑异同移动平均线", isPrimary: true, frequency: "mid" }],
    aliases: [
      { raw: "MACD", aliasType: "primary" },
      { raw: "指数平滑异同移动平均线", aliasType: "cn_alias" },
    ],
  },
  {
    slug: "si-mao-fan-dan",
    headword: "死猫反弹",
    categoryL1: "走势形态",
    categoryL2: "极端走势",
    difficulty: "L1",
    summaryPlain: "下跌中的短暂假性回升",
    frequency: "mid",
    popularity: 600,
    senses: [{ senseKey: "default", plainExplain: "下跌中的短暂假性回升", isPrimary: true, frequency: "mid" }],
    aliases: [
      { raw: "死猫反弹", aliasType: "primary" },
      { raw: "弥留反弹", aliasType: "misspell" },
    ],
  },
  {
    slug: "qu-ku-cun",
    headword: "去库存",
    categoryL1: "宏观经济",
    categoryL2: "增长与产出",
    difficulty: "L1",
    summaryPlain: "降低积压的存货",
    frequency: "mid",
    popularity: 600,
    senses: [{ senseKey: "default", plainExplain: "降低积压的存货", isPrimary: true, frequency: "mid" }],
    aliases: [{ raw: "去库存", aliasType: "primary" }],
  },
];

function makeManifest(): LexiconManifest {
  return {
    version: 1,
    checksum: "test-checksum",
    generatedAt: new Date().toISOString(),
    count: fixture.length,
    entries: fixture,
  };
}

test("normalize: 全角/大小写/空白压缩", () => {
  assert.equal(normalize("  ＰＥ  ").norm, "pe");
  assert.equal(normalize("MACD").norm, "macd");
});

test("normalizeWithMap: 坐标反查", () => {
  const { norm, map } = normalizeWithMap("市盈率(PE)");
  assert.equal(norm, "市盈率(pe)");
  // '市' 是 norm[0] → 对应 raw[0]
  assert.equal(map[0], 0);
  // '(' 是 norm[3] → raw[3]
  assert.equal(map[3], 3);
});

test("AhoCorasick: 一次遍历收集全部 span（含包含关系）", () => {
  const ac = new AhoCorasick(["市盈率", "市", "pe", "macd"]);
  const spans = ac.collect("市盈率是pe指标");
  const keys = spans.map((s) => s.key).sort();
  assert.deepEqual(keys, ["pe", "市", "市盈率"]);
});

test("decide: 中文边界检查丢弃「市」", () => {
  const spans: SpanCandidate[] = [
    { normStart: 0, normEnd: 1, start: 0, end: 1, key: "市" },
    { normStart: 0, normEnd: 3, start: 0, end: 3, key: "市盈率" },
  ];
  const raw = "市盈率";
  const out = chineseBoundaryCheck(raw, spans);
  assert.equal(out.length, 1);
  assert.equal(out[0].key, "市盈率");
});

test("decide: 英文边界检查丢弃 OPEN 中的 PE", () => {
  const spans: SpanCandidate[] = [{ normStart: 1, normEnd: 3, start: 1, end: 3, key: "pe" }];
  const out = englishBoundaryCheck("OPEN", spans);
  assert.equal(out.length, 0);
});

test("decide: 贪心最长优先去重叠", () => {
  const spans: SpanCandidate[] = [
    { normStart: 0, normEnd: 3, start: 0, end: 3, key: "市盈率" },
    { normStart: 0, normEnd: 1, start: 0, end: 1, key: "市" },
  ];
  const out = greedyLongest(spans);
  assert.equal(out.length, 1);
  assert.equal(out[0].key, "市盈率");
});

test("decide: resolveSentenceSpans 端到端", () => {
  const { norm, map } = normalizeWithMap("市盈率(PE)");
  const ac = new AhoCorasick(["市盈率", "pe"]);
  const aliasToTerms: AliasToTerms = new Map([
    ["市盈率", [{ slug: "shi-ying-lv", popularity: 1000 }]],
    ["pe", [{ slug: "shi-ying-lv", popularity: 1000 }]],
  ]);
  const out = resolveSentenceSpans("市盈率(PE)", map, ac.collect(norm), aliasToTerms);
  assert.equal(out.length, 2);
  assert.ok(out.every((s) => s.slug === "shi-ying-lv"));
});

test("disambiguate: 单词模式退化为主义项", () => {
  const entry = fixture.find((e) => e.slug === "shi-ying-lv")!;
  const c = disambiguate(entry, {});
  assert.equal(c.senseKey, "default");
  assert.equal(c.isLowConfidence, false);
});

test("disambiguate: 句子模式命中上下文选 ttm 义项", () => {
  const entry = fixture.find((e) => e.slug === "shi-ying-lv")!;
  const c = disambiguate(entry, { contextTokens: ["滚动"], raw: "滚动市盈率", hitStart: 0 });
  assert.equal(c.senseKey, "ttm");
});

test("suggestions: 错别字召回死猫反弹", () => {
  const sugs = generateSuggestions("弥留反弹", fixture);
  assert.ok(sugs.some((s) => s.slug === "si-mao-fan-dan"));
});

test("Matcher.resolveWord: PE → 市盈率别名命中", () => {
  const m = loadLexicon(makeManifest());
  const r = m.resolveWord("PE");
  assert.ok(r);
  assert.equal(r!.slug, "shi-ying-lv");
  assert.equal(r!.matchType, "alias");
  assert.equal(r!.level, 1);
});

test("Matcher.scanSentence: 整句高亮双命中", () => {
  const m = loadLexicon(makeManifest());
  const { matched, spans } = m.scanSentence("市盈率和MACD怎么看");
  const slugs = matched.map((x) => x.slug).sort();
  assert.deepEqual(slugs, ["macd", "shi-ying-lv"]);
  assert.equal(spans.length, 2);
  // 原始坐标切片正确
  const peSpan = spans.find((s) => s.slug === "shi-ying-lv")!;
  assert.equal(peSpan.raw, "市盈率");
});

test("Matcher.search: 未命中给出建议", () => {
  const m = loadLexicon(makeManifest());
  const r = m.search("qqq");
  assert.equal(r.miss, true);
  assert.ok(r.suggestions.length >= 1);
});

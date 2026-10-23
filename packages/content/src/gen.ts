/**
 * 候选生成器（wave 批量脚手架）—— 机械活自动化，人话层仍由人工精修 + 过门。
 * 用法：
 *   tsx src/gen.ts --keyword "市盈率|市净率|估值" --category 估值财务 --category2 估值倍数 --limit 30 --out content/batches/_cand-估值.yaml
 *   tsx src/gen.ts --all --out-prefix content/batches/_cand-full    # 全量导入：市场+类型+关键词路由类目，按类目分文件
 * 产出候选 terms（slug 拼音 / 别名自动分类 / 查重跳过已覆盖 / 频次取优先级）。
 * 之后必须：人工精修人话层 → `ingest --file` 0 block → 合入。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import yaml from "yaml";
import { pinyin } from "pinyin-pro";
import { findRepoRoot } from "./paths";
import type { CategoryL1, LexiconManifest, AliasType } from "@jargon/contracts";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function genSlug(term: string): string {
  const arr = pinyin(term, { toneType: "none", type: "array" }) as string[];
  const s = arr.join("-").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s || `t-${Math.random().toString(36).slice(2, 8)}`;
}

function classifyAlias(raw: string): AliasType {
  return /[a-zA-Z]/.test(raw) ? "en_alias" : "cn_alias";
}

const FREQ_MAP: Record<string, "high" | "mid" | "low"> = { 高: "high", 中: "mid", 低: "low" };

/* ── 全量模式的类目路由（市场×类型×关键词，启发式，可能个别误分） ── */
const MACRO_KW = /GDP|CPI|PPI|PMI|LPR|MLF|SLF|PSL|逆回购|降准|降息|加息|利率|汇率|人民币汇率|美元指数|美联储|央行|国债|地方债|专项债|赤字|财政|货币|通胀|就业|失业|贸易|进出口|社融|M1|M2|信贷|外汇储备|国际收支|产能|库存周期|经济|工业增加值|房地产投资|基建|消费|投资|存款利率|市场利率|政策利率|无风险利率/;
const FIN_KW = /市盈率|市净率|市销率|股息率|估值|PEG|DCF|托宾|重置成本|清算价值|账面价值|每股净资产|资本成本|WACC|企业价值|ROE|ROA|ROIC|利润率|毛利|净利|周转|负债率|权益乘数|复合增长|年化|收益率|现金比率|利息保障/;
const ROUTES: [RegExp, CategoryL1][] = [
  [MACRO_KW, "宏观经济"],
  [/基金|ETF|LOF|QDII|货基|理财|信托|保险|资管|私募|公募|组合|净值|申赎|申购费|赎回费|管理费|托管费|FOF|REITs|养老目标|定投|侧袋|联接/i, "基金产品"],
  [/期货|期权|互换|保证金|交割|对冲|套利|杠杆|波动|回撤|夏普|索提诺|因子|量化|模型|希腊字母|Greeks|基差|升水|贴水|滑点|过拟合|择时|跟踪误差|爆仓|强平|风险价值|VaR|久期|凸性/i, "量化与风险"],
  [/交易|申购|赎回|上市|退市|停牌|复牌|涨跌|委托|交割|交收|制度|规则|监管|披露|要约|举牌|质押|两融|融资融券|融券|注册制|打新|中签|配股|供股|除权|除息|风险警示|退市整理|限价|市价|一手|交收|碎股|做市/i, "交易制度"],
  [/指数|板块|成分股|权重股|沪深300|中证|标普|纳指|道指|罗素|恒生|创业板|科创板|北证|宽基|风格|行业指数|概念板块/i, "指数板块"],
  [/均线|K线|蜡烛|MACD|KDJ|RSI|BOLL|布林|OBV|CCI|WR|SAR|EXPMA|BBI|量价|成交量|量比|趋势线|形态|十字星|锤子|吞没|背离|金叉|死叉|超买|超卖|支撑|压力|波浪|通道|缺口|跳空|乖离|威廉|轨道线|生命线/i, "技术指标"],
  [FIN_KW, "估值财务"],
  [/财报|报表|会计|收入|成本|利润|资产|负债|股东|权益|股本|分红|派息|送股|转增|回购|商誉|摊销|折旧|审计|应收|应付|存货|坏账|递延|现金|合同|少数股东|合并报表|关联交易|或有|预计负债|资本公积|未分配利润|减值/i, "财报公司"],
];

function routeCategory(market: string, typ: string, headword: string, def: string): CategoryL1 {
  if (market === "美股") return "美股";
  if (market === "港股") return "港股";
  if (typ === "黑话") return "行情黑话";
  if (typ === "机构") return "机构与资金";
  if (typ === "政策") return "宏观政策";
  const text = `${headword} ${def}`;
  for (const [re, cat] of ROUTES) if (re.test(text)) return cat;
  return typ === "指标" ? "技术指标" : "行情黑话";
}

function loadSkipSets(root: string): { surfaces: Set<string>; candHeadwords: Set<string> } {
  const surfaces = new Set<string>();
  const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
  const lexPath = path.join(root, "content/.compiled/lexicon.json");
  if (existsSync(lexPath)) {
    const manifest: LexiconManifest = JSON.parse(readFileSync(lexPath, "utf8"));
    for (const e of manifest.entries) {
      surfaces.add(norm(e.headword));
      for (const a of e.aliases) surfaces.add(norm(a.raw));
    }
  }
  // 已生成过候选的词也跳过（含被门拦下的，避免重复生成同样会 block 的内容）
  const candHeadwords = new Set<string>();
  const dir = path.join(root, "content/batches");
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((x) => x.startsWith("_cand-") && x.endsWith(".yaml"))) {
      const txt = readFileSync(path.join(dir, f), "utf8");
      for (const hw of txt.matchAll(/^\s*headword:\s*(.+)$/gm)) candHeadwords.add(norm(hw[1] ?? ""));
    }
  }
  return { surfaces, candHeadwords };
}

function main(): void {
  const root = findRepoRoot();
  const all = process.argv.includes("--all");
  const keyword = arg("keyword");
  const category = arg("category") as CategoryL1 | undefined;
  const category2 = arg("category2") ?? "综合";
  const market = arg("market");
  const freq = arg("freq");
  const limit = parseInt(arg("limit", all ? "100000" : "40") ?? "40", 10);
  const out = arg("out") ?? "content/batches/_cand.yaml";
  const outPrefix = arg("out-prefix") ?? "content/batches/_cand-full";
  if (!all && !keyword) { console.error("缺少 --keyword（或使用 --all 全量模式）"); process.exit(2); }

  const { surfaces: ours, candHeadwords } = loadSkipSets(root);
  const src = arg("src") ?? "/tmp/feishu_terms/full.tsv";
  const srcPath = path.isAbsolute(src) ? src : path.join(root, src);
  const rows = readFileSync(srcPath, "utf8")
    .split("\n").slice(1)
    .map((l) => l.split("\t"))
    .filter((c) => c.length >= 6 && c[0] && (all || new RegExp(keyword!).test(c[0])));

  const terms: any[] = [];
  const usedSlugs = new Set<string>();
  let skipped = 0;
  let skippedCand = 0;
  for (const c of rows) {
    if (terms.length >= limit) break;
    const headword = (c[0] ?? "").trim();
    const def = (c[4] ?? "").trim();
    if (!def) { skipped++; continue; }
    if (market && (c[2] ?? "").trim() !== market) continue;
    if (freq && (c[6] ?? "").trim() !== freq) continue;
    const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
    const surfaces = new Set([norm(headword), ...headword.split("/").map((p) => norm(p.trim()))]);
    for (const a of (c[1] ?? "").split(/[,，]/)) if (a.trim()) surfaces.add(norm(a.trim()));
    if ([...surfaces].some((s) => ours.has(s))) { skipped++; continue; }
    if (candHeadwords.has(norm(headword))) { skippedCand++; continue; }
    let slug = genSlug(headword);
    while (usedSlugs.has(slug)) slug = `${slug}-2`;
    usedSlugs.add(slug);
    const aliases: { raw: string; aliasType: AliasType }[] = [{ raw: headword, aliasType: "primary" }];
    for (const a of (c[1] ?? "").split(/[,，]/).map((x) => x.trim()).filter(Boolean)) {
      if (a === headword) continue;
      aliases.push({ raw: a, aliasType: classifyAlias(a) });
    }
    terms.push({
      slug,
      headword,
      categoryL1: all
        ? routeCategory((c[2] ?? "").trim(), (c[3] ?? "").trim(), headword, def)
        : category ?? "行情黑话",
      categoryL2: all ? "综合" : category2,
      difficulty: "L2",
      summaryPlain: def,
      riskNote: "术语解释仅供学习了解，不构成投资建议。",
      frequency: FREQ_MAP[(c[6] ?? "").trim()] ?? "mid",
      senses: [{ senseKey: "default", plainExplain: def, example: (c[5] ?? "").trim(), isPrimary: true }],
      aliases,
    });
  }

  if (all) {
    // 按类目分文件输出
    const byCat = new Map<string, any[]>();
    for (const t of terms) {
      const arr = byCat.get(t.categoryL1) ?? [];
      arr.push(t);
      byCat.set(t.categoryL1, arr);
    }
    for (const [cat, arr] of byCat) {
      const doc = { source: "gen from full.tsv --all 市场×类型×关键词路由 (待精修)", terms: arr };
      writeFileSync(path.join(root, `${outPrefix}-${cat}.yaml`), yaml.stringify(doc, { lineWidth: 0 }), "utf8");
      console.log(`  ${cat}: ${arr.length} 条 → ${outPrefix}-${cat}.yaml`);
    }
    console.log(`\n全量生成候选 ${terms.length} 条（查重跳过已覆盖 ${skipped}，跳过已生成候选 ${skippedCand}）`);
  } else {
    const doc = { source: `gen from full.tsv keyword=${keyword} (待精修)`, terms };
    const outPath = path.isAbsolute(out) ? out : path.join(root, out);
    writeFileSync(outPath, yaml.stringify(doc, { lineWidth: 0 }), "utf8");
    console.log(`生成候选 ${terms.length} 条（查重跳过 ${skipped}）→ ${outPath}`);
    console.log(`类别：${category ?? "(未指定→行情黑话, 建议指定)"} / ${category2}`);
  }
  console.log("下一步：人工精修 summaryPlain/example（去黑话/建议词）→ ingest --file 0 block → 合入");
}

main();

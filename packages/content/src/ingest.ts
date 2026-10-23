/**
 * 批量内容 ingestion（万级词条可扩展的生产链路）
 * ─────────────────────────────────────────────────────────────────
 * 目标：替代/补充 content/terms/*.mdx 的单文件链路，用结构化批量源
 *   content/batches 下的 yaml  →  校验（结构 + 内容门）→ 生成
 *   content/.compiled/lexicon.json（含 viz / insights，绝不丢字段）。
 *
 * 与 mdx→compile 的关键差异：
 *   - 按契约 18 类 CategoryL1 校验（schema.ts 的 13 类已滞后，勿耦合）。
 *   - 不要求 author/reviewer/compliance（客户端词典不携带这些字段）。
 *   - 幂等「替换」语义：lexicon.json = 所有批量源的并集（按 slug 去重），
 *     从而可从零复现；未在任何批量源中出现的旧词条会被移除——
 *     因此首次务必先 `bootstrap` 把现有词条物化进批量源。
 *
 * 用法：
 *   tsx src/ingest.ts bootstrap     # 一次性：读 lexicon.json → 写 content/batches/<类目>.yaml
 *   tsx src/ingest.ts               # 编译：content/batches → lexicon.json（有 block 也照写，仅告警）
 *   tsx src/ingest.ts --check       # CI 门：有 block 级问题则退出码 1 且不写文件
 */
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import yaml from "yaml";
import { z } from "zod";
import { loadRules, runContentGates } from "./validate";
import type { Issue } from "./validate";
import { findRepoRoot } from "./paths";
import type {
  CategoryL1,
  LexiconEntry,
  LexiconManifest,
  TermInsights,
  SenseFrequency,
  TermDifficulty,
  AliasType,
} from "@jargon/contracts";

// ── 契约 18 类（与 packages/contracts CategoryL1 对齐）────────────────────
const CATEGORY_L1 = [
  "宏观经济", "技术指标", "估值财务", "基金产品", "交易风险", "市场情绪",
  "走势形态", "买卖操作", "财报公司", "机构与资金", "宏观政策", "美股",
  "港股", "指数板块", "交易制度", "量化与风险", "行情黑话", "常见误用",
] as const;

// ── VizType 白名单（与 contracts 对齐；新增组件需同步此处）────────────────
const VIZ_TYPES = new Set<string>([
  "PriceChangeBars", "CandleBuilder", "MarketMood", "VolumeRatio", "MarketCapBar",
  "GDPStack", "CPIBasket", "InventoryClear", "PoolDilution", "UnlockPressure",
  "PEScale", "ProfitLossScale", "DividendSplit", "ExRightAdjust", "TurnoverPie",
  "CrossLines", "Oscillator", "MoneyFlow", "LongShortSeesaw", "IpoLottery",
  "BreakIssue", "TrapScale", "RiskLadder", "ConvertibleScale", "HaltClock",
  "IndexTower", "CircuitBreaker", "PrePostMarket", "EarningsSeason", "AdrBridge",
  "OptionsLadder", "LeverageWheel", "GreyMarket", "HkTypesCompare", "GaugeBar",
]);

const ALIAS_TYPES = [
  "primary", "cn_alias", "en_alias", "pinyin_abbr", "pinyin_full", "colloquial", "misspell",
] as const;

const POPULARITY_BY_FREQ: Record<SenseFrequency, number> = {
  high: 1000, mid: 600, low: 300,
};

// ── 批量源 schema（≈ LexiconEntry，popularity 由 frequency 派生，不入库）──
const senseSchema = z.object({
  senseKey: z.string().min(1),
  plainExplain: z.string().min(1),
  example: z.string().optional(),
  notMeaning: z.string().optional(),
  isPrimary: z.boolean(),
  contextKeywords: z.array(z.string()).optional(),
  frequency: z.enum(["high", "mid", "low"]).optional(),
});

const aliasSchema = z.object({
  raw: z.string().min(1),
  aliasType: z.enum(ALIAS_TYPES).default("cn_alias"),
});

const vizSchema = z.object({
  type: z.string().refine((v) => VIZ_TYPES.has(v), { message: `viz.type 需在 ${VIZ_TYPES.size} 个已注册类型内` }),
  title: z.string().optional(),
  caption: z.string().optional(),
  hint: z.string().optional(),
  insight: z.string().optional(),
  config: z.record(z.unknown()).optional(),
});

const insightsSchema = z.object({
  affects: z.array(z.string()),
  good: z.array(z.string()),
  bad: z.array(z.string()),
  policy: z.array(z.string()),
  example: z.string(),
});

const batchTermSchema = z
  .object({
    slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "slug 需小写 kebab-case"),
    headword: z.string().min(1),
    categoryL1: z.enum(CATEGORY_L1),
    categoryL2: z.string().min(1),
    difficulty: z.enum(["L1", "L2", "L3"]),
    summaryPlain: z.string().min(1),
    riskNote: z.string().optional(),
    frequency: z.enum(["high", "mid", "low"]).default("mid"),
    popularity: z.number().optional(),
    senses: z.array(senseSchema).min(1),
    aliases: z.array(aliasSchema).min(1),
    viz: vizSchema.optional(),
    insights: insightsSchema.optional(),
  })
  .superRefine((val, ctx) => {
    const primaries = val.senses.filter((s) => s.isPrimary);
    if (primaries.length !== 1) {
      ctx.addIssue({ code: "custom", path: ["senses"], message: "必须且只能有一个 isPrimary 义项" });
    }
    const keys = val.senses.map((s) => s.senseKey);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: "custom", path: ["senses"], message: "senseKey 不可重复" });
    }
    const aliasRaws = val.aliases.map((a) => a.raw);
    if (new Set(aliasRaws).size !== aliasRaws.length) {
      ctx.addIssue({ code: "custom", path: ["aliases"], message: "aliases.raw 不可重复" });
    }
    // 注：primary 别名(raw===headword) 与 summaryPlain===主义项 plainExplain
    // 两项在既有数据中不保证成立，故不作为硬性 block（降为 compile 期 review）。
  });

type BatchTerm = z.infer<typeof batchTermSchema>;

// ── 稳定序列化 → checksum（与 compile.ts 一致）────────────────────────────
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

function toEntry(t: BatchTerm): LexiconEntry {
  const senses = t.senses.map((s) => ({
    senseKey: s.senseKey,
    plainExplain: s.plainExplain,
    example: s.example,
    notMeaning: s.notMeaning,
    isPrimary: s.isPrimary,
    contextKeywords: s.contextKeywords,
    frequency: s.frequency,
  }));
  const aliases = t.aliases.map((a) => ({ raw: a.raw, aliasType: a.aliasType }));
  const entry: LexiconEntry = {
    slug: t.slug,
    headword: t.headword,
    categoryL1: t.categoryL1,
    categoryL2: t.categoryL2,
    difficulty: t.difficulty as TermDifficulty,
    summaryPlain: t.summaryPlain,
    riskNote: t.riskNote,
    frequency: t.frequency as SenseFrequency,
    popularity: t.popularity ?? POPULARITY_BY_FREQ[t.frequency as SenseFrequency],
    senses,
    aliases,
  };
  if (t.viz) entry.viz = t.viz as LexiconEntry["viz"];
  if (t.insights) entry.insights = t.insights as TermInsights;
  return entry;
}

function listBatchFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const f of readdirSync(dir)) {
    if (f.endsWith(".yaml") || f.endsWith(".yml")) out.push(path.join(dir, f));
  }
  return out.sort();
}

// ── bootstrap：把现有 lexicon.json 物化为 content/batches/<类目>.yaml ──────
function bootstrap(rootDir: string): void {
  const lexPath = path.join(rootDir, "content/.compiled/lexicon.json");
  if (!existsSync(lexPath)) {
    console.error("未找到 lexicon.json，无法 bootstrap");
    process.exit(2);
  }
  const manifest = JSON.parse(readFileSync(lexPath, "utf8")) as LexiconManifest;
  const byCat = new Map<string, LexiconEntry[]>();
  for (const e of manifest.entries) {
    const arr = byCat.get(e.categoryL1) ?? [];
    arr.push(e);
    byCat.set(e.categoryL1, arr);
  }
  const outDir = path.join(rootDir, "content/batches");
  mkdirSync(outDir, { recursive: true });
  let written = 0;
  for (const [cat, entries] of byCat) {
    entries.sort((a, b) => a.slug.localeCompare(b.slug));
    const terms = entries.map((e) => ({ ...e }));
    const doc = {
      category: cat,
      source: "bootstrap from lexicon.json (2026-10-22)",
      terms,
    };
    writeFileSync(
      path.join(outDir, `${cat}.yaml`),
      "# 自动生成的批量词条源（可由 ingest 重新编译为 lexicon.json）\n" +
        yaml.stringify(doc, { lineWidth: 0 }),
      "utf8",
    );
    written += terms.length;
    console.log(`✓ ${cat}.yaml  (${terms.length} 条)`);
  }
  console.log(`\nbootstrap 完成：物化 ${written} 条 → content/batches/（${byCat.size} 个类目文件）`);
}

// ── 编译：content/batches → lexicon.json ─────────────────────────────────
function compile(rootDir: string, checkOnly: boolean, onlyFile: string | null, cleanOnly: boolean): void {
  const batchesDir = path.join(rootDir, "content/batches");
  const files = onlyFile ? [onlyFile] : listBatchFiles(batchesDir);
  if (files.length === 0) {
    console.error("未找到 content/batches/*.yaml；如需迁移现有词条请先运行 bootstrap");
    process.exit(2);
  }
  const rules = loadRules(rootDir);

  const bySlug = new Map<string, { entry: LexiconEntry; file: string }>();
  const issuesBySlug = new Map<string, Issue[]>();
  let schemaFail = 0;
  const skippedBlocked: string[] = [];

  for (const file of files) {
    const rel = path.relative(rootDir, file);
    const doc = yaml.parse(readFileSync(file, "utf8")) as { terms?: unknown[] };
    const terms = Array.isArray(doc?.terms) ? doc.terms : [];
    for (const raw of terms) {
      const parsed = batchTermSchema.safeParse(raw);
      if (!parsed.success) {
        schemaFail++;
        const slug = (raw as any)?.slug ?? "(unknown)";
        console.error(`✗ ${rel} [${slug}] 结构校验未通过：`);
        for (const e of parsed.error.issues) {
          console.error(`    [block] ${e.path.join(".")}: ${e.message}`);
        }
        continue;
      }
      const t = parsed.data;
      if (bySlug.has(t.slug)) {
        // 同一 slug 出现在多个文件：内容一致则忽略；不一致时基线文件硬报错，_cand 候选文件跳过后者并告警
        const prev = bySlug.get(t.slug)!;
        if (stableStringify(prev.entry) !== stableStringify(toEntry(t))) {
          if (/(^|\/)_cand/.test(rel) || /(^|\/)_cand/.test(prev.file)) {
            skippedBlocked.push(`${t.slug}(slug冲突)`);
            continue;
          }
          console.error(`✗ slug 冲突且内容不一致：${t.slug}（${prev.file} 与 ${rel}）`);
          process.exit(1);
        }
        continue;
      }
      const entry = toEntry(t);

      // 内容门（复用 mdx 同一套；body 传空，批量源无正文）
      const primary = entry.senses.find((s) => s.isPrimary) ?? entry.senses[0];
      const gate = runContentGates(
        {
          slug: entry.slug,
          headword: entry.headword,
          plain_explain: entry.summaryPlain,
          example: primary?.example,
          risk_note: entry.riskNote,
        },
        "",
        rules,
      );
      // 额外：example 不宜包含词头（避免测验 T2 直接暴露答案）
      if (primary?.example && entry.headword.length >= 2 && primary.example.includes(entry.headword)) {
        gate.push({
          field: "example",
          rule: "example_headword",
          message: `例句包含词头「${entry.headword}」，可能暴露答案`,
          severity: "review",
        });
      }
      if (primary && primary.plainExplain !== entry.summaryPlain) {
        gate.push({ field: "summaryPlain", rule: "summary_mismatch", message: "summaryPlain 与主义项 plainExplain 不一致（建议统一）", severity: "review" });
      }
      if (!entry.aliases.some((a) => a.raw === entry.headword && a.aliasType === "primary")) {
        gate.push({ field: "aliases", rule: "primary_alias_missing", message: "缺少 primary 别名(raw===headword)，建议补齐", severity: "review" });
      }
      // clean-candidates：仅对 _cand- 前缀候选文件跳过 block 词（基线/已精修文件不受影响，绝不丢）
      if (cleanOnly && /(^|\/)_cand/.test(rel) && gate.some((i) => i.severity === "block")) {
        skippedBlocked.push(t.slug);
        continue;
      }
      bySlug.set(t.slug, { entry, file: rel });
      if (gate.length) issuesBySlug.set(entry.slug, gate);
    }
  }

  const entries = [...bySlug.values()].map((v) => v.entry).sort((a, b) => a.slug.localeCompare(b.slug));

  // 汇总 issue
  let blockCount = 0;
  let reviewCount = 0;
  const blockedSlugs: string[] = [];
  for (const [slug, list] of issuesBySlug) {
    for (const i of list) {
      if (i.severity === "block") { blockCount++; blockedSlugs.push(slug); }
      else reviewCount++;
    }
  }
  const uniqBlocked = [...new Set(blockedSlugs)];

  console.log(`\n批量源：${files.length} 个文件，编译 ${entries.length} 条（结构失败 ${schemaFail}）`);
  if (cleanOnly && skippedBlocked.length) {
    console.log(`[clean-only] 跳过 ${skippedBlocked.length} 条 block 候选（留待精修）：${skippedBlocked.slice(0, 20).join("、")}${skippedBlocked.length > 20 ? " …" : ""}`);
  }
  console.log(`内容门：block ${blockCount} 处（涉及 ${uniqBlocked.length} 条）／review ${reviewCount} 处`);
  const reasonHist: Record<string, number> = {};
  for (const [, list] of issuesBySlug) {
    for (const i of list) {
      if (i.severity === "block") reasonHist[i.rule] = (reasonHist[i.rule] ?? 0) + 1;
    }
  }
  const hist = Object.entries(reasonHist).sort((a, b) => b[1] - a[1]);
  if (hist.length) {
    console.log(`  block 原因分布：${hist.map(([r, n]) => `${r}×${n}`).join("  ")}`);
  }
  if (uniqBlocked.length) {
    console.log(`  block 词条（前 15）：${uniqBlocked.slice(0, 15).join("、")}${uniqBlocked.length > 15 ? " …" : ""}`);
  }

  if (onlyFile) {
    console.log(`\n[check-file] ${path.relative(rootDir, onlyFile)}：${entries.length} 条，block ${blockCount}，结构失败 ${schemaFail}`);
    if (blockCount > 0 || schemaFail > 0) {
      console.error("存在 block 级问题，未合入。");
      process.exit(1);
    }
    console.log("✓ 该文件全部通过 block 门，可合入。");
    process.exit(0);
  }

  if (checkOnly && (blockCount > 0 || schemaFail > 0)) {
    console.error("\n[check] 存在 block 级问题，退出码 1（未写出 lexicon.json）");
    process.exit(1);
  }

  // 读旧版本号做单调递增（离线；DB 发布链路另有 content_release）
  const outPath = path.join(rootDir, "content/.compiled/lexicon.json");
  let version = 1;
  if (existsSync(outPath)) {
    try {
      const prev = JSON.parse(readFileSync(outPath, "utf8")) as LexiconManifest;
      if (typeof prev.version === "number") version = prev.version + 1;
    } catch { /* ignore */ }
  }

  const canonical = stableStringify(entries);
  const checksum = createHash("sha256").update(canonical).digest("hex");
  const manifest: LexiconManifest = {
    version,
    checksum,
    generatedAt: new Date().toISOString(),
    count: entries.length,
    entries,
  };
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(manifest, null, 2), "utf8");
  console.log(`\n✓ 写出 lexicon.json：version=${version} count=${entries.length} checksum=${checksum.slice(0, 12)}…`);
}

function main(): void {
  const rootDir = findRepoRoot();
  const args = process.argv.slice(2);
  if (args[0] === "bootstrap") {
    bootstrap(rootDir);
    return;
  }
  const fileIdx = args.indexOf("--file");
  const fileArg = fileIdx >= 0 ? args[fileIdx + 1] : undefined;
  const onlyFile = fileIdx >= 0 && fileArg ? path.resolve(rootDir, fileArg) : null;
  const checkOnly = args.includes("--check") || onlyFile !== null;
  const cleanOnly = args.includes("--clean-candidates");
  compile(rootDir, checkOnly, onlyFile, cleanOnly);
}

main();

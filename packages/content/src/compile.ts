/**
 * M2-4 内容编译 upsert + content_release 版本机制
 * ─────────────────────────────────────────────────────────────────
 * 流程：content/terms/*.mdx → CI 硬门校验(validateTerm) → 编译为词条对象
 *   → 写出客户端词典 lexicon.json（含 version/checksum）
 *   → 幂等 upsert 到 DB（term/sense/alias/term_version，冲突更新并 version+1）
 *   → 登记 content_release（kind=lexicon，version 单调递增 + checksum）
 *
 * 运行模式：
 *   - 设置 DATABASE_URL：写库 + 登记发布批次（生产 content-publish 流水线）。
 *   - 未设置 DATABASE_URL：仅生成 lexicon.json（离线预览 / 本地调试），不写库。
 *
 * 用法：npm run compile --workspace=@jargon/content
 */
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import matter from "gray-matter";
import { z } from "zod";
import { and, eq, lt, sql } from "drizzle-orm";
import {
  termFrontMatterObject,
  refineTermFrontMatter,
  senseSchema,
} from "./schema";
import { loadRules, validateTerm } from "./validate";
import { normalize } from "@jargon/matcher";
import { findRepoRoot } from "./paths";
import type {
  CategoryL1,
  LexiconAlias,
  LexiconEntry,
  SenseView,
  TermDifficulty,
} from "@jargon/contracts";

type Freq = "high" | "mid" | "low";
type AliasTypeDb =
  | "primary"
  | "cn_alias"
  | "en_alias"
  | "pinyin_abbr"
  | "pinyin_full"
  | "colloquial"
  | "misspell";

// 词频档 → 热度分（§3.1 tie-break / §3.4 建议生成）
const POPULARITY_BY_FREQ: Record<Freq, number> = {
  high: 1000,
  mid: 600,
  low: 300,
};

// ── 编译期输入 schema（在词条 front-matter 基础上扩展义项/别名/词频）────────
const aliasInputSchema = z.object({
  raw: z.string().min(1),
  aliasType: z
    .enum([
      "primary",
      "cn_alias",
      "en_alias",
      "pinyin_abbr",
      "pinyin_full",
      "colloquial",
      "misspell",
    ])
    .default("cn_alias"),
  normKey: z.string().optional(),
});

const compileSenseSchema = senseSchema.extend({
  regulatory_flags: z.enum(["yes", "no"]).default("no"),
  frequency: z.enum(["high", "mid", "low"]).default("mid"),
});

const compileTermBase = termFrontMatterObject.extend({
  senses: z.array(compileSenseSchema).optional(),
  aliases: z.array(aliasInputSchema).optional(),
  frequency: z.enum(["high", "mid", "low"]).default("mid"),
});
export const compileTermSchema = compileTermBase.superRefine(refineTermFrontMatter);

type CompileTermInput = z.infer<typeof compileTermSchema>;

// ── 编译产物（同时服务客户端词典与 DB 写入）──────────────────────────────
interface DbSense {
  senseKey: string;
  isPrimary: boolean;
  plainExplain: string;
  example: string | null;
  notMeaning: string | null;
  regulatoryFlags: string;
  frequency: Freq;
}
interface DbAlias {
  raw: string;
  aliasType: AliasTypeDb;
  normKey: string;
}
interface Compiled {
  slug: string;
  headword: string;
  category_l1: CategoryL1;
  category_l2: string;
  difficulty: TermDifficulty;
  summaryPlain: string;
  riskNote: string | null;
  frequency: Freq;
  senses: DbSense[];
  aliases: DbAlias[];
  entry: LexiconEntry;
  snapshot: Record<string, unknown>;
}

function buildCompiled(fm: CompileTermInput): Compiled {
  const hasSenses = Array.isArray(fm.senses) && fm.senses.length > 0;

  const senseViews: SenseView[] = hasSenses
    ? fm.senses!.map((s) => ({
        senseKey: s.sense_key,
        plainExplain: s.plain_explain,
        example: s.example,
        notMeaning: s.not_meaning,
        isPrimary: s.is_primary,
        contextKeywords: s.context_keywords,
        frequency: s.frequency,
      }))
    : [
        {
          senseKey: "default",
          plainExplain: fm.plain_explain,
          example: fm.example,
          notMeaning: fm.not_meaning,
          isPrimary: true,
          frequency: fm.frequency,
        },
      ];

  const dbSenses: DbSense[] = hasSenses
    ? fm.senses!.map((s) => ({
        senseKey: s.sense_key,
        isPrimary: s.is_primary,
        plainExplain: s.plain_explain,
        example: s.example ?? null,
        notMeaning: s.not_meaning ?? null,
        regulatoryFlags: s.regulatory_flags,
        frequency: s.frequency,
      }))
    : [
        {
          senseKey: "default",
          isPrimary: true,
          plainExplain: fm.plain_explain,
          example: fm.example ?? null,
          notMeaning: fm.not_meaning ?? null,
          regulatoryFlags: fm.regulatory_flags,
          frequency: fm.frequency,
        },
      ];

  const primarySense = senseViews.find((s) => s.isPrimary) ?? senseViews[0];

  const lexAliases: LexiconAlias[] = [{ raw: fm.headword, aliasType: "primary" }];
  for (const a of fm.aliases ?? []) {
    if (a.raw === fm.headword) continue; // 避免与 primary 重复
    lexAliases.push({ raw: a.raw, aliasType: a.aliasType });
  }
  const dbAliases: DbAlias[] = lexAliases.map((a) => ({
    raw: a.raw,
    aliasType: a.aliasType,
    normKey: a.normKey ?? normalize(a.raw).norm,
  }));

  const entry: LexiconEntry = {
    slug: fm.slug,
    headword: fm.headword,
    categoryL1: fm.category_l1,
    categoryL2: fm.category_l2,
    difficulty: fm.difficulty,
    summaryPlain: primarySense.plainExplain,
    riskNote: fm.risk_note,
    frequency: fm.frequency,
    popularity: POPULARITY_BY_FREQ[fm.frequency],
    senses: senseViews,
    aliases: lexAliases,
  };

  const snapshot: Record<string, unknown> = {
    slug: fm.slug,
    headword: fm.headword,
    category_l1: fm.category_l1,
    category_l2: fm.category_l2,
    difficulty: fm.difficulty,
    plain_explain: fm.plain_explain,
    example: fm.example,
    not_meaning: fm.not_meaning,
    regulatory_flags: fm.regulatory_flags,
    risk_note: fm.risk_note,
    author: fm.author,
    reviewer: fm.reviewer,
    review_date: fm.review_date,
    compliance_approved: fm.compliance_approved,
    frequency: fm.frequency,
    senses: fm.senses ?? null,
    aliases: fm.aliases ?? null,
  };

  return {
    slug: fm.slug,
    headword: fm.headword,
    category_l1: fm.category_l1,
    category_l2: fm.category_l2,
    difficulty: fm.difficulty,
    summaryPlain: primarySense.plainExplain,
    riskNote: fm.risk_note ?? null,
    frequency: fm.frequency,
    senses: dbSenses,
    aliases: dbAliases,
    entry,
    snapshot,
  };
}

// 稳定序列化（排序键），保证相同内容 → 相同 checksum
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k]))
      .join(",") +
    "}"
  );
}

// ── DB 幂等 upsert（仅在 DATABASE_URL 存在时调用）────────────────────────
async function upsertCompiled(
  mod: typeof import("@jargon/db"),
  c: Compiled,
): Promise<void> {
  const { db, term, sense, alias, termVersion } = mod;

  // 1) term：按 slug 幂等冲突更新，version+1
  const [trow] = await db
    .insert(term)
    .values({
      slug: c.slug,
      categoryL1: c.category_l1,
      categoryL2: c.category_l2,
      difficulty: c.difficulty,
      status: "published",
      summaryPlain: c.summaryPlain,
      riskNote: c.riskNote,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: term.slug,
      set: {
        categoryL1: c.category_l1,
        categoryL2: c.category_l2,
        difficulty: c.difficulty,
        status: "published",
        summaryPlain: c.summaryPlain,
        riskNote: c.riskNote,
        version: sql`${term.version} + 1`,
        updatedAt: new Date(),
      },
    })
    .returning({ id: term.id, version: term.version });

  const termId = trow.id;
  const termVer = trow.version;

  // 2) sense：按 (termId, senseKey) 幂等冲突更新
  let primarySenseId: string | null = null;
  for (const s of c.senses) {
    const [srow] = await db
      .insert(sense)
      .values({
        termId,
        senseKey: s.senseKey,
        isPrimary: s.isPrimary,
        plainExplain: s.plainExplain,
        example: s.example,
        notMeaning: s.notMeaning,
        regulatoryFlags: s.regulatoryFlags,
        frequency: s.frequency,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [sense.termId, sense.senseKey],
        set: {
          isPrimary: s.isPrimary,
          plainExplain: s.plainExplain,
          example: s.example,
          notMeaning: s.notMeaning,
          regulatoryFlags: s.regulatoryFlags,
          frequency: s.frequency,
          updatedAt: new Date(),
        },
      })
      .returning({ id: sense.id });
    if (s.isPrimary) primarySenseId = srow.id;
  }
  if (primarySenseId) {
    await db.update(term).set({ primarySenseId }).where(eq(term.id, termId));
  }

  // 3) alias：先删后插（保持幂等；primary 的 normKey 全局唯一由 DB 部分唯一索引保证）
  await db.delete(alias).where(eq(alias.termId, termId));
  for (const a of c.aliases) {
    await db.insert(alias).values({
      termId,
      senseId: null,
      normKey: a.normKey,
      raw: a.raw,
      aliasType: a.aliasType,
    });
  }

  // 4) term_version 快照（按 termId+version 幂等覆盖）
  await db
    .delete(termVersion)
    .where(and(eq(termVersion.termId, termId), eq(termVersion.version, termVer)));
  await db.insert(termVersion).values({
    termId,
    version: termVer,
    snapshot: c.snapshot,
  });
}

async function main(): Promise<void> {
  const rootDir = findRepoRoot();
  const contentDir = path.join(rootDir, "content/terms");
  const outDir = path.join(rootDir, "content/.compiled");
  const rules = loadRules(rootDir);

  if (!existsSync(contentDir)) {
    console.error(`未找到词条目录：${contentDir}`);
    process.exit(2);
  }

  const files = readdirSync(contentDir).filter((f) => f.endsWith(".mdx"));
  const compiled: Compiled[] = [];
  let blocked = 0;

  for (const f of files) {
    const raw = readFileSync(path.join(contentDir, f), "utf8");
    const { data, content } = matter(raw);
    const v = validateTerm(data, content, rules);
    if (!v.valid) {
      blocked++;
      console.error(`✗ ${f} (${v.slug}) 校验未通过，跳过发布：`);
      for (const i of v.issues) {
        if (i.severity === "block") {
          console.error(`    [block] ${i.rule}: ${i.message}`);
        }
      }
      continue;
    }
    const fm = compileTermSchema.parse(data);
    compiled.push(buildCompiled(fm));
    console.log(`✓ ${f} (${fm.slug}) 已编译`);
  }

  if (compiled.length === 0) {
    console.error(`\n无可发布的词条（阻断 ${blocked} 个）。`);
    process.exit(1);
  }

  // 稳定序列化 → checksum
  const canonical = stableStringify(compiled.map((c) => c.entry));
  const checksum = createHash("sha256").update(canonical).digest("hex");

  // 写出客户端词典（无论是否写库都产出，供 /api/lexicon 与本地预览）
  mkdirSync(outDir, { recursive: true });

  const databaseUrl = process.env.DATABASE_URL;
  let version = 0;

  if (!databaseUrl) {
    console.warn("[offline] DATABASE_URL 未设置，仅生成 lexicon.json（不写库）。");
  } else {
    const mod = await import("@jargon/db");
    for (const c of compiled) {
      await upsertCompiled(mod, c);
    }

    // content_release：kind=lexicon 的 version 单调递增
    const [maxRow] = await mod.db
      .select({
        v: sql<number>`coalesce(max(${mod.contentRelease.version}), 0)`,
      })
      .from(mod.contentRelease)
      .where(eq(mod.contentRelease.kind, "lexicon"));
    version = (maxRow?.v ?? 0) + 1;

    const [rel] = await mod.db
      .insert(mod.contentRelease)
      .values({
        kind: "lexicon",
        version,
        checksum,
        status: "current",
      })
      .returning({ id: mod.contentRelease.id });

    // 旧批次标记为 superseded（同一 kind 仅保留一个 current）
    await mod.db
      .update(mod.contentRelease)
      .set({ status: "superseded" })
      .where(
        and(
          eq(mod.contentRelease.kind, "lexicon"),
          lt(mod.contentRelease.version, version),
        ),
      );

    console.log(
      `✓ content_release version=${version} checksum=${checksum.slice(0, 12)}… id=${rel.id}`,
    );
  }

  const manifest = {
    version,
    checksum,
    generatedAt: new Date().toISOString(),
    count: compiled.length,
    entries: compiled.map((c) => c.entry),
  };
  writeFileSync(
    path.join(outDir, "lexicon.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );

  console.log(
    `\n编译完成：发布 ${compiled.length} 个词条，阻断 ${blocked} 个；lexicon.json → ${outDir}`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});

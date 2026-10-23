import { readFileSync } from "node:fs";
import path from "node:path";
import yaml from "yaml";
import { termFrontMatterSchema } from "./schema";

export type Severity = "block" | "review";

export interface Issue {
  field: string;
  rule: string;
  message: string;
  severity: Severity;
}

export interface TermValidationResult {
  slug: string;
  valid: boolean;
  issues: Issue[];
}

export interface Rules {
  banned: Record<string, unknown>;
  jargon: Record<string, unknown>;
}

/**
 * 加载校验规则（content-rules/ 下的 YAML）。
 * rootDir 默认 process.cwd()（即仓库根，CI 与本地一致）。
 */
export function loadRules(rootDir: string = process.cwd()): Rules {
  const banned = yaml.parse(
    readFileSync(
      path.join(rootDir, "content-rules/lexicon/banned-words.yaml"),
      "utf8",
    ),
  );
  const jargon = yaml.parse(
    readFileSync(
      path.join(rootDir, "content-rules/lexicon/jargon-dict.layer-b.yaml"),
      "utf8",
    ),
  );
  return { banned, jargon };
}

function toRegExp(pat: string): RegExp {
  const m = pat.match(/^\/(.*)\/([a-z]*)$/);
  if (m) return new RegExp(m[1] ?? pat, m[2] ?? "");
  return new RegExp(pat);
}

/** 名词化 / 否定 / 语境 豁免判定（对应 banned-words.yaml 的 N1/N2/N3） */
function isExempt(text: string, idx: number, rules: Rules): boolean {
  const banned = rules.banned as any;
  // N3 否定前缀：命中词前 6 字内出现否定词 → 放行
  for (const neg of banned.negation_prefixes ?? []) {
    const before = text.slice(Math.max(0, idx - 6), idx);
    if (before.includes(neg)) return true;
  }
  // N1 名词化后缀：命中词后紧跟名词后缀 → 放行
  for (const suf of banned.noun_suffixes ?? []) {
    if (text.slice(idx + 1, idx + 1 + suf.length) === suf) return true;
  }
  // 显式名词白名单
  for (const w of banned.noun_explicit ?? []) {
    if (text.slice(idx, idx + w.length) === w) return true;
  }
  // N2 语境指示词（±10 字）
  for (const ci of banned.context_indicators ?? []) {
    const before = text.slice(Math.max(0, idx - 10), idx);
    const after = text.slice(idx + 1, idx + 11);
    if (before.includes(ci) || after.includes(ci)) return true;
  }
  return false;
}

/**
 * 内容门（不依赖 front-matter schema，可复用于 mdx 与批量 ingestion）：
 * 强禁词 / 弱禁词+豁免 / 零黑话词典 / 祈使句式 / 举例空泛 / 免责声明。
 * fm 需提供 slug / headword / plain_explain / example / risk_note（缺省 optional）。
 */
export function runContentGates(
  fm: unknown,
  body: string,
  rules: Rules,
): Issue[] {
  const issues: Issue[] = [];
  const banned = rules.banned as any;
  const jargon = rules.jargon as any;
  const fmAny = fm as any;
  const allText = [fmAny?.plain_explain, fmAny?.example, body]
    .filter(Boolean)
    .join("\n");
  // 人话层（plain_explain + example）须零黑话；正文允许解释术语
  const humanText = [fmAny?.plain_explain, fmAny?.example]
    .filter(Boolean)
    .join("\n");

  // 1. 强禁词（任何字段都不得出现）
  for (const w of banned.strong_banned ?? []) {
    if (allText.includes(w)) {
      issues.push({
        field: "*",
        rule: "strong_banned",
        message: `包含强禁词「${w}」（C8）`,
        severity: "block",
      });
    }
  }

  // 2. 弱禁词 + 豁免（N1/N2/N3）—— 仅针对人话层
  for (const w of banned.weak_banned ?? []) {
    let idx = humanText.indexOf(w);
    while (idx !== -1) {
      if (!isExempt(humanText, idx, rules)) {
        issues.push({
          field: "*",
          rule: "weak_banned",
          message: `疑似投资建议词「${w}」（弱禁词，未豁免）`,
          severity: "block",
        });
        break;
      }
      idx = humanText.indexOf(w, idx + 1);
    }
  }

  // 3. 零黑话词典（jargon 类一律违规；contextual 类需搭配判定）—— 仅针对人话层
  const headword = fmAny?.headword ?? "";
  for (const t of jargon.terms ?? []) {
    if (!humanText.includes(t.surface)) continue;
    if (t.surface === headword) continue; // 自身是被解释对象
    if (t.kind === "jargon") {
      issues.push({
        field: "*",
        rule: "jargon_dict",
        message: `包含黑话词「${t.surface}」，需解释或替换为人话（C4）`,
        severity: "block",
      });
    } else if (t.kind === "contextual") {
      const pattern = (banned.contextual_patterns ?? []).find(
        (p: any) => p.word === t.surface,
      );
      if (pattern) {
        const hit = pattern.with.some((withWord: string) =>
          allText.includes(withWord),
        );
        if (hit) {
          issues.push({
            field: "*",
            rule: "contextual_jargon",
            message: `语境黑话「${t.surface}」搭配投资判断词，属违规`,
            severity: "block",
          });
        }
      }
    }
  }

  // 4. 祈使句式检测（plain_explain/example 字段级 block）
  if ((banned.imperative_field_policy?.plain_explain ?? "block") === "block") {
    for (const p of banned.imperative_patterns ?? []) {
      if (toRegExp(p.pattern).test(fmAny?.plain_explain ?? "") ||
          toRegExp(p.pattern).test(fmAny?.example ?? "")) {
        issues.push({
          field: "plain_explain/example",
          rule: "imperative",
          message: `祈使句式违规（${p.id}）`,
          severity: "block",
        });
        break;
      }
    }
  }

  // 5. 举例空泛提示（review）
  if (
    fmAny?.example &&
    /在股市中|一般来说|通常情况下|这个就不用多说了/.test(fmAny.example)
  ) {
    issues.push({
      field: "example",
      rule: "example_vague",
      message: "举例含空泛表述，需具体场景（C5）",
      severity: "review",
    });
  }

  // 6. 免责存在（L1/L2 合规红线）
  const hasDisclaimer =
    fmAny?.risk_note ||
    (body ?? "").includes("不构成投资建议") ||
    fmAny?.disclaimer_code;
  if (!hasDisclaimer) {
    issues.push({
      field: "disclaimer",
      rule: "disclaimer_missing",
      message: "缺少免责声明 / risk_note（L1/L2）",
      severity: "block",
    });
  }

  return issues;
}

/**
 * 校验单个词条（front-matter + 正文）。
 * 覆盖 CI 硬门：字段校验(Zod) / 强禁词 / 弱禁词+豁免 / 零黑话词典 / 祈使句式 / 字数 / 免责。
 */
export function validateTerm(
  fm: unknown,
  body: string,
  rules: Rules,
): TermValidationResult {
  const issues: Issue[] = [];
  const slug = (fm as any)?.slug ?? "(unknown)";

  // 1. Zod 字段校验（slug / 分类合法性 / C6 / C7 / C10）
  const parsed = termFrontMatterSchema.safeParse(fm);
  if (!parsed.success) {
    for (const e of parsed.error.issues) {
      issues.push({
        field: e.path.join(".") || "*",
        rule: "schema",
        message: e.message,
        severity: "block",
      });
    }
  }

  // 2-7. 内容门（与批量 ingestion 复用同一套）
  issues.push(...runContentGates(fm, body, rules));

  return {
    slug,
    valid: issues.every((i) => i.severity !== "block"),
    issues,
  };
}

import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { loadRules, validateTerm, TermValidationResult } from "./validate";
import { findRepoRoot } from "./paths";

/**
 * 批量校验 CLI：扫描 content/terms/*.mdx，跑 CI 硬门校验。
 * 用法：npm run validate --workspace=@jargon/content
 * 退出码：有阻断项 → 1；全通过 → 0。
 */
const rootDir = findRepoRoot();
const contentDir = path.join(rootDir, "content/terms");
const rules = loadRules(rootDir);

if (!existsSync(contentDir)) {
  console.error(`未找到词条目录：${contentDir}`);
  process.exit(2);
}

const files = readdirSync(contentDir).filter((f) => f.endsWith(".mdx"));
let total = 0;
let blocked = 0;
const results: TermValidationResult[] = [];

for (const f of files) {
  const raw = readFileSync(path.join(contentDir, f), "utf8");
  const { data, content } = matter(raw);
  const result = validateTerm(data, content, rules);
  results.push(result);
  total++;
  if (!result.valid) {
    blocked++;
    console.error(`✗ ${f} (${result.slug})`);
    for (const i of result.issues) {
      console.error(`    [${i.severity}] ${i.rule}: ${i.message}`);
    }
  } else {
    console.log(`✓ ${f} (${result.slug})`);
  }
}

console.log(`\n校验完成：${total} 个词条，${blocked} 个阻断，退出码 ${blocked > 0 ? 1 : 0}`);
process.exit(blocked > 0 ? 1 : 0);

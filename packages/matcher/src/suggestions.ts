/**
 * 未命中建议生成（backend-implementation §3.4 三层级联）。
 * 约束：建议必须是库内真实词条（产品 R4「无结果不猜测」），每条带 source+reason
 * 以便运营作为「词库缺口探针」。
 */
import type { LexiconEntry } from "@jargon/contracts";
import type { Suggestion } from "./types";

/** Levenshtein 编辑距离 */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = (a[i - 1] ?? "") === (b[j - 1] ?? "") ? 0 : 1;
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n] ?? 0;
}

interface CandidateRow {
  entry: LexiconEntry;
  aliasKey: string;
}

export function generateSuggestions(
  queryNorm: string,
  entries: LexiconEntry[],
): Suggestion[] {
  // 别名 normKey 展开（用于编辑距离召回）
  const rows: CandidateRow[] = [];
  for (const e of entries) {
    for (const a of e.aliases) {
      rows.push({ entry: e, aliasKey: a.raw.toLowerCase() });
    }
  }
  const popularAll = [...entries].sort((a, b) => b.popularity - a.popularity);

  const picked = new Map<string, Suggestion>();

  // Layer 1 · edit_distance（配额 2）
  const maxDist = queryNorm.length <= 4 ? 1 : 2;
  const edHits = rows
    .map((r) => ({ r, d: editDistance(queryNorm, r.aliasKey) }))
    .filter((x) => x.d <= maxDist)
    .sort(
      (a, b) =>
        a.d - b.d ||
        b.r.entry.popularity - a.r.entry.popularity ||
        a.r.entry.slug.localeCompare(b.r.entry.slug),
    )
    .slice(0, 2);
  for (const { r } of edHits) {
    if (!picked.has(r.entry.slug)) {
      picked.set(r.entry.slug, {
        slug: r.entry.slug,
        headword: r.entry.headword,
        source: "edit_distance",
        reason: "拼写相近，可能打错了",
      });
    }
  }

  // Layer 2 · same_category（配额 2）
  const seedCats = edHits.length
    ? Array.from(new Set(edHits.map((x) => x.r.entry.categoryL1)))
    : popularAll.slice(0, 3).map((e) => e.categoryL1);
  const catPool = [...entries].sort(
    (a, b) => b.popularity - a.popularity,
  );
  let catCount = 0;
  for (const cat of seedCats) {
    for (const e of catPool) {
      if (e.categoryL1 === cat && !picked.has(e.slug)) {
        picked.set(e.slug, {
          slug: e.slug,
          headword: e.headword,
          source: "same_category",
          reason: `同属「${e.categoryL1}」分类`,
        });
        catCount++;
        break;
      }
    }
    if (catCount >= 2) break;
  }

  // Layer 3 · popular（配额 1，兜底补齐）
  for (const e of popularAll) {
    if (!picked.has(e.slug)) {
      picked.set(e.slug, {
        slug: e.slug,
        headword: e.headword,
        source: "popular",
        reason: "热门词条",
      });
      break;
    }
  }

  // 不足 3 条用热门表顺序补齐
  for (const e of popularAll) {
    if (picked.size >= 3) break;
    if (!picked.has(e.slug)) {
      picked.set(e.slug, {
        slug: e.slug,
        headword: e.headword,
        source: "popular",
        reason: "热门词条",
      });
    }
  }

  return Array.from(picked.values()).slice(0, 3);
}

import type { Metadata } from "next";
import { getLexiconManifest, getServerMatcher } from "@/lib/server-data";
import { SearchBar } from "@/components/SearchBar";
import { TermCard } from "@/components/TermCard";
import { HighlightedText } from "@/components/HighlightedText";
import { DisclaimerBanner } from "@/components/DisclaimerBanner";
import Link from "next/link";

interface SearchParams {
  q?: string;
  category?: string;
}

export const dynamic = "force-dynamic";

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}): Promise<Metadata> {
  const { q } = await searchParams;
  if (!q) return { title: "搜索" };
  const r = getServerMatcher().search(q.trim());
  // 唯一精确命中 → canonical 收敛到详情页（避免与详情页争权重）
  const first = r.matched[0];
  if (r.matched.length === 1 && r.inputKind === "word" && first?.matchType === "exact") {
    return {
      title: first.headword,
      alternates: { canonical: `/terms/${first.slug}` },
    };
  }
  return { title: `“${q.trim()}” 的搜索结果`, robots: { index: false, follow: true } };
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { q, category } = await searchParams;

  let heading = "搜索";
  let cards: React.ReactNode = null;
  let highlight: React.ReactNode = null;
  let missNote: React.ReactNode = null;

  if (q && q.trim()) {
    const query = q.trim();
    heading = `“${query}” 的搜索结果`;
    const r = getServerMatcher().search(query);

    if (r.inputKind === "sentence" && r.spans && r.spans.length > 0) {
      highlight = (
        <div className="card p-4">
          <HighlightedText
            text={query}
            spans={r.spans.map((s) => ({
              start: s.start,
              end: s.end,
              slug: s.slug,
              raw: s.raw,
              isLowConfidence: s.isLowConfidence,
            }))}
          />
          <p className="mt-2 text-xs text-[var(--color-muted)]" aria-live="polite">
            识别到 {r.spans.length} 个术语（点击高亮查看释义）。
          </p>
        </div>
      );
    }

    if (r.matched.length > 0) {
      cards = (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {r.matched.map((m) => (
            <TermCard
              key={m.slug}
              slug={m.slug}
              headword={m.headword}
              categoryL1={m.categoryL1}
              categoryL2={m.categoryL2}
              difficulty={m.difficulty}
              plainExplain={m.plainExplain}
              riskNote={m.riskNote}
            />
          ))}
        </div>
      );
    } else {
      if (r.suggestions.length > 0) {
        missNote = (
          <div className="card p-4">
            <p className="text-sm font-medium text-[var(--color-fg)]">没找到完全匹配的，你可能想看：</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {r.suggestions.map((s) => (
                <Link
                  key={s.slug}
                  href={`/terms/${s.slug}`}
                  className="rounded-full border border-[var(--color-border)] bg-white px-3 py-1.5 text-sm transition hover:border-[var(--brand-ring)] hover:text-[var(--brand-strong)]"
                >
                  {s.headword}
                </Link>
              ))}
            </div>
          </div>
        );
      } else {
        missNote = (
          <div className="card p-4 text-sm text-[var(--color-body)]">
            这个词我们还没收录。你可以换个说法再搜一次，或浏览下面的分类。
          </div>
        );
      }
    }
  } else if (category) {
    heading = `分类：${category}`;
    const filtered = getLexiconManifest().entries.filter((e) => e.categoryL1 === category);
    if (filtered.length > 0) {
      cards = (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {filtered.map((e) => (
            <TermCard
              key={e.slug}
              slug={e.slug}
              headword={e.headword}
              categoryL1={e.categoryL1}
              categoryL2={e.categoryL2}
              difficulty={e.difficulty}
              plainExplain={e.summaryPlain}
              riskNote={e.riskNote}
            />
          ))}
        </div>
      );
    } else {
      missNote = (
        <div className="card p-4 text-sm text-[var(--color-body)]">该分类下暂无词条。</div>
      );
    }
  } else {
    missNote = (
      <div className="card p-4 text-sm text-[var(--color-body)]">
        请输入一个术语，或选择一个分类开始浏览。
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <SearchBar variant="inline" initialQuery={q ?? ""} />
      <h1 className="text-lg font-bold tracking-tight text-[var(--color-fg)]">{heading}</h1>
      {highlight}
      {cards}
      {missNote}
      <DisclaimerBanner variant="line" />
    </div>
  );
}

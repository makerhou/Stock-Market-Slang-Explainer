import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { getEntryBySlug, getLexiconManifest } from "@/lib/server-data";
import { SenseTabs } from "@/components/SenseTabs";
import { RiskNote } from "@/components/RiskNote";
import { DisclaimerBanner } from "@/components/DisclaimerBanner";
import { VizPlayer } from "@/components/viz/VizPlayer";
import { InsightCard } from "@/components/InsightCard";

// 万级词条可扩展：仅预热热度最高的 Top-N 为静态页，其余按需渲染 + ISR 缓存，
// 避免 9000 条全量 SSG 导致每次构建渲染 9000 页。
export const dynamicParams = true;
export const revalidate = 86400; // 1 天

const PRERENDER_TOP_N = 500;

const DIFF_LABEL: Record<string, string> = {
  L1: "入门",
  L2: "进阶",
  L3: "专业",
};

const DIFF_STYLE: Record<string, string> = {
  L1: "bg-emerald-50 text-emerald-700",
  L2: "bg-indigo-50 text-indigo-700",
  L3: "bg-amber-50 text-amber-700",
};

export function generateStaticParams() {
  return getLexiconManifest()
    .entries.slice()
    .sort((a, b) => b.popularity - a.popularity || a.slug.localeCompare(b.slug))
    .slice(0, PRERENDER_TOP_N)
    .map((e) => ({ slug: e.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const entry = getEntryBySlug(slug);
  if (!entry) return { title: "未收录" };
  return {
    title: entry.headword,
    description: entry.summaryPlain,
    alternates: { canonical: `/terms/${entry.slug}` },
  };
}

export default async function TermDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const entry = getEntryBySlug(slug);
  if (!entry) notFound();

  const primary = entry.senses.find((s) => s.isPrimary) ?? entry.senses[0];
  const multiSense = entry.senses.length > 1;
  const reviewHref = `/quiz/review?termIds=t_${entry.slug.replace(/-/g, "_")}`;

  // Schema.org DefinedTerm（SEO）
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "DefinedTerm",
    name: entry.headword,
    description: entry.summaryPlain,
    inDefinedTermSet: { "@type": "DefinedTermSet", name: "股票黑话解释器" },
  };

  return (
    <article className="flex flex-col gap-5">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />

      {/* 面包屑 */}
      <nav aria-label="面包屑" className="flex flex-wrap items-center text-xs text-[var(--color-muted)]">
        <Link href="/" className="hover:text-[var(--color-fg)]">首页</Link>
        <span className="mx-1">/</span>
        <Link href={`/s?category=${encodeURIComponent(entry.categoryL1)}`} className="hover:text-[var(--color-fg)]">
          {entry.categoryL1}
        </Link>
        <span className="mx-1">/</span>
        <span className="text-[var(--color-fg)]">{entry.headword}</span>
      </nav>

      {/* 头部 hero 卡 */}
      <header className="card animate-pop p-5">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-2xl font-bold tracking-tight text-[var(--color-fg)]">{entry.headword}</h1>
          <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${DIFF_STYLE[entry.difficulty] ?? "bg-slate-100 text-slate-600"}`}>
            {DIFF_LABEL[entry.difficulty] ?? entry.difficulty}
          </span>
        </div>
        <p className="mt-1.5 text-sm text-[var(--color-muted)]">
          {entry.categoryL1}
          {entry.categoryL2 ? ` · ${entry.categoryL2}` : ""}
        </p>
        {multiSense ? (
          <p className="mt-3 rounded-lg bg-[var(--brand-soft)] px-3 py-2 text-sm font-medium text-[var(--brand-strong)]">
            该词有 {entry.senses.length} 个意思，下方可切换查看。
          </p>
        ) : null}
      </header>

      <SenseTabs senses={entry.senses} />

      <VizPlayer viz={entry.viz} />

      <InsightCard insights={entry.insights} />

      {entry.riskNote ? <RiskNote note={entry.riskNote} /> : null}

      {/* 试一题 CTA */}
      <Link
        href={reviewHref}
        className="btn btn-primary w-full"
      >
        🎯 用这个词考考你
      </Link>

      <DisclaimerBanner variant="line" />
    </article>
  );
}

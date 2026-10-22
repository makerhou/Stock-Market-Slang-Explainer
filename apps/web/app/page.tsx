import Link from "next/link";
import { getLexiconManifest } from "@/lib/server-data";
import { SearchBar } from "@/components/SearchBar";
import { CategoryNav } from "@/components/CategoryNav";
import { DisclaimerBanner } from "@/components/DisclaimerBanner";
import { TermCard } from "@/components/TermCard";

export const dynamic = "force-static";

export default function HomePage() {
  const manifest = getLexiconManifest();
  const entries = manifest.entries;

  // 热门术语：按热度分降序取前 8
  const hot = [...entries].sort((a, b) => b.popularity - a.popularity).slice(0, 8);

  // 分类聚合（L1 + 数量）
  const catMap = new Map<string, number>();
  for (const e of entries) catMap.set(e.categoryL1, (catMap.get(e.categoryL1) ?? 0) + 1);
  const categories = [...catMap.entries()]
    .map(([l1, count]) => ({ l1, count }))
    .sort((a, b) => b.count - a.count);

  return (
    <div className="flex flex-col gap-8">
      {/* Hero：品牌渐变面板 + 全局搜索入口 */}
      <section className="brand-gradient animate-pop -mx-4 rounded-3xl px-5 pb-7 pt-8 text-white shadow-[0_24px_60px_-24px_rgba(67,56,202,0.7)] sm:-mx-6 sm:px-8">
        <p className="text-sm font-medium text-indigo-100">股票黑话解释器</p>
        <h1 className="mt-1 text-2xl font-bold leading-snug tracking-tight sm:text-[1.75rem]">
          听不懂股票黑话？<br className="sm:hidden" />一句话讲明白
        </h1>
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-indigo-100">
          输入你听到的术语，或粘贴一句话，我们用大白话 + 举例解释清楚。
        </p>
        <div className="mt-5 max-w-xl">
          <SearchBar variant="hero" autoFocus />
        </div>
        <ul className="mt-4 flex max-w-xl flex-wrap gap-x-4 gap-y-1.5 text-xs text-indigo-100">
          <li>· 不荐股</li>
          <li>· 不预测涨跌</li>
          <li>· 不构成投资建议</li>
        </ul>
      </section>

      {/* 热门术语 */}
      {hot.length > 0 ? (
        <section>
          <h2 className="section-title mb-3">今天先学这些</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {hot.map((t) => (
              <TermCard
                key={t.slug}
                slug={t.slug}
                headword={t.headword}
                categoryL1={t.categoryL1}
                categoryL2={t.categoryL2}
                difficulty={t.difficulty}
                plainExplain={t.summaryPlain}
                riskNote={t.riskNote}
                variant="compact"
              />
            ))}
          </div>
        </section>
      ) : null}

      {/* 分类入口 */}
      {categories.length > 0 ? (
        <section>
          <h2 className="section-title mb-3">按分类浏览</h2>
          <CategoryNav items={categories} />
        </section>
      ) : null}

      <DisclaimerBanner variant="line" />
    </div>
  );
}

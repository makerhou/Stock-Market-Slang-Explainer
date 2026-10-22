import Link from "next/link";

export interface TermCardProps {
  slug: string;
  headword: string;
  categoryL1: string;
  categoryL2?: string;
  difficulty: string;
  plainExplain: string;
  riskNote?: string;
  variant?: "full" | "compact";
}

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

/** 术语卡片：搜索结果列表项 / 相关词展示 */
export function TermCard({
  slug,
  headword,
  categoryL1,
  categoryL2,
  difficulty,
  plainExplain,
  riskNote,
  variant = "full",
}: TermCardProps) {
  return (
    <Link
      href={`/terms/${slug}`}
      className="card group block p-4 transition-all duration-150 hover:-translate-y-0.5 hover:shadow-[0_24px_48px_-22px_rgba(79,70,229,0.30)]"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-base font-bold tracking-tight text-[var(--color-fg)]">{headword}</h3>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${
            DIFF_STYLE[difficulty] ?? "bg-slate-100 text-slate-600"
          }`}
        >
          {DIFF_LABEL[difficulty] ?? difficulty}
        </span>
      </div>
      <p className="mt-1 text-xs font-medium text-[var(--color-muted)]">
        {categoryL1}
        {categoryL2 ? ` · ${categoryL2}` : ""}
      </p>
      <p className="mt-2 text-sm leading-relaxed text-[var(--color-body)] line-clamp-2">
        {plainExplain}
      </p>
      {variant === "full" && riskNote ? (
        <p className="mt-2 text-xs text-[var(--color-risk-fg)] line-clamp-1">⚠ {riskNote}</p>
      ) : null}
    </Link>
  );
}

import Link from "next/link";
import type { MistakeEntry } from "@jargon/quiz";

export function MistakeList({ items }: { items: MistakeEntry[] }) {
  if (items.length === 0) {
    return (
      <div className="card flex flex-col items-center gap-1 px-6 py-8 text-center">
        <span aria-hidden className="text-2xl">🌱</span>
        <p className="text-sm font-medium text-emerald-700">还没有错题 —— 这是好事。</p>
      </div>
    );
  }
  return (
    <ul className="space-y-3">
      {items.map((m) => (
        <li key={m.termId} className="card p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-base font-semibold text-[var(--color-fg)]">{m.termName}</span>
                <span className="rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-600">
                  错 {m.wrongCount} 次
                </span>
              </div>
              <p className="mt-1 line-clamp-2 text-sm text-[var(--color-muted)]">{m.gloss}</p>
            </div>
            <div className="flex shrink-0 flex-col gap-2">
              <Link
                href={`/quiz/review?termIds=${m.termId}`}
                className="rounded-lg bg-[var(--brand)] px-3 py-1.5 text-center text-xs font-semibold text-white transition-colors hover:bg-[var(--brand-strong)]"
              >
                重做这题
              </Link>
              <Link
                href={`/terms/${m.termSlug}`}
                className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-center text-xs font-medium text-[var(--color-muted)] transition-colors hover:bg-slate-50"
              >
                看解释
              </Link>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

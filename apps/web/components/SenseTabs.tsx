"use client";

/**
 * 义项切换（frontend-design §2.3 / F4 / S3）。
 * 一词多义时首屏必须显性提示「该词有 N 个意思」。
 */
import { useState } from "react";
import type { SenseView } from "@jargon/contracts";

export function SenseTabs({ senses }: { senses: SenseView[] }) {
  const [active, setActive] = useState(() => {
    const idx = senses.findIndex((s) => s.isPrimary);
    return idx >= 0 ? idx : 0;
  });

  const current = senses[active] ?? senses[0];
  if (!current) return null; // senses 为空时不渲染
  const multi = senses.length > 1;

  return (
    <div>
      {multi ? (
        <div role="tablist" aria-label="义项切换" className="mb-3 flex flex-wrap gap-2">
          {senses.map((s, i) => (
            <button
              key={s.senseKey}
              role="tab"
              aria-selected={i === active}
              onClick={() => setActive(i)}
              className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition ${
                i === active
                  ? "bg-[var(--brand)] text-white shadow-sm"
                  : "border border-[var(--color-border)] bg-white text-[var(--color-body)] hover:border-[var(--brand-ring)]"
              }`}
            >
              {s.senseKey === "default" ? "通用释义" : s.senseKey}
            </button>
          ))}
        </div>
      ) : null}

      <div className="card p-5">
        <p className="text-lg leading-relaxed text-[var(--color-fg)]">{current.plainExplain}</p>

        {current.example ? (
          <div className="mt-4 rounded-xl bg-[var(--color-bg)] px-4 py-3 text-sm leading-relaxed text-[var(--color-body)]">
            <span className="font-semibold text-[var(--color-fg)]">📝 举例</span>
            <p className="mt-1">{current.example}</p>
          </div>
        ) : null}

        {current.notMeaning ? (
          <div className="mt-3 rounded-xl border border-[var(--color-border)] px-4 py-3 text-sm leading-relaxed text-[var(--color-muted)]">
            <span className="font-semibold text-[var(--color-fg)]">它不是</span>
            <p className="mt-1">{current.notMeaning}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

"use client";

import { useMemo, useState } from "react";
import { useProgress, useProgressSnapshot } from "@/lib/use-progress";
import { useLexicon } from "@/lib/lexicon-client";
import { MistakeList } from "@/components/MistakeList";
import { DisclaimerBanner } from "@/components/DisclaimerBanner";
import type { MistakeEntry } from "@jargon/quiz";

export function MistakesView() {
  const snap = useProgressSnapshot();
  const store = useProgress();
  const { manifest } = useLexicon();
  const [showMastered, setShowMastered] = useState(false);

  const withGloss = (m: MistakeEntry): MistakeEntry => ({
    ...m,
    termName: m.termName || m.termSlug,
    gloss: m.gloss || manifest?.entries.find((e) => e.slug === m.termSlug)?.summaryPlain || "",
  });

  const mistakes = useMemo<MistakeEntry[]>(() => {
    if (!snap) return [];
    return Object.values(snap.mistakes)
      .filter((m) => m.inDefaultList)
      .map(withGloss);
  }, [snap, manifest]);

  const mastered = useMemo<MistakeEntry[]>(() => {
    if (!snap) return [];
    return Object.values(snap.mistakes)
      .filter((m) => m.mastered && !m.inDefaultList)
      .map(withGloss);
  }, [snap, manifest]);

  const total = mistakes.length + mastered.length;

  const clearAll = () => {
    if (!store) return;
    if (window.confirm("确定清空学习记录吗？进度、错题本、连对都会被清除（设置会保留）。")) {
      store.clearAllLearningData();
    }
  };

  return (
    <div className="space-y-5">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-[var(--color-fg)]">错题本</h1>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            已掌握 <span className="font-semibold text-emerald-600">{mastered.length}</span> / 共 {total}　·　待复习{" "}
            <span className="font-semibold text-rose-600">{mistakes.length}</span>
          </p>
        </div>
        <button
          onClick={clearAll}
          className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium text-[var(--color-muted)] transition-colors hover:bg-slate-50"
        >
          清空我的记录
        </button>
      </header>

      <section className="card p-4">
        <h2 className="mb-3 text-sm font-semibold text-[var(--color-fg)]">待复习（{mistakes.length}）</h2>
        <MistakeList items={mistakes} />
      </section>

      <section>
        <button
          onClick={() => setShowMastered((v) => !v)}
          className="card flex w-full items-center justify-between px-4 py-3 text-sm font-medium text-[var(--color-body)]"
        >
          <span>已掌握（{mastered.length}）</span>
          <span className="text-[var(--color-faint)]">{showMastered ? "收起 ▲" : "展开 ▼"}</span>
        </button>
        {showMastered && (
          <div className="mt-2">
            <MistakeList items={mastered} />
          </div>
        )}
      </section>

      <p className="rounded-xl bg-slate-50 px-4 py-3 text-xs leading-relaxed text-[var(--color-muted)]">
        答对 1 次就算掌握，会移出复习列表。想再看一次，可以在「已掌握」里放回复习。
      </p>

      <DisclaimerBanner />
    </div>
  );
}

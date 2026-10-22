"use client";

import { LEVELS } from "@jargon/quiz";
import { useProgressSnapshot } from "@/lib/use-progress";
import { LevelCard } from "@/components/LevelCard";
import { DisclaimerBanner } from "@/components/DisclaimerBanner";

export default function LevelsPage() {
  const snap = useProgressSnapshot();
  const states = snap?.levels ?? {};

  const completed = LEVELS.filter((lv) => states[lv.levelId]?.completedAt).length;
  const total = LEVELS.length;

  return (
    <div className="space-y-5">
      <header className="brand-gradient rounded-2xl px-5 py-5 text-white shadow-[0_18px_50px_-24px_rgba(67,56,202,0.7)]">
        <h1 className="text-xl font-bold tracking-tight">闯关模式</h1>
        <p className="mt-1 text-sm text-white/80">从入门到挑战，循序渐进。答错的词会自动进入错题本。</p>
        <div className="mt-4 flex items-center gap-3">
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/25">
            <div
              className="h-full rounded-full bg-white transition-all duration-500"
              style={{ width: `${total > 0 ? (completed / total) * 100 : 0}%` }}
            />
          </div>
          <span className="shrink-0 text-xs font-semibold text-white/95">
            已通关 {completed} / {total}
          </span>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {LEVELS.map((lv) => {
          const st = states[lv.levelId];
          const done = !!st?.completedAt;
          const prevLevel = LEVELS[lv.ordinal - 2];
          const locked = !!prevLevel && !states[prevLevel.levelId]?.completedAt;
          return <LevelCard key={lv.levelId} level={lv} locked={locked} completed={done} />;
        })}
      </div>

      <DisclaimerBanner />
    </div>
  );
}

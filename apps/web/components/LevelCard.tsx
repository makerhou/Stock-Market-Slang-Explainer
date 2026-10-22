import Link from "next/link";
import type { QuizLevelConfig } from "@jargon/contracts";
import { DifficultyBadge } from "./DifficultyBadge";

const ACCENT: Record<number, string> = {
  1: "bg-emerald-400",
  2: "bg-indigo-500",
  3: "bg-amber-500",
};

export function LevelCard({
  level,
  locked,
  completed,
}: {
  level: QuizLevelConfig;
  locked: boolean;
  completed: boolean;
}) {
  const inner = (
    <div
      className={`card relative overflow-hidden transition-all duration-150 ${
        locked
          ? "opacity-70"
          : "hover:-translate-y-0.5 hover:shadow-[0_18px_40px_-18px_rgba(15,23,42,0.3)]"
      }`}
    >
      <span aria-hidden className={`absolute inset-x-0 top-0 h-1 ${ACCENT[level.targetDifficulty] ?? "bg-slate-300"}`} />
      <div className="p-4 pt-5">
        <div className="flex items-center justify-between">
          <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-[var(--color-muted)]">
            第 {level.ordinal} 关
          </span>
          {completed ? (
            <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600">
              <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2.5}>
                <path d="M5 10.5l3.5 3.5L15 6.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              已通关
            </span>
          ) : locked ? (
            <span className="text-xs text-[var(--color-faint)]">🔒 未解锁</span>
          ) : null}
        </div>
        <div className="mt-2.5 text-base font-bold tracking-tight text-[var(--color-fg)]">{level.name}</div>
        <div className="mt-3.5 flex items-center justify-between">
          <DifficultyBadge level={level.targetDifficulty} />
          <span className="text-xs font-medium text-[var(--color-faint)]">{level.questionCount} 题</span>
        </div>
      </div>
    </div>
  );
  return locked ? <div>{inner}</div> : <Link href={`/quiz/${level.levelId}`} className="block">{inner}</Link>;
}

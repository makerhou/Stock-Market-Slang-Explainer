"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LEVELS } from "@jargon/quiz";
import { ScoreBoard } from "@/components/ScoreBoard";
import { DisclaimerBanner } from "@/components/DisclaimerBanner";
import { useLexicon } from "@/lib/lexicon-client";
import { getQuizResult, type QuizResult } from "@/lib/quiz-results";

function ScoreRing({ rate, passed }: { rate: number; passed: boolean }) {
  const r = 34;
  const c = 2 * Math.PI * r;
  const off = c * (1 - rate / 100);
  const color = passed ? "var(--ok)" : "var(--brand)";
  return (
    <svg viewBox="0 0 80 80" className="h-20 w-20 -rotate-90">
      <circle cx="40" cy="40" r={r} fill="none" stroke="var(--color-border)" strokeWidth="7" />
      <circle
        cx="40"
        cy="40"
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="7"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={off}
        style={{ transition: "stroke-dashoffset .6s ease" }}
      />
    </svg>
  );
}

function nameOf(slug: string): string {
  return slug;
}

export function QuizResultView({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const { manifest } = useLexicon();
  const [result, setResult] = useState<QuizResult | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    setResult(getQuizResult(sessionId));
  }, [sessionId]);

  if (!mounted) {
    return <p className="py-10 text-center text-sm text-[var(--color-faint)]">加载中…</p>;
  }
  if (!result) {
    return (
      <div className="card p-6 text-center">
        <p className="text-sm text-[var(--color-body)]">没有找到这次练习的记录（可能已清理本地数据）。</p>
        <Link href="/levels" className="mt-3 inline-block text-sm font-medium text-[var(--brand-strong)] hover:underline">
          返回关卡列表
        </Link>
      </div>
    );
  }

  const name = (slug: string) => manifest?.entries.find((e) => e.slug === slug)?.headword ?? nameOf(slug);
  const passed = result.correctCount >= Math.ceil(result.answers.length / 2);
  const rate = result.answers.length > 0 ? Math.round((result.correctCount / result.answers.length) * 100) : 0;
  const nextLevel = LEVELS.find((l) => l.levelId === result.levelId);
  const next = nextLevel ? LEVELS[LEVELS.indexOf(nextLevel) + 1] : undefined;
  const retryHref = result.mode === "level" && result.levelId ? `/quiz/${result.levelId}` : "/levels";

  return (
    <div className="space-y-5">
      <div className={`card flex items-center gap-4 p-5 ${passed ? "ring-1 ring-emerald-200" : ""}`}>
        <div className="relative flex items-center justify-center">
          <ScoreRing rate={rate} passed={passed} />
          <span className="absolute text-lg font-bold tabular-nums text-[var(--color-fg)]">{rate}%</span>
        </div>
        <div>
          <div className="text-sm font-medium text-[var(--color-muted)]">{result.levelName}</div>
          <div className={`mt-0.5 text-xl font-bold tracking-tight ${passed ? "text-emerald-700" : "text-[var(--color-fg)]"}`}>
            {passed ? "已通关 🎉" : "再接再厉"}
          </div>
          <div className="mt-1 text-xs text-[var(--color-faint)]">
            答对 {result.correctCount} / {result.answers.length} 题
          </div>
        </div>
      </div>

      <ScoreBoard
        durationMs={result.durationMs}
        correctCount={result.correctCount}
        wrongCount={result.wrongCount}
      />

      {result.mistakes.length > 0 && (
        <div className="card p-5">
          <h2 className="text-sm font-semibold text-[var(--color-fg)]">
            这次答错的词（{result.mistakes.length}）
          </h2>
          <ul className="mt-3 space-y-2">
            {result.mistakes.map((m) => (
              <li key={m.termId} className="flex items-center justify-between rounded-xl bg-[var(--color-bg)] px-3 py-2.5">
                <Link href={`/terms/${m.termSlug}`} className="text-sm font-medium text-[var(--color-body)] hover:text-[var(--brand-strong)] hover:underline">
                  {name(m.termSlug)}
                </Link>
                <Link
                  href={`/quiz/review?termIds=${m.termId}`}
                  className="rounded-full bg-[var(--brand-soft)] px-3 py-1 text-xs font-semibold text-[var(--brand-strong)] transition-colors hover:bg-[var(--brand-ring)]"
                >
                  重做这题
                </Link>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-[var(--color-faint)]">这 {result.mistakes.length} 个词已加入错题本。</p>
        </div>
      )}

      <div className="flex flex-col gap-3 sm:flex-row">
        <Link href={retryHref} className="btn btn-primary flex-1">
          再练一次
        </Link>
        {next ? (
          <Link href={`/quiz/${next.levelId}`} className="btn btn-ghost flex-1">
            下一关：{next.name}
          </Link>
        ) : (
          <Link href="/levels" className="btn btn-ghost flex-1">
            返回关卡列表
          </Link>
        )}
      </div>

      <DisclaimerBanner />
    </div>
  );
}

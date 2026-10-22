"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { QuizMode } from "@jargon/contracts";
import { QuizSessionProvider, useQuizSession } from "@/lib/quiz-session";
import { LevelProgress } from "@/components/LevelProgress";
import { DifficultyBadge } from "@/components/DifficultyBadge";
import { QuizOption, type OptionState } from "@/components/QuizOption";
import { DisclaimerBanner } from "@/components/DisclaimerBanner";

function PlayInner() {
  const router = useRouter();
  const s = useQuizSession();
  const exit = () => {
    if (window.confirm("退出后进度会保留，下次可以继续。确定退出吗？")) router.push("/levels");
  };

  if (s.phase === "loading") {
    return (
      <div className="space-y-4">
        <div className="h-2 w-full animate-pulse rounded-full bg-slate-200" />
        <div className="h-24 animate-pulse rounded-2xl bg-slate-100" />
        <div className="space-y-2.5">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-[52px] animate-pulse rounded-2xl bg-slate-100" />
          ))}
        </div>
      </div>
    );
  }

  if (s.phase === "error") {
    return (
      <div className="card p-6 text-center">
        <p className="text-sm text-[var(--color-body)]">{s.errorMessage ?? "出题失败"}</p>
        <div className="mt-4 flex justify-center gap-3">
          <button
            onClick={s.retry}
            className="rounded-lg bg-[var(--brand)] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--brand-strong)]"
          >
            重试
          </button>
          <Link href="/levels" className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm font-medium text-[var(--color-muted)] transition-colors hover:bg-slate-50">
            返回关卡列表
          </Link>
        </div>
      </div>
    );
  }

  if (s.phase === "result") {
    return <p className="py-10 text-center text-sm text-[var(--color-faint)]">正在跳转结果页…</p>;
  }

  const q = s.current;
  if (!q) return null;

  const optionState = (id: string): OptionState => {
    if (s.pending && id === s.selectedOptionId) return "pending";
    if (s.phase === "feedback" && s.feedback) {
      if (id === s.feedback.correctOptionId) return "correct";
      if (id === s.selectedOptionId) return "wrong";
    }
    if (id === s.selectedOptionId) return "selected";
    return "idle";
  };

  return (
    <div className="space-y-4">
      {s.difficultyNotice && (
        <div
          role="status"
          className="flex items-center justify-center gap-1.5 rounded-xl bg-indigo-50 px-4 py-2 text-center text-sm font-medium text-indigo-700"
        >
          {s.difficultyNotice.dir === "down" ? "⬇️ 已为你调低难度，接下来这题更简单一点" : "⬆️ 已为你调高难度，试试更难的题"}
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <button onClick={exit} className="text-sm font-medium text-[var(--color-faint)] transition-colors hover:text-[var(--color-body)]">
          ✕ 退出
        </button>
        <div className="flex-1">
          <LevelProgress current={s.index} total={s.questions.length} />
        </div>
        <DifficultyBadge level={s.difficultyLevel} />
      </div>

      <div key={q.questionId} className="card animate-slide p-5">
        <div className="text-[15px] font-medium leading-relaxed text-[var(--color-fg)]">
          {q.stem.split("\n").map((line, i) => (
            <p key={i}>{line}</p>
          ))}
        </div>

        <div role="radiogroup" aria-label="选项" className="mt-4 space-y-2.5">
          {q.options.map((o, i) => (
            <QuizOption
              key={o.id}
              option={o}
              index={i}
              state={optionState(o.id)}
              disabled={s.phase !== "question"}
              onSelect={() => s.select(o.id)}
            />
          ))}
        </div>
      </div>

      {s.phase === "feedback" && (
        <div
          className={`card p-4 ${
            s.pending ? "" : s.feedback?.correct ? "ring-1 ring-emerald-200" : "ring-1 ring-rose-200"
          }`}
        >
          {s.pending ? (
            <p className="text-sm text-[var(--color-muted)]">网络不太好，这题结果待确认（已加入待校验队列）。</p>
          ) : (
            s.feedback && (
              <>
                <p className={`text-base font-bold ${s.feedback.correct ? "text-emerald-700" : "text-rose-700"}`}>
                  {s.feedback.correct ? "✓ 答对了" : "✗ 答错了"}
                </p>
                <p className="mt-1.5 text-sm leading-relaxed text-[var(--color-body)]">
                  <span className="font-semibold text-[var(--color-fg)]">依据：</span>
                  {s.feedback.explanation}
                </p>
                {s.feedback.example && (
                  <p className="mt-1 text-sm text-[var(--color-muted)]">举例：{s.feedback.example.text}</p>
                )}
                <Link
                  href={`/terms/${s.feedback.termSlug}`}
                  className="mt-2 inline-block text-sm font-medium text-[var(--brand-strong)] hover:underline"
                >
                  看这个词的完整解释 →
                </Link>
              </>
            )
          )}
          <div className="mt-3 flex items-center justify-between border-t border-[var(--color-border)] pt-3">
            <span className="text-xs text-[var(--color-faint)]">本题仅用于理解术语，不涉及任何投资建议</span>
            <button
              onClick={s.next}
              className="rounded-lg bg-[var(--brand)] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--brand-strong)] active:scale-[0.98]"
            >
              下一题 →
            </button>
          </div>
        </div>
      )}

      <DisclaimerBanner />
    </div>
  );
}

export function QuizPlay({
  levelId,
  mode,
  termIds,
}: {
  levelId: string;
  mode: QuizMode;
  termIds?: string[];
}) {
  return (
    <QuizSessionProvider levelId={levelId} mode={mode} termIds={termIds}>
      <PlayInner />
    </QuizSessionProvider>
  );
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m} 分 ${r} 秒`;
}

export function ScoreBoard({
  durationMs,
  correctCount,
  wrongCount,
}: {
  durationMs: number;
  correctCount: number;
  wrongCount: number;
}) {
  const total = correctCount + wrongCount;
  const rate = total > 0 ? Math.round((correctCount / total) * 100) : 0;
  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="card flex flex-col items-center justify-center px-4 py-5 text-center">
        <div className="text-3xl font-bold tabular-nums text-[var(--color-fg)]">{fmtDuration(durationMs)}</div>
        <div className="mt-1 text-xs font-medium text-[var(--color-muted)]">用时</div>
      </div>
      <div className="card flex flex-col items-center justify-center px-4 py-5 text-center">
        <div className="text-3xl font-bold tabular-nums text-[var(--brand-strong)]">{rate}%</div>
        <div className="mt-1 text-xs font-medium text-[var(--color-muted)]">正确率</div>
      </div>
      <div className="col-span-2 card flex items-center justify-center gap-2 px-4 py-3 text-sm">
        答对 <span className="font-semibold text-emerald-600">{correctCount}</span> 题
        <span className="text-[var(--color-faint)]">·</span>
        答错 <span className="font-semibold text-rose-600">{wrongCount}</span> 题
      </div>
    </div>
  );
}

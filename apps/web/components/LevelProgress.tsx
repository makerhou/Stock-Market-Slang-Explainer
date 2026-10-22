export function LevelProgress({
  current,
  total,
}: {
  current: number;
  total: number;
}) {
  const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
  return (
    <div className="w-full">
      <div className="mb-1 flex items-center justify-between text-xs font-medium text-[var(--color-muted)]">
        <span>
          第 {Math.min(current + 1, total)} / {total} 题
        </span>
        <span className="tabular-nums text-[var(--color-faint)]">{pct}%</span>
      </div>
      <div
        role="progressbar"
        aria-valuenow={current}
        aria-valuemin={0}
        aria-valuemax={total}
        className="h-2 w-full overflow-hidden rounded-full bg-slate-200/80"
      >
        <div
          className="h-full rounded-full bg-[var(--brand)] transition-[width] duration-300 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

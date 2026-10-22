/** 词条风险提示框（frontend-design：详情页首屏三件套之一，必填项） */
export function RiskNote({ note }: { note: string }) {
  return (
    <div
      role="note"
      className="rounded-xl border border-[var(--color-risk-border)] bg-[var(--color-risk-bg)] px-3 py-2 text-sm text-[var(--color-risk-fg)]"
    >
      <span className="mr-1 font-semibold">⚠ 风险提示</span>
      {note}
    </div>
  );
}

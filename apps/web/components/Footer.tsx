import { DisclaimerBanner } from "./DisclaimerBanner";

/** 页脚（兜底免责 + 版权声明） */
export function Footer() {
  return (
    <footer className="mt-10 border-t border-[var(--color-border)] bg-white/60">
      <div className="app-container py-6">
        <DisclaimerBanner variant="full" />
        <p className="mt-4 text-xs text-[var(--color-muted)]">
          © 股票黑话解释器 · 用大白话讲清股票术语
        </p>
      </div>
    </footer>
  );
}

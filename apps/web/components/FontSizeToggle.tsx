"use client";

/**
 * 字号三档切换（frontend-design A3：100% / 115% / 130%）。
 * 持久化到 localStorage；默认档不小于 16px。
 */
import { useEffect, useState } from "react";

const TIERS = [
  { label: "标准", value: "100%" },
  { label: "大", value: "115%" },
  { label: "特大", value: "130%" },
] as const;

const KEY = "jargon-font-tier";

export function FontSizeToggle() {
  const [tier, setTier] = useState("100%");

  useEffect(() => {
    const saved = localStorage.getItem(KEY);
    if (saved) apply(saved);
    else apply("100%");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function apply(v: string) {
    setTier(v);
    document.documentElement.style.setProperty("--font-size-base", v);
    localStorage.setItem(KEY, v);
  }

  const idx = TIERS.findIndex((t) => t.value === tier);
  const current = TIERS[idx] ?? TIERS[0];
  const next = TIERS[(idx + 1) % TIERS.length] ?? TIERS[0];

  return (
    <button
      type="button"
      onClick={() => apply(next.value)}
      aria-label={`当前字号：${current.label}，点击切换为${next.label}`}
      className="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] bg-white px-3 py-1 text-xs text-[var(--color-muted)] transition-colors hover:border-[var(--brand-ring)] hover:text-[var(--brand-strong)]"
    >
      <span aria-hidden>🔠</span>
      字号 {current.label}
    </button>
  );
}

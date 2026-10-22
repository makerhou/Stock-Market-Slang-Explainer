"use client";

import { useState, type ReactNode } from "react";

/** 卡片外壳：标题 + 人话引导 + 图 + 互动提示 + 结论 */
export function VizShell({
  icon = "📊",
  title = "看图秒懂",
  caption,
  hint,
  insight,
  children,
}: {
  icon?: string;
  title?: string;
  caption?: string;
  hint?: string;
  insight?: string;
  children: ReactNode;
}) {
  return (
    <section className="card animate-pop overflow-hidden">
      <div className="brand-gradient px-4 py-3 text-white">
        <div className="flex items-center gap-2 text-base font-bold">
          <span aria-hidden>{icon}</span>
          <span>{title}</span>
        </div>
        {caption ? (
          <p className="mt-1 text-[0.82rem] leading-snug text-indigo-50/95">{caption}</p>
        ) : null}
      </div>
      <div className="p-4">{children}</div>
      {hint ? (
        <p className="flex items-center gap-1.5 px-4 pb-2 text-xs text-[var(--color-muted)]">
          <span aria-hidden>👆</span>
          <span>{hint}</span>
        </p>
      ) : null}
      {insight ? (
        <div className="mx-4 mb-4 rounded-xl bg-[var(--brand-soft)] px-3 py-2 text-[0.82rem] font-medium leading-snug text-[var(--brand-strong)]">
          <span aria-hidden className="mr-1">💡</span>
          {insight}
        </div>
      ) : null}
    </section>
  );
}

/** 大号触摸滑块（品牌色填充） */
export function Slider({
  label,
  min,
  max,
  step = 1,
  value,
  onChange,
  format,
  accent,
}: {
  label?: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  accent?: string;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div>
      {label ? (
        <div className="mb-1.5 flex items-center justify-between text-sm">
          <span className="font-semibold text-[var(--color-body)]">{label}</span>
          <span className="stat-num" style={accent ? { color: accent } : undefined}>
            {format ? format(value) : value}
          </span>
        </div>
      ) : null}
      <input
        type="range"
        className="viz-range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{
          background: `linear-gradient(90deg, ${accent ?? "var(--brand)"} ${pct}%, var(--color-border) ${pct}%)`,
        }}
        aria-label={label}
      />
    </div>
  );
}

/** 数值小药丸 */
export function StatTag({
  label,
  value,
  tone = "brand",
}: {
  label: string;
  value: ReactNode;
  tone?: "brand" | "up" | "down" | "ok" | "warn" | "neutral";
}) {
  const toneMap: Record<string, React.CSSProperties> = {
    brand: { background: "var(--brand-soft)", color: "var(--brand-strong)" },
    up: { background: "var(--up-bg)", color: "var(--up)" },
    down: { background: "var(--down-bg)", color: "var(--down)" },
    ok: { background: "var(--ok-bg)", color: "var(--ok)" },
    warn: { background: "var(--warn-bg)", color: "var(--warn)" },
    neutral: { background: "var(--color-bg)", color: "var(--color-muted)" },
  };
  return (
    <div
      className="flex flex-col items-center rounded-xl px-3 py-2"
      style={toneMap[tone]}
    >
      <span className="text-[0.7rem] font-medium opacity-80">{label}</span>
      <span className="stat-num text-base">{value}</span>
    </div>
  );
}

/** 分段切换大按钮 */
export function SegToggle<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="viz-seg w-full justify-center">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** 简单数据表（文图+表中的「表」） */
export function VizTable({
  headers,
  rows,
}: {
  headers: string[];
  rows: (ReactNode)[][];
}) {
  return (
    <div className="overflow-hidden">
      <table className="viz-table">
        <thead>
          <tr>
            {headers.map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 百分比格式化助手 */
export function pct(v: number, digits = 1): string {
  return `${v >= 0 ? "" : ""}${v.toFixed(digits)}%`;
}

/** 小按钮（播放 / 重置等） */
export function MiniButton({
  children,
  onClick,
  active,
}: {
  children: ReactNode;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="btn btn-ghost"
      style={active ? { borderColor: "var(--brand)", color: "var(--brand-strong)" } : undefined}
    >
      {children}
    </button>
  );
}

export { useState };

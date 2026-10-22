"use client";

import { useState } from "react";
import { VizShell, Slider, StatTag, VizTable } from "./viz-basics";

/**
 * GaugeBar：刻度尺 + 关键阈值线（荣枯线/中轴/警戒线）。
 * 用于 PMI 50 荣枯线、VIX 恐慌刻度、M1-M2 剪刀差 0 轴、10Y-2Y 利差倒挂。
 */
export function GaugeBar({ config }: { config?: Record<string, unknown> }) {
  const min = Number(config?.min ?? 0);
  const max = Number(config?.max ?? 100);
  const threshold = Number(config?.threshold ?? 50);
  const unit = config?.unit ? String(config.unit) : "";
  const zones: { min: number; max: number; label: string; color: string }[] = Array.isArray(config?.zones)
    ? (config.zones as { min: number; max: number; label: string; color: string }[])
    : [
      { min, max: threshold, label: config?.lowLabel ? String(config.lowLabel) : "偏冷", color: "var(--down)" },
      { min: threshold, max, label: config?.highLabel ? String(config.highLabel) : "偏热", color: "var(--up)" },
    ];
  const init = Number(config?.initial ?? threshold);
  const [val, setVal] = useState(init);
  const cur = zones.find((z) => val >= z.min && val <= z.max) ?? zones[zones.length - 1] ?? zones[0];
  const pct = max > min ? ((val - min) / (max - min)) * 100 : 0;
  const thrPct = max > min ? ((threshold - min) / (max - min)) * 100 : 50;
  return (
    <VizShell
      title={config?.title ? String(config.title) : "这条线，就是分界线"}
      caption={config?.caption ? String(config.caption) : "很多财经指标只看「在线的哪一边」：越过了分界线，含义就反过来。"}
      hint="拖动滑块，看读数跨过分界线的一刻"
      insight={config?.insight ? String(config.insight) : "💡 指标本身没有好坏，关键是和那条「线」比。"}
    >
      <Slider label={config?.valueLabel ? String(config.valueLabel) : "当前读数"} min={min} max={max}
        step={Number(config?.step ?? 1)} value={val} onChange={setVal}
        format={(v) => `${v}${unit}`} accent={cur?.color ?? "var(--brand)"} />
      <div className="relative mt-4 h-9 overflow-hidden rounded-full border border-[var(--color-border)]">
        {zones.map((z) => {
          const w = max > min ? ((z.max - z.min) / (max - min)) * 100 : 50;
          return (
            <div key={z.label} className="absolute inset-y-0 flex items-center justify-center text-[0.68rem] font-bold"
              style={{ left: `${((z.min - min) / (max - min)) * 100}%`, width: `${w}%`, background: "var(--color-bg)", color: z.color }}>
              {z.label}
            </div>
          );
        })}
        <div className="absolute inset-y-0 w-0.5 bg-[var(--color-fg)]" style={{ left: `${thrPct}%` }} />
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <StatTag label={config?.thresholdLabel ? String(config.thresholdLabel) : "分界线"} value={`${threshold}${unit}`} tone="neutral" />
        <StatTag label="现在读数" value={`${val}${unit}`} tone="brand" />
        <StatTag label="含义" value={cur?.label ?? "-"} tone={cur?.color === "var(--up)" ? "up" : "down"} />
      </div>
      {Array.isArray(config?.rows) ? (
        <div className="mt-3">
          <VizTable headers={["情形", "含义", "类比"]} rows={config.rows as [string, string, string][]} />
        </div>
      ) : null}
    </VizShell>
  );
}

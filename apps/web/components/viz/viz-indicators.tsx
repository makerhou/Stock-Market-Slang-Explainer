"use client";

import { useEffect, useRef, useState } from "react";
import { VizShell, Slider, StatTag, VizTable } from "./viz-basics";

/* ─────────────── MACD：金叉 / 死叉 ─────────────── */
export function CrossLines({ config }: { config?: Record<string, unknown> }) {
  const [fast, setFast] = useState(-20);
  const [slow, setSlow] = useState(0);
  const [playing, setPlaying] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!playing) return;
    setFast(-40);
    timer.current = setInterval(() => {
      setFast((f) => {
        if (f >= 40) {
          if (timer.current) clearInterval(timer.current);
          setPlaying(false);
          return 40;
        }
        return f + 4;
      });
    }, 70);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [playing]);

  const gold = fast > slow;
  const STATUS = gold
    ? { t: "金叉 🟢", d: "快线从下往上穿过慢线，常被看作上涨力气变强", c: "var(--up)" }
    : { t: "死叉 🔴", d: "快线从上往下穿过慢线，常被看作上涨力气变弱", c: "var(--down)" };

  const Track = ({ v, color, name }: { v: number; color: string; name: string }) => {
    const pct = ((v + 40) / 80) * 100;
    return (
      <div className="mb-2">
        <div className="mb-1 flex justify-between text-xs">
          <span className="font-semibold">{name}</span>
          <span className="stat-num" style={{ color }}>{v}</span>
        </div>
        <div className="relative h-3 w-full rounded-full bg-[var(--color-border)]">
          <div className="absolute left-1/2 top-0 h-full w-px bg-[var(--color-muted)]" />
          <div className="absolute top-1/2 h-4 w-4 -translate-y-1/2 -translate-x-1/2 rounded-full border-2 border-white" style={{ left: `${pct}%`, background: color }} />
        </div>
      </div>
    );
  };

  return (
    <VizShell
      icon="🤝"
      title={config?.title ? String(config.title) : "金叉与死叉"}
      caption="MACD 用两条线看趋势：快线从下往上穿过慢线叫「金叉」（力气可能变强），反叫「死叉」。"
      hint="点「▶ 播放穿越」，看快线慢慢穿过慢线，状态怎么翻牌。"
      insight="指标会滞后，过去出现金叉不代表以后一定涨。它只是描述走势的工具，不是「该买」的指令。"
    >
      <Track v={fast} color="var(--brand)" name="快线 (DIF)" />
      <Track v={slow} color="var(--color-muted)" name="慢线 (DEA)" />
      <div className="mt-2 rounded-xl px-3 py-2 text-center" style={{ background: gold ? "var(--up-bg)" : "var(--down-bg)" }}>
        <div className="stat-num text-xl" style={{ color: STATUS.c }}>{STATUS.t}</div>
        <div className="text-xs text-[var(--color-body)]">{STATUS.d}</div>
      </div>
      <div className="mt-3 flex gap-2">
        <button type="button" className="btn btn-primary flex-1" onClick={() => setPlaying(true)} disabled={playing}>
          {playing ? "穿越中…" : "▶ 播放穿越"}
        </button>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
        <Slider label="快线值" min={-40} max={40} step={1} value={fast} onChange={(v) => { setPlaying(false); setFast(v); }} accent="var(--brand)" />
        <Slider label="慢线值" min={-40} max={40} step={1} value={slow} onChange={setSlow} accent="var(--color-muted)" />
      </div>
    </VizShell>
  );
}

/* ─────────────── RSI / KDJ 摆动指标 ─────────────── */
type OzCfg = {
  needles?: { name: string }[];
  initial?: number[];
  zones?: { min: number; max: number; label: string; color: string }[];
  max?: number;
};
export function Oscillator({ config }: { config?: Record<string, unknown> }) {
  const c = (config ?? {}) as OzCfg;
  const max = c.max ?? 100;
  const needles = c.needles ?? [{ name: "指标" }];
  const [vals, setVals] = useState<number[]>(c.initial ?? needles.map(() => 50));
  const zoneOf = (v: number) =>
    (c.zones ?? []).find((z) => v >= z.min && v <= z.max) ?? { label: "—", color: "var(--color-muted)" };

  const H = 180,
    PAD = 10,
    INNER = H - PAD * 2;
  const map = (v: number) => PAD + INNER - (v / max) * INNER;

  return (
    <VizShell
      icon="🌡️"
      title={config?.title ? String(config.title) : "摆到哪个区间了？"}
      caption="摆动指标像温度计，在 0~100 之间晃。太高（超买）可能过热要歇歇，太低（超卖）可能冷过头要反弹。"
      hint="拖动滑块改变指标数值，看它落在「超买 / 中性 / 超卖」哪个区。"
      insight="超买超卖只是「可能」偏向，不是必然反转。别一看到超买就卖、超卖就买，要结合价格和趋势。"
    >
      <div className="flex gap-3">
        <svg viewBox="0 0 60 200" className="w-20 shrink-0" role="img" aria-label="摆动区间">
          <rect x="18" y={PAD} width="24" height={INNER} rx="12" fill="var(--color-border)" />
          {(c.zones ?? []).map((z, i) => (
            <rect key={i} x="18" y={map(z.max)} width="24" height={map(z.min) - map(z.max)} fill={z.color} opacity={0.35} />
          ))}
          {vals.map((v, i) => (
            <line key={i} x1="10" y1={map(v)} x2="50" y2={map(v)} stroke={i === 0 ? "var(--brand)" : "var(--warn)"} strokeWidth="3" />
          ))}
          <text x="30" y="14" textAnchor="middle" fontSize="9" fill="var(--color-faint)">{max}</text>
          <text x="30" y="196" textAnchor="middle" fontSize="9" fill="var(--color-faint)">0</text>
        </svg>
        <div className="flex-1">
          {needles.map((n, i) => {
            const v = vals[i] ?? 0;
            const z = zoneOf(v);
            return (
              <div key={n.name} className="mb-2">
                <div className="mb-1 flex justify-between text-xs">
                  <span className="font-semibold">{n.name}</span>
                  <span className="stat-num" style={{ color: z.color }}>{v.toFixed(0)} · {z.label}</span>
                </div>
                <input
                  type="range" className="viz-range" min={0} max={max} step={1} value={v}
                  onChange={(e) => {
                    const nv = [...vals];
                    nv[i] = Number(e.target.value);
                    setVals(nv);
                  }}
                />
              </div>
            );
          })}
        </div>
      </div>
      <div className="mt-3">
        <VizTable
          headers={["指标", "数值", "区间"]}
          rows={needles.map((n, i) => [n.name, (vals[i] ?? 0).toFixed(0), zoneOf(vals[i] ?? 0).label])}
        />
      </div>
    </VizShell>
  );
}

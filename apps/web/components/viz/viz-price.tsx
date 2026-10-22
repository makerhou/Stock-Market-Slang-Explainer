"use client";

import { useState } from "react";
import { VizShell, Slider, StatTag, VizTable, pct } from "./viz-basics";

/* ─────────────── 涨跌幅 / 涨停 / 跌停 ─────────────── */
type PcbCfg = {
  mode?: "limitUp" | "limitDown" | "free";
  limitPct?: number;
  basePrice?: number;
};
export function PriceChangeBars({ config }: { config?: Record<string, unknown> }) {
  const c = (config ?? {}) as PcbCfg;
  const mode = c.mode ?? "free";
  const limit = c.limitPct ?? 10;
  const base = c.basePrice ?? 10;
  const min = mode === "limitDown" ? -limit : mode === "free" ? -20 : 0;
  const max = mode === "limitUp" ? limit : mode === "limitDown" ? 0 : 20;
  const [chg, setChg] = useState(
    mode === "limitUp" ? 3 : mode === "limitDown" ? -3 : 2,
  );

  const price = base * (1 + chg / 100);
  const diff = price - base;
  const up = chg >= 0;
  const color = up ? "var(--up)" : "var(--down)";
  const isLimit =
    (mode === "limitUp" && chg >= limit - 0.02) ||
    (mode === "limitDown" && chg <= -limit + 0.02);
  const status = isLimit
    ? mode === "limitUp"
      ? "涨停 🔒 今天最多涨到这儿"
      : "跌停 🔒 今天最多跌到这儿"
    : chg > 0
      ? "上涨"
      : chg < 0
        ? "下跌"
        : "平盘";

  // SVG 竖向柱
  const H = 170,
    PAD = 10,
    INNER = H - PAD * 2;
  const map = (v: number) => PAD + INNER - ((v - min) / (max - min)) * INNER;
  const zeroY = map(0);
  const valY = map(chg);
  const top = Math.min(zeroY, valY);
  const h = Math.max(2, Math.abs(zeroY - valY));
  const arrow = up ? "▲" : "▼";

  return (
    <VizShell
      icon="📈"
      title={config?.title ? String(config.title) : "涨跌停一目了然"}
      caption="拖动滑块，看看一天里股价最多能涨多少、跌多少。"
      hint="拖动下面的滑块，观察红绿柱子和「涨停 / 跌停」提示。"
      insight="A股普通股票一天最多涨 10%（涨停）或跌 10%（跌停），到顶就不能再动，像被按了暂停键。"
    >
      <div className="flex flex-col items-center gap-3">
        <svg viewBox="0 0 160 190" className="w-full max-w-[260px]" role="img" aria-label="涨跌柱状图">
          <line x1="20" y1={zeroY} x2="140" y2={zeroY} stroke="var(--color-border)" strokeWidth="2" />
          <rect x="68" y={top} width="24" height={h} rx="4" fill={color} />
          <text x="80" y={valY < zeroY ? top - 6 : top + h + 16} textAnchor="middle" fontSize="15" fontWeight="800" fill={color}>
            {arrow} {pct(chg)}
          </text>
          <text x="20" y="185" fontSize="10" fill="var(--color-faint)">跌</text>
          <text x="118" y="185" fontSize="10" fill="var(--color-faint)">涨</text>
        </svg>
        <div className="grid w-full grid-cols-3 gap-2">
          <StatTag label="现价" value={`¥${price.toFixed(2)}`} tone={up ? "up" : "down"} />
          <StatTag label="涨跌额" value={`${diff >= 0 ? "+" : ""}${diff.toFixed(2)}`} tone={up ? "up" : "down"} />
          <StatTag label="状态" value={status.replace(/ .*/, "")} tone={isLimit ? "warn" : up ? "up" : "down"} />
        </div>
        <Slider label="今日涨跌幅" min={min} max={max} step={0.5} value={chg} onChange={setChg} format={(v) => pct(v)} accent={color} />
      </div>
    </VizShell>
  );
}

/* ─────────────── K线 / 阴线 蜡烛拼装 ─────────────── */
export function CandleBuilder({ config }: { config?: Record<string, unknown> }) {
  const [open, setOpen] = useState(10);
  const [close, setClose] = useState(8);
  const [high, setHigh] = useState(12);
  const [low, setLow] = useState(7);
  const up = close >= open;
  const color = up ? "var(--up)" : "var(--down)";
  const label = up ? "阳线（涨·红）" : "阴线（跌·绿）";
  const H = 200,
    PAD = 14,
    INNER = H - PAD * 2;
  const lo = Math.min(open, close, low, high) - 1;
  const hi = Math.max(open, close, low, high) + 1;
  const map = (v: number) => PAD + INNER - ((v - lo) / (hi - lo)) * INNER;
  const yO = map(open),
    yC = map(close),
    yH = map(high),
    yL = map(low);
  const bodyTop = Math.min(yO, yC),
    bodyH = Math.max(2, Math.abs(yO - yC));
  return (
    <VizShell
      icon="🕯️"
      title={config?.title ? String(config.title) : "拼一根K线蜡烛"}
      caption="K线就是一根小蜡烛：开盘价、收盘价、最高、最低。收盘比开盘高就是红柱子（涨）。"
      hint="拖动四个滑块，看蜡烛怎么变红变绿。"
      insight="阴线＝当天收盘价比开盘价低，所以画成绿柱子。一眼就能看出这天是涨还是跌。"
    >
      <div className="flex flex-col items-center gap-3">
        <svg viewBox="0 0 160 220" className="w-full max-w-[240px]" role="img" aria-label="K线蜡烛">
          <line x1="80" y1={map(high)} x2="80" y2={map(low)} stroke={color} strokeWidth="3" />
          <rect x="62" y={bodyTop} width="36" height={bodyH} rx="3" fill={color} />
          <text x="118" y={map(high) + 4} fontSize="11" fill={color}>高 {high}</text>
          <text x="118" y={map(low) + 4} fontSize="11" fill={color}>低 {low}</text>
        </svg>
        <div className="grid w-full grid-cols-2 gap-2">
          <StatTag label="开盘" value={`¥${open}`} tone="neutral" />
          <StatTag label="收盘" value={`¥${close}`} tone={up ? "up" : "down"} />
        </div>
        <div className="w-full text-center text-sm font-bold" style={{ color }}>
          {label}
        </div>
        <div className="grid w-full grid-cols-2 gap-x-4 gap-y-2">
          <Slider label="开盘价" min={5} max={15} step={0.5} value={open} onChange={setOpen} />
          <Slider label="收盘价" min={5} max={15} step={0.5} value={close} onChange={setClose} />
          <Slider label="最高价" min={5} max={18} step={0.5} value={high} onChange={(v) => setHigh(Math.max(v, open, close))} />
          <Slider label="最低价" min={3} max={15} step={0.5} value={low} onChange={(v) => setLow(Math.min(v, open, close))} />
        </div>
      </div>
    </VizShell>
  );
}

/* ─────────────── 行情：牛 / 熊 / 震荡 ─────────────── */
export function MarketMood({ config }: { config?: Record<string, unknown> }) {
  const [mood, setMood] = useState<"bull" | "bear" | "flat">("bull");
  const paths: Record<string, string> = {
    bull: "M10,150 L40,140 L70,120 L100,95 L130,60 L150,40",
    bear: "M10,50 L40,65 L70,85 L100,110 L130,135 L150,155",
    flat: "M10,100 L40,90 L70,110 L100,95 L130,105 L150,100",
  };
  const meta: Record<string, { face: string; label: string; desc: string; color: string }> = {
    bull: { face: "😄", label: "牛市（行情好）", desc: "股价一波比一波高，大家乐意买。", color: "var(--up)" },
    bear: { face: "😟", label: "熊市（行情差）", desc: "股价一波比一波低，大家想卖出。", color: "var(--down)" },
    flat: { face: "😐", label: "震荡（不上不下）", desc: "涨涨跌跌来回晃，方向不明显。", color: "var(--color-muted)" },
  };
  const m = meta[mood]!;
  return (
    <VizShell
      icon="🌦️"
      title={config?.title ? String(config.title) : "行情是牛是熊？"}
      caption="「行情」就是市场整体的冷热。点下面的按钮，看看三种天气长什么样。"
      hint="点「牛市 / 熊市 / 震荡」切换，看曲线和表情。"
      insight="行情好叫牛市（红红火火），差叫熊市（绿油油凉凉）。但天气会变，别以为一种天气永远不变。"
    >
      <div className="flex flex-col items-center gap-3">
        <svg viewBox="0 0 160 170" className="w-full max-w-[280px]" role="img" aria-label="行情曲线">
          <line x1="10" y1="160" x2="150" y2="160" stroke="var(--color-border)" strokeWidth="2" />
          <line x1="10" y1="20" x2="10" y2="160" stroke="var(--color-border)" strokeWidth="2" />
          <path d={paths[mood]} fill="none" stroke={m.color} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <div className="text-4xl" aria-hidden>{m.face}</div>
        <div className="text-center">
          <div className="text-base font-bold" style={{ color: m.color }}>{m.label}</div>
          <div className="text-sm text-[var(--color-muted)]">{m.desc}</div>
        </div>
        <div className="viz-seg w-full justify-center">
          {(["bull", "flat", "bear"] as const).map((k) => (
            <button key={k} type="button" aria-pressed={mood === k} onClick={() => setMood(k)}>
              {k === "bull" ? "牛市" : k === "bear" ? "熊市" : "震荡"}
            </button>
          ))}
        </div>
      </div>
    </VizShell>
  );
}

/* ─────────────── 量比（成交量） ─────────────── */
export function VolumeRatio({ config }: { config?: Record<string, unknown> }) {
  const [today, setToday] = useState(150);
  const avg = 100;
  const ratio = today / avg;
  const tone = ratio > 1.5 ? "up" : ratio < 0.8 ? "down" : "neutral";
  const label = ratio > 1.5 ? "放量🔥 今天比平时热闹" : ratio < 0.8 ? "缩量🥱 今天冷清" : "平量😐 和平时差不多";
  const maxV = 250;
  const barH = (v: number) => (v / maxV) * 120;
  return (
    <VizShell
      icon="📦"
      title={config?.title ? String(config.title) : "今天买卖有多热闹？"}
      caption="量比＝今天的成交量 ÷ 最近 5 天的平均。比 1 大就说明今天比平时热闹。"
      hint="拖动滑块改变今天的成交量，看量比怎么变。"
      insight="量比大＝买卖的人多、市场热闹；量比小＝冷冷清清。热闹不一定好，要看价格是涨是跌。"
    >
      <div className="flex items-end justify-center gap-6">
        {[
          { n: "今天", v: today, c: "var(--brand)" },
          { n: "5日均", v: avg, c: "var(--color-border)" },
        ].map((b) => (
          <div key={b.n} className="flex flex-col items-center">
            <div className="stat-num mb-1" style={{ color: b.c }}>{b.v}</div>
            <div style={{ width: 46, height: barH(b.v), background: b.c, borderRadius: 8 }} />
            <div className="mt-1 text-xs text-[var(--color-muted)]">{b.n}</div>
          </div>
        ))}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <StatTag label="量比" value={ratio.toFixed(2)} tone={tone} />
        <StatTag label="看法" value={label.split(" ")[0]} tone={tone} />
      </div>
      <Slider label="今日成交量" min={20} max={250} step={5} value={today} onChange={setToday} />
      <div className="mt-3">
        <VizTable headers={["项目", "数值"]} rows={[["今日成交量", today], ["5日平均", avg], ["量比", ratio.toFixed(2) + " 倍"]]} />
      </div>
    </VizShell>
  );
}

/* ─────────────── 市值（盘子大小） ─────────────── */
export function MarketCapBar({ config }: { config?: Record<string, unknown> }) {
  const [price, setPrice] = useState(20);
  const [shares, setShares] = useState(50); // 亿股
  const cap = price * shares; // 亿元
  const level = cap < 100 ? { t: "小盘股", c: "var(--ok)" } : cap < 500 ? { t: "中盘股", c: "var(--brand)" } : { t: "大盘股", c: "var(--warn)" };
  const maxCap = 2000;
  return (
    <VizShell
      icon="🏢"
      title={config?.title ? String(config.title) : "这家公司值多少钱？"}
      caption="市值＝股价 × 总股数，就是「把整家公司买下来要花多少钱」。"
      hint="拖动两个滑块，看市值和「盘子大小」怎么变。"
      insight="市值小的叫小盘股（灵活但易波动），大的叫大盘股（稳但笨重）。你的钱在这家公司里的分量，也跟盘子大小有关。"
    >
      <div className="mb-2">
        <div className="stat-num text-2xl" style={{ color: level.c }}>¥{cap.toFixed(0)} 亿</div>
        <div className="text-sm font-bold" style={{ color: level.c }}>{level.t}</div>
      </div>
      <div className="h-4 w-full overflow-hidden rounded-full bg-[var(--color-border)]">
        <div style={{ width: `${Math.min(100, (cap / maxCap) * 100)}%`, height: "100%", background: level.c, borderRadius: 9999 }} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
        <Slider label="股价(元)" min={1} max={100} step={1} value={price} onChange={setPrice} />
        <Slider label="总股数(亿股)" min={1} max={300} step={1} value={shares} onChange={setShares} />
      </div>
      <div className="mt-3">
        <VizTable headers={["项目", "数值"]} rows={[["股价", `¥${price}`], ["总股数", `${shares} 亿股`], ["市值", `¥${cap.toFixed(0)} 亿`], ["级别", level.t]]} />
      </div>
    </VizShell>
  );
}

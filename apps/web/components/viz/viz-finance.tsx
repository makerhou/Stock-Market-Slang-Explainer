"use client";

import { useState } from "react";
import { VizShell, Slider, StatTag, VizTable } from "./viz-basics";

/* ─────────────── 市盈率 / 市净率 跷跷板 ─────────────── */
type PeCfg = {
  ratioName?: string;
  denomLabel?: string;
  denomMax?: number;
  cheap?: number;
  fair?: number;
};
export function PEScale({ config }: { config?: Record<string, unknown> }) {
  const c = (config ?? {}) as PeCfg;
  const ratioName = c.ratioName ?? "市盈率";
  const denomLabel = c.denomLabel ?? "每年赚的钱";
  const denomMax = c.denomMax ?? 10;
  const cheap = c.cheap ?? 15;
  const fair = c.fair ?? 30;
  const [price, setPrice] = useState(20);
  const [denom, setDenom] = useState(2);
  const ratio = denom > 0 ? price / denom : 0;
  const tone = ratio < cheap ? "ok" : ratio <= fair ? "brand" : "warn";
  const verdict = ratio < cheap ? "可能偏便宜" : ratio <= fair ? "大致适中" : "可能偏贵";
  const angle = Math.max(-18, Math.min(18, (ratio - (cheap + fair) / 2) / 1.5));

  return (
    <VizShell
      icon="⚖️"
      title={`${ratioName}：贵还是便宜？`}
      caption={`${ratioName}＝股价 ÷ ${denomLabel}。数值小，说明花不多的钱就能买到一份盈利，可能便宜；数值大，可能偏贵。`}
      hint="拖动两个滑块，看跷跷板往哪边沉、估值标签怎么变。"
      insight="估值是「可能贵/便宜」的参考，不是买卖指令。同一数字在不同行业含义不同，别单看一个数就冲。"
    >
      <svg viewBox="0 0 200 120" className="w-full max-w-[300px] mx-auto" role="img" aria-label="估值跷跷板">
        <polygon points="100,110 92,118 108,118" fill="var(--color-muted)" />
        <g transform={`rotate(${angle} 100 110)`}>
          <rect x="20" y="104" width="160" height="8" rx="4" fill="var(--brand)" />
          <circle cx="30" cy="104" r="14" fill="var(--up)" />
          <circle cx="170" cy="104" r="14" fill="var(--down)" />
        </g>
        <text x="30" y="86" textAnchor="middle" fontSize="10" fill="var(--up)">股价 {price}</text>
        <text x="170" y="86" textAnchor="middle" fontSize="10" fill="var(--down)">{denomLabel} {denom}</text>
      </svg>
      <div className="mt-1 grid grid-cols-2 gap-2">
        <StatTag label={ratioName} value={ratio.toFixed(1)} tone={tone} />
        <StatTag label="看法" value={verdict} tone={tone} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
        <Slider label="股价(元)" min={1} max={60} step={1} value={price} onChange={setPrice} accent="var(--up)" />
        <Slider label={denomLabel} min={0.3} max={denomMax} step={0.1} value={denom} onChange={setDenom} accent="var(--down)" />
      </div>
      <div className="mt-3">
        <VizTable
          headers={["项目", "数值", "含义"]}
          rows={[
            ["股价", `¥${price}`, "你买一股花的钱"],
            [denomLabel, `${denom}`, "这一股一年带来的价值"],
            [ratioName, ratio.toFixed(1), verdict],
          ]}
        />
      </div>
    </VizShell>
  );
}

/* ─────────────── 盈利 / 亏损 天平 ─────────────── */
type PlCfg = { income?: number; cost?: number };
export function ProfitLossScale({ config }: { config?: Record<string, unknown> }) {
  const c = (config ?? {}) as PlCfg;
  const [income, setIncome] = useState(c.income ?? 300);
  const [cost, setCost] = useState(c.cost ?? 220);
  const profit = income - cost;
  const win = profit >= 0;
  const color = win ? "var(--ok)" : "var(--bad)";
  const angle = Math.max(-16, Math.min(16, (income - cost) / 30));
  return (
    <VizShell
      icon="💰"
      title={config?.title ? String(config.title) : "赚钱了还是亏了？"}
      caption="公司（或你）一段时期：收入减去成本。收进来的钱比花出去的多，就是盈利；反过来就是亏损。"
      hint="拖动「收入」「成本」两个滑块，看天平往哪边沉。"
      insight="账面赚钱不等于手里现金多——钱可能被欠着没收回来。看盈利也要看钱真到账没有。"
    >
      <svg viewBox="0 0 200 120" className="w-full max-w-[300px] mx-auto" role="img" aria-label="盈亏天平">
        <polygon points="100,110 92,118 108,118" fill="var(--color-muted)" />
        <g transform={`rotate(${angle} 100 110)`}>
          <rect x="20" y="104" width="160" height="8" rx="4" fill="var(--brand)" />
          <circle cx="30" cy="104" r="14" fill="var(--ok)" />
          <circle cx="170" cy="104" r="14" fill="var(--bad)" />
        </g>
        <text x="30" y="86" textAnchor="middle" fontSize="10" fill="var(--ok)">收入 {income}</text>
        <text x="170" y="86" textAnchor="middle" fontSize="10" fill="var(--bad)">成本 {cost}</text>
      </svg>
      <div className="mt-1 grid grid-cols-2 gap-2">
        <StatTag label={win ? "盈利" : "亏损"} value={`${win ? "+" : ""}${profit}`} tone={win ? "ok" : "warn"} />
        <StatTag label="状态" value={win ? "赚钱😀" : "亏钱😣"} tone={win ? "ok" : "warn"} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
        <Slider label="收入" min={0} max={600} step={10} value={income} onChange={setIncome} accent="var(--ok)" />
        <Slider label="成本" min={0} max={600} step={10} value={cost} onChange={setCost} accent="var(--bad)" />
      </div>
      <div className="mt-3">
        <VizTable headers={["项目", "数值"]} rows={[["收入", income], ["成本", cost], [win ? "盈利" : "亏损", `${win ? "+" : ""}${profit}`]]} />
      </div>
    </VizShell>
  );
}

/* ─────────────── 分红：按股数分现金 ─────────────── */
export function DividendSplit({ config }: { config?: Record<string, unknown> }) {
  const [shares, setShares] = useState(1000);
  const [div, setDiv] = useState(0.5);
  const got = (shares * div) / 100; // 元（示例：每股分 div 元，shares 单位百股→简化为直接乘）
  const youGet = shares * div; // 简单：持股数×每股分红（元）
  return (
    <VizShell
      icon="🪙"
      title={config?.title ? String(config.title) : "公司请你分钱"}
      caption="「分红」是公司赚钱后，按你手里持有多少股，给你发一点现金。持有越多，分到的越多。"
      hint="拖动「持股数」「每股分红」两个滑块，看你能拿到多少钱。"
      insight="分红是你当股东的好处之一，但分了红股价会相应除息（见「除权」）。别只看分红高就买，还要看公司值不值。"
    >
      <div className="text-center">
        <div className="text-4xl" aria-hidden>🪙💰</div>
        <div className="stat-num text-2xl text-[var(--ok)]">你拿到 ¥{youGet.toFixed(0)}</div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
        <Slider label="持股数(股)" min={100} max={10000} step={100} value={shares} onChange={setShares} accent="var(--brand)" />
        <Slider label="每股分红(元)" min={0.1} max={3} step={0.1} value={div} onChange={setDiv} accent="var(--ok)" />
      </div>
      <div className="mt-3">
        <VizTable headers={["项目", "数值"]} rows={[["持股数", `${shares} 股`], ["每股分红", `¥${div}`], ["你拿到", `¥${youGet.toFixed(0)}`]]} />
      </div>
    </VizShell>
  );
}

/* ─────────────── 除权：蛋糕切更多块 ─────────────── */
export function ExRightAdjust({ config }: { config?: Record<string, unknown> }) {
  const [bonus, setBonus] = useState(10); // 10送bonus
  const basePrice = 10;
  const baseShares = 100;
  const ratio = 1 + bonus / 10;
  const newPrice = basePrice / ratio;
  const newShares = Math.round(baseShares * ratio);
  const before = basePrice * baseShares;
  const after = newPrice * newShares;
  return (
    <VizShell
      icon="🍰"
      title={config?.title ? String(config.title) : "除权：一块蛋糕切更多块"}
      caption="「除权」是分红送股后，股价按规则下调、股数变多。你手里的总价值其实没变——只是蛋糕被切成更多块。"
      hint="切换「10送几」，看股价和股数怎么变，但总资产不变。"
      insight="除权不是你亏了钱，是账面上把「送的那部分」从股价里扣掉。盯着总资产（价格×股数）才不会被吓到。"
    >
      <div className="viz-seg w-full justify-center">
        {[0, 5, 10].map((b) => (
          <button key={b} type="button" aria-pressed={bonus === b} onClick={() => setBonus(b)}>
            {b === 0 ? "不送" : `10送${b}`}
          </button>
        ))}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        {[
          { t: "送前", p: basePrice, s: baseShares },
          { t: "送后", p: newPrice, s: newShares },
        ].map((x) => (
          <div key={x.t} className="card p-3 text-center">
            <div className="text-xs text-[var(--color-muted)]">{x.t}</div>
            <div className="stat-num text-lg">¥{x.p.toFixed(2)}</div>
            <div className="text-xs text-[var(--color-muted)]">{x.s} 股</div>
            <div className="mt-1 text-sm font-bold text-[var(--brand-strong)]">总值 ¥{Math.round(x.p * x.s)}</div>
          </div>
        ))}
      </div>
      <div className="mt-3">
        <VizTable
          headers={["", "股价", "股数", "总值"]}
          rows={[
            ["送前", `¥${basePrice}`, baseShares, `¥${before}`],
            ["送后", `¥${newPrice.toFixed(2)}`, newShares, `¥${Math.round(after)}`],
          ]}
        />
      </div>
    </VizShell>
  );
}

/* ─────────────── 换手率：一天转手多少 ─────────────── */
export function TurnoverPie({ config }: { config?: Record<string, unknown> }) {
  const [r, setR] = useState(5); // 换手率 %
  const moved = Math.min(100, r);
  const R = 42,
    C = 2 * Math.PI * R;
  const dash = (moved / 100) * C;
  const tone = r < 3 ? "neutral" : r <= 10 ? "brand" : "warn";
  const label = r < 3 ? "冷清🥱" : r <= 10 ? "活跃🙂" : "火爆🔥";
  return (
    <VizShell
      icon="🔄"
      title={config?.title ? String(config.title) : "今天转手了多少？"}
      caption="换手率＝今天买卖的股票占全部的比例。比例越高，说明大家倒手越频繁、越热闹。"
      hint="拖动滑块调高换手率，看圆环里「转手」的部分怎么变大。"
      insight="换手太低说明没人气；太高（尤其配合大涨大跌）说明短线客在快进快出，波动可能变大。"
    >
      <div className="flex justify-center">
        <svg viewBox="0 0 120 120" width="160" height="160" role="img" aria-label="换手率圆环">
          <circle cx="60" cy="60" r={R} fill="none" stroke="var(--color-border)" strokeWidth="16" />
          <circle
            cx="60" cy="60" r={R} fill="none" stroke={tone === "warn" ? "var(--warn)" : tone === "brand" ? "var(--brand)" : "var(--color-muted)"}
            strokeWidth="16" strokeLinecap="round"
            strokeDasharray={`${dash} ${C - dash}`}
            transform="rotate(-90 60 60)"
          />
          <text x="60" y="58" textAnchor="middle" fontSize="22" fontWeight="800" fill="var(--color-fg)">{r}%</text>
          <text x="60" y="76" textAnchor="middle" fontSize="11" fill="var(--color-muted)">换手率</text>
        </svg>
      </div>
      <div className="mt-1 grid grid-cols-2 gap-2">
        <StatTag label="转手比例" value={`${r}%`} tone={tone} />
        <StatTag label="人气" value={label.split("·")[0]} tone={tone} />
      </div>
      <Slider label="换手率" min={0} max={20} step={0.5} value={r} onChange={setR} accent={tone === "warn" ? "var(--warn)" : "var(--brand)"} />
    </VizShell>
  );
}

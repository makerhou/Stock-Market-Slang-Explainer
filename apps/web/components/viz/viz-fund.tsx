"use client";

import { useState } from "react";
import { VizShell, Slider, StatTag, VizTable } from "./viz-basics";

/* ─────────────── 沪深港通资金流：北向（外资买A股）/ 南向（内地钱买港股） ─────────────── */
export function MoneyFlow({ config }: { config?: Record<string, unknown> }) {
  const south = config?.direction === "south";
  const [dir, setDir] = useState<"in" | "out">("in");
  const [amt, setAmt] = useState(80); // 亿元
  const inFlow = dir === "in";
  const color = inFlow ? "var(--down)" : "var(--up)"; // 净买入用绿(资金进来友好)，净卖出用红
  const fromX = inFlow ? 20 : 140;
  const toX = inFlow ? 140 : 20;
  const leftLabel = south ? "内地" : "香港/海外";
  const rightLabel = south ? "港股" : "A股";
  return (
    <VizShell
      icon="🌊"
      title={config?.title ? String(config.title) : south ? "南向资金：内地钱在买港股" : "外资在买还是在卖？"}
      caption={south
        ? "「港股通」是内地资金南下买港股的官方通道。净买入＝内地钱流进港股；净卖出＝钱撤回来。"
        : "「北向资金」是香港及海外资金通过沪深港通买卖 A 股的钱流。净买入＝钱流进 A 股；净卖出＝钱流出。"}
      hint="切换「净买入 / 净卖出」，再拖金额，看水流方向和大小。"
      insight={south
        ? "南向资金近年是港股的重要定价力量。但它只是参考：连续净卖出时，港股常常真的软。" : "北向资金常被叫作「聪明钱」风向标，但它只是参考、不是预言。一天净流出不代表要崩，别被单日数据带节奏。"}
    >
      <svg viewBox="0 0 160 110" className="w-full max-w-[300px] mx-auto" role="img" aria-label="资金流向">
        <rect x="8" y="38" width="44" height="34" rx="8" fill="var(--brand-soft)" />
        <text x="30" y="60" textAnchor="middle" fontSize="11" fill="var(--brand-strong)">{leftLabel}</text>
        <rect x="108" y="38" width="44" height="34" rx="8" fill="var(--brand)" />
        <text x="130" y="60" textAnchor="middle" fontSize="11" fill="#fff">{rightLabel}</text>
        <line x1={fromX} y1="55" x2={toX} y2="55" stroke={color} strokeWidth={Math.max(3, amt / 12)} strokeLinecap="round" />
        <polygon points={`${toX},55 ${toX - (inFlow ? 10 : -10)},50 ${toX - (inFlow ? 10 : -10)},60`} fill={color} />
        <text x="80" y="30" textAnchor="middle" fontSize="12" fontWeight="700" fill={color}>
          {inFlow ? "流入 →" : "← 流出"}
        </text>
      </svg>
      <div className="mt-1 grid grid-cols-2 gap-2">
        <StatTag label="方向" value={inFlow ? "净买入" : "净卖出"} tone={inFlow ? "ok" : "warn"} />
        <StatTag label="金额" value={`¥${amt}亿`} tone={inFlow ? "ok" : "warn"} />
      </div>
      <div className="viz-seg w-full justify-center">
        <button type="button" aria-pressed={inFlow} onClick={() => setDir("in")}>净买入</button>
        <button type="button" aria-pressed={!inFlow} onClick={() => setDir("out")}>净卖出</button>
      </div>
      <div className="mt-2">
        <Slider label="金额（亿元）" min={0} max={200} step={5} value={amt} onChange={setAmt} accent={color} />
      </div>
    </VizShell>
  );
}

/* ─────────────── 融资融券：做多 / 做空（路径对比） ─────────────── */
export function LongShortSeesaw({ config }: { config?: Record<string, unknown> }) {
  const board = config?.variant === "board"; // 龙虎榜模式：买方席位 vs 卖方席位
  const [side, setSide] = useState<"long" | "short">("long");
  const [buyAmt, setBuyAmt] = useState(8000); // 万元
  const [sellAmt, setSellAmt] = useState(3000);
  const [entry, setEntry] = useState(10); // 买入价（做空时为卖出价）
  const [exit, setExit] = useState(13); // 卖出价（做空时为买回价）
  const [deposit, setDeposit] = useState(50); // 保证金成数（%）
  const long = side === "long";
  const profit = long ? exit - entry : entry - exit;
  const win = profit >= 0;
  // 杠杆倍数 = 本金 / 保证金；盈亏按本金 1 万元随手举例
  const leverage = 100 / Math.max(5, deposit);
  const pnl = profit * 100 * leverage;
  return (
    <VizShell
      icon="🎚️"
      title={config?.title ? String(config.title) : "做多还是做空？"}
      caption={board
        ? "龙虎榜把异动股票买卖最猛的席位公开张贴：买方前五 vs 卖方前五，一眼看清谁在进、谁在撤。"
        : long
          ? "融资做多：借钱先把股票买进来，涨了再卖掉还钱——低买高卖。"
          : "融券做空：先借股票卖掉，等跌了再买回来还——高卖低买。"}
      hint={board ? "拖动买卖两边的金额，看净买入还是净卖出占优" : "切换「融资 / 融券」，拖买卖两价和保证金，看盈亏怎么变"}
      insight={board
        ? "💡 龙虎榜只是公开信息：机构席位大买可能是真看好，游资上榜也可能是一日游，照抄需谨慎。"
        : "💡 做多是先买后卖、做空是先卖后买，方向相反但逻辑都是「赚差价」。杠杆放大盈亏，做错方向同样被放大。"}
    >
      {board ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Slider label="买方席位合计（万元）" min={0} max={20000} step={500} value={buyAmt}
              onChange={setBuyAmt} format={(v) => v.toLocaleString("zh-CN")} accent="var(--up)" />
            <Slider label="卖方席位合计（万元）" min={0} max={20000} step={500} value={sellAmt}
              onChange={setSellAmt} format={(v) => v.toLocaleString("zh-CN")} accent="var(--down)" />
          </div>
          <div className="mt-2 flex h-8 overflow-hidden rounded-full border border-[var(--color-border)]">
            <div className="flex items-center justify-center bg-[var(--up-bg)] text-xs font-bold text-[var(--up)]"
              style={{ width: `${(buyAmt / (buyAmt + sellAmt)) * 100}%` }}>
              买 {buyAmt.toLocaleString("zh-CN")}
            </div>
            <div className="flex flex-1 items-center justify-center bg-[var(--down-bg)] text-xs font-bold text-[var(--down)]">
              卖 {sellAmt.toLocaleString("zh-CN")}
            </div>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2">
            <StatTag label="净买卖" value={buyAmt >= sellAmt ? "净买入" : "净卖出"}
              tone={buyAmt >= sellAmt ? "up" : "down"} />
            <StatTag label="净额" value={`${(buyAmt - sellAmt >= 0 ? "+" : "")}${(buyAmt - sellAmt).toLocaleString("zh-CN")} 万`}
              tone={buyAmt >= sellAmt ? "up" : "down"} />
            <StatTag label="信号" value={buyAmt > sellAmt * 2 ? "抢筹" : buyAmt * 2 < sellAmt ? "撤退" : "拉锯"} tone="neutral" />
          </div>
          <div className="mt-3">
            <VizTable
              headers={["席位类型", "像谁", "要防什么"]}
              rows={[
                ["知名游资营业部", "短线敢死队", "今天上榜、明天闷杀"],
                ["机构专用", "公募/保险等", "可能只是调仓，不是看多"],
                ["量化/程序", "机器人", "制造假流入、假放量"],
              ]}
            />
          </div>
        </>
      ) : (
        <>
          <div className="viz-seg w-full justify-center">
            <button type="button" aria-pressed={long} onClick={() => setSide("long")}>📈 融资（做多）</button>
            <button type="button" aria-pressed={!long} onClick={() => setSide("short")}>📉 融券（做空）</button>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Slider label={long ? "买入价（元）" : "卖出价（元）"} min={5} max={20} step={0.5} value={entry}
              onChange={setEntry} format={(v) => v.toFixed(1)} accent="var(--brand)" />
            <Slider label={long ? "卖出价（元）" : "买回价（元）"} min={5} max={20} step={0.5} value={exit}
              onChange={setExit} format={(v) => v.toFixed(1)} accent={win ? "var(--up)" : "var(--down)"} />
          </div>
          <div className="mt-3">
            <Slider label="保证金（本金占比，越低杠杆越高）" min={10} max={100} step={5} value={deposit}
              onChange={setDeposit} format={(v) => `${v}% → ${leverage.toFixed(1)} 倍杠杆`} accent="var(--warn)" />
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2">
            <StatTag label="每股价差" value={`${win ? "+" : ""}${profit.toFixed(1)} 元`} tone={win ? "up" : "down"} />
            <StatTag label="1 万股盈亏" value={`${pnl >= 0 ? "+" : ""}${pnl.toFixed(0)} 元`} tone={win ? "up" : "down"} />
            <StatTag label="方向" value={long ? "赚上涨" : "赚下跌"} tone="brand" />
          </div>
          <div className="mt-3">
            <VizTable
              headers={["", "第一步", "第二步", "盈亏来源"]}
              rows={[
                ["融资做多", "借钱买入", "涨后卖出还钱", "卖价 − 买价"],
                ["融券做空", "借股卖出", "跌后买股还股", "卖价 − 买价"],
                ["共同风险", "要付利息", "可能被强制平仓", "杠杆双刃剑"],
              ]}
            />
          </div>
          <p className="mt-2 text-xs text-[var(--color-muted)]">
            注：仅为说明机制，未计利息、手续费与保证金追缴；真实杠杆交易风险更高。
          </p>
        </>
      )}
    </VizShell>
  );
}

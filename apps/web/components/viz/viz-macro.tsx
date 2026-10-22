"use client";

import { useState } from "react";
import { VizShell, Slider, StatTag, VizTable } from "./viz-basics";

/* ─────────────── GDP：四个季度加起来 ─────────────── */
export function GDPStack({ config }: { config?: Record<string, unknown> }) {
  const [qs, setQs] = useState<[number, number, number, number]>([25, 26, 27, 28]);
  const total = qs.reduce((a, b) => a + b, 0);
  const maxQ = 60;
  const colors = ["#6366f1", "#4f46e5", "#4338ca", "#7c3aed"];
  const setQ = (i: number, v: number) => {
    const n = [...qs] as [number, number, number, number];
    n[i] = v;
    setQs(n);
  };
  return (
    <VizShell
      icon="🧱"
      title={config?.title ? String(config.title) : "一年生产了多少？"}
      caption="GDP 就像用四个季度的积木搭成的高塔：Q1+Q2+Q3+Q4 = 全年生产的总价值。"
      hint="拖动四个滑块，看高塔变高变矮，全年总量跟着变。"
      insight="GDP 涨，说明这一年大家生产的东西整体变多了，经济像在长个子。但它不等于你钱包里钱变多。"
    >
      <div className="flex items-end justify-center gap-2" style={{ height: 170 }}>
        {qs.map((v, i) => (
          <div key={i} className="flex flex-col items-center">
            <div className="stat-num text-xs" style={{ color: colors[i] }}>{v}</div>
            <div style={{ width: 34, height: (v / maxQ) * 130, background: colors[i], borderRadius: 6 }} />
            <div className="mt-1 text-[0.7rem] text-[var(--color-muted)]">Q{i + 1}</div>
          </div>
        ))}
      </div>
      <div className="mt-2 text-center">
        <span className="stat-num text-2xl text-[var(--brand-strong)]">全年 ≈ {total}</span>
        <span className="ml-1 text-sm text-[var(--color-muted)]">（单位：示例值）</span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
        {qs.map((v, i) => (
          <Slider key={i} label={`第 ${i + 1} 季度`} min={5} max={maxQ} step={1} value={v} onChange={(x) => setQ(i, x)} accent={colors[i]} />
        ))}
      </div>
      <div className="mt-3">
        <VizTable headers={["季度", "生产价值"]} rows={qs.map((v, i) => [`Q${i + 1}`, v])} />
      </div>
    </VizShell>
  );
}

/* ─────────────── CPI：一篮子物价 ─────────────── */
export function CPIBasket({ config }: { config?: Record<string, unknown> }) {
  const [idx, setIdx] = useState(102);
  const goods = [
    { e: "🍚", n: "大米" },
    { e: "🥬", n: "青菜" },
    { e: "🚌", n: "公交" },
    { e: "🎓", n: "学费" },
    { e: "🏥", n: "看病" },
  ];
  const tone = idx > 103 ? "up" : idx < 99 ? "down" : "neutral";
  const label = idx > 103 ? "东西变贵了·钱毛了" : idx < 99 ? "东西变便宜了" : "物价基本没变";
  return (
    <VizShell
      icon="🧺"
      title={config?.title ? String(config.title) : "钱是不是毛了？"}
      caption="CPI 就是跟踪一篮子日常开销（吃饭、坐车、上学…）的价格。指数越高，同样一笔钱能买的东西越少。"
      hint="拖动滑块改变物价指数，看篮子里东西的「价格标签」怎么变。"
      insight="CPI 涨太多叫通胀（钱不值钱）；一直跌叫通缩（东西便宜但大家不敢花）。它只算日常消费，不含买房。"
    >
      <div className="flex flex-wrap justify-center gap-3 py-2">
        {goods.map((g) => (
          <div key={g.n} className="flex flex-col items-center">
            <div className="text-3xl" aria-hidden>{g.e}</div>
            <div className="text-[0.7rem] text-[var(--color-muted)]">{g.n}</div>
            <div className="stat-num text-xs" style={{ color: idx > 100 ? "var(--up)" : "var(--down)" }}>
              ×{(idx / 100).toFixed(2)}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <StatTag label="CPI 指数" value={idx.toFixed(1)} tone={tone} />
        <StatTag label="含义" value={label.split("·")[0]} tone={tone} />
      </div>
      <Slider label="物价指数（100=去年）" min={90} max={115} step={0.5} value={idx} onChange={setIdx} accent={idx > 100 ? "var(--up)" : "var(--down)"} />
    </VizShell>
  );
}

/* ─────────────── 去库存：卖货回笼资金 ─────────────── */
export function InventoryClear({ config }: { config?: Record<string, unknown> }) {
  const [sell, setSell] = useState(30); // 卖出速度 0..100
  const remain = 100 - sell;
  const cash = sell * 1; // 回笼资金（示例：每卖1件回1万）
  const boxes = Array.from({ length: 30 });
  return (
    <VizShell
      icon="📦"
      title={config?.title ? String(config.title) : "把积压的货卖掉"}
      caption="「去库存」就是企业把仓库里堆着的货卖出去，换成钱。卖得越快，仓库越空、手里的钱越多。"
      hint="拖动滑块加大卖货速度，看仓库里的箱子怎么变少、回笼的钱怎么变多。"
      insight="货变成钱叫「回笼资金」。库存太高占用钱，去库存能让企业轻装上阵——但它只是经营现象，不预测股价。"
    >
      <div className="grid grid-cols-6 gap-1.5">
        {boxes.map((_, i) => {
          const filled = i < Math.round((remain / 100) * 30);
          return (
            <div
              key={i}
              style={{
                height: 26,
                borderRadius: 5,
                background: filled ? "var(--warn)" : "var(--color-border)",
                opacity: filled ? 1 : 0.5,
              }}
            />
          );
        })}
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2">
        <StatTag label="仓库剩余" value={`${remain}%`} tone="warn" />
        <StatTag label="已卖出" value={`${sell}%`} tone="ok" />
        <StatTag label="回笼资金" value={`${cash}万`} tone="brand" />
      </div>
      <Slider label="卖货速度" min={0} max={100} step={1} value={sell} onChange={setSell} accent="var(--ok)" />
    </VizShell>
  );
}

/* ─────────────── 扩容：池子里的鱼变多 ─────────────── */
export function PoolDilution({ config }: { config?: Record<string, unknown> }) {
  const [newStocks, setNewStocks] = useState(200); // 新股数量
  const mine = 1;
  const total = 200 + newStocks;
  const myPct = (mine / total) * 100;
  return (
    <VizShell
      icon="🐟"
      title={config?.title ? String(config.title) : "池子里的鱼变多了"}
      caption="「扩容」就是市场里能买的股票变多了（比如新股上市）。你手里那一条鱼占的比例就被稀释了。"
      hint="拖动滑块增加新股数量，看你那条鱼占的份额怎么变小。"
      insight="股票变多，资金还是那么多，你的「份额」就被摊薄。扩容本身不好坏，关键看有没有新钱进来。"
    >
      <div className="flex h-5 w-full overflow-hidden rounded-full bg-[var(--color-border)]">
        <div style={{ width: `${myPct}%`, height: "100%", background: "var(--brand)" }} />
      </div>
      <div className="mt-2 text-center">
        <span className="stat-num text-xl text-[var(--brand-strong)]">你占 {myPct.toFixed(2)}%</span>
        <span className="ml-1 text-sm text-[var(--color-muted)]">（原来约 0.50%）</span>
      </div>
      <Slider label="新股数量（条鱼）" min={0} max={800} step={10} value={newStocks} onChange={setNewStocks} accent="var(--down)" />
    </VizShell>
  );
}

/* ─────────────── 解禁：锁着的股票能卖了 ─────────────── */
export function UnlockPressure({ config }: { config?: Record<string, unknown> }) {
  const [p, setP] = useState(20); // 解禁比例
  const open = p >= 1;
  return (
    <VizShell
      icon="🔓"
      title={config?.title ? String(config.title) : "锁着的股票解锁了"}
      caption="「解禁」是原本不能卖的股票（比如老板、早期投资人的）到了时间可以卖了。能卖的人变多，就可能多卖压。"
      hint="拖动滑块调大解禁比例，看锁打开、卖压箭头变粗。"
      insight="解禁≠一定会跌，但「能卖」变成「可能卖」，供给变多会对价格有压力。别一听解禁就慌，要看量和价。"
    >
      <div className="flex flex-col items-center gap-2">
        <div className="text-5xl" aria-hidden style={{ filter: open ? "none" : "grayscale(1)" }}>
          {open ? "🔓" : "🔒"}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-[var(--color-muted)]">卖压</span>
          <div className="flex items-end gap-0.5" style={{ height: 40 }}>
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                style={{
                  width: 7,
                  height: 8 + i * 8,
                  background: "var(--down)",
                  opacity: p / 50 >= (i + 1) / 4 ? 1 : 0.25,
                  borderRadius: 2,
                }}
              />
            ))}
          </div>
        </div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <StatTag label="解禁比例" value={`${p}%`} tone={p > 30 ? "warn" : "neutral"} />
        <StatTag label="状态" value={open ? "已解锁" : "未解锁"} tone={open ? "warn" : "ok"} />
      </div>
      <Slider label="解禁比例" min={0} max={50} step={1} value={p} onChange={setP} accent={p > 30 ? "var(--warn)" : "var(--brand)"} />
    </VizShell>
  );
}

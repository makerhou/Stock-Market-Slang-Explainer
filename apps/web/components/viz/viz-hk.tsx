"use client";

import { useState } from "react";
import { VizShell, Slider, StatTag, SegToggle, VizTable } from "./viz-basics";

/* ───────────────────────── 窝轮 / 牛熊证（杠杆产品） ───────────────────────── */

/**
 * LeverageWheel：窝轮（warrant）与牛熊证（CBBC）都是「带杠杆的认股凭证」。
 * - warrant 模式：拖正股涨跌 + 杠杆倍数 → 窝轮涨跌（盈损同放大）
 * - cbbc 模式：拖正股价 vs 收回价 → 触发收回即归零
 */
export function LeverageWheel({ config }: { config?: Record<string, unknown> }) {
  const mode = config?.mode === "cbbc" ? "cbbc" : "warrant";
  const [kind, setKind] = useState<"bull" | "bear">(config?.kind === "bear" ? "bear" : "bull");
  const leverage = Number(config?.leverage ?? 10);

  // 窝轮模式
  const [underlyingPct, setUnderlyingPct] = useState(3); // 正股涨跌 %
  const wheelPct = kind === "bull" ? underlyingPct * leverage : -underlyingPct * leverage;
  const wheelUp = wheelPct >= 0;

  // 牛熊证模式
  const [spot, setSpot] = useState(52);
  const strike = Number(config?.strike ?? 50);
  const knocked = kind === "bull" ? spot <= strike : spot >= strike;
  const dist = kind === "bull" ? ((spot - strike) / spot) * 100 : ((strike - spot) / spot) * 100;
  const cbbcPct = knocked ? -100 : dist * (leverage / 10);

  return (
    <VizShell
      title={mode === "cbbc" ? "牛熊证：带「熔断」的杠杆" : "窝轮：小钱放大涨跌"}
      caption={
        mode === "cbbc"
          ? "牛熊证（CBBC）= 带强制收回条款的杠杆产品。价格碰到收回价 → 立刻归零，哪怕只碰一下。"
          : "窝轮（涡轮）= 上市公司/银行发行的认股证。花很少的钱就能撬动正股涨跌，但杠杆双向放大。"
      }
      hint={mode === "cbbc"
        ? "切换牛/熊证，拖动「正股价」逼近收回价试试"
        : "切换牛/熊证，拖动「正股涨跌」，看杠杆怎么放大盈亏"}
      insight={
        mode === "cbbc"
          ? "💡 牛熊证的宿命是「归零」：时间损耗 + 收回机制，多数散户拿到底就是零。"
          : "💡 杠杆放大盈亏：正股跌 1%，10 倍杠杆的窝轮可能跌 10%+，还可能一天归零。"
      }
    >
      <SegToggle value={kind} onChange={setKind}
        options={[
          { value: "bull", label: "🐂 牛证（看涨）" },
          { value: "bear", label: "🐻 熊证（看跌）" },
        ]} />

      {mode === "cbbc" ? (
        <>
          <div className="mt-3">
            <Slider label={`正股价｜收回价 ${strike} 元`} min={Math.max(1, strike - 25)} max={strike + 25} step={0.5}
              value={spot} onChange={setSpot} format={(v) => v.toFixed(1)}
              accent={knocked ? "var(--down)" : kind === "bull" ? "var(--up)" : "var(--down)"} />
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2">
            <StatTag label="距收回价" value={`${dist.toFixed(1)}%`} tone="neutral" />
            <StatTag label={knocked ? "状态" : "你的浮盈"} value={knocked ? "⚡ 已触发收回" : `+${cbbcPct.toFixed(0)}%`}
              tone={knocked ? "down" : "up"} />
            <StatTag label={knocked ? "收回后" : "杠杆（约）"} value={knocked ? "归零 ❌" : `${leverage} 倍`}
              tone={knocked ? "warn" : "brand"} />
          </div>
          <div className="mt-3">
            <VizTable
              headers={["情况", "发生什么", "你的钱"]}
              rows={[
                ["没碰收回价", "杠杆放大涨跌", "可能赚很多"],
                ["碰了一下收回价", "强制收回（立即结算）", "基本归零"],
                ["天天持有", "时间价值损耗", "横盘也缩水"],
              ]}
            />
          </div>
        </>
      ) : (
        <>
          <div className="mt-3">
            <Slider label="正股涨跌幅" min={-10} max={10} step={0.5} value={underlyingPct}
              onChange={setUnderlyingPct} format={(v) => `${v > 0 ? "+" : ""}${v}%`}
              accent={underlyingPct >= 0 ? "var(--up)" : "var(--down)"} />
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2">
            <StatTag label="杠杆倍数" value={`${leverage} 倍`} tone="brand" />
            <StatTag label="窝轮涨跌幅" value={`${wheelUp ? "+" : ""}${wheelPct.toFixed(0)}%`} tone={wheelUp ? "up" : "down"} />
            <StatTag label="感受" value={Math.abs(wheelPct) > 50 ? "😱 心跳加速" : Math.abs(wheelPct) > 20 ? "😬 够刺激" : "🙂 还好"} tone="neutral" />
          </div>
          <div className="mt-3">
            <VizTable
              headers={["正股", "窝轮（10 倍杠杆）", "说明"]}
              rows={[
                ["+1%", `${kind === "bull" ? "+10%" : "-10%"}`, "杠杆双向放大"],
                ["+5%", `${kind === "bull" ? "+50%" : "-50%"}`, "小钱撬大钱"],
                ["-5%", `${kind === "bull" ? "-50%" : "+50%"}`, "赌错方向亏得快"],
              ]}
            />
          </div>
        </>
      )}
    </VizShell>
  );
}

/* ───────────────────────── 暗盘 ───────────────────────── */

/** GreyMarket：暗盘 = 新股上市前一天的场外交易（券商内部撮合）。 */
export function GreyMarket({ config }: { config?: Record<string, unknown> }) {
  const issue = Number(config?.issuePrice ?? 10);
  const [grey, setGrey] = useState(11.5);
  const premium = ((grey - issue) / issue) * 100;
  const hot = premium >= 0;
  return (
    <VizShell
      title={config?.title ? String(config.title) : "暗盘：上市前一天的「影子市场」"}
      caption={`新股还没正式挂牌，部分券商在上市前一天内部撮合买卖——这就是暗盘。发行价 ${issue} 元。`}
      hint="拖动「暗盘成交价」，看暗盘冷热对第一天心情的影响"
      insight="💡 暗盘火爆 ≠ 上市一定涨，只代表部分人的提前报价；暗盘破发往往是危险信号。"
    >
      <Slider label="暗盘成交价（元）" min={issue * 0.5} max={issue * 2} step={0.1} value={grey}
        onChange={setGrey} format={(v) => v.toFixed(1)} accent={hot ? "var(--up)" : "var(--down)"} />
      <div className="mt-3 grid grid-cols-3 gap-2">
        <StatTag label="发行价" value={`${issue.toFixed(1)} 元`} tone="neutral" />
        <StatTag label="暗盘价" value={`${grey.toFixed(1)} 元`} tone="brand" />
        <StatTag label="暗盘溢价" value={`${premium >= 0 ? "+" : ""}${premium.toFixed(0)}%`} tone={hot ? "up" : "down"} />
      </div>
      <div className="mt-3">
        <VizTable
          headers={["暗盘信号", "含义", "第二天可能"]}
          rows={[
            ["暗盘大涨（抢货）", "很多人想要这新股", "上市常高开，但可能一步到位"],
            ["暗盘小涨", "情绪一般", "平稳开局"],
            ["暗盘破发", "没人要 / 定价太高", "上市凶多吉少"],
          ]}
        />
      </div>
    </VizShell>
  );
}

/* ───────────────────────── 港股股票家族 ───────────────────────── */

const HK_TYPES = [
  {
    key: "blue", label: "🟦 蓝筹股", where: "香港注册（或国际）", eg: "汇丰、腾讯、友邦",
    note: "市值大、业务稳、常年派息，指数的「定海神针」。",
  },
  {
    key: "red", label: "🔴 红筹股", where: "境外注册、香港上市", eg: "中国移动（香港）、华润置地",
    note: "内地资本控股，但在香港注册上市，募的是港币/美元。",
  },
  {
    key: "h", label: "🅷 H 股", where: "内地注册、香港上市", eg: "工商银行 H、青岛啤酒 H",
    note: "内地公司的香港分身：A+H 两地上市，股价常常「同股不同价」。",
  },
  {
    key: "cn", label: "🇺🇸 中概股", where: "内地/开曼注册、美股上市", eg: "阿里巴巴、京东、拼多多",
    note: "去美国上市的中国公司，多为 ADR；受中美两边政策影响。",
  },
];

/** HkTypesCompare：点选蓝筹/红筹/H股/中概，看注册地与例子。 */
export function HkTypesCompare({ config }: { config?: Record<string, unknown> }) {
  const def = String(config?.defaultKey ?? "h");
  const [sel, setSel] = useState(def);
  const cur = HK_TYPES.find((x) => x.key === sel) ?? HK_TYPES[2];
  if (!cur) return null;
  return (
    <VizShell
      title={config?.title ? String(config.title) : "港股四兄弟：蓝筹 / 红筹 / H股 / 中概"}
      caption="都在香港或美国交易，差别在「公司在哪注册、去哪上市、赚谁的钱」。"
      hint="点一家看它的户口在哪、举几个例子"
      insight="💡 别把「港股」当一个整体：蓝筹稳、H 股折价、中概波动大，脾气完全不同。"
    >
      <div className="grid grid-cols-2 gap-2">
        {HK_TYPES.map((t) => (
          <button key={t.key} type="button" onClick={() => setSel(t.key)} aria-pressed={t.key === sel}
            className={t.key === sel
              ? "rounded-xl border-2 border-[var(--brand)] bg-[var(--brand-soft)] px-3 py-2 text-left text-xs font-semibold text-[var(--brand-strong)]"
              : "rounded-xl border border-[var(--color-border)] bg-white px-3 py-2 text-left text-xs font-medium text-[var(--color-body)] hover:border-[var(--brand-ring)]"}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="mt-3 rounded-xl bg-[var(--color-bg)] p-3 text-sm leading-relaxed text-[var(--color-body)]">
        <p><span className="font-semibold text-[var(--color-fg)]">在哪注册/上市：</span>{cur.where}</p>
        <p className="mt-1"><span className="font-semibold text-[var(--color-fg)]">例子：</span>{cur.eg}</p>
        <p className="mt-1"><span className="font-semibold text-[var(--color-fg)]">特点：</span>{cur.note}</p>
      </div>
      <div className="mt-3">
        <VizTable
          headers={["类型", "注册地", "典型代表"]}
          rows={HK_TYPES.map((t) => [t.label, t.where, t.eg])}
        />
      </div>
    </VizShell>
  );
}

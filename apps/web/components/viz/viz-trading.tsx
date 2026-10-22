"use client";

import { useState } from "react";
import { VizShell, Slider, StatTag, SegToggle, VizTable } from "./viz-basics";

/* ───────────────────────── 打新（新股申购） ───────────────────────── */

/**
 * IpoLottery：打新 = 摇号中签 + 上市首日涨跌。
 * 互动：拖中签率、拖首日涨幅 → 中一签（500 股）赚/亏。
 */
export function IpoLottery({ config }: { config?: Record<string, unknown> }) {
  const issuePrice = Number(config?.issuePrice ?? 10);
  const [rate, setRate] = useState(Number(config?.rate ?? 0.03)); // 中签率 %
  const [firstDay, setFirstDay] = useState(0); // 首日涨跌 %
  const perShare = issuePrice * (firstDay / 100);
  const won = 500 * perShare; // 一签常为 500 股
  const up = firstDay >= 0;
  return (
    <VizShell
      title={config?.title ? String(config.title) : "打新就像抽奖，中了才买"}
      caption={`发行价 ${issuePrice} 元，先交钱摇号；中一签 ${500} 股，上市首日涨跌决定赚亏。`}
      hint="拖动两个滑块：中签率决定「多少人抢」，首日涨跌决定「中了赚多少」"
      insight={
        up
          ? "💡 首日涨 → 中的签就赚钱；但打新不是稳赚，破发也会亏。"
          : "💡 首日跌（破发）→ 中的签也亏钱。打新有风险，不是保本理财。"
      }
    >
      <Slider label="中签率（10000 个人里几个中）" min={0.01} max={1} step={0.01} value={rate}
        onChange={setRate} format={(v) => `${v.toFixed(2)}%`} accent="var(--brand)" />
      <Slider label="上市首日涨跌幅" min={-44} max={44} step={4} value={firstDay}
        onChange={setFirstDay} format={(v) => `${v > 0 ? "+" : ""}${v}%`}
        accent={up ? "var(--up)" : "var(--down)"} />
      <div className="mt-3 grid grid-cols-3 gap-2">
        <StatTag label="一签股数" value={`${500} 股`} tone="neutral" />
        <StatTag label="每股赚亏" value={`${perShare >= 0 ? "+" : ""}${perShare.toFixed(2)} 元`} tone={up ? "up" : "down"} />
        <StatTag label="中一签赚亏" value={`${won >= 0 ? "+" : ""}${won.toFixed(0)} 元`} tone={up ? "up" : "down"} />
      </div>
      <div className="mt-3">
        <VizTable
          headers={["情况", "要做什么", "结果"]}
          rows={[
            ["申购", "交钱+摇号", `中签率 ${rate.toFixed(2)}% ≈ 1 万个人里 ${Math.round(10000 * rate / 100)} 个中`],
            [up ? "中签且首日涨" : "中签且首日跌", "上市就能卖出", `${up ? "赚" : "亏"} ${Math.abs(won).toFixed(0)} 元`],
            ["没中", "钱自动退回", "不赚不亏"],
          ]}
        />
      </div>
    </VizShell>
  );
}

/* ───────────────────────── 破发 ───────────────────────── */

/** 破发=上市后价格跌破发行价（复用打新心智，独立小图） */
export function BreakIssue({ config }: { config?: Record<string, unknown> }) {
  const issue = Number(10);
  const [now, setNow] = useState(8);
  const pctChange = ((now - issue) / issue) * 100;
  const broken = now < issue;
  return (
    <VizShell
      title={config?.title ? String(config.title) : "破发：跌破出生价"}
      caption={`发行价 ${issue} 元。现价拖到 ${issue} 元以下，就是「破发」。`}
      hint="拖动滑块，看价格跌破发行价的一瞬间"
      insight={broken ? "💡 现价低于发行价：打新中签的人亏钱，公司面子也不好看。" : "💡 现价高于发行价：暂时安全。"}
    >
      <Slider label="现在股价（元）" min={4} max={20} step={0.5} value={now} onChange={setNow}
        format={(v) => v.toFixed(1)} accent={broken ? "var(--down)" : "var(--up)"} />
      <div className="mt-3">
        <VizTable
          headers={["对比", "价格", "说明"]}
          rows={[
            ["发行价（出生价）", `${issue.toFixed(1)} 元`, "公司上市定价"],
            ["现价", `${now.toFixed(1)} 元`, broken ? "❌ 破发了" : "✅ 还在发行价上方"],
            ["相对发行价", `${pctChange >= 0 ? "+" : ""}${pctChange.toFixed(1)}%`, broken ? "打新中签 = 亏" : "打新中签 = 赚"],
          ]}
        />
      </div>
    </VizShell>
  );
}

/* ───────────────────────── 割肉 / 套牢 ───────────────────────── */

/**
 * TrapScale：买入价 vs 现价 → 浮亏/割肉金额 + 「回本需要涨多少」表。
 * mode：trap（还拿着）/ cut（割肉卖掉）。
 */
export function TrapScale({ config }: { config?: Record<string, unknown> }) {
  const mode = config?.mode === "cut" ? "cut" : "trap";
  const [buy, setBuy] = useState(20);
  const [now, setNow] = useState(14);
  const lossPct = ((now - buy) / buy) * 100; // 负=亏
  const losing = lossPct < 0;
  const needBack = buy > 0 && now > 0 ? ((buy - now) / now) * 100 : 0; // 回本需涨%
  const cut = mode === "cut";
  const shares = Number(config?.shares ?? 1000);
  return (
    <VizShell
      title={cut ? "割肉：亏损也要卖掉" : "套牢：买了就跌，舍不得卖"}
      caption={`你按买入价买了 ${shares} 股。拖动「现价」看亏多少${cut ? "，以及卖掉后真正亏掉的钱" : "，以及回本需要涨多少"}。`}
      hint="拖动「买入价」和「现价」两个滑块"
      insight={
        cut
          ? "💡 割肉 = 把浮亏变成真亏：卖掉后钱回不来，但也不继续跌。"
          : "💡 套牢 = 账面在亏还拿着；跌得越深，回本要涨得越多（亏 50% 要涨 100% 才回来）。"
      }
    >
      <Slider label="买入价（元）" min={5} max={50} step={1} value={buy} onChange={setBuy}
        format={(v) => v.toFixed(0)} accent="var(--brand)" />
      <Slider label="现价（元）" min={5} max={50} step={1} value={now} onChange={setNow}
        format={(v) => v.toFixed(0)} accent={losing ? "var(--down)" : "var(--up)"} />
      <div className="mt-3 grid grid-cols-3 gap-2">
        <StatTag label="账面盈亏" value={`${lossPct >= 0 ? "+" : ""}${lossPct.toFixed(1)}%`} tone={losing ? "down" : "up"} />
        <StatTag label={`${shares} 股盈亏`} value={`${(lossPct / 100) * buy * shares >= 0 ? "+" : ""}${((lossPct / 100) * buy * shares).toFixed(0)} 元`} tone={losing ? "down" : "up"} />
        <StatTag label={cut ? "割肉后损失" : "回本需要涨"} value={cut ? `${Math.abs(((lossPct / 100) * buy * shares)).toFixed(0)} 元` : `${needBack.toFixed(1)}%`} tone={cut ? "warn" : "brand"} />
      </div>
      <div className="mt-3">
        <VizTable
          headers={["亏了多少", "回本要涨", "感受"]}
          rows={[
            ["-10%", "+11.1%", "小套，容易解套"],
            ["-30%", "+42.9%", "套住了，要涨四成多"],
            ["-50%", "+100%", "深度套牢，要翻倍才回本"],
          ]}
        />
      </div>
    </VizShell>
  );
}

/* ───────────────────────── ST 股（风险阶梯） ───────────────────────── */

const RISK_STEPS = [
  { key: "normal", label: "① 正常股票", desc: "财务/经营正常，每日涨跌幅 ±10%（主板）。", limit: "±10%" },
  { key: "st", label: "② ST 股", desc: "「特别处理」：连续亏损、资金被占用等问题，交易所亮黄牌。", limit: "±5%" },
  { key: "sst", label: "③ *ST 股", desc: "退市风险警示：连续亏损 + 可能退市，亮红牌。", limit: "±5%" },
  { key: "delist", label: "④ 退市整理", desc: "真的要走了：进入退市整理期，之后去老三板，几乎无人问津。", limit: "±10%（整理期）" },
];

export function RiskLadder({ config }: { config?: Record<string, unknown> }) {
  const init = Number(config?.initialStep ?? 1);
  const [step, setStep] = useState(init);
  const cur = RISK_STEPS[Math.min(Math.max(step, 0), RISK_STEPS.length - 1)];
  if (!cur) return null; // 不可达兜底（台阶恒 4 级）
  return (
    <VizShell
      title={config?.title ? String(config.title) : "从正常股到退市的四级台阶"}
      caption="公司出问题不是一步退市，而是一步步被「亮牌」。点台阶看每级发生了什么。"
      hint="点下面的台阶切换，注意涨跌幅限制的变化"
      insight="💡 ST/*ST 是「警示」不是「处罚」：它在提醒你这家公司病了，但买不买、风险自担。"
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {RISK_STEPS.map((s, i) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setStep(i)}
            aria-pressed={i === step}
            className={i === step
              ? "rounded-xl border-2 border-[var(--brand)] bg-[var(--brand-soft)] px-2 py-2 text-left text-xs font-semibold text-[var(--brand-strong)]"
              : "rounded-xl border border-[var(--color-border)] bg-white px-2 py-2 text-left text-xs font-medium text-[var(--color-body)] hover:border-[var(--brand-ring)]"}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div className="mt-3 rounded-xl bg-[var(--color-bg)] p-3 text-sm leading-relaxed text-[var(--color-body)]">
        <span className="font-semibold text-[var(--color-fg)]">{cur.label}</span>
        <p className="mt-1">{cur.desc}</p>
        <p className="mt-1 text-xs text-[var(--color-muted)]">涨跌幅限制：{cur.limit}</p>
      </div>
      <div className="mt-3">
        <VizTable
          headers={["级别", "触发原因", "对股民"]}
          rows={[
            ["ST", "连续两年亏损等", "涨跌只能 ±5%"],
            ["*ST", "退市风险（连亏+审计意见）", "有退市可能，更危险"],
            ["退市", "达到退市标准", "去三板，基本卖不出价"],
          ]}
        />
      </div>
    </VizShell>
  );
}

/* ───────────────────────── 可转债 ───────────────────────── */

/**
 * ConvertibleScale：可转债 = 债底 + 转股权。
 * 互动：拖正股价 vs 转股价 → 转股价值、溢价率。
 */
export function ConvertibleScale({ config }: { config?: Record<string, unknown> }) {
  const convPrice = Number(config?.convPrice ?? 10); // 转股价
  const faceValue = Number(config?.faceValue ?? 100); // 债底
  const [stock, setStock] = useState(12);
  const convValue = convPrice > 0 ? (stock / convPrice) * faceValue : faceValue; // 转股价值
  const premium = convValue > 0 ? ((faceValue - convValue) / convValue) * 100 : 0; // 转债相对转股价值溢价
  const worthwhile = stock > convPrice;
  return (
    <VizShell
      title={config?.title ? String(config.title) : "可转债：是债也是股的兑换券"}
      caption={`每张面值 ${faceValue} 元，可按 ${convPrice} 元 1 股换成股票。公司欠你钱（债底）+ 你能换成股票（股性）。`}
      hint="拖动「正股价」滑块，超过转股价时转股才划算"
      insight="💡 正股涨 → 转债跟着涨（股性）；正股大跌 → 有债底兜着（债性）。但公司还不上钱时，债底也会塌。"
    >
      <Slider label={`正股价（元）｜转股价 ${convPrice} 元`} min={2} max={30} step={0.5} value={stock}
        onChange={setStock} format={(v) => v.toFixed(1)}
        accent={worthwhile ? "var(--up)" : "var(--brand)"} />
      <div className="mt-3 grid grid-cols-3 gap-2">
        <StatTag label="债底（保本参考）" value={`≈ ${faceValue} 元`} tone="neutral" />
        <StatTag label="转股价值" value={`${convValue.toFixed(1)} 元`} tone={worthwhile ? "up" : "brand"} />
        <StatTag label="现价溢价" value={`${premium >= 0 ? "+" : ""}${premium.toFixed(1)}%`} tone={premium >= 0 ? "warn" : "up"} />
      </div>
      <div className="mt-3">
        <VizTable
          headers={["正股 10 元", `正股 ${convPrice} 元`, `正股 ${convPrice * 1.5} 元`]}
          rows={[
            ["转股不划算", "刚好打平", `转股价值 ${faceValue * 1.5} 元`],
            ["当债拿着", "临界点", "转股大赚"],
          ]}
        />
      </div>
    </VizShell>
  );
}

/* ───────────────────────── 停牌/复牌 ───────────────────────── */

/** HaltClock：停牌=暂停交易；拖停牌天数 + 复牌表现。 */
export function HaltClock({ config }: { config?: Record<string, unknown> }) {
  const [days, setDays] = useState(30);
  const [reopen, setReopen] = useState<"up" | "flat" | "down">("down");
  const label = reopen === "up" ? "复牌大涨" : reopen === "down" ? "复牌大跌" : "复牌平开";
  const reason =
    reopen === "up"
      ? "等待期内利好消息落地（重组成功、业绩超预期）→ 复牌被抢着买。"
      : reopen === "down"
        ? "等待期内情况更糟（重组失败、爆雷）→ 复牌被抢着卖，还可能连续跌停。"
        : "消息面平静，复牌后价格延续停牌前走势。";
  return (
    <VizShell
      title={config?.title ? String(config.title) : "停牌：按下暂停键"}
      caption="公司有大事（重组、爆雷、股价异动）时，交易所让它停牌「冷静一下」，期间不能买卖。"
      hint="拖动「停牌天数」，再点复牌后的三种走势"
      insight="💡 停牌是中性保护，但复牌后往往补涨/补跌：停牌前卖不出，复牌后情绪一次释放。"
    >
      <Slider label="停牌了多久" min={1} max={365} step={1} value={days} onChange={setDays}
        format={(v) => `${v} 天`} accent="var(--brand)" />
      <div className="mt-3 flex items-center gap-2 overflow-hidden rounded-full border border-[var(--color-border)] bg-white p-1.5">
        <div className="flex-1 rounded-full bg-[var(--brand-soft)] py-1.5 text-center text-[0.7rem] font-semibold text-[var(--brand-strong)]">
          停牌前（正常交易）
        </div>
        <div className="shrink-0 px-1 text-xs text-[var(--color-muted)]">→ ⏸ {days} 天不能动 →</div>
        <div className="flex-1 rounded-full bg-[var(--color-bg)] py-1.5 text-center text-[0.7rem] font-semibold text-[var(--color-body)]">
          复牌 {label}
        </div>
      </div>
      <div className="mt-3">
        <SegToggle
          value={reopen}
          onChange={setReopen}
          options={[
            { value: "up", label: "📈 复牌大涨" },
            { value: "flat", label: "➖ 平开" },
            { value: "down", label: "📉 复牌大跌" },
          ]}
        />
      </div>
      <p className="mt-2 text-sm leading-relaxed text-[var(--color-body)]">{reason}</p>
    </VizShell>
  );
}

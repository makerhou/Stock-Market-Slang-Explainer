"use client";

import { useState } from "react";
import { VizShell, Slider, StatTag, SegToggle, VizTable, MiniButton } from "./viz-basics";

/* ───────────────────────── 指数（标普/纳指/道指/恒生） ───────────────────────── */

interface IndexRow {
  name: string;
  point: number;
  base: number;
  note: string;
}

const DEFAULT_INDICES: IndexRow[] = [
  { name: "标普 500", point: 5200, base: 10, note: "500 家美国大公司，按市值加权" },
  { name: "纳斯达克 100", point: 18300, base: 125, note: "100 家科技巨头为主" },
  { name: "道琼斯 30", point: 39000, base: 40.9, note: "30 家传统蓝筹，按股价加权" },
];

/** IndexTower：指数=一篮子股票的「平均分」。拖点数看相对基期涨跌。 */
export function IndexTower({ config }: { config?: Record<string, unknown> }) {
  const indices = (Array.isArray(config?.indices) ? (config.indices as IndexRow[]) : DEFAULT_INDICES);
  const [sel, setSel] = useState(0);
  const cur = indices[sel] ?? indices[0];
  if (!cur) return null;
  const [point, setPoint] = useState(cur.point);
  const growth = ((point - cur.base) / cur.base) * 100;
  const up = growth >= 0;
  // 换指数时把点数重置为该指数默认值
  const pick = (i: number) => {
    setSel(i);
    const r = indices[i];
    if (r) setPoint(r.point);
  };
  return (
    <VizShell
      title={config?.title ? String(config.title) : "指数 = 一篮子股票的平均分"}
      caption="指数不是某一只股票，而是一篮子股票按规则算出的「平均分」。它涨，代表这一篮子整体涨。"
      hint="切换不同的指数，再拖「当前点位」看相对基期涨了多少"
      insight="💡 指数涨 ≠ 每只股票都涨：只要权重股够强，小股票跌也能把指数拉起来。"
    >
      <div className="flex flex-wrap gap-2">
        {indices.map((r, i) => (
          <MiniButton key={r.name} active={i === sel} onClick={() => pick(i)}>{r.name}</MiniButton>
        ))}
      </div>
      <div className="mt-3">
        <Slider label={`${cur.name}｜当前点位`} min={Math.round(cur.base * 0.3)} max={Math.round(cur.base * 4)}
          step={Math.max(1, Math.round(cur.base / 20))} value={point} onChange={setPoint}
          format={(v) => v.toLocaleString("zh-CN")} accent={up ? "var(--up)" : "var(--down)"} />
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <StatTag label="基期（定成 100 分）" value={cur.base.toLocaleString("zh-CN")} tone="neutral" />
        <StatTag label="现在" value={point.toLocaleString("zh-CN")} tone="brand" />
        <StatTag label="相对基期" value={`${up ? "+" : ""}${growth.toFixed(0)}%`} tone={up ? "up" : "down"} />
      </div>
      <div className="mt-3">
        <VizTable
          headers={["指数", "装了什么", "脾气"]}
          rows={indices.map((r) => [r.name, r.note, "跌起来一个都跑不掉"])}
        />
      </div>
    </VizShell>
  );
}

/* ───────────────────────── 熔断（Circuit Breaker） ───────────────────────── */

const CB_LEVELS = [
  { pct: 7, act: "暂停交易 15 分钟", why: "先让大家冷静，别慌砸" },
  { pct: 13, act: "再暂停 15 分钟", why: "还跌，说明问题严重" },
  { pct: 20, act: "当天直接收摊（停止交易）", why: "极端崩盘，保护市场" },
];

/** CircuitBreaker：美股大盘跌太猛 = 拉闸限电式暂停。 */
export function CircuitBreaker({ config }: { config?: Record<string, unknown> }) {
  const [drop, setDrop] = useState(5);
  const triggered = CB_LEVELS.filter((l) => drop >= l.pct);
  const active = triggered.length > 0;
  return (
    <VizShell
      title={config?.title ? String(config.title) : "熔断：大盘跌太猛，拉闸冷静 15 分钟"}
      caption="美股的「保险丝」：标普 500 相对前一天跌够 7% / 13% / 20%，就暂停交易。"
      hint="拖动「今天跌了多少」，看哪级保险丝烧断"
      insight="💡 熔断 ≠ 跌停了不许动，只是暂停让你冷静；恢复后该跌还是跌。"
    >
      <Slider label="标普 500 今天跌幅（相对前收盘）" min={1} max={30} step={1} value={drop}
        onChange={setDrop} format={(v) => `-${v}%`} accent={active ? "var(--down)" : "var(--brand)"} />
      <div className="mt-3 flex flex-col gap-2">
        {CB_LEVELS.map((l) => {
          const on = drop >= l.pct;
          return (
            <div key={l.pct}
              className={`flex items-center gap-3 rounded-xl border px-3 py-2 text-sm transition ${on
                ? "border-[var(--down)] bg-[var(--down-bg)]"
                : "border-[var(--color-border)] bg-white"}`}>
              <span className={`stat-num shrink-0 ${on ? "text-[var(--down)]" : "text-[var(--color-muted)]"}`}>
                -{l.pct}%
              </span>
              <span className={`flex-1 ${on ? "font-semibold text-[var(--down)]" : "text-[var(--color-body)]"}`}>
                {on ? "⚡ 触发：" : "未触发："}{l.act}
              </span>
              <span className="hidden text-xs text-[var(--color-muted)] sm:block">{l.why}</span>
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-sm text-[var(--color-body)]">
        {active
          ? `现在跌 ${-drop}%，已经烧断了 ${triggered.length} 级保险丝${drop >= 20 ? "：今天提前收摊。" : "。"}`
          : "再拖一拖，看看跌多少会拉闸。"}
      </p>
    </VizShell>
  );
}

/* ───────────────────────── 盘前盘后 ───────────────────────── */

const SESSIONS = [
  { key: "pre", label: "🌙 盘前 4:00–9:30", who: "加班的人+大资金", note: "流动性差、价差大，盘前价常被开盘「打脸」", risk: "价差大，容易被滑点坑" },
  { key: "open", label: "☀️ 盘中 9:30–16:00", who: "所有人", note: "成交量最大、价格最公允", risk: "参与者多，波动也大" },
  { key: "post", label: "🌆 盘后 16:00–20:00", who: "赶财报的人+机构", note: "发财报的高峰期，价格常剧烈跳动", risk: "没人陪你玩，挂单可能撤不了" },
] as const;

export function PrePostMarket({ config }: { config?: Record<string, unknown> }) {
  const [s, setS] = useState<(typeof SESSIONS)[number]["key"]>("open");
  const cur = SESSIONS.find((x) => x.key === s) ?? SESSIONS[1];
  return (
    <VizShell
      title={config?.title ? String(config.title) : "美股的一天：盘前、盘中、盘后"}
      caption="美股不只 9:30–16:00。前后还有延长时段，但那里的水更浅、浪更大。"
      hint="点三个时段，看谁在交易、有啥坑"
      insight="💡 聪明钱常在盘后发财报抢跑；新手在盘前盘后挂单，容易被价差和滑点教做人。"
    >
      <div className="flex flex-col gap-2">
        {SESSIONS.map((x) => (
          <button key={x.key} type="button" onClick={() => setS(x.key)} aria-pressed={x.key === s}
            className={`rounded-xl border px-3 py-2 text-left text-sm transition ${x.key === s
              ? "border-[var(--brand)] bg-[var(--brand-soft)] font-semibold text-[var(--brand-strong)]"
              : "border-[var(--color-border)] bg-white text-[var(--color-body)] hover:border-[var(--brand-ring)]"}`}>
            {x.label}
          </button>
        ))}
      </div>
      <div className="mt-3">
        <VizTable
          headers={["谁在交易", "这里发生什么", "风险"]}
          rows={[[cur.who, cur.note, cur.risk]]}
        />
      </div>
    </VizShell>
  );
}

/* ───────────────────────── 财报季 ───────────────────────── */

/** EarningsSeason：预期 vs 实际 → 超预期/不及预期股价反应。 */
export function EarningsSeason({ config }: { config?: Record<string, unknown> }) {
  const expectEps = Number(config?.expectEps ?? 1.5);
  const [actual, setActual] = useState(1.8);
  const diff = ((actual - expectEps) / expectEps) * 100;
  const beat = diff >= 0;
  return (
    <VizShell
      title={config?.title ? String(config.title) : "财报季：交作业的日子"}
      caption="美股每季度发财报：实际赚的钱（EPS）比分析师预期高 = 超预期，反之 = 不及预期。"
      hint="拖动「实际每股收益」，看超过/低于预期时的市场反应"
      insight="💡 股价常看「预期差」而非绝对值：赚 1 亿但大家以为赚 2 亿 → 股价照样跌。"
    >
      <Slider label={`实际每股收益（预期 ${expectEps.toFixed(2)} 美元）`} min={0} max={4} step={0.1}
        value={actual} onChange={setActual} format={(v) => v.toFixed(2)}
        accent={beat ? "var(--up)" : "var(--down)"} />
      <div className="mt-3 grid grid-cols-3 gap-2">
        <StatTag label="预期" value={`${expectEps.toFixed(2)}`} tone="neutral" />
        <StatTag label="实际" value={actual.toFixed(2)} tone="brand" />
        <StatTag label="预期差" value={`${diff >= 0 ? "+" : ""}${diff.toFixed(0)}%`} tone={beat ? "up" : "down"} />
      </div>
      <div className="mt-3">
        <VizTable
          headers={["关系", "术语", "常见反应"]}
          rows={[
            ["实际 > 预期", "超预期（beat）", "股价常涨；还给出乐观指引 → 涨更猛"],
            ["实际 < 预期", "不及预期（miss）", "股价常跌；哪怕其实赚钱只是赚得少"],
            ["业绩好但股价跌", "利好出尽", "大家早就买好了，兑现利润跑路"],
          ]}
        />
      </div>
    </VizShell>
  );
}

/* ───────────────────────── ADR / 中概股 ───────────────────────── */

/** AdrBridge：1 ADR = N 股普通股；中国公司去美股上市的「翻译层」。 */
export function AdrBridge({ config }: { config?: Record<string, unknown> }) {
  const ratio = Number(config?.ratio ?? 2);
  const [adrPrice, setAdrPrice] = useState(60);
  const perShare = adrPrice / ratio;
  const theme = config?.theme === "cnconcept" ? "cnconcept" : "adr";
  return (
    <VizShell
      title={config?.title ? String(config.title) : theme === "cnconcept" ? "中概股：中国公司，美股上市" : "ADR：外国股票的美国代币"}
      caption={
        theme === "cnconcept"
          ? "很多中国公司去美国上市（多为 ADR），白天黑夜两头受气：美股收盘的涨跌，会影响它港股/A 股第二天的情绪。"
          : "外国公司来美股上市，常常发行 ADR（存托凭证）：1 份 ADR 可能等于好几股原股票，由银行托管打包。"
      }
      hint="拖动「ADR 价格」，看折算回每股原股票是多少钱"
      insight={
        theme === "cnconcept"
          ? "💡 中概股 = 中国生意 + 美股规则 + 中美两边的政策风险，三头波动叠加。"
          : "💡 买 ADR ≠ 直接持有原股票；你持有的是银行的存托凭证。"
      }
    >
      <Slider label={`1 份 ADR 价格｜= ${ratio} 股原股票`} min={5} max={200} step={1} value={adrPrice}
        onChange={setAdrPrice} format={(v) => `$${v}`} accent="var(--up)" />
      <div className="mt-3 grid grid-cols-2 gap-2">
        <StatTag label="1 份 ADR" value={`$${adrPrice.toFixed(2)}`} tone="brand" />
        <StatTag label="折合每股原股" value={`$${perShare.toFixed(2)}`} tone="up" />
      </div>
      <div className="mt-3">
        <VizTable
          headers={theme === "cnconcept" ? ["特色", "说明"] : ["环节", "谁来做"]}
          rows={
            theme === "cnconcept"
              ? [
                ["上市地", "美国（多为 ADR 形式）"],
                ["生意", "主要在中国（电商/教育/出行等）"],
                ["风险叠加", "中美监管、汇率、行业政策三重波动"],
              ]
              : [
                ["打包", "托管银行把原股票收进保险库"],
                ["发行", "在美股发存托凭证（ADR）"],
                ["交易", "你买卖 ADR，银行在背后对应原股票"],
              ]
          }
        />
      </div>
    </VizShell>
  );
}

/* ───────────────────────── 期权 ───────────────────────── */

/** OptionsLadder：看涨/看跌 + 到期价内外。简化 pedagogy：不考虑时间价值。 */
export function OptionsLadder({ config }: { config?: Record<string, unknown> }) {
  const premium = Number(config?.premium ?? 2);
  const [kind, setKind] = useState<"call" | "put">("call");
  const [spot, setSpot] = useState(12);
  const [strike, setStrike] = useState(10);
  const intrinsic = kind === "call" ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
  const pnl = intrinsic - premium;
  const inMoney = intrinsic > 0;
  return (
    <VizShell
      title={config?.title ? String(config.title) : "期权：花小钱买「未来的选择权」"}
      caption={`花 ${premium} 元权利金，锁定 ${kind === "call" ? "未来按行权价买入" : "未来按行权价卖出"}的权利（不强行权）。`}
      hint="切换看涨/看跌，拖「到期时股价」和「行权价」，看赚钱还是打水漂"
      insight="💡 期权是「有限亏损（最多亏权利金）+ 可能大赚」的工具，但方向、时间、波动全猜错就归零。"
    >
      <SegToggle value={kind} onChange={setKind}
        options={[{ value: "call", label: "📈 看涨期权" }, { value: "put", label: "📉 看跌期权" }]} />
      <div className="mt-3">
        <Slider label="到期时股价（元）" min={4} max={20} step={0.5} value={spot} onChange={setSpot}
          format={(v) => v.toFixed(1)} accent="var(--brand)" />
        <div className="mt-3">
          <Slider label="行权价（元）" min={4} max={20} step={0.5} value={strike} onChange={setStrike}
            format={(v) => v.toFixed(1)} accent="var(--warn)" />
        </div>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <StatTag label="权利金（成本）" value={`-${premium} 元`} tone="neutral" />
        <StatTag label={inMoney ? "内在价值" : "内在价值（价外=0）"} value={`${intrinsic.toFixed(1)} 元`} tone={inMoney ? "up" : "down"} />
        <StatTag label="这笔盈亏" value={`${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)} 元`} tone={pnl >= 0 ? "up" : "down"} />
      </div>
      <div className="mt-3">
        <VizTable
          headers={["到期情况", "术语", "结果"]}
          rows={[
            [kind === "call" ? "股价 > 行权价" : "股价 < 行权价", "价内（in the money）", intrinsic > premium ? "赚：差价覆盖权利金" : "小赚或刚回本"],
            [kind === "call" ? "股价 ≤ 行权价" : "股价 ≥ 行权价", "价外（out of money）", "不行权，亏光权利金"],
            ["赌错方向", "归零", `最多亏 ${premium} 元（这就是买方的定义）`],
          ]}
        />
      </div>
    </VizShell>
  );
}

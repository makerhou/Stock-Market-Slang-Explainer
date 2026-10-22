import type { TermInsights } from "@jargon/contracts";

function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="mt-2 space-y-1.5">
      {items.map((t, i) => (
        <li key={i} className="flex gap-2 text-[0.82rem] leading-relaxed text-[var(--color-body)]">
          <span className="mt-[0.45rem] h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--brand)]" />
          <span>{t}</span>
        </li>
      ))}
    </ul>
  );
}

function Pane({
  badge,
  title,
  items,
  tone,
}: {
  badge: string;
  title: string;
  items: string[];
  tone: "brand" | "warn" | "ok" | "bad";
}) {
  const toneCls: Record<typeof tone, { box: string; head: string; badge: string }> = {
    brand: { box: "bg-[var(--brand-soft)]", head: "text-[var(--brand-strong)]", badge: "bg-[var(--brand)]" },
    warn: { box: "bg-[var(--warn-bg)]", head: "text-[var(--warn)]", badge: "bg-[var(--warn)]" },
    ok: { box: "bg-[var(--ok-bg)]", head: "text-[var(--ok)]", badge: "bg-[var(--ok)]" },
    bad: { box: "bg-[var(--bad-bg)]", head: "text-[var(--bad)]", badge: "bg-[var(--bad)]" },
  };
  const c = toneCls[tone];
  return (
    <div className={`rounded-xl border border-[var(--color-border)] ${c.box} p-3.5`}>
      <div className={`flex items-center gap-2 text-sm font-bold ${c.head}`}>
        <span className={`grid h-6 w-6 place-items-center rounded-full ${c.badge} text-xs text-white`}>{badge}</span>
        {title}
      </div>
      <Bullets items={items} />
    </div>
  );
}

/**
 * 「读懂这个词：影响 · 好 · 坏 · 政策」——深度解读卡片（服务端渲染，纯文本要点）。
 * 放在「看图秒懂」互动图之后，补全文+表的「文」深度层。
 */
export function InsightCard({ insights }: { insights?: TermInsights }) {
  if (!insights) return null;
  const { affects, good, bad, policy, example } = insights;

  return (
    <section className="card animate-pop p-5" aria-labelledby="insight-title">
      <h2 id="insight-title" className="section-title">
        读懂这个词：影响 · 好 · 坏 · 政策
      </h2>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Pane badge="影" title="它影响什么" items={affects} tone="brand" />
        <Pane badge="策" title="什么会影响它" items={policy} tone="warn" />
        <Pane badge="好" title="指标好说明什么" items={good} tone="ok" />
        <Pane badge="坏" title="指标坏说明什么" items={bad} tone="bad" />
      </div>

      {example ? (
        <div className="mt-3 rounded-xl border border-[var(--color-risk-border)] bg-[var(--color-risk-bg)] p-3.5">
          <div className="flex items-center gap-2 text-sm font-bold text-[var(--color-risk-fg)]">
            <span className="grid h-6 w-6 place-items-center rounded-full bg-[var(--color-risk-fg)] text-xs text-white">例</span>
            举个例子
          </div>
          <p className="mt-2 text-[0.85rem] leading-relaxed text-[var(--color-risk-fg)]">{example}</p>
        </div>
      ) : null}

      <p className="mt-3 text-xs text-[var(--color-faint)]">
        注：这里的好 / 坏只表示「指标读数本身」，不等于股票涨跌（涨跌另用红绿色表示）。
      </p>
    </section>
  );
}

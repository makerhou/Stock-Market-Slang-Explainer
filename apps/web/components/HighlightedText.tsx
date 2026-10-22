"use client";

/**
 * 安全高亮渲染（frontend-design §3.1.2 ★）。
 * 严禁 dangerouslySetInnerHTML：用 React 文本节点 + <mark> 分段。
 * - 高置信 span：实心黄底 + 下边框
 * - 低置信 span（confidence < 0.6）：虚线下划线，默认不展开
 * 点击高亮 → 跳转术语详情（点按可忽略由上层处理）
 */
import Link from "next/link";

export interface HighlightSpan {
  start: number;
  end: number;
  slug: string;
  raw: string;
  isLowConfidence?: boolean;
}

export function HighlightedText({
  text,
  spans,
}: {
  text: string;
  spans: HighlightSpan[];
}) {
  if (!spans || spans.length === 0) return <>{text}</>;

  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const nodes: React.ReactNode[] = [];
  let cursor = 0;

  sorted.forEach((sp, i) => {
    if (sp.start < cursor) return; // 重叠保护
    if (sp.start > cursor) {
      nodes.push(<span key={`t-${i}`}>{text.slice(cursor, sp.start)}</span>);
    }
    const cls = sp.isLowConfidence
      ? "bg-[var(--mark-weak-bg)] underline decoration-dashed decoration-[var(--color-fg)]"
      : "bg-[var(--mark-bg)] text-[var(--mark-fg)] border-b-2 border-[var(--mark-fg)]";
    nodes.push(
      <Link
        key={`m-${i}`}
        href={`/terms/${sp.slug}`}
        className={`rounded px-0.5 ${cls}`}
        title={sp.raw}
      >
        {text.slice(sp.start, sp.end)}
      </Link>,
    );
    cursor = sp.end;
  });
  if (cursor < text.length) {
    nodes.push(<span key="t-end">{text.slice(cursor)}</span>);
  }

  return <span>{nodes}</span>;
}

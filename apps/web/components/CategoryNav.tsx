import Link from "next/link";

export interface CategoryItem {
  l1: string;
  count: number;
}

/** 分类入口（首页「分类浏览」/ 详情页面包屑用） */
export function CategoryNav({ items }: { items: CategoryItem[] }) {
  if (items.length === 0) return null;
  return (
    <nav aria-label="分类浏览" className="flex flex-wrap gap-2">
      {items.map((c) => (
        <Link
          key={c.l1}
          href={`/s?category=${encodeURIComponent(c.l1)}`}
          className="group inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-white px-3.5 py-1.5 text-sm font-medium text-[var(--color-body)] transition hover:border-[var(--brand-ring)] hover:text-[var(--brand-strong)]"
        >
          {c.l1}
          <span className="rounded-full bg-[var(--brand-soft)] px-1.5 text-xs font-semibold text-[var(--brand-strong)]">
            {c.count}
          </span>
        </Link>
      ))}
    </nav>
  );
}

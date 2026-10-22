"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** 顶部吸顶 Header：移动端交给底部 TabBar，桌面端显示文字导航 */
export function Header() {
  const pathname = usePathname();
  const nav = [
    { href: "/", label: "搜索" },
    { href: "/levels", label: "闯关" },
    { href: "/mistakes", label: "错题本" },
  ];
  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <header className="sticky top-0 z-30 border-b border-[var(--color-border)] bg-white/80 backdrop-blur-md">
      <div className="app-container flex h-14 items-center justify-between">
        <Link href="/" className="flex items-center gap-2.5 font-semibold text-[var(--color-fg)]">
          <span
            aria-hidden
            className="brand-gradient flex h-8 w-8 items-center justify-center rounded-xl text-base shadow-sm"
          >
            📖
          </span>
          <span className="tracking-tight">股票黑话解释器</span>
        </Link>
        <nav className="hidden items-center gap-1 text-sm sm:flex">
          {nav.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={`rounded-lg px-3 py-1.5 font-medium transition-colors ${
                isActive(n.href)
                  ? "bg-[var(--brand-soft)] text-[var(--brand-strong)]"
                  : "text-[var(--color-muted)] hover:bg-slate-100 hover:text-[var(--color-fg)]"
              }`}
            >
              {n.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}

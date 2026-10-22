"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/", label: "搜索", icon: "🔍" },
  { href: "/levels", label: "闯关", icon: "🎯" },
  { href: "/mistakes", label: "错题本", icon: "📕" },
];

export function TabBar() {
  const pathname = usePathname();
  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <nav
      aria-label="主导航"
      className="fixed inset-x-0 bottom-0 z-40 flex justify-center pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-1"
    >
      <div className="flex items-center gap-1 rounded-2xl border border-[var(--color-border)] bg-white/90 p-1.5 shadow-[0_10px_40px_-12px_rgba(15,23,42,0.4)] backdrop-blur-md">
        {TABS.map((t) => {
          const active = isActive(t.href);
          return (
            <Link
              key={t.href}
              href={t.href}
              aria-current={active ? "page" : undefined}
              className={`relative flex min-w-[4.5rem] flex-col items-center gap-0.5 rounded-xl px-3 py-1.5 text-xs transition-colors ${
                active
                  ? "bg-[var(--brand-soft)] font-semibold text-[var(--brand-strong)]"
                  : "text-[var(--color-faint)] hover:text-[var(--color-muted)]"
              }`}
            >
              <span
                aria-hidden
                className={`text-lg transition-transform duration-150 ${active ? "scale-110" : ""}`}
              >
                {t.icon}
              </span>
              {t.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

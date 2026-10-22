"use client";

/**
 * 全站唯一全局入口（frontend-design §2.1 / S1）。
 * - 实时联想：输入 ≥2 字符、120ms 防抖 → 本地 matcher 过滤 → 下拉建议
 * - 自动判定：单词 / 整句（mode hint），提交后由 /s 渲染
 * - 键盘可达：↑↓ 选择、Enter 选中/提交、Esc 关闭；不劫持 Tab
 * - a11y：combobox + aria-activedescendant
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLexicon } from "@/lib/lexicon-client";

interface SearchBarProps {
  variant?: "hero" | "inline";
  initialQuery?: string;
  autoFocus?: boolean;
}

export function SearchBar({ variant = "hero", initialQuery = "", autoFocus = false }: SearchBarProps) {
  const router = useRouter();
  const { matcher } = useLexicon();
  const [q, setQ] = useState(initialQuery);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [isSentence, setIsSentence] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus && inputRef.current) {
      // 移动端不自动弹键盘、不抢焦点（设计 S19）
      const isTouch = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
      if (!isTouch) inputRef.current.focus();
    }
  }, [autoFocus]);

  const suggestions = useMemo(() => {
    const query = q.trim();
    if (!matcher || query.length < 2) return [];
    const r = matcher.search(query);
    setIsSentence(r.inputKind === "sentence");
    return r.matched.slice(0, 6).map((m) => ({
      slug: m.slug,
      headword: m.headword,
      plainExplain: m.plainExplain,
    }));
  }, [q, matcher]);

  useEffect(() => {
    setActive(-1);
  }, [suggestions]);

  function go(target: string) {
    setOpen(false);
    router.push(target);
  }

  function submit() {
    const query = q.trim();
    if (!query) return;
    if (active >= 0 && suggestions[active]) {
      go(`/terms/${suggestions[active].slug}`);
      return;
    }
    go(`/s?q=${encodeURIComponent(query)}`);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      setOpen(false);
      setActive(-1);
    }
  }

  const hero = variant === "hero";
  const listId = "search-suggestions";

  return (
    <div className={hero ? "w-full" : "w-full"}>
        <div
          className={
            hero
              ? "flex items-center gap-2 rounded-2xl border border-[var(--color-border)] bg-white px-4 shadow-[0_16px_38px_-20px_rgba(15,23,42,0.35)]"
              : "flex items-center gap-2 rounded-xl border border-[var(--color-border)] bg-white px-3"
          }
          style={{ minHeight: hero ? "3.5rem" : "2.75rem" }}
        >
        <span aria-hidden className="text-[var(--color-muted)]">
          🔍
        </span>
        <label htmlFor="search-input" className="sr-only">
          输入你听到的股票术语，如 MACD、去库存
        </label>
        <input
          id="search-input"
          ref={inputRef}
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={q}
          placeholder="输入你听到的词，如：MACD、去库存"
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded={open && suggestions.length > 0}
          aria-controls={listId}
          aria-activedescendant={active >= 0 ? `sg-${active}` : undefined}
          className="h-full w-full bg-transparent text-base text-[var(--color-fg)] outline-none placeholder:text-[var(--color-muted)]"
        />
        <button
          type="button"
          onClick={submit}
          className="btn btn-primary shrink-0 px-4 py-2 text-sm"
          style={{ minHeight: "2.5rem" }}
        >
          查一查
        </button>
      </div>

      {isSentence && open ? (
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          已识别为一句话，将高亮其中的术语。
        </p>
      ) : null}

      {open && suggestions.length > 0 ? (
        <ul
          id={listId}
          role="listbox"
          className="mt-1 overflow-hidden rounded-xl border border-[var(--color-border)] bg-white shadow-sm"
        >
          {suggestions.map((s, i) => (
            <li
              key={s.slug}
              id={`sg-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                go(`/terms/${s.slug}`);
              }}
              className={`cursor-pointer px-4 py-2 text-sm ${
                i === active ? "bg-[var(--color-bg)]" : ""
              }`}
            >
              <span className="font-medium text-[var(--color-fg)]">{s.headword}</span>
              <span className="ml-2 text-[var(--color-muted)]">{s.plainExplain}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

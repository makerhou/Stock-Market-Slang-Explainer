"use client";

/**
 * 客户端词典 Hook（frontend-design §5.3）。
 *  - 启动：先读 IndexedDB 快照 → 立即可用（零网络，离线可读）
 *  - 空闲时：拉 /api/lexicon（带 If-None-Match）→ 304 不重写，200 则更新 IDB 与内存
 *  - 构建客户端 matcher（@jargon/matcher 单例），供 SearchBar 联想 / 整句高亮
 */
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { LexiconManifest } from "@jargon/contracts";
import { LexiconMatcher, loadLexicon } from "@jargon/matcher";
import { idbGet, idbPut } from "./idb";

const STORE_KEY = "manifest";

interface LexiconCtx {
  manifest: LexiconManifest | null;
  matcher: LexiconMatcher | null;
  loading: boolean;
  fromCache: boolean;
}

const Ctx = createContext<LexiconCtx>({
  manifest: null,
  matcher: null,
  loading: true,
  fromCache: false,
});

export function useLexicon(): LexiconCtx {
  return useContext(Ctx);
}

export function LexiconProvider({ children }: { children: ReactNode }) {
  const [manifest, setManifest] = useState<LexiconManifest | null>(null);
  const [matcher, setMatcher] = useState<LexiconMatcher | null>(null);
  const [loading, setLoading] = useState(true);
  const [fromCache, setFromCache] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    let cancelled = false;

    (async () => {
      // 1) 离线优先：IndexedDB 快照
      try {
        const cached = await idbGet<LexiconManifest>(STORE_KEY);
        if (cached && cached.entries.length > 0 && !cancelled) {
          setManifest(cached);
          setMatcher(loadLexicon(cached));
          setFromCache(true);
        }
      } catch {
        /* IndexedDB 不可用（隐私模式等）→ 走网络 */
      }

      // 2) 空闲时网络校正（带 If-None-Match）
      const run = async () => {
        try {
          const cur = await idbGet<LexiconManifest>(STORE_KEY);
          const headers: Record<string, string> = {};
          if (cur?.checksum) headers["If-None-Match"] = cur.checksum;
          const res = await fetch("/api/lexicon", { headers });
          if (res.status === 304) {
            if (!cancelled) setLoading(false);
            return;
          }
          if (!res.ok) {
            if (!cancelled) setLoading(false);
            return;
          }
          const next = (await res.json()) as LexiconManifest;
          if (cancelled) return;
          setManifest(next);
          setMatcher(loadLexicon(next));
          setFromCache(false);
          await idbPut(STORE_KEY, next).catch(() => {});
        } catch {
          /* 网络失败 → 维持快照 */
        } finally {
          if (!cancelled) setLoading(false);
        }
      };

      const ric = (window as unknown as { requestIdleCallback?: (cb: () => void) => void })
        .requestIdleCallback;
      if (ric) ric(run);
      else setTimeout(run, 300);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Ctx.Provider value={{ manifest, matcher, loading, fromCache }}>
      {children}
    </Ctx.Provider>
  );
}

"use client";

import { useEffect, useReducer, useState } from "react";
import {
  createProgressStore,
  type ProgressSnapshot,
  type ProgressStore,
} from "@jargon/quiz";

/** 异步初始化 ProgressStore（隐私模式降级为内存实现） */
export function useProgress(): ProgressStore | null {
  const [store, setStore] = useState<ProgressStore | null>(null);
  useEffect(() => {
    let alive = true;
    createProgressStore().then((s) => {
      if (alive) setStore(s);
    });
    return () => {
      alive = false;
    };
  }, []);
  return store;
}

/** 订阅式读取进度快照（store 变更自动刷新组件） */
export function useProgressSnapshot(): ProgressSnapshot | null {
  const store = useProgress();
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    if (!store) return;
    return store.subscribe(() => force());
  }, [store]);
  return store ? store.exportSnapshot() : null;
}

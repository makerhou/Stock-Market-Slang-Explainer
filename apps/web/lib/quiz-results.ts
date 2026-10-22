"use client";

import type { AnswerRecord } from "@jargon/quiz";
import type { QuizMode, QuizDifficulty } from "@jargon/contracts";

export type QuizResultMistake = { termId: string; termSlug: string };

export type QuizResult = {
  sessionId: string;
  levelId: string | null;
  levelName: string;
  mode: QuizMode;
  difficulty: QuizDifficulty;
  correctCount: number;
  wrongCount: number;
  durationMs: number;
  answers: AnswerRecord[];
  mistakes: QuizResultMistake[];
  finishedAt: number;
};

const KEY = "glossary:quiz:results:v1";
const MAX = 20;

function readAll(): Record<string, QuizResult> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<string, QuizResult>) : {};
  } catch {
    return {};
  }
}

export function saveQuizResult(r: QuizResult): void {
  if (typeof window === "undefined") return;
  const all = readAll();
  all[r.sessionId] = r;
  const keys = Object.keys(all).sort((a, b) => (all[b]?.finishedAt ?? 0) - (all[a]?.finishedAt ?? 0));
  for (const k of keys.slice(MAX)) delete all[k];
  try {
    window.localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* 配额超限忽略 */
  }
}

export function getQuizResult(sessionId: string): QuizResult | null {
  return readAll()[sessionId] ?? null;
}

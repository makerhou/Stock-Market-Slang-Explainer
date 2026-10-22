"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import type {
  QuizAnswerResponse,
  QuizDifficulty,
  QuizMode,
  QuizNextResponse,
  QuizQuestionPayload,
} from "@jargon/contracts";
import { LEVELS, type AnswerRecord } from "@jargon/quiz";
import { useProgress } from "./use-progress";
import { saveQuizResult, type QuizResult } from "./quiz-results";

export type QuizPhase = "loading" | "question" | "feedback" | "result" | "error";

interface PendingItem {
  questionId: string;
  optionId: string;
  clientRequestId: string;
  termId: string;
  termSlug: string;
}

interface QuizSessionValue {
  phase: QuizPhase;
  questions: QuizQuestionPayload[];
  index: number;
  current: QuizQuestionPayload | null;
  selectedOptionId: string | null;
  feedback: QuizAnswerResponse | null;
  pending: boolean;
  correctCount: number;
  answers: AnswerRecord[];
  levelId: string | null;
  mode: QuizMode;
  pendingCount: number;
  errorMessage: string | null;
  difficultyLevel: QuizDifficulty;
  difficultyNotice: { dir: "up" | "down"; to: QuizDifficulty } | null;
  select: (optionId: string) => void;
  next: () => void;
  retry: () => void;
}

const Ctx = createContext<QuizSessionValue | null>(null);

function rid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c && typeof c.randomUUID === "function" ? c.randomUUID() : "r" + Math.random().toString(36).slice(2);
}

export function QuizSessionProvider({
  levelId,
  mode,
  termIds,
  count = 8,
  children,
}: {
  levelId: string;
  mode: QuizMode;
  termIds?: string[];
  count?: number;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const store = useProgress();
  const [phase, setPhase] = useState<QuizPhase>("loading");
  const [questions, setQuestions] = useState<QuizQuestionPayload[]>([]);
  const [index, setIndex] = useState(0);
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<QuizAnswerResponse | null>(null);
  const [pending, setPending] = useState(false);
  const [correctCount, setCorrectCount] = useState(0);
  const [answers, setAnswers] = useState<AnswerRecord[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // 初始难度档与关卡目标对齐；关卡默认上限由 compose 按 Math.min(3, target+1) 计算，
  // 确保 d2/d3 槽可被填充（详见 M6-2 修复说明）。
  const [difficultyLevel, setDifficultyLevel] = useState<QuizDifficulty>(
    () => LEVELS.find((l) => l.levelId === levelId)?.targetDifficulty ?? 1,
  );
  const [difficultyNotice, setDifficultyNotice] = useState<{ dir: "up" | "down"; to: QuizDifficulty } | null>(null);

  const answeredIds = useRef<Set<string>>(new Set());
  const consecutiveRight = useRef(0);
  const consecutiveWrong = useRef(0);
  const pendingQueue = useRef<PendingItem[]>([]);
  /** 提交在途守卫：防止在网络往返期间重复点击导致重复判分 */
  const inFlight = useRef(false);
  const startedAt = useRef<number>(Date.now());
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const levelName = LEVELS.find((l) => l.levelId === levelId)?.name ?? "练习";

  const fetchNext = useCallback(
    async (exclude: string[]): Promise<QuizNextResponse> => {
      const params = new URLSearchParams();
      params.set("levelId", levelId);
      params.set("mode", mode);
      params.set("count", String(count));
      // 不传 difficultyCap：关卡默认上限由 compose 按 Math.min(3, target+1) 计算，
      // 保证 d2/d3 槽可被填充（M6-2 修复：此前首拉恒传 difficultyCap=1 会覆盖该默认值，导致 409）。
      // 自适应降档需配合“重新拉题”才有意义，当前会话为一次性取题，故此处不传。
      params.set("allowRepeat", mode === "review" ? "1" : "0");
      if (exclude.length) params.set("excludeQuestionIds", exclude.join(","));
      if (termIds?.length) params.set("termIds", termIds.join(","));
      const res = await fetch(`/api/quiz/next?${params.toString()}`, { cache: "no-store" });
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
        throw { status: res.status, code: e?.error?.code, message: e?.error?.message ?? "出题失败" };
      }
      return (await res.json()) as QuizNextResponse;
    },
    [levelId, mode, count, termIds],
  );

  const start = useCallback(async () => {
    setPhase("loading");
    setErrorMessage(null);
    answeredIds.current = new Set();
    consecutiveRight.current = 0;
    consecutiveWrong.current = 0;
    pendingQueue.current = [];
    setAnswers([]);
    setCorrectCount(0);
    setSelectedOptionId(null);
    setFeedback(null);
    setPending(false);
    startedAt.current = Date.now();
    try {
      const data = await fetchNext([]);
      setQuestions(data.questions);
      setIndex(0);
      setPhase(data.questions.length > 0 ? "question" : "error");
      if (data.questions.length === 0) setErrorMessage("这一关还在准备中，先试试前面的关卡吧。");
      if (store && mode === "level") {
        store.saveLevelState(levelId, {
          levelId,
          currentIndex: 0,
          questionIds: [],
          answered: {},
          startedAt: startedAt.current,
          updatedAt: Date.now(),
          correctCount: 0,
        });
      }
    } catch (e) {
      const err = e as { message?: string };
      setErrorMessage(err?.message ?? "网络异常，出题失败");
      setPhase("error");
    }
  }, [fetchNext, levelId, mode, store]);

  useEffect(() => {
    if (store) start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);

  const submit = useCallback(
    async (optionId: string) => {
      const q = questions[index];
      if (!q) return;
      const clientRequestId = rid();
      try {
        const res = await fetch("/api/quiz/answer", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            questionId: q.questionId,
            optionId,
            clientRequestId,
            mode,
            levelId,
            elapsedMs: Date.now() - startedAt.current,
          }),
        });
        if (!res.ok) throw new Error("answer failed");
        const resp = (await res.json()) as QuizAnswerResponse;
        setFeedback(resp);
        setPending(false);
        if (resp.correct) setCorrectCount((c) => c + 1);
        if (store) {
          store.recordAnswer({
            questionId: q.questionId,
            termId: q.termId,
            termSlug: q.termSlug,
            optionId,
            correct: resp.correct,
            verification: "verified",
            answeredAt: Date.now(),
          });
        }
        // 难度自适应
        if (resp.correct) {
          consecutiveRight.current += 1;
          consecutiveWrong.current = 0;
          if (consecutiveRight.current >= 3 && difficultyLevel < 3) {
            const to = (difficultyLevel + 1) as QuizDifficulty;
            setDifficultyLevel(to);
            setDifficultyNotice({ dir: "up", to });
          }
        } else {
          consecutiveWrong.current += 1;
          consecutiveRight.current = 0;
          if (consecutiveWrong.current >= 2 && difficultyLevel > 1) {
            const to = (difficultyLevel - 1) as QuizDifficulty;
            setDifficultyLevel(to);
            setDifficultyNotice({ dir: "down", to });
          }
        }
        setPhase("feedback");
      } catch {
        // 离线 / 弱网：标待校验，不阻塞
        pendingQueue.current.push({
          questionId: q.questionId,
          optionId,
          clientRequestId,
          termId: q.termId,
          termSlug: q.termSlug,
        });
        setPendingCount(pendingQueue.current.length);
        setPending(true);
        setFeedback(null);
        setPhase("feedback");
      }
    },
    [questions, index, mode, levelId, difficultyLevel, store],
  );

  const select = useCallback(
    (optionId: string) => {
      if (phase !== "question" || inFlight.current) return;
      inFlight.current = true;
      setSelectedOptionId(optionId);
      void submit(optionId).finally(() => {
        inFlight.current = false;
      });
    },
    [phase, submit],
  );

  useEffect(() => {
    if (!difficultyNotice) return;
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setDifficultyNotice(null), 5000);
    return () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    };
  }, [difficultyNotice]);

  // 离线恢复后重放待校验队列（幂等键保证不重复计分）
  useEffect(() => {
    if (typeof window === "undefined") return;
    const replay = async () => {
      if (pendingQueue.current.length === 0) return;
      const queue = pendingQueue.current;
      pendingQueue.current = [];
      for (const item of queue) {
        try {
          const res = await fetch("/api/quiz/answer", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              questionId: item.questionId,
              optionId: item.optionId,
              clientRequestId: item.clientRequestId,
              mode,
              levelId,
            }),
          });
          if (res.ok && store) {
            const resp = (await res.json()) as QuizAnswerResponse;
            store.recordAnswer({
              questionId: item.questionId,
              termId: item.termId,
              termSlug: item.termSlug,
              optionId: item.optionId,
              correct: resp.correct,
              verification: "verified",
              answeredAt: Date.now(),
            });
          }
        } catch {
          pendingQueue.current.push(item);
        }
      }
      setPendingCount(pendingQueue.current.length);
    };
    window.addEventListener("online", replay);
    return () => window.removeEventListener("online", replay);
  }, [mode, levelId, store]);

  const finish = useCallback(
    (finalAnswers: AnswerRecord[]) => {
      const durationMs = Date.now() - startedAt.current;
      const verified = finalAnswers.filter((a) => a.verification === "verified");
      const correct = verified.filter((a) => a.correct).length;
      const mistakes = verified
        .filter((a) => !a.correct)
        .map((a) => ({ termId: a.termId, termSlug: a.termSlug }));
      const sessionId = rid();
      const result: QuizResult = {
        sessionId,
        levelId,
        levelName,
        mode,
        difficulty: difficultyLevel,
        correctCount: correct,
        wrongCount: verified.length - correct,
        durationMs,
        answers: finalAnswers,
        mistakes,
        finishedAt: Date.now(),
      };
      saveQuizResult(result);
      if (store && mode === "level") {
        const st = store.getLevelState(levelId);
        if (st) {
          store.saveLevelState(levelId, {
            ...st,
            completedAt: Date.now(),
            durationMs,
            correctCount: correct,
            updatedAt: Date.now(),
          });
        }
      }
      setPhase("result");
      router.push(`/quiz/result/${sessionId}`);
    },
    [levelId, levelName, mode, difficultyLevel, store, router],
  );

  const next = useCallback(() => {
    // 记录已答 id（用于下一批评题去重）
    const q = questions[index];
    let base = answers;
    if (q) {
      answeredIds.current.add(q.questionId);
      const ans: AnswerRecord = {
        questionId: q.questionId,
        termId: q.termId,
        termSlug: q.termSlug,
        optionId: selectedOptionId ?? "",
        correct: feedback?.correct ?? false,
        verification: (pending ? "pending" : "verified") as "pending" | "verified",
        answeredAt: Date.now(),
      };
      base = [...answers, ans];
      const verified = base.filter((a) => a.verification === "verified");
      setCorrectCount(verified.filter((a) => a.correct).length);
      setAnswers(base);
    }
    setSelectedOptionId(null);
    setFeedback(null);
    setPending(false);
    if (q && index + 1 < questions.length) {
      setIndex(index + 1);
      setPhase("question");
      if (store && mode === "level") {
        const st = store.getLevelState(levelId);
        if (st) store.saveLevelState(levelId, { ...st, currentIndex: index + 1, updatedAt: Date.now() });
      }
    } else {
      finish(base);
    }
  }, [questions, index, selectedOptionId, feedback, pending, answers, levelId, mode, store, finish]);

  const retry = useCallback(() => {
    void start();
  }, [start]);

  const value: QuizSessionValue = {
    phase,
    questions,
    index,
    current: questions[index] ?? null,
    selectedOptionId,
    feedback,
    pending,
    correctCount,
    answers,
    levelId,
    mode,
    pendingCount,
    errorMessage,
    difficultyLevel,
    difficultyNotice,
    select,
    next,
    retry,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useQuizSession(): QuizSessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useQuizSession 必须在 QuizSessionProvider 内使用");
  return v;
}

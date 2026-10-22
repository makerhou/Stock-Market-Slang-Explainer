import type {
  QuizDifficulty,
  QuizMode,
  QuizNextResponse,
  QuizQuestionPayload,
} from "@jargon/contracts";
import type { GeneratedQuestion } from "./types";
import { getLevel, clampDiff } from "./levels.config";
import { shuffle } from "./shuffle";
import { randomToken } from "./id";

export interface ComposeInput {
  pool: GeneratedQuestion[];
  levelId: string;
  count: number;
  mode: QuizMode;
  termIds?: string[];
  excludeQuestionIds?: string[];
  difficultyCap?: QuizDifficulty;
  allowRepeat: boolean;
  seed?: string;
}

export type ComposeResult =
  | { ok: true; response: QuizNextResponse }
  | { ok: false; status: number; code: string; message: string };

function buildSlots(
  targetDifficulty: QuizDifficulty,
  composition: { current: number; previous: number; next: number },
  count: number,
): QuizDifficulty[] {
  const W = composition.previous + composition.current + composition.next;
  if (W <= 0 || count <= 0) return new Array(Math.max(0, count)).fill(targetDifficulty);

  // 两端难度越界时回落到当前档：L1 没有更简单的档，L3 没有更难的档
  const buckets: { d: QuizDifficulty; w: number }[] = [
    { d: (targetDifficulty > 1 ? targetDifficulty - 1 : targetDifficulty) as QuizDifficulty, w: composition.previous },
    { d: targetDifficulty, w: composition.current },
    { d: (targetDifficulty < 3 ? targetDifficulty + 1 : targetDifficulty) as QuizDifficulty, w: composition.next },
  ];

  // 按权重下取整分配，余数补到小数部分最大的桶 —— 保证槽位总数恒等于 count
  const alloc = buckets.map((b) => {
    const exact = (count * b.w) / W;
    return { d: b.d, f: Math.floor(exact), frac: exact - Math.floor(exact) };
  });
  let leftover = count - alloc.reduce((s, a) => s + a.f, 0);
  const byFrac = [...alloc].sort((a, b) => b.frac - a.frac);
  for (let i = 0; i < leftover; i++) {
    const b = byFrac[i % byFrac.length];
    if (b) b.f += 1;
  }

  // 巩固优先：先上一难度 → 再当前 → 再下一难度
  const slots: QuizDifficulty[] = [];
  for (const a of alloc) for (let i = 0; i < a.f; i++) slots.push(a.d);
  return slots;
}

function buildPayload(q: GeneratedQuestion, seed: string): QuizQuestionPayload {
  const options = shuffle(q.options, seed + "::" + q.questionId);
  return {
    questionId: q.questionId,
    type: q.type,
    stem: q.stem,
    options,
    difficulty: q.difficulty,
    termId: q.termId,
    termSlug: q.termSlug,
    senseId: q.senseId,
  };
}

function diffMix(picked: GeneratedQuestion[]): Record<"1" | "2" | "3", number> {
  const mix: Record<"1" | "2" | "3", number> = { "1": 0, "2": 0, "3": 0 };
  for (const q of picked) mix[String(q.difficulty) as "1" | "2" | "3"]++;
  return mix;
}

/**
 * 出题编排（backend-implementation §2.4 步骤 1–9）。
 * 纯函数、无状态：跨请求去重由客户端传 excludeQuestionIds 实现。
 */
export function composeQuestions(input: ComposeInput): ComposeResult {
  const { pool, levelId, count, mode } = input;
  const seed = input.seed ?? randomToken();
  const exclude = new Set(input.excludeQuestionIds ?? []);

  let effectiveCap: QuizDifficulty;
  let slots: QuizDifficulty[];
  let termIdSet: Set<string> | null = null;
  let budget = 0; // 错题补位预算（仅 level 模式有上限）

  if (mode === "level") {
    const lvl = getLevel(levelId);
    if (!lvl) return { ok: false, status: 404, code: "LEVEL_NOT_FOUND", message: "关卡不存在" };
    effectiveCap = clampDiff(input.difficultyCap ?? Math.min(3, lvl.targetDifficulty + 1));
    slots = buildSlots(lvl.targetDifficulty, lvl.composition, count);
    termIdSet = input.termIds ? new Set(input.termIds) : null;
    budget = Math.floor(count * 0.25); // ≤25% 来自错题本，避免关卡编排崩坏
  } else {
    // review / daily：复习可跨档，无固定预算上限
    effectiveCap = clampDiff(input.difficultyCap ?? 3);
    const lvl = getLevel(levelId);
    slots = lvl ? buildSlots(lvl.targetDifficulty, lvl.composition, count) : new Array(count).fill(effectiveCap);
    termIdSet = input.termIds ? new Set(input.termIds) : null;
  }

  const inScope = (q: GeneratedQuestion) =>
    q.difficulty <= effectiveCap && !exclude.has(q.questionId) && (!termIdSet || termIdSet.has(q.termId));

  const byDiff: Record<1 | 2 | 3, GeneratedQuestion[]> = { 1: [], 2: [], 3: [] };
  for (const q of pool) if (inScope(q)) byDiff[q.difficulty].push(q);

  const used = new Set<string>();
  const picked: GeneratedQuestion[] = [];
  let filledWrong = 0;
  let levelPoolCount = 0;
  let repeated = 0;

  const pickFrom = (arr: GeneratedQuestion[], pred?: (q: GeneratedQuestion) => boolean): GeneratedQuestion | null => {
    for (const q of arr) if (!used.has(q.questionId) && (!pred || pred(q))) return q;
    return null;
  };

  for (const d of slots) {
    const dd = (d >= 1 && d <= 3 ? d : effectiveCap) as 1 | 2 | 3;
    // ① 错题本优先补位（level 模式受 budget 限制）
    if (termIdSet && (mode !== "level" || filledWrong < budget)) {
      const w = pickFrom(byDiff[dd], (q) => termIdSet!.has(q.termId));
      if (w) {
        picked.push(w);
        used.add(w.questionId);
        filledWrong++;
        levelPoolCount++;
        continue;
      }
    }
    // ② 关卡题池（按槽位难度）
    const s = pickFrom(byDiff[dd]);
    if (s) {
      picked.push(s);
      used.add(s.questionId);
      levelPoolCount++;
      continue;
    }
    // ③ review 模式：放宽到任意难度
    if (mode !== "level") {
      const any = pickFrom(pool.filter(inScope) as GeneratedQuestion[]);
      if (any) {
        picked.push(any);
        used.add(any.questionId);
        levelPoolCount++;
        continue;
      }
    }
    // ④ 允许重复
    if (input.allowRepeat) {
      const rep = pool.find(inScope);
      if (rep) {
        const wasUsed = used.has(rep.questionId);
        picked.push(rep);
        used.add(rep.questionId);
        if (wasUsed) repeated++;
        continue;
      }
    }
    break; // 真没题了
  }

  const delivered = picked.length;
  if (delivered < count && !input.allowRepeat) {
    return {
      ok: false,
      status: 409,
      code: "QUIZ_POOL_EXHAUSTED",
      message: "这一关的题目还在补充中，先试试前面的关卡吧。",
    };
  }

  const meta = {
    requested: count,
    delivered,
    filledFromWrongBook: filledWrong,
    filledFromLevelPool: levelPoolCount - filledWrong,
    repeated,
    difficultyMix: diffMix(picked),
    effectiveDifficultyCap: effectiveCap,
  };

  const questions = picked.map((q) => buildPayload(q, seed));
  return {
    ok: true,
    response: { requestId: randomToken(), mode, levelId: mode === "level" ? levelId : null, questions, meta },
  };
}

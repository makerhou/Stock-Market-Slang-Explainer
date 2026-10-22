import type { ExampleStyle, QuizAnswerResponse } from "@jargon/contracts";
import type { GeneratedQuestion } from "./types";
import { randomToken } from "./id";

/** 无状态找回题目（answer 路由重建题池后，用 questionId 定位） */
export function findQuestion(
  pool: GeneratedQuestion[],
  questionId: string,
): GeneratedQuestion | undefined {
  return pool.find((q) => q.questionId === questionId);
}

export function scoreAnswer(q: GeneratedQuestion, optionId: string): boolean {
  return q.correctOptionId === optionId;
}

/**
 * 组装判分响应（backend-implementation §2.5）。
 * - answer_key 判定在服务端，explanation/example 随响应下发（不在题目中预发）
 * - 连击/分数由客户端算（无排行榜 → 作弊收益为零 → 不做权威计分）
 */
export function buildAnswerResponse(
  q: GeneratedQuestion,
  optionId: string,
  contentVersion: number,
  idempotentReplay: boolean,
): QuizAnswerResponse {
  const correct = scoreAnswer(q, optionId);
  return {
    requestId: randomToken(),
    correct,
    correctOptionId: q.correctOptionId,
    explanation: q.explanation,
    example: q.exampleText
      ? { text: q.exampleText, style: (q.exampleStyle ?? "other") as ExampleStyle }
      : null,
    termSlug: q.termSlug,
    termId: q.termId,
    senseId: q.senseId,
    nextComboHint: correct
      ? { label: "答对了，继续保持", tone: "praise" }
      : { label: "这题有点绕，看看解析", tone: "encourage" },
    idempotentReplay,
    contentVersion,
  };
}

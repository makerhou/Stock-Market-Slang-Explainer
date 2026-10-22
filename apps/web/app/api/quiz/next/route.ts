import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getQuizPool, getContentVersion } from "@/lib/server-quiz";
import { composeQuestions } from "@jargon/quiz";
import type { QuizDifficulty } from "@jargon/contracts";

export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  levelId: z.string().regex(/^lv_(0[1-9]|10)$/, "关卡编号格式不正确"),
  count: z.coerce.number().int().min(1).max(20).default(8),
  mode: z.enum(["level", "review", "daily"]).default("level"),
  termIds: z
    .string()
    .max(2048)
    .optional()
    .transform((v) =>
      v === undefined
        ? undefined
        : v.split(",").map((s) => s.trim()).filter((s) => s.length > 0).slice(0, 50),
    )
    .refine((arr) => arr === undefined || arr.every((s) => /^t_[a-z0-9_]{1,32}$/.test(s)), {
      message: "termIds 含有非法标识",
    }),
  excludeQuestionIds: z
    .string()
    .max(1024)
    .optional()
    .transform((v) =>
      v === undefined ? undefined : v.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 20),
    ),
  difficultyCap: z.coerce.number().int().min(1).max(3).optional(),
  allowRepeat: z.enum(["0", "1"]).default("0").transform((v) => v === "1"),
  seed: z.string().max(32).optional(),
});

export async function GET(req: NextRequest) {
  const parsed = QuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "INVALID_QUERY", message: parsed.error.issues[0]?.message ?? "参数错误", retryable: false } },
      { status: 400 },
    );
  }
  const input = parsed.data;
  const pool = getQuizPool();
  const result = composeQuestions({
    pool,
    levelId: input.levelId,
    count: input.count,
    mode: input.mode,
    termIds: input.termIds,
    excludeQuestionIds: input.excludeQuestionIds,
    difficultyCap: input.difficultyCap as QuizDifficulty | undefined,
    allowRepeat: input.allowRepeat,
    seed: input.seed,
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: { code: result.code, message: result.message, retryable: false } },
      { status: result.status },
    );
  }
  return NextResponse.json(result.response, {
    status: 200,
    headers: { "Cache-Control": "private, no-store" },
  });
}

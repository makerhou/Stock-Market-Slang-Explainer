import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getQuizPool, getContentVersion } from "@/lib/server-quiz";
import { findQuestion, buildAnswerResponse } from "@jargon/quiz";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  questionId: z.string().min(1).max(40),
  optionId: z.string().min(1).max(16),
  clientRequestId: z.string().uuid(),
  mode: z.enum(["level", "review", "daily"]).default("level"),
  levelId: z.string().regex(/^lv_(0[1-9]|10)$/).optional(),
  elapsedMs: z.number().int().min(0).max(1_800_000).optional(),
});

// ── 幂等快路径（Level 1 内存 LRU，跨实例由 Postgres 唯一约束兜底；离线模式此处即权威）──
interface IdemRecord {
  response: unknown;
  questionId: string;
  optionId: string;
  expiresAt: number;
}
const IDEM_TTL = 10 * 60 * 1000;
const IDEM_CAP = 5000;
const idemCache = new Map<string, IdemRecord>();

function idemGet(id: string): IdemRecord | undefined {
  const r = idemCache.get(id);
  if (!r) return undefined;
  if (r.expiresAt < Date.now()) {
    idemCache.delete(id);
    return undefined;
  }
  return r;
}
function idemSet(id: string, rec: IdemRecord) {
  if (idemCache.size >= IDEM_CAP) idemCache.delete(idemCache.keys().next().value as string);
  idemCache.set(id, rec);
}

function rid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c && typeof c.randomUUID === "function" ? c.randomUUID() : "r" + Math.random().toString(36).slice(2);
}

function csrfGuard(req: NextRequest): NextResponse | null {
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) {
    return NextResponse.json(
      { error: { code: "INVALID_ORIGIN", message: "Content-Type 必须为 application/json", retryable: false } },
      { status: 403 },
    );
  }
  const site = req.headers.get("sec-fetch-site");
  if (site && !["same-origin", "same-site"].includes(site)) {
    return NextResponse.json(
      { error: { code: "INVALID_ORIGIN", message: "跨站请求被拒绝", retryable: false } },
      { status: 403 },
    );
  }
  return null;
}

export async function POST(req: NextRequest) {
  const guard = csrfGuard(req);
  if (guard) return guard;

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: { code: "BAD_JSON", message: "请求体不是合法 JSON", retryable: false } }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "INVALID_BODY", message: parsed.error.issues[0]?.message ?? "参数错误", retryable: false } },
      { status: 400 },
    );
  }
  const body = parsed.data;

  // 幂等：同 key 同 payload → 200 重放；同 key 不同 payload → 409
  const cached = idemGet(body.clientRequestId);
  if (cached) {
    if (cached.questionId === body.questionId && cached.optionId === body.optionId) {
      return NextResponse.json(
        { ...(cached.response as object), idempotentReplay: true },
        { status: 200, headers: { "Cache-Control": "private, no-store" } },
      );
    }
    return NextResponse.json(
      { error: { code: "DUPLICATE_SUBMIT", message: "这次提交的编号之前已经用过了，请刷新后重试。", retryable: false } },
      { status: 409 },
    );
  }

  const pool = getQuizPool();
  const q = findQuestion(pool, body.questionId);
  if (!q) {
    return NextResponse.json(
      { error: { code: "QUESTION_NOT_FOUND", message: "题目不存在或已失效", retryable: false } },
      { status: 404 },
    );
  }

  const response = buildAnswerResponse(q, body.optionId, getContentVersion(), false);
  idemSet(body.clientRequestId, {
    response,
    questionId: body.questionId,
    optionId: body.optionId,
    expiresAt: Date.now() + IDEM_TTL,
  });

  return NextResponse.json(response, { status: 200, headers: { "Cache-Control": "private, no-store" } });
}

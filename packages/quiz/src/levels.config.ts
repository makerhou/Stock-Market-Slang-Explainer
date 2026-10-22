import { z } from "zod";
import type { QuizDifficulty, QuizLevelConfig } from "@jargon/contracts";

/**
 * 关卡配置（10 关）。模块加载时用 Zod 校验，配置非法 → 启动即失败，不留到运行时。
 * 难度配比遵循产品 8.3 / 7.5：
 *  - 前 2 关 targetDifficulty=1，配比 {cur:8, prev:0, next:1}（硬约束全 L1）
 *  - 中 3 关 targetDifficulty=2，配比 {cur:5, prev:2, next:1}
 *  - 后 5 关 targetDifficulty=3（无 L4）→ 配比 {cur:6, prev:2, next:0}
 */
const levelSchema = z.object({
  levelId: z.string().regex(/^lv_(0[1-9]|10)$/),
  ordinal: z.number().int().min(1).max(10),
  name: z.string().min(1),
  targetDifficulty: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  composition: z.object({
    current: z.number().int().min(0),
    previous: z.number().int().min(0),
    next: z.number().int().min(0),
  }),
  questionCount: z.number().int().min(1).max(20),
});

const RAW_LEVELS: QuizLevelConfig[] = [
  { levelId: "lv_01", ordinal: 1, name: "入门关 · 先认识这些", targetDifficulty: 1, composition: { current: 8, previous: 0, next: 1 }, questionCount: 8 },
  { levelId: "lv_02", ordinal: 2, name: "入门关 · 再认一遍", targetDifficulty: 1, composition: { current: 8, previous: 0, next: 1 }, questionCount: 8 },
  { levelId: "lv_03", ordinal: 3, name: "进阶关 · 开始区分", targetDifficulty: 2, composition: { current: 5, previous: 2, next: 1 }, questionCount: 8 },
  { levelId: "lv_04", ordinal: 4, name: "进阶关 · 钱的温度", targetDifficulty: 2, composition: { current: 5, previous: 2, next: 1 }, questionCount: 8 },
  { levelId: "lv_05", ordinal: 5, name: "进阶关 · 混着考", targetDifficulty: 2, composition: { current: 5, previous: 2, next: 1 }, questionCount: 8 },
  { levelId: "lv_06", ordinal: 6, name: "挑战关 · 深水区", targetDifficulty: 3, composition: { current: 6, previous: 2, next: 0 }, questionCount: 8 },
  { levelId: "lv_07", ordinal: 7, name: "挑战关 · 术语迷宫", targetDifficulty: 3, composition: { current: 6, previous: 2, next: 0 }, questionCount: 8 },
  { levelId: "lv_08", ordinal: 8, name: "挑战关 · 老练读者", targetDifficulty: 3, composition: { current: 6, previous: 2, next: 0 }, questionCount: 8 },
  { levelId: "lv_09", ordinal: 9, name: "挑战关 · 硬核辨析", targetDifficulty: 3, composition: { current: 6, previous: 2, next: 0 }, questionCount: 8 },
  { levelId: "lv_10", ordinal: 10, name: "终极关 · 全库通考", targetDifficulty: 3, composition: { current: 6, previous: 2, next: 0 }, questionCount: 8 },
];

function assertLevels(): QuizLevelConfig[] {
  const out: QuizLevelConfig[] = [];
  for (const raw of RAW_LEVELS) {
    const parsed = levelSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`关卡配置非法 ${raw.levelId}: ${parsed.error.message}`);
    }
    out.push(parsed.data as QuizLevelConfig);
  }
  return out;
}

export const LEVELS: QuizLevelConfig[] = assertLevels();

const BY_ID = new Map(LEVELS.map((l) => [l.levelId, l]));

export function getLevel(levelId: string): QuizLevelConfig | undefined {
  return BY_ID.get(levelId);
}

export function clampDiff(n: number): QuizDifficulty {
  if (n <= 1) return 1;
  if (n >= 3) return 3;
  return 2;
}

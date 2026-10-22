import type { LexiconEntry, QuizDifficulty, QuizOption } from "@jargon/contracts";
import type { GeneratedQuestion } from "./types";
import { questionIdFromParts, fingerprintFromParts } from "./id";
import { selectDistractors, type DistractorCandidate } from "./distractor";

/** 词条难度（L1/L2/L3）→ 测验难度档（1/2/3） */
export function quizDifficultyOf(d: LexiconEntry["difficulty"]): QuizDifficulty {
  return d === "L1" ? 1 : d === "L2" ? 2 : 3;
}

/** slug → termId（与 contracts / score 路由一致的派生规则） */
export function toTermId(slug: string): string {
  return "t_" + slug.replace(/-/g, "_");
}

/** 把单条词条的「已发布释义集合」编译为题目（确定性，纯函数） */
export function generateQuestions(entry: LexiconEntry, all: LexiconEntry[]): GeneratedQuestion[] {
  const out: GeneratedQuestion[] = [];
  const qd = quizDifficultyOf(entry.difficulty);
  const termId = toTermId(entry.slug);
  const primary = entry.senses.find((s) => s.isPrimary) ?? entry.senses[0];
  if (!primary) return out; // 无义项不成题（schema 保证不为空）
  const others = all.filter((e) => e.slug !== entry.slug);
  const candidateTexts: DistractorCandidate[] = others
    .map((e) => {
      const sense = e.senses.find((s) => s.isPrimary) ?? e.senses[0];
      return sense ? { text: sense.plainExplain, entry: e } : null;
    })
    .filter((x): x is DistractorCandidate => x !== null);

  const make = (p: {
    type: GeneratedQuestion["type"];
    stem: string;
    opts: QuizOption[];
    correctOptionId: string;
    senseId: string | null;
    explanation: string;
    example: string | null | undefined;
  }): GeneratedQuestion => {
    const optionTexts = p.opts.map((o) => o.text);
    return {
      questionId: questionIdFromParts({
        type: p.type,
        termId,
        senseId: p.senseId,
        stem: p.stem,
        optionTexts,
      }),
      type: p.type,
      stem: p.stem,
      options: p.opts,
      correctOptionId: p.correctOptionId,
      difficulty: qd,
      termId,
      termSlug: entry.slug,
      senseId: p.senseId,
      explanation: p.explanation,
      exampleText: p.example ?? null,
      exampleStyle: null,
      source: "auto",
      fingerprint: fingerprintFromParts(
        p.type,
        termId,
        p.senseId ?? "",
        p.stem,
        ...optionTexts,
      ),
    };
  };

  const buildOptions = (correct: string, distractors: string[]): QuizOption[] => [
    { id: "o1", text: correct },
    { id: "o2", text: distractors[0] ?? "" },
    { id: "o3", text: distractors[1] ?? "" },
    { id: "o4", text: distractors[2] ?? "" },
  ];

  // ── T1 给术语选白话意思 ──
  {
    const correct = primary.plainExplain;
    const distractors = selectDistractors(correct, candidateTexts, entry.categoryL1);
    if (distractors.length >= 3) {
      // 弃权检查 1：干扰项不足 3 个 → 跳过
      out.push(
        make({
          type: "T1",
          stem: `${entry.headword} 在财经语境里通常指的是？`,
          opts: buildOptions(correct, distractors.map((d) => d.text)),
          correctOptionId: "o1",
          senseId: primary.senseKey,
          explanation: correct,
          example: primary.example,
        }),
      );
    }
  }

  // ── T2 给白话描述选术语 ──
  if (primary.example && !primary.example.includes(entry.headword)) {
    // 弃权检查 4：题干不得出现术语名（否则送分）
    const correctName = entry.headword;
    const sameCat = others.filter((e) => e.categoryL1 === entry.categoryL1).map((e) => e.headword);
    const picks = [...new Set([...sameCat, ...others.map((e) => e.headword)])]
      .filter((n) => n !== correctName)
      .slice(0, 3);
    if (picks.length >= 3) {
      out.push(
        make({
          type: "T2",
          stem: `${primary.example}　这说的是哪个金融术语？`,
          opts: [
            { id: "o1", text: correctName },
            { id: "o2", text: picks[0] ?? "" },
            { id: "o3", text: picks[1] ?? "" },
            { id: "o4", text: picks[2] ?? "" },
          ],
          correctOptionId: "o1",
          senseId: primary.senseKey,
          explanation: primary.plainExplain,
          example: primary.example,
        }),
      );
    }
  }

  // ── T3 语境应用 ──
  if (primary.example) {
    const correct = primary.plainExplain;
    const distractors = selectDistractors(correct, candidateTexts, entry.categoryL1);
    if (distractors.length >= 3) {
      out.push(
        make({
          type: "T3",
          stem: `有人提到：「${primary.example}」，这里的「${entry.headword}」指的是？`,
          opts: buildOptions(correct, distractors.map((d) => d.text)),
          correctOptionId: "o1",
          senseId: primary.senseKey,
          explanation: correct,
          example: primary.example,
        }),
      );
    }
  }

  // ── T4 一词多义辨析（仅多义词） ──
  if (entry.senses.length >= 2) {
    // 弃权检查 3：不足 2 个义项 → 跳过
    const s1 = entry.senses[0];
    const s2 = entry.senses[1];
    if (!s1 || !s2) return out; // 不可达兜底（length>=2 已保证）
    out.push(
      make({
        type: "T4",
        stem: `「${entry.headword}」有两种常见用法，以下哪组分别对应①②？\n① ${s1.example ?? s1.plainExplain}\n② ${s2.example ?? s2.plainExplain}`,
        opts: [
          { id: "o1", text: `① ${s1.plainExplain}；② ${s2.plainExplain}` },
          { id: "o2", text: `① ${s2.plainExplain}；② ${s1.plainExplain}` },
          { id: "o3", text: `① ${s1.plainExplain}；② ${s1.plainExplain}` },
          { id: "o4", text: `① ${s2.plainExplain}；② ${s2.plainExplain}` },
        ],
        correctOptionId: "o1",
        senseId: null,
        explanation: `「${entry.headword}」的两种含义分别是：${s1.plainExplain}；${s2.plainExplain}`,
        example: null,
      }),
    );
  }

  return out;
}

/** 把整库词条编译为题目池（确定性） */
export function buildQuestionPool(entries: LexiconEntry[]): GeneratedQuestion[] {
  const pool: GeneratedQuestion[] = [];
  for (const e of entries) pool.push(...generateQuestions(e, entries));
  return pool;
}

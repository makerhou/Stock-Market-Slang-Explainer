import type {
  ExampleStyle,
  QuizDifficulty,
  QuestionType,
  QuizOption,
} from "@jargon/contracts";

/** 服务端内部题目形态（含 answerKey，绝不下发客户端） */
export interface GeneratedQuestion {
  /** 稳定不透明 id（由 type+termId+senseId+stem+选项集合 指纹派生，与展示顺序无关） */
  questionId: string;
  type: QuestionType;
  stem: string;
  /** logical 顺序：正确项固定在 o1，展示顺序在 compose 时按 seed 打乱（id 不变） */
  options: QuizOption[];
  correctOptionId: string;
  difficulty: QuizDifficulty;
  termId: string;
  termSlug: string;
  senseId: string | null;
  /** 1 句答案依据（复用词条释义，随判分响应下发） */
  explanation: string;
  exampleText: string | null;
  exampleStyle: ExampleStyle | null;
  source: "auto";
  /** 内容指纹，用于 CI 联动重审（§3.4） */
  fingerprint: string;
}

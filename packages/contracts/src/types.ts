// 前后端共享契约类型（与 backend-implementation.md 的 API 契约对齐）

export type TermDifficulty = "L1" | "L2" | "L3";

export type CategoryL1 =
  | "宏观经济"
  | "技术指标"
  | "估值财务"
  | "基金产品"
  | "交易风险"
  | "市场情绪"
  | "走势形态"
  | "买卖操作"
  | "财报公司"
  | "机构与资金"
  | "宏观政策"
  | "美股"
  | "港股"
  | "指数板块"
  | "交易制度"
  | "量化与风险"
  | "行情黑话"
  | "常见误用";

export interface TermSummary {
  slug: string;
  headword: string;
  categoryL1: CategoryL1;
  categoryL2: string;
  difficulty: TermDifficulty;
  plainExplain: string;
  riskNote?: string;
}

export interface SenseView {
  senseKey: string;
  plainExplain: string;
  example?: string;
  notMeaning?: string;
  isPrimary: boolean;
  /** 消歧用上下文关键词（§3.3 第二级打分）；缺省时退化为主义项偏置 */
  contextKeywords?: string[];
  /** 义项词频档（high/mid/low），用于三级消歧的 frequencyWeight 排序 */
  frequency?: SenseFrequency;
}

export interface SearchResultItem {
  slug: string;
  headword: string;
  plainExplain: string;
  categoryL1: CategoryL1;
  difficulty: TermDifficulty;
  matchType: "exact" | "alias" | "pinyin" | "prefix" | "fuzzy";
}

export type QuizMode = "level" | "review" | "daily";

export interface QuizOption {
  id: string;
  text: string;
}

// ── 测验 API 契约（与 backend-implementation.md §2.4/§2.5 对齐）─────────────
/** 测验难度档（1|2|3），与词条 TermDifficulty(L1/L2/L3) 解耦 */
export type QuizDifficulty = 1 | 2 | 3;

export type QuestionType = "T1" | "T2" | "T3" | "T4";

export type ExampleStyle =
  | "life_analogy"
  | "scene"
  | "dialogue"
  | "numeric"
  | "contrast"
  | "other";

/** 下发客户端的题目（严格白名单，绝不含 answerKey / explanation / 可推断答案的字段） */
export interface QuizQuestionPayload {
  questionId: string;
  type: QuestionType;
  stem: string;
  /** 4 个选项，顺序已在服务端按 seed 打乱；id 稳定、与展示顺序解耦 */
  options: QuizOption[];
  difficulty: QuizDifficulty;
  /** 客户端 ProgressStore 以 termId 为错题本键，必须下发 */
  termId: string;
  termSlug: string;
  senseId: string | null;
}

export interface QuizNextMeta {
  requested: number;
  delivered: number;
  /** 来自错题本补位的题数 */
  filledFromWrongBook: number;
  /** 来自关卡题池的题数 */
  filledFromLevelPool: number;
  /** 因题库不足而重复的题数（>0 表示内容缺口） */
  repeated: number;
  difficultyMix: Record<"1" | "2" | "3", number>;
  /** 本次生效的难度上限（回显，便于客户端确认降档已生效） */
  effectiveDifficultyCap: QuizDifficulty;
}

export interface QuizNextResponse {
  requestId: string;
  mode: QuizMode;
  levelId: string | null;
  questions: QuizQuestionPayload[];
  meta: QuizNextMeta;
}

export interface QuizAnswerBody {
  questionId: string;
  /** 必须是该题 options 集合中的 id；注意是 id 不是下标 */
  optionId: string;
  /** 幂等键：客户端 crypto.randomUUID() 生成，重试必须复用同一个值 */
  clientRequestId: string;
  mode: QuizMode;
  levelId?: string;
  /** 仅用于埋点（作答耗时），不参与任何判分逻辑 */
  elapsedMs?: number;
}

export interface QuizAnswerResponse {
  requestId: string;
  correct: boolean;
  correctOptionId: string;
  /** 1 句答案依据（复用词条释义，必带） */
  explanation: string;
  example: { text: string; style: ExampleStyle } | null;
  termSlug: string;
  termId: string;
  senseId: string | null;
  /** 文案提示，非计分依据 */
  nextComboHint: { label: string; tone: "praise" | "encourage" | "neutral" };
  /** 是否走了幂等重放（true = 本次未产生新的作答事件） */
  idempotentReplay: boolean;
  contentVersion: number;
}

/** 服务端对外暴露的关卡配置（供 /levels 与进度展示） */
export interface QuizLevelConfig {
  levelId: string;
  ordinal: number;
  name: string;
  targetDifficulty: QuizDifficulty;
  composition: { current: number; previous: number; next: number };
  questionCount: number;
}

// ── 客户端词典（/api/lexicon 下发 + IndexedDB 缓存）────────────────────
export type SenseFrequency = "high" | "mid" | "low";

export type AliasType =
  | "primary"
  | "cn_alias"
  | "en_alias"
  | "pinyin_abbr"
  | "pinyin_full"
  | "colloquial"
  | "misspell";

export interface LexiconAlias {
  raw: string;
  aliasType: AliasType;
}

/**
 * 词条配套的可视化（M8+）：用互动图表把抽象术语讲给金融小白 / 小学生听懂。
 * type 决定前端渲染哪个互动组件；config 为组件私有的可选参数（数值/标签等）。
 */
export type VizType =
  | "PriceChangeBars"
  | "CandleBuilder"
  | "MarketMood"
  | "VolumeRatio"
  | "MarketCapBar"
  | "GDPStack"
  | "CPIBasket"
  | "InventoryClear"
  | "PoolDilution"
  | "UnlockPressure"
  | "PEScale"
  | "ProfitLossScale"
  | "DividendSplit"
  | "ExRightAdjust"
  | "TurnoverPie"
  | "CrossLines"
  | "Oscillator"
  | "MoneyFlow"
  | "LongShortSeesaw"
  // ── 中美港股词条扩充（M10）──
  | "IpoLottery"
  | "BreakIssue"
  | "TrapScale"
  | "RiskLadder"
  | "ConvertibleScale"
  | "HaltClock"
  | "IndexTower"
  | "CircuitBreaker"
  | "PrePostMarket"
  | "EarningsSeason"
  | "AdrBridge"
  | "OptionsLadder"
  | "LeverageWheel"
  | "GreyMarket"
  | "HkTypesCompare"
  | "GaugeBar";

export interface TermViz {
  type: VizType;
  /** 卡片标题（缺省用「看图秒懂」） */
  title?: string;
  /** 一句人话说明，配在图上方（给小白/小学生看的引导语） */
  caption?: string;
  /** 互动操作提示，如「拖动下面的滑块试试」 */
  hint?: string;
  /** 看完图的一句话结论 / 彩蛋，配在图下方 */
  insight?: string;
  /** 组件私有配置（数值、标签、默认值等），各组件自行解析 */
  config?: Record<string, unknown>;
}

/**
 * 词条深度解读层（M8+）：用「影响 / 好 / 坏 / 政策 / 例子」五问，
 * 把抽象术语讲给金融小白 / 小学生听懂。各字段均为人话短句（数组便于排版成要点）。
 */
export interface TermInsights {
  /** 这个指标会影响什么（牵动哪些东西） */
  affects: string[];
  /** 指标读数「好」说明什么 */
  good: string[];
  /** 指标读数「坏」说明什么 */
  bad: string[];
  /** 哪些政策或因素会影响它 */
  policy: string[];
  /** 一个生活化 / 故事化例子 */
  example: string;
}

export interface LexiconEntry {
  slug: string;
  headword: string;
  categoryL1: CategoryL1;
  categoryL2: string;
  difficulty: TermDifficulty;
  summaryPlain: string;
  riskNote?: string;
  frequency: SenseFrequency;
  /** 热度分（用于 §3.1 排序稳定性 tie-break 与 §3.4 建议生成）；由 frequency 档位派生 */
  popularity: number;
  senses: SenseView[];
  aliases: LexiconAlias[];
  /** 配套互动可视化（M8+）；缺省则详情页不渲染图表区 */
  viz?: TermViz;
  /** 深度解读层（M8+）；缺省则详情页不渲染「读懂这个词」卡片 */
  insights?: TermInsights;
}

export interface LexiconManifest {
  version: number;
  checksum: string;
  generatedAt: string;
  count: number;
  entries: LexiconEntry[];
}

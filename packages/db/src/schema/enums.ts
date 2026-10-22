import { pgEnum } from "drizzle-orm/pg-core";

/**
 * 枚举定义（与 data-model.md §2.1 保持一致）。
 * 分类枚举标签 = MDX front-matter 取值，避免两套定义漂移（架构 §2.7）。
 */

// ── 一级分类：12 个固定值（主理人裁决 #1）────────────────────────────
export const termCategoryL1 = pgEnum("term_category_l1", [
  "宏观经济",
  "技术指标",
  "估值财务",
  "基金产品",
  "交易风险",
  "市场情绪",
  "走势形态",
  "买卖操作",
  "财报公司",
  "机构与资金",
  "宏观政策",
  "常见误用",
]);

// ── 二级分类：51 个固定值（每个一级下 3~5 个）────────────────────────
export const termCategoryL2 = pgEnum("term_category_l2", [
  // 宏观经济（5）
  "增长与产出",
  "物价水平",
  "货币与信用",
  "就业与收入",
  "汇率与国际",
  // 宏观政策（4）
  "央行与货币政策",
  "财政政策",
  "利率与政策工具",
  "监管与市场制度",
  // 技术指标（5）
  "均线类",
  "摆动指标",
  "量能指标",
  "波动率指标",
  "交叉与信号",
  // 估值财务（5）
  "估值倍数",
  "盈利能力",
  "现金流",
  "杠杆水平",
  "增长与口径",
  // 基金产品（4）
  "基金类型",
  "指数与市场",
  "规模与净值",
  "跨市场工具",
  // 交易风险（5）
  "收益与亏损",
  "回撤与风险度量",
  "交易机制",
  "发行与上市",
  "报价与成本",
  // 市场情绪（3）
  "多空立场",
  "群体心理",
  "风险偏好",
  // 走势形态（4）
  "趋势与反转",
  "盘整与区间",
  "突破与关键位",
  "极端走势",
  // 买卖操作（4）
  "方向与持仓",
  "进出场动作",
  "仓位管理",
  "持有者行为",
  // 财报公司（4）
  "财报发布与预期",
  "收入与利润",
  "公司质地",
  "股东回报",
  // 机构与资金（4）
  "机构类型",
  "资金与流动性",
  "杠杆与保证金",
  "市场结构事件",
  // 常见误用（4）
  "信号误读",
  "估值误读",
  "指标误读",
  "主体误读",
]);

export const termDifficulty = pgEnum("term_difficulty", ["L1", "L2", "L3"]);
export const questionBand = pgEnum("question_band", ["easy", "mid", "hard"]);

// 词条生命周期（产品 §7.1 的 4 态 + archived 软删除态）
export const termStatus = pgEnum("term_status", [
  "draft",
  "pending_review",
  "published",
  "needs_revision",
  "archived",
]);

// 题目生命周期（内容流水线 §3.5）
export const questionStatus = pgEnum("question_status", [
  "draft",
  "pending_review",
  "approved",
  "published",
  "stale",
  "retired",
]);

export const senseFrequency = pgEnum("sense_frequency", ["high", "mid", "low"]);
export const sourceType = pgEnum("source_type", [
  "self_authored",
  "expert_reviewed",
  "llm_generated",
]);

export const aliasType = pgEnum("alias_type", [
  "primary",
  "cn_alias",
  "en_alias",
  "pinyin_abbr",
  "pinyin_full",
  "colloquial",
  "misspell",
]);

export const relationType = pgEnum("relation_type", [
  "related",
  "contrast",
  "prereq",
]);

export const exampleStyle = pgEnum("example_style", [
  "life_analogy",
  "workplace_social",
  "family_finance",
  "business_practice",
]);

export const questionType = pgEnum("question_type", ["T1", "T2", "T3", "T4"]);
export const questionSource = pgEnum("question_source", ["auto", "semi", "manual"]);

export const optionKind = pgEnum("option_kind", [
  "correct",
  "gloss",
  "not_meaning",
  "term_name",
  "example_derived",
]);

export const quizMode = pgEnum("quiz_mode", ["level", "review", "daily"]);
export const releaseKind = pgEnum("release_kind", [
  "lexicon",
  "quiz",
  "rules",
  "disclaimer",
]);
export const releaseStatus = pgEnum("release_status", [
  "compiling",
  "current",
  "superseded",
  "failed",
]);
export const missResolution = pgEnum("miss_resolution", [
  "new",
  "triaged",
  "covered",
  "rejected",
]);

export const blacklistKind = pgEnum("blacklist_kind", [
  "strong_banned",
  "weak_banned",
  "term_whitelist",
  "noun_suffix",
  "noun_explicit",
  "context_indicator",
  "negation_prefix",
  "imperative_pattern",
  "contextual_pattern",
  "disclaimer_template",
  "exemption",
]);

export const jargonLayer = pgEnum("jargon_layer", ["A", "B"]);
export const jargonKind = pgEnum("jargon_kind", [
  "jargon",
  "contextual",
  "generic",
  "proper_noun",
]);
export const fieldPolicy = pgEnum("field_policy", ["block", "review", "allow"]);

import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import * as e from "./enums";

/**
 * 核心表定义（与 data-model.md §2 DDL 对应）。
 * 完整 DDL（含全部索引 / CHECK / 注释）见 data-model.md §2；
 * 此处为 M1 可演进的核心 schema，后续由 drizzle-kit generate 生成迁移。
 */

// ── 分类登记表（两层枚举的合法组合真源）────────────────────────────
export const categoryL1 = pgTable(
  "category_l1",
  {
    l1: e.termCategoryL1("l1").primaryKey(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    numericId: integer("numeric_id").notNull(),
    sortOrder: integer("sort_order").notNull(),
    riskNoteTemplate: text("risk_note_template").notNull(),
    t2Referent: text("t2_referent").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("category_l1_code_uk").on(t.code),
    uniqueIndex("category_l1_numeric_id_uk").on(t.numericId),
  ],
);

export const categoryL2 = pgTable(
  "category_l2",
  {
    l2: e.termCategoryL2("l2").primaryKey(),
    l1: e.termCategoryL1("l1").notNull(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    numericId: integer("numeric_id").notNull(),
    sortOrder: integer("sort_order").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("category_l2_code_uk").on(t.code),
    uniqueIndex("category_l2_numeric_id_uk").on(t.numericId),
  ],
);

// ── 术语主体 ───────────────────────────────────────────────────────
export const term = pgTable(
  "term",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    categoryL1: e.termCategoryL1("category_l1").notNull(),
    categoryL2: e.termCategoryL2("category_l2").notNull(),
    difficulty: e.termDifficulty("difficulty").notNull().default("L1"),
    status: e.termStatus("status").notNull().default("draft"),
    primarySenseId: uuid("primary_sense_id"),
    summaryPlain: text("summary_plain"),
    riskNote: text("risk_note"),
    version: integer("version").notNull().default(1),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("term_slug_uk").on(t.slug),
    index("term_cat_diff_idx").on(t.categoryL1, t.categoryL2, t.difficulty),
  ],
);

// ── 义项 ───────────────────────────────────────────────────────────
export const sense = pgTable(
  "sense",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    termId: uuid("term_id")
      .notNull()
      .references(() => term.id, { onDelete: "cascade" }),
    senseKey: text("sense_key").notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
    plainExplain: text("plain_explain").notNull(),
    example: text("example"),
    notMeaning: text("not_meaning"),
    regulatoryFlags: text("regulatory_flags").notNull().default("no"),
    frequency: e.senseFrequency("frequency").notNull().default("mid"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("sense_term_key_uk").on(t.termId, t.senseKey),
    index("sense_term_idx").on(t.termId),
  ],
);

// ── 别名 / 缩写 / 拼音 / 口语 / 错别字 ─────────────────────────────
export const alias = pgTable(
  "alias",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    senseId: uuid("sense_id").references(() => sense.id, { onDelete: "cascade" }),
    termId: uuid("term_id").references(() => term.id, { onDelete: "cascade" }),
    normKey: text("norm_key").notNull(),
    raw: text("raw").notNull(),
    aliasType: e.aliasType("alias_type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // partial unique：仅 primary 类型全局唯一（data-model §4.1）
    uniqueIndex("alias_norm_key_primary_uk")
      .on(t.normKey)
      .where(sql`alias_type = 'primary'`),
    index("alias_sense_idx").on(t.senseId),
    index("alias_term_idx").on(t.termId),
  ],
);

// ── 标签（多对多）──────────────────────────────────────────────────
export const tag = pgTable(
  "tag",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
  },
  (t) => [uniqueIndex("tag_name_uk").on(t.name)],
);

export const termTag = pgTable(
  "term_tag",
  {
    termId: uuid("term_id")
      .notNull()
      .references(() => term.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tag.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.termId, t.tagId] })],
);

// ── 相关词 / 易混词 / 前置知识（自关联多对多）──────────────────────
export const termRelation = pgTable(
  "term_relation",
  {
    source: uuid("source")
      .notNull()
      .references(() => term.id, { onDelete: "cascade" }),
    target: uuid("target")
      .notNull()
      .references(() => term.id, { onDelete: "cascade" }),
    relationType: e.relationType("relation_type").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.source, t.target, t.relationType] }),
    index("term_relation_target_idx").on(t.target),
    // 应用层保证 source != target
  ],
);

// ── 题目与选项（answer_key 永不下发客户端）─────────────────────────
export const quizQuestion = pgTable(
  "quiz_question",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    termId: uuid("term_id")
      .notNull()
      .references(() => term.id),
    senseId: uuid("sense_id").references(() => sense.id),
    band: e.questionBand("band").notNull(),
    questionType: e.questionType("question_type").notNull(),
    status: e.questionStatus("status").notNull().default("draft"),
    source: e.questionSource("source").notNull().default("auto"),
    stem: text("stem").notNull(),
    options: jsonb("options").notNull(),
    answerKey: text("answer_key").notNull(),
    explanation: text("explanation").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("quiz_q_term_idx").on(t.termId),
    index("quiz_q_band_idx").on(t.band),
  ],
);

export const quizLevel = pgTable(
  "quiz_level",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    level: integer("level").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    unlockOrder: integer("unlock_order").notNull(),
    questionCount: integer("question_count").notNull().default(8),
    difficultyBand: e.questionBand("difficulty_band").notNull().default("easy"),
  },
  (t) => [uniqueIndex("quiz_level_level_uk").on(t.level)],
);

export const quizLevelQuestion = pgTable(
  "quiz_level_question",
  {
    levelId: uuid("level_id")
      .notNull()
      .references(() => quizLevel.id, { onDelete: "cascade" }),
    questionId: uuid("question_id")
      .notNull()
      .references(() => quizQuestion.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.levelId, t.questionId] })],
);

// ── 作答事件（兼作幂等键载体；不含任何用户标识）───────────────────
export const answerEvent = pgTable(
  "answer_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientRequestId: uuid("client_request_id").notNull(),
    questionId: uuid("question_id")
      .notNull()
      .references(() => quizQuestion.id),
    isCorrect: boolean("is_correct").notNull(),
    isFirstAttempt: boolean("is_first_attempt").notNull().default(false),
    isRetry: boolean("is_retry").notNull().default(false),
    mode: e.quizMode("mode").notNull().default("level"),
    contentVersion: integer("content_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("answer_event_req_id_uk").on(t.clientRequestId),
    index("answer_event_q_idx").on(t.questionId),
    // 保留期 90 天自动清理（cron / 应用层）
  ],
);

// ── 词库缺口池（只存归一化 query + 计数，不关联用户标识）──────────
export const searchMissLog = pgTable(
  "search_miss_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    normQuery: text("norm_query").notNull(),
    count: integer("count").notNull().default(1),
    firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
    lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
    resolution: e.missResolution("resolution").notNull().default("new"),
  },
  (t) => [
    uniqueIndex("search_miss_norm_uk").on(t.normQuery),
    // k-匿名门槛 count>=3 才进运营视图（应用层）
  ],
);

// ── 免责声明（可动态配置，法务改文案不发版）────────────────────────
export const disclaimer = pgTable(
  "disclaimer",
  {
    code: text("code").notNull().primaryKey(),
    version: integer("version").notNull(),
    text: text("text").notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("disclaimer_code_ver_uk").on(t.code, t.version)],
);

// ── 词库发布批次（version 单调递增 + checksum）─────────────────────
export const contentRelease = pgTable(
  "content_release",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: e.releaseKind("kind").notNull(),
    version: integer("version").notNull(),
    checksum: text("checksum").notNull(),
    status: e.releaseStatus("status").notNull().default("compiling"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("content_release_kind_ver_uk").on(t.kind, t.version)],
);

// ── 词条内容快照（回滚 / diff 审计）───────────────────────────────
export const termVersion = pgTable(
  "term_version",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    termId: uuid("term_id")
      .notNull()
      .references(() => term.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("term_version_term_idx").on(t.termId)],
);

// ── 禁用词表 / 零黑话扫描词典（CI 校验数据源，可运营维护）──────────
export const blacklistWord = pgTable(
  "blacklist_word",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: e.blacklistKind("kind").notNull(),
    value: text("value").notNull(),
    fieldPolicy: e.fieldPolicy("field_policy").notNull().default("block"),
    note: text("note"),
  },
  (t) => [index("blacklist_kind_value_idx").on(t.kind, t.value)],
);

export const jargonDict = pgTable(
  "jargon_dict",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    layer: e.jargonLayer("layer").notNull(),
    kind: e.jargonKind("kind").notNull(),
    value: text("value").notNull(),
    note: text("note"),
  },
  (t) => [index("jargon_layer_value_idx").on(t.layer, t.value)],
);

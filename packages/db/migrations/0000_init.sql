-- 0000_init.sql — 股票黑话解释器 初始迁移
-- 与 packages/db/src/schema 对应。完整 DDL（含全部索引/CHECK/注释）见 data-model.md §2。
-- 执行：DATABASE_URL=... npm run db:migrate

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── 枚举 ───────────────────────────────────────────────────────
CREATE TYPE term_category_l1 AS ENUM ('宏观经济','技术指标','估值财务','基金产品','交易风险','市场情绪','走势形态','买卖操作','财报公司','机构与资金','宏观政策','常见误用');
CREATE TYPE term_category_l2 AS ENUM ('增长与产出','物价水平','货币与信用','就业与收入','汇率与国际','央行与货币政策','财政政策','利率与政策工具','监管与市场制度','均线类','摆动指标','量能指标','波动率指标','交叉与信号','估值倍数','盈利能力','现金流','杠杆水平','增长与口径','基金类型','指数与市场','规模与净值','跨市场工具','收益与亏损','回撤与风险度量','交易机制','发行与上市','报价与成本','多空立场','群体心理','风险偏好','趋势与反转','盘整与区间','突破与关键位','极端走势','方向与持仓','进出场动作','仓位管理','持有者行为','财报发布与预期','收入与利润','公司质地','股东回报','机构类型','资金与流动性','杠杆与保证金','市场结构事件','信号误读','估值误读','指标误读','主体误读');
CREATE TYPE term_difficulty AS ENUM ('L1','L2','L3');
CREATE TYPE question_band AS ENUM ('easy','mid','hard');
CREATE TYPE term_status AS ENUM ('draft','pending_review','published','needs_revision','archived');
CREATE TYPE question_status AS ENUM ('draft','pending_review','approved','published','stale','retired');
CREATE TYPE sense_frequency AS ENUM ('high','mid','low');
CREATE TYPE source_type AS ENUM ('self_authored','expert_reviewed','llm_generated');
CREATE TYPE alias_type AS ENUM ('primary','cn_alias','en_alias','pinyin_abbr','pinyin_full','colloquial','misspell');
CREATE TYPE relation_type AS ENUM ('related','contrast','prereq');
CREATE TYPE example_style AS ENUM ('life_analogy','workplace_social','family_finance','business_practice');
CREATE TYPE question_type AS ENUM ('T1','T2','T3','T4');
CREATE TYPE question_source AS ENUM ('auto','semi','manual');
CREATE TYPE option_kind AS ENUM ('correct','gloss','not_meaning','term_name','example_derived');
CREATE TYPE quiz_mode AS ENUM ('level','review','daily');
CREATE TYPE release_kind AS ENUM ('lexicon','quiz','rules','disclaimer');
CREATE TYPE release_status AS ENUM ('compiling','current','superseded','failed');
CREATE TYPE miss_resolution AS ENUM ('new','triaged','covered','rejected');
CREATE TYPE blacklist_kind AS ENUM ('strong_banned','weak_banned','term_whitelist','noun_suffix','noun_explicit','context_indicator','negation_prefix','imperative_pattern','contextual_pattern','disclaimer_template','exemption');
CREATE TYPE jargon_layer AS ENUM ('A','B');
CREATE TYPE jargon_kind AS ENUM ('jargon','contextual','generic','proper_noun');
CREATE TYPE field_policy AS ENUM ('block','review','allow');

-- ── 分类登记表 ─────────────────────────────────────────────────
CREATE TABLE category_l1 (
  l1 term_category_l1 PRIMARY KEY,
  code text NOT NULL,
  name text NOT NULL,
  numeric_id smallint NOT NULL,
  sort_order smallint NOT NULL,
  risk_note_template text NOT NULL,
  t2_referent text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT category_l1_code_uk UNIQUE (code),
  CONSTRAINT category_l1_numeric_id_uk UNIQUE (numeric_id)
);

CREATE TABLE category_l2 (
  l2 term_category_l2 PRIMARY KEY,
  l1 term_category_l1 NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  numeric_id smallint NOT NULL,
  sort_order smallint NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT category_l2_code_uk UNIQUE (code),
  CONSTRAINT category_l2_numeric_id_uk UNIQUE (numeric_id)
);

-- ── 术语 / 义项 / 别名 ─────────────────────────────────────────
CREATE TABLE term (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  category_l1 term_category_l1 NOT NULL,
  category_l2 term_category_l2 NOT NULL,
  difficulty term_difficulty NOT NULL DEFAULT 'L1',
  status term_status NOT NULL DEFAULT 'draft',
  primary_sense_id uuid,
  summary_plain text,
  risk_note text,
  version integer NOT NULL DEFAULT 1,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT term_slug_uk UNIQUE (slug)
);
CREATE INDEX term_cat_diff_idx ON term (category_l1, category_l2, difficulty);

CREATE TABLE sense (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  term_id uuid NOT NULL REFERENCES term (id) ON DELETE CASCADE,
  sense_key text NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  plain_explain text NOT NULL,
  example text,
  not_meaning text,
  regulatory_flags text NOT NULL DEFAULT 'no',
  frequency sense_frequency NOT NULL DEFAULT 'mid',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sense_term_key_uk UNIQUE (term_id, sense_key)
);
CREATE INDEX sense_term_idx ON sense (term_id);

CREATE TABLE alias (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sense_id uuid REFERENCES sense (id) ON DELETE CASCADE,
  term_id uuid REFERENCES term (id) ON DELETE CASCADE,
  norm_key text NOT NULL,
  raw text NOT NULL,
  alias_type alias_type NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- partial unique：仅 primary 类型全局唯一
CREATE UNIQUE INDEX alias_norm_key_primary_uk ON alias (norm_key) WHERE alias_type = 'primary';
CREATE INDEX alias_sense_idx ON alias (sense_id);
CREATE INDEX alias_term_idx ON alias (term_id);

-- ── 标签 ───────────────────────────────────────────────────────
CREATE TABLE tag (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  kind text NOT NULL,
  CONSTRAINT tag_name_uk UNIQUE (name)
);

CREATE TABLE term_tag (
  term_id uuid NOT NULL REFERENCES term (id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES tag (id) ON DELETE CASCADE,
  PRIMARY KEY (term_id, tag_id)
);

CREATE TABLE term_relation (
  source uuid NOT NULL REFERENCES term (id) ON DELETE CASCADE,
  target uuid NOT NULL REFERENCES term (id) ON DELETE CASCADE,
  relation_type relation_type NOT NULL,
  PRIMARY KEY (source, target, relation_type)
);
CREATE INDEX term_relation_target_idx ON term_relation (target);

-- ── 测验 ───────────────────────────────────────────────────────
CREATE TABLE quiz_question (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  term_id uuid NOT NULL REFERENCES term (id),
  sense_id uuid REFERENCES sense (id),
  band question_band NOT NULL,
  question_type question_type NOT NULL,
  status question_status NOT NULL DEFAULT 'draft',
  source question_source NOT NULL DEFAULT 'auto',
  stem text NOT NULL,
  options jsonb NOT NULL,
  answer_key text NOT NULL,
  explanation text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quiz_q_term_idx ON quiz_question (term_id);
CREATE INDEX quiz_q_band_idx ON quiz_question (band);

CREATE TABLE quiz_level (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  level integer NOT NULL,
  name text NOT NULL,
  description text,
  unlock_order integer NOT NULL,
  question_count integer NOT NULL DEFAULT 8,
  difficulty_band question_band NOT NULL DEFAULT 'easy',
  CONSTRAINT quiz_level_level_uk UNIQUE (level)
);

CREATE TABLE quiz_level_question (
  level_id uuid NOT NULL REFERENCES quiz_level (id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES quiz_question (id) ON DELETE CASCADE,
  sort_order integer NOT NULL DEFAULT 0,
  PRIMARY KEY (level_id, question_id)
);

-- ── 作答事件 / 缺口池 ──────────────────────────────────────────
CREATE TABLE answer_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_request_id uuid NOT NULL,
  question_id uuid NOT NULL REFERENCES quiz_question (id),
  is_correct boolean NOT NULL,
  is_first_attempt boolean NOT NULL DEFAULT false,
  is_retry boolean NOT NULL DEFAULT false,
  mode quiz_mode NOT NULL DEFAULT 'level',
  content_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT answer_event_req_id_uk UNIQUE (client_request_id)
);
CREATE INDEX answer_event_q_idx ON answer_event (question_id);

CREATE TABLE search_miss_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  norm_query text NOT NULL,
  count integer NOT NULL DEFAULT 1,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  resolution miss_resolution NOT NULL DEFAULT 'new',
  CONSTRAINT search_miss_norm_uk UNIQUE (norm_query)
);

-- ── 免责 / 发布 / 快照 ─────────────────────────────────────────
CREATE TABLE disclaimer (
  code text NOT NULL,
  version integer NOT NULL,
  text text NOT NULL,
  effective_from timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (code),
  CONSTRAINT disclaimer_code_ver_uk UNIQUE (code, version)
);

CREATE TABLE content_release (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind release_kind NOT NULL,
  version integer NOT NULL,
  checksum text NOT NULL,
  status release_status NOT NULL DEFAULT 'compiling',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_release_kind_ver_uk UNIQUE (kind, version)
);

CREATE TABLE term_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  term_id uuid NOT NULL REFERENCES term (id) ON DELETE CASCADE,
  version integer NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX term_version_term_idx ON term_version (term_id);

-- ── 禁用词 / 零黑话词典 ───────────────────────────────────────
CREATE TABLE blacklist_word (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind blacklist_kind NOT NULL,
  value text NOT NULL,
  field_policy field_policy NOT NULL DEFAULT 'block',
  note text
);
CREATE INDEX blacklist_kind_value_idx ON blacklist_word (kind, value);

CREATE TABLE jargon_dict (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  layer jargon_layer NOT NULL,
  kind jargon_kind NOT NULL,
  value text NOT NULL,
  note text
);
CREATE INDEX jargon_layer_value_idx ON jargon_dict (layer, value);

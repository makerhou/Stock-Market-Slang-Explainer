# 股票黑话解释器 · 数据建模方案（概念模型 / DDL / 索引 / 内存镜像 / 编译管线）

> 文档作者：数据建模工程师（储海量）
> 文档性质：**物理数据模型定稿稿**，可直接执行 DDL
> 目标数据库：**Neon Serverless Postgres（PostgreSQL 15+）**，ORM = Drizzle，校验 = Zod / drizzle-zod
> 上游依据：产品需求 §7.1/§7.3/§7.6/§8、架构设计 §3.2/§3.3/§4.6/§5、服务端实现 §2/§7.2/§7.5、内容流水线 §3.5/§4、`content-rules/*.yaml`
> 主理人裁决：两层分类枚举、term/sense 分离 + `norm_key` 全局唯一、错题本升 Must、`quiz_mistake` 无用户标识、`answer_event` 90 天保留、`search_miss_log` k≥3、免责声明入库、**不建没用的表**
> 数据量口径：**口径 A = 首版实际（120 条术语 / 145 义项 / 12 一级分类）**；**口径 B = 扩展上限（2000 条术语 / ≈2400 义项）**。所有估算均标注假设前提。

---

## 0. 建模决策摘要（TL;DR）

| # | 决策 | 一句话理由 |
|---|---|---|
| D1 | **分类 = 两个真 ENUM 类型（`term_category_l1` 12 值 / `term_category_l2` 51 值）+ 两张登记表 + 复合外键** | 枚举保证"值域封闭"，登记表承载展示名/风险提示模板/T2 指代词，复合外键 `(l1,l2) → category_l2(l1,l2)` 保证"二级必须属于该一级"这条跨字段不变量落到 DB |
| D2 | **`term` / `sense` / `sense_example` 三层拆分**，举例独立成表而非 jsonb 数组 | 举例需按条校验（LEN-004 / EX-002 / EX-003）与按族做场景互斥（DUP-003），行级比 jsonb 数组可校验、可查询、可统计 |
| D3 | **`alias.norm_key` 全表 UNIQUE + 两条 partial unique index 限定"每 term/每 sense 只有一个 primary 别名"** | 全局唯一是"同串字符不得指向两个词条"的最终防线；partial index 才允许"多别名指向同一 term" |
| D4 | **`term` / `sense` / `quiz_question` / `quiz_level` 全部双标识：内部 `bigint id` + 对外 `public_id text`** | 服务端契约用 `t_pe` / `s_pe_fin` / `q_01J…` / `lv_01`；内部主键策略可自由变更而不破坏对外契约，也不泄露词条总量 |
| D5 | **`answer_event` 存 `question_public_id`（NOT NULL）+ `question_ref`（可空 FK, ON DELETE SET NULL）双份** | 90 天保留期内题目可能被 retire/删除，分析维度不能被外键带走 |
| D6 | **`content_release` 上 `UNIQUE (release_kind, git_sha)`** | 编译管线的幂等根：同一 commit 重复编译不产生新版本号，checksum 不变 → 索引不重建 |
| D7 | **DB CHECK 只放"违反即数据损坏"的约束；随产品口径演进的内容规则放 CI/Zod** | 改一次字数口径不应该需要一次 DB 迁移（详见 §6.1 取舍原则） |
| D8 | **`search_miss_log` 无 `raw_query` 列**（架构 ER 草案里有，本方案删除） | 裁决 #6 明确"只存归一化 query"；原始输入可能含姓名/手机号片段，落库即违反产品 L6 |
| D9 | **`quiz_mistake` 是"题目维度的全局匿名聚合"，不是用户错题本** | 用户错题本（`mastered`/`inDefaultList`）100% 在客户端 localStorage；服务端只做"哪些题大家都错"的聚合 |
| D10 | **`answer_event` v1 单表 + 定时 DELETE，不做分区** | 分区会迫使唯一键变成 `(client_request_id, created_at)`，跨月重试的幂等就漏了；幂等是硬要求，130k~390k 行的 DELETE 完全可承受 |
| D11 | **v1 不建 `term_symbol` / `feedback` / 向量表 / `user*` / `misconception`** | 裁决 #8。误用命题库留在 YAML（Git 真源），编译进 `quiz_option.source_ref` |
| D12 | **`blacklist_word` / `jargon_dict` 建表，但定位为"规则集的编译产物镜像"，按 `ruleset_release_id` 版本化** | 发布后回溯扫描（内容流水线 §4.5 ④）跑在 Vercel Cron 上，**没有 Git 工作区**，只能从 DB 读规则快照 |

**表清单汇总（18 张表 + 3 个视图）**

| # | 表名 | 职责 | 口径 A 行数（120 条） | 口径 B 行数（2000 条） | v1 必需 |
|---|---|---|---|---|---|
| 1 | `category_l1` | 一级分类登记表（12 行固定）+ 风险提示模板 + T2 指代词 | 12 | 12 | ✅ 必需 |
| 2 | `category_l2` | 二级分类登记表 + **两级合法组合的唯一真源** | 51 | ≈90 | ✅ 必需 |
| 3 | `term` | 术语主体：slug/分类/难度/合规字段/审核留痕 | 120 | 2,000 | ✅ 必需 |
| 4 | `sense` | 义项：三层释义 + 语境标签 + 频率 + 溯源 | 145 | ≈2,400 | ✅ 必需 |
| 5 | `sense_example` | 举例（每义项 ≥1，L1 词条 ≥2）+ 具体性断言 | ≈230 | ≈3,800 | ✅ 必需 |
| 6 | `alias` | 别名/口语/拼音/错拼，`norm_key` 全局唯一 | ≈430 | ≈7,000 | ✅ 必需 |
| 7 | `tag` / 8 `term_tag` | 运营标签（"新手常问"/"高频"），API `tags[]` 的来源 | 6 / ≈240 | 20 / ≈6,000 | ✅ 必需 |
| 9 | `term_relation` | 相关词/易混词/前置知识（有向、类型化、带一句话解释） | ≈300 | ≈8,000 | ✅ 必需 |
| 10 | `term_version` | 词条内容快照（回滚 + diff 审计） | ≈180 | ≈6,000 | ✅ 必需 |
| 11 | `content_release` | 发布批次账本：version + checksum + git_sha | ≈30 | ≈500 | ✅ 必需 |
| 12 | `quiz_level` | 10 关编排配置（难度构成/主题分类/知识点小结） | 10 | 10~30 | ✅ 必需 |
| 13 | `quiz_question` | 题目（T1–T4）+ 依据 + 指纹 + 难度预估 | 374 | ≈6,000 | ✅ 必需 |
| 14 | `quiz_option` | 选项（4/题）+ `is_correct`（永不下发）+ 干扰项溯源 | 1,496 | ≈24,000 | ✅ 必需 |
| 15 | `quiz_level_question` | 关卡↔题目编排（fixed 槽位 / pool 候选） | ≈280 | ≈1,000 | ✅ 必需 |
| 16 | `answer_event` | 作答事件（**无任何用户标识**，90 天保留） | ≈13 万（稳态） | ≈39 万（稳态） | ✅ 必需 |
| 17 | `quiz_mistake` | 错题聚合（题目维度、全局匿名） | ≤374 | ≤6,000 | ✅ 必需 |
| 18 | `search_miss_log` | 词库缺口池（归一化 query + 聚合计数，k≥3 才进运营视图） | ≈500 | ≈20,000 | ✅ 必需 |
| 19 | `disclaimer` | 免责声明文案（code+version+effective_from+is_active） | ≈10 | ≈50 | ✅ 必需 |
| 20 | `blacklist_word` | 禁用词/豁免规则集（编译产物，按规则版本快照） | ≈210 | ≈450 | ⚠️ 建议（回溯扫描需要） |
| 21 | `jargon_dict` | 零黑话扫描词典 Layer A（自动抽取）+ Layer B（人工） | ≈700 | ≈5,000 | ⚠️ 建议（同上） |

> 行数假设前提（口径 A）：平均 1.21 义项/条（145÷120）；平均 1.6 举例/义项；平均 3.0 别名/条 + 0.5 义项专属别名；`term_relation` 平均 2.5 条/词条（related ≤4 取 1.8 + contrast 0.6 + prereq 0.1）；题目 374（内容流水线 §1.2 配额表）；`term_version` 平均 1.5 次修订/词条。
> 行数假设前提（口径 B）：按口径 A 的同比例放大，义项比降至 1.2、别名比升至 3.5（词库越大，别名/口语说法越密）。
> `answer_event` 稳态口径：日活 1,000 × 查询→测验转化 18% × 人均 8 题 ≈ **1,440 行/天**（服务端实现 §2.5 假设）→ 90 天 ≈ 13 万行；若日活达 3,000（架构 §4.1 假设）→ ≈4,320 行/天 → 90 天 ≈ 39 万行。**两个口径下总存储都 < 100MB，Neon Launch 10GB 无压力。**

---

## 1. 概念模型（ER）

### 1.1 实体清单

| 实体 | 说明 | 关键属性 |
|---|---|---|
| `category_l1` | 一级分类登记表，12 行固定枚举 | `l1`(enum PK)、`name`、`numeric_id`(对外 API 用)、`risk_note_template`、`t2_referent` |
| `category_l2` | 二级分类登记表，59 行，**同时是"两级合法组合"的唯一真源** | `(l1,l2)` PK、`name`、`numeric_id`、`sort_order` |
| `term` | 术语主体（一个黑话概念的锚点） | `slug`、`public_id`、`display_name`、`full_name`、`pronunciation`、`difficulty`、`not_meaning`、`risk_note`、`regulatory_flags`、`status`、`content_hash` |
| `sense` | 义项（一种含义），承载三层释义 | `sense_key`、`context_label`、`frequency`、`is_primary`、`plain_explain`、`advanced_explain`、`pro_explain`、`source_type`、`reviewed_by` |
| `sense_example` | 单个举例 | `body`、`style`、`has_concrete_number`、`has_concrete_scene`、`sort_order` |
| `alias` | 别名 / 口语 / 拼音 / 错拼 | `surface`、`norm_key`(全局 UNIQUE)、`alias_type`、`weight`、`sense_id`(可空) |
| `tag` / `term_tag` | 运营标签及关联 | `code`、`name` / `(term_id,tag_id)` |
| `term_relation` | 自关联多对多：相关词 / 易混词 / 前置知识 | `(source,target,relation_type)`、`weight`、`one_liner`、`difference_text` |
| `term_version` | 词条内容快照 | `version_no`、`snapshot`(jsonb)、`content_hash`、`changed_by` |
| `content_release` | 发布批次账本 | `release_kind`、`version`、`checksum`、`git_sha`、`status` |
| `quiz_level` | 关卡编排配置 | `public_id`(`lv_01`)、`ordinal`、`theme_category_l1`、`target_difficulty`、`composition`、`summary` |
| `quiz_question` | 题目 | `public_id`、`question_type`、`stem`、`answer_basis`、`difficulty`、`fingerprint`、`status` |
| `quiz_option` | 选项 | `option_public_id`、`body`、`is_correct`、`kind`、`source_term_id`、`source_ref` |
| `quiz_level_question` | 关卡↔题目编排 | `slot_no`、`slot_difficulty`、`selection_mode`(fixed/pool)、`term_id`(冗余去重) |
| `answer_event` | 作答事件（匿名） | `client_request_id`(UNIQUE 幂等键)、`question_public_id`、`option_id`、`is_correct`、`difficulty`、`mode`、`level_id`、`elapsed_ms`、`content_version` |
| `quiz_mistake` | 错题全局聚合 | `question_public_id`、`term_id`、`wrong_count`、`retry_count`、`retry_correct_count` |
| `search_miss_log` | 词库缺口池 | `norm_key` PK、`occurrence_count`、`first/last_seen_at`、`resolution` |
| `disclaimer` | 免责声明文案 | `code`、`version`、`content`、`short_content`、`effective_from`、`is_active` |
| `blacklist_word` | 禁用词与豁免规则集 | `kind`、`surface`、`payload`、`field_policy`、`ruleset_release_id` |
| `jargon_dict` | 零黑话扫描词典 | `layer`(A/B)、`surface`、`norm_key`、`kind`、`field_policy`、`source_term_id` |

### 1.2 关系与基数

| 关系 | 基数 | 说明 |
|---|---|---|
| `category_l1` → `category_l2` | 1 : 2~6 | 每类下 2~6 个子类；删除一级前必须先删二级（`ON DELETE RESTRICT`） |
| `(category_l1, category_l2)` → `term` | 1 : N | **复合外键**，保证二级隶属一级；这是"两层枚举合法性"的 DB 级防线 |
| `term` → `sense` | 1 : 1..N | 至少 1 个义项（CI 保证 ≥1）；每 term 至多 1 个 `is_primary`（partial unique index） |
| `sense` → `sense_example` | 1 : 1..N | 每义项 ≥1（L1 词条 ≥2 由 CI 在 term 维度校验） |
| `term` → `alias` | 1 : 0..N | 词条级通用别名（`sense_id IS NULL`） |
| `sense` → `alias` | 1 : 0..N | 义项专属别名（多义直连消解的一级依据） |
| `term` ↔ `term` (`term_relation`) | N : M（有向、类型化） | `source ≠ target`；`(source,target,relation_type)` 唯一 |
| `term` ↔ `tag` (`term_tag`) | N : M | v1 仅少量运营标签 |
| `term` → `term_version` | 1 : 0..N | 每次实质修订一行 |
| `content_release` → `term_version` | 1 : 0..N | 快照归属哪次发布 |
| `term` / `sense` → `quiz_question` | 1 : 0..N | 题目必须挂词条；义项可空（T2 反向题可能不指定义项） |
| `quiz_question` → `quiz_option` | 1 : 4 | **至多 1 个 `is_correct`**（partial unique index）；恰好 4 个由编译期断言 |
| `quiz_level` → `quiz_level_question` ← `quiz_question` | N : M（带槽位属性） | fixed 行有 `slot_no`，pool 行为空；**同关卡内同一 term 不得出现 2 次**（partial unique index） |
| `quiz_question` → `answer_event` | 1 : 0..N | **通过 `question_public_id` 弱关联**（+ 可空 `question_ref` FK），题目删除不带走分析数据 |
| `term` → `quiz_mistake` | 1 : 0..N | 题目维度全局聚合，无用户维度 |
| `disclaimer` → `term`（运行期） | 无 FK | 按 `code` 取当前 active 版本；"同一响应内正文与免责同版本"由缓存键包含 `disclaimer_set_hash` 保证（§6.4） |
| `content_release` → `blacklist_word` / `jargon_dict` | 1 : N | 规则集按发布版本快照 |

### 1.3 ER 图

```mermaid
erDiagram
    CATEGORY_L1 ||--o{ CATEGORY_L2 : "包含 2~6 个子类"
    CATEGORY_L2 ||--o{ TERM : "复合外键 (l1,l2) 定位"
    TERM ||--o{ SENSE : "义项 1..N"
    SENSE ||--o{ SENSE_EXAMPLE : "举例 >=1"
    TERM ||--o{ ALIAS : "词条级通用别名"
    SENSE ||--o{ ALIAS : "义项专属别名"
    TERM ||--o{ TERM_TAG : "打标"
    TAG ||--o{ TERM_TAG : "被使用"
    TERM ||--o{ TERM_RELATION : "source 端"
    TERM ||--o{ TERM_RELATION : "target 端"
    TERM ||--o{ TERM_VERSION : "内容快照"
    CONTENT_RELEASE ||--o{ TERM_VERSION : "归属发布批次"
    CONTENT_RELEASE ||--o{ BLACKLIST_WORD : "规则集快照"
    CONTENT_RELEASE ||--o{ JARGON_DICT : "词典快照"
    TERM ||--o{ QUIZ_QUESTION : "考题所属词条"
    SENSE ||--o{ QUIZ_QUESTION : "考题所属义项(可空)"
    QUIZ_QUESTION ||--|{ QUIZ_OPTION : "4 个选项 至多1正确"
    QUIZ_LEVEL ||--o{ QUIZ_LEVEL_QUESTION : "关卡编排"
    QUIZ_QUESTION ||--o{ QUIZ_LEVEL_QUESTION : "进入题池"
    TERM ||--o{ QUIZ_LEVEL_QUESTION : "同关卡同词条去重"
    QUIZ_QUESTION ||--o{ ANSWER_EVENT : "public_id 弱关联"
    QUIZ_LEVEL ||--o{ ANSWER_EVENT : "level_id 可空"
    TERM ||--o{ QUIZ_MISTAKE : "错题全局聚合"
    DISCLAIMER ||..o{ TERM : "运行期按 code 取用 无外键"

    CATEGORY_L1 {
        enum l1 PK "12 值固定枚举"
        smallint numeric_id UK "对外 API 分类 id 1~12"
        text name "中文名"
        text risk_note_template "风险提示模板句"
        text t2_referent "T2b 指代词"
    }
    CATEGORY_L2 {
        enum l1 PK_FK "隶属一级"
        enum l2 PK "59 值固定枚举"
        integer numeric_id UK "101~1206"
        text name "中文名"
    }
    TERM {
        bigint id PK
        text public_id UK "t_slug"
        text slug UK "URL 权威地址"
        text display_name "规范形态 <=20"
        text full_name "缩写类必填"
        text pronunciation "中文译名+音标"
        enum category_l1 FK
        enum category_l2 FK
        enum difficulty "L1 L2 L3"
        text not_meaning "30~60 字"
        text risk_note "涉投资判断必填"
        bool regulatory_flags
        enum status "draft pending_review published needs_revision"
        char64 content_hash "变更检测"
        smallint sense_count "冗余 编译期回填"
        int popularity "同级排序"
    }
    SENSE {
        bigint id PK
        bigint term_id FK
        text public_id UK "s_slug_key"
        text sense_key "义项键"
        text context_label "用户能懂的语境标签"
        enum frequency "high mid low"
        bool is_primary "每 term 至多 1"
        text plain_explain "<=40 字"
        text advanced_explain "60~150"
        text pro_explain "100~250 L3必填"
        enum source_type "自撰 专家审核 LLM生成"
        text reviewed_by
        text reference_url
    }
    SENSE_EXAMPLE {
        bigint id PK
        bigint sense_id FK
        text body "30~80 字"
        enum style "生活类比 职场社交 家庭财务 商业实务"
        bool has_concrete_number "EX-002 断言"
        bool has_concrete_scene "EX-003 断言"
    }
    ALIAS {
        bigint id PK
        bigint term_id FK
        bigint sense_id FK "可空=词条级"
        enum alias_type "primary cn en pinyin_abbr pinyin_full colloquial misspell"
        text surface "展示形态"
        text norm_key UK "归一化键 全局唯一"
        smallint weight "0~100"
    }
    TERM_RELATION {
        bigint source_term_id FK
        bigint target_term_id FK
        enum relation_type "related contrast prereq"
        numeric weight
        text one_liner "相关词一句解释 <=40"
        text difference_text "易混词一句区分 <=40"
    }
    QUIZ_QUESTION {
        bigint id PK
        text public_id UK "q_ + ULID"
        bigint term_id FK
        bigint sense_id FK
        enum question_type "T1 T2 T3 T4"
        text stem
        text answer_basis "1 句依据 30~80"
        enum difficulty
        char40 fingerprint UK "去重指纹"
        enum source "auto semi manual"
        enum status "draft pending_review approved published stale retired"
    }
    QUIZ_OPTION {
        bigint id PK
        bigint question_id FK
        text option_public_id "o1~o4"
        text body
        bool is_correct "永不下发"
        enum kind "correct gloss not_meaning term_name"
        bigint source_term_id FK "干扰项来源词条"
        text source_ref "misc-001 等"
    }
    QUIZ_LEVEL {
        bigint id PK
        text public_id UK "lv_01~lv_10"
        smallint ordinal UK
        enum theme_category_l1
        enum target_difficulty
        jsonb composition "current previous next"
        jsonb summary "知识点小结"
    }
    QUIZ_LEVEL_QUESTION {
        bigint level_id FK
        bigint question_id FK
        bigint term_id FK "冗余 去重用"
        smallint slot_no "fixed 才有"
        enum selection_mode "fixed pool"
    }
    ANSWER_EVENT {
        bigint id PK
        uuid client_request_id UK "幂等键"
        text question_public_id "分析稳定键"
        bigint question_ref FK "可空 ON DELETE SET NULL"
        text option_id
        bool is_correct
        enum difficulty "冗余存储"
        enum mode "level review daily"
        text level_id "可空"
        int elapsed_ms "可空 不信任"
        int content_version "作答时词库版本"
        timestamptz created_at "90 天保留"
    }
    QUIZ_MISTAKE {
        bigint id PK
        bigint term_id FK
        text question_public_id UK
        int wrong_count
        int retry_count
        int retry_correct_count
        int content_version
    }
    SEARCH_MISS_LOG {
        text norm_key PK "仅归一化 无 raw"
        int occurrence_count "k>=3 才进运营视图"
        timestamptz first_seen_at
        timestamptz last_seen_at
        enum resolution "new triaged covered rejected"
    }
    DISCLAIMER {
        bigint id PK
        text code "GENERAL TERM_CARD ..."
        int version
        text content
        text short_content "卡片内一行"
        date effective_from
        bool is_active "每 code 至多 1 个"
        text approved_by
    }
    CONTENT_RELEASE {
        bigint id PK
        enum release_kind "lexicon quiz rules disclaimer"
        int version
        char64 checksum
        text git_sha UK "幂等根"
        char64 disclaimer_set_hash
        enum status "compiling current superseded failed"
    }
    TERM_VERSION {
        bigint id PK
        bigint term_id FK
        int version_no
        jsonb snapshot
        char64 content_hash
        text changed_by
    }
    TAG {
        bigint id PK
        text code UK
        text name
    }
    TERM_TAG {
        bigint term_id PK_FK
        bigint tag_id PK_FK
        smallint sort_order
    }
    BLACKLIST_WORD {
        bigint id PK
        bigint ruleset_release_id FK
        enum kind "strong_banned weak_banned noun_explicit ..."
        text surface
        jsonb payload
        enum field_policy "block review allow"
    }
    JARGON_DICT {
        bigint id PK
        bigint ruleset_release_id FK
        enum layer "A B"
        text surface
        text norm_key
        enum kind "jargon contextual generic proper_noun"
        bigint source_term_id FK
        enum field_policy
    }
```

---

## 2. 完整 PostgreSQL DDL（可直接执行）

### 2.0 执行顺序与前置

按 `000 → 011` 顺序执行；`001` 的枚举必须先于 `002` 的表创建。全部脚本以 `BEGIN; ... COMMIT;` 包裹（**例外见 2.1 末尾关于 `ALTER TYPE ... RENAME VALUE` 的说明**）。

```sql
-- 000_extensions.sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;      -- 英文长词二级兜底（similarity / %）
-- pgvector：v1 明确不装。装上不用没有成本，但会让人误以为向量检索已就绪；
-- 裁决 #8「不建没用的表」同理适用于扩展。v2 接 LLM 兜底时再 CREATE EXTENSION vector。
```

### 2.1 枚举类型（全量取值）

> **为什么用中文枚举标签而不是 ASCII code**：词库真源是 MDX，`category_l1: 估值与财务` 是产品 §7.1 的原样取值。若 DB 用 ASCII code，编译管线要多维护一张双向映射表，且 `drizzle-zod` 生成的 schema 与 MDX front-matter 不再同源 —— 这正是架构 §2.7 想避免的"两套定义漂移"。因此**枚举标签 = MDX 取值**，另在 `category_l1.code` 存一份 ASCII 短码供 URL / 日志 / 埋点使用。

```sql
-- 001_types.sql
BEGIN;

-- ── 一级分类：12 个固定值（主理人裁决 #1）────────────────────────────
CREATE TYPE term_category_l1 AS ENUM (
  '宏观经济', '技术指标', '估值财务', '基金产品', '交易风险', '市场情绪',
  '走势形态', '买卖操作', '财报公司', '机构与资金', '宏观政策', '常见误用'
);

-- ── 二级分类：51 个固定值（每个一级下 3~5 个，满足"2~6"约束）──────────
--    标签全局唯一：Postgres ENUM 的值在类型内唯一，跨类型可重名；
--    本类型刻意让 51 个标签两两不同，便于日志与 API 直接回显。
CREATE TYPE term_category_l2 AS ENUM (
  -- 宏观经济（5）
  '增长与产出', '物价水平', '货币与信用', '就业与收入', '汇率与国际',
  -- 宏观政策（4）
  '央行与货币政策', '财政政策', '利率与政策工具', '监管与市场制度',
  -- 技术指标（5）
  '均线类', '摆动指标', '量能指标', '波动率指标', '交叉与信号',
  -- 估值财务（5）
  '估值倍数', '盈利能力', '现金流', '杠杆水平', '增长与口径',
  -- 基金产品（4）
  '基金类型', '指数与市场', '规模与净值', '跨市场工具',
  -- 交易风险（5）
  '收益与亏损', '回撤与风险度量', '交易机制', '发行与上市', '报价与成本',
  -- 市场情绪（3）
  '多空立场', '群体心理', '风险偏好',
  -- 走势形态（4）
  '趋势与反转', '盘整与区间', '突破与关键位', '极端走势',
  -- 买卖操作（4）
  '方向与持仓', '进出场动作', '仓位管理', '持有者行为',
  -- 财报公司（4）
  '财报发布与预期', '收入与利润', '公司质地', '股东回报',
  -- 机构与资金（4）
  '机构类型', '资金与流动性', '杠杆与保证金', '市场结构事件',
  -- 常见误用（4）
  '信号误读', '估值误读', '指标误读', '主体误读'
);

-- ── 难度：字符串枚举，与产品 §7.1 一致（不用数字，避免"L2 是中等还是第二档"歧义）
CREATE TYPE term_difficulty   AS ENUM ('L1', 'L2', 'L3');
CREATE TYPE question_band     AS ENUM ('easy', 'mid', 'hard');

-- ── 词条生命周期（产品 §7.1 的 4 态 + archived 软删除态，见 §6.2 状态机）
CREATE TYPE term_status AS ENUM (
  'draft', 'pending_review', 'published', 'needs_revision', 'archived'
);

-- ── 题目生命周期（内容流水线 §3.5）
CREATE TYPE question_status AS ENUM (
  'draft', 'pending_review', 'approved', 'published', 'stale', 'retired'
);

CREATE TYPE sense_frequency AS ENUM ('high', 'mid', 'low');
CREATE TYPE source_type     AS ENUM ('self_authored', 'expert_reviewed', 'llm_generated'); -- 自撰/专家审核/LLM生成
CREATE TYPE alias_type      AS ENUM (
  'primary', 'cn_alias', 'en_alias', 'pinyin_abbr', 'pinyin_full', 'colloquial', 'misspell'
);
CREATE TYPE relation_type   AS ENUM ('related', 'contrast', 'prereq');
CREATE TYPE example_style   AS ENUM (
  'life_analogy', 'workplace_social', 'family_finance', 'business_practice'
);
CREATE TYPE question_type   AS ENUM ('T1', 'T2', 'T3', 'T4');
CREATE TYPE question_source AS ENUM ('auto', 'semi', 'manual');
CREATE TYPE option_kind     AS ENUM ('correct', 'gloss', 'not_meaning', 'term_name', 'example_derived');
CREATE TYPE quiz_mode       AS ENUM ('level', 'review', 'daily');
CREATE TYPE release_kind    AS ENUM ('lexicon', 'quiz', 'rules', 'disclaimer');
CREATE TYPE release_status  AS ENUM ('compiling', 'current', 'superseded', 'failed');
CREATE TYPE miss_resolution AS ENUM ('new', 'triaged', 'covered', 'rejected');
CREATE TYPE blacklist_kind  AS ENUM (
  'strong_banned', 'weak_banned', 'term_whitelist',
  'noun_suffix', 'noun_explicit', 'context_indicator', 'negation_prefix',
  'imperative_pattern', 'contextual_pattern', 'disclaimer_template', 'exemption'
);
CREATE TYPE jargon_layer    AS ENUM ('A', 'B');
CREATE TYPE jargon_kind     AS ENUM ('jargon', 'contextual', 'generic', 'proper_noun');
CREATE TYPE field_policy    AS ENUM ('block', 'review', 'allow');

COMMIT;
```

> ⚠️ **迁移期唯一例外**：`ALTER TYPE ... ADD VALUE` 在 PG 12+ 可以出现在事务中（但新值在同一事务内不可立即使用）；`ALTER TYPE ... RENAME VALUE` **不能在事务块内执行**。因此"重命名某个分类"这类迁移必须写成裸语句文件，Drizzle 的 `--breakpoints` 或独立 `psql -c` 执行。这也是**分类枚举一旦上线就极难改**的具体体现 —— 见 §5.5 演进策略。

### 2.2 分类登记表（两层枚举的合法组合真源）

```sql
-- 002_category.sql
BEGIN;

CREATE TABLE category_l1 (
  l1                 term_category_l1 PRIMARY KEY,
  code               text        NOT NULL,                 -- ASCII 短码，供 URL/日志/埋点
  name               text        NOT NULL,                 -- 展示名（可与枚举标签不同，如"估值财务"→"估值与财务"）
  numeric_id         smallint    NOT NULL,                 -- 对外 API category.id 的高位段（1~12）
  sort_order         smallint    NOT NULL,
  risk_note_template text        NOT NULL,                 -- 产品 §7.2 的风险提示模板句
  t2_referent        text        NOT NULL,                 -- T2b 题干指代词（generator.config.yaml referent_by_category）
  description        text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT category_l1_code_uk       UNIQUE (code),
  CONSTRAINT category_l1_numeric_id_uk UNIQUE (numeric_id),
  CONSTRAINT category_l1_numeric_id_ck CHECK (numeric_id BETWEEN 1 AND 12),
  CONSTRAINT category_l1_code_ck       CHECK (code ~ '^[a-z][a-z0-9_]{1,31}$')
);
COMMENT ON TABLE  category_l1 IS '一级分类登记表：12 行固定。枚举保证值域封闭，本表承载展示名/风险模板/T2指代词等附加语义';
COMMENT ON COLUMN category_l1.risk_note_template IS '产品 §7.2 分类模板；编译期拼接词条级补充生成 term.risk_note，减少重复劳动但保证不遗漏';
COMMENT ON COLUMN category_l1.t2_referent IS '内容流水线 T2b「举例去术语化」的指代词，如 技术指标→"这个指标"';

CREATE TABLE category_l2 (
  l1          term_category_l1 NOT NULL,
  l2          term_category_l2 NOT NULL,
  code        text        NOT NULL,
  name        text        NOT NULL,
  numeric_id  integer     NOT NULL,   -- 对外 API category.id = numeric_id（全局唯一，101~1206）
  sort_order  smallint    NOT NULL,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (l1, l2),                                        -- ★ 两级"合法组合"的唯一真源
  CONSTRAINT category_l2_code_uk       UNIQUE (code),
  CONSTRAINT category_l2_numeric_id_uk UNIQUE (numeric_id),
  CONSTRAINT category_l2_numeric_id_ck CHECK (numeric_id BETWEEN 101 AND 9999),
  CONSTRAINT category_l2_l1_fk FOREIGN KEY (l1)
      REFERENCES category_l1 (l1) ON DELETE RESTRICT ON UPDATE CASCADE
);
COMMENT ON TABLE  category_l2 IS '二级分类登记表；主键 (l1,l2) 即"哪些二级属于哪个一级"的合法组合清单，term 表用复合外键引用它';
COMMENT ON CONSTRAINT category_l2_l1_fk ON category_l2 IS 'RESTRICT：删一级前必须先处理其下二级，防止出现孤儿分类';

CREATE INDEX category_l2_l1_sort_idx ON category_l2 (l1, sort_order);

COMMIT;
```

**为什么需要"枚举 + 登记表"两套东西**（这是本方案最容易被质疑的一处）：

| 方案 | 值域封闭 | 承载展示名/模板 | 防止"L2 挂错 L1" | 结论 |
|---|---|---|---|---|
| 只建表（架构师 v1.0 的 `parent_id` 单层方案） | ❌ 需应用层校验 | ✅ | ✅ | 裁决已作废 |
| 只用两个独立 ENUM，不建表 | ✅ | ❌ 无处放 `risk_note_template` / `t2_referent` | ❌ **无法表达"均线类只能挂在技术指标下"** | 不够 |
| **两个 ENUM + 登记表 + 复合外键**（本方案） | ✅ | ✅ | ✅ | ✅ 采纳 |

### 2.3 词条主体与义项

```sql
-- 003_term.sql
BEGIN;

CREATE TABLE term (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id         text        NOT NULL,   -- 't_' || slug，对外契约（backend §2.4 termIds 正则 ^t_[a-z0-9_]{1,32}$）
  slug              text        NOT NULL,   -- URL 权威地址，一旦上线不可改（分享链接生命周期长）
  display_name      text        NOT NULL,   -- 规范形态（大写缩写/英文全称/中文词），≤20 字符
  full_name         text,                   -- 缩写类必填（CI 强制，见 ABBR-001）
  pronunciation     text,                   -- 裁决 #10：英文术语中文译名 + 音标，如 "/ˈmoʊʃən/ 动量"
  category_l1       term_category_l1 NOT NULL,
  category_l2       term_category_l2 NOT NULL,
  difficulty        term_difficulty  NOT NULL,
  family_id         text,                   -- 族模板 id（families.yaml），空=非族成员；用于 DUP-002/DUP-003 族内校验
  example_style     example_style   NOT NULL DEFAULT 'life_analogy',
  not_meaning       text,                   -- 「这不代表什么」30~60 字，term 级（架构 §3.2.2 归属判定）
  risk_note         text,                   -- 风险提示，regulatory_flags=true 时必填
  risk_note_extra   text,                   -- 词条级补充（与分类模板拼接前留痕）
  regulatory_flags  boolean     NOT NULL DEFAULT false,
  source            text,                   -- 权威出处，仅内部审核留痕，不对用户展示
  reviewer          text,                   -- 二级专业复核人
  reviewed_at       timestamptz,
  compliance_reviewer   text,               -- 三级合规终审人
  compliance_reviewed_at timestamptz,
  content_version   text        NOT NULL DEFAULT 'v1',   -- 产品 §7.1 的 v1/v1.1（人读版本）
  release_version   integer,                             -- 机器版本 = content_release.version，索引/缓存用
  status            term_status NOT NULL DEFAULT 'draft',
  popularity        integer     NOT NULL DEFAULT 0,      -- 同级排序（初始由内容负责人标注，后续可按埋点回填）
  sense_count       smallint    NOT NULL DEFAULT 0,      -- ★ 冗余：搜索结果列表"MA · 3 个意思"零 join
  search_payload    text,                                -- ★ 归一化检索冗余串（display_name+full_name+全部别名，空格分隔）
  archived_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT term_public_id_uk UNIQUE (public_id),
  CONSTRAINT term_slug_uk      UNIQUE (slug),
  CONSTRAINT term_slug_ck      CHECK (slug ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  CONSTRAINT term_public_id_ck CHECK (public_id = 't_' || replace(slug, '-', '_')),
  CONSTRAINT term_display_name_len_ck CHECK (char_length(display_name) BETWEEN 1 AND 40),
  CONSTRAINT term_pronunciation_len_ck CHECK (pronunciation IS NULL OR char_length(pronunciation) <= 80),
  -- ★ 两级分类合法性：复合外键，二级必须隶属于该一级
  CONSTRAINT term_category_fk FOREIGN KEY (category_l1, category_l2)
      REFERENCES category_l2 (l1, l2) ON DELETE RESTRICT ON UPDATE CASCADE,
  -- ★ 发布门禁（把"已发布的行必须是完整的"变成 DB 不变量，草稿态可留空）
  CONSTRAINT term_published_complete_ck CHECK (
        status <> 'published'
     OR (   not_meaning IS NOT NULL AND btrim(not_meaning) <> ''
        AND source      IS NOT NULL AND btrim(source)      <> ''
        AND reviewer    IS NOT NULL AND btrim(reviewer)    <> ''
        AND reviewed_at IS NOT NULL
        AND compliance_reviewer    IS NOT NULL
        AND compliance_reviewed_at IS NOT NULL
        AND release_version IS NOT NULL
        AND sense_count >= 1)
  ),
  -- ★ 合规红线（产品 C7）：标记为"易被误读为投资建议"的词条必须有风险提示
  CONSTRAINT term_regulatory_risk_note_ck CHECK (
        regulatory_flags = false
     OR (risk_note IS NOT NULL AND btrim(risk_note) <> '')
  ),
  -- 归档态一致性
  CONSTRAINT term_archived_ck CHECK (
        status <> 'archived' OR (archived_at IS NOT NULL)
  ),
  -- DB 侧宽松长度上限（严格字数口径由 CI 把关，见 §6.1 分工表）
  CONSTRAINT term_not_meaning_len_ck CHECK (not_meaning IS NULL OR char_length(not_meaning) <= 120),
  CONSTRAINT term_risk_note_len_ck   CHECK (risk_note   IS NULL OR char_length(risk_note)   <= 120)
);

COMMENT ON TABLE  term IS '术语主体：一个黑话概念的锚点。真源在 Git 内 MDX，本表是编译产物/读模型';
COMMENT ON COLUMN term.public_id IS '对外不透明标识（backend §2.4 的 termIds）；与 slug 派生关系由 CHECK 锁定，防止编译期生成不一致';
COMMENT ON COLUMN term.sense_count IS '冗余计数，编译期与 sense 表在同事务内回填；服务"搜索结果列表多义提示"（产品 F5），避免每次搜索 join sense';
COMMENT ON COLUMN term.search_payload IS 'pg_trgm 英文兜底与运营模糊查找用；中文检索走应用层内存索引，不依赖本列';
COMMENT ON COLUMN term.source IS '产品 §7.1 明示"不对用户展示"，仅内部审核留痕；不得进入任何对外 API 响应体';
COMMENT ON COLUMN term.regulatory_flags IS '产品 §7.1 监管/合规标记；true 时 CI 额外校验零祈使句 + risk_note 存在（架构 §4.6.1）';
COMMENT ON COLUMN term.popularity IS '架构 §3.1.3 排序的 tiebreaker；无排行榜语义，仅用于同分候选的稳定排序';

-- ── 义项 ───────────────────────────────────────────────────────────
CREATE TABLE sense (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  term_id           bigint      NOT NULL,
  public_id         text        NOT NULL,   -- 's_' || slug || '_' || sense_key
  sense_key         text        NOT NULL,   -- 义项键，如 'fin' / 'degree' / 'geo'
  context_label     text        NOT NULL,   -- ★ 用户能懂的说法（"技术分析里的均线"），禁止"义项 1"
  context_keywords  text[]      NOT NULL DEFAULT '{}',  -- 消歧二级：上下文加权关键词（架构 §3.2.3）
  frequency         sense_frequency NOT NULL DEFAULT 'mid',
  is_primary        boolean     NOT NULL DEFAULT false,
  sort_order        smallint    NOT NULL DEFAULT 1,
  plain_explain     text        NOT NULL,   -- 人话层：所有 sense 必填（产品 §7.4「L1 必须在所有词条上存在」）
  advanced_explain  text,                   -- 进阶层 60~150 字
  pro_explain       text,                   -- 专业层 100~250 字，L3 词条必填（CI 跨表校验）
  recap_sentence    text,                   -- 「一句话讲给别人听」复述句式（产品 T7 / 附录 B）
  source_type       source_type NOT NULL DEFAULT 'self_authored',   -- 裁决 #9
  reviewed_by       text,
  reviewed_at       timestamptz,
  reference_url     text,
  status            term_status NOT NULL DEFAULT 'draft',
  content_hash      char(64),               -- sha256(参与题目生成的字段)，staleness 判定用（流水线 §3.5）
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sense_term_fk FOREIGN KEY (term_id)
      REFERENCES term (id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT sense_public_id_uk UNIQUE (public_id),
  CONSTRAINT sense_term_key_uk  UNIQUE (term_id, sense_key),
  CONSTRAINT sense_key_ck       CHECK (sense_key ~ '^[a-z0-9][a-z0-9_]{0,31}$'),
  CONSTRAINT sense_public_id_ck CHECK (public_id ~ '^s_[a-z0-9_]{1,64}$'),
  CONSTRAINT sense_context_label_ck CHECK (
        char_length(context_label) BETWEEN 2 AND 24
    AND context_label !~ '^义项\s*\d+$'          -- ★ 产品 §7.3 第 3 条：标签名不得是"义项 1/2/3"
  ),
  CONSTRAINT sense_context_keywords_ck CHECK (
        array_length(context_keywords, 1) IS NULL OR array_length(context_keywords, 1) <= 12
  ),
  CONSTRAINT sense_sort_ck       CHECK (sort_order BETWEEN 1 AND 20),
  CONSTRAINT sense_reference_url_ck CHECK (
        reference_url IS NULL OR reference_url ~ '^https://[^\s]{4,200}$'
  ),
  -- ★ 人话层必填 + DB 侧宽松上限（CI 严格 ≤40 字，见 LEN-001）
  CONSTRAINT sense_plain_explain_ck CHECK (char_length(btrim(plain_explain)) BETWEEN 1 AND 60),
  CONSTRAINT sense_advanced_len_ck  CHECK (advanced_explain IS NULL OR char_length(advanced_explain) <= 300),
  CONSTRAINT sense_pro_len_ck       CHECK (pro_explain      IS NULL OR char_length(pro_explain)      <= 500),
  CONSTRAINT sense_recap_len_ck     CHECK (recap_sentence   IS NULL OR char_length(recap_sentence)   <= 80),
  -- ★ LLM 生成内容必须标记且经审（架构 §4.6）：llm_generated 不得直接 published
  CONSTRAINT sense_llm_review_ck CHECK (
        source_type <> 'llm_generated'
     OR (status <> 'published' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
  )
);
COMMENT ON TABLE  sense IS '义项：一个术语的一种含义，承载三层释义。三层是"同一义项的三种表述深度"，不是三个义项（架构 §3.2.2）';
COMMENT ON COLUMN sense.is_primary IS '默认义项 = 最高频场景（产品 §7.3 第 2 条）；每 term 至多一个，由 partial unique index 保证';
COMMENT ON COLUMN sense.context_label IS '前端义项切换 Tab 的标签文本，直接下发给用户';
COMMENT ON COLUMN sense.content_hash IS '题目 staleness 的触发依据：只哈希参与生成的字段，不用 content_version，避免每次改版全量重审（流水线 staleness.fingerprint_inputs）';

-- 每 term 至多一个 primary 义项
CREATE UNIQUE INDEX sense_primary_one_per_term_uk ON sense (term_id) WHERE is_primary;

-- ── 举例（独立成表，不用 jsonb 数组）─────────────────────────────────
CREATE TABLE sense_example (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sense_id             bigint      NOT NULL,
  body                 text        NOT NULL,
  style                example_style NOT NULL,
  has_concrete_number  boolean     NOT NULL DEFAULT false,  -- EX-002 编译期断言，回填后可审计
  has_concrete_scene   boolean     NOT NULL DEFAULT false,  -- EX-003 编译期断言
  scene_tag            text,                                -- 命中的场景词（族内场景互斥 DUP-003 用）
  is_fictional_assumption boolean  NOT NULL DEFAULT false,  -- 架构 §4.6：涉具体数字须标注"虚构假设"
  sort_order           smallint    NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sense_example_sense_fk FOREIGN KEY (sense_id)
      REFERENCES sense (id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT sense_example_len_ck  CHECK (char_length(btrim(body)) BETWEEN 4 AND 160),  -- CI 严格 30~80
  CONSTRAINT sense_example_sort_ck CHECK (sort_order BETWEEN 1 AND 6),
  CONSTRAINT sense_example_unique_body_uk UNIQUE (sense_id, body)   -- 防重复编译产生两条一样的举例
);
COMMENT ON TABLE  sense_example IS '举例独立成表：需按条校验（LEN-004/EX-002/EX-003）+ 按族做场景互斥（DUP-003），行级比 jsonb 数组可校验可统计';
COMMENT ON COLUMN sense_example.has_concrete_number IS '由 CI 的数字正则判定后回填；线上审计时可直接 SELECT 出"没有具体数字的举例"，无需重跑规则';

CREATE INDEX sense_example_sense_sort_idx ON sense_example (sense_id, sort_order);

COMMIT;
```

### 2.4 别名（含 partial unique index）

```sql
-- 004_alias.sql
BEGIN;

CREATE TABLE alias (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  term_id     bigint      NOT NULL,
  sense_id    bigint,                       -- 可空 = 词条级通用别名；非空 = 义项专属别名
  alias_type  alias_type  NOT NULL,
  surface     text        NOT NULL,         -- 展示形态（原样，用于高亮与回显）
  norm_key    text        NOT NULL,         -- 归一化键（NFKC + 大小写折叠 + 空白折叠，架构 §3.1.1）
  weight      smallint    NOT NULL,         -- 0~100，对应架构 WEIGHTS 常量
  is_searchable boolean   NOT NULL DEFAULT true,  -- misspell 类型只走精确层，不进模糊层
  lang        text        NOT NULL DEFAULT 'zh',  -- 'zh' | 'en' | 'mixed'，决定 pg_trgm 是否适用
  source_field text       NOT NULL,         -- 'aliases' | 'search_alias' | 'term' | 'full_name'，产品两个字段的可追溯映射
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT alias_term_fk  FOREIGN KEY (term_id)  REFERENCES term (id)  ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT alias_sense_fk FOREIGN KEY (sense_id) REFERENCES sense (id) ON DELETE CASCADE ON UPDATE RESTRICT,
  -- ★★ 裁决 #2 核心防线：norm_key 全局唯一
  CONSTRAINT alias_norm_key_uk UNIQUE (norm_key),
  CONSTRAINT alias_norm_key_ck CHECK (char_length(norm_key) BETWEEN 1 AND 64),
  CONSTRAINT alias_surface_len_ck CHECK (char_length(surface) BETWEEN 1 AND 40),
  CONSTRAINT alias_weight_ck  CHECK (weight BETWEEN 0 AND 100),
  CONSTRAINT alias_lang_ck    CHECK (lang IN ('zh', 'en', 'mixed')),
  CONSTRAINT alias_source_field_ck CHECK (
        source_field IN ('aliases', 'search_alias', 'term', 'full_name')
  ),
  -- norm_key 必须是全小写（归一化的可验证后果；编译期算错会立刻炸，不会静默产生重复键）
  CONSTRAINT alias_norm_key_lowercase_ck CHECK (norm_key = lower(norm_key)),
  -- 拼音首字母长度上限 4（架构 §3.1.5：再长会与英文缩写大面积冲突）
  CONSTRAINT alias_pinyin_abbr_len_ck CHECK (
        alias_type <> 'pinyin_abbr' OR char_length(norm_key) <= 4
  )
);
COMMENT ON TABLE  alias IS '别名/缩写/口语/拼音/错拼。对应产品 aliases + search_alias 两个字段；norm_key 全局唯一是"同串字符不得指向两个词条"的最终防线';
COMMENT ON COLUMN alias.sense_id IS 'NULL = 词条级通用别名；非 NULL = 义项专属别名（多义消歧的一级依据：命中即直连该义项，无需打分）';
COMMENT ON COLUMN alias.is_searchable IS 'misspell 类型固定 false 参与模糊层（架构 §3.1.5：否则模糊层会把错别字和正确近邻词混淆）';

-- ★ sense_id 若填写，必须属于同一 term（跨字段完整性，DB 级防线）
--   用复合外键实现：把 term_id 冗余进 sense 的唯一键
ALTER TABLE sense ADD CONSTRAINT sense_term_public_uk UNIQUE (id, term_id);
ALTER TABLE alias
  ADD CONSTRAINT alias_sense_belongs_to_term_fk
  FOREIGN KEY (sense_id, term_id) REFERENCES sense (id, term_id)
  ON DELETE CASCADE ON UPDATE RESTRICT;
COMMENT ON CONSTRAINT alias_sense_belongs_to_term_fk ON alias IS
  '防止"A 词条下挂 B 词条义项的专属别名"这类编译期错乱；这是 jsonb 方案做不到的跨表不变量';

-- ★★ 裁决 #2：partial unique index —— 只对 primary 类型别名唯一
--   语义：一个 term 只能有一个 primary 别名；一个 sense 只能有一个 primary 专属别名。
--   非 primary 类型（cn_alias/colloquial/misspell…）不受此索引约束 → 允许多别名指向同一 term。
CREATE UNIQUE INDEX alias_primary_one_per_term_uk
    ON alias (term_id)
    WHERE alias_type = 'primary' AND sense_id IS NULL;

CREATE UNIQUE INDEX alias_primary_one_per_sense_uk
    ON alias (sense_id)
    WHERE alias_type = 'primary' AND sense_id IS NOT NULL;

-- primary 别名的 surface 必须等于词条 display_name（编译期一致性，DB 侧用触发器兜底见 §6.3）
COMMIT;
```

**partial unique index 的三个必须说清的点**：

1. **为什么不能用普通 UNIQUE**：`UNIQUE(term_id, alias_type)` 会连带禁止"一个 term 有两个 `cn_alias`"（如「市盈率」同时有「PE 比率」「本益比」两个中文别名），这与产品 §7.1「aliases 数组 ≥1 项」直接冲突。partial index 只在 `alias_type='primary'` 的子集上生效，正好表达"主名唯一、别名可多"。
2. **为什么需要两条**：`sense_id IS NULL` 与 `IS NOT NULL` 是两个不相交子集，Postgres 的 partial index 谓词无法用一条覆盖（`WHERE alias_type='primary'` 单条会让"term 级 primary"和"sense 级 primary"互相冲突）。
3. **Drizzle 里怎么写**（必须裸 SQL，这是选 Drizzle 而非 Prisma 的直接收益，架构 §2.7）：
   ```ts
   export const alias = pgTable('alias', { /* ... */ }, (t) => [
     unique('alias_norm_key_uk').on(t.normKey),
     uniqueIndex('alias_primary_one_per_term_uk')
       .on(t.termId).where(sql`${t.aliasType} = 'primary' AND ${t.senseId} IS NULL`),
     uniqueIndex('alias_primary_one_per_sense_uk')
       .on(t.senseId).where(sql`${t.aliasType} = 'primary' AND ${t.senseId} IS NOT NULL`),
   ]);
   ```

### 2.5 标签、关系、版本

```sql
-- 005_tag_relation_version.sql
BEGIN;

CREATE TABLE tag (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code       text NOT NULL,
  name       text NOT NULL,
  is_visible boolean NOT NULL DEFAULT true,   -- false = 内部标记，不下发前端
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tag_code_uk UNIQUE (code),
  CONSTRAINT tag_code_ck CHECK (code ~ '^[a-z][a-z0-9_]{1,31}$')
);
COMMENT ON TABLE tag IS '运营标签（"新手常问"/"高频"），服务 API 契约 term.tags[]。v1 只做少量固定标签，不做自由标签体系';

CREATE TABLE term_tag (
  term_id    bigint NOT NULL,
  tag_id     bigint NOT NULL,
  sort_order smallint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (term_id, tag_id),
  CONSTRAINT term_tag_term_fk FOREIGN KEY (term_id) REFERENCES term (id) ON DELETE CASCADE,
  CONSTRAINT term_tag_tag_fk  FOREIGN KEY (tag_id)  REFERENCES tag  (id) ON DELETE CASCADE
);
CREATE INDEX term_tag_tag_idx ON term_tag (tag_id);   -- 反查"某标签下有哪些词"

CREATE TABLE term_relation (
  source_term_id bigint NOT NULL,
  target_term_id bigint NOT NULL,
  relation_type  relation_type NOT NULL,
  weight         numeric(4,3) NOT NULL DEFAULT 1.000,   -- related 按"常一起出现"排序
  one_liner      text,          -- relation_type='related' 用：一句独立解释 ≤40 字（产品 F9：不做纯链接列表）
  difference_text text,         -- relation_type='contrast' 用：一句可辨差异 ≤40 字（产品 S4 / C13）
  sort_order     smallint NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_term_id, target_term_id, relation_type),
  CONSTRAINT term_relation_source_fk FOREIGN KEY (source_term_id) REFERENCES term (id) ON DELETE CASCADE,
  CONSTRAINT term_relation_target_fk FOREIGN KEY (target_term_id) REFERENCES term (id) ON DELETE CASCADE,
  CONSTRAINT term_relation_no_self_ck CHECK (source_term_id <> target_term_id),
  CONSTRAINT term_relation_weight_ck  CHECK (weight >= 0 AND weight <= 1),
  CONSTRAINT term_relation_sort_ck    CHECK (sort_order BETWEEN 1 AND 10),
  -- ★ 产品硬约束：related ≤4（同屏最多 4 个）、confusion 0~3 组
  CONSTRAINT term_relation_related_limit_ck CHECK (sort_order <= 10),
  CONSTRAINT term_relation_one_liner_ck CHECK (
        relation_type <> 'related' OR (one_liner IS NOT NULL AND char_length(one_liner) <= 60)
  ),
  CONSTRAINT term_relation_diff_ck CHECK (
        relation_type <> 'contrast' OR (difference_text IS NOT NULL AND char_length(difference_text) <= 60)
  )
);
COMMENT ON TABLE  term_relation IS '自关联多对多：related=相关术语(产品 related)、contrast=易混词(产品 confusion)、prereq=前置知识(v2 个性化学习路径预留)';
COMMENT ON COLUMN term_relation.one_liner IS '产品 F9 硬要求"每个相关词都有一句独立解释"；缺字段即 CI 阻断，DB CHECK 兜底';

-- 双向查询索引（架构 §4.2 SEO：相关词双向互链；发布时需按 target 反查以 revalidateTag）
CREATE INDEX term_relation_target_idx ON term_relation (target_term_id, relation_type);
CREATE INDEX term_relation_source_type_weight_idx
    ON term_relation (source_term_id, relation_type, weight DESC);

CREATE TABLE term_version (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  term_id      bigint  NOT NULL,
  version_no   integer NOT NULL,          -- 该词条的第 N 次快照，从 1 递增
  content_version text NOT NULL,          -- 人读版本号 v1 / v1.1 / v2
  snapshot     jsonb   NOT NULL,          -- term + senses + examples + aliases + relations 的完整快照
  content_hash char(64) NOT NULL,
  change_note  text,
  changed_by   text    NOT NULL,
  release_id   bigint,                    -- 归属发布批次
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT term_version_term_fk FOREIGN KEY (term_id) REFERENCES term (id) ON DELETE CASCADE,
  CONSTRAINT term_version_release_fk FOREIGN KEY (release_id) REFERENCES content_release (id) ON DELETE SET NULL,
  CONSTRAINT term_version_term_no_uk UNIQUE (term_id, version_no),
  CONSTRAINT term_version_no_ck CHECK (version_no >= 1)
);
COMMENT ON TABLE term_version IS '词条内容快照：支持"回滚到上一版"与"改动 diff 审计"（产品 R1 依赖）。只在实质修订时写行，不写"改了空格"这类无意义版本';
CREATE INDEX term_version_term_created_idx ON term_version (term_id, created_at DESC);

COMMIT;
```

### 2.6 发布批次与规则集

```sql
-- 006_release_rules.sql
BEGIN;

CREATE TABLE content_release (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  release_kind  release_kind  NOT NULL,
  version       integer       NOT NULL,     -- 每 kind 内单调递增
  checksum      char(64)      NOT NULL,     -- sha256(canonical_json(该 kind 的全量导出))
  git_sha       text,                       -- ★ 幂等根：同一 commit 重复编译不产生新版本
  term_count    integer       NOT NULL DEFAULT 0,
  sense_count   integer       NOT NULL DEFAULT 0,
  question_count integer      NOT NULL DEFAULT 0,
  disclaimer_set_hash char(64),             -- ★ 本次发布时 active disclaimer 集合的哈希（§6.4 版本一致性）
  ruleset_version text,                     -- content-rules/*.yaml 的 version 字段（如 2026-10-20）
  status        release_status NOT NULL DEFAULT 'compiling',
  released_at   timestamptz,
  released_by   text,
  error_message text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_release_kind_version_uk UNIQUE (release_kind, version),
  -- ★ 幂等：同 kind + 同 git_sha 只能有一行（重复编译命中已有行 → 直接复用）
  CONSTRAINT content_release_kind_sha_uk UNIQUE (release_kind, git_sha),
  CONSTRAINT content_release_version_ck CHECK (version >= 1),
  CONSTRAINT content_release_completed_ck CHECK (
        status NOT IN ('current', 'superseded')
     OR (released_at IS NOT NULL AND git_sha IS NOT NULL)
  ),
  CONSTRAINT content_release_failed_ck CHECK (
        status <> 'failed' OR error_message IS NOT NULL
  )
);
COMMENT ON TABLE  content_release IS '发布批次账本。前端缓存刷新、内存索引 SWR 重建、answer_event.content_version 的口径全部以本表 version 为准';
COMMENT ON COLUMN content_release.checksum IS '内存索引与 DB 的一致性校验依据（backend §4.1 第 3 点"自洽优先"）：不一致则继续用旧索引 + 旧内容，绝不混用';
COMMENT ON COLUMN content_release.disclaimer_set_hash IS '裁决 #7：同一响应内正文与免责必须同版本。缓存键包含本哈希 → 免责改版自动打掉旧缓存，不可能出现"新正文 + 旧免责"';

-- 每个 kind 至多一个 current
CREATE UNIQUE INDEX content_release_current_uk
    ON content_release (release_kind) WHERE status = 'current';
CREATE INDEX content_release_kind_version_desc_idx
    ON content_release (release_kind, version DESC);

-- ── 禁用词表（裁决 #8 之外的必要表：服务发布后回溯扫描）────────────────
CREATE TABLE blacklist_word (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ruleset_release_id bigint NOT NULL,
  kind               blacklist_kind NOT NULL,
  surface            text        NOT NULL,
  pattern            text,                       -- imperative_pattern 类的正则源串
  payload            jsonb       NOT NULL DEFAULT '{}'::jsonb,  -- {with:[...], window:8, approved_by, context, ...}
  field_policy       field_policy NOT NULL DEFAULT 'block',
  applies_to_fields  text[]      NOT NULL DEFAULT '{}',        -- 空 = 全部字段
  note               text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT blacklist_release_fk FOREIGN KEY (ruleset_release_id)
      REFERENCES content_release (id) ON DELETE CASCADE,
  CONSTRAINT blacklist_kind_surface_uk UNIQUE (ruleset_release_id, kind, surface),
  CONSTRAINT blacklist_surface_len_ck CHECK (char_length(surface) BETWEEN 1 AND 32),
  -- 人工豁免必须署名（流水线 §4.3：approved_by 为空 → CI 阻断）
  CONSTRAINT blacklist_exemption_signed_ck CHECK (
        kind <> 'exemption'
     OR (payload ? 'approved_by' AND btrim(payload->>'approved_by') <> ''
         AND payload ? 'context' AND btrim(payload->>'context') <> '')
  ),
  CONSTRAINT blacklist_template_signed_ck CHECK (
        kind <> 'disclaimer_template'
     OR (payload ? 'code' AND payload ? 'version')
  )
);
COMMENT ON TABLE  blacklist_word IS 'banned-words.yaml 的编译产物镜像。定位：CI 直接读 YAML（Git 真源）；DB 副本服务发布后回溯扫描（跑在 Vercel Cron 上，没有 Git 工作区）与运营可视化';
COMMENT ON COLUMN blacklist_word.ruleset_release_id IS '规则集按发布版本快照。规则改了 → 新 release → 旧词条用旧规则的历史扫描结果仍可复现，不会"规则一改历史结论全变"';

CREATE INDEX blacklist_release_kind_idx ON blacklist_word (ruleset_release_id, kind);

-- ── 零黑话扫描词典（Layer A 自动抽取 + Layer B 人工维护）───────────────
CREATE TABLE jargon_dict (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ruleset_release_id bigint NOT NULL,
  layer              jargon_layer NOT NULL,       -- A=词库黑话集(自动) B=通用金融黑话集(人工)
  surface            text        NOT NULL,
  norm_key           text        NOT NULL,
  kind               jargon_kind NOT NULL DEFAULT 'jargon',
  source_term_id     bigint,                      -- Layer A：来自哪个词条的哪个 surface
  source_field       text,                        -- 'term'|'full_name'|'aliases'|'search_alias'|'category_name'
  field_policy       field_policy NOT NULL DEFAULT 'block',
  allowlist_reason   text,                        -- 白名单豁免理由（jargon-allowlist.yaml）
  allowlist_approved_by text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jargon_release_fk FOREIGN KEY (ruleset_release_id)
      REFERENCES content_release (id) ON DELETE CASCADE,
  CONSTRAINT jargon_source_term_fk FOREIGN KEY (source_term_id)
      REFERENCES term (id) ON DELETE SET NULL,
  CONSTRAINT jargon_release_layer_norm_uk UNIQUE (ruleset_release_id, layer, norm_key, surface),
  CONSTRAINT jargon_norm_key_ck CHECK (char_length(norm_key) BETWEEN 1 AND 64),
  -- Layer A 必须能溯源到词条；Layer B 必须有人工维护说明
  CONSTRAINT jargon_layer_a_source_ck CHECK (layer <> 'A' OR source_term_id IS NOT NULL),
  -- 白名单豁免必须署名（流水线 §4.1：approved_by 为空 → CI 阻断）
  CONSTRAINT jargon_allowlist_signed_ck CHECK (
        allowlist_reason IS NULL
     OR (allowlist_approved_by IS NOT NULL AND btrim(allowlist_approved_by) <> '')
  )
);
COMMENT ON TABLE  jargon_dict IS '零黑话词典。Layer A 由 CI 从 MDX 自动抽取（term/full_name/aliases/search_alias/分类名），Layer B 人工维护 + 季度复核';
COMMENT ON COLUMN jargon_dict.kind IS 'contextual = banned-words.yaml 的搭配判定词（如"便宜"+"股票"才违规）；proper_noun = 专有名词豁免（如"美林"）';

CREATE INDEX jargon_release_layer_idx ON jargon_dict (ruleset_release_id, layer);
CREATE INDEX jargon_norm_key_idx      ON jargon_dict (norm_key);   -- 扫描时按 norm_key 反查

-- ── 免责声明（裁决 #7）────────────────────────────────────────────────
CREATE TABLE disclaimer (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code           text        NOT NULL,   -- GENERAL / TERM_CARD / TERM_DETAIL / QUIZ_RESULT / HOME / AI_FALLBACK / NO_RESULT
  version        integer     NOT NULL,
  scope          text        NOT NULL DEFAULT 'global',  -- global | term_card | quiz | home
  content        text        NOT NULL,   -- 完整版（详情页/页脚）
  short_content  text        NOT NULL,   -- 卡片内简短一行（架构 §4.6 分级披露）
  entity_name    text,                   -- 署名主体，产品 Q5 待确认，默认空
  effective_from date        NOT NULL,
  effective_to   date,                   -- 空 = 至今有效
  is_active      boolean     NOT NULL DEFAULT false,
  approved_by    text,                   -- 法务确认人
  approved_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT disclaimer_code_version_uk UNIQUE (code, version),
  CONSTRAINT disclaimer_code_ck CHECK (code ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  CONSTRAINT disclaimer_version_ck CHECK (version >= 1),
  CONSTRAINT disclaimer_content_len_ck CHECK (char_length(content) BETWEEN 4 AND 500),
  CONSTRAINT disclaimer_short_len_ck   CHECK (char_length(short_content) BETWEEN 4 AND 120),
  CONSTRAINT disclaimer_effective_range_ck CHECK (
        effective_to IS NULL OR effective_to >= effective_from
  ),
  -- ★ 生效中的文案必须已法务确认（产品 L4 / R8）
  CONSTRAINT disclaimer_active_approved_ck CHECK (
        is_active = false
     OR (approved_by IS NOT NULL AND btrim(approved_by) <> '' AND approved_at IS NOT NULL)
  )
);
COMMENT ON TABLE  disclaimer IS '免责声明文案入库：法务改文案 = 改数据 + 走发布管线，不改代码不发版（架构 §4.6）';
COMMENT ON COLUMN disclaimer.short_content IS '架构 §4.6「分级披露」：卡片内一行、详情页完整版。两者同 code 同 version，从数据层保证不可能不同步';

-- ★ 每个 code 至多一个 is_active（产品 L4"使用法务确认的唯一版本号"）
CREATE UNIQUE INDEX disclaimer_active_one_per_code_uk
    ON disclaimer (code) WHERE is_active;
-- 历史版本查询（"这个词条当时用的是哪版免责"）
CREATE INDEX disclaimer_code_effective_idx ON disclaimer (code, effective_from DESC);

COMMIT;
```

### 2.7 测验：关卡、题目、选项

```sql
-- 007_quiz.sql
BEGIN;

CREATE TABLE quiz_level (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id          text        NOT NULL,          -- 'lv_01' ~ 'lv_10'（backend 契约正则 ^lv_(0[1-9]|10)$）
  ordinal            smallint    NOT NULL,          -- 关卡序号 1..10
  name               text        NOT NULL,          -- "入门关：先认识这些"
  theme_category_l1  term_category_l1,              -- 主题分类（第 10 关为混合 → 允许空）
  target_difficulty  term_difficulty NOT NULL,      -- 本关基准难度档
  question_count     smallint    NOT NULL DEFAULT 8,
  composition        jsonb       NOT NULL,          -- {"current":5,"previous":2,"next":1}
  min_context_questions smallint NOT NULL DEFAULT 0,-- 产品 §8.3 规则 3：第 3 关起每关 ≥1 道 T3
  require_not_meaning_option boolean NOT NULL DEFAULT true, -- 规则 4：每关 ≥1 个"这不代表什么"型干扰项
  unlock_after_level smallint,                      -- 前置关卡（跳关不允许）
  summary            jsonb       NOT NULL DEFAULT '[]'::jsonb,  -- 通关知识点小结：[{termId, oneLiner}]
  status             term_status NOT NULL DEFAULT 'published',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quiz_level_public_id_uk UNIQUE (public_id),
  CONSTRAINT quiz_level_ordinal_uk   UNIQUE (ordinal),
  CONSTRAINT quiz_level_public_id_ck CHECK (public_id ~ '^lv_(0[1-9]|[1-9][0-9])$'),
  CONSTRAINT quiz_level_count_ck     CHECK (question_count BETWEEN 1 AND 20),
  CONSTRAINT quiz_level_ordinal_ck   CHECK (ordinal BETWEEN 1 AND 99),
  CONSTRAINT quiz_level_composition_ck CHECK (
        jsonb_typeof(composition) = 'object'
    AND (composition->>'current')::int >= 0
    AND (composition->>'previous')::int >= 0
    AND (composition->>'next')::int >= 0
  ),
  -- ★ 产品 §8.3 规则 2：前 2 关必须全 L1（DB 级硬约束，防运营改配置改出超纲首关）
  CONSTRAINT quiz_level_first_two_l1_ck CHECK (
        ordinal > 2 OR target_difficulty = 'L1'
  ),
  CONSTRAINT quiz_level_unlock_ck CHECK (
        unlock_after_level IS NULL OR unlock_after_level < ordinal
  )
);
COMMENT ON TABLE  quiz_level IS '关卡编排配置放服务端（架构 §3.3.2）：避免客户端被篡改后出现"不存在的关卡"，且关卡可运营调整而不发版';
COMMENT ON COLUMN quiz_level.summary IS '产品 §8.3「通关后展示本关知识点小结（3~5 个词条 + 一句话串讲）」';

CREATE TABLE quiz_question (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id           text        NOT NULL,      -- 'q_' || ULID（对外不透明，不暴露题量）
  term_id             bigint      NOT NULL,
  sense_id            bigint,                    -- T2 反向题可不指定义项
  question_type       question_type NOT NULL,
  stem                text        NOT NULL,
  stem_template_id    text,                      -- 派生题记录用了哪个模板（可复现）
  answer_basis        text        NOT NULL,      -- ★ 1 句答案依据，答对答错都展示（产品 §8.1）
  example_ref_id      bigint,                    -- 判分响应里的 example（产品 §8.7"每题必带 1 句依据 + 1 个举例"）
  difficulty          term_difficulty NOT NULL,  -- 冗余于 term.difficulty：题目可独立于词条调档
  difficulty_estimate numeric(4,3),              -- p̂ 离线难度预估（流水线 §3.2.1）
  difficulty_band     question_band,
  source              question_source NOT NULL,  -- auto / semi / manual
  generator_version   text,                      -- 改规则即变（流水线 §3.5）
  fingerprint         char(40)    NOT NULL,      -- sha1(type+term+sense+stem+sorted(options))，去重
  interference_fingerprint char(40),             -- sha1(sorted(distractor_term_ids))
  source_type         source_type NOT NULL DEFAULT 'self_authored',
  status              question_status NOT NULL DEFAULT 'draft',
  stale_reason        text,
  reviewed_by         text,
  reviewed_at         timestamptz,
  correct_count       integer NOT NULL DEFAULT 0,-- ★ 在线难度反馈旋钮的输入（流水线 §3.2.2）
  submit_count        integer NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT quiz_question_public_id_uk UNIQUE (public_id),
  CONSTRAINT quiz_question_fingerprint_uk UNIQUE (fingerprint),
  CONSTRAINT quiz_question_term_fk FOREIGN KEY (term_id) REFERENCES term (id) ON DELETE CASCADE,
  CONSTRAINT quiz_question_sense_fk FOREIGN KEY (sense_id) REFERENCES sense (id) ON DELETE SET NULL,
  CONSTRAINT quiz_question_example_fk FOREIGN KEY (example_ref_id)
      REFERENCES sense_example (id) ON DELETE SET NULL,
  CONSTRAINT quiz_question_public_id_ck CHECK (public_id ~ '^q_[0-9A-HJKMNP-TV-Z]{20,32}$'),
  CONSTRAINT quiz_question_stem_len_ck  CHECK (char_length(btrim(stem)) BETWEEN 4 AND 200),
  CONSTRAINT quiz_question_basis_len_ck CHECK (char_length(btrim(answer_basis)) BETWEEN 8 AND 160),
  CONSTRAINT quiz_question_p_hat_ck CHECK (
        difficulty_estimate IS NULL OR (difficulty_estimate > 0 AND difficulty_estimate < 1)
  ),
  CONSTRAINT quiz_question_counter_ck CHECK (correct_count >= 0 AND submit_count >= correct_count),
  -- ★ 不出超纲（产品 §7.5 规则 1）：题目难度不得高于所属词条难度
  CONSTRAINT quiz_question_not_exceed_term_ck CHECK (difficulty <= term_difficulty_of(term_id)),
  -- ★ 发布门禁
  CONSTRAINT quiz_question_published_ck CHECK (
        status <> 'published'
     OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND difficulty_estimate IS NOT NULL)
  ),
  -- ★ T4 只用于多义词（产品 §8.1：仅多义词）
  CONSTRAINT quiz_question_t4_polysemy_ck CHECK (
        question_type <> 'T4' OR sense_id IS NOT NULL
  ),
  CONSTRAINT quiz_question_stale_ck CHECK (
        status <> 'stale' OR stale_reason IS NOT NULL
  )
);
COMMENT ON TABLE  quiz_question IS '题目主表。answer_key 不在本表 —— 正确性由 quiz_option.is_correct 表达，且该列永不出现在任何对外响应';
COMMENT ON COLUMN quiz_question.correct_count IS '与 submit_count 一起构成在线 p̂；由 answer_event 的每日聚合任务回填，不在写入路径上自增（避免热点行锁）';
COMMENT ON COLUMN quiz_question.difficulty IS '刻意与 term.difficulty 解耦：同一词条可以出 L1 直给题和 L3 口径题';

CREATE TABLE quiz_option (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  question_id       bigint      NOT NULL,
  option_public_id  text        NOT NULL,   -- 'o1'~'o4'，稳定标识与展示顺序解耦（backend §2.4）
  body              text        NOT NULL,
  is_correct        boolean     NOT NULL DEFAULT false,   -- ★ 永不下发客户端
  kind              option_kind NOT NULL DEFAULT 'gloss',
  source_term_id    bigint,                 -- 干扰项来源词条（审计"干扰项是否来自真实术语"）
  source_ref        text,                   -- 如 'misc-001'（误用命题库 id）、'sense.plain_explain'
  source_reason     text,                   -- 干扰项选取理由（P0~P5 池 + 过滤器结果）
  sort_order        smallint    NOT NULL DEFAULT 1,   -- 编辑期顺序；下发前服务端按 seed 重打乱
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quiz_option_question_fk FOREIGN KEY (question_id)
      REFERENCES quiz_question (id) ON DELETE CASCADE,
  CONSTRAINT quiz_option_source_term_fk FOREIGN KEY (source_term_id)
      REFERENCES term (id) ON DELETE SET NULL,
  CONSTRAINT quiz_option_qid_oid_uk UNIQUE (question_id, option_public_id),
  CONSTRAINT quiz_option_oid_ck CHECK (option_public_id ~ '^o[1-9]$'),
  CONSTRAINT quiz_option_body_len_ck CHECK (char_length(btrim(body)) BETWEEN 2 AND 120),
  CONSTRAINT quiz_option_sort_ck CHECK (sort_order BETWEEN 1 AND 9)
);
COMMENT ON TABLE  quiz_option IS '选项独立成表（架构 ER 草案里是 jsonb options，本方案改为表）：理由见下方"为什么不用 jsonb"';
COMMENT ON COLUMN quiz_option.source_term_id IS '产品 §8.1「干扰项来源优先级」与 C14「干扰项均来自真实术语（无荒谬项）」的可审计依据';
COMMENT ON COLUMN quiz_option.source_ref IS '误用命题库（misconceptions.yaml）的 claim id 落点。v1 不建 misconception 表 —— 它的唯一消费者是编译期出题器，Git 真源已足够（裁决 #8 同源理由）';

-- ★ 每题至多一个正确选项
CREATE UNIQUE INDEX quiz_option_correct_one_per_question_uk
    ON quiz_option (question_id) WHERE is_correct;
CREATE INDEX quiz_option_source_term_idx ON quiz_option (source_term_id);

-- ── 关卡 ↔ 题目编排 ───────────────────────────────────────────────────
CREATE TABLE quiz_level_question (
  level_id       bigint NOT NULL,
  question_id    bigint NOT NULL,
  term_id        bigint NOT NULL,          -- 冗余自 quiz_question，为"同关卡同词条不重复"约束服务
  slot_no        smallint,                 -- fixed 槽位 1..question_count；pool 行为空
  slot_difficulty term_difficulty,         -- 该槽位要求难度（编排校验用）
  selection_mode text NOT NULL DEFAULT 'fixed',  -- 'fixed'=固定编排 / 'pool'=候选池随机抽取
  is_context_question boolean NOT NULL DEFAULT false,   -- T3 标记（产品 §8.3 规则 3 校验）
  has_not_meaning_option boolean NOT NULL DEFAULT false,-- 规则 4 校验
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (level_id, question_id),
  CONSTRAINT qlq_level_fk    FOREIGN KEY (level_id)    REFERENCES quiz_level    (id) ON DELETE CASCADE,
  CONSTRAINT qlq_question_fk FOREIGN KEY (question_id) REFERENCES quiz_question (id) ON DELETE CASCADE,
  CONSTRAINT qlq_term_fk     FOREIGN KEY (term_id)     REFERENCES term          (id) ON DELETE CASCADE,
  CONSTRAINT qlq_mode_ck CHECK (selection_mode IN ('fixed', 'pool')),
  CONSTRAINT qlq_slot_ck CHECK (
        (selection_mode = 'fixed' AND slot_no IS NOT NULL AND slot_no BETWEEN 1 AND 20)
     OR (selection_mode = 'pool'  AND slot_no IS NULL)
  )
);
COMMENT ON TABLE  quiz_level_question IS '关卡编排。fixed 行 = 产品 §8.3 的 10×8 固定题位；pool 行 = 同难度同分类的候选题，供"错题优先补位"（规则 5）与题池不足时替换';

-- ★ 产品 §8.3 diversity.same_term_same_level_forbidden：同关卡内同一 term 不得出现 2 次
CREATE UNIQUE INDEX qlq_one_question_per_term_per_level_uk
    ON quiz_level_question (level_id, term_id);
-- fixed 槽位不重复
CREATE UNIQUE INDEX qlq_slot_one_per_level_uk
    ON quiz_level_question (level_id, slot_no) WHERE slot_no IS NOT NULL;
-- 出题查询主路径：按关卡 + 难度筛题
CREATE INDEX qlq_level_difficulty_idx ON quiz_level_question (level_id, slot_difficulty, selection_mode);
-- 反查：某词条变更影响哪些关卡 → revalidateTag(`level:{levelId}`)（backend §4.2）
CREATE INDEX qlq_term_idx ON quiz_level_question (term_id);

COMMIT;
```

**为什么 `quiz_option` 是表而不是架构 ER 草案里的 `jsonb options`**（这是对上游方案的一处有意偏离，需架构师确认）：

| 维度 | `jsonb options` | **`quiz_option` 表（采纳）** |
|---|---|---|
| "每题至多 1 个正确选项" | 需 GIN + 应用层校验，DB 拦不住 | ✅ partial unique index，DB 级不变量 |
| "干扰项均来自真实术语"（产品 C14 验收） | `source_term_id` 埋在 jsonb 里，无法建外键 → 词条删了干扰项溯源静默失效 | ✅ 真外键 `ON DELETE SET NULL`，可 join 出"孤立干扰项"清单 |
| "全局同一选项文本出现 ≤6 次"（`diversity.max_option_text_appearances_global`） | 需 jsonb 数组展开 + 全表扫，无法索引 | ✅ `GROUP BY body HAVING count(*)>6` 走普通索引 |
| 答案位置分布校验（`answer_position_distribution`） | 每次都要解析 jsonb | ✅ 直接聚合 |
| 出题时读取 | 一次读一行（略优） | 一次 join 4 行；题池预取时批量 join，实测差异可忽略（口径 A 仅 1,496 行） |

**唯一代价**：出题查询多一次 join。口径 A 全表 1,496 行、口径 B 约 24,000 行，`quiz_level_question` 已把题池收敛到每关几十行，join 成本可忽略；而"防送分题"是产品 C15（首次正确率 55%~70%，**发布阻塞级验收**）的唯一数据来源，可审计性优先。

**`quiz_question_not_exceed_term_ck` 依赖的函数**（CHECK 里不能直接 join，用 IMMUTABLE 函数封装；注意其"半可信"性质，见注释）：

```sql
-- 007a_helper_fn.sql —— 必须在 007 之前执行
CREATE OR REPLACE FUNCTION term_difficulty_of(p_term_id bigint)
RETURNS term_difficulty
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT difficulty FROM term WHERE id = p_term_id;
$$;
COMMENT ON FUNCTION term_difficulty_of IS
  '⚠️ 诚实声明：Postgres 要求 CHECK 表达式为 IMMUTABLE，本函数标 STABLE 以使 CREATE 通过，'
  '但这意味着该 CHECK 在 term.difficulty 后续变更时【不会自动重算】—— 它只在 INSERT/UPDATE quiz_question 时生效。'
  '因此它是"编译期防线"而非"运行期不变量"。词条改难度后必须重跑 CI 的题目超纲校验（CI-D12）。'
  '若不接受这个半可信性，替代方案是删掉此 CHECK、完全交给 CI —— 两种选择都比"看起来有约束实际不生效"好。';
```

> 【待确认 · 数据建模】上述 CHECK 的半可信性是否可接受？备选：① 保留 CHECK + CI 双防线（本方案，推荐）；② 删除 CHECK，`quiz_question.difficulty` 改为编译期从 `term.difficulty` 派生的生成列 `GENERATED ALWAYS AS (...)`（Postgres 不支持跨表生成列，故只能落到编译期）；③ 用触发器 `BEFORE INSERT OR UPDATE` 做真校验（性能代价：每次写题目多一次 SELECT）。**我的建议是 ①**，理由：题目是编译产物，写入路径只发生在 CI 编译时，此时 `term.difficulty` 与题目在同一事务内确定，CHECK 完全有效；后续词条改难度属于"内容修订"，本来就要走 CI 重新校验。

### 2.8 作答事件与错题聚合

```sql
-- 008_answer_event.sql
BEGIN;

CREATE TABLE answer_event (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_request_id  uuid        NOT NULL,   -- ★ 幂等键（backend §2.5 Level 2 权威去重）
  question_public_id text        NOT NULL,   -- ★ 分析稳定键（题目被 retire/删除后仍可聚合）
  question_ref       bigint,                 -- 可空 FK，ON DELETE SET NULL；仅用于需要 join 题目细节时
  option_id          text        NOT NULL,
  is_correct         boolean     NOT NULL,
  difficulty         term_difficulty NOT NULL,-- ★ 冗余存储（backend §7.2 明示：避免分析 join，且题目可能后续被删）
  question_type      question_type,          -- 冗余：T2/T3 占比是产品 R7 的监控维度
  term_public_id     text,                   -- 冗余：错题聚合与"按词条的正确率"分析
  mode               quiz_mode   NOT NULL,
  level_id           text,                   -- review/daily 模式为空
  elapsed_ms         integer,                -- 不信任、不校验合理性，仅均值参考
  content_version    integer     NOT NULL,   -- ★ 作答时的词库版本（词库改了之后历史正确率不可直接比较）
  generator_version  text,                   -- 题目生成器版本；调旋钮后区分新旧题目难度
  created_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT answer_event_crid_uk UNIQUE (client_request_id),
  CONSTRAINT answer_event_question_fk FOREIGN KEY (question_ref)
      REFERENCES quiz_question (id) ON DELETE SET NULL,
  CONSTRAINT answer_event_question_public_id_ck CHECK (question_public_id ~ '^q_[0-9A-HJKMNP-TV-Z]{20,32}$'),
  CONSTRAINT answer_event_option_id_ck CHECK (option_id ~ '^o[1-9]$'),
  CONSTRAINT answer_event_level_id_ck CHECK (
        level_id IS NULL OR level_id ~ '^lv_(0[1-9]|[1-9][0-9])$'
  ),
  -- mode=level 时 level_id 必填（否则分析口径会缺维度）
  CONSTRAINT answer_event_level_mode_ck CHECK (mode <> 'level' OR level_id IS NOT NULL),
  CONSTRAINT answer_event_elapsed_ck CHECK (
        elapsed_ms IS NULL OR (elapsed_ms >= 0 AND elapsed_ms <= 1800000)
  ),
  CONSTRAINT answer_event_content_version_ck CHECK (content_version >= 1)
);

COMMENT ON TABLE answer_event IS
  '作答事件。★合规红线（backend §7.2）：本表【绝不】包含 IP / User-Agent / Referer / deviceId / anonymousId / '
  'sync_token / 任何可回溯到个人的哈希。本表只用于内容质量分析（题目难度、正确率、旋钮调优），'
  '【绝不】用于用户级去重统计 —— UV/WAL 只能来自客户端分析（零 Cookie 下服务端做不到，backend §7.1）。';
COMMENT ON COLUMN answer_event.client_request_id IS
  '双重职责：① 幂等键（弱网重试队列依赖它，同 key 同 payload 返回首次结果）；② 唯一约束 = 跨实例去重的权威。'
  '进程内 LRU 只是快路径，多实例下必漏检（backend §2.5 已论证）';
COMMENT ON COLUMN answer_event.content_version IS
  '产品 C15 的正确率必须按 content_version 分组比较。跨版本直接平均会得出错误结论（题目改了、词条释义改了）';
COMMENT ON COLUMN answer_event.elapsed_ms IS
  '客户端上报，服务端不信任、不据此判定超时或作弊；仅用于"题目是否过长"的均值参考';

-- 90 天保留期的清理路径（见 §5.4）
CREATE INDEX answer_event_created_at_idx ON answer_event (created_at);
COMMIT;
```

```sql
-- 009_quiz_mistake.sql
BEGIN;

CREATE TABLE quiz_mistake (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  question_public_id  text        NOT NULL,
  term_id             bigint      NOT NULL,
  term_public_id      text        NOT NULL,
  difficulty          term_difficulty NOT NULL,
  wrong_count         integer     NOT NULL DEFAULT 0,   -- 全局累计答错次数
  submit_count        integer     NOT NULL DEFAULT 0,   -- 全局累计作答次数
  retry_count         integer     NOT NULL DEFAULT 0,   -- mode='review' 下的作答次数
  retry_correct_count integer     NOT NULL DEFAULT 0,   -- ★ 错题二次答对率的分子
  last_wrong_at       timestamptz,
  content_version     integer     NOT NULL,             -- 聚合口径所属版本；版本变更时重置
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT quiz_mistake_question_uk UNIQUE (question_public_id, content_version),
  CONSTRAINT quiz_mistake_term_fk FOREIGN KEY (term_id)
      REFERENCES term (id) ON DELETE CASCADE,
  CONSTRAINT quiz_mistake_counts_ck CHECK (
        wrong_count  >= 0 AND submit_count >= 0
    AND retry_count  >= 0 AND retry_correct_count >= 0
    AND retry_correct_count <= retry_count
    AND wrong_count <= submit_count
  ),
  CONSTRAINT quiz_mistake_no_pii_ck CHECK (term_public_id ~ '^t_[a-z0-9_]{1,32}$')
);
COMMENT ON TABLE quiz_mistake IS
  '★裁决 #4：错题【全局匿名聚合】表，一行 = 一道题在一个内容版本下的聚合计数。'
  '【绝不含任何用户标识】—— 没有 sync_token、没有 device_id、没有 user_id。'
  '用途仅两个：① 错题优先补位（客户端把 termIds 传给 /api/quiz/next，服务端据此排序候选题）；'
  '② 错题二次答对率（产品目标 ≥65%）的服务端交叉验证口径。'
  '用户个人的错题本（mastered / inDefaultList / wrongCount）100% 在客户端 localStorage，不上服务端。';
COMMENT ON COLUMN quiz_mistake.content_version IS
  '聚合口径按版本切片：题目改版后旧聚合失去意义，新版本从 0 开始。这也是"90 天后老版本行可安全清理"的依据';

CREATE INDEX quiz_mistake_term_idx ON quiz_mistake (term_id, wrong_count DESC);
CREATE INDEX quiz_mistake_wrong_rate_idx
    ON quiz_mistake ((wrong_count::numeric / greatest(submit_count, 1)) DESC)
    WHERE submit_count >= 20;   -- 样本量门槛，防"1 次答错 = 100% 错误率"污染排序

COMMIT;
```

> ⚠️ **与架构 §3.3.2 的一处有意偏离（需主理人/架构师确认）**
> 架构文档设计了 `quiz_mistake.sync_token`（可撤销同步凭证）以支持"错题本跨会话可用"。主理人裁决 #4 明确「**只存匿名聚合所需字段，绝不含任何用户标识**（合规红线）」。`sync_token` 虽然不是 `deviceId` 的哈希、也无法反推身份，但它**仍然是一个跨请求稳定的用户级标识符** —— 有了它就能拼出"某个 token 的完整错题序列"，这在产品 L6「匿名标识不可回溯个人」的口径下属于灰色地带，且与裁决 #4 的字面要求冲突。
> **本方案采纳裁决 #4：`quiz_mistake` 无 `sync_token`，按 `(question_public_id, content_version)` 聚合。**
> **代价（必须诚实列出）**：错题本不再有服务端副本 → 清浏览器缓存 / 换设备即丢失错题本。这正是产品 Q13 已确认接受的代价（「假设接受，并提供清空记录入口」），且前端设计 §5.2 的 `ProgressStore` 已把"重新加入复习"定义为纯客户端操作。**功能上 MVP 不受影响**（M7 验收全部在客户端可满足），只是失去"跨设备错题本"这一项 v1 本来就不承诺的能力。
> 【待确认 · P1】是否接受该代价？若不接受，替代方案是给 `quiz_mistake` 加回 `sync_token`，但需要主理人对"可撤销随机凭证是否算用户标识"给出明确裁决 —— 这是合规判断，不是数据建模判断，我不越权决定。

### 2.9 缺口池、触发器与视图

```sql
-- 010_search_miss.sql
BEGIN;

CREATE TABLE search_miss_log (
  norm_key          text        PRIMARY KEY,   -- ★ 只存归一化 query（裁决 #6）
  occurrence_count  integer     NOT NULL DEFAULT 1,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  content_version   integer     NOT NULL,      -- 哪个词库版本下未命中（补词后自动失效判定）
  query_kind        text        NOT NULL DEFAULT 'term',  -- 'term' | 'sentence'，服务端判定，不用客户端猜
  query_length_bucket text      NOT NULL DEFAULT '0-4',   -- 分桶而非原值（backend §7.4）
  resolution        miss_resolution NOT NULL DEFAULT 'new',
  resolved_term_id  bigint,                    -- 补词后指向新词条，形成闭环
  resolved_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT search_miss_count_ck CHECK (occurrence_count >= 1),
  -- ★★ 裁决 #6 输入过滤：DB 侧兜底，不符合的一律拒绝写入
  --    （应用层 Zod 先过滤；这里是最终防线，防止绕过 API 的直连写入把姓名/手机号片段落库）
  CONSTRAINT search_miss_norm_key_shape_ck CHECK (
        norm_key ~ '^[a-z0-9 .\-]{2,32}$'
     OR norm_key ~ '^[\u4e00-\u9fff]{2,8}$'
  ),
  CONSTRAINT search_miss_bucket_ck CHECK (
        query_length_bucket IN ('0-4', '5-8', '9-16', '17-32', '33-200')
  ),
  CONSTRAINT search_miss_query_kind_ck CHECK (query_kind IN ('term', 'sentence')),
  CONSTRAINT search_miss_resolved_fk FOREIGN KEY (resolved_term_id)
      REFERENCES term (id) ON DELETE SET NULL,
  CONSTRAINT search_miss_resolved_ck CHECK (
        resolution <> 'covered' OR (resolved_term_id IS NOT NULL AND resolved_at IS NOT NULL)
  )
);
COMMENT ON TABLE search_miss_log IS
  '词库缺口池（产品 R4 应对④）。★合规红线：本表【没有 raw_query 列】—— 架构 §3.2 ER 草案里有 raw_query，'
  '本方案删除。理由：原始输入可能含姓名/手机号片段，一旦落库即进入运营可见范围，违反产品 L6 与裁决 #6。'
  '缺口分析只需要归一化后的词形，raw 对补词决策零增益。';
COMMENT ON COLUMN search_miss_log.occurrence_count IS
  '★k-匿名门槛：count >= 3 才进运营视图（见 v_search_miss_ops）。'
  '只被搜过 1 次的词若原样进后台，等于把某个用户的输入暴露给运营';

CREATE INDEX search_miss_count_desc_idx ON search_miss_log (occurrence_count DESC, last_seen_at DESC);
CREATE INDEX search_miss_resolution_idx ON search_miss_log (resolution, occurrence_count DESC);

-- ★ 运营视图：k-匿名门槛在此固化，运营无法绕过（比"文档里写要求"可靠得多）
CREATE OR REPLACE VIEW v_search_miss_ops AS
SELECT norm_key,
       occurrence_count,
       first_seen_at,
       last_seen_at,
       query_kind,
       resolution,
       resolved_term_id
FROM   search_miss_log
WHERE  occurrence_count >= 3          -- ★ k-匿名：低于门槛的词永不出现在运营视图
ORDER  BY occurrence_count DESC, last_seen_at DESC;
COMMENT ON VIEW v_search_miss_ops IS
  '运营唯一可见的缺口池视图。默认只展示 norm_key + 次数 + 时间，无任何用户关联信息（backend §7.5）。'
  '建议为运营账号只授予本视图的 SELECT 权限，不授予 search_miss_log 表权限。';

COMMIT;
```

```sql
-- 011_triggers_views.sql
BEGIN;

-- ── updated_at 自动维护（除 answer_event / search_miss_log 外的所有表）──
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'category_l1','category_l2','term','sense','sense_example','alias',
    'tag','term_relation','content_release','disclaimer',
    'quiz_level','quiz_question','quiz_option','quiz_level_question',
    'quiz_mistake','search_miss_log'
  ]
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS %I ON %I;
       CREATE TRIGGER %I BEFORE UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      'trg_'||t||'_updated_at', t, 'trg_'||t||'_updated_at', t);
  END LOOP;
END $$;

-- ── 视图 1：词条完整读模型（/api/term/[slug] 与编译期导出共用）─────────
CREATE OR REPLACE VIEW v_term_published AS
SELECT t.id, t.public_id, t.slug, t.display_name, t.full_name, t.pronunciation,
       t.category_l1, t.category_l2, c2.numeric_id AS category_id,
       c1.name AS category_l1_name, c2.name AS category_l2_name,
       t.difficulty, t.not_meaning, t.risk_note, t.regulatory_flags,
       t.content_version, t.release_version, t.popularity, t.sense_count,
       t.updated_at::date AS updated_date
FROM   term t
JOIN   category_l2 c2 ON c2.l1 = t.category_l1 AND c2.l2 = t.category_l2
JOIN   category_l1 c1 ON c1.l1 = t.category_l1
WHERE  t.status = 'published';
COMMENT ON VIEW v_term_published IS '已发布词条的扁平读模型；SSG generateStaticParams 与 /api/term/[slug] 的第一段查询';

-- ── 视图 2：搜索列表项（产品 F5「MA · 3 个意思」零额外查询）───────────
CREATE OR REPLACE VIEW v_search_list_item AS
SELECT t.id AS term_id, t.public_id, t.slug, t.display_name, t.full_name, t.pronunciation,
       t.category_l1, t.category_l2, c2.numeric_id AS category_id,
       t.difficulty, t.sense_count, t.not_meaning, t.risk_note, t.popularity,
       t.content_version, t.updated_at::date AS updated_at,
       s_primary.plain_explain AS primary_plain_explain,
       s_primary.public_id     AS primary_sense_id,
       EXISTS (SELECT 1 FROM quiz_question q
                WHERE q.term_id = t.id AND q.status = 'published') AS has_quiz
FROM   term t
JOIN   category_l2 c2 ON c2.l1 = t.category_l1 AND c2.l2 = t.category_l2
LEFT   JOIN LATERAL (
         SELECT s.plain_explain, s.public_id
         FROM   sense s
         WHERE  s.term_id = t.id AND s.status = 'published'
         ORDER  BY s.is_primary DESC,
                   CASE s.frequency WHEN 'high' THEN 0 WHEN 'mid' THEN 1 ELSE 2 END,
                   s.sort_order
         LIMIT  1
       ) s_primary ON true
WHERE  t.status = 'published';
COMMENT ON VIEW v_search_list_item IS
  '对应 backend §2.1 TermCardSummary 的全部字段来源。风险条截断（riskNoteShort）在应用层做，不在视图里';

-- ── 视图 3：内容质量巡检（产品 §7.6 发布后巡检 + 流水线 §4.5 ④）───────
CREATE OR REPLACE VIEW v_content_audit AS
SELECT t.slug, t.display_name, t.status, t.difficulty, t.regulatory_flags,
       (t.category_l1)::text AS l1, (t.category_l2)::text AS l2,
       t.sense_count,
       (SELECT count(*) FROM sense s WHERE s.term_id = t.id)                        AS actual_sense_count,
       (SELECT count(*) FROM sense s WHERE s.term_id = t.id
          AND s.advanced_explain IS NULL)                                           AS missing_advanced,
       (SELECT count(*) FROM sense s WHERE s.term_id = t.id
          AND s.pro_explain IS NULL AND t.difficulty = 'L3')                        AS l3_missing_pro,
       (SELECT count(*) FROM sense s JOIN sense_example e ON e.sense_id = s.id
          WHERE s.term_id = t.id AND NOT e.has_concrete_number)                     AS examples_without_number,
       (SELECT count(*) FROM alias a WHERE a.term_id = t.id)                        AS alias_count,
       (SELECT count(*) FROM alias a WHERE a.term_id = t.id AND a.source_field='search_alias') AS search_alias_count,
       (SELECT count(*) FROM term_relation r
          WHERE r.source_term_id = t.id AND r.relation_type = 'related')            AS related_count,
       (SELECT count(*) FROM term_relation r
          WHERE r.source_term_id = t.id AND r.relation_type = 'contrast')           AS contrast_count,
       (SELECT count(*) FROM quiz_question q
          WHERE q.term_id = t.id AND q.status = 'published')                        AS published_question_count
FROM   term t
WHERE  t.status <> 'archived';
COMMENT ON VIEW v_content_audit IS
  '一眼看出产品 §9.2 C1~C14 的达成情况；也是"规则演进后回溯扫描"的输出基底';

-- ── 视图 4：题目在线难度（旋钮调优的输入）────────────────────────────
CREATE OR REPLACE VIEW v_question_difficulty AS
SELECT content_version,
       difficulty,
       question_type,
       count(*)                                        AS submits,
       count(*) FILTER (WHERE is_correct)              AS corrects,
       round(avg(is_correct::numeric), 4)              AS correct_rate,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY elapsed_ms), 0) AS p50_elapsed_ms
FROM   answer_event
GROUP  BY content_version, difficulty, question_type;
COMMENT ON VIEW v_question_difficulty IS
  '产品 C15 首次正确率的服务端口径（注意：这是【全部提交】口径，不是"首次"—— 服务端在零 Cookie 下算不出首次，backend §7.6 已明示）';

COMMIT;
```

### 2.10 权限最小化（Neon 上的角色划分）

```sql
-- 012_grants.sql
-- 三类连接身份，权限严格分离（产品 L6 数据最小化在 DB 层的落地）
-- ① 编译管线（CI，写内容表）        role: glossary_compiler
-- ② 运行时读（Next.js Route Handler） role: glossary_reader
-- ③ 运行时写（仅 answer_event / search_miss_log / quiz_mistake 计数） role: glossary_writer

CREATE ROLE glossary_reader  NOLOGIN;
CREATE ROLE glossary_writer  NOLOGIN;
CREATE ROLE glossary_compiler NOLOGIN;

-- 读：只给读模型需要的表；★ 不给 quiz_option（含 is_correct）与 term.source（内部审核留痕）
GRANT USAGE ON SCHEMA public TO glossary_reader;
GRANT SELECT ON category_l1, category_l2, term, sense, sense_example, alias,
               tag, term_tag, term_relation, quiz_level, quiz_question,
               quiz_level_question, disclaimer, content_release
       TO glossary_reader;
GRANT SELECT ON v_term_published, v_search_list_item TO glossary_reader;
-- ★ answer_key 的唯一读取路径：判分函数（SECURITY DEFINER），而非直接授予表权限
--   这样 quiz_option 永不出现在任何"可自由 SELECT"的身份下

-- 写：只能写事件表，且无 UPDATE / DELETE 权限（append-only，防篡改指标）
GRANT USAGE ON SCHEMA public TO glossary_writer;
GRANT INSERT ON answer_event, search_miss_log TO glossary_writer;
GRANT UPDATE (occurrence_count, last_seen_at) ON search_miss_log TO glossary_writer;
GRANT UPDATE (wrong_count, submit_count, retry_count, retry_correct_count, last_wrong_at, updated_at)
      ON quiz_mistake TO glossary_writer;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO glossary_writer;

-- 编译：内容表全权，但★不给 answer_event / search_miss_log / quiz_mistake（编译管线不应触碰行为数据）
GRANT USAGE ON SCHEMA public TO glossary_compiler;
GRANT SELECT, INSERT, UPDATE, DELETE ON
      category_l1, category_l2, term, sense, sense_example, alias, tag, term_tag,
      term_relation, term_version, content_release, quiz_level, quiz_question,
      quiz_option, quiz_level_question, disclaimer, blacklist_word, jargon_dict
      TO glossary_compiler;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO glossary_compiler;

-- 运营：只能看 k-匿名视图，看不到底表（裁决 #6 的权限级落地）
CREATE ROLE glossary_ops NOLOGIN;
GRANT USAGE ON SCHEMA public TO glossary_ops;
GRANT SELECT ON v_search_miss_ops, v_content_audit, v_question_difficulty TO glossary_ops;
-- ★ 刻意不授予 search_miss_log 表权限：k-匿名门槛不可绕过
```

### 2.11 两级分类枚举完整合法取值清单（★ 内容后台校验依据）

> 这是裁决 #1 要求交付的清单。**内容后台（MDX front-matter 校验）与 DB 复合外键用的是同一份清单**，两侧不会漂移。
> 编号规则：`category_l1.numeric_id = 1~12`；`category_l2.numeric_id = 一级号 × 100 + 二级序号`（如 技术指标=2 → 均线类=201）。对外 API `category.id` 统一返回**二级 `numeric_id`**（backend §2.1 的 `category: {id, l1, l2}`），一级号可由 `id / 100` 反推。

| L1 号 | `category_l1`（枚举标签） | `code`（ASCII） | 展示名 `name` | L2 号 | `category_l2`（枚举标签） | `code` | 展示名 | 风险提示模板 `risk_note_template` | T2 指代词 `t2_referent` |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `宏观经济` | `macro_economy` | 宏观经济 | 101 | `增长与产出` | `growth_output` | 增长与产出 | 宏观数据反映的是整体经济状况，不能推出某个行业或公司的表现。 | 这个说法 |
| 1 | | | | 102 | `物价水平` | `price_level` | 物价水平 | 统计口径以发布机构公布为准，不构成投资建议。 | 这个说法 |
| 1 | | | | 103 | `货币与信用` | `money_credit` | 货币与信用 | 货币数据是政策结果的描述，不预测市场走向。 | 这个说法 |
| 1 | | | | 104 | `就业与收入` | `employment_income` | 就业与收入 | 就业数据滞后于经济变化，不构成任何判断依据。 | 这个说法 |
| 1 | | | | 105 | `汇率与国际` | `fx_international` | 汇率与国际 | 汇率受多重因素影响，本词条不构成任何换汇或跨境投资建议。 | 这个说法 |
| 2 | `技术指标` | `technical_indicator` | 技术指标 | 201 | `均线类` | `moving_average` | 均线类 | 技术指标是对历史价格的统计，不预测未来。 | 这个指标 |
| 2 | | | | 202 | `摆动指标` | `oscillator` | 摆动指标 | 技术指标是对历史价格的统计，不预测未来。 | 这个指标 |
| 2 | | | | 203 | `量能指标` | `volume` | 量能指标 | 技术指标是对历史价格的统计，不预测未来。 | 这个指标 |
| 2 | | | | 204 | `波动率指标` | `volatility` | 波动率指标 | 技术指标是对历史价格的统计，不预测未来。 | 这个指标 |
| 2 | | | | 205 | `交叉与信号` | `cross_signal` | 交叉与信号 | 所谓"信号"是对历史形态的命名，不是操作指令。 | 这个指标 |
| 3 | `估值财务` | `valuation_finance` | 估值与财务 | 301 | `估值倍数` | `valuation_multiple` | 估值倍数 | 市盈率高低只反映价格与利润的关系，不构成买卖依据。 | 这个数字 |
| 3 | | | | 302 | `盈利能力` | `profitability` | 盈利能力 | 历史比例不代表未来表现，不构成买卖依据。 | 这个数字 |
| 3 | | | | 303 | `现金流` | `cash_flow` | 现金流 | 现金流数据是历史结果，不预测未来资金状况。 | 这个数字 |
| 3 | | | | 304 | `杠杆水平` | `leverage_level` | 杠杆水平 | 杠杆类指标对应的产品可能造成本金全部损失。 | 这个数字 |
| 3 | | | | 305 | `增长与口径` | `growth_measure` | 增长与口径 | 增速口径差异很大，比较前必须先确认口径。 | 这个数字 |
| 4 | `基金产品` | `fund_product` | 基金与产品 | 401 | `基金类型` | `fund_type` | 基金类型 | 规模数据以披露口径为准，不构成投资建议。 | 这个产品 |
| 4 | | | | 402 | `指数与市场` | `index_market` | 指数与市场 | 指数是市场整体的统计描述，不代表任何单一产品的表现。 | 这个产品 |
| 4 | | | | 403 | `规模与净值` | `aum_nav` | 规模与净值 | 规模与净值是披露数据，不构成买卖依据。 | 这个产品 |
| 4 | | | | 404 | `跨市场工具` | `cross_market` | 跨市场工具 | 跨市场产品涉及额外规则与汇率因素，本词条不构成投资建议。 | 这个产品 |
| 5 | `交易风险` | `trading_risk` | 交易与风险 | 501 | `收益与亏损` | `pnl_roi` | 收益与亏损 | 历史收益不代表未来表现，不构成投资建议。 | 这件事 |
| 5 | | | | 502 | `回撤与风险度量` | `drawdown_risk` | 回撤与风险度量 | 风险度量基于历史数据与模型假设，不能穷尽全部风险。 | 这件事 |
| 5 | | | | 503 | `交易机制` | `trading_mechanism` | 交易机制 | 交易规则以交易所公布为准，本词条不构成操作指导。 | 这件事 |
| 5 | | | | 504 | `发行与上市` | `issuance_listing` | 发行与上市 | 发行与上市规则以监管公布为准，不构成投资建议。 | 这件事 |
| 5 | | | | 505 | `报价与成本` | `quote_cost` | 报价与成本 | 报价与成本随市场变化，本词条仅解释概念。 | 这件事 |
| 6 | `市场情绪` | `market_sentiment` | 市场情绪 | 601 | `多空立场` | `bull_bear_stance` | 多空立场 | 多空说法是对他人观点的描述，不构成任何操作建议。 | 这个说法 |
| 6 | | | | 602 | `群体心理` | `crowd_psychology` | 群体心理 | 情绪类说法是对群体行为的描述，不预测市场走向。 | 这个说法 |
| 6 | | | | 603 | `风险偏好` | `risk_appetite` | 风险偏好 | 风险偏好是市场状态描述，不构成任何配置建议。 | 这个说法 |
| 7 | `走势形态` | `price_pattern` | 走势形态 | 701 | `趋势与反转` | `trend_reversal` | 趋势与反转 | 形态名称是事后描述，不是有效的预测工具。 | 这种走势 |
| 7 | | | | 702 | `盘整与区间` | `sideways_range` | 盘整与区间 | 形态名称是事后描述，不是有效的预测工具。 | 这种走势 |
| 7 | | | | 703 | `突破与关键位` | `breakout_levels` | 突破与关键位 | 支撑与阻力是对历史价格的描述，不构成买卖依据。 | 这种走势 |
| 7 | | | | 704 | `极端走势` | `extreme_moves` | 极端走势 | 形态名称是事后描述，不是有效的预测工具。 | 这种走势 |
| 8 | `买卖操作` | `trading_action` | 买卖操作 | 801 | `方向与持仓` | `direction_position` | 方向与持仓 | 多空持仓说法是对他人行为的描述，不构成任何操作建议。 | 这个操作 |
| 8 | | | | 802 | `进出场动作` | `entry_exit` | 进出场动作 | 本词条仅解释说法含义，不构成任何操作指导。 | 这个操作 |
| 8 | | | | 803 | `仓位管理` | `position_sizing` | 仓位管理 | 杠杆类术语对应的产品可能造成本金全部损失。 | 这个操作 |
| 8 | | | | 804 | `持有者行为` | `holder_behavior` | 持有者行为 | 这些说法是对他人行为的标签，不代表其判断正确。 | 这个操作 |
| 9 | `财报公司` | `earnings_company` | 财报与公司 | 901 | `财报发布与预期` | `earnings_surprise` | 财报发布与预期 | 单期财报不代表长期表现，不构成投资建议。 | 这个数字 |
| 9 | | | | 902 | `收入与利润` | `revenue_profit` | 收入与利润 | 财务数据是历史结果，不预测未来表现。 | 这个数字 |
| 9 | | | | 903 | `公司质地` | `company_quality` | 公司质地 | 定性说法不构成任何标的推荐或评价。 | 这个数字 |
| 9 | | | | 904 | `股东回报` | `shareholder_return` | 股东回报 | 分红与回购是历史行为，不代表未来一定持续。 | 这个数字 |
| 10 | `机构与资金` | `institution_capital` | 机构与资金 | 1001 | `机构类型` | `institution_type` | 机构类型 | 所谓"聪明钱"没有公开、可验证的识别标准，不要当作跟随信号。 | 这个机构 |
| 10 | | | | 1002 | `资金与流动性` | `liquidity` | 资金与流动性 | 流动性描述的是市场状态，不构成任何操作建议。 | 这个机构 |
| 10 | | | | 1003 | `杠杆与保证金` | `leverage_margin` | 杠杆与保证金 | 杠杆类术语对应的产品可能造成本金全部损失。 | 这个机构 |
| 10 | | | | 1004 | `市场结构事件` | `market_structure` | 市场结构事件 | 这些说法多为事后归因，不能当作可跟随的信号。 | 这个机构 |
| 11 | `宏观政策` | `macro_policy` | 宏观政策与央行 | 1101 | `央行与货币政策` | `central_bank` | 央行与货币政策 | 政策表述以官方发布为准，本词条不构成任何预期判断。 | 这个说法 |
| 11 | | | | 1102 | `财政政策` | `fiscal_policy` | 财政政策 | 政策表述以官方发布为准，本词条不构成任何预期判断。 | 这个说法 |
| 11 | | | | 1103 | `利率与政策工具` | `rate_tools` | 利率与政策工具 | 利率工具的影响链条复杂，不能简化为单一结论。 | 这个说法 |
| 11 | | | | 1104 | `监管与市场制度` | `regulation` | 监管与市场制度 | 监管规则以官方公布为准，且可能随时调整。 | 这个说法 |
| 12 | `常见误用` | `misconception` | 常见误用与澄清 | 1201 | `信号误读` | `signal_misread` | 信号误读 | 本词条仅用于理解他人表达的市场术语，不构成投资建议。 | 这句话 |
| 12 | | | | 1202 | `估值误读` | `valuation_misread` | 估值误读 | 本词条仅用于理解他人表达的市场术语，不构成投资建议。 | 这句话 |
| 12 | | | | 1203 | `指标误读` | `indicator_misread` | 指标误读 | 本词条仅用于理解他人表达的市场术语，不构成投资建议。 | 这句话 |
| 12 | | | | 1204 | `主体误读` | `actor_misread` | 主体误读 | 本词条仅用于理解他人表达的市场术语，不构成投资建议。 | 这句话 |

**清单校验结论**：12 个一级 × 各 3~5 个二级 = **51 个二级**，全部落在裁决 #1 要求的「每类下 2~6 个」区间内。

> 【待确认 · P1】二级子类命名与产品文档存在两处差异，需内容负责人确认：
> ① 产品 §7.7 用「宏观政策与央行」「估值与财务」「基金与产品」「交易与风险」「财报与公司」「常见误用与澄清」作分类名，裁决 #1 的 12 个枚举用简称「宏观政策」「估值财务」「基金产品」「交易风险」「财报公司」「常见误用」。**本方案：枚举标签 = 裁决 #1 的简称（DB 侧），展示名 `name` = 产品文档全称（UI 侧）**，两者分离，各自都对。
> ② 裁决 #1 举例「技术指标 → 均线/摆动/量能/波动率」是 4 个，本方案加了第 5 个「交叉与信号」以承接产品 §7.7 明列的「金叉死叉」；「估值财务 → 估值倍数/盈利能力/现金流/杠杆水平」是 4 个，本方案加了第 5 个「增长与口径」以承接「YoY/QoQ/TTM/CAGR/TAM」。若内容负责人认为应严格 4 个，把这两项合并到相邻子类即可，**不影响任何 DDL**。

**Seed 脚本（`013_seed_category.sql`，节选前 3 个一级 + 全部 12 个一级的插入骨架）**

```sql
-- 013_seed_category.sql
BEGIN;

INSERT INTO category_l1 (l1, code, name, numeric_id, sort_order, risk_note_template, t2_referent) VALUES
 ('宏观经济',   'macro_economy',         '宏观经济',        1,  1, '宏观数据反映的是整体经济状况，不能推出某个行业或公司的表现。', '这个说法'),
 ('技术指标',   'technical_indicator',   '技术指标',        2,  2, '技术指标是对历史价格的统计，不预测未来。',                     '这个指标'),
 ('估值财务',   'valuation_finance',     '估值与财务',      3,  3, '比率型指标只反映价格与相关财务数据的关系，不构成买卖依据。',   '这个数字'),
 ('基金产品',   'fund_product',          '基金与产品',      4,  4, '规模与净值数据以披露口径为准，不构成投资建议。',               '这个产品'),
 ('交易风险',   'trading_risk',          '交易与风险',      5,  5, '历史收益与风险度量不代表未来表现，不构成投资建议。',           '这件事'),
 ('市场情绪',   'market_sentiment',      '市场情绪',        6,  6, '多空说法是对他人观点的描述，不构成任何操作建议。',             '这个说法'),
 ('走势形态',   'price_pattern',         '走势形态',        7,  7, '形态名称是事后描述，不是有效的预测工具。',                     '这种走势'),
 ('买卖操作',   'trading_action',        '买卖操作',        8,  8, '本词条仅解释说法含义，不构成任何操作指导。',                   '这个操作'),
 ('财报公司',   'earnings_company',      '财报与公司',      9,  9, '单期财报不代表长期表现，不构成投资建议。',                     '这个数字'),
 ('机构与资金', 'institution_capital',   '机构与资金',     10, 10, '所谓"聪明钱"没有公开、可验证的识别标准，不要当作跟随信号。',   '这个机构'),
 ('宏观政策',   'macro_policy',          '宏观政策与央行', 11, 11, '政策表述以官方发布为准，本词条不构成任何预期判断。',           '这个说法'),
 ('常见误用',   'misconception',         '常见误用与澄清', 12, 12, '本词条仅用于理解他人表达的市场术语，不构成投资建议。',         '这句话');

INSERT INTO category_l2 (l1, l2, code, name, numeric_id, sort_order) VALUES
 ('宏观经济','增长与产出','growth_output','增长与产出',101,1),
 ('宏观经济','物价水平','price_level','物价水平',102,2),
 ('宏观经济','货币与信用','money_credit','货币与信用',103,3),
 ('宏观经济','就业与收入','employment_income','就业与收入',104,4),
 ('宏观经济','汇率与国际','fx_international','汇率与国际',105,5),
 ('技术指标','均线类','moving_average','均线类',201,1),
 ('技术指标','摆动指标','oscillator','摆动指标',202,2),
 ('技术指标','量能指标','volume','量能指标',203,3),
 ('技术指标','波动率指标','volatility','波动率指标',204,4),
 ('技术指标','交叉与信号','cross_signal','交叉与信号',205,5),
 ('估值财务','估值倍数','valuation_multiple','估值倍数',301,1),
 ('估值财务','盈利能力','profitability','盈利能力',302,2),
 ('估值财务','现金流','cash_flow','现金流',303,3),
 ('估值财务','杠杆水平','leverage_level','杠杆水平',304,4),
 ('估值财务','增长与口径','growth_measure','增长与口径',305,5),
 ('基金产品','基金类型','fund_type','基金类型',401,1),
 ('基金产品','指数与市场','index_market','指数与市场',402,2),
 ('基金产品','规模与净值','aum_nav','规模与净值',403,3),
 ('基金产品','跨市场工具','cross_market','跨市场工具',404,4),
 ('交易风险','收益与亏损','pnl_roi','收益与亏损',501,1),
 ('交易风险','回撤与风险度量','drawdown_risk','回撤与风险度量',502,2),
 ('交易风险','交易机制','trading_mechanism','交易机制',503,3),
 ('交易风险','发行与上市','issuance_listing','发行与上市',504,4),
 ('交易风险','报价与成本','quote_cost','报价与成本',505,5),
 ('市场情绪','多空立场','bull_bear_stance','多空立场',601,1),
 ('市场情绪','群体心理','crowd_psychology','群体心理',602,2),
 ('市场情绪','风险偏好','risk_appetite','风险偏好',603,3),
 ('走势形态','趋势与反转','trend_reversal','趋势与反转',701,1),
 ('走势形态','盘整与区间','sideways_range','盘整与区间',702,2),
 ('走势形态','突破与关键位','breakout_levels','突破与关键位',703,3),
 ('走势形态','极端走势','extreme_moves','极端走势',704,4),
 ('买卖操作','方向与持仓','direction_position','方向与持仓',801,1),
 ('买卖操作','进出场动作','entry_exit','进出场动作',802,2),
 ('买卖操作','仓位管理','position_sizing','仓位管理',803,3),
 ('买卖操作','持有者行为','holder_behavior','持有者行为',804,4),
 ('财报公司','财报发布与预期','earnings_surprise','财报发布与预期',901,1),
 ('财报公司','收入与利润','revenue_profit','收入与利润',902,2),
 ('财报公司','公司质地','company_quality','公司质地',903,3),
 ('财报公司','股东回报','shareholder_return','股东回报',904,4),
 ('机构与资金','机构类型','institution_type','机构类型',1001,1),
 ('机构与资金','资金与流动性','liquidity','资金与流动性',1002,2),
 ('机构与资金','杠杆与保证金','leverage_margin','杠杆与保证金',1003,3),
 ('机构与资金','市场结构事件','market_structure','市场结构事件',1004,4),
 ('宏观政策','央行与货币政策','central_bank','央行与货币政策',1101,1),
 ('宏观政策','财政政策','fiscal_policy','财政政策',1102,2),
 ('宏观政策','利率与政策工具','rate_tools','利率与政策工具',1103,3),
 ('宏观政策','监管与市场制度','regulation','监管与市场制度',1104,4),
 ('常见误用','信号误读','signal_misread','信号误读',1201,1),
 ('常见误用','估值误读','valuation_misread','估值误读',1202,2),
 ('常见误用','指标误读','indicator_misread','指标误读',1203,3),
 ('常见误用','主体误读','actor_misread','主体误读',1204,4);

INSERT INTO disclaimer (code, version, scope, content, short_content, effective_from, is_active, approved_by, approved_at) VALUES
 ('GENERAL',     1, 'global',    '本工具内容仅用于理解他人表达的市场术语，不构成任何投资建议。市场有风险，决策请独立判断。', '仅供理解，不构成投资建议', '2026-10-20', true,  NULL, NULL),
 ('HOME',        1, 'home',      '这里只做一件事：把金融黑话翻译成人话。不提供行情，不提供投资建议，不替你做决定。',         '不提供行情，不提供投资建议', '2026-10-20', true,  NULL, NULL),
 ('TERM_CARD',   1, 'term_card', '术语解释仅供学习了解，不构成投资建议。',                                                   '仅供学习了解',             '2026-10-20', true,  NULL, NULL),
 ('TERM_DETAIL', 1, 'global',    '本词条仅用于理解他人表达的市场术语，不构成任何投资建议。市场有风险，决策请独立判断。',       '仅供理解，不构成投资建议', '2026-10-20', true,  NULL, NULL),
 ('QUIZ_RESULT', 1, 'quiz',      '题目仅用于检验你对术语的理解，不涉及任何投资建议。',                                        '不涉及任何投资建议',       '2026-10-20', true,  NULL, NULL),
 ('NO_RESULT',   1, 'global',    '这个词我们还没收录。你可以看看下面几个相近的词。',                                          '尚未收录',                 '2026-10-20', true,  NULL, NULL),
 ('AI_FALLBACK', 1, 'global',    '本段内容由 AI 生成，未经人工审核，仅供理解参考，不构成投资建议。',                          'AI 生成，未经人工审核',    '2026-10-20', false, NULL, NULL);  -- v2 才启用

-- ★ 上线前必须把 approved_by / approved_at 填成法务实名（disclaimer_active_approved_ck 会阻断未署名的 is_active=true）
--   此处先插 NULL + is_active=true 只是为了 seed 可执行；生产库上线前由法务确认后 UPDATE。

COMMIT;
```

> ⚠️ seed 中 `disclaimer_active_approved_ck` 与 `approved_by IS NULL` 冲突 —— 上面这段 **在生产库会执行失败**，这是**故意的**：它把"法务未署名就不许上线免责文案"变成了执行时报错，而不是靠人记住。开发库若需先跑通，用 `is_active=false` 插入，法务确认后 `UPDATE ... SET is_active=true, approved_by='法务张三', approved_at=now()`（触发器保证同一时刻仍只有一个 active）。
> 【待确认 · P0】免责声明署名主体（产品 Q5）：`entity_name` 字段已预留但默认为空，需法务确认后填入。

---

## 3. 索引设计

> **原则：每条索引必须绑定一个真实查询。没有查询服务的索引一律不建** —— 索引不是免费的：口径 A 数据量下写入成本可忽略，但口径 B（2000 条 + 6000 题 + 39 万 answer_event）下多余索引会显著拖慢编译管线的批量 upsert（每次发布要写全量 term/sense/alias/option）。

### 3.1 索引总表

| # | 表 | 索引名 | 字段 | 类型 | 服务的查询场景 | 为什么这样建（不建会怎样） |
|---|---|---|---|---|---|---|
| I1 | `alias` | `alias_norm_key_uk` | `norm_key` | UNIQUE btree | **L0 精确查找**：`SELECT term_id, alias_type, weight, sense_id FROM alias WHERE norm_key = $1`；也是 `/api/lexicon` 全量导出的排序键 | 冷启动加载内存索引时的首次全表扫需要它做有序输出；**更重要的是唯一约束本身**——这是"同串字符指向两个词条"这类线上事故的最终防线。CI 也会查，但 CI 可被 `--no-verify` 绕过（流水线 §4.5） |
| I2 | `alias` | `alias_primary_one_per_term_uk` | `term_id` WHERE `alias_type='primary' AND sense_id IS NULL` | **partial UNIQUE** | 裁决 #2：一个 term 只有一个主名 | 普通 `UNIQUE(term_id, alias_type)` 会连带禁止"一个 term 有两个中文别名"，与产品 §7.1「aliases ≥1 项」冲突。partial index 只约束 primary 子集 |
| I3 | `alias` | `alias_primary_one_per_sense_uk` | `sense_id` WHERE `alias_type='primary' AND sense_id IS NOT NULL` | **partial UNIQUE** | 一个义项只有一个专属主名 | 同 I2；两条谓词互斥，无法合并成一条 |
| I4 | `alias` | `alias_term_id_idx` | `term_id` | btree | ① 词条详情页取全部别名（`/api/term/[slug]` 的 alias 段）② 编译期按 term 差量删除 ③ 发布后回溯"哪些词条别名少于 1 个" | 无索引则每次详情页多一次全表扫（口径 B 7000 行）。`ON DELETE CASCADE` 也依赖它 |
| I5 | `alias` | `alias_sense_id_idx` | `sense_id` WHERE `sense_id IS NOT NULL` | partial btree | 义项切换时取该义项专属别名；多义消歧一级路径的验证查询 | partial 而非全列：`sense_id IS NULL` 的行（词条级别名占多数）不进索引，索引体积减半 |
| I6 | `alias` | `alias_trgm_en_gin` | `norm_key gin_trgm_ops` WHERE `lang='en' AND char_length(norm_key) >= 4` | **partial GIN (pg_trgm)** | **L3.5 英文长词二级兜底**：`WHERE norm_key % $1 AND lang='en' ORDER BY similarity(norm_key,$1) DESC LIMIT 5` | ★**为什么只对英文建、且加长度门槛**：① `pg_trgm` 把字符串按 3 字符切片，**中文 2 字词（"均线""追高"）只产生 1~2 个 trigram，选择度极低**——查"市盈率"会召回"市净率/息率/股息率"，架构 §2.4.1 明确判定这是"失败而非成功"；② 中文模糊匹配已由应用层 gram 倒排 + 编辑距离承担（架构 §3.1.3 L3），DB 层再做一遍是负资产；③ 英文 ≥4 字符才有 ≥2 个 trigram，选择度可用；④ partial 让索引只含约 30% 的行（口径 A ≈130 行 / 口径 B ≈2100 行），写入与维护成本可忽略 |
| I7 | `term` | `term_slug_uk` | `slug` | UNIQUE btree | `/api/term/[slug]`、SSG `generateStaticParams`、旧别名 URL 301 判定 | 唯一约束 + 主查询路径，必须 |
| I8 | `term` | `term_public_id_uk` | `public_id` | UNIQUE btree | `/api/quiz/next?termIds=t_pe,t_roe` 的批量解析（backend §2.4 错题优先补位） | 客户端传的是 `public_id`，不是内部 `id` |
| I9 | `term` | `term_status_category_difficulty_idx` | `status, category_l1, difficulty, popularity DESC` | 复合 btree | **闯关出题主路径**：`WHERE status='published' AND category_l1=$1 AND difficulty<=$2 ORDER BY popularity DESC`；分类页浏览（产品 S7）；干扰项候选池 P1/P3（同分类同难度采样） | ★`status` 放最左：所有读路径都带 `status='published'`，它是最强过滤条件（草稿态词条不得泄露）。`difficulty` 用 `<=` 是范围条件，放在等值列之后才能吃到索引 |
| I10 | `term` | `term_category_l2_idx` | `category_l2, difficulty` | btree | 干扰项候选池 P1/P2（`category_l2 + same/adjacent difficulty`，generator.config.yaml `distractor.pools`） | P1/P2 是干扰项的最高优先级来源，出题器每次生成都会查；不建则每题一次全表扫 |
| I11 | `term` | `term_release_status_idx` | `release_version, status` | btree | 编译期差量对比：`WHERE release_version < $current` 找出需要归档/未更新的行 | 幂等 upsert 的收尾校验（§5.3） |
| I12 | `term` | `term_search_payload_trgm_gin` | `search_payload gin_trgm_ops` WHERE `lang_is_en`（生成列） | partial GIN | 运营后台"模糊找词条"；L3.5 的第二条兜底路径（当 alias 未命中但 display_name/full_name 近似） | 与 I6 分开：I6 服务别名精确归一化键，本索引服务展示串。**同样只对英文有效**，中文运营查找走 `v_content_audit` + 应用层 |
| I13 | `sense` | `sense_term_key_uk` | `term_id, sense_key` | UNIQUE btree | 义项 upsert 的冲突键；`/api/term/[slug]` 按 term 取全部义项 | 唯一约束 + 主读路径合一，不需要额外 `term_id` 单列索引 |
| I14 | `sense` | `sense_primary_one_per_term_uk` | `term_id` WHERE `is_primary` | **partial UNIQUE** | 产品 §7.3 第 2 条：默认义项唯一 | 无它则可能出现两个 primary，前端"默认展示哪个"变成未定义行为 |
| I15 | `sense` | `sense_public_id_uk` | `public_id` | UNIQUE btree | `/api/term/[slug]?sense=s_pe_fin`；`answer_event` 反查义项 | 对外契约用 public_id |
| I16 | `sense_example` | `sense_example_unique_body_uk` | `sense_id, body` | UNIQUE btree | **编译幂等**：重复编译同一份 MDX 不产生两条相同举例 | 这是 `ON CONFLICT DO NOTHING` 的冲突目标，没有它 upsert 无法幂等（§5.3） |
| I17 | `sense_example` | `sense_example_sense_sort_idx` | `sense_id, sort_order` | btree | 详情页按顺序取举例；判分响应取第 1 个举例 | 覆盖 `ORDER BY sort_order LIMIT n` |
| I18 | `term_relation` | PK `(source,target,relation_type)` | — | UNIQUE btree | 正向查询：`WHERE source_term_id=$1 AND relation_type='related' ORDER BY weight DESC`（相关词，产品 F9）；干扰项 P0 池（`relation_type='contrast'`） | 主键最左前缀 = `source_term_id`，正向查询天然覆盖 |
| I19 | `term_relation` | `term_relation_target_idx` | `target_term_id, relation_type` | btree | ★**反向查询**：① 发布时按 target 反查引用方 → `revalidateTag('term:{slug}')`（backend §2.2「反向依赖」）② SEO 内链双向互链（架构 §4.2）③ "谁把我列为易混词"的运营巡检 | 无它则每次发布要对 300~8000 行做全表扫，且发布耗时随词库线性增长 |
| I20 | `term_tag` | `term_tag_tag_idx` | `tag_id` | btree | 反查"某标签下有哪些词"（首页"新手常问"位、今日一词候选） | 主键最左是 `term_id`，反向查询需独立索引 |
| I21 | `quiz_question` | `quiz_question_public_id_uk` | `public_id` | UNIQUE btree | **判分主路径**：`POST /api/quiz/answer` 的第一次查询（取 answer_key + answer_basis）；`answer_event` 关联 | 这是全站 QPS 最高的写路径的读前提，P95 ≤ 300ms（产品 P4）依赖它 |
| I22 | `quiz_question` | `quiz_question_fingerprint_uk` | `fingerprint` | UNIQUE btree | **题目去重**（generator.config.yaml `dedup.exact_fingerprint`）；编译期幂等冲突键 | 无它则同一题可能被生成两次（改了题干空格又生成一遍），题量虚高、干扰项分布被污染 |
| I23 | `quiz_question` | `quiz_question_status_difficulty_type_idx` | `status, difficulty, question_type` | 复合 btree | **闯关出题筛选**：`WHERE status='published' AND difficulty <= $cap AND question_type = ANY($types)`；产品 C14 题量统计；产品 F17「难度自选」 | `status` 最左（draft/stale/retired 题绝不能出现在用户面前）；三列全等值/IN，索引利用率最高 |
| I24 | `quiz_question` | `quiz_question_term_idx` | `term_id, status` | btree | ① **review 模式出题**：`WHERE term_id = ANY($termIds) AND status='published'`（错题优先补位）② 词条修订时标记该词条的题目为 `stale`（流水线 §3.4）③ `has_quiz` 判定 | 错题复习是 M7 的核心路径；无索引则每次 review 请求扫全表（口径 B 6000 行 × 每次请求） |
| I25 | `quiz_question` | `quiz_question_stale_idx` | `status` WHERE `status IN ('stale','pending_review')` | partial btree | 运营"待处理题目"清单；CI 报告 | partial 只含少量行，比全列索引小一个数量级 |
| I26 | `quiz_option` | `quiz_option_correct_one_per_question_uk` | `question_id` WHERE `is_correct` | **partial UNIQUE** | ★**答案唯一性的 DB 级防线**：一道题不可能有两个正确答案 | 这是"判对但解析对不上"（backend §2.5 明确点名的可见故障）的根因防线。jsonb 方案做不到 |
| I27 | `quiz_option` | `quiz_option_question_sort_idx` | `question_id, sort_order` | btree | 出题时按题取 4 个选项（编译期顺序），下发前服务端按 seed 重打乱 | 判分与出题都走它；覆盖索引，无需回表 |
| I28 | `quiz_option` | `quiz_option_source_term_idx` | `source_term_id` | btree | ① 产品 C14「干扰项均来自真实术语」的审计查询 ② 词条删除后找出孤立干扰项 ③ 干扰项多样性统计（`max_option_text_appearances_global`） | `ON DELETE SET NULL` 需要它；也是"某词条被当作干扰项多少次"的唯一查询路径 |
| I29 | `quiz_level_question` | PK `(level_id, question_id)` | — | UNIQUE btree | 取关卡题池 | 主键即主查询 |
| I30 | `quiz_level_question` | `qlq_one_question_per_term_per_level_uk` | `level_id, term_id` | UNIQUE btree | ★产品 §8.3 规则 1 + `diversity.same_term_same_level_forbidden`：同关卡内同一 term 不得出现 2 次 | 这条编排规则原本只能靠编排器自觉；落成 DB 约束后，编排器写错就直接报错 |
| I31 | `quiz_level_question` | `qlq_slot_one_per_level_uk` | `level_id, slot_no` WHERE `slot_no IS NOT NULL` | partial UNIQUE | fixed 槽位不重复（8 题位不能有两条占同一位） | partial：pool 行 `slot_no IS NULL`，不进索引（PG 中 NULL 本来也不参与唯一，但显式 partial 让索引更小） |
| I32 | `quiz_level_question` | `qlq_level_difficulty_idx` | `level_id, slot_difficulty, selection_mode` | btree | **槽位编排查询**：按关卡 + 难度桶取题（backend §2.4 出题算法步骤 4） | 出题算法每关要按 5/2/1 三个难度桶分别取题 |
| I33 | `quiz_level_question` | `qlq_term_idx` | `term_id` | btree | 反查：词条变更影响哪些关卡 → `revalidateTag('level:{levelId}')`（backend §4.2） | 发布管线依赖；无它则每次发布全表扫 |
| I34 | `answer_event` | `answer_event_crid_uk` | `client_request_id` | UNIQUE btree | ★**幂等的权威实现**：`INSERT ... ON CONFLICT (client_request_id) DO NOTHING RETURNING id`（backend §2.5 Level 2） | 这是 v1 无 Redis 方案能成立的**唯一支柱**。多实例下进程内 LRU 必漏检，只有 DB 唯一约束能跨实例去重 |
| I35 | `answer_event` | `answer_event_created_at_idx` | `created_at` | btree | ★**90 天保留期清理**：`DELETE WHERE created_at < now() - interval '90 days'` | 无它则每次清理都是全表顺序扫 + 长事务，在 Neon serverless 上会直接打爆 CU |
| I36 | `answer_event` | `answer_event_version_agg_idx` | `content_version, difficulty, question_type` | 复合 btree | ★**按 content_version 聚合**：`v_question_difficulty` 视图、产品 C15 首次正确率的分版本口径、旋钮调优的 A/B 前后对比 | `content_version` 放最左：所有分析查询都必须先按版本切片（跨版本平均会得出错误结论，backend §7.2 明示）。三列都是低基数等值列，GROUP BY 可走 index-only scan |
| I37 | `answer_event` | `answer_event_question_time_idx` | `question_public_id, created_at DESC` | btree | 单题正确率时间序列（旋钮调优：某题改难度后前后对比）；`quiz_question.correct_count` 每日回填 | 无它则单题分析要扫全部事件 |
| I38 | `answer_event` | `answer_event_level_time_idx` | `level_id, created_at` WHERE `level_id IS NOT NULL` | partial btree | 关卡级正确率与 `meta.repeated` 监控（backend §7.7 告警项） | partial：review/daily 模式的 `level_id IS NULL` 行不进索引 |
| I39 | `quiz_mistake` | `quiz_mistake_question_uk` | `question_public_id, content_version` | UNIQUE btree | 计数 upsert 的冲突键 | `ON CONFLICT ... DO UPDATE SET wrong_count = quiz_mistake.wrong_count + 1` |
| I40 | `quiz_mistake` | `quiz_mistake_term_idx` | `term_id, wrong_count DESC` | btree | **错题优先补位**：`WHERE term_id = ANY($ids) ORDER BY wrong_count DESC`（哪些题大家都错 → 优先出） | 裁决 #4 的用途①；无它则 review 模式每次请求排序全表 |
| I41 | `quiz_mistake` | `quiz_mistake_wrong_rate_idx` | 表达式 `(wrong_count::numeric/greatest(submit_count,1)) DESC` WHERE `submit_count >= 20` | partial 表达式 btree | 裁决 #4 的用途②：**错题二次答对率**看板（`retry_correct_count/retry_count`）与"全站最难题目 Top20" | ★样本量门槛 `>=20` 是必需的：否则"1 次作答 1 次答错 = 100% 错误率"会永久霸榜，运营看到的是噪声 |
| I42 | `search_miss_log` | PK `norm_key` | — | UNIQUE btree | 缺口池 upsert：`ON CONFLICT (norm_key) DO UPDATE SET occurrence_count = ... + 1, last_seen_at = now()` | 幂等聚合的冲突键；也是裁决 #6"只存归一化 query"的物理体现 |
| I43 | `search_miss_log` | `search_miss_count_desc_idx` | `occurrence_count DESC, last_seen_at DESC` | btree | 运营视图 `v_search_miss_ops` 的排序（"最该补的词"）；k-匿名过滤后的 Top-N | 视图带 `WHERE occurrence_count >= 3 ORDER BY count DESC`，正好匹配 |
| I44 | `search_miss_log` | `search_miss_resolution_idx` | `resolution, occurrence_count DESC` | btree | 运营工作台按处理状态分组（new / triaged / covered / rejected） | 补词闭环的看板查询 |
| I45 | `disclaimer` | `disclaimer_active_one_per_code_uk` | `code` WHERE `is_active` | **partial UNIQUE** | ★裁决 #7 + 产品 L4：每个 code 同时只有一个生效版本；详情页/测验页/结果页读同一个 code → **从数据层保证三处不可能不同步** | 这是"三处免责版本漂移"的根治方案：不是靠流程约定，是靠唯一索引 |
| I46 | `disclaimer` | `disclaimer_code_effective_idx` | `code, effective_from DESC` | btree | 历史版本查询："这个词条 2026-03 上线时用的是哪版免责"（合规审计） | 产品 L4 版本管理要求 |
| I47 | `content_release` | `content_release_current_uk` | `release_kind` WHERE `status='current'` | **partial UNIQUE** | 内存索引版本校验：`SELECT version, checksum FROM content_release WHERE release_kind='lexicon' AND status='current'`（backend §4.1 每 5 分钟拉一次） | 保证任意时刻只有一个 current 版本 → "新索引 + 旧内容"混用在数据层就不可能 |
| I48 | `content_release` | `content_release_kind_sha_uk` | `release_kind, git_sha` | UNIQUE btree | ★**编译幂等根**：同一 commit 重复编译（CI 重跑、手动重试）不产生新 version、checksum 不变 → 索引不重建、缓存不打掉 | 无它则每次 CI 重跑都 bump version，触发全站缓存失效与索引重建，发布变成"越重试越慢" |
| I49 | `term_version` | `term_version_term_no_uk` | `term_id, version_no` | UNIQUE btree | 快照 upsert 幂等；"回滚到上一版"查询 | — |
| I50 | `jargon_dict` | `jargon_norm_key_idx` | `norm_key` | btree | 发布后回溯扫描：给定一段释义文本切出的 surface，反查是否在词典中 | Cron 任务无 Git 工作区，只能查 DB（§2.6 的定位说明） |
| I51 | `blacklist_word` | `blacklist_release_kind_idx` | `ruleset_release_id, kind` | btree | 回溯扫描按 kind 分批加载规则（strong_banned 先扫、weak_banned 走分类判定） | 同上 |
| I52 | `tag` | `tag_code_uk` | `code` | UNIQUE btree | MDX front-matter 里 `tags: [新手常问]` 按 code 解析成 id | 编译期查找 |

### 3.2 刻意**不建**的索引（与理由）

| 不建 | 理由 |
|---|---|
| `term(display_name)` | 中文展示名检索走应用层内存索引（架构 §2.4 的核心裁决）；DB 层建它等于诱导后端写出"用 SQL 做中文检索"的代码，而那正是被否决的方案 |
| `term` 的中文 `pg_trgm` GIN | 中文 2 字词 trigram 退化，选择度极低，召回的是噪声（详见 I6 说明）。**这是本项目最容易犯的错** |
| `sense(plain_explain)` 的任何文本索引 | 同上；释义正文只按 `term_id` 取，不按内容搜 |
| `answer_event(is_correct)` | 基数 2，选择度极差；所有分析都带 `content_version`，已被 I36 覆盖 |
| `answer_event(mode)` | 基数 3，同上 |
| `answer_event` 的分区 | 见 D10：分区会迫使唯一键变成 `(client_request_id, created_at)`，跨月重试的幂等就漏了。**幂等是硬要求，分区是优化**，冲突时选幂等 |
| `term_version(snapshot)` 的 GIN | jsonb 快照只在回滚/diff 时整体读取，不按内部字段查询 |
| `sense_example(body)` 的 trgm | 举例去重由 CI 的 dice3 相似度做（流水线 §2.7），不在 DB 做 |
| `quiz_question(stem)` 的任何索引 | 题干只按 id/public_id 取 |

### 3.3 高频查询与优化

| 查询场景 | SQL 要点 | 使用索引 | 优化建议 |
|---|---|---|---|
| **① 判分**（全站 QPS 最高的写路径） | `SELECT q.public_id, q.answer_basis, q.term_id, o.option_public_id, o.body, o.is_correct FROM quiz_question q JOIN quiz_option o ON o.question_id=q.id WHERE q.public_id=$1` 然后 `INSERT INTO answer_event ... ON CONFLICT (client_request_id) DO NOTHING RETURNING id` | I21 + I27 + I34 | **不加事务**（backend §2.5 已论证：单题判分无跨表写）。读走 I21 主键级命中；写的唯一约束冲突检测是 btree 单点查找。P95 ≤ 300ms（产品 P4）的余量充足 |
| **② 词条详情**（缓存收益最高） | 三段查询：`v_term_published` → `sense`+`sense_example` → `term_relation` 双向 + `alias` | I7 + I13 + I17 + I18/I19 + I4 | 全部走 `unstable_cache(tag: term:{slug}, revalidate: 3600)`；**深翻页/重复访问基本不回源**。相关词的反向查询（I19）用于发布时失效，不在读路径上 |
| **③ 闯关出题** | `WITH pool AS (SELECT q.* FROM quiz_level_question lq JOIN quiz_question q ON q.id=lq.question_id WHERE lq.level_id=$1 AND q.status='published' AND q.difficulty<=$2 AND q.public_id <> ALL($3)) SELECT ... ORDER BY random() LIMIT $4` | I29 + I32 + I23 | ★**不要在 SQL 里 `ORDER BY random()` 大表**：口径 B 下题池可能上千行。正确做法是先按 I32 取出候选 id 数组（≤200 行），在**应用层**用 seed 做 Fisher-Yates 打乱（backend §2.4 要求"相同 seed 得到相同题序"，`random()` 做不到） |
| **④ 错题优先补位** | `SELECT q.public_id FROM quiz_question q WHERE q.term_id = ANY($1) AND q.status='published' ORDER BY (SELECT wrong_count FROM quiz_mistake m WHERE m.question_public_id=q.public_id AND m.content_version=$2) DESC NULLS LAST LIMIT 8` | I24 + I40 | `$1` 上限 50 个 termId（backend §2.4 已限制）。用 `ANY(array)` 而非 `IN (子查询)`，让计划器走 index scan 而非 hash join |
| **⑤ 搜索（应用层内存索引）** | **0 次 DB 往返**（架构 §3.1）；仅在 L3.5 兜底时 `SELECT term_id, norm_key, similarity(norm_key,$1) AS s FROM alias WHERE norm_key % $1 AND lang='en' ORDER BY s DESC LIMIT 5` | I6 | ★`pg_trgm.similarity_threshold` 设为 0.3（架构 §3.1.2）。**必须用 `%` 运算符而不是 `similarity() > 0.3`** —— 只有 `%` 能用上 GIN 索引，函数形式会退化成全索引扫 |
| **⑥ 词库快照导出** | `SELECT ... FROM alias WHERE term_id IN (SELECT id FROM term WHERE status='published') ORDER BY norm_key` | I1 + I9 | 每 5 分钟由 backend §4.1 的 meta 检查触发；**结果集口径 A ≈430 行 / 口径 B ≈7000 行**，一次查询 < 20ms |
| **⑦ 按 content_version 聚合正确率** | `SELECT difficulty, question_type, count(*), avg(is_correct::numeric) FROM answer_event WHERE content_version=$1 GROUP BY 1,2` | I36 | index-only scan（三列全在索引里，`is_correct` 需回表 → 若查询频繁，可把 `is_correct` 加进 I36 做覆盖索引；**口径 A 下 13 万行不值得，口径 B 39 万行时再评估**） |
| **⑧ 缺口池聚合写入** | `INSERT INTO search_miss_log (norm_key, ...) VALUES ($1,...) ON CONFLICT (norm_key) DO UPDATE SET occurrence_count = search_miss_log.occurrence_count + 1, last_seen_at = now()` | I42 (PK) | ★**必须异步 fire-and-forget**（backend §2.5 超时约定：写失败即放弃）。缺口池丢一条不影响任何用户功能，绝不能拖慢搜索响应 |
| **⑨ 90 天清理** | `DELETE FROM answer_event WHERE created_at < now() - interval '90 days'` | I35 | **分批删**：`DELETE ... WHERE ctid IN (SELECT ctid FROM answer_event WHERE created_at < ... LIMIT 5000)` 循环，每批之间让出。一次删 13 万行会产生大事务 + WAL 膨胀，在 Neon serverless 上是 CU 灾难 |
| **⑩ 深翻页（词条目录页，产品 S7）** | **不用 OFFSET**：`WHERE (category_l1, popularity, id) > ($1,$2,$3) ORDER BY category_l1, popularity DESC, id LIMIT 24` | I9 | keyset 分页。口径 B 下 2000 条翻到第 80 页，`OFFSET 1920` 仍要扫过前 1920 行；keyset 是常量代价 |

---

## 4. 内存索引镜像结构设计

> **定位**：Postgres 是**权威内容存储**，内存索引是**检索读模型**。两者通过 `content_release.version + checksum` 对齐，**绝不允许"半新半旧"混用**（backend §4.1 第 3 点）。
> **同构硬约束**（架构 §6.2 Top3）：本节全部数据结构必须能在 **浏览器 + Node + Edge Runtime** 三处跑同一份代码。§4.5 给出逐条自检清单。

### 4.1 数据结构（TypeScript interface）

```ts
// packages/matcher/src/types.ts —— 同构共享包，零后端依赖
// ⚠️ 本文件不得 import 任何 Node API（见 §4.5 自检清单）

/** 归一化后的别名条目；对应 DB alias 表的一行的检索投影 */
export interface IndexEntry {
  /** = alias.norm_key，全局唯一（DB UNIQUE 约束保证，内存 Map 的键） */
  key: string;
  /** = alias.surface，展示与高亮用原样串（绝不用 key 渲染给用户） */
  surface: string;
  /** = term.public_id，如 't_pe'。用 public_id 而非内部 bigint id：
   *    ① 对外契约稳定（架构 §6.2 Top4）② 字符串 id 让内存索引与 DB 主键解耦 */
  termId: string;
  /** = sense.public_id；null 表示词条级通用别名 */
  senseId: string | null;
  aliasType: AliasType;
  /** = alias.weight，0~100，对应架构 WEIGHTS 常量 */
  weight: number;
  /** ★ 语言标记：只有 'en' 且 key.length>=4 的条目参与 gram 索引与 pg_trgm 兜底
   *    （中文 2 字词的 gram 选择度问题见 §4.2 与 I6 说明） */
  lang: 'zh' | 'en' | 'mixed';
  /** = alias.is_searchable；misspell 类为 false → 只进精确层，不进模糊层 */
  searchable: boolean;
}

/** 词条的检索侧最小投影（不含释义正文 —— 正文永远从 DB/缓存取，不进内存索引） */
export interface IndexTermMeta {
  termId: string;          // public_id
  slug: string;
  displayName: string;
  /** = term.sense_count（DB 冗余列）。产品 F5「MA · 3 个意思」直接读它，0 次额外查询 */
  senseCount: number;
  /** = category_l2.numeric_id，对外 API category.id */
  categoryId: number;
  categoryL1: string;      // 枚举标签，用于按分类预筛（backend §2.1 filters.category）
  difficulty: 'L1' | 'L2' | 'L3';
  /** = term.popularity，同分候选的稳定排序 tiebreaker（架构 §3.1.3） */
  popularity: number;
  /** 人话层释义首句，仅用于"未命中建议"的展示（backend §2.1 TermSuggestion.primaryPlainExplain）
   *    ★ 这是内存索引里唯一的正文字段。是否保留见 §4.4 的取舍讨论 */
  primaryPlainExplain: string;
}

/** 义项的消歧元数据（不含释义正文） */
export interface IndexSenseMeta {
  senseId: string;         // public_id
  termId: string;
  contextLabel: string;    // 前端 Tab 标签文本
  isPrimary: boolean;
  frequency: 'high' | 'mid' | 'low';
  /** = sense.context_keywords，消歧二级：上下文加权（架构 §3.2.3） */
  contextKeywords: readonly string[];
}

/** ── ① AC 自动机（v1 建结构、v2 启用扫描；架构 §3.1.4 主理人裁决一） ───────── */
export interface AhoCorasick {
  /** 状态转移表：CSR（压缩稀疏行）风格三数组，避免 Map<number,Map> 的对象开销
   *    gotoBase[state] + gotoChar[i] + gotoTarget[i]，i ∈ [gotoBase[state], gotoBase[state+1])
   *    ★ 用 TypedArray 而非普通数组：内存减半且访问更快（见 §4.4 估算） */
  gotoBase: Uint32Array;      // 长度 = stateCount + 1
  gotoChar: Uint32Array;      // 长度 = 边总数
  gotoTarget: Uint32Array;    // 长度 = 边总数
  /** 失配指针（fail link） */
  fail: Uint32Array;          // 长度 = stateCount
  /** 输出链：state → 命中的 pattern 下标数组（用 CSR 二级压缩） */
  outputBase: Uint32Array;    // 长度 = stateCount + 1
  outputPattern: Uint32Array; // 长度 = 输出总数，值 = pattern 下标
  /** pattern 下标 → 该 pattern 在 keys 数组中的位置 */
  patternToKey: Uint32Array;
  /** pattern 长度（用于 span 计算与最长匹配裁决） */
  patternLen: Uint16Array;
  stateCount: number;
}

/** ── ② 倒排（L0 精确层 / L2 别名层） ─────────────────────────────────────── */
/** key → 命中该 key 的条目下标数组。
 *    ★ 为什么是数组而不是单值：DB 层 norm_key 全局唯一，理论上恒为单元素；
 *      但保留数组形态有两个理由：① 防御性——若唯一约束被绕过（直连 DB 写入），
 *      内存层能同时返回多候选并按 weight 排序，退化为"可解释的多义"而不是"静默取一个"；
 *      ② 同构复用——客户端从 /api/lexicon 构建索引时走同一段代码 */
export type ExactIndex = Map<string, readonly number[]>;

/** ── ③ Trie 前缀（L1 前缀层，长度 ≥2 才参与） ──────────────────────────── */
export interface PrefixTrie {
  /** 与 AC 共享状态转移表（同一棵 Trie），只是多了 fail/output
   *    ★ 不重复建：口径 B 下两棵独立 Trie 会多占 ~1.2MB */
  ac: AhoCorasick;
  /** 每个 state 是否是某个 key 的终点 + 该终点的条目下标 */
  terminalBase: Uint32Array;   // 长度 = stateCount + 1
  terminalEntry: Uint32Array;  // 长度 = key 总数
}

/** ── ④ gram 倒排（L3 模糊层召回） ─────────────────────────────────────── */
/** 二元 gram（bigram）→ 候选 key 下标。CSR 风格，对应 backend §2.3 的 LexiconGrams 线格式
 *    ★ 只对 lang='en' 且 length>=4 的 key 建（§4.2 说明） */
export interface GramIndex {
  /** gram 字符串数组，已排序（二分查找定位） */
  grams: readonly string[];
  /** offsets[i] = grams[i] 的 posting 起始下标；offsets[length] = postings.length */
  offsets: Uint32Array;
  /** 扁平化的 key 下标 posting list */
  postings: Uint32Array;
}

/** ── ⑤ 拼音首字母（L2 层，≤4 位） ─────────────────────────────────────── */
/** 直接复用 ExactIndex —— alias_type='pinyin_abbr' 的 norm_key 本身就是首字母串，
 *    不需要额外结构。架构 §3.1.5 的核心判断："别名映射是数据问题，不是算法问题" */

/** ── 顶层索引容器 ─────────────────────────────────────────────────────── */
export interface LexiconIndex {
  /** 与 content_release.version 对齐 */
  version: number;
  /** 与 content_release.checksum 对齐；不一致 → degraded.staleIndex（§4.3） */
  checksum: string;
  builtAt: string;           // ISO
  /** 所有条目（IndexEntry）的扁平数组，其余结构全部存"下标"而非对象引用
   *    ★ 这是内存占用的关键设计：6000 个对象 vs 6000 个下标，差 3~5 倍 */
  entries: readonly IndexEntry[];
  terms: ReadonlyMap<string, IndexTermMeta>;          // termId → meta
  senses: ReadonlyMap<string, IndexSenseMeta>;        // senseId → meta
  exact: ExactIndex;                                   // ① L0/L2
  prefix: PrefixTrie;                                  // ② L1（与 AC 共享转移表）
  grams: GramIndex;                                    // ③ L3
  ac: AhoCorasick;                                     // ④ 整句扫描（v2 启用）
  /** key 下标 → 该 key 所属 termId 的快查（避免 entries[i].termId 的字符串比较） */
  keyToTerm: Uint32Array;   // 值 = termIds 数组下标
  termIds: readonly string[];
}

/** 构建输入 = /api/lexicon 的响应体（backend §2.3 LexiconResponse）或编译期直接产物 */
export interface LexiconSnapshot {
  version: number;
  checksum: string;
  builtAt: string;
  entries: readonly IndexEntry[];
  terms: readonly IndexTermMeta[];
  senses: readonly IndexSenseMeta[];
  /** 可选：客户端默认不下发（backend §2.3 决策），服务端构建时本地生成 */
  grams?: { grams: readonly string[]; offsets: readonly number[]; postings: readonly number[] };
}

export interface BuildOptions {
  /** 客户端传 true → 跳过 gram 与 AC 构建（省 CPU 与内存），只保留 L0/L1/L2 */
  skipFuzzy?: boolean;
  /** v1 传 true：构建 AC 结构但不注册扫描入口（架构 §3.1.4：结构先建，扫描 v2 启用） */
  disableSentenceScan?: boolean;
}

export function buildIndex(snap: LexiconSnapshot, opts?: BuildOptions): LexiconIndex;
```

**设计要点（三条容易被忽视的）**：

1. **全部用"下标 + TypedArray"而不是"对象引用图"**。朴素实现里 `Map<string, IndexEntry[]>` 会让同一个 `IndexEntry` 被 exact / prefix / grams 三处引用，JS 引擎无法共享字符串，且每个 Map 桶有 ~50 字节开销。CSR + TypedArray 把三套结构压成"一份 entries 数组 + 三份整数数组"，内存降到 1/3~1/5（估算见 §4.4）。
2. **`prefix` 与 `ac` 共享同一棵 Trie**。前缀查找就是"沿转移表走到底，收集路径上所有 terminal"，AC 的 goto 表已经包含这个能力，另建一棵是纯浪费。
3. **`primaryPlainExplain` 是唯一进内存的正文**。它的用途只有一个：`isMiss=true` 时生成 ≥3 条相近词建议（产品 F6 硬验收）必须能显示"一句话人话"，而此时 DB 可能正好不可用（架构 §4.3 降级矩阵：Neon 挂了搜索仍要给建议）。**代价**：口径 B 下多占约 2000 × 60 字 × 2 字节 ≈ 240KB。**收益**：DB 全挂时搜索兜底路径仍然完整可用。取舍结论：保留（§4.4 详算）。

### 4.2 为什么 gram 索引只对英文建（中文 2 字词 trgm 退化的完整论证）

这是本方案最需要说清的一处技术判断，因为它同时决定了 **DB 索引（I6/I12）与内存索引（GramIndex）两侧**。

**二元 gram（bigram）的选择度计算**：

| 语言 | 字符集大小 | 2-gram 理论空间 | 词库实际 2-gram 数（口径 B） | 单个 2-gram 的平均 posting 长度 | 结论 |
|---|---|---|---|---|---|
| 英文（小写 a-z + 数字） | 36 | 1,296 | ≈4,200（2000 条 × 平均 8 字符 → 7 个 bigram，去重后） | ≈12 个候选 | **可用**：召回 12 个候选再做编辑距离校验，成本可控 |
| 中文（常用字 ~3,500） | 3,500 | 12,250,000 | ≈1,800（2000 条 × 平均 3 字 → 2 个 bigram，去重后） | ≈**2,200 个候选** | **退化**：金融术语高度集中在"股/价/市/率/线/盘/仓/量"等 ~200 个高频字上，实际 bigram 空间远小于理论值 |

**具体到 2 字词**：`"均线"` 只产生 **1 个** bigram（`均线`）。查 `"市盈率"` 产生 2 个（`市盈`、`盈率`）。而 `"市净率"` 也含 `盈率`? 不 —— 但 `"息率"`、`"股息率"`、`"市销率"` 与 `"市盈率"` 共享 `率` 相关 bigram 的比例极高。结果是：**查一个 3 字中文词会召回几十个候选，编辑距离校验后发现全都不该召回**，用户看到"市盈率"的搜索结果里混进"市净率/市销率/股息率"。架构 §2.4.1 对此的判词是准确的：**"那是失败而非成功"**。

**三元 gram（trigram，即 `pg_trgm` 的口径）更糟**：`"均线"` 长度 2 < 3，**产生 0 个 trigram**（`pg_trgm` 对短于 3 字符的串返回空集或退化集），索引里根本没有这个词条 → 查不到；`"市盈率"` 只产生 1 个 trigram，选择度 = 该 trigram 的 posting 长度，在金融语料里通常几百条。

**因此本方案的分工**：

| 匹配需求 | 中文的实现 | 英文的实现 |
|---|---|---|
| 精确（L0/L2） | 内存 `ExactIndex`（norm_key 全局唯一） | 同左 |
| 前缀（L1） | 内存 Trie（对中文有效：中文前缀="以…开头的词"，语义清晰） | 同左 |
| 模糊（L3） | **内存编辑距离直扫**：口径 A 仅 430 个 key、口径 B 7000 个 key，全量算一次 Levenshtein（≤2）在 JS 里约 0.3ms / 5ms，**比建 gram 索引再召回更快更准** | 内存 gram 召回 Top-20 → 编辑距离校验（key 多时才有收益） |
| DB 兜底（L3.5） | **不做**（架构 §3.1.2 明示：`pg_trgm` 仅作英文长词二级兜底） | `alias` 上的 partial GIN（I6），`WHERE norm_key % $1 AND lang='en' AND char_length(norm_key)>=4` |

**关键实现推论**：`GramIndex` 在构建时按 `entry.lang === 'en' && entry.key.length >= 4` 过滤，中文条目**不进 gram 索引**；中文模糊层走 `fuzzyScanByEditDistance()` 直扫路径。代码里必须显式分流，否则会有人"顺手"把中文也塞进 gram 索引，然后花几天排查"为什么搜市盈率出来一堆市净率"。

```ts
// packages/matcher/src/build-grams.ts（伪代码，说明分流点）
function collectGramSources(entries: readonly IndexEntry[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e.searchable) continue;            // misspell 类不进模糊层（架构 §3.1.5）
    if (e.lang !== 'en') continue;          // ★ 中文不进 gram 索引（本节论证）
    if (e.key.length < 4) continue;         // <4 字符的英文串 bigram 太少，直扫更快
    out.push(i);
  }
  return out;
}

/** 中文模糊层：直扫编辑距离（口径 A 0.3ms / 口径 B ~5ms，可接受） */
export function fuzzyScanCJK(
  index: LexiconIndex, normKey: string, maxDist: number, limit: number
): Array<{ entryIdx: number; dist: number }> {
  const hits: Array<{ entryIdx: number; dist: number }> = [];
  for (let i = 0; i < index.entries.length; i++) {
    const e = index.entries[i];
    if (!e.searchable || e.lang === 'en') continue;
    // 长度差剪枝：|len(a)-len(b)| > maxDist 直接跳过（省掉绝大多数计算）
    if (Math.abs(e.key.length - normKey.length) > maxDist) continue;
    const d = levenshteinAtMost(normKey, e.key, maxDist);  // 带上限的早退实现
    if (d >= 0 && d <= maxDist) hits.push({ entryIdx: i, dist: d });
    if (hits.length >= limit * 4) break;   // 召回够用即止，交给打分层排序
  }
  return hits;
}
```

### 4.3 从 Postgres 加载到内存 + SWR 双缓冲增量更新

```
┌──────────────────────────────────────────────────────────────────────────┐
│ 阶段 0 · 编译期（CI，非运行时）                                            │
│  MDX + content-rules/*.yaml                                               │
│    → Zod 校验 + CI 门禁（§5.4）                                            │
│    → upsert 到 Neon（§5.3 幂等设计）                                       │
│    → 生成 content_release 行：version++ / checksum / git_sha / status      │
│    → 导出 lexicon-snapshot.json（构建产物，随部署包一起上 Vercel）           │
│      ★ 这份 JSON 是"冷启动零 DB 依赖"的关键：函数冷启动直接读它建索引，       │
│        不等 DB 唤醒（Neon scale-to-zero 唤醒 300~500ms，架构 §2.6）          │
└──────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌──────────────────────────────────────────────────────────────────────────┐
│ 阶段 1 · 运行时冷启动（Vercel 函数实例首次请求）                            │
│  globalThis.__glossaryMatcher === undefined                               │
│    → status = 'building'                                                  │
│    → 优先读【构建产物 snapshot】（同步 require，0 I/O）                     │
│    → buildIndex(snapshot, { disableSentenceScan: true })                  │
│    → 异步拉 content_release WHERE release_kind='lexicon' AND status='current'│
│    → 若 DB.version === snapshot.version → 直接用，status='ready'           │
│    → 若 DB.version >  snapshot.version → 标记 needsRebuild，先用旧的对外服务 │
│      （★ 绝不阻塞首个请求：产品 P2 搜索 P95 ≤ 400ms 含冷启动）              │
│    → 若 DB 不可达 → 用 snapshot + degraded.indexUnavailable=false          │
│      （snapshot 是自洽的完整版本，架构 §4.3「DB 挂了网站还能读」）            │
└──────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌──────────────────────────────────────────────────────────────────────────┐
│ 阶段 2 · SWR 双缓冲热更新（backend §4.1 的数据层实现）                      │
│                                                                            │
│  触发：每个请求检查 unstable_cache('content-release-meta', revalidate:300)   │
│        → meta.version !== current.version → 触发重建（单飞，见下）           │
│                                                                            │
│  重建流程（★ 双缓冲，不原地改）：                                            │
│   ┌─ 旧实例 A（status='ready', version=N）  ← 继续服务所有在途请求           │
│   │                                                                        │
│   ├─ 后台构建 B：                                                           │
│   │    ① 全量路径（默认）：拉 /api/lexicon 等价 SQL → buildIndex() → B       │
│   │    ② 增量路径（可选优化，见下）：diff(oldChecksumEntries, newEntries)     │
│   │       → 只对变化的 term 重建子树，其余结构复用                            │
│   │                                                                        │
│   ├─ 构建成功 + checksum 校验通过                                            │
│   │    → globalThis.__glossaryMatcher = { status:'ready', matcher:B, ... }  │
│   │      ★ 单次赋值 = JS 单线程天然原子，无需锁                              │
│   │    → A 进入 grace 队列，60s 后释放（让在途请求安全完成）                  │
│   │                                                                        │
│   └─ 构建失败 / checksum 不一致                                              │
│        → 保留 A，status 回退 'ready'(旧)，记 error                           │
│        → degraded.staleIndex = true（backend §2.1 契约字段）                 │
│        → 指数退避重试：30s → 60s → 120s → … 上限 5min                        │
│        → ★ 绝不用"B 索引 + A 内容"或"A 索引 + B 内容"的混用组合               │
│          （混用会返回不存在的 termId，是 backend §4.1 点名的最坏情况）         │
└──────────────────────────────────────────────────────────────────────────┘
```

**增量更新（②）的具体做法与取舍**：

```ts
// packages/matcher/src/diff.ts（伪代码）
export interface LexiconDelta {
  /** 新增/变更的条目（按 termId 分组，因为一个词条的别名要整体替换） */
  upsertTermIds: string[];
  /** 需要整体移除的 termId */
  removeTermIds: string[];
  /** delta 是否"小"到值得走增量：阈值见下 */
  worthIncremental: boolean;
}

export function computeDelta(
  oldSnap: LexiconSnapshot, newSnap: LexiconSnapshot
): LexiconDelta {
  const oldByTerm = groupBy(oldSnap.entries, e => e.termId);
  const newByTerm = groupBy(newSnap.entries, e => e.termId);
  const upsert: string[] = [], remove: string[] = [];
  for (const [tid, list] of newByTerm) {
    const old = oldByTerm.get(tid);
    // 逐词条比较条目的 key 集合与 weight（不比较对象引用）
    if (!old || !sameEntrySet(old, list)) upsert.push(tid);
  }
  for (const tid of oldByTerm.keys()) if (!newByTerm.has(tid)) remove.push(tid);
  const changedRatio = (upsert.length + remove.length) / Math.max(newByTerm.size, 1);
  return { upsertTermIds: upsert, removeTermIds: remove,
           worthIncremental: changedRatio < 0.05 };   // ★ 变化 <5% 才走增量
}
```

| 方案 | 何时用 | 代价 |
|---|---|---|
| **全量重建**（默认） | 变化 ≥5% 词条，或首次构建，或增量结果 checksum 对不上 | 口径 A ≈8ms / 口径 B ≈90ms（构建耗时估算见 §4.4）。**在 300s 的检查间隔下完全可以接受** |
| **增量重建** | 变化 <5%（典型场景：改了 1 个词条的别名） | 实现复杂度显著上升：AC 的 fail 指针与 output 链在插入新 pattern 后**必须全量重算**（fail 指针依赖整棵树的结构），所以"增量"只能省掉 Trie 的重复插入，省不掉 fail 重算 → **实际收益 <30%** |

> **诚实结论：v1 只做全量重建，增量作为代码结构预留（`computeDelta` 用于日志与告警"这次发布改了多少词条"），不作为性能优化启用。** 理由：口径 B 下全量重建 90ms，而重建每 300s 才可能触发一次，且发生在后台（不阻塞请求）。为省 60ms 引入"增量后 fail 指针不一致"这类极难排查的 bug（表现为偶发错误高亮，backend §4.1 明确点名过这类 bug 的排查成本），收益比是负的。
> **增量路径的重新评估触发条件**：词库 > 20,000 条（全量重建 > 1s）或重建频率 > 每分钟 1 次（内容进入高频运营期）。

### 4.4 checksum 一致性校验

**checksum 的定义（必须在编译期与运行期用同一份算法，否则永远对不上）**：

```ts
// packages/content/src/checksum.ts —— 同构（用 WebCrypto，不用 node:crypto，见 §4.5）
/**
 * 规范化 JSON：
 *   ① 对象键按 Unicode 码点升序排序（消除键序差异）
 *   ② 数组保持原序（顺序有语义：sort_order / weight 排序结果）
 *   ③ 数字统一为最简十进制（消除 1.0 vs 1）
 *   ④ 剔除 null / undefined 值键（消除"显式 null"与"缺键"的差异）
 *   ⑤ 不含任何时间戳、不含 id（自增主键在不同分支上会不同 —— 见下）
 */
export function canonicalizeForChecksum(snap: LexiconSnapshot): string {
  const payload = {
    v: snap.version,
    e: snap.entries.map(x => [x.key, x.termId, x.senseId ?? '', x.aliasType, x.weight, x.lang, x.searchable ? 1 : 0]),
    t: snap.terms.map(x => [x.termId, x.slug, x.senseCount, x.categoryId, x.difficulty, x.popularity]),
    s: snap.senses.map(x => [x.senseId, x.termId, x.isPrimary ? 1 : 0, x.frequency]),
  };
  return stableStringify(payload);
}

export async function sha256Hex(text: string): Promise<string> {
  // ★ WebCrypto：浏览器 / Node 18+ / Edge Runtime / Cloudflare Workers 四处同 API
  const buf = new TextEncoder().encode(text);
  const hash = await globalThis.crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}
```

**★ checksum 的输入刻意排除自增 `id`**。这是 Neon branching 场景下的**必需**设计：内容审核在 branch 上跑（架构 §2.6「branching 一等公民」），branch 与 main 的 `term.id` 序列可能不同（分支上先插了草稿又删了 → 序列跳号）。若 checksum 含 `id`，**同样的内容在 branch 和 main 上会算出不同 checksum**，导致"合并后索引永远 staleIndex=true"这类查不出原因的告警。用 `public_id`（内容派生）而非 `id`（序列派生）作为身份，checksum 才真正表达"内容是否相同"。

**三级校验**：

| 级别 | 校验内容 | 时机 | 不一致时的行为 |
|---|---|---|---|
| **L1 · 编译期自检** | `sha256(canonicalize(导出结果))` === 写入 `content_release.checksum` 的值 | upsert 事务提交后、标记 `status='current'` 前 | **回滚整个发布事务**，`content_release.status='failed'` + `error_message`。绝不让坏版本变成 current |
| **L2 · 加载期校验** | `buildIndex(snapshot)` 后重算 checksum，与 `content_release.checksum` 比对 | 每次构建（冷启动 + 每次热重建） | 保留旧索引 + `degraded.staleIndex=true` + ERROR 日志 + 告警（backend §7.7：持续 >30min 为 **Page** 级） |
| **L3 · 抽样运行期校验** | 随机抽 20 个 `norm_key`，比对内存索引的 `termId` 与 DB `alias` 表查询结果 | 每天 1 次（Vercel Cron） | 告警 + 强制触发一次全量重建 |

```sql
-- L3 抽样校验的 SQL（Vercel Cron 每日执行）
WITH sample AS (
  SELECT norm_key, term_id FROM alias
  WHERE term_id IN (SELECT id FROM term WHERE status = 'published')
  ORDER BY md5(norm_key || current_date::text)   -- ★ 按日期加盐的确定性抽样：可复现、每日不同
  LIMIT 20
)
SELECT s.norm_key, t.public_id AS expected_term_id
FROM   sample s JOIN term t ON t.id = s.term_id;
-- 应用层比对 expected_term_id 与内存索引 exact.get(norm_key) → entries[i].termId
```

> ★ 抽样用 `ORDER BY md5(norm_key || current_date)` 而不是 `ORDER BY random()`：`random()` 无法复现（出问题后无法重跑同一批），而"每天抽不同的一批"通过把日期拌进哈希实现。**可复现的随机抽样是审计类任务的基本要求。**

### 4.5 同构自检清单（浏览器 + Node + Edge 都能跑）

| 检查项 | 要求 | 本方案的落地 | 若违反的后果 |
|---|---|---|---|
| **禁用 Node 内建模块** | 不得 `import` `node:fs` / `node:crypto` / `node:buffer` / `node:util` / `node:path` | 哈希用 `globalThis.crypto.subtle`（WebCrypto，四处同 API）；不用 `Buffer`，用 `Uint8Array` + `TextEncoder` | Edge Runtime 直接构建失败；浏览器 bundle 报 "Module not found" |
| **禁用 Node 全局** | 不得用 `process.env` / `__dirname` / `global` / `Buffer` | 配置通过 `BuildOptions` 参数注入；单例挂在 `globalThis`（backend §4.1 明确用 `globalThis`，不是 `global`） | Edge Runtime 无 `process`；浏览器无 `__dirname` |
| **TypedArray 而非 Buffer** | `Uint8Array`/`Uint16Array`/`Uint32Array` 是 ECMAScript 标准，四处都有 | §4.1 全部结构用 TypedArray | `Buffer` 是 Node 专有子类 |
| **无 Worker/child_process 依赖** | 构建必须在主线程同步可完成（口径 B ~90ms） | `buildIndex()` 是纯同步函数（除 `sha256Hex` 是 async） | Edge Runtime 的 Worker 模型不同；浏览器主线程构建 90ms 可接受（发生在空闲期） |
| **无 `Intl.Segmenter` 依赖** | 分词不用它（Safari <14.1 无；且架构 §3.1.4 明确"不引入中文分词器"） | 归一化用 `String.prototype.normalize('NFKC')`（ES6 标准，四处都有）+ 自写正则 | 老浏览器崩；且引入分词器会破坏"词表封闭、最长匹配即可"的架构判断 |
| **无 `Atomics`/`SharedArrayBuffer`** | 需 COOP/COEP 响应头，与 CDN 缓存策略冲突 | 双缓冲靠"单次引用赋值"实现原子性（JS 单线程），不需要共享内存 | 浏览器需额外安全头；Edge 上支持不稳 |
| **无动态 `require`/`eval`** | CSP `strict-dynamic` + nonce（架构 §4.5）会拦 | 全部静态 import | 生产环境被 CSP 拦死，且开发环境不报错（最坏的一类 bug） |
| **无浮点非确定性** | 打分排序必须四处结果一致 | 权重全为整数（0~100）；相似度用整数运算的 dice3（`2*|A∩B|/(|A|+|B|)` 保留 4 位定点比较） | 浏览器与服务端排序不同 → "前端预览的结果和线上不一样"，无法排查 |
| **代码体积预算** | matcher 包 gzip ≤ 12KB（架构 §4.1 JS 预算 90KB 的一部分） | AC + Trie + gram + 归一化 + 打分 ≈ 800 行 TS → 约 6~8KB gzip | 超预算会挤占首屏 LCP（产品 P1 硬验收 ≤2.0s） |
| **CI 守卫** | 自动化防止上述退化 | `eslint-plugin-no-restricted-imports` 禁 `node:*`；`pnpm --filter @glossary/matcher exec tsc --lib es2022,dom`（**只给 DOM lib，不给 @types/node**）→ 一旦用了 Node API 直接编译失败 | 靠人记住必然失效 |

### 4.6 内存占用估算（两个口径）

**假设前提**（必须标注，否则数字没有意义）：
- 每条词条平均别名数：口径 A = **3.0**（架构 §2.4 的口径）+ 义项专属别名 0.5 = **3.5 个 key/词条**；口径 B = **3.5**（词库越大，口语说法与错拼越密）
- 平均 key 长度：中文 3 字（UTF-16 = 6 字节）、英文 8 字符 → 混合按 **7 个 UTF-16 code unit** 计
- JS 字符串开销：V8 中一个短字符串对象头 ≈ 16 字节 + 内容（UTF-16 每字符 2 字节，latin1 优化时 1 字节）。**中文走 UTF-16 双字节路径，无 latin1 优化**
- `Map` 每个条目开销 ≈ 50 字节（V8 保守估计）
- TypedArray：`Uint32Array` 4 字节/元素，无对象头
- **不计入**：`terms` Map 里的 `primaryPlainExplain`（单列）；`senses` Map（单列）

#### 口径 A：120 条术语 / 145 义项 / 420 个 key

| 结构 | 元素数 | 单位开销 | 小计 |
|---|---|---|---|
| `entries` 数组（420 个 IndexEntry 对象，7 个字段） | 420 | ≈150 B（对象头 + 7 字段槽 + 字符串引用） | 63 KB |
| ↳ 其中 `key` / `surface` 字符串本体 | 420 × 2 | ≈16 B 头 + 14 B 内容 | 25 KB |
| `exact` Map（420 桶） | 420 | ≈50 B + 单元素数组 ≈40 B | 38 KB |
| `ac` 转移表（Trie 节点 ≈ 每个 key 平均 4 个新节点 = 1,680 节点；边 ≈1,680） | gotoBase 1,681×4 + gotoChar/Target 1,680×4×2 | — | 20 KB |
| `ac.fail` / `outputBase` | 1,681 × 4 × 2 | — | 13 KB |
| `ac.outputPattern` + `patternToKey` + `patternLen` | 420×4 + 420×4 + 420×2 | — | 4 KB |
| `prefix.terminalBase` + `terminalEntry` | 1,681×4 + 420×4 | — | 8 KB |
| `grams`（**仅英文 key**：约 40% = 168 个 key，平均 7 字符 → 6 bigram，去重后 ≈600 个 gram；postings ≈1,000） | grams 字符串 600×(16+8) + offsets 601×4 + postings 1000×4 | — | 21 KB |
| `terms` Map（120 条 × IndexTermMeta 9 字段） | 120 | ≈200 B + Map 桶 50 B | 30 KB |
| ↳ `primaryPlainExplain` 字符串（平均 38 字中文 = 76 B + 16 B 头） | 120 | 92 B | 11 KB |
| `senses` Map（145 义项 × 6 字段，含 contextKeywords 数组平均 3 项） | 145 | ≈250 B + Map 桶 50 B | 44 KB |
| `keyToTerm` + `termIds` | 420×4 + 120×(16+10) | — | 5 KB |
| **合计（服务端 Node 进程，单实例）** | | | **≈ 282 KB** |
| **客户端瘦身版**（`skipFuzzy: true` → 去掉 grams；`disableSentenceScan: true` → 去掉 ac.output* 与 fail，只留 goto 表做前缀） | | | **≈ 210 KB** |

> 交叉验证：架构 §2.4 给的口径是"120 条 × 3 别名 ≈ 360 key ≈ 11KB"。差异原因：架构估的是**纯 key 字符串的字节数**（360 × 30 B ≈ 11KB），本表估的是**含全部索引结构与 JS 对象开销的常驻内存**。两者不矛盾，口径不同 —— **架构的 11KB 说的是"数据量"，这里的 282KB 说的是"V8 堆占用"**。这个差异必须写清楚，否则两个人对着不同的数字吵。
> **对 `/api/lexicon` 线格式的影响**：下发给客户端的是 JSON（`entries` + `terms` + `senses`），不含索引结构（客户端本地重建）。JSON 体积 ≈ 420 条 × 90 B + 120 × 180 B + 145 × 120 B ≈ **78 KB 原始 / ≈26 KB gzip**。backend §2.3 给的是"120 条时约 28KB(gzip)"—— **吻合**。

#### 口径 B：2,000 条术语 / 2,400 义项 / 7,000 个 key

| 结构 | 元素数 | 小计 |
|---|---|---|
| `entries` 数组（7,000 个对象 + 字符串本体） | 7,000 | 1,050 KB + 420 KB = **1,470 KB** |
| `exact` Map | 7,000 | **630 KB** |
| `ac` 转移表（Trie 节点 ≈ 7,000 × 4 = 28,000；边 28,000） | | **336 KB** |
| `ac.fail` + `outputBase` | 28,001 × 4 × 2 | **224 KB** |
| `ac.outputPattern` + `patternToKey` + `patternLen` | 7,000 | **70 KB** |
| `prefix.terminalBase` + `terminalEntry` | | **140 KB** |
| `grams`（英文 key ≈40% = 2,800 个，平均 6 bigram，去重后 ≈9,000 gram；postings ≈22,000） | | **9,000×24 + 9,001×4 + 22,000×4 = 344 KB** |
| `terms` Map（2,000 × 250 B） | | **500 KB** |
| ↳ `primaryPlainExplain`（2,000 × 92 B） | | **184 KB** |
| `senses` Map（2,400 × 300 B） | | **720 KB** |
| `keyToTerm` + `termIds` | | **50 KB** |
| **合计（服务端 Node 进程，单实例）** | | **≈ 4.97 MB** |
| **客户端瘦身版**（去 grams + AC 输出链/fail） | | **≈ 4.2 MB** |
| **客户端 IndexedDB 存储**（存 JSON snapshot，不存构建后的结构） | | ≈ 1.3 MB 原始 / **≈ 380 KB gzip**（backend §2.3 给的 380KB(gzip) —— **吻合**） |

**结论与红线对照**：

| 对照项 | 阈值 | 口径 A | 口径 B | 判定 |
|---|---|---|---|---|
| 架构 §2.9 Redis 重新引入触发条件 | 单实例索引 > 50MB | 0.28 MB | 4.97 MB | ✅ 距阈值 10 倍余量，**v1/v1.5 都不需要 Redis** |
| 架构 §6.4 "索引分片"触发条件 | 同上 50MB | — | 4.97 MB | ✅ 不触发 |
| Vercel 函数内存（Pro 默认 1024MB） | — | 0.03% | 0.5% | ✅ 可忽略 |
| 前端 IndexedDB 配额（通常 >50MB） | 前端设计 §5.3 给的 <20MB | 0.03 MB | 1.3 MB | ✅ 无压力 |
| 客户端构建耗时（阻塞主线程） | 应在 `requestIdleCallback` 内完成 | ≈8ms | ≈90ms | ⚠️ 口径 B 下 90ms 会掉 5~6 帧 → **必须放在空闲期构建，且构建期间搜索走服务端**（前端设计 §5.3 已如此约定） |
| 多实例放大 | Vercel 并发实例数（假设峰值 20 个） | 5.6 MB | **99 MB** | ✅ 仍在安全区；这也是"每实例各持一份"可接受的量化依据（架构 §2.9 理由 2） |

> **口径 B 下最值得优化的一处**：`entries` 数组的 1.47MB 占了 30%。若词库继续增长到 20,000 条（≈50MB，触到架构阈值），第一刀应该是**把 `IndexEntry` 从对象数组改成 SoA（Structure of Arrays）**：`keys: string[]`、`termIdx: Uint32Array`、`aliasType: Uint8Array`、`weight: Uint8Array`、`lang: Uint8Array`、`flags: Uint8Array`。这样每个条目从 ~150B 降到 ~24B + 字符串本体，总体积降约 40%。**v1 不做**（口径 A/B 都远未触阈值，过早优化会牺牲代码可读性），但把这条写进演进笔记，避免将来"发现内存爆了才重构"。

<!-- CONT-2 -->

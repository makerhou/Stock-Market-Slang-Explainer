# 股票黑话解释器 · 服务端实现方案（API 契约 + 业务逻辑 + 幂等/限流/容错）

> 作者：程不宕（后端服务工程师）｜版本：**v1.0**｜日期：2026-10-20
> 配套文档：《总体架构与技术选型方案》v1.1（梁承宇）、《产品需求与范围定义》v1.0（许可研）
> 本文是**可直接照着写代码的实现契约**。架构选型（Next.js Route Handlers + Neon + 内存词典 + 无 Redis）为已锁定输入，本文不重新选型，只在其之下给出接口级与逻辑级实现。
> **本文不覆盖**：前端页面设计、数据库 DDL、部署运维（分别由前端工程师、数据工程师、架构师负责）。本文会明确标出对**读模型**的字段要求（供数据工程师对齐），但不给 DDL。

---

## 0. 服务与模块结构

### 0.1 服务清单

本项目**没有独立后端服务**。所谓"服务"是同一个 Vercel 产物内的运行时模块，边界靠**依赖方向**而非网络边界保证。

| 模块（运行时单元） | 职责 | 依赖 | 技术栈 | runtime |
|---|---|---|---|---|
| `Route Handlers` `/api/**` | 对外 HTTP 契约、缓存语义、限流、幂等、可观测埋点 | resolver / quiz / db / http-kit | Next.js 16 Route Handler | **Node**（不用 Edge） |
| `Server Actions` `app/**/actions.ts` | 纯内部表单型交互（无对外契约的写操作） | 同上 | React Server Actions | Node |
| `TermResolver` 运行时 | `resolveCandidates`（内存→pg_trgm→v2 LLM）+ `hydrate`（DB 读权威内容） | matcher / db | TS 接口 + 2 个实现 | Node（v2 LLM 也 Node） |
| `Matcher` 单例 | 归一化、L0–L3.5、AC 自动机、裁决层、gram 倒排 | 无（零依赖） | `@glossary/matcher` |  isomorphic |
| `Quiz Engine` | 关卡配置校验、出题编排、判分、去重 | matcher(打乱) / db | `@glossary/quiz` | Node |
| `http-kit` | 统一响应体、错误码、requestId、超时、Zod 解析、限流兜底、日志 | zod | 内部包 | Node |

**运行时统一 Node 的理由（结论 + 理由）**：① 需要 `crypto.timingSafeEqual`、稳定的 `TextEncoder` 行为与可控的 `AbortSignal.timeout`；② Edge isolate 的内存模型会让 200KB 级索引反复冷构建，抖动不可控；③ OG 图（`ImageResponse`）与部分依赖在 Node runtime 行为最可预测。**否决 Edge**：架构已定，且冷启动抖动会直接打脸「搜索 P95 ≤ 400ms」。

### 0.2 目录组织（只列服务端相关）

```
apps/web/src/
├─ app/
│  ├─ api/
│  │  ├─ search/route.ts
│  │  ├─ term/[slug]/route.ts
│  │  ├─ lexicon/route.ts
│  │  ├─ quiz/next/route.ts
│  │  ├─ quiz/answer/route.ts
│  │  ├─ og/term/[slug]/route.ts
│  │  └─ health/route.ts
│  └─ **/actions.ts                # 内部 Server Actions（无对外契约）
├─ server/                         # 仅服务端代码，禁止被 client 组件 import
│  ├─ http/  {respond.ts, errors.ts, request-id.ts, timeout.ts, rate-limit.ts, logger.ts}
│  ├─ resolver/ {types.ts, registry.ts, lexicon-resolver.ts, chain-resolver.ts}
│  ├─ quiz/  {levels.config.ts, compose.ts, answer.ts, shuffle.ts}
│  ├─ db/    {queries.ts, cache.ts, hot-query-cache.ts}
│  └─ index/ {singleton.ts, matcher-instance.ts, swr-rebuild.ts}
└─ proxy.ts                       # Next 16：安全响应头 + 边缘限流兜底（原 middleware.ts）
packages/
├─ matcher/src/  {normalize.ts, trie.ts, aho-corasick.ts, grams.ts, edit-distance.ts, disambiguate.ts, weights.ts}
├─ quiz/src/     {progress-store.ts}          # 客户端唯一依赖的接口（仅类型 + localStorage 实现）
└─ contracts/src/                              # 本文的 TS 类型 + Zod schema，前后端共享（唯一真源）
```

**依赖方向铁律**：`client → contracts` ；`server → matcher / db / quiz / http-kit` ；`matcher →（零依赖）`；`db ↛ matcher`；`contracts ↛ server`。
**CI 强制规则**（ESLint `import/no-restricted-paths`）：
- `packages/matcher/**` 禁止 import 任何 Node 内置模块（保证同构）
- `packages/contracts/**` 禁止 import `server/**`（防止服务端内部类型泄漏到客户端 bundle）
- `apps/web/src/app/**/*.tsx` 禁止 import `server/**`

### 0.3 禁止循环依赖

依赖图是**有向无环**的，具体靠三条规则保证：
1. **`server/db` 不 import `server/resolver`**：DB 层不知道上层有谁用它。
2. **`TermResolver` 只通过 `registry.ts` 被解析**：`route.ts → registry.getResolver() → TermResolver`，`registry` 是唯一知道所有实现的地方；实现之间不互相 import（`chain-resolver` 通过构造参数注入依赖，而非 import）。
3. **同层互不 import**：`search` 与 `quiz` 之间零依赖，共享逻辑下沉到 `http-kit` 或 `contracts`。

---

## 1. 统一响应与错误码体系

### 1.1 成功响应约定

- 所有 JSON 接口返回**顶层对象**（永不安裸数组/裸字符串），便于后续加字段而不破坏客户端。
- 所有响应**必带**响应头 `X-Request-Id`。
- 所有响应**必带** `X-Content-Type-Options: nosniff`。
- 成功响应**不回显用户原始输入**（见 §6.3「反射面」），这是刻意的安全决策。

### 1.2 统一错误响应体（对外契约）

```ts
/** 所有 /api/** 的错误响应体（除 /api/og/** 二进制端点） */
export interface ApiErrorBody {
  error: {
    /** 稳定机器可读字符串，客户端逻辑只允许依赖此字段 */
    code: ApiErrorCode;
    /** 面向用户的中文文案，可直接展示；不含技术术语与内部标识 */
    message: string;
    /** 本次请求追踪 ID，与服务端日志、服务端告警一一对应 */
    requestId: string;
    /** 是否可安全重试（true 时前端应自动重试或降级，不弹错误） */
    retryable: boolean;
    /** retryable=true 时的建议重试间隔（毫秒）；未定义则用指数退避默认值 */
    retryAfterMs?: number;
    /** 字段级校验错误，仅 400 类返回；key 为字段路径，value 为可直接展示的文案 */
    fields?: Record<string, string>;
  };
}
```

**关键设计**：`retryable` + `retryAfterMs` 把 §5 的降级矩阵**变成机器可驱动的契约**——前端的降级分支（"网络异常，使用离线题库"）由 `code`/`retryable` 决定，**不需要匹配 message 文案**。message 允许随时改文案而不破坏客户端。

### 1.3 错误码全表（对外契约，v1 冻结）

| `code` | HTTP | 含义 | `retryable` | 触发场景 | 前端应做什么 |
|---|---|---|---|---|---|
| `INVALID_INPUT` | 400 | 参数结构非法 | false | 缺 `q`、`levelId` 格式错 | 展示 message |
| `Q_EMPTY` | 400 | 归一化后为空（输入全是标点/空白） | false | `q="。。。"` | 提示"请输入术语或句子" |
| `Q_TOO_LONG` | 400 | 原始输入 > 200 字符 | false | 超长粘贴 | 展示 message |
| `INVALID_LIMIT` | 400 | `limit` 非整数或越界 | false | `limit=100` | 回退默认 8 |
| `INVALID_MODE` | 400 | `mode` 不在枚举 | false | `mode=abc` | 回退 auto |
| `INVALID_DIFFICULTY` | 400 | `difficulty`/`difficultyCap` 非 1/2/3 | false | — | 回退默认 |
| `INVALID_CATEGORY` | 400 | `category` 非正整数 | false | — | 忽略该过滤条件 |
| `INVALID_LEVEL` | 400 | `levelId` 格式非法（不匹配 `^lv_(0[1-9]|10)$`） | false | `levelId=99` | 展示 message |
| `INVALID_OPTION` | 400 | `optionId` 不属于该题的选项集合 | false | 客户端 bug | 丢弃该次作答 |
| `PAYLOAD_TOO_LARGE` | 400 | POST body > 4KB | false | 恶意/异常客户端 | 丢弃 |
| `TERM_NOT_FOUND` | 404 | slug 不存在或未发布 | false | — | 走「未收录」空态 |
| `TERM_NOT_PUBLISHED` | 404 | 词条存在但 `status != published` | false | — | 同上（不泄露草稿存在性） |
| `LEVEL_NOT_FOUND` | 404 | 关卡配置缺失 | false | — | 提示稍后再试 |
| `QUESTION_NOT_FOUND` | 404 | `questionId` 不存在或不属于当前词库版本 | false | 词库更新后旧题失效 | 触发重新出题 |
| `INVALID_ORIGIN` | 403 | 写接口的 Origin / Sec-Fetch-Site 校验失败 | false | CSRF | 静默失败 |
| `METHOD_NOT_ALLOWED` | 405 | 方法不匹配 | false | — | — |
| `DUPLICATE_SUBMIT` | 409 | 同一 `clientRequestId` 携带**不同** `optionId`/`questionId` 重放 | false | 客户端 bug 或攻击 | 丢弃本次，按首次结果为准 |
| `RATE_LIMITED` | 429 | 超出限流 | **true** | — | 指数退避，不弹错误 |
| `INTERNAL_ERROR` | 500 | 未预期异常 | **true** | — | 通用错误页 + 重试 |
| `DB_UNAVAILABLE` | 503 | Neon 不可用且该接口无降级路径 | **true** | Neon 故障 | 降级 UI |
| `CONTENT_UNAVAILABLE` | 503 | 检索命中但**释义正文**取不到（部分降级） | **true** | Neon 故障 | **正常渲染卡片 + "释义加载中"**，不是错误页 |
| `INDEX_NOT_READY` | 503 | 内存索引冷启动中或构建失败且无旧实例 | **true** | 冷启动/构建失败 | 客户端本地 lexicon 兜底 |
| `UPSTREAM_TIMEOUT` | 504 | 软超时触发 | **true** | DB 慢 | 降级 |
| `QUIZ_POOL_EXHAUSTED` | 409 | 该关卡题库不足且不允许重复（`allowRepeat=false`） | false | 内容缺口 | 展示"本关题目正在补充" |

**契约原则**：① 客户端逻辑只依赖 `code`，绝不解析 `message`；② `code` 一经发布**只增不改**（废弃的 code 保留并映射到新 code 一个发布周期）；③ `304` 不是错误；④ 二进制端点（`/api/og/**`）不返回 JSON 错误体，见 §2.7。

### 1.4 结构化日志与 requestId 贯穿

```ts
export interface ServerLogFields {
  requestId: string;
  route: string;                 // '/api/search'
  method: string;
  status: number;
  durationMs: number;
  code?: ApiErrorCode;
  // 业务维度（全部为低基数枚举或数值，禁止放用户输入原文）
  matchedBy?: MatchedBy;
  matchedCount?: number;
  isMiss?: boolean;
  levelId?: string;
  questionCount?: number;
  degraded?: boolean;            // 是否走了降级路径
  indexVersion?: number;
  dbRoundTrips?: number;
}
```

**requestId 生成与净化**（防日志注入）：
```
1. 读入站 header `x-request-id`
2. 若存在且严格匹配 /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i → 复用
3. 否则丢弃并 crypto.randomUUID() 新生成
4. 写入响应头 X-Request-Id，并放入 AsyncLocalStorage 贯穿本次调用
5. 任何写入日志的「用户派生字符串」（如 slug）先过 sanitize：去掉 \r \n 与控制字符，截断 64 字符
```

---

## 2. API 契约完整定义

### 2.0 接口清单与「对外契约 / 内部实现」标注

| 端点 | 方法 | 契约级别 | 说明 |
|---|---|---|---|
| `GET /api/search` | GET | **对外契约（可版本化）** | 主检索，可能被外部消费 |
| `GET /api/term/[slug]` | GET | **对外契约** | 术语详情 |
| `GET /api/lexicon` | GET | **对外契约** | 词库快照，供客户端本地匹配 |
| `GET /api/quiz/next` | GET | **对外契约** | 出题 |
| `POST /api/quiz/answer` | POST | **对外契约（写 + 幂等键）** | 判分 |
| `GET /api/og/term/[slug]` | GET | **对外契约** | 分享图（二进制） |
| `GET /api/health` | GET | **对外契约（运维）** | 健康检查 |
| `submitAnswerAction` | Server Action | **内部实现** | 无稳定契约、无版本化，**外部调用方不得使用** |
| `reportSearchMissAction` | Server Action | **内部实现** | 仅 RSC 表单回退路径 |

> 标注规则：Server Actions 是 Next 的内部 RPC 通道，**其入参/返回值随框架版本与实现自由变更**，不构成对外契约；任何非本仓库前端的使用都必须走 Route Handlers。

### 2.0.1 全局约定表

| 项 | 值 | 说明 |
|---|---|---|
| Base URL | 同源 `/api/*` | 无独立域名 |
| 鉴权 | **无**（v1 无账号） | 仅 Origin 校验 + 限流 |
| 请求体大小上限 | POST ≤ 4KB | 超限 400 `PAYLOAD_TOO_LARGE` |
| 输入长度上限 | 200 字符（原始字符串长度） | 超限 400 `Q_TOO_LONG` |
| 结果条数上限 | `limit` ≤ 20，默认 8 | 超限 400 `INVALID_LIMIT`（不静默截断，避免客户端误判） |
| 软超时 | search 2000ms / quiz.next 2000ms / quiz.answer 1500ms / term 1500ms / lexicon 2000ms / health 500ms | 超时返回 504 `UPSTREAM_TIMEOUT` |
| gzip | 由 Vercel CDN 自动 | 不在应用层压缩 |
| 幂等性 | 仅 `POST /api/quiz/answer` 有（`clientRequestId`） | 其余全为幂等读 |
| 并发上限 | Vercel 函数侧配置（Pro 默认） | `/api/lexicon` 单独压低 maxDuration |

---

### 2.1 `GET /api/search`

**方法/路径**：`GET /api/search`
**契约级别**：对外契约　**幂等**：是（纯读）　**限流**：≤ 60 req/min/单 IP，超出 429

#### 请求参数（Zod schema，`packages/contracts/src/search.ts`）

```ts
import { z } from 'zod';

export const SearchQuerySchema = z.object({
  q: z.string().min(1, '请输入要查询的术语或句子'),
  limit: z.coerce.number().int().min(1).max(20).default(8),
  mode: z.enum(['auto', 'term', 'sentence']).default('auto'),
  category: z.coerce.number().int().positive().optional(),
  difficulty: z.coerce.number().int().min(1).max(3).optional(),
  includeSuggestions: z
    .enum(['0', '1'])
    .default('1')
    .transform((v) => v === '1'),
});
export type SearchQuery = z.infer<typeof SearchQuerySchema>;
```

**校验规则（顺序固定，短路抛错）**：
1. `q` 必须存在（缺失 → `INVALID_INPUT`）
2. **原始长度** `q.length > 200` → `Q_TOO_LONG`（在归一化前判断，避免攻击者用零宽字符绕过）
3. 归一化后 `normKey` 为空 → `Q_EMPTY`
4. `limit` / `mode` / `difficulty` / `category` 按上表
5. **未知 query 参数一律忽略**（不报错，向前兼容）

#### 响应体

```ts
import type { Difficulty } from './term';

export type MatchedBy =
  | 'exact_primary'
  | 'exact_alias_cn'
  | 'exact_alias_en'
  | 'exact_pinyin_abbr'
  | 'exact_pinyin_full'
  | 'colloquial'
  | 'misspell'
  | 'sentence'
  | 'prefix'
  | 'substring_in_alias'
  | 'fuzzy_gram'
  | 'pg_trgm';

export type MatchLayer = 'L0' | 'L1' | 'L2' | 'L3' | 'L3.5' | 'sentence';

export interface MatchSpan {
  /** 相对 **原始输入字符串** 的 UTF-16 code unit 偏移，闭开区间 [start, end) */
  start: number;
  end: number;
  /** 相对归一化串 normKey 的偏移，仅调试/埋点用，前端高亮必须用 raw span */
  normStart: number;
  normEnd: number;
}

export interface SenseRef {
  senseId: string;
  /** 面向用户的语境标签，如「技术分析里的均线」；不得是「义项 1」 */
  contextLabel: string;
  isPrimary: boolean;
  /** 0~1；< 0.7 视为低置信 */
  confidence: number;
  isLowConfidence: boolean;
  /** 义项数 > 1 时非空，供 UI 显示「MA · 3 个意思」与切换 Tab（不打断用户、不弹窗） */
  alternatives: Array<{ senseId: string; contextLabel: string }>;
}

export interface TermCardSummary {
  slug: string;
  termId: string;
  displayName: string;
  fullName: string | null;
  pronunciation: string | null;
  category: { id: number; l1: string; l2: string | null };
  difficulty: Difficulty;
  senseCount: number;
  /** 人话一句话，≤ 40 字，结果列表直接展示，无需进详情 */
  primaryPlainExplain: string;
  riskNoteShort: string | null;
  notMeaning: string | null;
  hasQuiz: boolean;
  contentVersion: number;
  updatedAt: string; // YYYY-MM-DD
}

export interface SearchMatch {
  rank: number;              // 1..limit
  termId: string;
  slug: string;
  displayName: string;
  layer: MatchLayer;
  matchedBy: MatchedBy;
  /** 命中的别名展示形态（来自词条数据，非用户输入） */
  matchedAlias: string;
  score: number;
  span: MatchSpan | null;    // 单词模式为 null；整句模式必有
  sense: SenseRef;
  /** 释义正文；DB 不可用时为 null 且 degraded 含 CONTENT_UNAVAILABLE */
  card: TermCardSummary | null;
}

export type SuggestionSource =
  | 'edit_distance'   // 与用户输入编辑距离最近（覆盖错别字/记不清）
  | 'same_category'   // 同分类同难度的高热词（覆盖「概念相邻但词不对」）
  | 'popular';        // 全站热门兜底（覆盖「完全没头绪」）

export interface TermSuggestion {
  termId: string;
  slug: string;
  displayName: string;
  primaryPlainExplain: string;
  difficulty: Difficulty;
  categoryId: number;
  source: SuggestionSource;
  /** 该建议被召回时的具体依据，便于埋点归因与 UI 文案 */
  reason: string;
}

export interface DegradationFlags {
  /** 检索索引不可用，整个检索降级 */
  indexUnavailable: boolean;
  /** 命中了但释义正文取不到（Neon 故障） */
  contentUnavailable: boolean;
  /** pg_trgm 兜底被触发 */
  trgmFallbackUsed: boolean;
  /** 内存索引 checksum 与 content_release 不一致，当前使用自洽的旧版本 */
  staleIndex: boolean;
}

export interface SearchResponse {
  requestId: string;
  query: {
    /** 归一化后的匹配键；不回显原始输入 */
    normKey: string;
    inputKind: 'term' | 'sentence';
    /** 原始输入超过 200 字符被截断 */
    truncated: boolean;
  };
  isMiss: boolean;
  matched: SearchMatch[];
  /** isMiss=true 时服务端保证 ≥3 条（词库规模足够时）；非 miss 时为 [] */
  suggestions: TermSuggestion[];
  /** 处理耗时（服务端纯计算 + DB），不含网络 */
  tookMs: number;
  degraded: DegradationFlags;
  /** 词库版本，客户端据此判断本地 lexicon 是否需要刷新 */
  contentVersion: number;
}
```

**`suggestions` 只在 `isMiss=true` 时返回**（非 miss 时返回空数组，减少载荷）。产品要求 F6「无结果兜底 ≥3 个相近词」由此契约保证。

#### 缓存策略

| 层 | 策略 | 理由 |
|---|---|---|
| CDN | **不使用**，`Cache-Control: private, no-store` | ① 响应与具体 query 强绑定，CDN 命中率低；② 避免任何形式的跨用户响应错配风险（§6.3） |
| `unstable_cache` | **热门查询**：`unstable_cache(fn, { key, tags: ['search:hot'], revalidate: 300 })` | 热词（MACD/市盈率/PE）重复查询率高，省 DB 与 CPU |
| 进程内 LRU | 归一化 query → 候选 termId 列表，TTL 60s，上限 1000 条 | 免去重复 AC 扫描（<1ms，但省 CPU） |
| 进程内负缓存 | miss 结果 TTL 15s，上限 500 条 | 防「对不存在的词反复探测」打穿 DB |
| `unstable_cache`（内容） | `hydrate` 单 term 结果，tag `term:{slug}`，revalidate 3600 | 释义正文变化极少 |

**热门查询判定（无 Redis 下的可实现方案）**：进程内 LFU 计数（key=normKey），访问 ≥ 3 次的进入 `unstable_cache` 写入路径；LFU 计数随实例重建丢失，**只影响命中率不影响正确性**，可接受。

**防缓存击穿（stampede）**：
1. **单飞（single-flight）**：进程内 `Map<cacheKey, Promise>`，同一 key 并发只回源一次，其余 await 同一 Promise。
2. **过期宽限（stale-while-revalidate）**：`hydrate` 结果 TTL 3600s，但在 `freshUntil=3000s` 之后命中即返回旧值并异步触发后台刷新（不阻塞请求）。
3. **热门查询写入抖动**：写入 `unstable_cache` 的 TTL 乘以 `0.9 + random*0.2`，避免同批 key 同时到期。
4. **负缓存不参与单飞**（miss 也需要单飞，防止并发打 DB）。

#### 超时

- 内存索引阶段：**无超时**（纯计算，1KB 文本 < 1ms，硬上限是 200 字符输入）
- `hydrate`（DB）：`AbortSignal.timeout(800)` 软超时 → 超时降级为 `card: null` + `contentUnavailable`
- 整体 handler：`maxDuration = 2`，`AbortSignal.timeout(2000)` → 504

#### 调用示例

**请求**
```
GET /api/search?q=%EF%BC%A5%EF%BC%B0%EF%BC%A5%EF%BC%B0%EF%BC%B0%EF%BC%B0&limit=3
（q = "ＰＥ（市盈率）" 全角）
```

**响应 200**
```json
{
  "requestId": "3f7c1e0a-5b2d-4c19-9a44-8e1b6d2f7c33",
  "query": { "normKey": "pe 市盈率", "inputKind": "term", "truncated": false },
  "isMiss": false,
  "matched": [
    {
      "rank": 1,
      "termId": "t_pe",
      "slug": "pe",
      "displayName": "PE",
      "layer": "L0",
      "matchedBy": "exact_primary",
      "matchedAlias": "PE",
      "score": 100,
      "span": null,
      "sense": {
        "senseId": "s_pe_fin",
        "contextLabel": "估值里的市盈率",
        "isPrimary": true,
        "confidence": 0.94,
        "isLowConfidence": false,
        "alternatives": [
          { "senseId": "s_pe_gear", "contextLabel": "私募股权里的 PE" }
        ]
      },
      "card": {
        "slug": "pe",
        "termId": "t_pe",
        "displayName": "PE",
        "fullName": "Price to Earnings Ratio（市盈率）",
        "pronunciation": null,
        "category": { "id": 4, "l1": "估值与财务", "l2": null },
        "difficulty": 2,
        "senseCount": 2,
        "primaryPlainExplain": "股价 ÷ 每股利润，用来粗看「贵不贵」。",
        "riskNoteShort": "市盈率高低只反映价格与利润的关系，不构成买卖依据。",
        "notMeaning": "P/E 低不等于这只股票便宜。",
        "hasQuiz": true,
        "contentVersion": 3,
        "updatedAt": "2026-10-12"
      }
    }
  ],
  "suggestions": [],
  "tookMs": 4,
  "degraded": {
    "indexUnavailable": false,
    "contentUnavailable": false,
    "trgmFallbackUsed": false,
    "staleIndex": false
  },
  "contentVersion": 42
}
```

**响应 200（未命中）**
```json
{
  "requestId": "b1c2d3e4-1111-4222-8333-444455556666",
  "query": { "normKey": "qqq", "inputKind": "term", "truncated": false },
  "isMiss": true,
  "matched": [],
  "suggestions": [
    {
      "termId": "t_qfq",
      "slug": "qfq-dayi",
      "displayName": "前复权",
      "primaryPlainExplain": "把分红除权的价格倒推回今天，方便比较历史涨跌。",
      "difficulty": 2,
      "categoryId": 6,
      "source": "edit_distance",
      "reason": "与输入编辑距离 1"
    },
    {
      "termId": "t_etf",
      "slug": "etf",
      "displayName": "ETF",
      "primaryPlainExplain": "一篮子股票打包成的基金，在交易所像股票一样买卖。",
      "difficulty": 1,
      "categoryId": 5,
      "source": "popular",
      "reason": "高频查询但你还没看过"
    },
    {
      "termId": "t_zzz",
      "slug": "zhishu-jituan",
      "displayName": "指数基金",
      "primaryPlainExplain": "照着某个指数成分股买的基金。",
      "difficulty": 1,
      "categoryId": 5,
      "source": "same_category",
      "reason": "同属「基金与产品」分类"
    }
  ],
  "tookMs": 2,
  "degraded": {
    "indexUnavailable": false,
    "contentUnavailable": false,
    "trgmFallbackUsed": false,
    "staleIndex": false
  },
  "contentVersion": 42
}
```

**响应 400**
```json
{
  "error": {
    "code": "Q_TOO_LONG",
    "message": "输入太长了，超过 200 个字符，请精简后再试。",
    "requestId": "aa11bb22-cc33-4d44-8e55-ff6677889900",
    "retryable": false
  }
}
```

#### 执行流程（含每一步失败降级）

```
[0] 生成/复用 requestId（见 §1.4）                     失败 → 500 INTERNAL_ERROR
[1] 读限流计数（Firewall 为主，进程内令牌桶兜底）        超限 → 429 RATE_LIMITED
[2] Zod 解析 searchParams                              失败 → 400 INVALID_*（附 fields）
[3] 原始长度检查（>200）                                超限 → 400 Q_TOO_LONG
[4] 归一化管线（packages/matcher/normalize.ts）
      产出 normKey + display + offsetMap（单调不减映射）
      产出 inputKind（auto 模式下由形态判定：≤16 且无分隔符 → term，否则 sentence）
[5] normKey 归一化后为空                                 → 400 Q_EMPTY
[6] 取 Matcher 单例（冷启动时 await 单例初始化）
      索引未就绪且无旧实例 → 503 INDEX_NOT_READY
      （客户端应改用本地 lexicon 兜底，这是「命中不了也不白屏」的关键路径）
[7] 进程内候选 LRU 命中？ → 跳到 [10]
[8] resolveCandidates(normKey, inputKind, filters)
      单词模式 L0→L1→L2→L3；整句模式 AC + 裁决层
      L3.5 pg_trgm：仅 /^[a-z0-9 .\-']{4,}$/ 命中时触发，且仅当 0~L3 全空
      pg_trgm 查询失败 → 记 degraded.trgmFallbackUsed=false，直接判 miss（不抛错）
      AC 构建失败（仅冷启动）→ 降级：跳过整句模式，只跑单词模式 L0~L3
                          → 仍全空则退化为 pg_trgm（L3.5）
                          → 再失败 → 503 INDEX_NOT_READY
[9] 候选结果写入进程内 LRU（正/负都写，负 TTL 更短）
[10] 排序裁剪 → matched 骨架（score desc → popularity desc → limit）
      applyFilters(category, difficulty)
[11] isMiss = matched.length === 0
[12] if isMiss → generateSuggestions()（见 §3.4）
      失败 → 降级为热门 Top3（纯进程内静态表，零 I/O）
      热门表也为空（词库 <3 条）→ 返回空数组（契约允许：文档保证 ≥3 需词库规模足够）
[13] hydrate(termIds[]) → 批量取 TermCardSummary（单次查询，非 N+1）
      800ms 软超时 / 连接失败 → card=null，degraded.contentUnavailable=true
      单条失败不影响其他条目（Promise.allSettled 语义）
[14] 组装响应；span 坐标由 normStart/normEnd 经 offsetMap 反查为 raw 坐标
[15] 埋点 term_search(hit, matchedBy, layer, count, tookMs, degraded)
[16] 返回；CDN no-store
```

**关键实现细节 —— span 坐标映射（易错点）**：
归一化会改变长度（全角→半角长度不变，但零宽字符删除会变、空白折叠会变、大小写折叠长度不变）。因此归一化时必须**同时产出单调不减的 offsetMap**：`normOffsetToRawOffset: number[]`。
- 单向映射保证：归一化空间中不重叠的 span，反查回原始空间也**必然不重叠**（单调函数保持序关系）→ 裁决层在 norm 空间去重后，raw 空间无需再去重。
- 前端高亮**必须使用 `span.start/end`（raw 坐标）**；`normStart/normEnd` 只用于埋点归因与调试。

---

### 2.2 `GET /api/term/[slug]`

**方法/路径**：`GET /api/term/[slug]`　**契约级别**：对外契约　**幂等**：是　**限流**：≤ 120 req/min/单 IP（页面流量比 API 大）

#### 请求参数

```ts
import { z } from 'zod';

export const TermSlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'slug 只能包含小写字母、数字与连字符');

export const TermQuerySchema = z.object({
  /** 指定初始展示义项；缺省为 is_primary 义项 */
  sense: z.string().min(1).max(40).optional(),
});
export type TermQuery = z.infer<typeof TermQuerySchema>;
```

**校验规则**：slug 不匹配正则 → `404 TERM_NOT_FOUND`（**不返回 400**，避免向爬虫泄露"格式错误 vs 不存在"的差异，也避免 slug 枚举探测）。

#### 响应体

```ts
export interface SenseDetail {
  senseId: string;
  senseKey: string;
  contextLabel: string;
  isPrimary: boolean;
  frequency: 'high' | 'mid' | 'low';
  /** 人话层，≤ 40 字，首屏默认展开 */
  plainExplain: string;
  /** 进阶层，60~150 字，默认折叠 */
  advancedExplain: string | null;
  /** 专业层，100~250 字，L3 必填，默认折叠 */
  proExplain: string | null;
  /** 至少 1 条；L1 词条至少 2 条 */
  examples: Array<{ text: string; style: ExampleStyle }>;
  /** 「这不代表什么」，30~60 字，涉投资判断词条必填 */
  notMeaning: string | null;
}

export type ExampleStyle =
  | 'life_analogy'
  | 'workplace_social'
  | 'family_finance'
  | 'business_practice';

export type RelationType = 'related' | 'contrast' | 'prereq';

export interface RelatedTermRef {
  slug: string;
  displayName: string;
  relationType: RelationType;
  /** 一句独立解释（≤40 字），不做纯链接列表（产品 F9） */
  oneLiner: string;
}

export interface DisclaimerRef {
  code: string;
  version: number;
  /** 卡片内用简短一行；完整版由客户端按 code 取 */
  short: string;
}

export interface TermDetailResponse {
  requestId: string;
  term: {
    slug: string;
    termId: string;
    displayName: string;
    fullName: string | null;
    pronunciation: string | null;
    category: { id: number; l1: string; l2: string | null };
    difficulty: Difficulty;
    tags: string[];
    senses: SenseDetail[];
    /** 义项数 > 1 时，前端首屏必须显性提示「该词有 N 个意思」（产品 F4/S3） */
    senseCount: number;
    /** 非默认义项时，服务端在此声明「本响应权威义项」，防止客户端猜错 */
    activeSenseId: string;
    related: RelatedTermRef[];
    /** 易混词对照，MVP 为空数组，V2 上线（S-2） */
    confusion: Array<{ slug: string; displayName: string; difference: string }>;
    riskNote: string | null;
    regulatoryFlags: boolean;
    /** 内容版本可追溯（S8），页脚展示「v3 / 更新于 2026-10-12」 */
    contentVersion: number;
    updatedAt: string;
    sourceLabel: string;
    hasQuiz: boolean;
  };
  disclaimer: DisclaimerRef;
  contentVersion: number;
}
```

#### 缓存策略（这是全站缓存收益最高的接口）

| 层 | 策略 |
|---|---|
| CDN / ISR | 术语详情页与本接口共享 `unstable_cache` tag `term:{slug}`，`revalidate: 3600`；内容发布后 `revalidateTag('term:{slug}')` 精准打掉 |
| 关联 tag | 反向依赖：某词条被 X 引用为 related，则 X 的 tag 也需失效 → 发布时按 `term_relation` 反查并一并 `revalidateTag` |
| `Cache-Control` | `public, max-age=0, s-maxage=3600, stale-while-revalidate=86400`（浏览器不缓存，CDN 缓存 1h + 1 天宽限） |
| 免责一致性 | 正文与 `disclaimer.version` **必须在同一次缓存写入中产生**，防止缓存错配出现「新正文 + 旧免责」（架构 4.6 硬要求） |

**缓存击穿防护**：单飞 + `freshUntil` 宽限（同 §2.1）。SSG 页面已由框架处理。

#### 超时：`AbortSignal.timeout(800)` 查库；整体 `maxDuration = 2`。
**幂等**：天然幂等。

#### 调用示例

**请求**：`GET /api/term/pe`

**响应 200**
```json
{
  "requestId": "7c8d9e0f-2222-4333-8444-555566667777",
  "term": {
    "slug": "pe",
    "termId": "t_pe",
    "displayName": "PE",
    "fullName": "Price to Earnings Ratio（市盈率）",
    "pronunciation": null,
    "category": { "id": 4, "l1": "估值与财务", "l2": null },
    "difficulty": 2,
    "tags": ["新手常问", "高频"],
    "senses": [
      {
        "senseId": "s_pe_fin",
        "senseKey": "financial",
        "contextLabel": "估值里的市盈率",
        "isPrimary": true,
        "frequency": "high",
        "plainExplain": "股价 ÷ 每股利润，用来粗看「贵不贵」。",
        "advancedExplain": "PE = 股价 ÷ 每股收益。分母用的是过去 12 个月的利润（TTM），所以利润波动大的公司 PE 会跳得很厉害。",
        "proExplain": "常见口径有静态 PE、TTM PE、动态 PE（用预测利润）。跨行业比较 PE 无意义，应与同行业同口径比较，并结合 PB 与 ROE 一起看。常见误用：把低 PE 直接当作「便宜」。",
        "examples": [
          { "text": "你花 100 元买入一股，它一年赚了 5 元，那市盈率就是 20 倍——意思是「按这个赚钱速度，20 年赚回本」。", "style": "life_analogy" },
          { "text": "有人说「这只票 PE 才 8 倍，很便宜」，通常他没提这个 8 倍是靠利润下滑换来的。", "style": "workplace_social" }
        ],
        "notMeaning": "P/E 低不等于这只股票便宜，只说明当前价格对应更低的盈利倍数。"
      },
      {
        "senseId": "s_pe_gear",
        "senseKey": "private_equity",
        "contextLabel": "私募股权里的 PE",
        "isPrimary": false,
        "frequency": "mid",
        "plainExplain": "Private Equity 的缩写，指专门做公司收购的私募基金。",
        "advancedExplain": "与股市里的市盈率无关，指用募集来的资金购买非上市企业股权的基金。",
        "proExplain": null,
        "examples": [
          { "text": "财经新闻里说「PE 出手收购了某公司」，说的是私募股权基金，不是市盈率。", "style": "business_practice" }
        ],
        "notMeaning": "看到 PE 要先看语境：算股价除利润时是市盈率，说机构收购时是私募股权。"
      }
    ],
    "senseCount": 2,
    "activeSenseId": "s_pe_fin",
    "related": [
      { "slug": "pb", "displayName": "PB", "relationType": "contrast", "oneLiner": "PE 看利润，PB 看净资产，适合给钱的账面价值。" },
      { "slug": "peg", "displayName": "PEG", "relationType": "related", "oneLiner": "把 PE 除以利润增速，帮你看贵不贵是不是「贵在没成长」。" },
      { "slug": "roe", "displayName": "ROE", "relationType": "related", "oneLiner": "股东每投 1 元一年赚回多少，比 PE 更能解释「为什么便宜」。" }
    ],
    "confusion": [],
    "riskNote": "市盈率高低只反映价格与利润的关系，不构成买卖依据。",
    "regulatoryFlags": true,
    "contentVersion": 3,
    "updatedAt": "2026-10-12",
    "sourceLabel": "交易所投资者教育手册 / 权威金融词典",
    "hasQuiz": true
  },
  "disclaimer": { "code": "TERM_CARD", "version": 2, "short": "仅供理解，不构成投资建议。" },
  "contentVersion": 42
}
```

**响应 404**
```json
{
  "error": {
    "code": "TERM_NOT_FOUND",
    "message": "这个词我们还没收录。你可以换个说法再搜一次。",
    "requestId": "88a1b2c3-3333-4444-8555-666677778888",
    "retryable": false
  }
}
```

---

### 2.3 `GET /api/lexicon`

**方法/路径**：`GET /api/lexicon`　**契约级别**：对外契约（客户端离线/本地匹配的依赖源）　**幂等**：是

#### 请求参数

```ts
import { z } from 'zod';

export const LexiconQuerySchema = z.object({
  /** 客户端已知版本；与服务端一致时服务端仍走 ETag/304，不做业务短路 */
  version: z.coerce.number().int().positive().optional(),
  /**
   * include=entries|entries+grams
   * 默认 entries —— 结论：v1 不下发 gram 倒排（见下方理由）
   */
  include: z.enum(['entries', 'entries+grams']).default('entries'),
});
export type LexiconQuery = z.infer<typeof LexiconQuerySchema>;
```

**是否下发 grams 的决策（结论 + 理由）**：架构契约里列了 `grams`，但**默认关闭**，需显式 `include=entries+grams` 才返回。
- 理由①：客户端本地匹配的实际需要是「精确命中 + 别名 + 前缀 + 整句 AC 高亮」，这些只需 `entries`（normKey → termId/aliasType）；`grams` 服务的是模糊层，而**客户端做模糊匹配是负资产**（架构 §2.4 已论证：搜索「市盈率」返回一堆近邻词是失败）。
- 理由②：载荷测算（假设前提：词库 120 条 → 长期 2000 条，每条约 4 个别名）：`entries` 120 条时约 28KB(gzip)，2000 条时约 380KB(gzip)；`grams` 倒排会再带来 150%~300% 的体积，且**长期与词库规模同步膨胀**。
- 理由③：默认关闭 = 契约保留 v2 可能性而 v1 不付代价。
- **否决方案**：默认下发 grams（为了"将来可能用"，v1 就要为不确定的需求付带宽与 IndexedDB 空间）。

#### 响应体

```ts
export type AliasType =
  | 'primary'
  | 'cn_alias'
  | 'en_alias'
  | 'pinyin_abbr'
  | 'pinyin_full'
  | 'colloquial'
  | 'misspell';

export interface LexiconEntry {
  /** 归一化键，全局唯一（DB UNIQUE 约束） */
  key: string;
  termId: string;
  aliasType: AliasType;
  /** 该别名类型的匹配权重（对应架构 WEIGHTS 常量） */
  weight: number;
  /** 展示形态，如「市盈率」「PE ratio」；客户端做高亮时用原文匹配，展示用这个 */
  surface: string;
  /** 非空表示这是 sense 级专属别名（一词多义直连消解的依据） */
  senseId: string | null;
  /** 该词条的分类与难度，供客户端本地预筛与兜底渲染 */
  difficulty: Difficulty;
  categoryId: number;
}

export interface LexiconGrams {
  /** 二元 gram → 候选 alias key 的 posting（稀疏数组，CSR 风格，避免 JSON 对象键爆炸） */
  keys: string[];
  offsets: number[];
  postings: number[];
}

export interface LexiconResponse {
  requestId: string;
  version: number;
  checksum: string;
  entries: LexiconEntry[];
  /** 仅当 include=entries+grams 时非 null */
  grams: LexiconGrams | null;
  /** 服务端生成时间（ISO），客户端可据此判断是否需要重建本地 AC */
  builtAt: string;
}
```

#### 缓存策略（防「反复拉全量」）

| 项 | 值 | 理由 |
|---|---|---|
| `ETag` | `"lex-{version}-{checksum}"` | checksum 参与 ETag → 内容不变时永远 304 |
| `If-None-Match` 命中 | `304`，无响应体 | 客户端轮询成本≈0 |
| `Cache-Control` | `public, max-age=300, s-maxage=3600, stale-while-revalidate=86400` | 客户端 5 分钟内的重复请求走浏览器缓存，CDN 1 小时 |
| tag | `lexicon` | 内容发布后 `revalidateTag('lexicon')` |
| **限流** | **≤ 10 req/min/单 IP**（比搜索更严） | 单次载荷大，是最值得防的爬取目标 |
| robots | `/api/` 全量 disallow（sitemap 与 robots.txt 负责引导） | 不做验证码 |

#### 调用示例

**请求**：`GET /api/lexicon?include=entries`

**响应 200**
```json
{
  "requestId": "99aa11bb-4444-4555-8666-777788889999",
  "version": 42,
  "checksum": "sha256:1f0c9d2b7e5a",
  "entries": [
    { "key": "pe", "termId": "t_pe", "aliasType": "primary", "weight": 100, "surface": "PE", "senseId": null, "difficulty": 2, "categoryId": 4 },
    { "key": "市盈率", "termId": "t_pe", "aliasType": "cn_alias", "weight": 95, "surface": "市盈率", "senseId": "s_pe_fin", "difficulty": 2, "categoryId": 4 },
    { "key": "pe ratio", "termId": "t_pe", "aliasType": "en_alias", "weight": 92, "surface": "PE ratio", "senseId": null, "difficulty": 2, "categoryId": 4 },
    { "key": "plr", "termId": "t_pe", "aliasType": "pinyin_abbr", "weight": 90, "surface": "市盈率", "senseId": "s_pe_fin", "difficulty": 2, "categoryId": 4 }
  ],
  "grams": null,
  "builtAt": "2026-10-20T08:12:03.000Z"
}
```

**响应 304**（`If-None-Match: "lex-42-sha256:1f0c9d2b7e5a"`）→ 无响应体，仅 `ETag` + `Cache-Control`。

---

### 2.4 `GET /api/quiz/next`

**方法/路径**：`GET /api/quiz/next`　**契约级别**：对外契约　**幂等**：是（纯读，服务端无状态）　**限流**：≤ 30 req/min/单 IP

#### 请求参数

```ts
import { z } from 'zod';

export const QuizNextQuerySchema = z.object({
  levelId: z.string().regex(/^lv_(0[1-9]|10)$/, '关卡编号格式不正确'),
  count: z.coerce.number().int().min(1).max(20).default(8),
  mode: z.enum(['level', 'review', 'daily']).default('level'),
  /**
   * 复习/补位用的 termId 列表，**顺序即优先级**（服务端不排序，客户端掌握错题权重）
   * level 模式下用作「错题优先补位」来源；review 模式下决定出题范围
   */
  termIds: z
    .string()
    .max(2048)
    .optional()
    .transform((v) =>
      v === undefined
        ? undefined
        : v.split(',').map((s) => s.trim()).filter((s) => s.length > 0).slice(0, 50)
    )
    .refine((arr) => arr === undefined || arr.every((s) => /^t_[a-z0-9_]{1,32}$/.test(s)), {
      message: 'termIds 含有非法标识',
    }),
  /** 本次会话已出现过的题目，服务端据此保证「一关内不重复」（客户端持有，服务端无状态） */
  excludeQuestionIds: z
    .string()
    .max(1024)
    .optional()
    .transform((v) => (v === undefined ? undefined : v.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20))),
  /**
   * 难度上限（1|2|3）。客户端连续 2 题错 → 降档时下调本值实现「不出超纲题」，
   * 无需服务端保存任何用户状态
   */
  difficultyCap: z.coerce.number().int().min(1).max(3).optional(),
  /** 题目池耗尽时是否允许重复；默认 false（关卡内应能出满 8 题） */
  allowRepeat: z.enum(['0', '1']).default('0').transform((v) => v === '1'),
  /** 可选随机种子，缺省用 crypto 随机；传相同 seed 得到相同题序（便于复现与测试） */
  seed: z.string().max(32).optional(),
});
export type QuizNextQuery = z.infer<typeof QuizNextQuerySchema>;
```

#### 响应体（题目 payload 最小化）

```ts
export type QuestionType = 'T1' | 'T2' | 'T3' | 'T4';

export interface QuizOption {
  /** 稳定选项标识，与「展示顺序」解耦；乱序只改顺序不改 id */
  id: string;
  text: string;
}

export interface QuizQuestionPayload {
  /**
   * 对外不透明 id（DB public_id，形如 q_01J...），
   * **刻意不使用自增整型**：① 避免暴露题目总量与 source 分布；② 让内部主键策略可自由变更而不破坏契约
   */
  questionId: string;
  type: QuestionType;
  stem: string;
  /**
   * 4 个选项，**顺序已服务端打乱**（seed 可复现）。
   * 绝不含 isCorrect / weight / termId 等任何可推断答案的字段
   */
  options: QuizOption[];
  difficulty: Difficulty;
  /** 客户端 ProgressStore 以 termId 为错题本键，故必须下发 */
  termId: string;
  termSlug: string;
  /** 用于「点进词条卡」；不代表答案线索 */
  senseId: string | null;
}

export interface QuizNextMeta {
  requested: number;
  delivered: number;
  /** 来自错题本补位的题数 */
  filledFromWrongBook: number;
  /** 来自关卡题池的题数 */
  filledFromLevelPool: number;
  /** 因题库不足而重复的题数（>0 表示内容缺口，触发内容告警） */
  repeated: number;
  /** 实际难度分布，服务端自检用；与产品「不超纲」验收对齐 */
  difficultyMix: Record<'1' | '2' | '3', number>;
  /** 本次生效的难度上限（回显，便于客户端确认降档已生效） */
  effectiveDifficultyCap: Difficulty;
}

export interface QuizNextResponse {
  requestId: string;
  mode: 'level' | 'review' | 'daily';
  levelId: string | null;
  questions: QuizQuestionPayload[];
  meta: QuizNextMeta;
}
```

**题目 payload 最小化核对表（不下发的字段及理由）**

| 不下发 | 理由 |
|---|---|
| `answerKey` | 防「看源码」作弊（架构 3.3.4 第一层，零成本零延迟） |
| `explanation` | 答案依据随判分响应下发；提前下发等于泄题 |
| `isCorrect` / `option.weight` | 可直接定位答案 |
| `distractorTermId[]` | 反推答案 |
| `termId` 对应的 gloss 全文 | 干扰项文本本身就是选项，提前单独下发无意义且增体积 |
| `source`（auto/manual）、`reviewStatus` | 内部质检字段，无产品价值 |
| `quiz_question.id`（自增整型） | 见上，`public_id` 替代 |

**唯一保留的冗余是 `termSlug`**：产品要求「点进词条卡」，用 slug 比 termId 更可读且已是公开信息。

#### 出题算法（具体步骤）

**步骤 1 · 关卡配置解析与校验**
```
levels.config.ts（Zod 在模块加载时校验，配置非法 → 启动即失败，不留到运行时）
  levelId → { ordinal, name, targetDifficulty, categoryId, composition, questionPool }
若 levelId 无配置 → 404 LEVEL_NOT_FOUND
```

**步骤 2 · 确定有效难度上限（不出超纲）**
```
effectiveCap = difficultyCap ?? min(3, level.targetDifficulty + 1)
effectiveCap = clamp(effectiveCap, 1, 3)
```
- 前 2 关：`targetDifficulty = 1`，`composition = { current: 8, previous: 0, next: 0 }` → **全 L1**（硬约束，产品 8.3 规则 2）
- 第 3~10 关：`composition = { current: 5, previous: 2, next: 1 }`（产品 8.3 规则与 7.5）
- 若 `targetDifficulty = 3`：`next` 无 L4 → 重分配为 `{ current: 6, previous: 2, next: 0 }`
- 若 `targetDifficulty = 1`（第 3 关若配置如此）：`previous` 无 L0 → 重分配为 `{ current: 8, previous: 0, next: 1 }`

**步骤 3 · 题池构建**
```
pool = level.questionPool
     ∪ (mode==='review' 或 level 模式下传入 termIds ? termIds 对应题目 : ∅)
过滤：difficulty <= effectiveCap
过滤：questionId ∈ excludeQuestionIds → 剔除
缓存：level 题池（不含选项顺序）用 unstable_cache(tag: `level:{levelId}`, revalidate: 600)
      → 缓存命中后仍需按本次 seed 重打乱，保证每次题目展示顺序不同
```

**步骤 4 · 槽位编排（每关 8 题 = 5 当前 + 2 上一 + 1 下一）**
```
slots = []
for i in 1..count:
  优先复用 composition 的配比（按 count 等比缩放，见下方注）
  → 计算每个难度桶需要几题：bucket[d] = round(count × composition[d] / 8)
注：count < 8 时（如每日一练 5 题），按同比例缩放并保证桶顺序：
    先「上一难度」→ 再「当前难度」→「下一难度」，
    保证任何 count 下都优先给巩固题（产品 7.5「不出超纲」优先于「配比精确」）
```

**步骤 5 · 错题优先补位（仅 `mode=level` 且传入 termIds 时生效）**
```
budget = level 模式下允许的错题补位数 = floor(count × 0.25)   // 8 题 → 最多 2 题
        （保留上限，避免「一关全是错题」导致难度配比崩坏）
for each slot in slots:
  if usedWrongBook >= budget → break
  wanted = 该槽位要求的难度
  从 termIds（按传入顺序 = 优先级）中找第一个
       满足 difficulty == wanted 且未被选中的题目
  命中 → 占用该槽位，usedWrongBook++
```
**为什么预算限定在 25%**：产品 8.3 规则 5 要求错题优先，但规则 2/7.5 同时要求「前 2 关全 L1」与「不超纲」。若不设上限，一个积累了大量 L1 错题的用户做第 3 关（L1+L2+L3 配比）会被错题全部占满 L1 槽位，关卡编排形同失效。25% 是「让错题被看见」与「保持关卡编排有效」的平衡点。
**review 模式无预算上限**：`mode=review` 的目的就是集中练错题，此时 `effectiveCap = difficultyCap ?? 3`（复习可以跨档）。

**步骤 6 · 题池耗尽与去重保证**
```
若 pool 剩余 < count:
  allowRepeat=false → 409 QUIZ_POOL_EXHAUSTED（并在 message 说明「题目正在补充」）
                     ⚠️ 更好的做法是**不抛错**：返回能出的题数 + meta.repeated=0，
                        前端提示「本关题目较少」。权衡后结论：**仍抛 409**，
                        因为返回不足 8 题会破坏「第 X / 8 题」的产品体验与断点续做语义（产品 8.7）。
                        → 用 meta.delivered 让前端可降级展示，并触发内容缺口告警。
  allowRepeat=true  → 允许重复，meta.repeated = count - pool.length，触发内容缺口告警
去重保证（两层）:
  ① 服务端在本次响应内用 Set 保证 questionId 不重复
  ② 跨请求去重由客户端传 excludeQuestionIds 实现（服务端无状态，
     「无账号 + 进度在 localStorage」决定了服务端不可能持有已出题记录）
```

**步骤 7 · 选项乱序（关键实现细节）**
```
缓存中的题目形态：{ questionId, options: [{id,text}...]（DB 原始顺序）, answerKey: 'o3' }
下发前：用 seed 对 options 数组做 Fisher-Yates 洗牌
seed = f(seed ?? randomUUID(), questionId)
答案判定：answerKey 指的是**选项 id**，不是位置 → 洗牌不影响判分
```
**为什么必须「按 id 而非按位置」判分**：如果 `answerKey` 存的是「正确选项在第几位」，洗牌就必然改答案。这里是**载荷设计层面的决定**：选项 id 在 DB 中固定（`o1..o4`），`answer_key` 存 id。

**步骤 8 · 组装 payload 并剔除敏感字段**（严格按 §2.4 最小化核对表逐字段白名单构造，不做「先取全量再删除」——黑名单式删除迟早漏字段）

**步骤 9 · 埋点**：`level_start`（mode=level 首次）、出题量与难度分布进服务端日志。

#### 缓存策略

| 项 | 决策 | 理由 |
|---|---|---|
| 关卡题池 | `unstable_cache` tag `level:{levelId}`，600s | 题池低频变化，避免每次出题都查 DB |
| `mode=review` | **不缓存**（key 含用户 termIds，键空间无界且是隐私面） | 复习题的组合是个性化的，缓存收益低、风险高 |
| 响应头 | `Cache-Control: private, no-store` | 避免 CDN 缓存个性化出题结果 |
| CDN | 不使用 | 同上 |

#### 超时：`AbortSignal.timeout(1200)` 查库；整体 `maxDuration = 2`。题池不足时**不做降级**，直接 409（内容缺口要暴露而非掩盖）。
#### 幂等：天然幂等（无状态）。

#### 调用示例

**请求**：`GET /api/quiz/next?levelId=lv_04&count=8&termIds=t_pe,t_roe&excludeQuestionIds=q_01J&q_01K&seed=abc123`

**响应 200**
```json
{
  "requestId": "aabb11cc-5555-4666-8777-88889999aaaa",
  "mode": "level",
  "levelId": "lv_04",
  "questions": [
    {
      "questionId": "q_01JABCDEF",
      "type": "T1",
      "stem": "PE 在财经语境里指的是？",
      "options": [
        { "id": "o2", "text": "股价 ÷ 每股利润，用来粗看「贵不贵」" },
        { "id": "o4", "text": "基金净资产 ÷ 份额数量" },
        { "id": "o1", "text": "股东权益 ÷ 净利润" },
        { "id": "o3", "text": "总资产 ÷ 总负债" }
      ],
      "difficulty": 2,
      "termId": "t_pe",
      "termSlug": "pe",
      "senseId": "s_pe_fin"
    }
  ],
  "meta": {
    "requested": 8,
    "delivered": 8,
    "filledFromWrongBook": 2,
    "filledFromLevelPool": 6,
    "repeated": 0,
    "difficultyMix": { "1": 1, "2": 5, "3": 2 },
    "effectiveDifficultyCap": 3
  }
}
```

**响应 409（题库不足）**
```json
{
  "error": {
    "code": "QUIZ_POOL_EXHAUSTED",
    "message": "这一关的题目还在补充中，先试试前面的关卡吧。",
    "requestId": "bbcc22dd-6666-4777-8888-9999aaaabbbb",
    "retryable": false
  }
}
```

---

### 2.5 `POST /api/quiz/answer`

**方法/路径**：`POST /api/quiz/answer`　**契约级别**：对外契约（**唯一的写接口**）　**限流**：≤ 30 req/min/单 IP

#### 为什么用 Route Handler 而不是 Server Action（结论 + 理由）

产品与架构共同定调：Server Actions 用于**纯内部表单型交互**，Route Handlers 用于**可被外部消费或需缓存语义/幂等键**的接口。`/api/quiz/answer` 明确归 Route Handler，理由四条：

1. **需要幂等键与可观测的调用记录**。幂等键（`clientRequestId`）的语义是"HTTP 层可重放的请求标识"，它必须活在 HTTP 语义里（同一个 `clientRequestId` 的两次 POST 在网络层是可区分的）。Server Action 的 action ID 是内部 RPC 标识，外部调用方无法也**不应**依赖它，把它当幂等键等于把内部实现细节当契约。
2. **需要精确的 HTTP 状态码**。`409 DUPLICATE_SUBMIT` / `404 QUESTION_NOT_FOUND` / `503 DB_UNAVAILABLE` 都要能被调用方按状态码分支处理。Server Action 的错误会被 Next 序列化进 RSC 响应体（只有 `digest` 之类），不适合做细粒度契约。
3. **需要独立的可观测链路**。这是唯一有写入语义的接口，必须能被 Vercel Firewall 限流规则精确匹配（`/api/quiz/*`），必须有独立的函数 `maxDuration` 与日志采样策略。Server Action 与页面渲染共享同一个请求，限流粒度与错误隔离都做不到。
4. **将来可能出现的外部消费方**：小程序 / 开放 API / 自动化测试。Route Handler 是天然入口，届时无需迁移。

**保留的 Server Action**：`submitAnswerAction` 仅作为**无 JS 环境（JS 加载失败/极慢网络）的渐进增强回退**路径。它内部调用**完全相同的 `answerService.submit()`**，因此幂等与判分逻辑只有一份实现——**不重复实现业务逻辑**，只是入口不同。⚠️ 风险控制：Server Action 路径**不做幂等**（FormData 无法可靠携带 UUID 且可能被浏览器重放），因此该路径**只在无 `clientRequestId` 时允许**，且响应中标记 `idempotency: 'not_applicable'`。

#### 请求参数

```ts
import { z } from 'zod';

export const QuizAnswerBodySchema = z.object({
  /** 对外不透明题目标识（public_id） */
  questionId: z.string().min(1).max(40),
  /** 必须是该题 options 集合中的 id；注意是 id 不是下标 */
  optionId: z.string().min(1).max(16),
  /** 幂等键：客户端 crypto.randomUUID() 生成，重试必须复用同一个值 */
  clientRequestId: z.string().uuid(),
  mode: z.enum(['level', 'review', 'daily']).default('level'),
  levelId: z.string().regex(/^lv_(0[1-9]|10)$/).optional(),
  /** 仅用于埋点（作答耗时），不参与任何判分逻辑；服务端不信任、不校验合理性 */
  elapsedMs: z.number().int().min(0).max(1_800_000).optional(),
});
export type QuizAnswerBody = z.infer<typeof QuizAnswerBodySchema>;
```

**Body 大小硬上限 4KB**（读 `content-length` 头 + 实际 body 双重检查）→ 超限 `400 PAYLOAD_TOO_LARGE`。

#### 响应体

```ts
export interface QuizAnswerResponse {
  requestId: string;
  correct: boolean;
  correctOptionId: string;
  /** 1 句答案依据（复用词条释义/举例，不另写长解析），必带 */
  explanation: string;
  /** 至少 1 条举例，答错时随解析一起展示（产品 8.7） */
  example: { text: string; style: ExampleStyle } | null;
  termSlug: string;
  termId: string;
  senseId: string | null;
  /**
   * 文案提示，**非计分依据**。连击与分数由客户端计算（架构 ADR-10：无排行榜 → 作弊收益为零 → 不做权威计分）。
   * 服务端只提供「这一题该怎么说话」的提示，避免前端各写一套文案。
   */
  nextComboHint: { label: string; tone: 'praise' | 'encourage' | 'neutral' };
  /** 是否走了幂等重放（true = 本次未产生新的作答事件） */
  idempotentReplay: boolean;
  contentVersion: number;
}
```

**明确的服务端/客户端责任边界**

| 项 | 服务端 | 客户端 |
|---|---|---|
| `answer_key` 判定（对/错、正确选项 id） | ✅ 唯一权威 | ❌ |
| 解析文案、举例 | ✅ | ❌ |
| 连击 combo | ❌ | ✅ localStorage |
| 分数、难度升降档判定 | ❌ | ✅ localStorage |
| 错题本 | ❌ | ✅ localStorage |
| 作答事件落库（去重后） | ✅ | ❌ |

**为什么服务端不校验分数（给出理由，而非默认）**：本产品**没有排行榜、没有奖励、没有付费、没有社交排名**（产品 W7）。用户篡改分数的唯一收益是"自己骗自己看一个高分"，业务价值为零。为零收益场景做服务端权威计分 = 增加接口复杂度（+1 个会话存储）+ 增加延迟（+1 次写往返）+ 增加故障点（会话存储挂了整站答题不可用）。**这是有意识的"够用即止"，在引入排行榜时推翻**（架构 6.4 已列为触发条件）。
但**答案本身必须在服务端**：这不是防作弊，而是**保证释义与判分的一致性**（`answer_key` 与 `explanation` 必须来自同一条题目记录的同一次读取，否则会出现"判对但解析对不上"的可见故障）。

#### 幂等与并发实现（v1 无 Redis 的方案）

**这是本方案最需要论证的一处决策。**

**问题定义**：需要防的是「同一个 `clientRequestId` 被提交多次」。可能的真实来源：① 用户双击；② 网络抖动导致客户端自动重试；③ 恶意脚本刷接口。
**注意防不了什么**：由于分数由客户端算（§上表），重复提交**不会**让用户多得分。所以幂等要保护的真实对象是**① 作答事件表的完整性（否则 WAL/正确率指标被污染）与 ② DB 不被无效查询打爆**。

**被否决的方案**

| 方案 | 否决理由 |
|---|---|
| **完全不做幂等** | ① 作答事件表会被重复写入，`首次答题正确率`（产品 C15，验收目标 55%~70%）直接失真——这是**发布阻塞级验收项**；② 放弃架构明确要求的 `409 DUPLICATE_SUBMIT` 契约；③ 无法给客户端一个明确的"这次算哪次"语义 |
| **只用进程内 LRU** | 多实例下同一 `clientRequestId` 打到不同实例会漏检。Vercel 同一部署会有多个实例并行处理请求，**这不是理论风险而是必然发生**。漏检后果：重复写事件表 → 指标失真（不算致命） |
| **引入 Upstash / Vercel KV（Redis）** | 与已锁定的「v1 无 Redis」冲突；且**它换来的只是一个唯一索引能做的事**——为一个单行唯一约束引入外部服务、一份月费、一个连接池故障点，收益比极低 |
| **客户端本地去重后不上报** | 客户端去重不可信（脚本可绕过），且**客户端去重的数据结构存在 localStorage 里，清缓存即失效** |

**采纳方案：两级去重（内存快路径 + Postgres 唯一约束权威）**

```
Level 1 · 进程内 LRU（快路径，挡住绝大多数重复）
  key   = clientRequestId
  value = { questionId, optionId, response: QuizAnswerResponse, verdict: {correct, correctOptionId} }
  上限  = 5000 条（超出按 LRU 淘汰）
  TTL   = 10 分钟（覆盖所有真实重试窗口；网络重试通常 < 30s）
  命中行为：
    同 questionId + 同 optionId → 直接返回缓存响应，200，idempotentReplay=true
    同 clientRequestId 但 questionId/optionId 不同 → 409 DUPLICATE_SUBMIT
Level 2 · Postgres 唯一约束（权威，跨实例）
  INSERT INTO answer_event (client_request_id, question_id, option_id, is_correct, difficulty, mode, level_id, elapsed_ms, created_at)
  VALUES (...)
  ON CONFLICT (client_request_id) DO NOTHING
  RETURNING id, created_at;
  · 有行返回 → 首次提交，正常返回 200
  · 无行返回 → 已存在 → 再 SELECT 一次该 clientRequestId 的记录：
      - 记录的 (question_id, option_id) 与本次完全一致 → 返回同一 verdict，200，idempotentReplay=true
        （**幂等重放语义：同 key 同 payload 必须返回同一结果，而不是报错**）
      - 不一致 → 409 DUPLICATE_SUBMIT
```

**关键语义决策（与锁定契约的一处有意偏离，需架构师确认）**：架构契约写「重复提交返回 `409 DUPLICATE_SUBMIT`」。我的实现是：
- **同 key + 同 payload → 200 + 重放首次结果**（标准幂等键语义）。理由：网络超时后客户端重试是**正常且期望的行为**，返回 409 会让用户看到"提交失败"，是一个真实的体验故障。
- **同 key + 不同 payload → 409 `DUPLICATE_SUBMIT`**。这才是真正需要拦截的情况（客户端 bug、key 复用、攻击）。
- 409 的 `message` 明确写「这次提交的编号之前已经用过了，请刷新后重试」，把问题定位到客户端而不是用户。

**为什么这套方案成立（三条）**：
1. **零新增基础设施**：唯一约束是 Postgres 天然能力，`answer_event` 表我们**本来就要写**（它是作答事件的唯一存储，见 §7.3），所以这次 INSERT 不是"为了幂等而付出的额外写成本"，而是"本来就要写的埋点，顺带解决了幂等"。**幂等与埋点是同一次写入**——这是本决策最漂亮的地方。
2. **写入量微不足道**：按假设前提【日活 1000、人均 8 次查询/天、查询→测验转化 18%】→ 每天作答事件约 `1000 × 0.18 × 8 ≈ 1440` 条；即使转化率翻倍到 40%，也只有 3200 条/天。Neon Launch 的 300 CU-hrs 绰绰有余。
3. **降级方向明确**：如果 DB 写失败（`DB_UNAVAILABLE`），**仍然把判分结果返回给用户**（判分只依赖读），只是事件不落库、指标当天空一个洞。**判分优先，埋点尽力**——因为用户的学习流程不能被指标采集拖累。

**并发正确性**：单次作答只需「一次主键读（取 answer_key + explanation）」+「一次 INSERT」，**不需要事务**（无跨表写）。并发同一题互不影响。

#### 缓存策略
`Cache-Control: private, no-store`（写接口永不缓存）。
#### 超时：读 `AbortSignal.timeout(700)`；写 `AbortSignal.timeout(500)`（失败即放弃落库）；整体 `maxDuration = 2`，`AbortSignal.timeout(1500)`。
#### CSRF：`Content-Type: application/json`（非 simple request，跨域必触发预检）+ `Sec-Fetch-Site ∈ {same-origin, same-site}` + `Origin` 白名单校验，任一不过 → `403 INVALID_ORIGIN`。详见 §6.2。

#### 调用示例

**请求**
```http
POST /api/quiz/answer HTTP/1.1
Content-Type: application/json
Sec-Fetch-Site: same-origin

{ "questionId": "q_01JABCDEF", "optionId": "o2", "clientRequestId": "6f1a2b3c-4d5e-4f60-8a71-92b3c4d5e6f7", "mode": "level", "levelId": "lv_04", "elapsedMs": 8400 }
```

**响应 200**
```json
{
  "requestId": "cc11dd22-7777-4888-8999-aaaabbbbcccc",
  "correct": true,
  "correctOptionId": "o2",
  "explanation": "PE = 股价 ÷ 每股利润，衡量的是「花 1 元买 stock，一年能赚回多少分」。",
  "example": { "text": "你花 100 元买入一股，它一年赚了 5 元，那市盈率就是 20 倍。", "style": "life_analogy" },
  "termSlug": "pe",
  "termId": "t_pe",
  "senseId": "s_pe_fin",
  "nextComboHint": { "label": "连对 3 题", "tone": "praise" },
  "idempotentReplay": false,
  "contentVersion": 42
}
```

**响应 409（同一 clientRequestId，不同 optionId）**
```json
{
  "error": {
    "code": "DUPLICATE_SUBMIT",
    "message": "这次提交的编号之前已经用过了，请刷新后重试。",
    "requestId": "dd22ee33-8888-4999-8aaa-bbbbccccdddd",
    "retryable": false
  }
}
```

---

### 2.6 `POST /api/quiz/answer` 的 Server Action 回退（非对外契约）

```ts
// apps/web/src/app/quiz/actions.ts
'use server';

/** 内部实现，非对外契约。无 JS 环境回退路径。 */
export async function submitAnswerAction(
  prevState: QuizAnswerUiState,
  formData: FormData,
): Promise<QuizAnswerUiState> {
  const parsed = QuizAnswerFormSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { status: 'error', message: '提交内容不完整，请重试。' };
  const { questionId, optionId, mode } = parsed.data;
  // 注意：FormData 路径无 clientRequestId → 幂等不适用
  return answerService.submit({ questionId, optionId, mode, clientRequestId: null });
}
```

**约束**：`answerService.submit()` 是唯一实现，Route Handler 与 Server Action 都调它；入参 `clientRequestId: string | null`，为 `null` 时跳过 Level 1/2 去重并在响应里标 `idempotentReplay: false` + `idempotency: 'not_applicable'`。

---

### 2.7 `GET /api/og/term/[slug]`

**方法/路径**：`GET /api/og/term/[slug]`　**契约级别**：对外契约（社交平台会跨站拉取，必须可公开访问）　**幂等**：是

#### 请求参数
- `slug`：同 `TermSlugSchema`（不匹配 → 返回**默认兜底图**，见下）

#### 响应体
`image/png`，1200×630（`ImageResponse`，Node runtime）。

#### 关键实现决策

| 决策 | 结论 | 理由 |
|---|---|---|
| 词条不存在 | **返回 200 + 默认兜底图**（"这个术语我们还没收录"），**不返回 404 JSON** | 社交平台的爬虫会把 404 图片缓存成永久坏图；兜底图可正常分享，且不泄露 slug 存在性 |
| 缓存 | `Cache-Control: public, max-age=86400, s-maxage=604800, immutable`，`ETag: "og-{slug}-v{contentVersion}"` | OG 图永不变化（同 contentVersion），可以长缓存 |
| 失效 | 内容发布时 `revalidateTag('term:{slug}')` 连带打掉 | — |
| 内容渲染 | **只渲染 `displayName` + `primaryPlainExplain`（≤40 字）+ 免责短句**，均为编译期受控的 MDX 数据 | 避免把长文本塞进图片；避免任何用户输入进入图片渲染路径 |
| 字体 | 自托管中文子集字体，`font-display: block` | 字体加载失败会导致 `ImageResponse` 抛错 → 5xx |
| `alt` 文本 | 由 `Referer`/平台决定，服务端无法控制；因此**正文语义必须完整**（爬虫不看图） | 强化了「OG 图只是入口，SEO 靠 SSG 页面」的设计 |

#### 调用示例
`GET /api/og/term/pe` → `200 image/png`（约 18~35KB）

---

### 2.8 `GET /api/health`

**方法/路径**：`GET /api/health`　**契约级别**：对外契约（运维/监控）　**幂等**：是

#### 请求参数
无。

#### 响应体

```ts
export type HealthStatus = 'ok' | 'degraded' | 'error';

export interface HealthResponse {
  status: HealthStatus;
  /** 词库版本与索引 checksum；不泄露主机名/连接串/版本细节 */
  index: { ready: boolean; version: number; checksumAligned: boolean };
  db: { reachable: boolean; /** 只给布尔，不给延迟细节给公网 */ };
  /** 服务端运行时长（秒） */
  uptimeSeconds: number;
  /** 契约版本，客户端可据此判断兼容性 */
  contractVersion: string;
  checkedAt: string;
}
```

#### 缓存与安全
- `Cache-Control: no-store`（**永不缓存**，否则探针会读到旧状态）
- **信息泄露防护**：公网可见的健康检查**不得**返回数据库主机名、连接池大小、驱动版本、异常堆栈、内部服务地址。内部完整诊断走 Vercel 函数日志与集成面板，不经此端点。
- **限流豁免**：需在 Vercel Firewall 规则中**排除 `/api/health`**，否则全站 300 req/min 规则会让探针误判为故障（每次探测返回 429 = 假警报）。【待确认】需运维在 Firewall 配置中显式豁免。

#### 判定逻辑

```ts
if (!index.ready) return 'error';                        // 503 INDEX_NOT_READY
if (!db.reachable) return 'degraded';                    // 200，但 DB 不可用
if (!index.checksumAligned) return 'degraded';           // 200，但索引与 DB 版本不一致（自洽优先）
return 'ok';
```
**故意不用 503 表示 degraded**：Neon 短暂抖动不应让平台把整个应用摘除——此时术语页（SSG/ISR）完全正常，摘流量反而伤害可用性。

---

## 3. 检索接口的详细实现

### 3.1 五级降级与权重（服务端实现细节）

`packages/matcher/src/weights.ts`：
```ts
export const WEIGHTS = {
  EXACT_PRIMARY: 100,
  EXACT_ALIAS_CN: 95,
  EXACT_ALIAS_EN: 92,
  EXACT_PINYIN_ABBR: 90,
  EXACT_PINYIN_FULL: 88,
  COLLOQUIAL: 90,
  MISSPELL: 80,
  PREFIX: 78,
  SUBSTRING_IN_ALIAS: 66,
  FUZZY_GRAM: 45,
  PG_TRGM: 35,
} as const;
```
**排序稳定性**：`sort` 必须是全序，不能依赖引擎稳定性。比较链：
```ts
candidates.sort((a, b) =>
  b.score - a.score
  || b.term.popularity - a.term.popularity
  || a.term.slug.localeCompare(b.term.slug)   // 最终兜底，保证同分同热度时顺序确定
);
```
最后一行 `slug` 兜底很重要：没有它，`/api/search` 的响应在相同 score/热度下可能不稳定，客户端 `useEffect` 依赖数组会反复重渲染，且埋点的 `rank=1` 归属会漂移。

### 3.2 整句模式：AC 自动机 + 自写裁决层

**裁决层是必须自写的**（架构结论），服务端实现顺序（严格按此序，每一步都可独立单测）：

```
① collectSpans(normText)      → AC 一次遍历输出全部 span（含被更长匹配包含的短匹配）
② sortSpans(spans)            → (长度 desc, 起点 asc)
③ greedyLongest(spans)        → 贪心取最长；若新 span 与已选 span 重叠 → 丢弃较短的
④ chineseBoundaryCheck(spans) → span 左右相邻字符若仍是中文字符 → 丢弃
     例：「市盈率」不应命中单字词条「市」
⑤ englishBoundaryCheck(spans) → span 左右相邻字符若仍是 [A-Za-z0-9] → 丢弃
     例：「PE」不应命中「OPEN」内部
⑥ resolveEqualLengthConflict   → 同位置多个等长候选 → 取 popularity 高者；仍相同 → 取 slug 字典序
⑦ mapSpanToTerm               → span.key → termId
⑧ disambiguate                 → 三级降级（§3.3）
⑨ toRawSpan                    → 经 offsetMap 反查为原始输入坐标
```

**④⑤ 的判定细节（易错点）**：中文边界检查判定「相邻字符是否 CJK」用正则 `[\u4e00-\u9fff\u3400-\u4dbf]`，**不含标点**。所以「市盈率（PE）」中「PE」右邻是 `）` → 判定为独立词，正确命中；而「市盈率」中「市」右邻是「盈」→ 丢弃，正确。
**被否决的做法**：把标点也算作"词内字符"会导致「（PE）」里的 PE 被丢；完全不做边界检查会让「OPEN」命中「PE」。

**整句模式的一个补充策略（架构已提"允许补充整体查询"）**：整句识别有结果时，**仍额外跑一次单词模式的 L0 精确**（仅 normKey 整体，不跑 L1~L3），因为用户输入「市盈率 PE ROE」时若 AC 因边界规则漏掉了某个词，整体精确匹配能补上。此步骤的候选 score 用 `SUBSTRING_IN_ALIAS`，排不到前面但不会丢失。

### 3.3 三级降级消歧（服务端实现）

```ts
// 第一级：sense 级专属别名直连消解（不需打分，最可靠）
const directSenseId = index.aliasSenseOf(matchedNormKey);   // alias.sense_id 非空即为直连
if (directSenseId) return { senseId: directSenseId, confidence: 1.0, isLowConfidence: false };

// 第二级：上下文关键词加权打分
score(sense) = Σ weight(k) for k ∈ (sense.contextKeywords ∩ contextTokens)
             + adjacencyBonus(关键词在命中词 ±10 字符内) × 1.5
             + (sense.isPrimary ? 0.5 : 0)
const ranked = senses.sort((a, b) => b.score - a.score || (b.frequencyWeight) - (a.frequencyWeight));
const top = ranked[0];
const second = ranked[1];
const isLowConfidence = !second || (top.score - second.score) < 0.3;

// 第三级：低置信兜底
if (isLowConfidence) {
  // 返回主义项作为默认展示 + 携带 alternatives 供 UI 切换（不打断用户、不弹窗）
  const primary = senses.find((s) => s.isPrimary) ?? top;
  return { senseId: primary.senseId, confidence: Math.min(top.confidence, 0.69), isLowConfidence: true, alternatives: ranked.map(...) };
}
```

**`contextTokens` 的来源（整句 vs 单词不同）**：整句模式用**整句归一化文本**分词后的 token 集合 + 命中 span ±10 字符窗口；单词模式（无上下文）下 `adjacencyBonus` 恒为 0，此时退化为「纯关键词匹配 + 主义项偏置」——而单词查询时用户本来就是查这个词的默认含义，所以这个退化是**符合预期**的，不是缺陷。

**为什么不用 LLM 做消歧（v1）**：词库 120 条、主义项命中率本就很高、三级方案完全可解释（运营能预判用户看到哪个义项）；引入 NLU 增加成本与不确定性，且**不可解释的消歧会让"内容准确性"这个最大产品风险更难管控**。

### 3.4 未命中（`isMiss=true`）的建议生成

**问题**：`/api/search` 必须返回 ≥3 条相近词（F6，★ 阻塞项）。候选来源有三种，各自覆盖不同的未命中原因。

| 来源 | 覆盖的未命中原因 | 例子 | 缺点 |
|---|---|---|---|
| 编辑距离最近 | 用户**打错了**（错别字、记不清） | 「弥留反弹」→「死猫反弹」 | 对完全无关的词（如 QQQ）会给出噪音 |
| 同分类热门 | 用户**知道大概领域**但记不清说法 | 搜「美债收益率」→ 同属宏观政策的「国债收益率」 | 未命中时我们不知道他属于哪个分类 |
| 全站热门 | 用户**完全没头绪**（只记得"有个金融词"） | 搜「qqq」→ 给 ETF、股票、ETF 联接 | 与本次查询无关，像在凑数 |

**决策：三层级联（cascade），每层配额固定，最终去重后取前 3。**

```
Layer 1 · edit_distance（配额 2）
  从 gram 倒排召回 Top-20 → 逐个算编辑距离（与 L3 同一套实现）
  ≤4 字符允许距离 1，否则 ≤2
  排序：距离 asc → popularity desc → slug asc
  取前 2

Layer 2 · same_category（配额 2 → 去重后不足则留空）
  从 Layer 1 命中项的 categoryId 出发，取同 category 且 difficulty 相同的高热词
  若 Layer 1 全空 → 用「热度最高的 3 个分类各取 1 个最高热词」
  排序：popularity desc

Layer 3 · popular（配额 1 → 兜底补齐）
  进程内静态热门表（编译期生成，随词库发布更新），排除已选
  取第 1 个

最终去重（按 termId）→ 不足 3 条时，用热门表顺序继续补齐
```

**为什么这样分层（决策 + 理由）**：
1. **不命中原因是多峰的**：错别字占相当比例（产品断点 A 明确要求错别字容错），但真实的生僻词/新词（如 QQQ、某个新出的政策词）也占比例。**单一策略必然在某一类上表现很差**——纯编辑距离会让「搜 QQQ」返回一堆乱码近邻（比不给建议更伤信任），纯热门会让「打去库存」返回一堆无关词（用户还是搜不到）。
2. **每条建议都带 `source` 与 `reason`**：这不只是 UI 装饰。它让运营能看懂"用户为什么没搜到"——若 `edit_distance` 来源占比高，说明词库缺错拼别名；若 `popular` 占比高，说明词库整体覆盖不足。**建议列表本身就是词库缺口探针**（产品 R4 的"缺口池"由此自动化，产品 R4 原本要求人工维护缺口池）。
3. **不返回模型编造的"你是不是想找…"**：产品 R4 明确"无结果不猜测"。所有 suggestion 必须是**库内真实存在的词条**，这是信任底线。
4. **被否决：返回"热门搜索榜"给用户**（业界常见做法）——理由是它会让搜索框变成"随便看看"，与"帮用户找到他要的词"的产品目标（断点 A）背道驰驰，且 120 条词库的热门榜对长尾用户毫无帮助。

### 3.5 缓存击穿防护的完整机制

四道防线（按触发顺序）：

```
防线 1 · 单飞（single-flight）
  进程内 Map<cacheKey, Promise<T>>；命中已有 Promise → 直接 await
  作用：并发 100 个相同热门查询 → 只回源 1 次
  释放：Promise settle 后从 Map 删除（无论成功失败，finally 里删）

防线 2 · stale-while-revalidate（宽限返回）
  缓存条目带 freshUntil = createdAt + 3000s，总 TTL = 3600s
  命中时：freshUntil 内 → 直接返回
         超过 freshUntil → 立即返回旧值 + 后台异步刷新（不 await，失败则保留旧值）
  作用：DB 抖动时缓存接口**不会集体超时**

防线 3 · TTL 抖动
  实际 TTL = base × (0.9 + random × 0.2)
  作用：防止批量发布的 2000 个词条 tag 同时失效导致集体回源

防线 4 · 负缓存 + 熔断
  负缓存：miss 结果 TTL 15s（远小于正缓存），挡住"对不存在的词反复探测"
  熔断：DB 连续失败 ≥5 次 → 打开熔断 30s，期间 hydrate 直接返回 card=null（不做 DB 调用）
        半开：30s 后放 1 个探测请求，成功则关闭，失败则继续熔断
  作用：DB 挂掉时 QPS 不会全部打在 DB 上（防止级联崩溃）
```

**熔断器放在哪一层（决策）**：放在 `hydrate` 层而**不是**整个检索层。因为检索（内存索引）在 DB 挂掉时**仍然完全可用**——这正是"Neon 挂了网站还能查词"的技术基础。若把熔断放在检索层，会把还能用的检索一起干掉，是错误的熔断粒度。

### 3.6 缓存键规范（消除歧义，避免上线后 key 冲突）

| 缓存 | key 构成 |
|---|---|
| 进程内候选 LRU | `cand:{indexChecksum8}:{normKey}:{inputKind}:{categoryId\|'-'}:{difficultyCap\|'-'}` |
| 进程内负缓存 | `neg:{indexChecksum8}:{normKey}` |
| 进程内热门 LFU | `hot:{indexChecksum8}:{normKey}` |
| `unstable_cache` 热查 | `search:{contentVersion}:{normKey}:{limit}` |
| `unstable_cache` hydrate | `term-card:{contentVersion}:{termId}` |
| `unstable_cache` 关卡题池 | `level:{contentVersion}:{levelId}` |
| 幂等 LRU | `idem:{clientRequestId}` |
| 单飞表 | 同各缓存 key |

**所有 key 都带 `contentVersion` 或 `indexChecksum8`**：内容一发布，旧 key 自然不再被命中（虽然 tag 失效也会清，但双保险避免"tag 失效失败时读到旧数据"）。

---

## 4. 索引与缓存热更新（服务端运行时）

### 4.1 内存索引单例 + SWR 双缓冲

```ts
// apps/web/src/server/index/matcher-instance.ts （结构示意，非完整实现）
type MatcherState =
  | { status: 'uninitialized' }
  | { status: 'building'; startedAt: number }
  | { status: 'ready'; matcher: Matcher; version: number; checksum: string; builtAt: string }
  | { status: 'failed'; error: string; lastGood: Matcher | null; lastGoodVersion: number };

const globalRef = globalThis as unknown as { __glossaryMatcher?: MatcherState; __glossaryBuildPromise?: Promise<void> };
```

**要点（四个必须做对的细节）**：

1. **挂在 `globalThis` 上**：Next.js dev 模式与 HMR 会反复重求值模块，模块级变量会被重置 → 索引被重复构建（架构 §1.1「单例加载」的落地细节）。开发模式下重复构建掩盖了生产环境的 bug，所以必须用 `globalThis` 强制单例。

2. **SWR 双缓冲（必须，无替代方案）**：
   ```
   检测到 content_release.version 变化（或冷启动首次构建）
     → 构建【新实例】completely，build() 期间不触碰当前实例
     → 构建成功 → 原子替换 globalRef.__glossaryMatcher 的引用（单次赋值，JS 单线程天然原子）
     → 旧实例保留 60s（让在途请求安全完成）→ 释放
   构建失败 → 保留旧实例，状态回退为 ready(旧)，记录 error，指数退避重试（30s → 60s → 120s，上限 5min）
   ```
   **为什么必须双缓冲（不是过度设计）**：AC 自动机在扫描中途若节点被替换（原地更新 Trie/转移表），会读到半新半旧的状态，产出**不可预测的 span**——这类 bug 表现为"偶发的错误高亮"，排查成本极高。双缓冲保证任意时刻的请求看到的是一个**自洽的完整版本**。

3. **版本校验与"自洽优先"**：
   ```
   每 5 分钟（unstable_cache('content-release-meta', revalidate: 300)）拉 content_release.version/checksum
   若与当前实例的 version 不同 → 触发重建
   重建时：若 DB 查询成功 → 用新版本；加载中途 DB 失败 → 继续用旧索引
   加载成功后再比对 checksum：
     index.checksum !== release.checksum → 
       ① 保持使用「旧索引 + 旧内容」的**自洽组合**（绝不混用新索引 + 旧内容，那会返回不存在的 termId）
       ② degraded.staleIndex = true
       ③ 记录 ERROR 日志并触发一次告警（索引与 DB 长期不一致是发布管线故障）
   ```

4. **不做主动常驻轮询**：无 Redis、无常驻进程 → 无法做可靠的定时任务。改为 **SWR + 请求驱动检查**（每个请求检查一个 300s 缓存的 meta，成本 ≈0）。代价是**若无流量则不重建**——但这没关系：没有流量时没人需要新索引；下次有流量时立刻重建。

**被否决方案**：Vercel Cron + 外部触发重建 → 需要一个可被外部调用的重建端点，等于新增对外攻击面，且收益（提前 5 分钟重建）在分钟级生效要求下没有价值。

### 4.2 `revalidateTag` 精确失效清单（内容发布后由 CI 调用）

```
revalidateTag('lexicon')                        // 词库快照
revalidateTag(`term:{slug}`)  // 每个变更词条
revalidateTag(`category:{id}`)   // 变更词条所属分类（一级 + 二级都打）
revalidateTag(`level:{levelId}`) // 若变更词条在该关题池内（按 term 反查 level）
```
⚠️ Next 16 细节：`revalidateTag` 需配合 `cacheLife` profile 使用；且它是 **tag 级**失效，不支持"只失效某个 key"。因此 tag 粒度设计要保守——**宁可 tag 多一点，也不要 tag 太粗**（一个粗 tag 会连带失效大量缓存）。分类 tag 建议按「一级分类」粒度，不按二级。

---

## 5. 错误处理与降级矩阵

### 5.1 完整矩阵

| # | 故障场景 | 检测方式 | 降级行为 | 用户感知 |
|---|---|---|---|---|
| 1 | **Neon 完全不可用**（术语详情页） | `hydrate` 抛连接错误 / 800ms 软超时 | 术语页走 **SSG/ISR 缓存**（`unstable_cache` tag 命中即返回上次内容）；CDN 命中时**函数根本不被调用**，用户完全无感 | **无感知**（CDN 命中）；仅当 CDN 也未命中且 DB 不可用时，短暂显示上次缓存内容 |
| 2 | **Neon 完全不可用**（搜索） | 同上 | 内存索引仍完整可用：命中 termId 与 sense，但 `card: null` + `degraded.contentUnavailable = true`；客户端渲染「术语名 + 一句话 loading + 进详情链接」，详情走 ISR 缓存 | 轻度：卡片骨架显示「释义加载中」，**不白屏、不报错**（这不是错误页，是部分降级） |
| 3 | **Neon 完全不可用**（出题） | 题池查询失败 | **不降级**，返回 `503 DB_UNAVAILABLE`（retryable=true）→ 客户端用 localStorage/IndexedDB 缓存的题目继续（「网络异常，使用离线题库」） | 明确提示 + 可继续答题 |
| 4 | **Neon 完全不可用**（判分） | answer_key 读取失败 | 返回 `503 DB_UNAVAILABLE`；客户端本地标记该题「待校验」，不计入错题本 | 轻提示「这道题暂时无法判分」 |
| 5 | **Neon 写不可用**（事件落库） | INSERT 抛错 / 500ms 软超时 | **判分结果照常返回 200**（判分只依赖读）；仅事件不落库，指标当天空一个洞 | **无感知**（埋点是尽力而为） |
| 6 | **AC 自动机构建失败**（冷启动异常） | `build()` 抛错 | 三级降级：① 跳过整句模式，只跑单词模式 L0~L3；② 若 L0~L3 也全空 → 退化为纯 `pg_trgm`；③ pg_trgm 也不可用（Neon 同时挂）→ `503 INDEX_NOT_READY`，客户端用本地 lexicon 兜底 | 搜索变慢但可用；整句高亮暂不可用（单词查询不受影响） |
| 7 | **`/api/quiz/next` 失败** | 网络错误 / 5xx | 客户端用 IndexedDB 缓存的最近一次题目继续答题，展示「网络异常，使用离线题库」；作答标记为「待校验」，网络恢复后批量补交（复用同一 `clientRequestId`，天然幂等） | 明确提示，**可继续闯关，不丢进度** |
| 8 | **`/api/quiz/answer` 失败** | 网络错误 / 5xx | 客户端本地记为「待校验」；**不写入错题本**（避免把判错的题当错题污染统计）；恢复后重试（同 `clientRequestId`） | 无阻断感（作答界面已乐观更新） |
| 9 | **Vercel 函数冷启动** | 首次请求，Matcher 处于 `building` | 单例 `building` 期间：词条详情走 CDN 缓存（无感）；搜索等待索引构建（<300ms）而非返回 503；`unstable_cache` 已命中的接口直接返回 | 首请求略慢（目标 <300ms）；不出现 503 |
| 10 | **索引与 DB 版本不一致** | `index.checksum !== release.checksum` | **自洽优先**：用旧索引 + 旧内容，绝不混用；`degraded.staleIndex = true`；触发重建 + ERROR 告警 | 短暂显示旧版本内容（最多几分钟） |
| 11 | **CDN 缓存陈旧** | TTL 到期或 tag 失效失败 | TTL 兜底（术语页 1h、lexicon 5min 浏览器 / 1h CDN）；`stale-while-revalidate=86400` 保证极端情况下也返回可接受内容而非 5xx | 最多延迟数分钟看到新内容 |
| 12 | **限流 429** | Firewall 返回 429 / 进程内令牌桶 | 返回 `429 RATE_LIMITED`（`retryable: true` + `retryAfterMs`）；客户端指数退避，**不弹错误弹窗**（正常用户不该感知到限流） | 无感（自动退避） |
| 13 | **`pg_trgm` 兜底查询失败** | 查询抛错 | 直接判 miss（不进 `degraded`），走建议生成 | 无感 |
| 14 | **`hydrate` 部分条目失败** | `Promise.allSettled` 部分 rejected | 该条 `card: null`，其他条目正常返回 | 单个卡片显示「释义加载中」 |
| 15 | **请求体超限** | `content-length` / 实际长度 > 4KB | `400 PAYLOAD_TOO_LARGE` | 无感（正常客户端不会触发） |
| 16 | **缓存 key 冲突 / tag 失效失败** | 预防性：key 中带 `contentVersion` | 双保险：即使 tag 失效失败，version 变化也使旧 key 不再命中 | 最多延迟到 TTL 到期 |

### 5.2 三个容易做错的降级决策（明确列出结论）

| 决策点 | 结论 | 理由 |
|---|---|---|
| 熔断粒度 | 熔断 `hydrate`，**不熔断检索** | 检索在 DB 挂时完全可用。熔错粒度 = 把还能用的功能一起干掉 |
| DB 写失败时是否还返回判分 | **返回** | 判分只依赖读。埋点是尽力而为，不能拖累用户的学习流程 |
| 索引 checksum 不一致时是否用新索引 | **不用，用旧索引 + 旧内容** | 「新索引 + 旧内容」会返回 DB 里已不存在的 termId → 前端拿到坏数据。自洽优先 |

---

## 6. 安全实现

### 6.1 XSS：高亮是最易被忽视的 XSS 面

**服务端能做的（强制约束）**：

| # | 措施 | 落点 |
|---|---|---|
| 1 | **服务端返回的所有用户输入派生字段都是纯文本语义**：`query.normKey`、`display`、`matchedAlias` 一律进 `textContent` 渲染路径 | 契约层：字段命名不含 `html`/`richText` 语义；文档明确「所有 string 字段均为 plain text」 |
| 2 | **`/api/search` 完全不回显原始输入**（见 §6.3） | 从源头消灭反射型 XSS 的载体 |
| 3 | **响应头 `X-Content-Type-Options: nosniff`** | 防 MIME 混淆（把 JSON 当 HTML 执行） |
| 4 | **JSON 端点不做内容协商**：始终 `application/json; charset=utf-8` | 浏览器不会把 `application/json` 当 HTML 执行 |
| 5 | `proxy.ts` 统一输出安全响应头（含 CSP），覆盖页面与 API | 见 §6.5 |
| 6 | ESLint `react/no-danger: error`；**CI 硬拦**（不只是 lint warning） | 高亮必须用 React 文本节点 + `<mark>` 分段包裹 |

**为什么服务端要管 XSS（这不是前端的事）**：搜索接口把「用户输入」与「服务端回显」结合在一起，是**唯一一个输入源不完全受控的对外端点**。即使当前前端实现正确，接口被第三方消费（这正是我们把它定为对外契约的原因）时，`display` 类字段就是活的 XSS 载体。所以"不回显原始输入"是**服务端必须做的防御**，不能推给前端。

### 6.2 CSRF

| 接口 | 防护 |
|---|---|
| 所有 `/api/quiz/answer`（唯一写接口） | 三重校验，任一不过 → `403 INVALID_ORIGIN`：① `Content-Type` 必须是 `application/json`（非 CORS simple request，跨域必触发预检，而表单无法发送该 Content-Type）；② `Sec-Fetch-Site ∈ {same-origin, same-site}`；③ `Origin`（若存在）必须在白名单内（`APP_ORIGIN` 环境变量 + Vercel 预览域名规则） |
| Server Actions | Next 内置 origin 校验，不额外实现 |
| 读接口 | 全部 GET，无副作用，不需要 CSRF 防护 |

**被否决**：自造 CSRF token + 双提交 Cookie。理由：**本项目明确零 Cookie**（合规红线），双提交 Cookie 的前提是有 Cookie；`Content-Type: application/json` + `Sec-Fetch-Site` 的组合在现代浏览器下已足够，且不引入任何持久状态。

### 6.3 反射面：为什么 `/api/search` 不回显原始输入

**决策**：`/api/search` 响应中**不包含 `query.display`（原始输入）**，只有 `query.normKey`（归一化键）。

**理由（三条）**：
1. **客户端不需要**：原始输入就在客户端手里（用户刚输入的），回传是纯浪费（同 P95 响应体膨胀）。
2. **消灭反射型 XSS 载体**：服务端主动回显用户输入的那一刻，就创建了一个"攻击者可控内容进入服务端响应"的链路，即使前端当前不渲染它，风险也随接口被外部消费而放大。
3. **消除缓存错配风险**：若回显输入并对响应做 CDN 缓存，热门 query 的缓存条目会把**发起者的原始输入**返回给其他用户。归一化键与缓存 key 一致，所以回传 `normKey` 不存在这个问题。

`normKey` 为什么安全：因为缓存 key 本身就包含 `normKey`，任何缓存命中都意味着"请求的归一化键与缓存内容的键一致"，不存在错配可能。

### 6.4 SQL 注入与资源耗尽

| 威胁 | 措施 |
|---|---|
| SQL 注入 | Drizzle 全部参数化；**无任何字符串拼接 SQL** |
| `ORDER BY` 注入 | v1 的对外 API **不存在 `sort`/`order` 参数**（预防性规则，写入 `db/queries.ts` 的代码评审清单）；数据侧的排序白名单以 TypeScript 枚举 + `as const satisfies readonly [...]` 形式定义，禁止传字符串 |
| `pg_trgm` 查询 | `similarity(alias.norm_key, ${sqlParam}) >= ${threshold}` —— 阈值用**数字常量内联**（不是字符串插值），查询串参数化 |
| 输入长度 | 200 字符硬上限（归一化**前**判断，防零宽字符绕过） |
| 结果条数 | `limit ≤ 20` 且超限报 400（不静默截断） |
| `termIds` 数量 | ≤ 50；`excludeQuestionIds` ≤ 20 |
| 请求体 | POST ≤ 4KB |
| **资源耗尽（AC 扫描）** | 200 字符上限已把 AC 输入规模钉死在 1KB 内 → 扫描成本恒定 O(n+m)，**单次请求的计算量有硬上界** |
| **正则回溯（ReDoS）** | 归一化管线的所有正则必须**线性安全**（无嵌套量词）。⚠️ 边界检查用的中文正则 `[\u4e00-\u9fff\u3400-\u4dbf]` 是单字符类，线性安全 ✅。**代码评审清单必须包含「所有正则无嵌套量词」** |
| 函数并发 | Vercel 侧设置 `maxDuration`；`/api/lexicon` 单独压低（载荷大、缓存命中率高，不需要长执行） |
| 限流（兜底） | Firewall 为主（跨实例）；进程内令牌桶为辅（Firewall 未生效时仍有保护）。**诚实说明：进程内令牌桶在多实例下精度下降（实际限额 ≈ 配置值 × 实例数），只能作兜底不能作主防线** |

### 6.5 安全响应头（`apps/web/src/proxy.ts` 统一输出）

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'nonce-{RANDOM}' 'strict-dynamic' https:;
  style-src 'self' 'unsafe-inline';          ← Tailwind 与 Radix 运行时样式需要；见下方说明
  img-src 'self' data: blob:;
  font-src 'self';
  connect-src 'self';                         ← MVP 不接任何第三方
  object-src 'none';
  base-uri 'self';
  form-action 'self';
  frame-ancestors 'none';
  upgrade-insecure-requests;
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
X-Frame-Options: DENY
Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=(), browsing-topics=(), payment=(), usb=()
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
```

**两个需要说明的取舍（诚实标注）**：

| 取舍 | 结论 | 理由 |
|---|---|---|
| `style-src 'unsafe-inline'` | **保留** | Tailwind v4 的运行时注入 + Radix 的 inline style（CSS 变量、动画进度、Popper 定位）依赖内联样式。`style-src` **不执行脚本**，去掉会直接破坏 UI。**安全上可接受**：XSS 的实际执行入口是 `script-src`，`style-src` 的风险面是 CSS 注入导致的 UI 欺骗（需要攻击者已能注入 HTML，成本极高）。⚠️ 不为了形式上的严格而破坏功能 |
| `script-src` 保留 `https:` 兜底 | **保留** | `strict-dynamic` 下，**支持 CSP3 的浏览器会忽略 host 白名单**，只认 nonce；老浏览器才回退到 host 白名单。保留 `https:` 是为老浏览器兜底。这与「不用 unsafe-inline」不冲突（两者语义不同） |

**nonce 生成**：`proxy.ts` 中 `crypto.randomUUID()` 生成 → 同时写入请求头 `x-nonce` 供 RSC 读取 → 响应头 CSP 引用。⚠️ Next 16 需注意：`proxy.ts` 设为动态渲染会使整站放弃静态优化，**故 nonce 只加在需要 CSP 的文档响应上，静态资源与 `/api/**` 不加**（JSON 端点不需要 CSP，见下）。

**API 端点的响应头策略（与页面不同）**：`/api/**` **不下发 CSP**（CSP 是文档级防护，JSON 不存在脚本执行上下文）。API 只发 `X-Content-Type-Options` + `Cache-Control` + `X-Request-Id`。**给 JSON 加 CSP 是常见的无意义开销**。

### 6.6 MDX 安全（内容层，服务端职责是发布校验）

| 措施 | 说明 |
|---|---|
| MDX 编译期禁用原始 HTML | `rehype-raw` **不启用**；`mdxOptions.rehypePlugins` 白名单，不允许 `dangerouslySetInnerHTML` 类插件 |
| MDX 组件白名单 | 只允许 `ExampleBlock / RelatedTerms / RiskNote / PlainExplain` 等自建组件；未知组件在编译期报错（不是渲染期报错） |
| 内容进 DB 前剥离 | 编译产物只保留结构化字段（`plainExplain` 等纯文本），**释义正文以纯文本入库**，不存 HTML → 渲染期天然无 XSS 面 |
| CI 硬拦 | 禁用词扫描（买/卖/建议/目标价/稳赚/必涨/值得入手/加仓/满仓）、`plainExplain ≤ 40` 字、人话层黑话扫描 |

### 6.7 内容合规（服务端职责边界）

| 措施 | 说明 |
|---|---|
| 免责数据化 | `disclaimer` 表带 `version`；响应返回 `{code, version, short}`；**正文与免责必须来自同一次缓存写入**（防「新正文 + 旧免责」错配） |
| 禁用词门禁 | CI 阶段硬拦（`买/卖/建议/目标价/稳赚/必涨/值得入手/加仓/满仓`），命中即阻断发布 |
| 未成年人边界 | API **不提供**任何年龄/画像字段（无账号即无从采集）；年龄段适配靠**内容分层**（`difficulty` + 三层释义）而非用户画像 |
| 无 PII 端点 | v1 不存在任何接收用户身份信息的端点（`/api/feedback` 为 v2，且**即使上线也不应接收 PII**） |

---

## 7. 埋点与可观测性

### 7.1 北极星指标与「为什么不是查询数」

**北极星 = 周活跃学习者 WAL** = 自然周内**完成 ≥1 次测验作答**的去重用户数。

**为什么不用查询数（这是本方案最重要的一条度量纪律）**：
- 查询数会被**划水式浏览**刷高——用户输入「市盈率」看到卡片就走，和真的学会了，产品价值完全不同。
- 停留时长无法区分「读懂了」和「卡住了」。
- **只有"发生了一次作答行为"才是比阅读更强的学习信号**（北极星定义直接采用产品定义）。

⚠️ **一个必须诚实面对的技术约束（此条为本方案新增发现，架构文档未覆盖）**：
在**零 Cookie、零账号**的合规前提下，**服务端无法计算任何"去重用户数"**——UV/WAL 必须依赖免 Cookie 的客户端分析（Vercel Web Analytics）。因此：
- **UV 类指标（WAL、查询用户数、转化率的用户级 join）→ 只能来自客户端分析**（`@vercel/analytics` 埋点，服务端埋点做不到）。
- **服务端 `answer_event` 表只用于内容质量分析，绝不用于用户级去重统计**。
- **绝不能为了算 UV 而自建"匿名设备标识 + 行为明细表"**——那等于在服务端重建用户画像，**直接违反产品 L6「匿名标识不可回溯个人」与架构 4.5「零个人数据采集」的合规红线**。这是一个"看起来很自然但绝对不能做"的诱惑，明确写出来以避免后续实现时误入。

### 7.2 服务端埋点（结构化日志，非用户画像）

服务端**不持久化行为明细到可识别个体的维度**。`answer_event` 表只存**不含任何标识符**的作答事实。

**`answer_event` 表的字段要求（供数据工程师对齐，本文不给 DDL）**

| 字段 | 类型 | 说明 |
|---|---|---|
| `client_request_id` | UUID | **幂等键 + 唯一约束**（§2.5 核心） |
| `question_id` | 文本 | 对外 `public_id` |
| `option_id` | 文本 | 用户选的选项 id |
| `is_correct` | 布尔 | 判分结果 |
| `difficulty` | 1/2/3 | **冗余存储题目难度**（避免每次分析都 join 题目表，题目可能后续被删） |
| `mode` | 枚举 | level / review / daily |
| `level_id` | 文本 | 可空（review 模式无） |
| `elapsed_ms` | 整数 | 可空。**不信任、不校验合理性**（仅均值参考，不做超时判定） |
| `content_version` | 整数 | 作答时的词库版本（关键：词库改了之后历史正确率不可直接比较） |
| `created_at` | 时间戳 | |
| **保留期** | — | **90 天后自动清理**（不留长期行为记录，这是隐私友好的默认值） |

**明确不采集的字段**（写入代码评审清单）：`IP`、`User-Agent`、`Referer`、`deviceId`、`anonymousId`、`任何可回溯到个人的哈希`。
`x-forwarded-for` **仅在限流中间件内用于内存计数，绝不落日志**（架构 4.5 的隐私约束比排障便利更重要）。

### 7.3 服务端埋点事件清单

| 事件 | 触发点 | 关键属性（全部为低基数枚举/数值） | 用途 |
|---|---|---|---|
| `term_search` | `/api/search` | `hit:boolean`、`matchedBy`、`layer`、`matchedCount`、`tookMs`、`degraded.*` | **查询成功率**（`hit=true` 占比）、**无结果率**（≤12%）、P95 延迟 |
| `term_view_success` | `/api/term/[slug]` 200 | `cache: 'hit'\|'miss'`、`senseCount` | **查询成功率**分母/分子的另一半（`term_search(hit=true)` 且卡片成功渲染） |
| `quiz_answer_submit` | `/api/quiz/answer` 200 | `correct:boolean`、`type:T1-T4`、`difficulty`、`mode`、`levelId`、`idempotentReplay` | **WAL**（客户端分析 join）、**首次答题正确率**（客户端 join `contentVersion`）、**错题二次答对率**（客户端错题本 join） |
| `level_start` | `/api/quiz/next` mode=level | `levelId`、`requested`、`delivered`、`effectiveDifficultyCap` | **闯关完课率**分母 |
| `level_complete` | **客户端埋点**（服务端无法判定"完成"，因为进度在 localStorage） | `levelId`、`correctCount`、`durationMs` | **闯关完课率**分子 |
| `wrongbook_retry` | **客户端埋点** | `termId`、`attempt`、`correct` | **错题二次答对率** |

**关键分工说明**：`level_complete` 与 `wrongbook_retry` **必须由客户端埋点**——服务端既不知道用户答了哪些题（进度在 localStorage），也无法在零 Cookie 下识别用户。这两条是"服务端做不到什么"的清晰边界，写在这里避免后续实现时试图在服务端拼凑。

### 7.4 客户端埋点的隐私约束（服务端契约层的配合）

**服务端能帮客户端做的**：
1. **提供"上报字段白名单"文档**：明确哪些字段可以进分析（枚举、数值、布尔），哪些不可以（原始 query 文本、任何用户输入）。
2. **提供归一化桶**：`term_search` 的 `queryLength` 用**分桶**（`0-4` / `5-8` / `9-16` / `17-32` / `33-200`）而非原值，`queryKind` 用服务端判定结果而非客户端猜测。**把判定留在服务端，避免客户端与服务端判定不一致导致数据自相矛盾**。
3. **不接收 query 文本上报**：若产品/运营确实需要"哪些词没搜到"的明细，走 §7.5 的服务端缺口池（带 k-匿名阈值），**不走客户端分析**。

### 7.5 词库缺口池（服务端聚合，隐私友好）

**结论**：`term_search` 事件**不上报原始 query 文本**（用户输入可能含个人信息）。词库缺口分析在服务端完成：

```
定时聚合（unstable_cache revalidate 3600 + 客户端请求驱动）：
  search_gap_pool 聚合表：
    norm_key           规范化后的缺失词（截断 64 字符，过滤后）
    category_guess     猜测分类（可空）
    occurrence_count   出现次数
    first_seen / last_seen
  展示门槛（k-匿名）：occurrence_count >= 3 才进入运营视图，
                     避免「只有一个人搜过的私密词」被看到
  输入过滤：
    保留 ^[a-z0-9 .\-]{2,32}$ 或 ^[\u4e00-\u9fff]{2,8}$ 之外的输入一律丢弃
    （防止把用户输入的姓名/手机号片段写进运营可见的表）
  运营视图默认只展示 norm_key + 次数 + 首次出现时间，不展示任何用户关联信息
```
**k-匿名的必要性**：一个只被搜过 1 次的词条，如果原样进入运营后台，等于把某个用户的输入暴露给运营。`>= 3` 是最低成本的去个体化门槛。

### 7.6 需计算的指标与口径（含数据来源可行性标注）

| 指标 | 目标值 | 计算口径 | **数据来源（可行性关键）** |
|---|---|---|---|
| **WAL（北极星）** | 第 8 周 ≥ 1500 | 周内 `quiz_answer_submit ≥ 1` 的去重用户 | ⚠️ **只能客户端分析**（零 Cookie 下服务端无法 UV） |
| 术语查询成功率 | ≥ 88% | `term_view_success / term_search(hit=true)` | ✅ 服务端可算（PV 口径） |
| 查询→测验转化率 | ≥ 18% | 当日先查后答用户 / 当日查询用户 | ⚠️ **用户级 join 只能客户端分析**；服务端只能给 PV 级比值（会有偏差，需注明） |
| 闯关完课率 | ≥ 30% | `level_complete / level_start` | ✅ 客户端埋点 join（用户级在客户端） |
| 错题二次答对率 | ≥ 65% | 错题本重练正确率 | ✅ 客户端（错题本在 localStorage） |
| **首次答题正确率** | **55%~70%** | 所有题目**首次**作答正确率均值 | ⚠️ **只能客户端分析**。服务端 `answer_event` 能算「全部提交的正确率」，但**算不出"首次"**——因为判断"是否首次"需要知道用户此前答过，而跨请求的用户身份在零 Cookie 下不可得。**这是本方案识别出的一个验收可行性问题，见 §9【待确认】** |
| 无结果率 | ≤ 12% | `term_search(hit=false) / term_search` | ✅ 服务端可算 |
| 搜索→结果呈现 P95 | ≤ 400ms | 客户端 RUM（服务端只能算 `tookMs`，不含网络与渲染） | ✅ 客户端（前端/性能监控负责） |
| 缓存命中率 | 观测项 | CDN 命中 / 进程内命中 / 回源 | ✅ 服务端日志 |
| 重复提交率 | 观测项，阈值 > 3% 告警 | `idempotentReplay=true` 占比 | ✅ 服务端（高值说明客户端重试逻辑有问题） |

### 7.7 核心运行时指标与告警阈值

**假设前提**：日活 1000、人均 8 次查询/天 → 约 8000 次查询/天（架构 §8.1）；峰值按日均 5 倍计（约 70 QPS，集中在 19:00–22:00）；作答事件约 1500/天。**这些数字需运营确认后重算**，阈值按比例调整。

| 指标 | 目标 | 告警阈值 | 级别 | 依据 |
|---|---|---|---|---|
| `/api/search` P95 端到端 | ≤ 250ms（架构 §4.1） | > 400ms 持续 5min | Warn | 体验目标 P95 ≤ 400ms（产品 P2）留 1 档余量 |
| `/api/search` P99 | ≤ 500ms | > 1000ms 持续 5min | Warn | — |
| `term_search` 无结果率 | ≤ 12% | > 12% 持续 1h | Warn（内容） | 产品 1.3 质量目标，超出触发词库补词排期 |
| `/api/search` 5xx 率 | < 0.1% | > 1% 持续 5min | **Page** | — |
| `INDEX_NOT_READY` 发生次数 | 0 | ≥ 1 | **Page** | 索引不可用 = 搜索全挂 |
| `index.checksumAligned = false` 持续时长 | < 5min | > 30min | **Page** | 发布管线故障，新词搜不到 |
| DB 查询 P95 | ≤ 500ms | > 800ms 持续 5min | Warn | Neon 异常 |
| `DB_UNAVAILABLE` 发生 | 0 | ≥ 3 次/5min | **Page** | Neon 故障 |
| `RATE_LIMITED` 占比 | < 1% | > 10% 持续 10min | Warn | 可能被爬虫攻击或限流配置过紧 |
| `idempotentReplay=true` 占比 | < 1% | > 3% | Warn | 客户端重试逻辑有问题 |
| `meta.repeated > 0` 出现 | 0 | 每周 ≥ 1 次 | Warn（内容） | 题库缺口（关卡出不满 8 题） |
| 首次答题正确率 | 55%~70% | 连续 2 天越界 | Warn（内容） | 产品 C15，题目难度失衡 |
| WAL/目标达成率 | 第 8 周 ≥ 1500 | 第 4 周 < 60% | Warn（增长） | 产品 1.3，触发 §R6 应对 |
| `/api/health` 非 `ok` | — | 连续 3 次 | **Page** | — |

---

## 8. v2 预留：`TermResolver` 接口

### 8.1 设计原则（先说清"不这样设计会怎样"）

架构 §6.1 把 `TermResolver` 列为 Top 1 的 v2 预留点。**如果 v1 不接口化，v2 接 LLM 时要改的东西**：搜索结果页 UI 契约、`/api/search` 响应形状、前端状态机（miss 态要变成"生成中/生成成功/生成失败"）、错误处理。**这是全站最大的一处返工**。

三条设计铁律：
1. **未命中必须是返回值的一个变体（`status: 'miss'`），不是 `null`、不是异常。** 这样前端在 v1 就必须写好 miss 分支，v2 只是多一个 `coverage: 'llm'` 而已。
2. **接口不得假设"零 I/O"**。调用方不能假设 `resolve()` 是同步/纯内存的——否则 v2 的 LLM 实现接入时会打穿所有调用方。
3. **内容读取与候选解析分离**（`resolveCandidates` / `hydrate`）。理由：v2 的 LLM 兜底能生成解释，但**不能凭空生成 termId**；候选解析与权威内容读取必须能独立降级。

### 8.2 完整 TypeScript 定义

```ts
// packages/contracts/src/resolver.ts —— 前后端共享的契约

import type { Difficulty } from './term';

export type TermId = string;
export type SenseId = string;

/** 未命中的原因分类，用于 v2 决定"是否值得叫 LLM" */
export type MissKind =
  | 'no_lexicon_match'      // 词库确实没有（最常见）
  | 'rejected_by_filters'    // 有候选但被 category/difficulty 过滤掉
  | 'rejected_by_boundary'   // AC 命中但被边界检查丢弃（疑似误报）
  | 'input_too_short'        // < 2 字符，无法可靠匹配
  | 'index_unavailable';     // 索引故障，此时 v2 应直接走 LLM

export interface ResolveFilters {
  categoryId?: number;
  difficulty?: Difficulty;
}

export interface ResolveQuery {
  raw: string;
  /** 归一化键（禁止用 raw 做匹配） */
  normKey: string;
  /** 单调不减的偏移映射：normOffsetToRawOffset */
  normOffsetToRawOffset: readonly number[];
  inputKind: 'term' | 'sentence';
  limit: number;
  filters: ResolveFilters;
  /** 用于把 span 反查回 raw 坐标 */
  locale: 'zh-CN';
  /** 调用方取消信号：v2 的 LLM 调用必须尊重它 */
  signal: AbortSignal;
  requestId: string;
  deadlineMs: number;
}

export interface ResolvedCandidate {
  termId: TermId;
  slug: string;
  displayName: string;
  layer: 'L0' | 'L1' | 'L2' | 'L3' | 'L3.5' | 'sentence';
  matchedBy: string;
  matchedAlias: string;
  score: number;
  span: { start: number; end: number; normStart: number; normEnd: number } | null;
  sense: {
    senseId: SenseId;
    contextLabel: string;
    isPrimary: boolean;
    confidence: number;
    isLowConfidence: boolean;
    alternatives: Array<{ senseId: SenseId; contextLabel: string }>;
  };
}

export interface ResolvedSuggestion {
  termId: TermId;
  slug: string;
  displayName: string;
  reason: string;
  source: 'edit_distance' | 'same_category' | 'popular';
}

export type ResolveCoverage = 'exact' | 'alias' | 'fuzzy' | 'llm';

/**
 * 未命中是一等状态：
 * - 不是 null（null 无法区分"没找到"与"出错了"）
 * - 不是异常（异常会被通用错误处理吞掉，前端被迫显示错误页）
 * - 携带足够的上下文让前端渲染"未收录"空态 + 相近词建议 + v2 的 LLM 入口
 */
export type ResolveOutcome =
  | {
      status: 'hit';
      candidates: ResolvedCandidate[];
      coverage: ResolveCoverage;
      degraded: boolean;
    }
  | {
      status: 'miss';
      missKind: MissKind;
      suggestions: ResolvedSuggestion[];
      /** v2：LLM 是否被尝试过（v1 恒为 false） */
      llmAttempted: boolean;
      /** true 时前端应显示"结果可能不完整"而不是"未收录" */
      degraded: boolean;
    };

export interface TermResolver {
  /** 用于日志与指标维度，如 'lexicon' / 'chain' / 'llm' */
  readonly name: string;
  /** 契约版本，v2 改接口形状时递增 */
  readonly version: string;

  /**
   * 解析候选。**允许慢、允许 I/O、允许失败**（失败通过 outcome.degraded 表达，
   * 不抛异常——除非 signal 被 abort）。
   */
  resolveCandidates(q: ResolveQuery): Promise<ResolveOutcome>;

  /** 取权威内容（DB）。与 resolveCandidates 分离，便于独立降级。 */
  hydrate(
    termIds: readonly TermId[],
    ctx: { signal: AbortSignal; requestId: string },
  ): Promise<{ cards: Map<TermId, TermCardSummary | null>; unavailable: boolean }>;

  /**
   * 预热。v1 是内存索引单例构建（冷启动时调），
   * v2 会额外做 LLM 客户端预热（连接池、prompt 模板编译）。
   */
  warm?(): Promise<void>;

  /** 健康状态，用于 /api/health 与熔断决策 */
  health(): Promise<{ ok: boolean; detail: Record<string, string | number | boolean> }>;
}
```

### 8.3 v1 唯一实现：`LexiconResolver`

```ts
// apps/web/src/server/resolver/lexicon-resolver.ts（结构示意）
export class LexiconResolver implements TermResolver {
  readonly name = 'lexicon';
  readonly version = '1.0.0';

  async resolveCandidates(q: ResolveQuery): Promise<ResolveOutcome> {
    const state = await getMatcherState();          // 单例 + SWR 双缓冲
    if (state.status !== 'ready') {
      return { status: 'miss', missKind: 'index_unavailable',
               suggestions: [], llmAttempted: false, degraded: true };
    }
    const outcome = state.matcher.resolveCandidates(q);   // L0→L3.5 / AC + 裁决层
    // outcome 只有 hit / miss 两种；miss 时带上 §3.4 的建议
    return outcome;
  }

  async hydrate(termIds, ctx) {
    // 批量查询 + unstable_cache(tag: term:{slug}) + 单飞 + 熔断 + 软超时
  }

  async warm() { await getMatcherState(); }

  async health() {
    const s = await getMatcherState();
    return { ok: s.status === 'ready', detail: { status: s.status, version: s.version } };
  }
}
```

### 8.4 调用方如何零改动切换实现（关键：registry + chain）

```ts
// apps/web/src/server/resolver/registry.ts
import type { TermResolver } from '@glossary/contracts';
import { LexiconResolver } from './lexicon-resolver';

const registry = new Map<string, () => TermResolver>();
registry.set('lexicon', () => new LexiconResolver());

/** v2 新增（本次不实现，但接口已就位） */
registry.set('llm', () => new LlmResolver({ /* ... */ }));
registry.set('chain', () => new ChainResolver({
  primary: registry.get('lexicon')!(),
  fallback: registry.get('llm')!(),
}));

export function getResolver(): TermResolver {
  const key = process.env.TERM_RESOLVER ?? 'lexicon';
  const factory = registry.get(key);
  if (!factory) throw new Error(`unknown resolver: ${key}`);   // 配置错误 → 启动即失败
  const instance = factory();
  void instance.warm?.();     // 异步预热，不阻塞首个请求
  return instance;
}
```

**"零改动"的准确含义（不夸大）**：

| 调用方 | v1 → v2 需要改什么 |
|---|---|
| `/api/search` 的 route handler | **零改动**（只调 `getResolver().resolveCandidates()` 与 `.hydrate()`） |
| `/api/term/[slug]` | **零改动**（不经过 resolver，直接读 DB） |
| 前端结果渲染 | **小改动**：`coverage === 'llm'` 时多一个"AI 生成，供参考"的来源标注（架构 6.1 要求 `source_type` 区分 LLM 生成内容） |
| 前端 miss 态 | **小改动**：`llmAttempted` 为 true 时显示"正在为你解释"→ 这本来就要写（产品 R4 要求未收录有空态） |
| **`/api/search` 响应体** | **零改动**（`isMiss` + `suggestions` 已是契约；v2 在 miss 时可能返回 hit → 需要一个 `coverage` 字段透出）⚠️ **建议现在就在 `SearchResponse` 预留 `coverage` 字段**，v1 恒为 `'exact'\|'alias'\|'fuzzy'`，避免 v2 加字段时前端又要改 |

**结论**：`TermResolver` 接口化 + `MissOutcome` 一等化，能把 v2 的改动量从"重写搜索结果页 + 状态机 + 错误处理"压缩到"加一个来源标注 + 一句 loading 文案"。这是本方案在 v2 方向上最重要的投资。

**`ChainResolver` 的设计（v2，本次只定义不实现）**：
```
resolveCandidates(q):
  primary.resolveCandidates(q)
    → hit  → 直接返回（词库命中永远优先，LLM 不介入，保证内容准确性与成本）
    → miss 且 missKind === 'index_unavailable' → 直接 fallback（索引都挂了，必须 LLM）
    → miss 且 missKind === 'no_lexicon_match' → fallback
    → fallback 超时/失败 → 返回 primary 的 miss + degraded=true（不向用户暴露 LLM 故障）
  预算控制：llmAttempted 字段让前端能显示"AI 解释中"；
            单实例 LLM 调用并发上限（Semaphore）防止把外部依赖打爆
```

### 8.5 其他 v2 预留点（服务端侧）

| 预留 | 现在的做法 | v2 接入时的改动 |
|---|---|---|
| `SymbolQuote` | **不建表、不建接口**（不建没用的表是铁律） | 新增独立可选表 `term_symbol` + 独立 resolver 分支 |
| `/api/feedback` | 不实现 | 新增路由 + 表结构；⚠️ **即使上线也不应接收 PII**，且必须限流防刷 |
| 排行榜/权威计分 | 分数在客户端 | `/api/quiz/answer` 的 `answer_event` 表加 `score`/`combo` 字段并改写为写事务；引入 Redis ZSet |
| 多语言 | `locale: 'zh-CN'` 字面量类型 | 改为可扩展联合类型；URL 加 `/{locale}` 前缀 |
| 用户进度云同步 | `ProgressStore` 接口（客户端） | 新增 `ApiProgressStore` 实现；**服务端需新增进度读写接口，注意此时才引入身份与鉴权** |

---

## 9. 风险与待确认

### 9.1 与已锁定架构的一处有意偏离（需架构师确认）

| 项 | 架构契约 | 本方案 | 理由 |
|---|---|---|---|
| `POST /api/quiz/answer` 重复提交 | 一律返回 `409 DUPLICATE_SUBMIT` | **同 key + 同 payload → 200 重放首次结果**（标准幂等键语义）；**同 key + 不同 payload → 409** | 网络超时后客户端重试是**正常且期望的行为**，返回 409 会让用户看到"提交失败"，是真实的体验故障。标准幂等键语义（同 key 同 payload 同 result）更正确。409 仍然保留了架构要求的"拦截 key 复用/攻击"语义。**请架构师确认此语义调整** |

### 9.2 实现风险与对策

| # | 风险 | 可能性 | 影响 | 对策 |
|---|---|---|---|---|
| R1 | **`idempotentReplay` 语义被前端误用**（前端把它当"新作答"再计一次） | 中 | 中 | 响应体中 `idempotentReplay` 语义写进契约文档；前端逻辑：`idempotentReplay=true` 时**不重复写入错题本、不重复推进进度**（只作为网络重试的结果校正） |
| R2 | **选项乱序后前端按位置存答案** | 中 | 高（判分全错） | `answerKey` 存**选项 id** 而非位置（§2.4 步骤 7）；契约文档显式强调「`optionId` 是 id 不是下标」；单测覆盖「同题不同 seed 洗牌后判分仍正确」 |
| R3 | **AC 边界检查误杀**（中文边界判定把标点算进词内） | 中 | 中（漏命中） | 边界正则**只判 CJK 字符类，不含标点**；建立「中文单字词条 + 括号包裹 + 中英混排」三组单测（架构 6.5 已列为最容易出 bug 的地方） |
| R4 | **`answer_event` 成为写热点** | 低 | 中 | 按假设前提仅 ~1500 条/天；预留按月分区；`content_version` 冗余存储避免 join |
| R5 | **单飞 Promise 泄漏**（reject 后不删 Map） | 低 | 高（内存泄漏 → 实例 OOM） | `finally` 中无条件删除；Map 设上限 1000，超限强制清空并记 WARN |
| R6 | **正则 ReDoS** | 低 | 高（CPU 打满） | 归一化管线所有正则必须线性安全，写入代码评审清单；禁止嵌套量词；建议加一条单测：对 200 字符的 adversarial 输入，normalize 耗时 < 1ms |
| R7 | **`revalidateTag` 粒度过粗导致缓存大面积失效** | 中 | 中（成本上升） | tag 粒度保守：词条级 + 分类级 + 关卡级，**不做全局 tag**；监控 revalidate 后回源 QPS |
| R8 | **零 Cookie 下误建用户画像** | 中 | **高（合规红线）** | §7.1 明确写出"绝不为了算 UV 自建匿名标识 + 行为明细表"；代码评审清单包含"禁止新增含 IP/UA/设备标识的表" |
| R9 | **热查询 `unstable_cache` 键空间无界** | 中 | 中（缓存成本失控） | 只有 LFU 计数 ≥3 的 query 才进入写入路径（§2.1）；定期清理低频 key |
| R10 | **CSP nonce 导致整站放弃静态优化**（Next 16 敏感点） | 中 | **高（TTFB 从 ~0 变成动态渲染）** | nonce **只加在文档响应上**，`/api/**` 与静态资源不加；术语页 SSG 的产出需实测确认 TTFB 未退化；若退化，改为"仅在非 SSG 页面启用 nonce"【需实测】 |

### 9.3 【待确认】清单

| # | 待确认项 | 影响 | 建议确认方 |
|---|---|---|---|
| 1 | **`/api/quiz/answer` 的幂等语义调整**（§9.1：同 key 同 payload 返回 200 重放而非 409） | 客户端错误处理逻辑 | 系统架构师 |
| 2 | **`SearchResponse` 是否现在预留 `coverage` 字段**（§8.4） | v2 接入 LLM 时能否零改动 | 系统架构师 + 前端 |
| 3 | **"首次答题正确率"（产品 C15，★ 验收项）在零 Cookie 约束下只能由客户端分析计算**（§7.6）。需确认：① 接受由客户端分析产出该指标？② 还是为此破例允许采集匿名标识（**我强烈反对**）？③ 或调整验收口径为"全部作答正确率"？ | 发布阻塞级验收项的可测性 | 产品 + 架构 + 前端 |
| 4 | **`/api/health` 需在 Vercel Firewall 中豁免限流**（否则探针假警报） | 监控可靠性 | 运维/架构 |
| 5 | **`/api/lexicon` 是否下发 grams**（本方案默认关闭，需显式 `include=entries+grams`） | 客户端包体与离线能力 | 前端 + 架构 |
| 6 | **`unstable_cache` 在 Next 16 中需配合 `cacheLife` profile** 的具体配置值（TTL/revalidate/stale 策略） | 缓存行为正确性 | 前端 + 架构（需对齐最新 Next 16 文档） |
| 7 | **`termIds` 上限 50 / `excludeQuestionIds` 上限 20** 是否满足错题本规模（产品未定义错题本容量上限） | 复习模式覆盖率 | 产品 |
| 8 | **每日一练（`mode=daily`）是否进 v1 契约**（本方案已在枚举中预留但未实现 composition） | 出题策略 | 产品（Should 项） |
| 9 | **`answer_event` 保留期 90 天**是否满足内容质量分析需要（首次正确率需要足够样本） | 分析能力 vs 隐私 | 产品 + 数据 |
| 10 | **CIP/备案与部署区域**是否影响健康检查对外暴露（架构附录 B #8/#9 已列） | 合规 + 架构 | 运营/法务 |
| 11 | **`pronunciation`（术语注音）字段**是否进 v1 契约（产品 7.4 提到 P2 人群需要中文译名/音标提示） | 契约字段 | 产品 |
| 12 | **`GET /api/quiz/next` 使用 GET 承载 1024 字符的 `excludeQuestionIds`** 在极端情况下（URL 长度限制）是否够用 | 长会话断点续做 | 前端 + 架构；若不够需改为 POST |

### 9.4 实现优先级建议（供排期参考）

| 顺序 | 内容 | 理由 |
|---|---|---|
| P0 | `http-kit`（错误体/requestId/超时/日志）+ `contracts` 包 | 所有接口的地基，必须先有 |
| P0 | `/api/term/[slug]`（最高缓存收益 + SEO 依赖） | 最简单、最独立、可独立验收 |
| P0 | `/api/search`（L0~L3.5 + 建议生成） | 产品价值最高（断点 A） |
| P0 | `/api/quiz/next` + `/api/quiz/answer`（含幂等） | 北极星指标依赖 |
| P1 | `/api/lexicon`（客户端离线匹配依赖） | 需与前端同批上线 |
| P1 | 索引 SWR 双缓冲 + checksum 校验 | 发布管线可靠性 |
| P1 | `/api/health` + 告警阈值接入 | 上线前必须就位 |
| P2 | `/api/og/term/[slug]` | 体验增强，非阻塞 |
| P2 | `answer_event` 保留期清理任务、缺口池聚合 | 上线后补 |

---

**文档结束。**
本文覆盖：API 契约（可照写代码）、Server Actions 与 Route Handlers 分工、检索实现、测验实现、错误与降级矩阵、安全、埋点与可观测性、v2 预留。
本文不覆盖（其他成员职责）：前端页面设计、数据库 DDL、部署运维、内容运营流程。
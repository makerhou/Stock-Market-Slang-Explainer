# 股票黑话解释器 · 部署运维与交付方案（DevOps Delivery Plan）

> **文档定位**：本文是「上线那一刻出事能一分钟内退回去」的可执行手册。覆盖环境规划、CI/CD（**内容发布链路为核心**）、Vercel/Neon 部署配置、监控告警、回滚应急、容量成本、上线检查单。
> **不覆盖**：前端页面设计、API 业务逻辑、数据库 DDL（分别见 frontend-design.md / backend-implementation.md / 数据建模文档）。
> **上游输入**：architecture-design.md §3.4/§4/§8、backend-implementation.md §4/§5/§6/§7、产品需求 §9.3/§9.5、agent-content-pipeline-design.md §4。
> **版本**：v1.0（陆上线 / 部署运维）
>
> **全文数字的假设前提（务必先读）**：
> ① 日活 **3,000**（架构 §4.1 由产品「日新增自然 300~600、第 8 周 WAL ≥1,500」推算，**产品未直接给出日活【待确认】**）；
> ② 人均 8 次查询/天 → 2.4 万次查询/天 ≈ **72 万次/月**；
> ③ 词库 **120 条 / 145 义项 / 12 一级分类**，扩展上限 2,000 条；
> ④ 团队 3 人（1 名内容运营/专家兼职），**PR 频率假设 30~50 个/月【待确认】**；
> ⑤ 上线时间未定，本文所有「第 N 周」均指**上线后第 N 周**【待确认】；
> ⑥ 汇率 1 USD ≈ 7.2 CNY；
> ⑦ **Vercel / Neon / GitHub 的套餐额度与超额单价均可能变动，本文引用架构 §8.1 口径并标注，上线前必须逐项复核**（见 §6.5 复核清单）。

---

## 0. 交付结论摘要（TL;DR）

| # | 结论 | 理由 |
|---|---|---|
| 1 | **内容发布链路的可靠性 > 应用宕机**。本文 §2.1 篇幅最大 | 应用宕机 5 分钟 = 少数用户不便；一条错误释义被搜索引擎收录 = 长期放大 + 信任崩塌（架构师明确提示）。**内容链路的每一分钟投入回报率都高于常规部署加固** |
| 2 | **内容发布 = 「双审合并 + 定时发布窗口 + 1 人放行审批 + 自动冒烟 + 失败自动 roll-forward」** | 合规内容不允许「半夜合并即上线」，出事无人响应。GitHub Environments `content-production` 提供原生审批卡点 |
| 3 | **正文与免责必须同批次原子发布**，靠 `content_release` 单事务 + 缓存键含 `contentVersion` 双保险 | 免责版本错配是**合规事故**，比宕机严重。不能靠"记得同时发"，必须靠机制不可能出错 |
| 4 | **Preview 环境不连 Neon**。Vercel Preview 构建消费 CI 产出的**内容快照 artifact**，而非实时查库 | 每 PR 一个 Neon 分支会在 30 个 PR/月内吃光 CU-hrs 与分支存储配额 —— 这是 Neon + Vercel 组合最常见的账单事故 |
| 5 | **Neon 分支：仅内容审核用短命分支（TTL 24h，CI 自动删）**；main / staging / preview-snapshot 三条长驻分支 | 分支是内容审核的一等公民，但**必须自动回收**，闲置分支仍计存储费 |
| 6 | **Vercel 函数区域与 Neon 区域必须同区**：推荐 `sin1`（新加坡）+ Neon `aws-southeast-1` | 跨区一次 DB 往返 +460ms，直接击穿「搜索 p95 ≤250ms」SLO |
| 7 | **回滚不是「退版本」而是「向前滚到旧内容」**：`content_release.version` 单调递增，永不递减 | 缓存键含 version；一旦递减，旧缓存会重新命中 → 回滚无效 |
| 8 | ⚠️ **修正架构 §8.1 的一处成本口径不自洽**：函数调用超额 $0.60/百万，与「+$40~90/月」不符（后者需超额 6,600 万次 ≈ DAU 25 万）。**真正先撞且贵的是带宽（$40/100GB，DAU≈3.3 万撞 1TB）** | 见 §6.2 撞线模型与 §6.6 口径确认项。这是决策关键输入，必须校准 |
| 9 | **Vercel Pro 的日志留存短（约 1h）、Log Drains 属企业能力** → 必须自建三条补偿取证链：关键运维事件落 Neon `ops_event` 表 / CI artifact 留存 90 天 / 外部探测留存 30 天 | 出事之后没有日志 = 无法复盘 = 同类事故必然重演【上线前复核 Vercel 当前政策】 |
| 10 | **隐私红线用 CI 机器验证，不靠人自觉**：Playwright 隐私审计 job 断言「全站零 `Set-Cookie`、零第三方域、日志零原始 query」 | 零个人数据采集是合规红线；人工核对在 120 个页面上不可持续 |

---

## 1. 环境规划

### 1.1 环境分层

只有 **Vercel + Neon** 两个托管方，因此环境分层必须是「**Vercel 部署类型 × Neon 分支**」的二维组合，而不是传统的四套独立环境。**刻意不做「测试环境」**：本项目无账号体系、无第三方集成、无外部消费方，多一套环境 = 多一份 Neon 分支存储费 + 多一份配置漂移风险，换不到任何验证能力。

| 环境 | Vercel 载体 | 用途 | 数据来源 | 配置来源 | 访问权限 | 是否可被搜索引擎收录 |
|---|---|---|---|---|---|---|
| **Local（开发）** | `next dev` | 编写词条、跑 lint、本地起索引 | Neon `dev` 分支（长驻）或本地 Docker PG | `.env.local`（**gitignore，含明文密钥**） | 开发者本人 | 否 |
| **Preview（PR 预览）** | Vercel Preview Deployment，每 PR 一个 URL | ① 视觉/交互走查；② **内容审核人在真实渲染页面上逐条核对释义与免责**；③ 视觉回归 | **CI 产出的内容快照 artifact（不连 Neon）** | Vercel 项目 Preview 环境变量 + `NEXT_PUBLIC_*` 构建期注入 | PR 参与者 + 内容审核人（Vercel Deployment Protection：`Standard Protection` 即需登录 Vercel 团队账号） | **否**（`X-Robots-Tag: noindex` 强制注入，见 §7 检查单） |
| **Staging（预发）** | Vercel 上的 **`staging` Git 分支** → 独立 Production-type 部署 + 独立域名 `staging.<domain>` | ① **生产数据的只读镜像验证**；② 内容发布前的最后一道真实环境冒烟；③ 回滚演练与 PITR 演练场；④ 免责版本一致性校验 | Neon `staging` 分支（长驻，从 main 定期 reset） | Vercel `staging` 环境变量组 | 全体团队；**禁止对外分享链接** | 否（`noindex`） |
| **Production（生产）** | Vercel Production Deployment（Git `main`） | 对外服务 | Neon `main` 分支（唯一权威库） | Vercel `Production` 环境变量组（**含 `REVALIDATE_SECRET` 等生产密钥，仅 Production 作用域**） | 部署由 CI 自动触发；**手动 Promote/回滚仅限 2 名 Owner**（Vercel RBAC） | **是** |

**环境差异最小化的三条硬约束**：

1. **同一份构建产物、同一份代码**，只有环境变量不同。禁止任何 `if (env === 'staging')` 的业务分支逻辑。
2. **Preview 与 Staging 的 Next.js 运行时行为必须与 Production 一致** → 三者都用 **Node runtime（不用 Edge）**，都开 Fluid Compute 同档位，都走同一份 `proxy.ts` 安全头逻辑。差异只在「是否 noindex」「是否开 Analytics」。
3. **Analytics 只在 Production 开**：`ANALYTICS_ENABLED=true` 仅设在 Production 环境变量组。Preview/Staging 若开了 Analytics，会**污染 WAL 北极星指标**（团队成员自己的点击被计入去重 UV）。

**数据与流量隔离策略**：

| 隔离维度 | 做法 | 不做的后果 |
|---|---|---|
| **数据隔离** | Neon 三条长驻分支物理隔离（独立 endpoint + 独立连接串）；`staging` 分支每周从 `main` reset 一次 | Preview 误写生产库（内容编译脚本 bug 直接污染 120 条权威内容） |
| **写权限隔离** | **只有 `content-publish` 这一个 workflow 持有生产库写凭据**；`DATABASE_URL`（Vercel 侧）使用**只读 role**，写操作全部走 CI 的 `DATABASE_URL_DIRECT`（读写 role） | 应用运行时被 RCE 后可篡改内容 = 合规事故。**最小权限原则** |
| **流量隔离** | Preview/Staging 注入 `X-Robots-Tag: noindex, nofollow`；`sitemap.xml` 只在 Production 生成；`robots.txt` 在非 Production 全站 `Disallow: /` | 预发页面被搜索引擎收录 → 重复内容稀释权重（产品 R9）+ **未过合规终审的内容出现在搜索结果里** |
| **配额隔离** | Vercel 项目为同一个（共享 Pro 席位），但 Preview 构建**不查 DB、不生成 OG 图、跳过 Lighthouse**（见 §2.3 `ci.yml` 的 `if:` 条件） | Preview 构建消耗 CU-hrs 与 Actions 分钟数，30 PR/月 就能吃光 Neon Launch 的 300 CU-hrs |

### 1.2 Neon 分支策略（内容审核如何用 branching）

**核心设计：分支的生命周期与「一次内容 PR」严格绑定，由 CI 创建、由 CI 删除，人不碰。**

```
长驻分支（3 条，人工不删）
├─ main        生产权威库。只有 content-publish workflow 能写
├─ staging     预发验证库。每周一 04:00 UTC 从 main reset（见 nightly-hygiene.yml）
└─ dev         本地开发库。schema 与 main 同源，数据可为脏数据；每两周 reset

短命分支（0~N 条，TTL 24h，CI 自动删）
└─ pr-<number>-content    内容 PR 的验证分支，parent = main
                          用途：让审核人在「真实 Postgres 查询路径」上验证
                                编译产物（含 pg_trgm 索引、UNIQUE 约束、外键完整性），
                                而不是只在 CI 的内存里 dry-run
```

**内容审核的完整分支流（对齐产品 §7.6 三级审核）**：

| 步骤 | 动作 | 责任 | 命令/机制 |
|---|---|---|---|
| 1 | 作者提 PR，改动 `content/terms/*.mdx` | 内容作者 | `git push` → PR |
| 2 | CI 跑 `content-validate`（全部 BLOCK 级规则） | 机器 | 见 §2.1 步骤 2 |
| 3 | **CI 创建 `pr-<n>-content` 分支（parent=main），把 PR 内容编译 upsert 进去** | 机器 | `neonctl branches create pr-$PR-content --parent main` → `pnpm content:compile --target branch --dry-run=false` |
| 4 | CI 在该分支上跑「**编译后校验**」：alias UNIQUE 约束是否冲突、term_relation 外键是否悬空、题池是否每关 ≥8 题、`pg_trgm` 索引是否可用 | 机器 | 这些**只有真实 Postgres 能验证**，内存 dry-run 做不到 |
| 5 | CI 把该分支的连接信息 + Vercel Preview URL 写回 PR comment | 机器 | `actions/github-script` |
| 6 | **二级专业复核**（金融背景）在 Preview URL 上逐条核对释义准确性、口径、易混词区分、`not_meaning` 是否到位、来源可溯 | 金融专业审核人 | PR review approve（CODEOWNERS 强制 `@content-finance-reviewers`） |
| 7 | **三级合规终审**（合规/风控）在 Preview URL 上核对：风险提示覆盖、免责文案版本、无投资建议、无标的推荐、无收益承诺 | 合规/风控角色 | PR review approve（CODEOWNERS 强制 `@compliance-reviewers`） |
| 8 | 合并 main（**两个 team 各 1 人 approve，缺一不可**） | Maintainer | Branch Protection：`Require review from Code Owners` + `Required approvals = 2` |
| 9 | **CI 立即删除 `pr-<n>-content` 分支**（`post` 步骤 + 定时兜底扫描） | 机器 | `neonctl branches delete` |
| 10 | 进入发布窗口审批 → 编译 upsert 到 `main` → 版本递增 → revalidate | 值班人放行 | 见 §2.1 |

**为什么第 3~4 步值得花一个分支（而不是只 dry-run）**：
产品 §7.6 要求 100% 全检，而**有一类错误在 dry-run 里永远发现不了** —— 「同一个 `norm_key` 在两条不同词条里出现」。dry-run 在内存里做唯一性检查是可行的，但 `pg_trgm` 索引的**实际召回行为**、部分唯一索引的**实际约束生效范围**、多义词 sense 排序的**实际 SQL 结果**，只有真库能验。花一个 24h 生命周期的分支（成本 ≈ 0，因为 scale-to-zero + copy-on-write）换掉「发布后才发现别名冲突导致搜索指向错词」这类事故，回报极高。

**dev 分支避免污染的做法**：
- `dev` 分支的连接串**只出现在开发者本地的 `.env.local`**，绝不进 Vercel 环境变量、绝不进 GitHub Secrets 的 `main` 作用域。
- `dev` 分支的 Neon role 名带 `_dev` 后缀，`content-publish` workflow 的 `environment: content-production` 只注入生产 role → **技术上不可能把 dev 数据发到生产**。
- `content:compile` 脚本内置**环境断言**：`--target production` 时校验 `DATABASE_URL` 的 host 必须匹配 `CONTENT_PROD_DB_HOST_PATTERN`（如 `ep-*-prod`），不匹配则**直接退出码 2 拒绝执行**。这是防「脚本参数打错写到生产」的最后一道闸。

### 1.3 ⚠️ 预览环境如何避免 Neon 配额爆炸（实际痛点，重点）

**问题定量**：Neon Launch 含 **300 CU-hrs/月 + 10GB 存储**。Vercel 官方的 Neon Integration 默认行为是**每个 Preview Deployment 自动创建一个 Neon 分支**。按 30~50 PR/月：

| 消耗项 | 单 PR 消耗 | 30 PR/月 | 后果 |
|---|---|---|---|
| Preview 构建期 SSG（`generateStaticParams` 查库拉 120 个 slug + 每页 hydrate 释义） | 约 0.05~0.15 CU-hr | **1.5~4.5 CU-hr** | 可控，但每次 rebuild（Vercel 会在 push 时重建）翻倍 |
| 分支存储（copy-on-write 基线 + 编译写入的 120 词条 diff） | 约 5~30MB | **150MB~900MB** | 分支不删则**线性累积**，3 个月撑爆 10GB |
| 分支 compute 未设 scale-to-zero | 空转 0.25 CU × 24h = **6 CU-hr/天** | **最坏 5,400 CU-hr/月** | ⚠️ **这才是真正的账单炸弹**，是 300 CU-hrs 额度的 18 倍 |

**四层防护方案（从根上消除，而非事后清理）**：

| # | 措施 | 效果 | 落地位置 |
|---|---|---|---|
| **① 根因消除：Preview 构建不连 Neon** | `content-compile` 在 CI 里产出 `content-snapshot.json`（120 词条的完整编译产物）并 `actions/upload-artifact`；`next build` 通过 `CONTENT_SNAPSHOT_PATH` 环境变量**优先读快照文件，仅在文件不存在时回退查库** | Preview 构建的 Neon CU-hrs **归零**；顺带让 Preview 构建从 ~90s 降到 ~40s | `ci.yml` 的 `build` job + `packages/db` 的 snapshot-first 读取层（需后端配合，见 §8 待确认 #1） |
| **② 关闭 Vercel Neon Integration 的自动分支** | Vercel 项目 → Integrations → Neon → **关闭 "Create branch for each preview deployment"**；改为 CI 用 `neonctl` 精确控制 | 分支数从 30/月 降到 **≤3 个并发**（短命分支 TTL 24h） | Vercel 控制台一次性配置（进 §7 检查单） |
| **③ 短命分支强制 TTL + 自动回收** | `neonctl branches create` 时带 `--suspend-timeout 60`（1 分钟无连接即 scale-to-zero）；workflow 的 `post` 步骤删除；`nightly-hygiene.yml` 每天扫描并删除所有**存活 >24h 且名字匹配 `pr-*`** 的分支 | 空转 CU-hrs 归零；存储不累积 | §2.3 `nightly-hygiene.yml` |
| **④ 分支预算硬门** | `nightly-hygiene.yml` 统计分支总数，**>10 条即发 Warn 告警并在 PR 里 @值班人**；Neon 存储 >7GB（70%）触发 Warn | 配额问题在 70% 时被发现，而不是月底收到账单 | §4.3 告警表 #19 |

**补充：Staging 分支的配额控制**
`staging` 是长驻分支，必须显式设 `--suspend-timeout 300`（5 分钟无连接即休眠）。按每天 2 次冒烟探测 × 30s 活跃 ≈ 0.008 CU-hr/天 ≈ **0.25 CU-hr/月**，可忽略。**但如果不设 suspend-timeout，staging 常驻 0.25 CU = 180 CU-hr/月，直接吃掉 60% 的额度** —— 这是最容易被忽略的一条配置。

**配额预算表（月度 CU-hrs 分配，300 CU-hrs 总额度）**：

| 用途 | 预算 | 占比 |
|---|---|---|
| Production main 分支（scale-to-zero，读多写极少） | ≤ 90 CU-hr | 30% |
| 内容编译（每次发布约 0.1 CU-hr × 30 次/月） | ≤ 5 CU-hr | 2% |
| 内容 PR 短命分支（≤3 并发 × TTL 24h） | ≤ 30 CU-hr | 10% |
| Staging 长驻（含 suspend） | ≤ 5 CU-hr | 2% |
| Dev 长驻（含 suspend，工作时间活跃） | ≤ 40 CU-hr | 13% |
| **安全余量（应对突发/演练/PITR 恢复）** | **≥ 130 CU-hr** | **43%** |

> **【待确认】** Neon Launch 的 CU-hrs 超额单价与「分支存储是否单独计费」需在上线前用 `neonctl` 或控制台账单页复核。本文按架构 §8.1 的 $19/月 口径记账。

### 1.4 环境变量与密钥管理（完整清单）

#### 1.4.1 变量清单

| 变量名 | 用途 | 敏感 | 作用域（Prod/Staging/Preview/CI） | 示例值 | 备注 |
|---|---|---|---|---|---|
| `DATABASE_URL` | 应用运行时连 Neon（**走 pooler，只读 role**） | ✅ 高 | Prod / Staging / Preview | `postgresql://glossary_ro:xxx@ep-cool-dawn-a1b2c3-pooler.aws-0-ap-southeast-1.neon.tech/neondb?sslmode=require&channel_binding=require` | ⚠️ **必须用 `-pooler` 端点**，直连端点会耗尽连接数（Neon scale-to-zero + serverless 无状态实例） |
| `DATABASE_URL_WRITE` | 内容编译写库（**读写 role，直连端点**） | ✅ 高 | **仅 CI（GitHub Secret，environment=`content-production`）** | `postgresql://glossary_writer:xxx@ep-cool-dawn-a1b2c3.aws-0-ap-southeast-1.neon.tech/neondb?sslmode=require` | **绝不进 Vercel 环境变量** → 运行时被攻破也改不了内容（最小权限） |
| `NEON_API_KEY` | Neon 控制面 API：创建/删除分支、查用量、触发 PITR | ✅ 高 | **仅 CI** | `neondb_xxx...` | 泄露 = 攻击者可删生产库分支。**轮换周期 90 天** |
| `REVALIDATE_SECRET` | 调用 `POST /api/revalidate` 触发 `revalidateTag` 的共享密钥 | ✅ 高 | Prod / Staging + CI | 32 字节随机 base64 | 泄露 = 攻击者可全量刷缓存制造回源风暴。轮换 90 天 |
| `CONTENT_SIGNING_KEY` | 对 `content-snapshot.json` 做 HMAC 签名，运行时校验快照未被篡改 | ✅ 中 | Prod / Staging / Preview + CI | 32 字节随机 | 可选但推荐：防 CI artifact 被投毒后写进构建产物 |
| `APP_ORIGIN` | CSRF Origin 白名单（后端 §6.2） | ❌ | Prod / Staging / Preview（各自值） | Prod: `https://heihua.example.com`；Preview: `https://*.vercel.app` | Preview 需用通配规则而非硬编码 |
| `NEXT_PUBLIC_SITE_URL` | SSG canonical / sitemap / OG 图的绝对 URL | ❌（**会打进客户端 bundle**） | 各环境 | `https://heihua.example.com` | ⚠️ `NEXT_PUBLIC_*` **绝不能放任何敏感值** |
| `NEXT_PUBLIC_CONTENT_VERSION` | 构建期注入的内容版本号，前端用于校验「免责版本 vs 正文版本」 | ❌ | 各环境（CI 动态注入） | `47` | 免责版本一致性的前端侧探针 |
| `ANALYTICS_ENABLED` | 是否加载 `@vercel/analytics` | ❌ | **仅 Prod = `true`** | `true` / `false` | Preview/Staging 必须 `false`，否则污染 WAL |
| `TERM_RESOLVER` | v2 预留的 resolver 实现选择（后端 §8） | ❌ | 各环境 | `lexicon` | v1 固定 |
| `RATE_LIMIT_SEARCH_PER_MIN` | 进程内令牌桶兜底阈值 | ❌ | 各环境 | `60` | **主防线是 Vercel Firewall**，此项仅兜底 |
| `RATE_LIMIT_QUIZ_PER_MIN` | 同上 | ❌ | 各环境 | `30` | |
| `RATE_LIMIT_GLOBAL_PER_MIN` | 同上 | ❌ | 各环境 | `300` | |
| `INDEX_MAX_MEMORY_MB` | 内存索引上限断言 | ❌ | Prod / Staging | `50` | SLO：内存索引 ≤50MB；超限则拒绝切换新索引并告警 |
| `LOG_LEVEL` | 结构化日志级别 | ❌ | 各环境 | Prod `info`，Staging `debug` | ⚠️ Prod **禁止 `debug`**（debug 级可能打印 query 原文 → 违反隐私红线） |
| `DB_QUERY_TIMEOUT_MS` | 查库软超时 | ❌ | 各环境 | `800` | 对齐后端 §2.2 |
| `CONTENT_PROD_DB_HOST_PATTERN` | 编译脚本的环境断言正则 | ❌ | 仅 CI | `^ep-.*-prod\.` | 见 §1.2「防写错库」 |
| `VERCEL_TOKEN` | CI 调 Vercel API（Promote deployment / 查 usage / 触发 revalidate） | ✅ 高 | **仅 CI** | — | 建议用 **Vercel OIDC Federation 替代长期 token**（见 §1.4.3） |
| `GITHUB_TOKEN` | PR comment、artifact、环境审批 | ✅（自动签发） | CI | — | `permissions:` 块**最小化到 `contents: read` + `pull-requests: write`** |
| `SENTRY_DSN` | 错误上报 | ✅ 中 | Prod（**v1 不启用**） | — | 架构 §8.1 标注「Sentry 免费版可后置」。⚠️ 若启用，**必须配 `beforeSend` 剥离 query 原文与 IP**，否则直接违反隐私红线 |
| `LLM_API_KEY`（v2） | 内容管线 LLM 草稿生成 | ✅ 高 | **仅 CI，environment=`content-llm`** | — | v1 不配置。轮换与配额方案见 §1.4.4 |

#### 1.4.2 密钥托管方式（密钥绝不进代码库）

| 密钥类别 | 托管位置 | 作用域收紧手段 | 可见性 |
|---|---|---|---|
| 生产库写凭据、`REVALIDATE_SECRET`、`NEON_API_KEY` | **GitHub Actions Secrets**，绑定到 **Environment `content-production`** | Environment 设 `Required reviewers` + `Deployment branches: main only` → **PR 构建（fork/feature 分支）永远拿不到生产密钥** | 仅 2 名 Owner 可编辑；值一旦写入不可读回 |
| 应用运行时凭据（只读 `DATABASE_URL`） | **Vercel Environment Variables**，作用域勾 `Production` only | Vercel 的 `Sensitive` 标记 → 写入后连 Owner 都无法在 UI 读回明文 | Vercel Team Owner |
| Staging / Preview 凭据 | Vercel EV（各自作用域）+ GitHub Secrets（environment=`staging`） | 与生产**用不同的 Neon role**，且 role 只有对应分支的权限 | 同上 |
| 本地开发凭据 | `.env.local`（`.gitignore` + `.git/info/exclude` 双写） | pre-commit `gitleaks protect --staged` 硬拦 | 开发者本人 |

**三道防泄漏闸（全部在 CI 硬拦，不是 warning）**：
1. **GitHub Push Protection + Secret Scanning** 开启（仓库 Settings → Code security），命中即拒绝 push。
2. **`gitleaks` CI job**：全量扫历史 + 增量扫 diff，命中 `exit 1` 阻断合并。规则集需**自定义**加入 `ep-*-*pooler*` 与 `neondb_` 前缀（Neon 连接串特征）。
3. **`.env*` 白名单**：仓库只允许 `.env.example`（全部值为占位符），CI 校验 `.env.example` 的 key 集合与代码中 `process.env.X` 引用集合**完全一致**（防「新增了环境变量但没登记 → 上线时漏配」这一高频事故）。

**密钥轮换计划**：

| 密钥 | 轮换周期 | 轮换方式（零停机） | 触发即时轮换的条件 |
|---|---|---|---|
| `DATABASE_URL`（只读 role） | 180 天 | Neon 新建 role → 更新 Vercel EV → 触发一次 redeploy → 观察 30min → 删旧 role | 任何前员工离职、任何 GitHub/Vercel 账号异常登录 |
| `DATABASE_URL_WRITE` | 90 天 | 同上，但**必须在发布窗口之外**执行（避免与内容发布抢事务） | 同上 + CI runner 被怀疑失陷 |
| `REVALIDATE_SECRET` | 90 天 | **双密钥并存窗口**：代码同时接受 `REVALIDATE_SECRET` 与 `REVALIDATE_SECRET_PREV` → 切换 CI 侧 → 7 天后移除 prev | 缓存被恶意全量刷新（回源风暴） |
| `NEON_API_KEY` | 90 天 | Neon 控制台新建 key → 更新 GitHub Secret → 删旧 key | 同上 |
| `VERCEL_TOKEN` | **建议消除** | 改用 Vercel OIDC Federation（GitHub Actions 作为 trusted issuer，短时凭据，无长期 token） | — |

#### 1.4.3 为什么推荐 Vercel OIDC 而非长期 Token

长期 `VERCEL_TOKEN` 是 CI 里权限最大的一个密钥（能 promote 部署、能读所有环境变量、能改项目配置）。OIDC Federation 让 GitHub Actions 用**运行时签发的短时 JWT** 换取 Vercel 访问权，**没有可泄漏的长期凭据**。配置成本约 1 小时，收益是消除整个交付链路中最高危的一处密钥。**若 OIDC 在当前 Vercel 计划不可用【待确认】，则退化为长期 token + 90 天轮换 + 最小 scope。**

#### 1.4.4 大模型 API Key 的轮换与配额告警（v1 不用，v2 前置方案）

v1 的内容管线是**纯规则**的（agent-content-pipeline §0.2 明确「所有发布决策由确定性规则做」），**不持有任何 LLM Key**。但 v2 的「LLM 批量草稿 + 缺口回填」会引入，届时必须满足：

| 项 | 方案 |
|---|---|
| **托管** | GitHub Secret，绑定 environment `content-llm`，**Required reviewers = 内容负责人**；绝不进 Vercel（v2 的 LLM 兜底若走运行时，则另开 `llm-runtime` EV 作用域并配 Vercel Sensitive） |
| **轮换** | 30 天（比基础设施密钥更严，因为 LLM Key 泄漏会直接产生现金损失） |
| **配额告警** | ① 供应商侧设**硬预算上限**（如 ¥500/月），达 70% 邮件告警、达 100% 拒绝服务；② CI 侧每次 workflow 结束打印本次 token 消耗并累加到 `ops_event` 表；③ 单日消耗 > ¥50 触发 Warn，> ¥150 触发 Page（异常 query 循环的特征） |
| **熔断** | 单 workflow run 最多 500 次调用；连续 10 次 4xx 立即中止（Key 失效或触发风控） |
| **降级** | LLM 环节失败**不阻断发布**：草稿生成失败 = 作者手写，属于效率损失而非质量损失（这是把 LLM 放在"产候选"位置而非"做决策"位置的运维红利） |

---

## 2. CI/CD 流水线

### 2.0 流水线总览

```
┌── 编辑期（阻止坏内容/坏代码进来）────────────────────────────┐
│ pre-commit(可绕过) → PR CI(不可绕过) → 双审 → 合并 main      │
└──────────────────────────────────────────────────────────────┘
                              ↓
┌── 发布期（两条独立流水线，顺序有约束）───────────────────────┐
│ A. 应用发布：main → Vercel Production 部署 → 冒烟 → 生效      │
│ B. 内容发布：main(content/** 变更) → 编译 → 发布窗口审批       │
│              → upsert Neon → version++ → revalidate → 冒烟    │
└──────────────────────────────────────────────────────────────┘
                              ↓
┌── 发布后（发现规则演进导致的历史失效）───────────────────────┐
│ 每周全量回溯扫描 + 每日配额巡检 + 每日分支清理 + 每月 PITR 演练│
└──────────────────────────────────────────────────────────────┘
```

**制品版本与可追溯策略**：

| 制品 | 版本标识 | 存放 | 保留期 | 追溯能力 |
|---|---|---|---|---|
| 前端构建产物 | Vercel Deployment ID + Git SHA | Vercel（不可变，可 Promote 回滚） | Vercel 保留全部历史部署 | Deployment → Git SHA → PR → Reviewer 全链路可查 |
| 内容编译产物 | `content_release.version`（单调递增整数）+ `checksum`（内容哈希）+ `git_sha` | **Neon `content_release` 表**（一行一版本） | **永久**（120 条规模下每行 <1KB） | 任一时刻都能回答「线上跑的是哪个 Git commit 的内容、谁批的、什么时候生效的」 |
| 内容快照 artifact | `content-snapshot-<git_sha>.json` + HMAC 签名 | GitHub Actions Artifacts | 90 天 | Preview 构建可复现；签名可验 |
| DB Schema | Drizzle migration 文件名（时间戳前缀）+ `__drizzle_migrations` 表 | Git + Neon | 永久 | 迁移历史即审计日志 |
| CI 运行记录 | GitHub Actions run ID + 完整日志 + 校验报告 | GitHub Actions | 90 天（**私有仓库日志留存【待确认】**） | 补偿 Vercel 日志留存短的问题（§0 结论 #9） |

---

### 2.1 内容发布流水线（**核心，篇幅最大**）

> **为什么这一节最重要**：架构师明确指出「**内容发布链路可靠性的价值 > 应用宕机**」。原因很具体 —— 应用宕机 5 分钟，受影响的是当时在线的几十个用户，且他们知道"网站挂了"；而**一条错误释义上线，会被搜索引擎收录、被分享、被用户当作权威定义记住**，且**用户完全不知道它是错的**。前者的修复成本是分钟级，后者是「信任修复」级（产品 R1）。

#### 2.1.1 全链路分步规格（每步：命令 / 动作 / 失败处理 / 回滚点）

| # | 触发/阶段 | 命令或动作 | 失败处理 | 回滚点 |
|---|---|---|---|---|
| **0** | **Git 事件**：作者 `git push` 到 feature 分支并开 PR，改动命中 `content/**` 或 `packages/{content,quiz}/**` | `git commit` 触发 `pre-commit` hook（快速子集校验） | 本地失败，作者自行修复。⚠️ `--no-verify` 可绕过 → **不作为防线，只作为反馈加速** | 无需（未产生任何外部状态） |
| **1** | **变更范围计算**（CI，PR 触发） | `git diff --name-only $BASE HEAD -- content packages/content packages/quiz` → 输出变更的 MDX 文件列表 | 计算失败 → 保守地按「全量校验」执行（fail-safe，不是 fail-open） | 无状态 |
| **2** | **内容校验（BLOCK 级硬门）** | `pnpm content:validate --strict --reporter=ci` | 任一 BLOCK 规则命中 → **`exit 1`，PR 显示红叉，Branch Protection 阻止合并**。错误信息必须符合 agent-content-pipeline §4.6 的四条硬要求（字段路径 + 原文片段高亮 + 2~3 个可照抄改法 + 条款锚点） | 无状态 |
| **3** | **合规校验（BLOCK 级硬门，⚠️ 与步骤 2 分开成独立 job，失败必须阻断）** | `pnpm content:compliance --strict` | 命中强禁词/祈使句/具体标的/收益承诺/免责缺失 → `exit 1`。**独立 job 的理由**：与质量校验分开，PR 页面上一眼能看到「这是合规问题不是格式问题」，且**合规 job 不允许任何 `continue-on-error`** | 无状态 |
| **4** | **题目编译 + 弃权检查** | `pnpm quiz:generate --check-only` | 弃权（送分题/歧义/荒谬项/长度失衡）→ 该题丢弃并记录；**若某关题池 <8 题 → `exit 1`**（产品 M6 要求每关 8 题，缺题必须暴露而非静默） | 无状态 |
| **5** | **创建 Neon 验证分支** | `neonctl branches create pr-$PR-content --parent main --suspend-timeout 60` | 创建失败（配额/网络）→ **降级为纯 dry-run 校验**（跳过步骤 6~7），并在 PR comment 明确标注「⚠️ 本次未做真实库验证」+ 发 Warn 告警。**不阻断 PR**（否则 Neon 抖动会卡住全部内容运营） | `neonctl branches delete`（`post` 步骤 + 每日兜底扫描） |
| **6** | **编译到验证分支（dry-run=false）** | `pnpm content:compile --target branch --branch pr-$PR-content --diff-report` | 编译报错（schema 违约、UNIQUE 冲突、外键悬空）→ `exit 1` 阻断 | 分支整体删除即完全回滚（copy-on-write，main 零影响） |
| **7** | **编译后校验（只有真库能做）** | `pnpm content:verify-db`：alias UNIQUE 实际生效 / term_relation 双向对称 / 每关题池 ≥8 / `pg_trgm` 索引可用 / 免责声明 4 个 code 齐全且 version 一致 / 已发布词条数 == MDX 文件数 | 任一失败 → `exit 1` + 输出具体差异行 | 同上 |
| **8** | **回写 PR comment** | `actions/github-script`：Preview URL + 变更词条清单 + 校验报告摘要 + 疑似未收录黑话候选清单（Layer A 自动生成） | 评论失败 → 仅记 Warn，不阻断 | 无 |
| **9** | **二级专业复核 + 三级合规终审** | 人工 PR review approve ×2（CODEOWNERS 强制两个不同 team） | 驳回 → 回到步骤 0 | 无（未合并） |
| **10** | **合并 main** | Squash merge（**保留单 commit = 单发布批次**，便于 roll-forward 定位） | — | `git revert <sha>` |
| **11** | **清理验证分支** | `neonctl branches delete pr-$PR-content` | 失败 → 每日兜底扫描删除 | — |
| **12** | **⏸ 发布窗口人工审批** | GitHub Environment `content-production` 的 `Required reviewers` → workflow 挂起等待放行 | 审批被拒 → 内容留在 main 但**不发布**（安全状态：线上仍是旧版本，自洽）。值班人可择期重新 `workflow_dispatch` | 无（未写生产库） |
| **13** | **生产编译预检（幂等 dry-run）** | `pnpm content:compile --target production --dry-run` → 输出「将新增 N 条 / 更新 M 条 / 归档 K 条 / checksum 变化 是/否」 | **若 checksum 无变化 → 直接 `exit 0` 跳过后续所有步骤**（这就是幂等：重复触发不产生新版本、不刷缓存、不打扰索引） | 无（dry-run 不写） |
| **14** | **⚠️ 环境断言** | 脚本校验 `DATABASE_URL_WRITE` 的 host 匹配 `CONTENT_PROD_DB_HOST_PATTERN`，且 `content_release` 当前 version 等于预期基线（**乐观锁**：若不等说明有并发发布，`exit 3`） | `exit 3` → 中止 + Page 告警（并发发布或有人手工改了库） | 无 |
| **15** | **原子发布（单事务）** | `pnpm content:compile --target production --commit`：BEGIN → upsert terms/senses/aliases/relations/questions/disclaimers → **UPDATE `content_release` SET version=version+1, checksum=..., git_sha=..., published_at=now(), published_by=..., approved_run_id=...** → COMMIT | 任一步失败 → **事务 ROLLBACK，生产库完全无变化**，`exit 1` + Page 告警。**这是整条链路最关键的设计：不存在"发了一半"的状态** | **事务回滚 = 天然回滚点**（步骤 15 之前，生产库零污染） |
| **16** | **发布后即时校验（写后读一致性）** | 用只读连接查 `content_release.version` 与 `SELECT count(*) FROM term WHERE status='published'`，与 dry-run 预期比对 | 不一致 → Page 告警 + **自动触发步骤 20 的 roll-forward** | 见步骤 20 |
| **17** | **触发缓存失效** | `curl -X POST $APP_ORIGIN/api/revalidate -H "x-revalidate-secret: $REVALIDATE_SECRET" -d '{"tags":["lexicon","term:*","category:*","level:*","disclaimer:*"]}'`（**按变更范围精确打 tag，全量 tag 仅在紧急下架时用**） | revalidate 失败 → **重试 3 次（指数退避 2s/8s/32s）**；仍失败 → Warn 告警 + **不自动回滚**（因为 TTL 兜底：术语页 1h、lexicon 5min 会自动收敛）。⚠️ 但**若失败涉及 `disclaimer:*` → 升级为 Page**（免责不失效 = 合规风险） | 重发 revalidate（幂等操作） |
| **18** | **索引热更新（被动，无 CI 动作）** | 运行时 SWR 双缓冲：每请求检查 300s 缓存的 `content_release` meta → 发现 version 变化 → 后台构建新 Matcher → 原子切换（后端 §4.1） | 构建失败 → 保留旧索引 + 指数退避重试（30s→60s→120s，上限 5min）+ ERROR 日志。**⚠️ 若无流量则不重建** → 冒烟测试（步骤 19）会提供必要流量 | 自动回退旧索引（自洽优先） |
| **19** | **发布冒烟验证（自动，必须全绿）** | `pnpm verify:post-publish`：① `/api/health` 返回 `status:ok` 且 `index.version == 新版本` 且 `index.checksumAligned == true`（**最多轮询 12 次 × 5s = 60s，对齐 SLO「索引预热 ≤30s」留 1 倍余量**）；② 抽查 3 个变更词条的详情页，断言正文首句 == MDX 源文件首句；③ **断言 `disclaimer.version` == `content_release` 中该 code 的当前 version（免责一致性，硬断言）**；④ 搜索一个新增别名，断言命中；⑤ 断言响应中**无 `Set-Cookie`**（隐私回归） | ①②④ 失败 → **自动触发步骤 20**；③ 失败 → **Page 级 + 自动触发步骤 20**（合规优先）；⑤ 失败 → Page（合规红线） | — |
| **20** | **自动 roll-forward 到前一版本**（失败自愈） | `pnpm content:compile --at <上一个 content_release.git_sha> --target production --commit` → version **继续 +1**（⚠️ **不回退 version 数字**）→ revalidate → 重跑冒烟 | roll-forward 也失败 → **Page 级告警 + 停止自动动作，转人工**（此时可能不是内容问题而是 DB 问题，继续自动重试会掩盖根因） | — |
| **21** | **发布记录归档** | 写 `ops_event` 表 + GitHub Actions Summary + PR comment「✅ 已发布 v48（git abc1234），冒烟 5/5 通过，耗时 42s」 | 失败仅记 Warn | — |

#### 2.1.2 CI 校验项清单（对齐产品 §9.2 / §9.5 与 agent-content-pipeline §4）

| 规则 ID | 校验项 | 判据 | 级别 | 阻断合并 | 对齐的产品验收 |
|---|---|---|---|---|---|
| `SCHEMA-001` | **字段完整性** | Zod schema 全字段校验；缺任一必填字段即失败，错误信息指明缺失项 | **BLOCK** | ✅ | C2 ★ |
| `SCHEMA-002` | front-matter 可解析 + MDX 组件在白名单内 | 未知组件**编译期**报错（不是渲染期） | **BLOCK** | ✅ | 后端 §6.6 |
| `LEN-001` | `plain_explain` ≤ 40 字（可见字符，去空格，标点计入） | 超限即失败 | **BLOCK** | ✅ | C3 ★ |
| `LEN-002` | `advanced_explain` 60~150 字 | 超 150 需作者显式确认标记 | REVIEW | ❌ | — |
| `LEN-003` | `pro_explain` 100~250 字 | 同上 | REVIEW | ❌ | — |
| `LEN-004` | `example` 每条 30~80 字 | | **BLOCK** | ✅ | C5 ★ |
| `LEN-005` | `not_meaning` / `risk_note` 30~60 字（涉投资判断词条） | | **BLOCK** | ✅ | C6/C7 ★ |
| `LEN-006` | 单句 ≤30 字 | | REVIEW | ❌ | — |
| `EX-001` | 举例数 ≥1；L1 词条 ≥2 | | **BLOCK** | ✅ | C5 ★ |
| `EX-002` | **举例具体性**：含具体数字或时间（数字正则 ∪ 时间词表） | 至少 1 个举例命中 | **BLOCK** | ✅ | C5 ★ |
| `EX-003` | 举例含具体场景类型（场景词典 ≥1 命中） | | **BLOCK** | ✅ | C5 ★ |
| `EX-004` | 举例禁空泛（`在(股市|投资|市场|交易|金融)(中|里|上|时)?$`） | | **BLOCK** | ✅ | C5 ★ |
| `EX-005` | 举例禁套娃（零黑话扫描 = 0） | | **BLOCK** | ✅ | C4 ★ |
| `EX-006` | 多义词每义项独立举例 ≥1 | | **BLOCK** | ✅ | C11 ★ |
| `JARGAN-001~005` | **零黑话扫描**（复用 `packages/matcher` 的 AC 自动机 + Layer A/B 词典 + R1~R5 豁免判定） | `plain_explain` / `example` → **BLOCK**；`advanced_explain` / `not_meaning` / `risk_note` → REVIEW；`pro_explain` → ALLOW | **BLOCK**（部分字段） | ✅ | C4 ★（一票否决） |
| `JARGAN-006` | 自动生成「疑似未收录黑话候选清单」 | 产出物，供人工判定是否入 Layer B | INFO | ❌ | §4.1 |
| `BAN-001` | **禁用词扫描**：强禁词（稳赚/必涨/保本/零风险/内幕消息…）零命中 | **任何字段、任何白名单都不豁免** | **BLOCK** | ✅ | C8 ★ |
| `BAN-002` | 弱禁词（买/卖/建议/目标价/加仓/满仓…）三层判定：N4 祈使组合 → BLOCK；N1 名词化后缀 / N3 否定式提醒 → 自动放行；N2 语境豁免 → 放行但标记 `needs_human_confirm` | | **BLOCK** | ✅ | C8 ★ |
| `BAN-003` | 人工豁免（`banned-word-exemptions.yaml`）必须 `approved_by` 非空 + `context` 非空 | 缺署名 → **阻断**（不允许无署名豁免） | **BLOCK** | ✅ | §4.3 |
| `IMP-001` | **禁祈使句**（P1~P5 模式表） | `plain_explain`/`example` BLOCK；`not_meaning`/`risk_note` ALLOW（其职责就是劝阻） | **BLOCK** | ✅ | L8（措辞不出现"你应该"） |
| `SEC-001` | **无具体标的**：无股票代码、无 `价格+数字` 组合、无真实个股/基金名称 | | **BLOCK** | ✅ | C9 ★ / L3 ★ |
| `SEC-002` | **无收益承诺** | | **BLOCK** | ✅ | C8 ★ / L3 ★ |
| `SEC-003` | 举例中的数字必须标注为**虚构假设**（不得用真实历史行情数字而不标注） | | **BLOCK** | ✅ | 架构 §4.6 |
| `ALIAS-001` | **别名全局唯一**：`norm_key` 在全库范围内不指向两个不同 term | dry-run 内存检查 + 步骤 7 真库 UNIQUE 约束双验 | **BLOCK** | ✅ | 架构 §6.5 |
| `SENSE-001` | **sense 完整性**：多义词每义项均有独立释义 + 举例 + `context_label` + `frequency`；无合并拼接；恰有 1 个 `isPrimary` | | **BLOCK** | ✅ | C11 ★ / F4 ★ |
| `REF-001` | **引用完整性**：`related[]` 指向的 slug 必须存在且 `status='published'`；`term_relation` 必须**双向对称**；`confusion[]` 同理 | 悬空引用 → BLOCK（否则线上出现死链） | **BLOCK** | ✅ | F9 ★ |
| `DISC-001` | **免责声明存在性**：`disclaimer` 表中 `GENERAL` / `TERM_CARD` / `QUIZ_RESULT` / `TERM_DETAIL` 四个 code 均有 `is_active=true` 的记录，且 `approved_by` 非空、`version` 与 `disclaimer-templates.yaml` 一致 | | **BLOCK** | ✅ | L1 ★ / L4 ★ |
| `DISC-002` | **免责模板白名单精确匹配**：合规文案库中的文案整体豁免弱禁词（按 `code` 精确匹配，不按关键词）；**强禁词仍生效** | | **BLOCK** | ✅ | §4.3 |
| `RISK-001` | `regulatory_flags=yes` 的词条 100% 含 `risk_note` | | **BLOCK** | ✅ | C7 ★ |
| `RISK-002` | `not_meaning` 100% 存在且非空 | | **BLOCK** | ✅ | C6 ★ |
| `DUP-001/002` | **雷同检测**：同族词条 `plain_explain` 的字符 3-gram Dice > 0.60 → BLOCK；题目雷同同理 | | **BLOCK** | ✅ | §4.6 示例 5 |
| `QUIZ-001~004` | 题目弃权检查：送分题（题干含术语名）/ 歧义 / 荒谬项（内容覆盖率 <0.08）/ 长度失衡 | 弃权则丢题；**某关题池 <8 → BLOCK** | **BLOCK** | ✅ | C14 ★ |
| `QUIZ-005` | 100% 题目配有 1 句 `answer_basis`；干扰项均来自真实术语 | | **BLOCK** | ✅ | C14 ★ |
| `COVER-001` | **覆盖度硬约束**：术语 ≥120、义项 ≥145、12 个一级分类均有词条、难度分布 L1≥40/L2≥50/L3≥10、每个一级分类 ≥1 条 L1 | | **BLOCK** | ✅ | C1 ★ |
| `META-001` | 版本可追溯：每词条有 `reviewer` + `reviewed_at`；修订后 `content_version` 递增 | | **BLOCK** | ✅ | C10 ★ / C12 |
| `A11Y-001` | 设计 token 对比度（正文 ≥4.5:1、大字 ≥3:1、控件 ≥3:1） | `scripts/check-contrast.ts`，低于阈值 **fail build** | **BLOCK** | ✅ | A4 ★ |
| `PRIV-001` | **隐私回归**（见 §4.4） | Playwright 断言零 Cookie / 零第三方域 | **BLOCK** | ✅ | L6 ★ |

> **⚠️ 合规校验必须 CI 硬拦（不是 warning）—— 四条不可妥协的执行纪律**：
> 1. **`content-compliance` 是独立 job，且不允许 `continue-on-error: true`、不允许 `if: always()` 之后的软失败**。job 失败 → workflow 失败 → Branch Protection 阻止合并。
> 2. **不允许任何环境变量开关关闭合规校验**（如 `SKIP_COMPLIANCE=true`）。这类开关一旦存在，就会在某个赶进度的深夜被用上。校验器代码里**不读任何 skip 类变量**。
> 3. **`BLOCK` 与 `REVIEW` 的强度必须与产品文档措辞一致**（agent-content-pipeline §4.2 的理由）：把"建议"级做成硬阻断，作者会用无意义绕写绕过，反而降低质量；把"一票否决"做成 warning，等于没有。
> 4. **合规 job 的失败信息必须能直接照抄修改**（§4.6 四条硬要求）。差的错误信息 → 120 词条 × 2.5 轮返工 × 20min = 100 人时 ≈ ¥8,000~15,000 的纯浪费。

#### 2.1.3 编译脚本的幂等设计

「幂等」不是口号，具体到 6 条实现约束：

| # | 约束 | 做法 | 不做的后果 |
|---|---|---|---|
| 1 | **按自然键 upsert，不按自增 id** | `INSERT ... ON CONFLICT (slug) DO UPDATE SET ...`；sense 按 `(term_id, sense_id)`；alias 按 `(term_id, norm_key)` | 重跑一次 → 内容翻倍 |
| 2 | **checksum 前置短路** | 编译开始前先算全量规范化内容的 SHA-256；与 `content_release.checksum` 相同 → **立即 `exit 0`，不开事务、不递增 version、不打 tag** | 每次 CI 触发都递增 version → 索引反复重建 + CDN 反复失效 → 回源风暴 + 白白烧 CU-hrs |
| 3 | **单事务原子提交** | 全部 upsert + version 递增在一个 `BEGIN/COMMIT` 内；**version 递增是事务的最后一条语句** | 发了一半的中间态被线上读到（新词条存在但关系表还没写 → 详情页相关词为空） |
| 4 | **乐观锁防并发** | `UPDATE content_release SET version=version+1 WHERE version=$EXPECTED`；`affected_rows == 0` → `exit 3` | 两个 workflow 并发发布 → version 跳号 + checksum 与内容错配 → **触发「索引与 DB 长期不一致」的 Page 告警且无法自愈** |
| 5 | **删除用软归档，不硬删** | MDX 中消失的词条 → `status='archived'` + 保留全部字段；**绝不 `DELETE`** | ① 硬删后无法 roll-forward（旧 version 的编译需要旧数据）；② 已收录的 URL 直接 404（SEO 损失，产品 R9）；③ `term_relation` 外键级联删除会连带删掉别的词条的关系 |
| 6 | **确定性输出** | 编译过程**禁止使用随机数、当前时间戳、Map 迭代顺序**作为内容的一部分（`published_at` 只写 `content_release`，不写词条）；题目生成的 seed 由 `(termId, senseId, questionType)` 派生 | 同一份 MDX 两次编译产生不同 checksum → 幂等短路永远不生效 → 每次 CI 都发布一遍 |

**归档词条的线上行为**：`status='archived'` 的词条 → 详情页返回 **410 Gone**（不是 404，410 明确告诉搜索引擎"永久移除，别再来了"，比 301 到首页更诚实），并从 `sitemap.xml` 移除、从内存索引移除。**紧急下架单条违规内容用这条路径**（见 §5.2 场景 1）。

#### 2.1.4 内容发布是否需要人工审批：**需要，且有两道**

**结论：合规内容必须有人工放行卡点。卡点位置如下：**

```
卡点 1（质量与合规判定）：PR 层的 Branch Protection
  ├─ CODEOWNERS 强制 @content-finance-reviewers（二级专业复核）approve
  ├─ CODEOWNERS 强制 @compliance-reviewers（三级合规终审）approve
  ├─ Required approvals = 2，且必须来自两个不同 team
  ├─ Required status checks = ci / content-validate / content-compliance / quiz-generate / privacy-audit
  └─ 禁止 force push、禁止 admin bypass（⚠️ 连 Owner 也不能绕过 —— 合规内容不能"我急我说了算"）

卡点 2（发布时机）：GitHub Environment `content-production` 的 Required reviewers
  ├─ 合并 main 后，content-publish workflow 在 `gate` job 挂起
  ├─ 审批人 = 当周值班人（1 人即可，因为质量与合规已在卡点 1 双审过）
  ├─ 审批时能看到：变更词条清单、dry-run diff、预计影响的 tag 数量、当前线上 version
  └─ 审批的作用不是"再审一遍内容"，而是**控制发布时机**
```

**为什么要第二道（这是很多团队会省掉、但本项目不能省的一步）**：

| 收益 | 具体说明 |
|---|---|
| **发布窗口化** | 建议工作日 **11:00 / 16:00** 两个窗口（避开凌晨与周五下班后）。内容出错的高峰发现期是发布后 30 分钟内 —— **窗口化保证出问题时有人在线** |
| **批量发布** | 一天内合并 5 个内容 PR → 只发布 1 次 → `content_release.version` 只 +1 → 索引只重建 1 次、CDN 只失效 1 次。**降低发布频率 = 降低事故面 = 降低 CU-hrs** |
| **可暂停** | 遇到线上事故、Neon 抖动、或合规争议时，值班人**不点批准就等于冻结了发布**，无需任何额外操作。这是最便宜的一个 kill switch |
| **紧急通道仍保留** | `workflow_dispatch` 带 `emergency: true` → 仍需 1 人审批，但跳过窗口等待。用于「单条内容违规需立即下架」 |

**⚠️ 一个必须明确的例外**：`emergency` 通道**不能跳过卡点 1**。也就是说，紧急下架也要先有一个（哪怕只有一个 commit 的）PR 并经过合规 reviewer approve。**"紧急"不是绕过合规审批的理由，只是绕过发布窗口的理由。**

#### 2.1.5 ⚠️ 发布顺序：先发应用还是先发内容？

**结论：默认「先应用，后内容」（Expand → Migrate → Contract 模式）。但真正的答案是——两者在 v1 是解耦的，因为免责与正文在同一个内容批次里。**

**（A）正文与免责必须同版本 —— 靠机制而非顺序**

这是最容易被做错的一点。三个层次同时上保险：

| 保险层 | 机制 | 防的是什么 |
|---|---|---|
| **① 数据层：同一事务** | `disclaimer` 表与 `term`/`sense` 表在**步骤 15 的同一个事务**里 upsert。`content_release.version` 是两者共同的版本戳 | 「免责改了但正文没改」或反之 —— 事务保证不可能只成功一半 |
| **② 缓存层：key 含 version** | 后端 §5.1 #16 的双保险：所有 `unstable_cache` 的 key 都带 `contentVersion` → **version 变化后旧 key 天然不再命中**，即使 `revalidateTag` 失败也不会出现「新正文 + 旧免责」 | tag 失效调用失败（网络抖动、secret 过期） |
| **③ 渲染层：同一次读取** | `/api/term/[slug]` 的响应里 `term` 与 `disclaimer` **来自同一次缓存写入**（后端 §6.7 明确要求），不是两次独立查询拼装 | 两次查询之间恰好跨了发布事务 |
| **④ 验证层：CI 硬断言** | 步骤 19 的冒烟 ③：`disclaimer.version == content_release 中该 code 的当前 version`，**不等则 Page + 自动 roll-forward** | 上面三层都失效的极端情况 |

**（B）应用与内容的发布顺序**

| 场景 | 正确顺序 | 理由 |
|---|---|---|
| **常规内容更新**（改释义、加词条、改举例） | 与应用发布**完全无关**，可独立进行 | 内容只是数据；应用代码读的字段没变 |
| **内容引入了应用尚不支持的新字段**（如新增 `pronunciation`） | **先应用，后内容**（Expand） | 新应用必须能读旧内容（字段可空/有默认值）；旧应用读到未知字段应忽略。**反之则新字段被静默丢弃** |
| **应用要移除对某字段的支持**（Contract） | **先内容（停止使用该字段），后应用** | 否则应用已不读，内容还在写 → 死数据 |
| **应用改了 API 契约**（如 `SearchResponse` 加字段） | **先应用（服务端），后前端消费方**；本项目前后端同仓同部署，天然原子 | — |
| **免责文案变更**（法务要求） | **走内容管线**，不走应用发布 | 架构 §4.6：「法务改文案 = 改数据 + 发布，不改代码、不发版」。这是免责声明入库的核心收益 |

**（C）一次「同时改了代码和内容」的 PR 怎么办？**

**必须拆成两个 PR。** 原因：代码走 Vercel 自动部署（合并即上线，分钟级），内容走发布窗口审批（可能等到 11:00）。**混在一个 PR 里，代码会在内容之前几分钟上线** —— 如果代码依赖新内容字段，这几分钟就是故障窗口。

CI 侧强制：`ci.yml` 加一个 `change-scope` job，若同一 PR 同时改动 `apps/**`（或 `packages/{db,matcher,contracts}/**`）与 `content/terms/**` → **`exit 1`，提示拆分 PR**。**例外**：只改 `content/lexicon/*.yaml`（词典/模板配置）可与代码同 PR，因为它随构建打包，与 DB 发布批次无关。

---

### 2.2 应用发布流水线

**发布方式：Vercel 的原子部署 + 即时 Promote（本质是蓝绿），不做金丝雀。**

**为什么不做金丝雀/滚动**（诚实说明取舍）：

| 方案 | 是否采用 | 理由 |
|---|---|---|
| **蓝绿（Vercel Deployment Promotion）** | ✅ **采用** | Vercel 每次部署产出一个**不可变、有独立 URL 的完整构建产物**；`Production` 域名指向哪个 deployment 是**原子切换**（改一条路由记录），**切换耗时 <2s，回滚同样 <2s**。这已经是蓝绿的全部收益 |
| **滚动** | ❌ 不适用 | Serverless 无常驻实例，不存在"逐台替换"的概念 |
| **金丝雀（按流量百分比）** | ❌ **v1 不做** | ① 需要 Vercel 的 Traffic Split（Skew/Edge Config 方案），配置复杂度显著上升；② 本项目**无账号体系 → 无法做用户维度灰度**，只能做随机流量灰度，而随机灰度对「内容站」几乎没有意义（用户看到的所有页面都是静态的）；③ **真正需要灰度的是内容，而内容的灰度手段是「分批发布」而非「分流」**（见下） |

**内容的"灰度"替代方案（这才是本项目该做的）**：
1. **分批发布**：一次内容 PR 只改 10~20 条词条，而不是一次性改 120 条。小批次 = 小爆炸半径。
2. **Staging 先行**：`content-publish` workflow 在写生产库**之前**，先对 `staging` 分支执行同样的编译 + 冒烟（增加约 90s，换掉「编译脚本 bug 直接写脏生产数据」这类事故）。
3. **新词条先 `status='draft'`**：新收录的词条首次发布时可标记为 draft（不进 sitemap、不被搜索索引命中、只能通过直链访问），观察 24~48h 无异常后由下一个批次转为 published。**这是零成本的真灰度**。

**应用发布链路（步骤表）**：

| # | 阶段 | 动作 | 失败处理 |
|---|---|---|---|
| 1 | PR CI | lint / typecheck / unit test / content-validate / build / contrast / size-budget / privacy-audit / lighthouse(仅 main) | 任一红 → 不可合并 |
| 2 | Preview 部署 | Vercel 自动为 PR 创建 Preview Deployment（消费内容快照 artifact，**不连 Neon**） | Vercel 自动重试；失败在 PR 页面标红 |
| 3 | 视觉回归 | Playwright 截图 12 个关键页面（首页/搜索有结果/搜索无结果/详情 L1/详情 L3/多义切换/答题中/答题反馈/错题本/闯关页/离线态/深色模式）与 baseline 比对，**像素差 >0.5% 即失败并上传 diff 图** | 失败 → 阻断合并；确认为预期变更 → `pnpm test:visual --update` 提交新 baseline（**baseline 变更必须独立 commit，便于 review**） |
| 4 | 合并 main | Squash merge | — |
| 5 | Production 部署 | Vercel 自动构建 + 部署（`generateStaticParams` 生成 120 页 SSG）→ 构建成功后**自动 Promote 到生产域名** | 构建失败 → 生产**完全不受影响**（旧 deployment 仍在服务）→ Page 告警 |
| 6 | 部署后冒烟 | `deploy-verify.yml`：`/api/health` ok、首页 200、随机 3 个术语页 200 且含免责文案、`/api/search?q=MACD` 命中、安全响应头齐全、**无 `Set-Cookie`**、`robots.txt` 与 `sitemap.xml` 可访问、OG 图 200 | 失败 → Page 告警 + 输出「建议执行 Vercel 一键回滚到 deployment `<id>`」的可点击链接 |
| 7 | 构建时长门禁 | 构建 > 8min（目标 ≤3min，架构 §4.1）→ Warn | 120 页无压力；此门禁的真实作用是**在扩展到 2,000 页时提前发现需要改 ISR** |

**构建时长与性能预算门禁**（来自前端设计 §1662 与架构 §4.1）：

| 门禁 | 阈值 | 失败行为 |
|---|---|---|
| `next build` 时长 | ≤ 3min（Warn @ 5min，BLOCK @ 8min） | 阻断 |
| JS 首屏 bundle | ≤ 90KB gzip（`size-limit`） | 阻断 |
| HTML（术语页） | ≤ 30KB gzip | 阻断 |
| CSS | ≤ 12KB | 阻断 |
| 字体 | ≤ 40KB | 阻断 |
| Lighthouse（mobile, 4G throttle） | LCP ≤1800ms、CLS ≤0.1、INP ≤200ms、a11y ≥95 | 阻断（**仅 main 分支跑**，PR 上为 Warn，因为 Lighthouse 在 CI 里抖动大） |
| SSG 页数 | == `SELECT count(*) FROM term WHERE status='published'` | 阻断（防「构建期漏生成页面 → 线上 404」） |

---

### 2.3 GitHub Actions 工作流（YAML）

> 说明：以下 5 个 workflow 覆盖 lint / test / content-validate / content-compile / deploy / 巡检。
> **标注约定**：`【必须】` = 上线前必须具备；`【可选】` = 可后置但强烈建议。`失败阻断` = 是否阻止合并/发布。
> 所有 workflow 都用 `permissions:` 显式最小化（**不用默认的宽权限**），都用 `concurrency` 防并发打架。

#### 2.3.1 `.github/workflows/ci.yml` — PR 质量门【必须｜失败阻断合并】

```yaml
name: ci

on:
  pull_request:
    branches: [main, staging]
  push:
    branches: [main]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true   # PR 上的 CI 可取消（推新 commit 即作废旧的）

env:
  NODE_VERSION: '22'
  PNPM_VERSION: '10'

jobs:
  change-scope:
    name: 变更范围检查（禁止代码与内容混在一个 PR）
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: 检查是否同时改动应用代码与词条内容
        run: |
          set -euo pipefail
          BASE="${{ github.event.pull_request.base.sha || github.event.before }}"
          if [ -z "$BASE" ] || [ "$BASE" = "0000000000000000000000000000000000000000" ]; then
            BASE="$(git rev-parse HEAD~1)"
          fi
          git diff --name-only "$BASE" HEAD > /tmp/changed.txt || true
          APP_CHANGED=$(grep -Ec '^(apps/|packages/(db|matcher|contracts|http-kit)/)' /tmp/changed.txt || true)
          TERM_CHANGED=$(grep -Ec '^content/terms/' /tmp/changed.txt || true)
          echo "应用代码变更文件数: $APP_CHANGED"
          echo "词条内容变更文件数: $TERM_CHANGED"
          if [ "$APP_CHANGED" -gt 0 ] && [ "$TERM_CHANGED" -gt 0 ]; then
            echo "::error::禁止在同一 PR 同时修改应用代码与词条内容。"
            echo "原因：代码走 Vercel 自动部署（合并即上线），内容走发布窗口审批（可能延后数小时）。"
            echo "     混在一起会导致代码先于内容上线，若代码依赖新内容字段则产生故障窗口。"
            echo "改法：拆成两个 PR。仅改 content/lexicon/*.yaml（词典/模板）可与代码同 PR。"
            exit 1
          fi

  lint-typecheck:
    name: Lint + TypeCheck
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: ${{ env.PNPM_VERSION }}
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: ESLint（react/no-danger 必须为 error 级）
        run: pnpm lint --max-warnings=0
      - name: TypeScript
        run: pnpm typecheck
      - name: 安全正则审计（禁止嵌套量词，防 ReDoS）
        run: pnpm audit:regex

  secret-scan:
    name: 密钥泄漏扫描
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: gitleaks（含 Neon 连接串自定义规则）
        uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GITLEAKS_CONFIG: .gitleaks.toml
      - name: .env.example 与代码引用一致性
        run: pnpm audit:env-parity

  unit-test:
    name: 单元测试 + 覆盖率门禁
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: ${{ env.PNPM_VERSION }}
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: 运行测试（matcher 包要求覆盖率 ≥90%，其余 ≥75%）
        run: pnpm test -- --coverage
      - name: AC 自动机中文边界基准（200 字符 adversarial 输入 <1ms）
        run: pnpm test:bench
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: coverage-${{ github.run_id }}
          path: coverage/
          retention-days: 90

  content-validate:
    name: 内容质量校验（BLOCK 级）
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: ${{ env.PNPM_VERSION }}
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: 生成 Layer A 黑话词典（从 MDX 自动抽取 surface）
        run: pnpm content:gen-jargon-dict
      - name: 结构 / 字数 / 举例具体性 / 别名唯一 / sense 完整 / 引用完整 / 雷同 / 覆盖度
        run: pnpm content:validate --strict --reporter=github
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: content-validate-report-${{ github.run_id }}
          path: .content-report/
          retention-days: 90

  content-compliance:
    name: 合规校验（硬拦 · 不可绕过 · 不可 continue-on-error）
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: ${{ env.PNPM_VERSION }}
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      # 注意：本 job 不接受任何 skip 开关；校验器代码中不读取任何 SKIP_* 环境变量
      - name: 禁用词 / 祈使句 / 具体标的 / 收益承诺 / 免责声明存在性与版本 / 虚构假设标注
        run: pnpm content:compliance --strict --reporter=github
      - name: 豁免项署名审计（approved_by 必须非空）
        run: pnpm content:audit-exemptions --strict

  quiz-generate:
    name: 题目编译 + 弃权检查
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: ${{ env.PNPM_VERSION }}
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: 生成题目并执行 4 道弃权检查（送分/歧义/荒谬/长度）
        run: pnpm quiz:generate --check-only --fail-on-pool-shortage
      - name: 题量与依据覆盖率断言（≥360 题，100% 有 answer_basis）
        run: pnpm quiz:assert-coverage

  content-snapshot:
    name: 编译内容快照（供 Preview 构建消费，不连 Neon）
    runs-on: ubuntu-latest
    needs: [content-validate, content-compliance, quiz-generate]
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: ${{ env.PNPM_VERSION }}
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: 编译为快照 JSON（纯函数，无 DB）
        run: pnpm content:compile --target snapshot --out .artifacts/content-snapshot.json
      - name: 对快照签名（防 artifact 投毒）
        run: |
          node -e "const c=require('crypto'),f=require('fs');const b=f.readFileSync('.artifacts/content-snapshot.json');f.writeFileSync('.artifacts/content-snapshot.sha256',c.createHash('sha256').update(b).digest('hex'))"
      - uses: actions/upload-artifact@v4
        with:
          name: content-snapshot
          path: .artifacts/
          retention-days: 14

  build-and-budget:
    name: 构建 + 性能预算 + 对比度 + 隐私审计
    runs-on: ubuntu-latest
    needs: [content-snapshot, lint-typecheck, unit-test]
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: ${{ env.PNPM_VERSION }}
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - uses: actions/download-artifact@v4
        with:
          name: content-snapshot
          path: .artifacts/
      - name: 构建（消费快照，CONTENT_SNAPSHOT_PATH 生效则不查库）
        run: pnpm build
        env:
          CONTENT_SNAPSHOT_PATH: .artifacts/content-snapshot.json
          NEXT_PUBLIC_SITE_URL: https://preview.example.com
          ANALYTICS_ENABLED: 'false'
      - name: 静态产物预算（JS ≤90KB / HTML ≤30KB / CSS ≤12KB / 字体 ≤40KB）
        run: pnpm budget
      - name: 设计 token 对比度（正文 ≥4.5:1，大字 ≥3:1）
        run: pnpm a11y:contrast
      - name: SSG 页数 == 快照中已发布词条数
        run: pnpm build:assert-page-count --snapshot .artifacts/content-snapshot.json
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: build-output-${{ github.run_id }}
          path: .next/trace
          retention-days: 30

  privacy-audit:
    name: 隐私合规审计（零 Cookie / 零第三方 / 零 PII）
    runs-on: ubuntu-latest
    needs: [build-and-budget]
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: ${{ env.PNPM_VERSION }}
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - uses: actions/download-artifact@v4
        with:
          name: content-snapshot
          path: .artifacts/
      - name: 静态扫描构建产物（禁第三方追踪脚本）
        run: pnpm privacy:scan-bundle
      - name: 启动生产模式服务并跑 Playwright 隐私断言
        run: |
          pnpm start &
          npx wait-on tcp:3000 -t 120000
          pnpm privacy:runtime
        env:
          CONTENT_SNAPSHOT_PATH: .artifacts/content-snapshot.json
          ANALYTICS_ENABLED: 'true'   # 故意开启，验证开启后仍然零 Cookie
      - name: 源码审计（x-forwarded-for 仅允许出现在限流中间件）
        run: pnpm privacy:audit-source
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: privacy-report-${{ github.run_id }}
          path: .privacy-report/
          retention-days: 90

  visual-regression:
    name: 视觉回归（12 个关键页面）
    runs-on: ubuntu-latest
    needs: [build-and-budget]
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: ${{ env.PNPM_VERSION }}
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec playwright install --with-deps chromium
      - uses: actions/download-artifact@v4
        with:
          name: content-snapshot
          path: .artifacts/
      - name: 截图比对（像素差 >0.5% 失败）
        run: pnpm test:visual --threshold 0.005
        env:
          CONTENT_SNAPSHOT_PATH: .artifacts/content-snapshot.json
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: visual-diff-${{ github.run_id }}
          path: test-results/visual/
          retention-days: 30

  lighthouse:
    name: Lighthouse CI（LCP/CLS/INP/a11y）
    runs-on: ubuntu-latest
    needs: [build-and-budget]
    # PR 上为可选（不阻断，CI 环境抖动大）；main 上阻断
    continue-on-error: ${{ github.event_name == 'pull_request' }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: ${{ env.PNPM_VERSION }}
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - uses: actions/download-artifact@v4
        with:
          name: content-snapshot
          path: .artifacts/
      - name: Lighthouse（mobile preset，4G throttle）
        run: pnpm lhci autorun
        env:
          CONTENT_SNAPSHOT_PATH: .artifacts/content-snapshot.json
          LHCI_GITHUB_APP_TOKEN: ${{ secrets.LHCI_GITHUB_APP_TOKEN }}
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: lighthouse-${{ github.run_id }}
          path: .lighthouseci/
          retention-days: 90

  branch-verify:
    name: Neon 验证分支（真实库校验 · 仅内容 PR）
    runs-on: ubuntu-latest
    if: github.event_name == 'pull_request'
    needs: [content-validate, content-compliance]
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: ${{ env.PNPM_VERSION }}
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: 判断是否改动了词条内容
        id: scope
        run: |
          git fetch origin "${{ github.event.pull_request.base.ref }}" --depth=50
          git diff --name-only "origin/${{ github.event.pull_request.base.ref }}" HEAD -- content/terms content/lexicon packages/content packages/quiz > /tmp/c.txt || true
          echo "count=$(wc -l < /tmp/c.txt | tr -d ' ')" >> "$GITHUB_OUTPUT"
      - name: 创建短命验证分支（suspend-timeout 60s）
        if: steps.scope.outputs.count != '0'
        id: branch
        run: |
          BR="pr-${{ github.event.pull_request.number }}-content"
          neonctl branches create "$BR" --parent main --suspend-timeout 60 --output json > /tmp/br.json
          echo "name=$BR" >> "$GITHUB_OUTPUT"
          echo "url=$(node -p "require('/tmp/br.json').connection_uris[0].connection_uri")" >> "$GITHUB_OUTPUT"
        env:
          NEON_API_KEY: ${{ secrets.NEON_API_KEY }}
      - name: 编译到验证分支
        if: steps.branch.outcome == 'success'
        run: pnpm content:compile --target branch --branch "${{ steps.branch.outputs.name }}" --diff-report
        env:
          DATABASE_URL_WRITE: ${{ steps.branch.outputs.url }}
      - name: 编译后校验（UNIQUE / 外键对称 / 题池 / pg_trgm / 免责四 code）
        if: steps.branch.outcome == 'success'
        run: pnpm content:verify-db
        env:
          DATABASE_URL_WRITE: ${{ steps.branch.outputs.url }}
      - name: 回写 PR 评论（验证分支连接信息不落评论，只落结论）
        if: always() && steps.scope.outputs.count != '0'
        uses: actions/github-script@v7
        with:
          script: |
            const ok = '${{ steps.branch.outcome }}' === 'success'
              && '${{ job.status }}' === 'success';
            await github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
              body: ok
                ? '✅ **Neon 验证分支校验通过**：别名唯一性、关系双向对称、每关题池 ≥8、pg_trgm 可用、免责声明 4 个 code 齐全且版本一致。'
                : '⚠️ **Neon 验证分支校验未通过或未执行**（详见 workflow 日志）。若因 Neon 配额/网络导致跳过，本 PR 仍可在人工确认风险后合并，但需在发布前于 staging 重跑 `content:verify-db`。',
            });
      - name: 删除验证分支（post 清理）
        if: always() && steps.branch.outputs.name != ''
        run: neonctl branches delete "${{ steps.branch.outputs.name }}" || true
        env:
          NEON_API_KEY: ${{ secrets.NEON_API_KEY }}
```

#### 2.3.2 `.github/workflows/content-publish.yml` — 内容发布【必须｜失败阻断 + 自动 roll-forward】

```yaml
name: content-publish

on:
  push:
    branches: [main]
    paths:
      - 'content/**'
      - 'packages/content/**'
      - 'packages/quiz/**'
  workflow_dispatch:
    inputs:
      emergency:
        description: '紧急下架/热修：跳过发布窗口等待，仍需 1 人审批（不跳过 PR 双审）'
        type: boolean
        default: false
      target_ref:
        description: '要发布的 git ref（留空 = 当前 main HEAD）；用于回滚到历史内容'
        type: string
        default: ''
      skip_staging:
        description: '跳过 staging 预演（仅在 staging 本身故障时使用，需在审批说明中记录理由）'
        type: boolean
        default: false

permissions:
  contents: read
  pull-requests: write

# 内容发布绝不 cancel-in-progress：半程中断会留下不一致状态，必须排队串行执行
# ⚠️ 组名必须与 db-migrate.yml 完全一致（prod-db-writes）：
#    「schema 迁移」与「内容编译写库」都写同一个生产库，必须全局串行，
#    否则并发会导致 content_release.version 跳号 + checksum 与内容错配（§5.2 场景 12）
concurrency:
  group: prod-db-writes
  cancel-in-progress: false

env:
  NODE_VERSION: '22'
  PNPM_VERSION: '10'

jobs:
  prepare:
    name: 准备与范围计算
    runs-on: ubuntu-latest
    outputs:
      target_ref: ${{ steps.ref.outputs.target_ref }}
      prev_sha: ${{ steps.calc.outputs.prev_sha }}
      changed_count: ${{ steps.calc.outputs.changed_count }}
    steps:
      - name: 解析目标 ref（workflow_dispatch 可指定历史 ref，用于内容回滚）
        id: ref
        run: |
          set -euo pipefail
          INPUT_REF="${{ github.event.inputs.target_ref }}"
          if [ -n "$INPUT_REF" ]; then
            echo "target_ref=$INPUT_REF" >> "$GITHUB_OUTPUT"
          else
            echo "target_ref=${{ github.sha }}" >> "$GITHUB_OUTPUT"
          fi
      - uses: actions/checkout@v4
        with:
          ref: ${{ steps.ref.outputs.target_ref }}
          fetch-depth: 50
      - name: 计算变更文件数与上一提交（roll-forward 的回退目标）
        id: calc
        run: |
          set -euo pipefail
          PREV=$(git rev-parse HEAD~1 2>/dev/null || echo "")
          echo "prev_sha=$PREV" >> "$GITHUB_OUTPUT"
          if [ -n "$PREV" ]; then
            N=$(git diff --name-only "$PREV" HEAD -- content packages/content packages/quiz | wc -l | tr -d ' ')
          else
            N=999
          fi
          echo "changed_count=$N" >> "$GITHUB_OUTPUT"

  compile-check:
    name: 编译校验（全量 BLOCK 规则重跑，防 main 上的组合违规）
    runs-on: ubuntu-latest
    needs: prepare
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ needs.prepare.outputs.target_ref }}
      - uses: pnpm/action-setup@v4
        with:
          version: ${{ env.PNPM_VERSION }}
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: 重新生成 Layer A 词典并全量校验
        run: |
          pnpm content:gen-jargon-dict
          pnpm content:validate --strict --reporter=github
      - name: 全量合规校验
        run: pnpm content:compliance --strict --reporter=github
      - name: 题目生成与弃权检查
        run: pnpm quiz:generate --check-only --fail-on-pool-shortage
      - name: 编译为快照并计算 checksum
        id: snap
        run: |
          pnpm content:compile --target snapshot --out .artifacts/content-snapshot.json
          node -e "const c=require('crypto'),f=require('fs');const b=f.readFileSync('.artifacts/content-snapshot.json');console.log('checksum='+c.createHash('sha256').update(b).digest('hex'))" >> "$GITHUB_OUTPUT"
      - name: 上传编译报告（供审批人查阅）
        uses: actions/upload-artifact@v4
        with:
          name: compile-report-${{ github.run_id }}
          path: |
            .artifacts/
            .content-report/
          retention-days: 90
    outputs:
      checksum: ${{ steps.snap.outputs.checksum }}

  staging-rehearsal:
    name: Staging 预演（真实库编译 + 冒烟，不触碰生产）
    runs-on: ubuntu-latest
    needs: [prepare, compile-check]
    if: ${{ github.event.inputs.skip_staging != 'true' }}
    environment: staging
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ needs.prepare.outputs.target_ref }}
      - uses: pnpm/action-setup@v4
        with:
          version: ${{ env.PNPM_VERSION }}
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: 编译到 staging 库（幂等；checksum 相同则跳过）
        run: pnpm content:compile --target staging --commit
        env:
          DATABASE_URL_WRITE: ${{ secrets.STAGING_DATABASE_URL_WRITE }}
      - name: staging 冒烟（staging 域名）
        run: pnpm verify:post-publish --base-url "${{ vars.STAGING_ORIGIN }}" --timeout-sec 90
        env:
          REVALIDATE_SECRET: ${{ secrets.STAGING_REVALIDATE_SECRET }}

  gate:
    name: ⏸ 发布窗口人工审批（值班人放行）
    runs-on: ubuntu-latest
    needs: [prepare, compile-check, staging-rehearsal]
    if: |
      always() &&
      needs.prepare.result == 'success' &&
      needs.compile-check.result == 'success' &&
      (needs.staging-rehearsal.result == 'success' || needs.staging-rehearsal.result == 'skipped')
    # Environment 配置：Required reviewers = 值班人组；Wait timer = 0（窗口靠人工掌握）
    # 紧急通道：emergency=true 时同样需要审批，但审批人可立即点批准，不受窗口约定限制
    environment:
      name: content-production
      url: https://github.com/${{ github.repository }}/actions/runs/${{ github.run_id }}
    steps:
      - name: 输出审批上下文（审批人在此页面看到即将发生什么）
        run: |
          echo "### 待发布内容" >> "$GITHUB_STEP_SUMMARY"
          echo "- 目标 ref: \`${{ needs.prepare.outputs.target_ref }}\`" >> "$GITHUB_STEP_SUMMARY"
          echo "- 变更文件数: ${{ needs.prepare.outputs.changed_count }}" >> "$GITHUB_STEP_SUMMARY"
          echo "- 编译产物 checksum: \`${{ needs.compile-check.outputs.checksum }}\`" >> "$GITHUB_STEP_SUMMARY"
          echo "- 紧急通道: ${{ github.event.inputs.emergency || 'false' }}" >> "$GITHUB_STEP_SUMMARY"
          echo "- Staging 预演: ${{ needs.staging-rehearsal.result }}" >> "$GITHUB_STEP_SUMMARY"
          echo "" >> "$GITHUB_STEP_SUMMARY"
          echo "**批准后将对生产库执行原子 upsert 并递增 content_release.version，随后刷新 CDN 缓存。**" >> "$GITHUB_STEP_SUMMARY"
          echo "详见 artifact: compile-report-${{ github.run_id }}" >> "$GITHUB_STEP_SUMMARY"

  publish-production:
    name: 生产发布（原子事务 + 版本递增 + revalidate + 冒烟）
    runs-on: ubuntu-latest
    needs: [prepare, compile-check, gate]
    environment: content-production
    outputs:
      new_version: ${{ steps.publish.outputs.new_version }}
      smoke_result: ${{ steps.smoke.outputs.result }}
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ needs.prepare.outputs.target_ref }}
      - uses: pnpm/action-setup@v4
        with:
          version: ${{ env.PNPM_VERSION }}
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm
      - run: pnpm install --frozen-lockfile

      - name: 环境断言（防写错库）
        run: |
          node -e "
            const u = new URL(process.env.DATABASE_URL_WRITE);
            const re = new RegExp(process.env.CONTENT_PROD_DB_HOST_PATTERN);
            if (!re.test(u.hostname)) {
              console.error('::error::DATABASE_URL_WRITE 的 host 不匹配生产模式，拒绝执行。host=' + u.hostname);
              process.exit(2);
            }
            console.log('环境断言通过: ' + u.hostname);
          "
        env:
          DATABASE_URL_WRITE: ${{ secrets.PROD_DATABASE_URL_WRITE }}
          CONTENT_PROD_DB_HOST_PATTERN: ${{ vars.CONTENT_PROD_DB_HOST_PATTERN }}

      - name: 幂等预检（checksum 未变则整体跳过）
        id: precheck
        run: pnpm content:compile --target production --dry-run --json-out .artifacts/dryrun.json
        env:
          DATABASE_URL_WRITE: ${{ secrets.PROD_DATABASE_URL_WRITE }}

      - name: 原子发布（单事务：upsert + version++ + 乐观锁）
        id: publish
        if: steps.precheck.outputs.checksum_changed == 'true'
        run: pnpm content:compile --target production --commit --expected-checksum "${{ needs.compile-check.outputs.checksum }}" --json-out .artifacts/publish.json
        env:
          DATABASE_URL_WRITE: ${{ secrets.PROD_DATABASE_URL_WRITE }}

      - name: 精确 revalidateTag（按变更范围，避免全量回源风暴）
        if: steps.publish.outcome == 'success'
        run: pnpm content:revalidate --base-url "${{ vars.PROD_ORIGIN }}" --from-diff .artifacts/publish.json --retry 3 --backoff 2,8,32
        env:
          REVALIDATE_SECRET: ${{ secrets.PROD_REVALIDATE_SECRET }}

      - name: 发布冒烟（含免责版本一致性硬断言）
        id: smoke
        if: steps.publish.outcome == 'success'
        run: |
          set -o pipefail
          if pnpm verify:post-publish --base-url "${{ vars.PROD_ORIGIN }}" --timeout-sec 90 --strict-disclaimer \
             | tee .artifacts/smoke.log; then
            echo "result=pass" >> "$GITHUB_OUTPUT"
          else
            echo "result=fail" >> "$GITHUB_OUTPUT"
            exit 1
          fi
        env:
          REVALIDATE_SECRET: ${{ secrets.PROD_REVALIDATE_SECRET }}

      - name: 记录发布事件到 ops_event（补偿 Vercel 日志留存短）
        if: always()
        run: pnpm ops:event --type content_publish --status "${{ steps.smoke.outputs.result || 'skipped' }}" --run-id "${{ github.run_id }}" --ref "${{ needs.prepare.outputs.target_ref }}"
        env:
          DATABASE_URL_WRITE: ${{ secrets.PROD_DATABASE_URL_WRITE }}

      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: publish-artifacts-${{ github.run_id }}
          path: .artifacts/
          retention-days: 90

  auto-rollback:
    name: 🚨 自动 roll-forward 到前一版本（仅在发布后校验失败时触发）
    runs-on: ubuntu-latest
    needs: [prepare, compile-check, publish-production]
    if: |
      always() &&
      needs.publish-production.result == 'failure' &&
      needs.prepare.outputs.prev_sha != ''
    environment: content-production
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ needs.prepare.outputs.prev_sha }}
      - uses: pnpm/action-setup@v4
        with:
          version: ${{ env.PNPM_VERSION }}
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: 以前一版本内容重新发布（version 继续 +1，绝不回退数字）
        run: pnpm content:compile --target production --commit
        env:
          DATABASE_URL_WRITE: ${{ secrets.PROD_DATABASE_URL_WRITE }}
      - name: 全量 revalidate（回滚场景下宁可全量失效）
        run: pnpm content:revalidate --base-url "${{ vars.PROD_ORIGIN }}" --all-tags --retry 3
        env:
          REVALIDATE_SECRET: ${{ secrets.PROD_REVALIDATE_SECRET }}
      - name: 回滚后冒烟
        id: verify
        run: pnpm verify:post-publish --base-url "${{ vars.PROD_ORIGIN }}" --timeout-sec 90 --strict-disclaimer
      - name: 无论成败都发 Page 级告警（自动回滚说明发布链路有问题，必须有人看）
        if: always()
        run: |
          curl -sf -X POST "${{ vars.ALERT_WEBHOOK_URL }}" \
            -H 'Content-Type: application/json' \
            -d "{\"text\":\"🚨 [PAGE] 内容发布失败已自动 roll-forward 到 ${{ needs.prepare.outputs.prev_sha }}。回滚后冒烟: ${{ steps.verify.outcome }}。run: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}\"}"

  notify:
    name: 发布结果通知
    runs-on: ubuntu-latest
    needs: [prepare, compile-check, publish-production, auto-rollback]
    if: always()
    steps:
      - name: 汇总
        run: |
          {
            echo "### 内容发布结果"
            echo "| 项 | 值 |"
            echo "|---|---|"
            echo "| 目标 ref | \`${{ needs.prepare.outputs.target_ref }}\` |"
            echo "| 编译校验 | ${{ needs.compile-check.result }} |"
            echo "| 生产发布 | ${{ needs.publish-production.result }} |"
            echo "| 自动回滚 | ${{ needs.auto-rollback.result }} |"
            echo "| 新版本 | ${{ needs.publish-production.outputs.new_version }} |"
          } >> "$GITHUB_STEP_SUMMARY"
```

#### 2.3.3 `.github/workflows/db-migrate.yml` — Schema 迁移【必须｜失败阻断，独立审批】

```yaml
name: db-migrate

on:
  push:
    branches: [main]
    paths:
      - 'packages/db/migrations/**'
      - 'packages/db/schema/**'
  workflow_dispatch:
    inputs:
      target:
        description: '迁移目标环境'
        type: choice
        default: staging
        options: [staging, production]

permissions:
  contents: read

# 迁移与内容发布必须串行（都写同一个生产库）
# ⚠️ 组名必须与 content-publish.yml 完全一致（prod-db-writes），不同的组名不会互斥
concurrency:
  group: prod-db-writes
  cancel-in-progress: false

env:
  NODE_VERSION: '22'
  PNPM_VERSION: '10'

jobs:
  migrate-staging:
    name: 迁移 staging
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: ${{ env.PNPM_VERSION }}
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: 生成迁移 SQL 并检查是否有破坏性语句（DROP COLUMN / DROP TABLE / ALTER TYPE）
        run: pnpm db:migrate --check-destructive
      - name: 执行迁移
        run: pnpm db:migrate --apply
        env:
          DATABASE_URL_WRITE: ${{ secrets.STAGING_DATABASE_URL_WRITE }}
      - name: 迁移后 schema 快照留档
        run: pnpm db:snapshot-schema --out .artifacts/schema-staging.sql
      - uses: actions/upload-artifact@v4
        with:
          name: schema-staging-${{ github.run_id }}
          path: .artifacts/
          retention-days: 90

  migrate-production:
    name: 迁移 production（⚠️ 人工审批）
    runs-on: ubuntu-latest
    needs: migrate-staging
    if: github.event_name == 'push' || github.event.inputs.target == 'production'
    environment: db-production   # Required reviewers = 架构师 + 运维
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: ${{ env.PNPM_VERSION }}
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: 迁移前打 Neon 备份点（PITR 锚点，回滚的关键前提）
        run: |
          neonctl branches create "backup-pre-migrate-$(date -u +%Y%m%d%H%M)" \
            --parent main --suspend-timeout 60
        env:
          NEON_API_KEY: ${{ secrets.NEON_API_KEY }}
      - name: 执行迁移（破坏性语句需 --allow-destructive 显式确认，且必须先 Expand 后 Contract）
        run: pnpm db:migrate --apply
        env:
          DATABASE_URL_WRITE: ${{ secrets.PROD_DATABASE_URL_WRITE }}
      - name: 迁移后 /api/health 校验
        run: pnpm verify:health --base-url "${{ vars.PROD_ORIGIN }}" --expect ok
```

#### 2.3.4 `.github/workflows/deploy-verify.yml` — 部署后冒烟【必须｜失败 Page 告警，不自动回滚】

```yaml
name: deploy-verify

on:
  deployment_status: {}
  schedule:
    - cron: '*/15 * * * *'   # 每 15 分钟生产冒烟（补偿 Vercel 日志留存短 + 提供索引重建所需流量）
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: deploy-verify
  cancel-in-progress: true

jobs:
  smoke:
    name: 生产冒烟
    runs-on: ubuntu-latest
    # 仅在 Vercel 生产部署成功后立即跑；schedule 触发的无条件跑
    if: |
      github.event_name == 'schedule' ||
      github.event_name == 'workflow_dispatch' ||
      (github.event.deployment_status.state == 'success' &&
       github.event.deployment.environment == 'Production')
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: '10'
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: pnpm
      - run: pnpm install --frozen-lockfile --prod
      - name: 冒烟（health / 首页 / 术语页 / 搜索 / 免责一致性 / 安全头 / 零 Cookie / robots / sitemap / OG）
        id: smoke
        run: pnpm verify:production --base-url "${{ vars.PROD_ORIGIN }}" --reporter github
      - name: 失败即 Page 告警，并给出可点击的一键回滚指引
        if: failure()
        run: |
          curl -sf -X POST "${{ vars.ALERT_WEBHOOK_URL }}" \
            -H 'Content-Type: application/json' \
            -d "{\"text\":\"🚨 [PAGE] 生产冒烟失败。处置：Vercel 控制台 → Deployments → 上一个成功部署 → Promote（<2min）。详情: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}\"}"
      - name: 冒烟结果写入 ops_event（长期留存，替代 Vercel 短日志）
        if: always()
        run: pnpm ops:event --type smoke_test --status "${{ steps.smoke.outcome }}" --run-id "${{ github.run_id }}" || true
        env:
          DATABASE_URL_WRITE: ${{ secrets.PROD_DATABASE_URL_WRITE }}
```

#### 2.3.5 `.github/workflows/nightly-hygiene.yml` — 每日巡检 + 每周回溯扫描【必须｜失败 Warn】

```yaml
name: nightly-hygiene

on:
  schedule:
    - cron: '0 20 * * *'    # 每日 04:00 CST（20:00 UTC）
    - cron: '0 21 * * 0'    # 每周日 05:00 CST：全量回溯扫描
  workflow_dispatch:
    inputs:
      full_rescan:
        description: '强制执行全量回溯扫描'
        type: boolean
        default: false

permissions:
  contents: read
  issues: write

concurrency:
  group: nightly-hygiene-${{ github.run_id }}
  cancel-in-progress: false

env:
  NODE_VERSION: '22'
  PNPM_VERSION: '10'

jobs:
  neon-cleanup:
    name: Neon 分支清理与配额巡检
    runs-on: ubuntu-latest
    steps:
      - name: 删除存活 >24h 的 pr-* 分支
        run: |
          set -euo pipefail
          neonctl branches list --output json > /tmp/branches.json
          node -e '
            const fs=require("fs");
            const bs=JSON.parse(fs.readFileSync("/tmp/branches.json","utf8"));
            const now=Date.now();
            const keep=new Set(["main","staging","dev"]);
            const stale=bs.filter(b=>
              !keep.has(b.name) &&
              /^pr-/.test(b.name) &&
              (now - new Date(b.created_at).getTime()) > 24*3600*1000
            );
            fs.writeFileSync("/tmp/stale.txt", stale.map(b=>b.name).join("\n"));
            console.log("发现过期分支:", stale.length, stale.map(b=>b.name));
            console.log("分支总数:", bs.length);
            if (bs.length > 10) { console.log("::warning::Neon 分支总数 "+bs.length+" > 10，请检查清理逻辑"); }
          '
          while read -r name; do
            [ -z "$name" ] && continue
            echo "删除分支 $name"
            neonctl branches delete "$name" || echo "::warning::删除 $name 失败"
          done < /tmp/stale.txt
        env:
          NEON_API_KEY: ${{ secrets.NEON_API_KEY }}
      - name: 校验长驻分支的 suspend_timeout 设置（防常驻吃 CU-hrs）
        run: |
          neonctl branches list --output json | node -e '
            let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
              const bs=JSON.parse(s);
              for (const b of bs) {
                if (["staging","dev"].includes(b.name) && !b.compute?.suspend_timeout_seconds) {
                  console.log("::error::长驻分支 "+b.name+" 未设置 suspend_timeout，会常驻消耗 CU-hrs");
                  process.exit(1);
                }
              }
              console.log("长驻分支 suspend_timeout 检查通过");
            });'
        env:
          NEON_API_KEY: ${{ secrets.NEON_API_KEY }}
      - name: staging 分支每周一从 main reset
        if: github.event.schedule == '0 20 * * *'
        run: |
          DOW=$(date -u +%u)
          if [ "$DOW" = "1" ]; then
            neonctl branches reset staging --parent main --yes
            echo "staging 已从 main 重置"
          else
            echo "非周一，跳过 reset"
          fi
        env:
          NEON_API_KEY: ${{ secrets.NEON_API_KEY }}

  quota-report:
    name: 额度与成本日报（Vercel + Neon）
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: ${{ env.PNPM_VERSION }}
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm
      - run: pnpm install --frozen-lockfile --prod
      - name: 拉取用量并计算撞线百分比
        run: pnpm ops:quota-report --json-out .artifacts/quota.json
        env:
          VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
          VERCEL_TEAM_ID: ${{ vars.VERCEL_TEAM_ID }}
          NEON_API_KEY: ${{ secrets.NEON_API_KEY }}
      - name: 阈值告警（函数调用/ISR/带宽/CU-hrs/存储 各 70% Warn、85% Page）
        run: pnpm ops:quota-alert --config ops/quota-thresholds.yaml
        env:
          ALERT_WEBHOOK_URL: ${{ vars.ALERT_WEBHOOK_URL }}
      - uses: actions/upload-artifact@v4
        with:
          name: quota-report-${{ github.run_id }}
          path: .artifacts/quota.json
          retention-days: 90

  cert-dns-check:
    name: SSL 证书与 DNS 检查
    runs-on: ubuntu-latest
    steps:
      - name: SSL 剩余天数（<14 Warn，<3 Page）
        run: |
          set -euo pipefail
          DOMAIN="${{ vars.PROD_DOMAIN }}"
          END=$(echo | openssl s_client -servername "$DOMAIN" -connect "$DOMAIN:443" 2>/dev/null \
                | openssl x509 -noout -enddate | cut -d= -f2)
          END_TS=$(date -d "$END" +%s)
          NOW_TS=$(date +%s)
          DAYS=$(( (END_TS - NOW_TS) / 86400 ))
          echo "$DOMAIN 证书剩余 $DAYS 天"
          if [ "$DAYS" -lt 3 ]; then
            curl -sf -X POST "${{ vars.ALERT_WEBHOOK_URL }}" -H 'Content-Type: application/json' \
              -d "{\"text\":\"🚨 [PAGE] SSL 证书 $DAYS 天后到期：$DOMAIN\"}"
            exit 1
          elif [ "$DAYS" -lt 14 ]; then
            curl -sf -X POST "${{ vars.ALERT_WEBHOOK_URL }}" -H 'Content-Type: application/json' \
              -d "{\"text\":\"⚠️ [WARN] SSL 证书 $DAYS 天后到期：$DOMAIN（Vercel 应自动续期，请检查 Domains 页面状态）\"}"
          fi
      - name: DNS 解析检查（A/AAAA/CNAME 存在 + 指向 Vercel）
        run: |
          set -euo pipefail
          DOMAIN="${{ vars.PROD_DOMAIN }}"
          if ! dig +short "$DOMAIN" CNAME A AAAA | grep -q .; then
            curl -sf -X POST "${{ vars.ALERT_WEBHOOK_URL }}" -H 'Content-Type: application/json' \
              -d "{\"text\":\"🚨 [PAGE] $DOMAIN DNS 解析为空\"}"
            exit 1
          fi
          dig +short "$DOMAIN" CNAME A AAAA
      - name: 首页可用性（连续 3 次失败才告警，避免单次抖动误报）
        run: |
          FAIL=0
          for i in 1 2 3; do
            CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${{ vars.PROD_ORIGIN }}/" || echo 000)
            if [ "$CODE" != "200" ]; then FAIL=$((FAIL+1)); fi
            sleep 5
          done
          echo "失败次数: $FAIL/3"
          if [ "$FAIL" -ge 3 ]; then
            curl -sf -X POST "${{ vars.ALERT_WEBHOOK_URL }}" -H 'Content-Type: application/json' \
              -d "{\"text\":\"🚨 [PAGE] 首页连续 3 次探测失败\"}"
            exit 1
          fi

  weekly-full-rescan:
    name: 每周全量回溯扫描（规则演进后老内容是否失效）
    runs-on: ubuntu-latest
    if: github.event.schedule == '0 21 * * 0' || github.event.inputs.full_rescan == true
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: ${{ env.PNPM_VERSION }}
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      # 这是 agent-content-pipeline §4.5 ④「发布后校验」，绝不能省：
      # 零黑话词典/禁用词表一旦扩充，老词条会静默变成违规，而 Git diff 里它们"没变"
      - name: 全量重跑合规与零黑话扫描（对已发布内容）
        run: pnpm content:compliance --strict --scope all-published --reporter github
        continue-on-error: true
      - name: 线上抽样一致性校验（随机 20 条：线上正文 == MDX 源 + 免责版本一致）
        run: pnpm verify:content-drift --sample 20 --base-url "${{ vars.PROD_ORIGIN }}"
        env:
          REVALIDATE_SECRET: ${{ secrets.PROD_REVALIDATE_SECRET }}
      - name: 产出「待修清单」并开 Issue（不阻断，但必须可见）
        if: always()
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const p = '.content-report/rescan.md';
            if (!fs.existsSync(p)) { return; }
            const body = fs.readFileSync(p, 'utf8');
            if (body.trim().length === 0) { return; }
            await github.rest.issues.create({
              owner: context.repo.owner,
              repo: context.repo.repo,
              title: `[每周回溯扫描] 规则演进导致的历史内容待修清单 ${new Date().toISOString().slice(0,10)}`,
              body,
              labels: ['content', 'weekly-rescan'],
            });

  dependency-audit:
    name: 依赖漏洞与 lockfile 完整性
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: ${{ env.PNPM_VERSION }}
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm
      - name: lockfile 必须与 package.json 一致（禁 --no-frozen-lockfile）
        run: pnpm install --frozen-lockfile
      - name: 漏洞扫描（high 及以上阻断）
        run: pnpm audit --audit-level=high
      - name: 镜像/pipeline 无 Docker，故不做镜像扫描；改为检查 Actions 依赖是否锁定到 SHA
        run: pnpm audit:actions-pinning
```

**YAML 的实现约定（避免被误读为缺陷）**：

| 约定 | 说明 |
|---|---|
| **`steps.<id>.outputs.*` 由 pnpm 脚本写入** | `content:compile --json-out`、`--dry-run`、`verify:post-publish` 等 CLI 需在成功时向 `$GITHUB_OUTPUT` 追加 `checksum_changed=true/false`、`new_version=<n>`、`result=pass/fail`。这是 GitHub Actions 的标准约定（`echo "k=v" >> "$GITHUB_OUTPUT"`），**必须在实现这些 CLI 时一并落地**，否则 `if: steps.precheck.outputs.checksum_changed == 'true'` 恒为假 → **发布会被静默跳过**。⚠️ 这是一个"看起来没问题但会导致内容永远发不出去"的坑，已列入 §8 待确认 #21 |
| **`auto-rollback` 的触发边界** | 仅在 `publish-production.result == 'failure'` 时触发；审批被拒 → job 为 `skipped` → **不会触发回滚**（正确行为）。若失败发生在「环境断言」步骤（尚未写库），回滚会执行一次全量编译，但因 checksum 短路而是**幂等空操作**，无副作用 |
| **`concurrency` 组必须统一** | `content-publish` 与 `db-migrate` **都要用 `prod-db-writes`**（本文 YAML 中 `content-publish` 写的是 `content-publish-production`，**实现时必须改为 `prod-db-writes`**，见 §5.2 场景 12 与 §8 待确认 #3） |
| **Actions 版本锁定** | 生产 workflow 建议把 `uses: actions/checkout@v4` 锁定到 **commit SHA**（`audit:actions-pinning` job 校验此项），防第三方 Action 被投毒 —— 本项目 CI 持有生产库写凭据，供应链风险等级高于普通项目 |
| **`neonctl` 的安装** | 上述 YAML 假设 runner 已可用 `neonctl`。实现时在每个用到它的 job 前加 `npm i -g neonctl`（或用 `pnpm dlx neonctl`），并在 `pnpm install` 之后执行 |

**Workflow 汇总与阻断性标注**：

| Workflow | 触发 | 必须/可选 | 失败是否阻断 | 关键 job |
|---|---|---|---|---|
| `ci.yml` | PR + push main | **必须** | ✅ 阻断合并 | `content-compliance`（合规硬拦）、`privacy-audit`（隐私红线）、`change-scope`（禁混改） |
| `content-publish.yml` | main 上 `content/**` 变更 / 手动 | **必须** | ✅ 阻断发布 + **失败自动 roll-forward** | `gate`（人工审批）、`publish-production`（原子事务）、`auto-rollback` |
| `db-migrate.yml` | main 上 migration 变更 / 手动 | **必须** | ✅ 阻断（迁移失败会让应用读到不匹配的 schema） | `migrate-production`（独立 environment 审批 + 迁移前打备份分支） |
| `deploy-verify.yml` | Vercel 部署成功 / 每 15min / 手动 | **必须** | ⚠️ 不自动回滚（避免误判导致来回震荡），但发 Page 告警 + 给出一键回滚指引 | `smoke` |
| `nightly-hygiene.yml` | 每日 / 每周日 / 手动 | **必须**（分支清理与配额巡检）；`weekly-full-rescan` **强烈建议必须** | ⚠️ Warn 为主，开 Issue 可见 | `neon-cleanup`、`quota-report`、`weekly-full-rescan` |
| Lighthouse（在 `ci.yml` 内） | PR / main | 可选（PR 上 `continue-on-error`） | main 上阻断 | `lighthouse` |
| `visual-regression` | PR | **建议必须**（12 页截图成本低，能挡住绝大多数 UI 回归） | ✅ 阻断 | `visual-regression` |

**⚠️ 一个必须显式配置的 GitHub 侧设置（不做则上面所有门禁都是纸糊的）**：
Branch Protection on `main`：
- ✅ Require a pull request before merging
- ✅ Require approvals = **2**
- ✅ Require review from Code Owners
- ✅ Require status checks to pass（勾选：`Lint + TypeCheck`、`内容质量校验（BLOCK 级）`、`合规校验（硬拦）`、`题目编译 + 弃权检查`、`构建 + 性能预算 + 对比度 + 隐私审计`、`隐私合规审计`、`视觉回归`）
- ✅ Require branches to be up to date before merging
- ✅ **Do not allow bypassing the above settings**（含 admin）
- ✅ Block force pushes / Require linear history（squash）
- ✅ Require signed commits（**建议**：内容资产的作者身份可验证，是合规留痕的一部分）

---

## 3. 部署方案

### 3.1 Vercel 项目配置要点

| 配置项 | 值 | 理由 / 注意 |
|---|---|---|
| **Plan** | **Pro（$20/席位/月）** | ⚠️ **Hobby 明确禁止商用**。这是**合规检查项不是成本项** —— 用 Hobby 上线等于把整个业务置于「被 Vercel 单方面下架」的风险中（架构 §6.5 已列为高风险）。**进上线检查单，且每次续费后复核** |
| **Framework Preset** | `Next.js`（自动检测，Next 16 App Router） | 不要手动改成 `Other`，会丢失 ISR/SSG 的原生支持与 `cacheLife` 处理 |
| **Build Command** | `pnpm build`（Turbopack：`next build --turbopack`） | ⚠️ **构建期不查 DB**：`CONTENT_SNAPSHOT_PATH` 指向 CI 上传的快照 → Vercel 侧构建**不需要生产 `DATABASE_URL_WRITE`**（最小权限） |
| **Output Directory** | `.next`（默认） | — |
| **Install Command** | `pnpm install --frozen-lockfile` | **必须 frozen**：lockfile 漂移 = 供应链风险 + 构建不可复现 |
| **Node.js Version** | `22.x` | 与 CI 严格一致（`NODE_VERSION: '22'`）。**版本不一致是"CI 绿但线上挂"的头号原因** |
| **regions** | **`["sin1"]`（新加坡）** | 见 §3.2 |
| **Fluid Compute** | 开启（Pro 默认） | 改善冷启动；⚠️ 开启后 `maxDuration` 语义变化，需与后端 §2.x 的 `maxDuration=2` 设定对齐复核【待确认】 |
| **Skew Protection** | 开启 | ⚠️ **本项目尤其需要**：内容发布导致 deployment 切换时，客户端持有的旧 HTML 会请求旧 chunk → skew 保护避免 "ChunkLoadError"。这也是「正文与免责不错配」的又一层保障 |
| **Deployment Protection** | Preview：`Standard Protection`（需登录 Vercel 团队）；Production：`Only Deployment Domains` 关闭 | Preview 含**未过合规终审的内容**，绝不能公开可访问 |
| **Web Analytics** | 开启，**Cookie-less 模式**（Vercel 默认即免 Cookie） | 合规红线。**必须验证不发 Set-Cookie**，见 §4.4 |
| **Speed Insights** | 开启（RUM） | LCP/INP/CLS 的真实用户数据，是 SLO 验收的唯一可信来源（Lighthouse 只是实验室数据） |
| **Observability** | 开启 | 函数调用量、错误率、p95 延迟。**⚠️ Pro 的日志留存短【上线前复核】** |
| **Firewall → Rate Limit Rules** | 见下表 | 主防线 |
| **Firewall → WAF** | 开启托管规则集；`/api/**` 启用；⚠️ **`/api/health` 必须在所有 Rate Limit 规则中豁免** | 后端 §2.8 明确指出：不豁免 → 探针每次拿到 429 → **假警报**，且真实的宕机被噪声淹没 |
| **Domains** | `heihua.example.com`（生产）+ `staging.heihua.example.com` | 证书由 Vercel 自动签发续期（Let's Encrypt） |
| **Cron Jobs** | **不使用** | 后端 §4.1 已否决「Vercel Cron 触发索引重建」（新增对外攻击面）。所有定时任务走 GitHub Actions schedule |
| **Integrations** | Neon（**关闭 "create branch per preview"**）、GitHub | 见 §1.3 措施 ② |

**Vercel Firewall Rate Limit 规则表**（架构 §4.5 已锁定阈值）：

| 规则名 | 匹配路径 | 限流 | 窗口 | 动作 | 豁免 |
|---|---|---|---|---|---|
| `rl-search` | `/api/search` | 60 req | 1 min | 429 | `/api/health` |
| `rl-quiz` | `/api/quiz/*` | 30 req | 1 min | 429 | — |
| `rl-global` | 全站 | 300 req | 1 min | 429 | **`/api/health`、`/_next/static/*`、`/sitemap.xml`、`/robots.txt`** |
| `rl-lexicon` | `/api/lexicon` | 20 req | 1 min | 429 | — （载荷大，防反复拉全量；正常客户端有 IndexedDB 缓存，20/min 远超需要） |
| `rl-write` | `/api/quiz/answer`、`/api/search/miss`、`/api/quiz/sync` | 30 req | 1 min | 429 | — |
| `waf-bots` | 全站 | 已知恶意 UA / 无 UA | — | Block | **放行 Googlebot / Bingbot**（SEO 命脉，产品 R9；用 robots.txt + sitemap 引导正当爬虫） |

> ⚠️ **限流规则的一个反直觉要点**：**不要为了"防爬"而收紧爬虫限流**。词库是公开内容，被爬是 SEO 收益而非损失；真正要防的是「高频拉 `/api/lexicon` 全量」与「暴力枚举 `/api/term/*`」。所以规则设计成：**页面路径宽松、数据接口收紧**。

### 3.2 ⚠️ 区域选择：Vercel 函数区域必须与 Neon 区域一致

**这是本项目最容易被忽略、但一旦错了就直接击穿 SLO 的一条配置。**

Vercel Pro 的默认函数区域是 **`iad1`（美国弗吉尼亚）**。Neon 的默认区域常是 `aws-us-east-2`。**如果两者不同区，一次 DB 往返就是 +200~500ms** —— 而「搜索 API 端到端 p95 ≤250ms」的 SLO 根本装不下这个开销。

**推荐配置（按目标用户地区二选一）**：

| 场景 | Vercel `regions` | Neon region | 单程延迟 | 适用 |
|---|---|---|---|---|
| **A. 目标用户主要在中国大陆**（**推荐**，与产品定位「金融小白 / 中文用户」一致） | **`sin1`**（新加坡） | **`aws-southeast-1`**（新加坡） | 同区 <2ms；大陆用户 → 新加坡 RTT 约 60~120ms | ⚠️ **前提：无 ICP 备案则不能部署在大陆境内**（架构附录 B #8 待确认）。新加坡是「合规可达 + 大陆延迟最低」的折中 |
| **B. 目标用户全球 / 英文为主** | `iad1`（弗吉尼亚） | `aws-us-east-1`（弗吉尼亚） | 同区 <2ms | — |
| **C. 备选：日本** | `hnd1`（东京） | `aws-ap-northeast-1`（东京） | 同区 <2ms；大陆 → 东京 RTT 约 50~90ms | 若新加坡线路质量不佳可切此项 |

**❌ 绝对禁止的组合**：`sin1` + `aws-us-east-1`（跨太平洋，单程 ~230ms）→ 搜索 p95 直接飙到 700ms+，SLO 全线失守。

**三条配套约束**：
1. **`regions` 只填 1 个**。多区域是 Vercel Enterprise 能力；Pro 上填多个会取第一个或行为不确定【上线前复核】。
2. **区域影响的是「函数被调用的那部分请求」**。本项目术语页全量 SSG + CDN 边缘缓存 → **绝大多数用户请求根本不进函数、不碰 DB**（CDN PoP 全球分布，大陆用户命中就近节点）。区域选择主要影响：搜索 API 的冷路径、答题写库、`/api/lexicon` 回源。
3. **Neon 的 pooler 端点必须与 compute 同区**（Neon 自动保证，但连接串里要确认 host 的区域段，如 `aws-0-ap-southeast-1`）。**在配置完成后必须实测**：
   ```bash
   # 从 Vercel 函数内部打点（部署一个临时 /api/debug/latency 端点，或用 Neon 的 query log）
   # 期望：SELECT 1 的往返 <5ms
   ```

**区域选择的合规附加考量（⚠️ 需法务确认）**：
本项目**零个人数据采集**（无账号、无 Cookie、deviceId 不上报），因此**不存在「用户个人数据出境」问题** —— 这是隐私最小化设计带来的一个意外的运维红利：**部署区域的选择完全不受数据本地化法规约束**。唯一存留的服务端数据是 `answer_event`（无标识符的作答事实）与 `search_miss_log`（归一化 query 聚合计数，k≥3 门槛），两者均**不构成个人信息**。→ 结论：**可自由选择延迟最优的区域**。（仍需法务确认「金融类内容在中国大陆提供服务的资质要求」，见 §8 待确认 #2。）

### 3.3 `vercel.json` 关键片段

```jsonc
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "framework": "nextjs",
  "regions": ["sin1"],
  "buildCommand": "pnpm build",
  "installCommand": "pnpm install --frozen-lockfile",
  "git": { "deploymentEnabled": { "main": true, "staging": true } },
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" },
        { "key": "X-Frame-Options", "value": "DENY" },
        {
          "key": "Permissions-Policy",
          "value": "camera=(), microphone=(), geolocation=(), interest-cohort=(), browsing-topics=(), payment=(), usb=()"
        },
        {
          "key": "Strict-Transport-Security",
          "value": "max-age=63072000; includeSubDomains; preload"
        }
      ]
    }
  ],
  "crons": []
}
```

> ⚠️ **CSP 不放在 `vercel.json`**：CSP 需要 per-request nonce（后端 §6.5），必须由 `proxy.ts` 动态生成。放 `vercel.json` 会导致 nonce 无法注入 → 要么 CSP 失效、要么整站脚本被拦。**这是一个真实踩坑点，写在这里防止有人"顺手加上去"**。
> ⚠️ 非 Production 环境的 `X-Robots-Tag: noindex, nofollow` 通过 `next.config.ts` 的 `headers()` 按 `process.env.VERCEL_ENV !== 'production'` 注入。

### 3.4 回滚三方案对比

| 方案 | 机制 | 耗时 | 适用场景 | **不适用场景（关键）** | 风险 |
|---|---|---|---|---|---|
| **① Vercel 一键回滚（Promote 上一个 Deployment）** | Vercel 控制台 → Deployments → 选中上一个成功部署 → `Promote to Production`。本质是**改一条路由指向**，构建产物是不可变的历史快照 | **< 2 min**（无需重新构建） | ✅ **应用代码回归**：新版本引入运行时错误、性能退化、UI 崩坏、`ChunkLoadError` 大面积出现<br>✅ **构建产物本身有问题** | ❌ **不解决内容/数据问题**：DB 里的内容不会因为回滚部署而变<br>❌ **回滚到"读不懂新内容字段"的旧代码**：如果新内容引入了旧应用不支持的字段，回滚应用会让这些字段静默消失（见 §2.1.5 Expand/Contract）<br>❌ **需要修改代码才能修的问题**（回滚只是拖延） | ⚠️ **Promote 旧部署不会自动 revert Git**，导致「代码仓库 main ≠ 线上运行的代码」。**必须在回滚后立即开一个 revert PR 让两者收敛**，否则下一次任何人合并 main 都会把 bug 重新带上线（这是 Vercel 一键回滚最经典的陷阱） |
| **② Git revert + 重新部署** | `git revert <sha>` → PR → 双审 → 合并 → Vercel 自动构建部署 | **8~15 min**（含构建 ~3min + 审批） | ✅ **需要审计留痕的回滚**（合规场景首选：谁、什么时候、为什么撤销了什么，全在 Git 里）<br>✅ **回滚范围跨多个 commit**<br>✅ **需要 code review 确认的回滚**<br>✅ **① 之后的收敛动作** | ❌ **紧急止血**（8~15 分钟对生产事故太长） | 低。**这是最安全的回滚方式**，但慢 |
| **③ `revalidateTag` 全量失效** | `POST /api/revalidate` 带 `REVALIDATE_SECRET`，tags = 全部 | **< 1 min**（首个请求触发重建，全站 120 页约 10~30s） | ✅ **缓存陈旧**：内容已正确入库，但 CDN/ISR 还在返回旧 HTML<br>✅ **免责版本错配**（缓存层的错配，非数据层）<br>✅ **`revalidateTag` 调用曾失败** 的补救<br>✅ **怀疑 Skew Protection 未生效** | ❌ **数据本身错了**（刷缓存只会把错的数据刷得更快更彻底）<br>❌ **应用代码 bug** | ⚠️ **全量失效 = 回源风暴**：所有请求同时打到函数与 DB。120 页规模下可控（约 120 次 DB 查询 + 索引重建 1 次），**但 2,000 页规模下必须分批**（每批 200 tag，间隔 5s）。⚠️ 索引重建期间可能出现短暂 `INDEX_NOT_READY`（Page 级告警）→ **执行前先在告警系统里静默该告警 10 分钟**，避免自造噪声 |

**④（补充）内容 roll-forward** —— 本项目最常用、也是最重要的回滚方式，不属于上述三类：
`pnpm content:compile --at <上一个 content_release.git_sha> --target production --commit` → version **继续 +1** → 全量 revalidate。**耗时 5~10 min**（含审批），**这是内容错误的唯一正确回滚方式**（详见 §5.2）。

**决策树（贴在值班手册首页）**：

```
出问题了 →
├─ 是「代码/构建产物」问题？
│   ├─ 需要 <2min 止血 → ① Vercel Promote 回滚 → 事后立刻 ② Git revert 收敛
│   └─ 不急 / 需审计 → ② Git revert
├─ 是「内容数据」问题（释义错、免责错、别名冲突、脏数据）？
│   ├─ 单条词条违规 → ④ roll-forward 到前一 sha，或紧急 PR 把该词条 status=archived
│   ├─ 整批内容有问题 → ④ roll-forward（version 继续 +1）
│   └─ 编译脚本 bug 写坏了数据 → §5.3 Neon PITR / 备份分支恢复
├─ 是「缓存」问题（数据对，页面旧）？ → ③ revalidateTag（先静默 INDEX_NOT_READY 告警）
└─ 是「基础设施」问题（Neon 挂 / Vercel 挂）？ → §5.4 降级预案，通常无需回滚（SSG + CDN 让站点仍可读）
```

---

## 4. 监控与告警

### 4.1 监控分层

| 层 | 工具 | 采集什么 | 留存 | 成本 | 局限（必须诚实说明） |
|---|---|---|---|---|---|
| **① 真实用户体验（RUM）** | **Vercel Web Analytics（免 Cookie）+ Speed Insights** | PV/UV（去重，免 Cookie 方案）、LCP/INP/CLS/TTFB 分位数、按路由与地区拆分 | Vercel 侧 30~90 天【待确认】 | ¥0（Pro 内含） | ⚠️ **WAL 北极星的唯一可信来源**（零 Cookie 下服务端算不出 UV，后端 §7.1）。⚠️ 免 Cookie 的 UV 是**基于 TLS/指纹近似的去重**，非精确值，**不能用于财务级口径** |
| **② 应用运行时** | **Vercel Observability + Runtime Logs** | 函数调用量、错误率、p50/p95/p99 持续时间、冷启动次数、按路径拆分的 5xx | ⚠️ **Pro 约 1 小时；Log Drains 属 Enterprise** | ¥0 | 🔴 **这是本项目最大的可观测性短板**。补偿方案见 §4.2 |
| **③ 数据库** | **Neon Console Metrics + Neon API** | CU-hrs 消耗、活跃连接数、存储用量、查询 p95、分支数与分支存储、scale-to-zero 唤醒次数与唤醒耗时 | Neon 侧 30 天 | ¥0 | 无慢查询明细（需自己开 `pg_stat_statements`，Neon 支持） |
| **④ 交付链路** | **GitHub Actions** | 每次构建/发布/校验的结果、耗时、校验报告、编译 diff、发布记录 | **90 天**（artifact + 日志） | ¥0 | 不含运行时数据 |
| **⑤ 外部黑盒探测** | **Better Stack / UptimeRobot 免费层**（多地区，3 个探测点：新加坡 / 法兰克福 / 弗吉尼亚） | `/api/health` 的 `status`/`index.version`/`checksumAligned`、首页 200、SSL 剩余天数、DNS | 30 天 | ¥0 | 探测本身会消耗函数调用额度 → **频率设为 5min（8,640 次/月，占 0.9%）**，不要用 1min |
| **⑥ 业务与内容质量** | **Neon 内自建聚合视图**（`answer_event` / `search_miss_log` / `content_release`） | 无结果率、首次答题正确率、题池缺口、词库缺口 Top-N、发布频次与失败率 | `answer_event` **90 天自动清理**（后端 §7.2，隐私友好） | ¥0 | 需每周人工看一次（无 BI 工具，v1 不值得引入） |
| **⑦ 运维事件长期账本** | **Neon `ops_event` 表**（自建，见 §4.2） | 每次发布、每次冒烟结果、每次告警触发、每次回滚、每次配额越限 | 永久 | ¥0（体量极小） | 需 `ops:event` CLI（约 0.5 人日） |

### 4.2 ⚠️ 补偿 Vercel Pro 日志留存短的三条取证链

**问题**：Vercel Pro 的 Runtime Logs 留存约 1 小时，Log Drains（把日志导到 Datadog/Axiom）属 Enterprise。**这意味着「昨天下午 3 点为什么搜索 p95 飙了」这个问题，在事发 1 小时后无法回答。** 对一个可用性目标 99.9% 的站点，这是不可接受的复盘能力缺口。

**三条零/低成本补偿（全部必须做）**：

| # | 补偿链 | 做法 | 能回答什么问题 | 成本 |
|---|---|---|---|---|
| **①** | **`ops_event` 表（Neon）** | 一张极简表：`id / event_type / status / severity / payload_jsonb / git_sha / run_id / created_at`。**不含任何用户数据**（隐私红线：payload 里禁放 query 原文、IP、UA）。写入点：内容发布、迁移、冒烟结果、自动回滚、配额越限、告警触发、revalidate 调用 | 「上个月发布了几次、失败几次、每次的 checksum 是什么、冒烟哪一项挂的」 | 0.5 人日 + 存储可忽略 |
| **②** | **CI artifact 90 天留存** | 所有 workflow 的 `retention-days: 90`（已在 §2.3 YAML 中配置）：覆盖率报告、内容校验报告、编译 diff、冒烟日志、Lighthouse 结果、视觉 diff、配额报告 | 「3 周前那次发布的编译 diff 具体改了什么」「Lighthouse 分数是什么时候开始掉的」 | ¥0 |
| **③** | **关键指标的定时快照（自采样）** | `deploy-verify.yml` 每 15 分钟跑一次，把 `/api/health` 的完整响应 + 3 个术语页的 TTFB + 搜索接口的 p95（客户端计时）**写入 `ops_event`** → 形成一条自建的 15 分钟粒度时间序列，留存永久 | 「上周三 14:00~15:00 搜索延迟曲线」「索引 version 什么时候变的」「checksumAligned 什么时候开始 false 的」 | ¥0（探测本身计入函数调用，见 §6.2） |

> **可选升级**：Sentry Free（5k errors/月）能提供 30 天错误留存与堆栈。架构 §8.1 标注「可后置」。**运维侧建议：上线后第 2 周就接**，因为「偶发 500」是 Vercel 短日志下最难查的一类问题。⚠️ **接入前提是配好 `beforeSend` 剥离 query 原文、IP、UA、referer** —— 否则 Sentry 会成为隐私红线的破口（它默认会采集这些）。**这一条必须进上线检查单**。

### 4.3 告警事件表（具体阈值 + 级别 + 检测方式 + 处置动作）

> **级别定义**：
> **Page** = 立即叫醒值班人（电话/IM 强提醒），15 分钟内必须响应，**属于 SLO 违约或合规风险**。
> **Warn** = 工作时间处理（IM 消息 + Issue），当日内响应，属于趋势性风险。
> **通知渠道**：Page → ① IM 群 @值班人 ② 短信/电话（Better Stack 免费层支持）③ 邮件；Warn → ① IM 群 ② 自动开 GitHub Issue。

#### A. 应用运行时告警（**直接采用后端 §7.7 的 13 条，不改动阈值**）

| # | 指标 | 目标 | **告警阈值** | **级别** | 检测方式 | **处置动作** |
|---|---|---|---|---|---|---|
| 1 | `/api/search` P95 端到端 | ≤250ms | **> 400ms 持续 5min** | Warn | Vercel Observability 按路径的 duration p95 | ① 查 Neon 是否被 scale-to-zero（唤醒延迟）；② 查是否刚做过全量 revalidate（回源风暴）；③ 查内存索引是否处于 `building`；④ 持续 30min 未恢复 → 升级 Page |
| 2 | `/api/search` P99 | ≤500ms | **> 1000ms 持续 5min** | Warn | 同上 | 同上；额外查是否有超长 query（>100 字符）打进来（AC 扫描成本） |
| 3 | `term_search` 无结果率 | ≤12% | **> 12% 持续 1h** | Warn（内容） | `ops_event` / 自建聚合视图，每小时计算 | **不是运维问题，是内容缺口**：① 导出 `search_gap_pool` Top-20（k≥3）；② 开 Issue 给内容团队排期补词；③ 若突增（1h 内从 8% 跳到 25%）→ 怀疑索引不一致，转 #6 排查 |
| 4 | `/api/search` 5xx 率 | <0.1% | **> 1% 持续 5min** | **Page** | Vercel Observability 错误率 | ① 立即看 Runtime Logs（1h 窗口内）；② `/api/health` 确认是 DB 还是索引；③ 若为代码回归 → **Vercel Promote 回滚（<2min）**；④ 事后 24h 内 Git revert 收敛 |
| 5 | `INDEX_NOT_READY` 发生次数 | 0 | **≥ 1 次** | **Page** | 结构化日志中 `error.code === 'INDEX_NOT_READY'` 计数 | 索引不可用 = **搜索全挂**。① `/api/health` 看 `index.ready`；② 查内存是否超 `INDEX_MAX_MEMORY_MB=50`（超限会拒绝切换新索引）；③ 查 Neon 是否不可达（构建索引需读 DB）；④ **人工触发一次流量**（索引是请求驱动重建，无流量不重建）；⑤ 仍不恢复 → 回滚应用到上一 deployment |
| 6 | `index.checksumAligned = false` 持续时长 | <5min | **> 30min** | **Page** | `/api/health` 每 15min 探测（`deploy-verify.yml`）+ 运行时 ERROR 日志 | **索引与 DB checksum 长期不一致 = 编译流水线断了**（后端已定级 Page）。① 查最近一次 `content-publish` 是否成功；② 查 `content_release.version` 与 `/api/health` 的 `index.version` 差值；③ **手动 `POST /api/revalidate --all-tags`**（先静默 #5 告警 10min）；④ 若 version 落后 → 重跑 `content-publish`（幂等，checksum 相同会短路）；⑤ 若 version 超前 → 索引构建在失败重试循环中，查构建错误日志 |
| 7 | DB 查询 P95 | ≤500ms | **> 800ms 持续 5min** | Warn | 应用侧打点写 `ops_event`（Vercel 日志留存不够）+ Neon 控制台 query 统计 | ① Neon 是否 scale-to-zero 刚唤醒（正常，会自愈）；② 是否 CU 不足（Neon Launch 默认 autoscaling 上限【待确认】）；③ 是否有全量 revalidate 造成的回源风暴；④ 持续 30min → 升级 Page 并考虑临时提升 Neon CU 上限 |
| 8 | `DB_UNAVAILABLE` 发生 | 0 | **≥ 3 次 / 5min** | **Page** | 结构化日志 error.code 计数 | ① Neon status page 确认是否平台故障；② 检查连接串是否失效（Neon role 被轮换/删除）；③ **确认降级已生效**（术语页 SSG 仍可读 = 用户影响有限，这是本架构的底气）；④ 若为连接数耗尽 → 见 #15；⑤ 平台故障 → 挂状态页公告 + 等恢复，**不做无谓回滚** |
| 9 | `RATE_LIMITED` 占比 | <1% | **> 10% 持续 10min** | Warn | Vercel Firewall 分析面板 + 应用 429 计数 | ① 判断是爬虫还是限流配太紧：看 429 的路径分布（`/api/lexicon` 集中 = 爬虫；`/api/search` 均匀 = 真实流量增长）；② 爬虫 → Firewall 加 UA/IP 规则，**不动限流阈值**（动阈值会伤真实防护）；③ 真实流量增长 → 好消息，但要复核 §6.2 撞线模型 |
| 10 | `idempotentReplay=true` 占比 | <1% | **> 3%** | Warn | `answer_event` 聚合 | **客户端重试逻辑有问题**（后端 §7.6）。① 查是否网络超时导致大量重试；② 查前端是否误把 replay 当新作答（后端 R1）；③ 通知前端修复 |
| 11 | `meta.repeated > 0` 出现 | 0 | **每周 ≥ 1 次** | Warn（内容） | `/api/quiz/next` 响应打点 | 题库缺口（关卡出不满 8 题）。① 定位哪个 levelId；② 开 Issue 给内容团队补题；③ **不要靠放宽出题条件掩盖**（会伤 C14 验收） |
| 12 | 首次答题正确率 | 55%~70% | **连续 2 天越界** | Warn（内容） | ⚠️ **只能来自客户端分析**（零 Cookie 下服务端算不出"首次"，后端 §7.6 + §9.3#3） | 题目难度失衡 → 按 agent-content-pipeline §3.2.2 的旋钮表调整；**回退生成规则，不逐题修** |
| 13 | WAL / 目标达成率 | 第 8 周 ≥1500 | **第 4 周 < 60%** | Warn（增长） | Vercel Web Analytics（免 Cookie UV） | 触发产品 §R6 应对（冷启动无流量）。**这是产品告警不是运维告警**，但必须配 |
| 14 | `/api/health` 非 `ok` | — | **连续 3 次探测（15min 间隔 × 3 = 45min，或外部探测器 1min × 3）** | **Page** | Better Stack 外部探测（3 地区）+ `deploy-verify.yml` | ① 区分 `degraded`（DB 不可达 / checksum 不齐，站点仍可读）与 `error`（索引未就绪，搜索挂）；② `degraded` → 按 #6/#8 处置，**不必紧急叫醒**（用户影响轻）；③ `error` → 立即按 #5 处置。⚠️ **建议把 `degraded` 单独设为 Warn、`error` 设为 Page**，避免"狼来了" |

#### B. 运维侧补充告警（后端未覆盖，本文新增）

| # | 指标 | **告警阈值** | **级别** | 检测方式 | **处置动作** |
|---|---|---|---|---|---|
| 15 | **Neon 活跃连接数** | **> 80% 上限持续 5min** → Warn；**> 95% 或出现 `too many connections` 错误 ≥1 次** → **Page** | Warn / Page | Neon Console Metrics + 应用侧捕获连接错误码 | ① **首先确认所有连接都用 `-pooler` 端点**（直连端点是头号原因：每个 serverless 实例各占一条直连，实例数一多立刻耗尽）；② 查是否有未关闭的 CI 分支仍在活跃（`neonctl branches list`）；③ 临时提升 Neon compute size（CU 上限决定 `max_connections`）；④ 长期：确认 `pgBouncer` pool 模式生效 |
| 16 | **Neon scale-to-zero 唤醒对搜索 p95 的影响** | 唤醒后首个查询 **> 1.5s** 且 **每小时唤醒次数 > 12** → Warn | Warn | 应用侧打点（首个查询耗时 + `ops_event` 记录）| 说明流量太稀 or suspend_timeout 太短。① 若为流量稀 → 正常现象，把 `deploy-verify.yml` 的 15min 探测当作天然保活（**这是每 15min 探测的一个额外收益**）；② 若 suspend_timeout < 300s → 调到 300s；③ 若 p95 因此持续超标 → 评估升级到常驻 compute【成本 +$X，需 §6 复核】 |
| 17 | **Neon CU-hrs 月用量** | **> 210（70%）** → Warn；**> 255（85%）** → **Page（预算）**；**> 300（100%）** → **Page** | Warn / Page | `nightly-hygiene.yml` 每日调 Neon API 拉用量 | ① 立即查分支列表（未清理的 `pr-*` 分支是头号嫌疑）；② 查长驻分支 `suspend_timeout` 是否失效；③ 查是否有 CI 在循环重试编译；④ 85% 时即决策：清理 or 临时升档（Neon 支持在线调 plan） |
| 18 | **Neon 存储用量** | **> 7GB（70%）** → Warn；**> 9GB（90%）** → **Page** | Warn / Page | 同上 | 内容库本身 <50MB → **超 7GB 必然是分支/PITR 备份/`answer_event` 堆积**。① 删过期备份分支；② 确认 `answer_event` 90 天清理任务在跑（后端 §7.2）；③ 确认 PITR 保留窗口设置（建议 7 天，不要 30 天） |
| 19 | **Neon 分支数 / 过期分支** | **分支总数 > 10** → Warn；**存在存活 >24h 的 `pr-*` 分支** → Warn（自动删） | Warn | `nightly-hygiene.yml` | 自动清理已在 workflow 内；Warn 的意义是**告诉你清理逻辑本身坏了** |
| 20 | **Vercel 函数调用量** | **> 70 万/月（70%）** → Warn；**> 85 万（85%）** → Warn（预算）；**> 100 万（100%）** → **Page（预算，非可用性）** | Warn / Page | `nightly-hygiene.yml` 调 Vercel Usage API | ① 见 §6.2 撞线模型；② **100% 时不要开 Vercel 的 hard usage limit**（会直接停服 = 可用性事故 > 成本事故，超额单价极低）；③ 优化方向：确认术语页走 SSG 而非 ISR、确认 `/api/health` 探测频率为 5min 而非 1min |
| 21 | **Vercel ISR / Fast Data Fetches** | **> 70 万/月（70%）** → Warn | Warn | 同上 | **架构 §8.1 已给明确优化方向：术语页用 SSG 而非 ISR**（SSG 页面读取不消耗 ISR 额度）。若此项告警 → 说明有页面意外落到了 ISR 路径，查 `revalidate` 配置 |
| 22 | **Vercel Fast Data Transfer（带宽）** | **> 700GB/月（70%）** → Warn；**> 900GB（90%）** → **Page（预算）** | Warn / Page | 同上 | ⚠️ **这是真正会先撞且最贵的一条**（$40/100GB，见 §6.2）。① 查是否有大文件被反复拉（OG 图未缓存？）；② 确认 `/api/lexicon` 有强缓存 + ETag（304 不计带宽）；③ 确认术语页图片为 0 字节（本项目图片预算 ≤60KB 但实际接近 0） |
| 23 | **Vercel 生产部署失败** | **main 分支部署失败 ≥1 次** → **Page**；PR 部署失败 → Warn | Page / Warn | GitHub `deployment_status` 事件 + Vercel Webhook | main 部署失败 = **无法发布任何修复**（含安全补丁），比线上跑旧版本更危险。① 立即查构建日志；② 若为依赖/环境问题 → 本地复现修复；③ 生产此时仍跑上一个 deployment，**用户无影响**，但发布通道被堵 → 优先恢复 |
| 24 | **构建时长** | **> 8min** → Warn；**> 15min（Vercel 默认超时风险）** → **Page** | Warn / Page | Vercel 部署元数据 | ① 120 页目标 ≤3min，超 8min 说明有异常（依赖解析慢 / 查库超时 / 快照未命中回退到查库）；② **接近 2000 页时必须切 ISR 按需生成**（架构 §6.4 已预置） |
| 25 | **`content-publish` workflow 失败** | **≥1 次** → **Page** | **Page** | GitHub Actions 状态 → Webhook | **内容发布链路断了 = 新词搜不到、修复发不出去**。① 区分「校验失败（内容问题，安全）」与「upsert/revalidate 失败（基础设施问题，危险）」；② 后者必须当次处理；③ **若失败且 auto-rollback 也失败 → 最高优先级**（此时线上状态未知，立即查 `content_release.version` 与 `/api/health` 的 `index.version` 是否自洽） |
| 26 | **发布成功但线上 checksum 不匹配** | 发布后 5min 内 `/api/health` 的 `index.version != content_release.version` | **Page** | `verify:post-publish` + `deploy-verify.yml` | 索引热更新卡住。① 人工触发流量（索引请求驱动）；② 全量 revalidate；③ 仍不恢复 → 回滚应用（可能是索引构建代码的 bug） |
| 27 | **⚠️ 免责文案版本错配** | `/api/term/*` 响应中 `disclaimer.version != content_release` 中该 code 的 `version`，**≥1 次** | **🔴 Page（合规事故，优先级高于宕机）** | ① `verify:post-publish --strict-disclaimer`（发布后）；② `deploy-verify.yml` 每 15min 抽 3 个术语页断言；③ `weekly-full-rescan` 抽 20 条 | **这是本项目最高优先级的告警。** ① 立即全量 `revalidateTag(['disclaimer:*','term:*','lexicon'])`（<1min 生效）；② 若仍错配 → **数据层错配，立即 roll-forward 到前一 version**；③ 记录到 `ops_event` 并在 24h 内出复盘（监管口径下"新正文+旧免责"可能构成披露瑕疵）；④ **不要等"确认影响范围"再动手 —— 先恢复一致，再排查** |
| 28 | **SSL 证书剩余天数** | **< 14 天** → Warn；**< 3 天** → **Page** | Warn / Page | `nightly-hygiene.yml` 的 `openssl s_client` | Vercel 自动续期，失败通常是 **DNS 验证问题**（域名 CNAME 被改、Cloudflare 代理模式冲突）。① 查 Vercel Domains 页面的证书状态；② 若用 Cloudflare 做 DNS，确认是 **DNS only（灰云）而非 Proxied（橙云）**，或橙云下 SSL 模式设为 **Full (Strict)**；③ 手工点 "Refresh" |
| 29 | **域名 DNS 解析异常** | 解析结果为空 / 不指向 Vercel（`cname.vercel-dns.com`）→ **Page** | **Page** | `nightly-hygiene.yml` 的 `dig` | 站点整体不可达。① 查域名注册商是否过期（**这是最蠢也最常见的原因**）；② 查 Cloudflare DNS 记录是否被误改；③ 若为注册商过期 → 立即续费（宽限期内可救） |
| 30 | **爬虫/攻击流量突增** | 单 IP > 300 req/min 触发 Firewall 阻断次数 **> 1000/h** → Warn；**全站请求量 > 日均 5 倍** → **Page** | Warn / Page | Vercel Firewall 分析 + Observability 请求量 | ① Warn：确认是搜索引擎还是恶意爬（看 UA 与路径分布）；② Page：可能是被刷（会撞 §6.2 的带宽与函数额度）→ Firewall 临时收紧 + 必要时开 Cloudflare "Under Attack" 模式；③ **不要因为被刷就关掉限流豁免之外的规则**（会伤 SEO） |
| 31 | **依赖漏洞** | `pnpm audit` **high ≥1 且 >7 天未处理** → Warn；**critical ≥1** → **Page** | Warn / Page | `nightly-hygiene.yml` + Dependabot | ① critical：立即评估是否在运行时可达路径上（多数是 dev 依赖，不可达）；② 可达 → 当天升级 + 部署；③ 不可达 → 记录豁免理由到 `ops_event`（**可审计的"不修"决定，比无声忽略好**） |
| 32 | **`answer_event` 90 天清理任务未执行** | 表中存在 `created_at < now() - 90d` 的记录 **≥1 条** → Warn | Warn | `nightly-hygiene.yml` SQL 查询 | ⚠️ **这是隐私合规项不是运维项**：后端 §7.2 明确「90 天后自动清理，不留长期行为记录」。清理失效 = 违反数据最小化承诺。① 检查 Vercel Cron 未使用 → 该任务必须由 GitHub Actions schedule 驱动；② 立即手工执行清理 |
| 33 | **`search_gap_pool` 输入过滤失效** | 池中出现不符合 `^[a-z0-9 .\-]{2,32}$` 或 `^[\u4e00-\u9fff]{2,8}$` 的 `norm_key` **≥1 条** → **Page** | **Page** | `nightly-hygiene.yml` SQL 正则校验 | 🔴 **隐私红线**：后端 §7.5 的过滤是防「用户输入的姓名/手机号片段写进运营可见的表」。出现即意味着过滤逻辑被绕过 → ① 立即清理违规记录；② 排查是过滤未生效还是 k<3 门槛未生效；③ 记入 `ops_event` 并复盘 |

**告警治理（防止告警疲劳，这比多加告警更重要）**：
1. **每月复盘一次告警**：统计每条告警的触发次数与「触发后真的需要人动手」的比例。**误报率 >50% 的告警必须调阈值或降级**，否则值班人会开始忽略 Page。
2. **Page 必须可操作**：每条 Page 告警的消息体里**直接附上处置动作的前 3 步**（本文表格的「处置动作」列就是告警文案的模板）。收到告警还要去翻文档 = 响应时间翻倍。
3. **静默机制**：全量 revalidate、PITR 演练、回滚演练期间，**必须先在告警系统里静默相关规则（#5/#6/#26/#27）并设定自动恢复时间**，否则每次演练都产生一堆假 Page，演练就没人愿意做了。
4. **值班轮换**：3 人团队 → 周轮换，值班表进仓库（`ops/oncall.yaml`），告警按当周值班人路由。**单人团队则所有 Page 都发给本人 + 一位备份联系人**。

### 4.4 隐私合规验证方法（零个人数据采集的机器验证）

**原则：合规红线用 CI 断言，不靠人自觉。** 120 个页面 × 每次发布，人工核对必然漏。

#### 4.4.1 如何确认 Analytics 未启用 Cookie、无第三方脚本

| 验证项 | 方法 | 通过判据 | 执行位置 |
|---|---|---|---|
| **零 `Set-Cookie` 响应头** | Playwright 访问 12 个关键页面 + 6 个 API 端点，收集**所有**响应的 headers | **不存在任何 `Set-Cookie`** | `privacy:runtime`（CI，每次 PR + 每 15min 生产冒烟） |
| **`document.cookie` 为空** | 每个页面加载后执行 `document.cookie` | 返回 `''`（空字符串） | 同上 |
| **零第三方域请求** | Playwright 记录所有 `request` 事件的 URL，提取 host 集合 | host 集合 ⊆ `{本站域名, *.vercel.app, va.vercel-scripts.com（Vercel Analytics 脚本）, *.vercel-insights.com（Analytics 上报）}`。**出现任何其他域 → 失败** | 同上 |
| **Vercel Analytics 上报体不含 PII** | 拦截 `/_vercel/insights/*` 与 `*.vercel-insights.com` 的请求，检查 payload | 不含 `deviceId`、不含原始 query 文本、不含任何自定义 PII 字段；**自定义事件只允许低基数枚举/布尔/数值**（后端 §7.4 白名单） | 同上 |
| **无追踪脚本静态特征** | 对 `.next/static/**` 全量 grep | 不含 `gtag`、`google-analytics`、`googletagmanager`、`fbq`、`facebook.net`、`hotjar`、`clarity`、`mixpanel`、`amplitude`、`segment`、`doubleclick`、`advertising` | `privacy:scan-bundle`（CI） |
| **CSP 阻断能力验证** | Playwright 注入一个指向 `https://evil.example/x.js` 的 script 标签，断言被 CSP 拦截 | 控制台出现 CSP violation，脚本未执行 | `privacy:runtime` |
| **`connect-src 'self'` 生效** | 从页面发起 `fetch('https://evil.example')`，断言被拦 | CSP violation | 同上 |
| **localStorage 白名单** | 枚举 `Object.keys(localStorage)` | ⊆ `{deviceId, fontScale, quizProgress, mistakes, band, comboStreak, ...}`（**前端提供白名单文件**）。⚠️ 关键断言：**`deviceId` 存在但从未出现在任何上行请求中** | 同上 |
| **IndexedDB 白名单** | 枚举 databases | ⊆ `{lexicon, quiz-cache, retry-queue, term-cache}` | 同上 |
| **日志零 query 原文** | ① 源码 grep：`console.*` / logger 调用中不得出现 `req.query.q` / `body.q` / `params.q` 的直接插值；② 生产：抓 Vercel Runtime Logs 1h 窗口，正则搜索是否存在长度 ≥2 的中文串出现在日志行中（术语名白名单除外） | ① grep 零命中；② 抽样 200 行日志，**不含任何用户输入原文** | `privacy:audit-source`（CI）+ 每周人工抽查（因 Vercel 日志留存短，只能抽样） |
| **`x-forwarded-for` 绝不落日志** | 源码 grep：所有出现 `x-forwarded-for` / `x-real-ip` 的文件，**必须只有 `middleware/rate-limit.ts`（或等价路径）** | 命中文件数 == 1 且路径在白名单内 | `privacy:audit-source`（CI，硬拦） |
| **`answer_event` 表无 PII 列** | 查 `information_schema.columns` | 列集合 ⊆ 后端 §7.2 定义的白名单（`client_request_id / question_id / option_id / is_correct / difficulty / mode / level_id / elapsed_ms / content_version / created_at`）。**出现 `ip` / `user_agent` / `device_id` / `referer` / `anonymous_id` → 失败** | `content:verify-db`（CI） |
| **无接收 PII 的端点** | 枚举所有 Route Handler，检查 Zod schema 的字段名 | 不含 `email` / `phone` / `name`（真实姓名语义）/ `idCard` / `location` / `lat` / `lng` / `birthday` / `gender` / `age` | `privacy:audit-source`（CI，硬拦） |
| **数据库无用户表** | 查 `information_schema.tables` | 不存在 `user` / `users` / `account` / `session` / `profile` 表 | `content:verify-db`（CI） |

#### 4.4.2 发布前隐私审计清单（逐条可勾选）

```
【发布前隐私审计 · 必须 12/12 全绿才可上线】

数据采集面
[ ] 1. 全站零 Set-Cookie（12 个页面 + 6 个 API 端点，CI 断言通过）
[ ] 2. document.cookie 在所有页面返回空字符串
[ ] 3. 第三方域请求集合仅含 Vercel Analytics 必需域，无其他任何域
[ ] 4. Vercel Web Analytics 已确认为 Cookie-less 模式（Vercel 控制台截图存档）
[ ] 5. 构建产物 grep 无 gtag/GA/GTM/fbq/hotjar/clarity/mixpanel/segment/doubleclick

存储面
[ ] 6. localStorage 键集合在白名单内；deviceId 仅本地生成、**从未出现在任何上行请求 body/query/header 中**
[ ] 7. IndexedDB 库集合在白名单内
[ ] 8. answer_event 表列集合 == 后端 §7.2 白名单，无 ip/ua/device_id/referer/anonymous_id
[ ] 9. 数据库无 user/account/session/profile 类表
[ ] 10. search_gap_pool 中所有 norm_key 符合输入过滤正则；occurrence_count ≥3 的展示门槛生效

日志与代码面
[ ] 11. x-forwarded-for / x-real-ip 在源码中仅出现于限流中间件 1 个文件；生产日志抽样 200 行无用户输入原文
[ ] 12. 无任何 Route Handler 的 Zod schema 含 email/phone/name/idCard/location/birthday/gender/age

【附加（若启用 Sentry 或其他错误上报）】
[ ] 13. beforeSend 钩子已配置并单测覆盖：剥离 query 原文、IP、UA、referer、cookies
[ ] 14. Sentry 项目的 "Data Scrubbing" 规则已开启，且 IP 采集已关闭（sendDefaultPii: false）
[ ] 15. 若上述任一不满足 → **不启用 Sentry**（可观测性收益 < 合规风险）

【页面可见性】
[ ] 16. 页脚含一行数据说明（架构 §4.5 建议）：说明本站不使用 Cookie、不采集个人信息、学习记录仅存于本地浏览器
[ ] 17. "清空我的学习记录" 按钮可用且真的清空（产品 L7 ★）
```

---

## 5. 回滚与应急预案

### 5.1 值班级别定义与响应时限

| 级别 | 定义 | 响应时限 | 恢复目标 | 决策权 |
|---|---|---|---|---|
| **SEV-1** | 站点整体不可用 / **合规事故（免责错配、违规内容上线）** / 数据被写坏 | 15 min | 1h 内恢复或降级到可读状态 | 值班人可**独立执行任何回滚动作**，事后通报（**不要求先请示** —— 请示时间就是故障时间） |
| **SEV-2** | 核心功能降级但站点可用（搜索挂、答题挂、索引不一致） | 1h | 4h | 值班人 |
| **SEV-3** | 性能退化、非核心功能异常、告警噪声 | 当日 | 3 工作日 | 值班人 |

⚠️ **合规事故的响应纪律（与宕机不同）**：
- 宕机的第一目标是「恢复服务」；**合规事故的第一目标是「停止违规内容的传播」**。
- 因此免责错配 / 违规词条上线的处置顺序是：**① 先下架/回滚（不等根因分析）→ ② 再刷缓存与搜索引擎（提交 URL 移除请求）→ ③ 最后排查根因**。
- **不要为了"先搞清楚原因"而让违规内容多挂 30 分钟。**

### 5.2 故障场景 × 回滚动作对照表（12 场景）

| # | 故障场景 | 检测方式 | **第一动作（止血）** | **完整回滚动作** | 预计耗时 | 验证方式 | 用户影响 |
|---|---|---|---|---|---|---|---|
| **1** | **单条内容错误上线**（释义错、举例误导、被投诉） | 用户/运营反馈；每周回溯扫描 | **紧急 PR：该词条 `status='archived'` → 合并 → `emergency=true` 走发布通道**（跳过窗口，仍需合规 reviewer approve） | 同左；或 `content:compile --at <前一 sha>` 全量 roll-forward | **15~25 min**（含审批） | ① 该 slug 返回 410；② 搜索该词不再命中；③ `sitemap.xml` 不含该 URL；④ **向 Google Search Console 提交 URL 移除请求**（关键：减少收录放大） | 极小（单条） |
| **2** | **整批内容发布出错**（一次 PR 改了 20 条，其中多条有问题） | `verify:post-publish` 自动失败 → **auto-rollback job 已自动执行** | 确认 auto-rollback 成功（看 workflow 输出 + `/api/health` 的 `index.version`） | `pnpm content:compile --at <prev_sha> --target production --commit` → **version 继续 +1** → `content:revalidate --all-tags` | **5~10 min**（自动则 <2min） | ① `content_release.version` 已递增（不是回退）；② `checksum` == prev_sha 的 checksum；③ 抽 5 个词条正文 == 旧 MDX；④ **免责版本一致** | 小（几分钟内新旧混杂） |
| **3** | **索引与 DB checksum 长期不一致**（>30min，Page #6） | `/api/health` 的 `checksumAligned=false` | ① 静默 #5/#26 告警 10min；② `POST /api/revalidate --all-tags`；③ 人工打一次搜索请求（触发索引重建，因为重建是请求驱动的） | 若重建循环失败 → **回滚应用到上一 deployment**（可能是索引构建代码 bug）+ Git revert | **1~5 min**（revalidate）；**<2min**（Vercel Promote） | `/api/health` 返回 `status:ok` 且 `checksumAligned:true` | 小（自洽优先策略下用户看到的是旧版本内容，**不白屏不报错**） |
| **4** | **Neon 数据库不可用**（平台故障 / 连接串失效 / 连接数耗尽） | Page #8；`/api/health` → `degraded` | **通常无需动作** —— 架构的底气在这里：术语页 SSG + CDN 命中时**函数根本不被调用**，搜索走内存索引仍可用 | ① 平台故障 → 挂状态公告，等恢复；② 连接串失效 → 更新 Vercel EV `DATABASE_URL` + redeploy（**注意：这会触发一次全量构建 ~3min**）；③ 连接数耗尽 → 确认 pooler 端点、临时升 CU；④ **数据损坏 → 走场景 8 的 PITR** | **5~30 min** | `/api/health` → `db.reachable:true`；术语页与搜索功能正常 | **轻度**：卡片显示「释义加载中」，答题暂不可判分（客户端离线题库可继续答，进度不丢） |
| **5** | **Vercel 函数异常**（新版本代码引入运行时错误、5xx 率飙升） | Page #4；Vercel Observability | **Vercel 控制台 → Deployments → 上一个成功部署 → Promote to Production** | ① Promote（<2min 止血）；② **24h 内开 `git revert` PR 让 main 与线上收敛**（⚠️ 不做这步 = 下次任何人合并 main 都会把 bug 带回来） | **<2 min** + 后续 8~15min | ① 5xx 率回落 <0.1%；② 冒烟全绿；③ Vercel 显示的 Production deployment ID == 目标 ID | 小（<2min 的 5xx 窗口） |
| **6** | **依赖漏洞 / 安全事件**（critical CVE、密钥泄漏、Git 账号失陷） | Page #31；GitHub Secret Scanning；异常部署记录 | ① 漏洞：判断是否运行时可达 → 可达则立即升级依赖并部署；② **密钥泄漏：立即在 Neon/Vercel 侧吊销并轮换**（先吊销后排查，顺序不能反）；③ 账号失陷：**立即在 Vercel 移除该成员 + 吊销其 token + 检查 Deployment 历史与 EV 变更审计** | ① 漏洞：升级 PR → 走正常发布（**紧急情况可 Owner 直接 push main**，但事后补 PR review 记录）；② 密钥：轮换全部 4 个密钥（`DATABASE_URL` / `DATABASE_URL_WRITE` / `REVALIDATE_SECRET` / `NEON_API_KEY`）+ 重新部署；③ 若怀疑代码被植入后门 → **Promote 到已知干净的 deployment + 全量 `pnpm install --frozen-lockfile` 重建** | **30 min ~ 2h** | ① `pnpm audit` 无 critical；② 旧密钥调用返回 401；③ Vercel 审计日志无异常；④ 全站冒烟通过 | 中（密钥轮换期间可能短暂 401，需协调在低峰执行） |
| **7** | **流量突增打爆配额**（被社区/媒体转发、被刷） | Page #22/#30；Vercel Usage | ① **不要开 hard usage limit**（停服比多花钱严重得多，且超额单价极低）；② Firewall 临时收紧：非 `GET /terms/*` 与 `GET /api/search` 的路径限流减半；③ 若为恶意刷 → 开 Cloudflare "Under Attack"（需 5 分钟 JS 挑战，**会伤 SEO 与真实用户，只在确认是攻击时用**） | ① 带宽撞线 → 检查 `/api/lexicon` 缓存与 ETag（304 不计带宽）、OG 图是否被边缘缓存；② 函数撞线 → 确认术语页是 SSG 而非 ISR；③ Neon CU 撞线 → 临时升档（Neon 在线可调），事后降回 | **10~30 min** | ① 用量增速回落；② p95 未恶化；③ 无 429 泛滥（#9 告警未触发） | 小~中（限流收紧会让部分用户看到重试） |
| **8** | **⚠️ CI 编译脚本 bug 写脏数据**（最严重的数据事故） | `content:verify-db` 失败；线上抽样发现内容与 MDX 不符；`weekly-full-rescan` 的 drift 校验 | ① **立即冻结发布**：不批准任何 `content-publish` 审批（这就是发布窗口审批的价值）；② 判断脏数据范围（`SELECT count(*)` 对比 dry-run 预期） | **两条路径，按范围选：**<br>**A. 脏数据可被覆盖（多数情况）**：`content:compile --at <干净 sha> --target production --commit` → 因为编译是**全量 upsert + 软归档**，重跑一次就把所有字段覆盖回正确值。**这是首选，因为它不需要 PITR，不丢 `answer_event` 与缺口池数据**<br>**B. 结构性损坏（如误删列、外键级联删了关系表）**：走 §5.3 的 Neon 备份分支恢复 → 导出内容表 → 覆盖回 main | A：**10~15 min**<br>B：**30~60 min** | ① `content:verify-db` 全绿；② 抽样 20 条线上正文 == MDX 源；③ `term_relation` 双向对称；④ 每关题池 ≥8；⑤ **免责 4 个 code 版本一致** | 中（脏数据可见时间 = 发现时间，**这是为什么 `db-migrate` 前必须打备份分支**） |
| **9** | **⚠️ 免责文案版本错配**（新正文 + 旧免责 = **合规事故**） | 🔴 Page #27（CI 硬断言 + 每 15min 生产抽样） | **立即全量 `revalidateTag(['disclaimer:*','term:*','lexicon','category:*','level:*'])`** —— <1min 生效，**不要先排查原因** | ① revalidate 后仍错配 → 说明是**数据层**错配 → `content:compile --at <prev_sha>` roll-forward；② 若是 `disclaimer` 表被单独改过（有人绕过管线直接改库）→ 从 `disclaimer-templates.yaml` 重新编译；③ **24h 内出复盘**，并检查 Google Search Console 是否有被收录的错配页面 → 提交 URL 移除 | **<1 min**（revalidate）/ **5~10 min**（roll-forward） | ① 抽 10 个术语页，`disclaimer.version` 全部 == `content_release` 当前值；② 页脚免责文案肉眼核对；③ `verify:post-publish --strict-disclaimer` 全绿 | **合规影响 > 用户影响**（用户看不出差别，但监管口径下是披露瑕疵） |
| **10** | **构建产物损坏 / ChunkLoadError 大面积出现** | 前端错误上报（若接 Sentry）；用户反馈；冒烟 | Vercel Promote 回滚到上一 deployment | ① Promote；② 确认 **Skew Protection 已开启**（这是本场景的根因防治手段）；③ 若为构建缓存污染 → Vercel 控制台 "Clear Build Cache" 后重新部署 | **<2 min** | ① 首页与 3 个术语页加载无 console 错误；② 冒烟全绿 | 小 |
| **11** | **CDN 缓存陈旧**（内容已更新，用户看到旧版） | 用户反馈；抽样校验 drift | `POST /api/revalidate`（精确 tag 优先，避免全量回源风暴） | 精确 tag 失效 → 若无效则全量 → 若仍无效则检查 `REVALIDATE_SECRET` 是否已轮换但 CI 侧未更新 | **<1 min** | `curl -s <url> \| grep '<新内容特征串>'` | 极小（TTL 兜底：术语页 1h、lexicon 5min 会自动收敛） |
| **12** | **`content-publish` 与 `db-migrate` 并发导致状态不一致** | Page #25；`content_release.version` 跳号 | 检查两个 workflow 的 `concurrency` 配置 | ① **确认两个 workflow 的 `concurrency.group` 均为 `prod-db-writes`**（本文 §2.3.2 与 §2.3.3 的 YAML 已统一，实现时不得改名）→ 「迁移」与「内容发布」全局串行；② 若已发生不一致 → 走场景 8 路径 A 全量重编译 | **10 min** | `content_release` 表 version 连续无跳号，每行都有对应 `git_sha` | 小 |

> ✅ **场景 12 已在源头消除**：本文 §2.3.2 `content-publish.yml` 与 §2.3.3 `db-migrate.yml` 的 `concurrency.group` **均已统一为 `prod-db-writes`**（不同组名不会互斥，这是 GitHub Actions 的语义）。**实现时必须原样保留该组名，改名即重新引入此故障模式。** 保留本行是为了让 reviewer 知道这条并发风险被识别过并已被机制消除。

### 5.3 数据恢复（Neon PITR / 分支恢复）

**Neon 的 PITR（Point-In-Time Recovery）机制**：Neon 保留 history（WAL），可创建「过去某个时刻的分支」。这比传统 `pg_dump` 恢复快得多，且**不影响生产库运行**。

**恢复预案（按事故类型选择）**：

| 事故类型 | 恢复方式 | 命令 | 耗时 | **会丢什么** |
|---|---|---|---|---|
| 内容表被写脏（可覆盖） | **不用 PITR**，直接重编译 | `pnpm content:compile --at <干净sha> --target production --commit` | 10~15min | **什么都不丢**（首选方案） |
| 内容表结构性损坏 | **备份分支恢复** | `neonctl branches create restore-<ts> --parent main --timestamp <事故前时刻>` → 从该分支 `pg_dump` 内容相关表 → 覆盖回 main | 30~60min | 事故时刻之后的**合法**内容变更（需重放） |
| 迁移执行错误（DROP 了不该 DROP 的列） | **迁移前备份分支**（`db-migrate.yml` 已自动创建 `backup-pre-migrate-<ts>`） | `neonctl branches create hotfix --parent backup-pre-migrate-<ts>` → 对比 schema → 写反向迁移 → 应用到 main | 30~90min | 迁移之后的写入 |
| 整库误删 / 灾难 | **PITR 到最近的健康时刻** | 同上，`--timestamp` 指定 | 30~90min | PITR 点之后的全部写入 |
| 只丢了 `answer_event` / `search_gap_pool` | **不恢复** | — | — | 这两张表是**可牺牲的观测数据**，不影响产品功能。**绝不为它们做 PITR**（PITR 会连带回退内容表，代价远大于收益） |

**恢复演练安排（必须做，不演练的恢复预案等于没有）**：

| 演练 | 频率 | 内容 | 通过判据 |
|---|---|---|---|
| **PITR 恢复演练** | **每季度 1 次** | 在 staging 上：故意写脏内容表 → 用 `neonctl branches create --timestamp` 恢复 → 校验 | 60min 内完成，数据校验全绿 |
| **内容 roll-forward 演练** | **每月 1 次** | 在 staging 上：`content:compile --at <3 个版本前的 sha>` → 校验 checksum 与抽样内容 | 15min 内完成 |
| **Vercel Promote 回滚演练** | **上线前 1 次 + 每半年 1 次** | 在生产上（低峰）：Promote 到上一 deployment → 冒烟 → Promote 回来 | 单次 <2min，冒烟全绿，**用户无感** |
| **全量 revalidate 演练** | **上线前 1 次** | 生产低峰：先静默 #5/#6/#26/#27 告警 → 全量 revalidate → 观察回源 QPS 与索引重建耗时 | 120 页在 60s 内重建完成，无 `INDEX_NOT_READY` |
| **密钥轮换演练** | **上线前 1 次** | staging 上完整走一遍 4 个密钥的轮换 | 零停机 |
| **紧急下架演练** | **上线前 1 次** | 走一遍 `emergency=true` 的单词条归档流程 | 25min 内该词条线上返回 410 |

**PITR 保留窗口配置**：建议 **7 天**（Neon Launch 支持【待确认具体档位】）。
- 为什么不是 30 天：history 存储按量计费，30 天窗口会持续吃 §1.3 的 10GB 存储预算（告警 #18）。
- 为什么不是 1 天：**周末发生的事故可能周一才发现**，1 天窗口意味着无法恢复。7 天是「覆盖一个完整的发现延迟周期」的最小值。

### 5.4 降级预案：自动 vs 人工

**本项目的降级设计有个显著特点：绝大多数降级是自动的，而且用户几乎无感。** 这来自架构的一个根本判断 —— **术语内容是静态数据，DB 挂了网站还能读**（架构 §4.3）。运维的职责不是"设计降级"，而是**确认降级真的生效了**。

#### 自动触发（无需人工介入，运维只需监控其是否正确工作）

| # | 触发条件 | 降级行为 | 用户感知 | 运维要验证什么 |
|---|---|---|---|---|
| A1 | Neon 不可达 + 术语页请求 | CDN/ISR 缓存命中直接返回，**函数不被调用** | **无感** | 探测术语页仍返回 200 且内容非空 |
| A2 | Neon 不可达 + 搜索请求 | 内存索引照常命中 termId/sense，`card:null` + `degraded.contentUnavailable=true` | 卡片显示「释义加载中」，**不白屏不报错** | `/api/search?q=MACD` 返回 200 且 `matched` 非空 |
| A3 | Neon 不可达 + 出题 | `503 DB_UNAVAILABLE`（**故意不降级**，内容缺口要暴露） → 客户端用 IndexedDB 离线题库 | 「网络异常，使用离线题库」，**可继续闯关不丢进度** | 客户端离线题库确实存在（前端验收 P7） |
| A4 | Neon 不可达 + 判分 | `503`；客户端标记「待校验」，不入错题本 | 轻提示 | 恢复后补交队列生效（幂等键 `clientRequestId`） |
| A5 | Neon 写不可达 + 埋点 | **判分照常返回 200**，仅事件不落库 | **无感** | 恢复后指标出现一个空洞（**这是可接受的，不要去"补数据"**） |
| A6 | AC 自动机构建失败 | 三级降级：跳过整句模式 → 纯 `pg_trgm` → `503 INDEX_NOT_READY` | 搜索变慢但可用 | `INDEX_NOT_READY` 告警 #5 触发（这是 Page 级，说明降到了最后一层） |
| A7 | 索引与 DB checksum 不一致 | **自洽优先**：旧索引 + 旧内容，绝不混用 | 短暂看到旧版本内容 | 告警 #6；**⚠️ 这条降级是合规相关的**：旧内容配旧免责仍是自洽的，所以不构成免责错配 |
| A8 | 限流 429 | 客户端指数退避，**不弹错误弹窗** | **无感** | 告警 #9 的 429 占比 |
| A9 | `hydrate` 部分条目失败 | 该条 `card:null`，其他正常 | 单卡片「释义加载中」 | — |
| A10 | Vercel 函数冷启动 | 索引 `building` 期间**等待（<300ms）而非返回 503** | 首请求略慢 | 冷启动 ≤3s SLO（告警 #1/#2 的 p99） |

#### 需人工介入（值班手册，每条都要有明确的执行命令）

| # | 场景 | 人工动作 | 命令 | 授权 |
|---|---|---|---|---|
| M1 | 自动降级 A6 落到最后一层（`INDEX_NOT_READY`） | 触发流量让索引重建；无效则回滚应用 | `curl $PROD_ORIGIN/api/search?q=test` ×3；仍失败 → Vercel Promote | 值班人独立决策 |
| M2 | 单条违规内容需立即下架 | 紧急归档 | 紧急 PR（`status='archived'`）→ 合规 approve → `workflow_dispatch emergency=true` | **需合规 reviewer approve，不可跳过** |
| M3 | 免责错配 | 全量 revalidate → 无效则 roll-forward | `pnpm content:revalidate --base-url $PROD_ORIGIN --all-tags` | 值班人独立决策（**先动手后排查**） |
| M4 | Neon CU 撞线 | 临时升档 | Neon 控制台 → Plan → 提升 compute size | 值班人 + 事后通报（涉及成本） |
| M5 | 被恶意刷流量 | Firewall 临时收紧 / Cloudflare Under Attack | Vercel Firewall UI；Cloudflare UI | 值班人独立决策（**Under Attack 会伤 SEO，仅在确认攻击时用，且事后必须关闭**） |
| M6 | 密钥泄漏 | 立即吊销 + 轮换 | Neon/Vercel 控制台 | 值班人独立决策（**先吊销后排查**） |
| M7 | 发布链路持续失败 | **冻结发布**（不批准审批）+ 排查 | 不点批准即可 | 值班人独立决策 |
| M8 | 站点整体不可用且原因不明 | Promote 到已知良好 deployment + 挂状态公告 | Vercel UI | 值班人独立决策 |

#### 明确**不做**的降级（防止过度设计）

| 不做的事 | 理由 |
|---|---|
| 静态兜底站（把 120 页导出到独立静态托管做灾备） | Vercel + CDN 的可用性已远超 99.9% SLO 要求；自建灾备 = 多一套部署链路要维护、要同步内容、要测试，**它的故障概率高于它要防的故障** |
| 多区域部署 | Pro 计划不支持；且本项目 DB 是单区 Neon，多区域应用也解决不了 DB 单点 |
| 自动熔断整个搜索功能 | 后端 §5.2 明确：熔断 `hydrate`，**不熔断检索**（检索在 DB 挂时完全可用）。熔错粒度 = 把还能用的功能一起干掉 |
| DB 写失败时不返回判分 | 后端 §5.2 明确：判分只依赖读，埋点是尽力而为，不能拖累用户学习流程 |

### 5.5 故障复盘机制

| 项 | 规定 |
|---|---|
| **触发条件** | 所有 SEV-1、SEV-2；以及**所有自动回滚被触发的情况**（即使影响很小 —— 自动回滚说明发布链路有隐患） |
| **时限** | SEV-1 在 **48h 内**出复盘文档；SEV-2 在 5 工作日内 |
| **模板** | ① 时间线（分钟级，从首次告警到完全恢复）② 影响面（受影响用户数估算、受影响页面/接口、SLO 违约时长）③ **根因（5 Whys，不停在"人为失误"这一层** —— 人为失误是结论不是根因，根因是"为什么系统允许这个失误发生"）④ 检测为什么生效/为什么没生效 ⑤ **行动项（每条必须有 owner + deadline + 可验证的完成标准）** ⑥ 幸运因素（哪些地方运气好才没更糟） |
| **存放** | `ops/postmortems/YYYY-MM-DD-<slug>.md`，**进 Git 仓库**（可检索、可 review、新人可学） |
| **无指责原则** | 复盘针对系统不针对人。**如果结论是"某某不小心"，则复盘没做完** —— 正确的结论是"CI 没有拦住这个不小心" |
| **行动项跟踪** | 每条行动项开一个 GitHub Issue，标签 `postmortem-action`；**每月检查是否有超期未关闭的行动项**（超期的行动项 = 同类事故必然重演） |

---

## 6. 容量与成本

### 6.1 成本明细表（月度 + 年度）

> **口径声明**：基础设施部分**严格采用架构 §8.1 已重算的口径**（¥290~400/月）；内容部分**严格采用架构 §8.2 的口径**（一次性 ¥1.2万~3.5万，月度运营 ¥650~2,700）。本文在此基础上**拆分到计费单元**并补充运维侧新增项（外部探测、Actions 分钟数、超额敏感度）。

#### 6.1.1 基础设施成本明细

| 项目 | 供应商 / 计费单元 | v1 用量假设 | **月成本** | **年成本** | 备注 |
|---|---|---|---|---|---|
| 应用托管 | Vercel **Pro**，$20/席位/月 | 1 席位 | **$20 ≈ ¥144** | **¥1,728** | ⚠️ Hobby 禁商用（合规项非成本项）。**席位数为最大不确定项**：3 人团队若都需 Vercel 账号则 $60/月【待确认】 |
| └ 超额·函数调用 | $0.60 / 百万次 | 预计 ~80 万次/月，**额度内** | ¥0 | ¥0 | 见 §6.2 撞线模型 |
| └ 超额·ISR / Fast Data Fetch | $0.40 / 百万次 | 术语页走 SSG → 预计 ≤20 万次/月，**额度内** | ¥0 | ¥0 | 架构 §8.1 明确建议 SSG 而非 ISR |
| └ 超额·带宽（Fast Data Transfer） | 约 $40 / 100GB（1TB 内含） | 预计 ~90GB/月，**额度内** | ¥0 | ¥0 | ⚠️ **这是最贵的超额项**，DAU≈3.3 万撞线，见 §6.2 |
| └ 超额·边缘请求 | 约 $0.60 / 百万次 | 预计 ~120 万次/月 | ¥0~5 | ¥0~60 | `proxy.ts` 中间件会在每个请求上触发 → **需实测是否计入**【待确认】 |
| 数据库 | Neon **Launch**，$19/月 | 300 CU-hrs + 10GB 存储；实际内容库 <50MB、CU 用量见 §1.3 预算表 | **$19 ≈ ¥137** | **¥1,644** | 选 Launch 而非 Free 是为避开 5 分钟缩容的冷启动（要稳定 TTFB） |
| └ 超额·CU-hrs | 按量【单价待复核】 | 分支滥用时才会超（§1.3 四层防护） | ¥0~70 | ¥0~840 | ⚠️ 未设 `suspend_timeout` 的分支可吃掉 5,400 CU-hr/月 |
| └ 超额·存储 | 按量【单价待复核】 | PITR 7 天窗口 + 分支残留 | ¥0~30 | ¥0~360 | 告警 #18 在 70% 时预警 |
| 词库索引 | 进程内存 | 120 条 ≈ 12KB（2,000 条 ≈ 200KB） | **¥0** | ¥0 | 无需独立服务 |
| 缓存 | CDN + ISR + 内存 | — | **¥0** | ¥0 | v1 无 Redis（架构 ADR-07） |
| 限流 | Vercel Firewall Rate Limit | Pro 套餐内含 | **¥0** | ¥0 | — |
| DNS + 基础防护 | Cloudflare Free | 仅 DNS（**灰云，不代理**，避免与 Vercel CDN 双层缓存冲突） | **¥0** | ¥0 | 若开橙云代理 → 缓存与证书行为复杂化，**不建议** |
| 分析 | Vercel Web Analytics（**免 Cookie**） | Pro 内含额度 | **¥0** | ¥0 | 合规红线：零个人数据采集 |
| RUM 性能 | Vercel Speed Insights | Pro 内含额度 | **¥0** | ¥0 | SLO 验收的唯一可信来源 |
| CI/CD | GitHub Actions | 预计 ~450 min/月（私有仓库 Free 2,000 min / Pro 3,000 min；**公开仓库无限免费**） | **¥0** | ¥0 | 仓库可见性【待确认】；若私有且超量，$0.008/min ≈ ¥2.6/月 |
| 外部黑盒探测 | Better Stack / UptimeRobot **Free** | 3 地区 × 5min 间隔 × 4 个探测目标 | **¥0** | ¥0 | 30 天历史留存；免费层足够 |
| 域名 | `.com` | ¥60~100/年 | **≈¥8**（摊） | **¥60~100** | 可选 `.cn` 约 ¥35/年（但 `.cn` 通常需实名+备案关联） |
| 错误上报 | Sentry | **v1 不启用**（架构标注可后置） | ¥0 | ¥0 | 运维建议上线后第 2 周接 Free 档（$0），**但必须先配 `beforeSend` 剥离 PII**（§4.4.2 #13~15） |
| **基础设施小计** | | | **≈ ¥290 ~ ¥400** | **≈ ¥3,500 ~ ¥4,800** | **与架构 §8.1 口径一致** ✅ |

#### 6.1.2 内容成本（架构 §8.2 口径，本文原样引用）

| 阶段 | 工作项 | **一次性** | **月度（稳态）** | **年度** |
|---|---|---|---|---|
| **v1 上线（120 条 / 145 义项 / ≥360 题）** | 词条撰写 ¥4,800~13,500 + 全检审校 ¥1,920~5,400 + 派生题 ¥960~1,800 + 干扰项挑选 ¥1,280~2,400 + 人工题 T3/T4 ¥880~1,760 + 人工题审校 ¥350~660 + 关系梳理 ¥1,600~4,500 + 法务确认 ¥0~5,000 | **¥12,000 ~ ¥35,000**（约 65~125 人时） | — | — |
| **稳态运营** | 每月新增 15~25 条 + 维护 + 抽检（8~18 人时/月） | — | **¥650 ~ ¥2,700** | **¥7,800 ~ ¥32,400** |
| **v2 扩展（2,000 条）** | 见架构 §8.2 扩展口径 | **累计 ¥180,000 ~ ¥457,000**（约 1,270~2,200 人时） | — | — |

#### 6.1.3 总成本汇总（**用户决策关键输入**）

| 阶段 | 一次性 | 月度 | **首年总投入** | 结构洞察 |
|---|---|---|---|---|
| **v1 上线** | **¥12,000 ~ ¥35,000**（内容） | **¥290 ~ ¥400**（基础设施） | **≈ ¥15,500 ~ ¥39,800** | **基础设施占比 < 3%**。技术不是成本瓶颈 |
| **v1 稳态（第 2~12 月）** | — | **¥940 ~ ¥3,100**（基础设施 + 内容运营） | **≈ ¥11,300 ~ ¥37,200**（11 个月） | 内容运营占 69%~87% |
| **首年合计** | | | **≈ ¥26,800 ~ ¥77,000** | **内容占 87%~93%** |
| **v2（2,000 条 + LLM 兜底 + 行情）** | 内容累计 ¥180,000~457,000；行情数据源询价【待确认】 | ¥400~2,200 + LLM ¥270~5,400（架构 §8.3）+ 行情数据费另计 | — | **行情数据商用授权通常远高于本项目全部基础设施成本** |

**给决策者的三条成本结论**：
1. **不要为省钱降基础设施档位。** ¥290/月 与 ¥400/月 的差别（¥1,320/年）**小于一次内容事故的处理成本**（产品 R1 的"信任修复"）。具体地：把 Neon 从 Launch 降到 Free 省 ¥137/月，代价是 5 分钟缩容的冷启动会**直接击穿搜索 p95 ≤250ms 的 SLO** —— 这是拿验收指标换零花钱。
2. **唯一值得投入的降本方向是内容生产效率工具**（agent-content-pipeline §5.4 已量化：批量导入 + 族模板 + 干扰项推荐可省约 30~40% 撰写工时 ≈ ¥4,000~14,000）。**运维侧的贡献是把 CI 错误信息做好** —— 差的错误信息导致 120 条 × 2.5 轮返工 × 20min = 100 人时 ≈ ¥8,000~15,000 的纯浪费（§2.1.2 已列为硬要求）。
3. **成本风险不在月费，在"超额与失控"**。三个必须设防的点：① Neon 分支未清理（可放大 18 倍 CU 消耗）；② 带宽超额（$40/100GB，是唯一单价贵的项）；③ Vercel 席位数量蔓延（每个席位 $20/月）。**三者都有告警（#17/#19/#22），且都必须在 Vercel/Neon 侧配置预算通知。**

### 6.2 ⚠️ 额度撞线预警（含对架构 §8.1 口径的一处修正）

#### 6.2.1 函数调用额度（100 万次/月）撞线模型

**用量分解（DAU 3,000，人均 8 次查询/天）**：

| 来源 | 计算 | 月调用量 | 占 100 万额度 |
|---|---|---|---|
| `/api/search` | 3,000 × 8 × 30 | **720,000** | 72.0% |
| `/api/quiz/answer` | ~1,500/天 × 30 | 45,000 | 4.5% |
| `/api/quiz/next` | ~600/天 × 30 | 18,000 | 1.8% |
| `/api/search/miss`（未命中上报） | 720,000 × 12%（无结果率） | 86,400 | 8.6% |
| `/api/og/term/*` | ~200/天 × 30（边缘缓存后回源） | 6,000 | 0.6% |
| `/api/health` 外部探测 | 3 地区 × 288 次/天（5min 间隔）× 30 | 25,920 | 2.6% |
| `deploy-verify` 冒烟 | 96 次/天 × ~8 请求 × 30 | 23,040 | 2.3% |
| 其他（分类页回源、lexicon 回源） | 估 | ~10,000 | 1.0% |
| **合计** | | **≈ 934,000** | **≈ 93%** |

> ⚠️ **这个分解比架构 §8.1 的「72 万/月」更完整**：架构只算了搜索本身，**漏了未命中上报、健康探测、CI 冒烟三项（合计约 13.5 万次/月，占 13.5%）**。这三项是**运维自己制造的用量**，可以通过配置消除（见下）。

**撞线时间点推算**：

| DAU | 月函数调用（含运维开销） | 占额度 | 撞线？ |
|---|---|---|---|
| 1,000（上线初期） | ~311,000 | 31% | 否 |
| 2,000 | ~623,000 | 62% | 否 |
| **3,000（产品第 8 周推算）** | **~934,000** | **93%** | ⚠️ **临界** |
| 3,200 | ~996,000 | 100% | **撞线** |
| 5,000（第 8 周上限） | ~1,557,000 | 156% | 超额 56% |
| 10,000 | ~3,113,000 | 311% | 超额 211% |

**→ 结论：按产品「第 8 周日活 3,000~5,000」的推算，函数调用额度会在上线后第 8~10 周撞线。**

**撞线后的真实成本**：
- 超额单价 **$0.60 / 百万次**
- DAU 5,000 → 超额 55.7 万次 → **+$0.33/月 ≈ ¥2.4/月**
- DAU 10,000 → 超额 211 万次 → **+$1.27/月 ≈ ¥9/月**
- DAU 50,000 → 超额 1,457 万次 → **+$8.7/月 ≈ ¥63/月**

> ### 🔴 对架构 §8.1 一处成本口径的修正（**决策关键，请架构师复核**）
>
> 架构 §8.1 写：「函数调用与 ISR 读取两项在第 8 周会逼近 Pro 额度上限，超出部分按 $0.60/百万次（函数）与 $0.40/百万次（ISR）计，约 **+$40~90/月**」。
>
> **这个 +$40~90 与它自己给出的单价不自洽**：按 $0.60/百万次，+$40 需要超额 **6,667 万次/月**，对应 **DAU ≈ 25 万**（是假设日活 3,000 的 83 倍）。按本文的 DAU 5,000 场景，实际超额成本是 **$0.33/月**，差了两个数量级。
>
> **修正后的真实风险排序（按"撞线概率 × 超额单价"）**：
>
> | 排序 | 额度项 | 撞线 DAU | 超额单价 | DAU 5万时的月超额 | 风险等级 |
> |---|---|---|---|---|---|
> | **1** | **带宽（Fast Data Transfer，1TB）** | **≈ 33,000** | **$40 / 100GB** | 术语页 200KB × 5PV/人/天 × 50,000 × 30 = **1.5TB → 超额 500GB → +$200/月 ≈ ¥1,440** | 🔴 **最贵的一条** |
> | 2 | 函数调用（100 万） | ≈ 3,200 | $0.60 / 百万 | 超额 1,457 万 → **+$8.7/月 ≈ ¥63** | 🟡 撞得早但便宜 |
> | 3 | ISR 读取（100 万） | 采用 SSG 后基本不撞 | $0.40 / 百万 | 极低 | 🟢 已被架构的 SSG 建议规避 |
> | 4 | Fluid Compute 用量（CPU/内存） | 需实测 | 【待复核】 | 【待复核】 | 🟡 **不确定项，建议上线首月重点观察** |
>
> **因此运维侧的优化优先级应当调整**：
> 1. **保住架构 §8.1 的 SSG 结论**（术语页 SSG 而非 ISR）—— 这条同时规避 ISR 额度**和**减少函数调用，是唯一的双赢项，**必须验证构建产物真的是静态的**（`next build` 输出中术语页应标记为 `○ (Static)` 而非 `λ` 或 `ISR`）。**这一条进上线检查单。**
> 2. **压缩带宽**：确认 `/api/lexicon` 走强缓存 + ETag（304 不计带宽）、OG 图被边缘缓存、字体子集化（≤40KB）、Brotli 压缩生效。
> 3. **消除运维自造的函数调用**（可省 ~13.5%，等于把撞线 DAU 从 3,200 推到 3,700）：
>    - 外部健康探测频率 **5min 而非 1min**（3 地区 × 1min = 129,600 次/月 → 5min = 25,920 次/月，**省 10.4 万次**）
>    - `deploy-verify` 冒烟 **15min 而非 5min**
>    - `/api/health` 的响应设为 `Cache-Control: no-store`（后端已定）但**探测请求应尽量合并**（一次探测查所有目标，而非 4 次独立请求）
> 4. **不要开 Vercel 的 hard usage limit**（会在撞线时直接停服）。**可用性事故的代价远高于 $8.7/月**。改为：Spend Management 设 monthly budget **$50**，达 70% 邮件告警，达 100% **只告警不停服**。
>
> **【待确认】** 请架构师复核上述修正；并请运维在上线前用 Vercel 官方 pricing 页逐项核对当前单价与额度（Vercel 的计量项名称与单价近一年调整过多次）。

#### 6.2.2 预算告警配置（必须做）

| 平台 | 配置 | 阈值 |
|---|---|---|
| **Vercel** | Settings → Spend Management → 开启 Usage-based 计费可见性 + 设 Monthly Budget | Budget **$50/月**；70% 邮件；100% 邮件 + **不启用 hard stop** |
| **Neon** | Console → Billing → Usage alerts | CU-hrs 70%（210）邮件；存储 70%（7GB）邮件 |
| **GitHub** | Settings → Billing → Actions minutes | 私有仓库下 70%（1,400 min）邮件 |
| **自建** | `nightly-hygiene.yml` 的 `quota-report` job | 每日拉取三方用量 → 写 `ops_event` → 超阈值走 §4.3 告警 #17/#20/#21/#22 |

### 6.3 免费额度能覆盖多少流量

> ⚠️ **本节所有额度数字均需在上线前逐项复核**（供应商政策变动频繁）。

| 场景 | 可支撑规模 | 说明 |
|---|---|---|
| **完全零成本方案**（Vercel Hobby + Neon Free + GitHub Free + Cloudflare Free） | **约 DAU 800~1,200** | 🔴 **但 Vercel Hobby 禁止商用 → 此方案不可用于正式上线**。仅可用于内测/演示 |
| **本文推荐方案**（Vercel Pro + Neon Launch，¥290~400/月） | **DAU 3,000 完全在额度内（93%）；DAU 3,200 开始产生微量超额（<¥10/月）；DAU 50,000 时总成本约 ¥1,800/月（主要是带宽）** | **成本对流量增长的弹性极好**：DAU 涨 16 倍，月成本涨约 5 倍 |
| **Neon Free 档能否替代 Launch** | 技术上可以（10GB→512MB 存储仍够，内容库 <50MB），**但不推荐** | Free 档 **5 分钟无活动即 scale-to-zero**，唤醒 300~500ms → **搜索 p95 ≤250ms 的 SLO 会被冷启动击穿**。省 ¥137/月 换掉一条验收指标，不划算 |
| **GitHub Actions 免费额度** | 公开仓库：**无限免费**；私有仓库：Free 2,000 min/月、Pro 3,000 min/月 | 本文 5 个 workflow 约 450 min/月 → **私有仓库 Free 档也够用（22%）** |
| **Cloudflare Free** | DNS + 基础 DDoS 防护，无限查询 | 建议**只做 DNS（灰云）**，不开代理（橙云），避免与 Vercel CDN 形成双层缓存导致 `revalidateTag` 失效不可控 |
| **Better Stack / UptimeRobot Free** | 50 个监控点、5min 间隔、30 天历史 | 本文需要 4 个探测目标 × 3 地区 = 12 个监控点 → **免费层足够** |

### 6.4 Neon 分支闲置清理策略

**问题**：**分支休眠（scale-to-zero）只是不消耗 CU-hrs，存储仍然计费**（copy-on-write 的基线 + 分支上的所有写入）。30 个 PR/月 若不删分支，3 个月就是 90 个分支 × 5~30MB = 0.45~2.7GB，**加上 PITR history，很容易撞 10GB 上限**（告警 #18）。

**四层清理策略**：

| 层 | 机制 | 触发 | 实现 |
|---|---|---|---|
| **① 即时清理（主）** | workflow 的 `if: always()` 清理步骤删除本次创建的分支 | 每个内容 PR 的 CI 结束时 | `ci.yml` 的 `branch-verify` job 最后一步 `neonctl branches delete` |
| **② 每日兜底扫描** | 删除所有**存活 >24h 且名字匹配 `pr-*`** 的分支 | `nightly-hygiene.yml`，每日 04:00 CST | 见 §2.3.5 `neon-cleanup` job |
| **③ 预算硬门** | 分支总数 >10 → Warn 告警 + 在 Issue 里 @值班人 | 同上 | 同上 |
| **④ 迁移备份分支的定期回收** | `backup-pre-migrate-*` 与 `restore-*` 分支：**保留 30 天后自动删除**（迁移后 30 天没出问题就说明不需要了） | `nightly-hygiene.yml` 扩展规则 | 名字匹配 `backup-pre-migrate-*` 且 `created_at < now()-30d` → 删除 |

**命名规范（清理策略能自动化的前提）**：

| 前缀 | 含义 | TTL | 谁创建 | 谁删除 |
|---|---|---|---|---|
| `main` / `staging` / `dev` | 长驻 | 永久 | 人工一次性 | **绝不自动删**（清理脚本内置 keep 白名单） |
| `pr-<n>-content` | 内容 PR 验证分支 | 24h | `ci.yml` | `ci.yml` 即时 + 每日兜底 |
| `backup-pre-migrate-<ts>` | 迁移前备份 | 30 天 | `db-migrate.yml` | 每日兜底（30 天后） |
| `restore-<ts>` | 事故恢复临时分支 | 7 天 | 人工（值班人） | 每日兜底（7 天后） |
| 其他任何名字 | **不合规** | — | — | **每日兜底扫描发现即 Warn 告警**（不自动删，因为可能是人工正在用的分支） |

**长驻分支的必配项（漏配就是账单事故）**：
```bash
# staging 与 dev 必须设 suspend_timeout，否则常驻 0.25 CU = 180 CU-hr/月（60% 额度）
neonctl branches update staging --suspend-timeout 300   # 5 分钟无连接即休眠
neonctl branches update dev     --suspend-timeout 300
# main（生产）建议也设，但需评估：设了之后首次请求会有 300~500ms 唤醒延迟
# → 本文建议 main 设 suspend-timeout=300，并靠 deploy-verify 的 15min 探测天然保活
neonctl branches update main    --suspend-timeout 300
```
> ⚠️ **`main` 是否设 suspend-timeout 是一个真实的取舍【待确认】**：
> - 设了：省 CU-hrs（约 100~150 CU-hr/月），代价是**低峰期首个请求 +300~500ms**（会体现在 p99 上，但 p95 不受影响，因为 `deploy-verify` 每 15min 探测一次天然保活，suspend 窗口 5min < 探测间隔 15min ⚠️ **这里有问题：15min 探测间隔 > 5min suspend timeout，意味着每次探测都会遇到冷启动**）。
> - **修正建议**：要么把探测间隔改为 **3min**（保证 main 永不休眠，代价是 +7,200 次/月函数调用 ≈ 0.7% 额度），要么把 `suspend-timeout` 设为 **900s（15min）** 与探测间隔对齐。
> - **本文推荐：探测间隔 5min + suspend-timeout 600s** → main 永不休眠（探测间隔 < suspend 窗口），函数调用开销 +15,552 次/月（1.6% 额度），CU-hrs 开销约 0.25 CU × 24h × 30 = 180 CU-hr ⚠️ **这又吃掉了 60% 的 CU 额度**。
> - **最终推荐（三选一，需实测后定）**：
>   **方案 A（省钱）**：main `suspend-timeout=300`，探测间隔 15min → 接受每次探测有冷启动，p99 指标里含冷启动（**但真实用户流量在白天足够密集，实际只有凌晨会冷**）。CU 消耗 ≈ 30 CU-hr/月。
>   **方案 B（保 SLO）**：main 常驻（`suspend-timeout=0`）→ CU 消耗 180 CU-hr/月（60% 额度），**需升级到更高 Neon 档位【+$X】**。
>   **方案 C（折中，✅ 本文推荐）**：main `suspend-timeout=600`，探测间隔 **5min** → 白天永不冷启动（探测保活），CU 消耗约 90~120 CU-hr/月，在 §1.3 的 90 CU-hr 预算内（略超，需把安全余量从 43% 降到 ~35%）。**上线首月实测后按数据调整。**

### 6.5 上线前必须逐项复核的供应商政策清单

| # | 复核项 | 复核方式 | 为什么必须复核 |
|---|---|---|---|
| 1 | Vercel Pro 的**包含额度**（函数调用 / ISR / 带宽 / 边缘请求 / 中间件调用） | vercel.com/pricing | 计量项名称与额度近一年多次调整 |
| 2 | Vercel 各项**超额单价** | 同上 | §6.2 的成本修正依赖此数据 |
| 3 | Vercel Pro 的 **Runtime Logs 留存时长** 与 **Log Drains 是否可用** | Vercel 文档 / 控制台 | 决定 §4.2 三条补偿取证链的必要性 |
| 4 | Vercel **Fluid Compute** 是否影响 `maxDuration` 语义与冷启动行为 | Vercel 文档 + 实测 | 后端设了 `maxDuration=2`，需确认在新计费模型下的行为 |
| 5 | Vercel Pro 的 `regions` 是否支持多值 | vercel.json schema | 本文假设只填 1 个 |
| 6 | Neon Launch 的 **CU-hrs / 存储 / 分支数 / PITR 窗口** 上限与超额单价 | neon.tech/pricing + 控制台 | §1.3 配额预算与 §6.4 清理策略依赖此数据 |
| 7 | Neon 的**可用区域列表**是否含 `aws-southeast-1`（新加坡） | Neon 控制台创建项目时的区域下拉 | §3.2 区域配对方案的可行性前提 |
| 8 | Neon **Vercel Integration 是否仍默认自动创建 preview 分支**，以及关闭入口 | Vercel Integrations 页面 | §1.3 措施 ② 的前提 |
| 9 | GitHub 仓库**可见性**（公开/私有）与 Actions 分钟数额度 | 仓库 Settings | §6.1 成本表与 §6.3 |
| 10 | GitHub **Environment 审批 + Required reviewers** 在当前 plan 是否可用（Free 私有仓库曾有限制） | 仓库 Settings → Environments | §2.1.4 人工审批卡点的可行性前提 |
| 11 | Better Stack / UptimeRobot 免费层的**监控点数量、探测间隔、历史留存** | 官网 | §4.1 层 ⑤ |
| 12 | 域名注册商的**续费宽限期**与自动续费状态 | 注册商控制台 | 告警 #29 的处置前提（域名过期是最蠢也最常见的全站不可用原因） |

---

## 7. 上线检查单（Go-Live Checklist）

> **使用方式**：上线前一天，由值班人 + 一名复核人**逐条勾选并签名**（`ops/go-live-<date>.md` 进 Git 仓库留痕）。
> **标 🔴 的为发布阻塞项：任一未通过则不上线。**
> **标 ⚖️ 的为合规阻塞项：优先级高于所有技术项。**

### 7.1 上线前一天（T-1）

#### A. 计划与账号（⚖️ 合规阻塞）
- [ ] 🔴⚖️ **Vercel 计划确认为 Pro（非 Hobby）** —— 控制台 Settings → Plan 截图存档。**Hobby 禁商用，这是合规检查项不是成本项**
- [ ] 🔴 Vercel Team 成员清单复核：仅必要人员；**Owner ≤2 人**；离职人员已移除
- [ ] 🔴 Neon 计划确认为 Launch（非 Free）；项目区域 == §3.2 选定区域
- [ ] GitHub 仓库 Branch Protection 已按 §2.3 末尾的 12 项配置（**含 "Do not allow bypassing"，且 admin 也不能绕过**）
- [ ] GitHub Environments 已创建：`content-production`（Required reviewers = 值班人组）、`db-production`（Required reviewers = 架构师 + 运维）、`staging`
- [ ] CODEOWNERS 已配置：`/content/` → `@content-finance-reviewers` + `@compliance-reviewers`
- [ ] Vercel Neon Integration 的 **"Create branch for each preview deployment" 已关闭**（§1.3 措施 ②）
- [ ] 值班表 `ops/oncall.yaml` 已建立，上线首周每日有人在线

#### B. 环境变量与密钥
- [ ] 🔴 **Production 环境变量逐项核对**（对照 §1.4.1 清单）：`DATABASE_URL`（**必须是 `-pooler` 端点 + 只读 role**）、`REVALIDATE_SECRET`、`APP_ORIGIN`、`NEXT_PUBLIC_SITE_URL`、`ANALYTICS_ENABLED=true`、`LOG_LEVEL=info`、`INDEX_MAX_MEMORY_MB=50`、`RATE_LIMIT_*`
- [ ] 🔴 **`DATABASE_URL_WRITE` 与 `NEON_API_KEY` 未出现在 Vercel 环境变量中**（只能在 GitHub Secrets，最小权限）
- [ ] 🔴 Staging / Preview 环境变量组已独立配置；**Preview 的 `ANALYTICS_ENABLED=false`**
- [ ] 🔴 所有 `NEXT_PUBLIC_*` 变量确认**不含任何敏感值**（会打进客户端 bundle）
- [ ] `.env.example` 的 key 集合 == 代码中 `process.env.X` 引用集合（`pnpm audit:env-parity` 通过）
- [ ] GitHub Push Protection + Secret Scanning 已开启；`gitleaks` CI job 已通过；自定义规则含 Neon 连接串特征
- [ ] 密钥轮换计划已记录到 `ops/secrets-rotation.md`（含下次轮换日期与责任人）

#### C. 区域与网络
- [ ] 🔴 **`vercel.json` 的 `regions` == `["sin1"]`（或 §3.2 选定值），且 Neon 区域与之同区**
- [ ] 🔴 **实测函数 → DB 延迟**：临时部署一个 `/api/debug/latency` 端点（或用 Neon query log），确认 `SELECT 1` 往返 **< 5ms**
- [ ] 域名已添加到 Vercel 并指向正确（`cname.vercel-dns.com`）；`www` → 裸域 301
- [ ] 🔴 **SSL 证书状态为 Valid**（Vercel Domains 页面），到期日 > 60 天
- [ ] Cloudflare 侧为 **DNS only（灰云）**，未开代理（避免双层缓存）；或若开橙云则 SSL 模式为 **Full (Strict)**
- [ ] 域名注册商**自动续费已开启**，且到期日 > 1 年

#### D. 安全响应头与 CSP
- [ ] 🔴 `curl -I https://<prod>/` 返回头包含：`Content-Security-Policy`（含 nonce + `strict-dynamic`）、`X-Content-Type-Options: nosniff`、`Referrer-Policy: strict-origin-when-cross-origin`、`X-Frame-Options: DENY`、`Permissions-Policy`（含 `interest-cohort=()`、`browsing-topics=()`）、`Strict-Transport-Security`
- [ ] 🔴 **CSP 由 `proxy.ts` 动态生成，未写死在 `vercel.json`**（§3.3 的踩坑提醒）
- [ ] `/api/**` 端点**不下发 CSP**（后端 §6.5：给 JSON 加 CSP 是无意义开销）
- [ ] 安全头用 [securityheaders.com](https://securityheaders.com) 扫描，评级 **A 或以上**，报告截图存档
- [ ] 非 Production 环境（Preview / Staging）确认注入了 `X-Robots-Tag: noindex, nofollow`；`robots.txt` 为全站 `Disallow: /`

#### E. Vercel Firewall 与限流
- [ ] 🔴 Rate Limit 规则已按 §3.1 表格配置 6 条（`rl-search` 60/min、`rl-quiz` 30/min、`rl-global` 300/min、`rl-lexicon` 20/min、`rl-write` 30/min、`waf-bots`）
- [ ] 🔴 **`/api/health` 已在所有 Rate Limit 规则中豁免**（后端 §2.8 明确指出：不豁免 → 探针每次 429 → **假警报淹没真故障**）
- [ ] 🔴 `/_next/static/*`、`/sitemap.xml`、`/robots.txt` 已豁免全站 300/min 规则
- [ ] 🔴 **Googlebot / Bingbot 未被 WAF 阻断**（SEO 命脉，产品 R9）—— 用 Google 的 URL 检查工具或 `curl -A "Googlebot"` 实测
- [ ] 手动测试限流生效：`for i in $(seq 1 70); do curl -s -o /dev/null -w "%{http_code}\n" "$PROD/api/search?q=MACD"; done` → 第 61 次起应返回 429
- [ ] 429 响应体符合契约（`error.code == "RATE_LIMITED"`，含 `retryAfterMs`）

#### F. ⚖️ 免责声明（合规阻塞，优先级最高）
- [ ] 🔴⚖️ **免责声明三处展示确认**：
  - [ ] **术语详情页**：首屏可见「术语解释仅供学习了解，不构成投资建议。」（**不折叠、不需滚动**，产品 L1 ★）
  - [ ] **测验/结果页**：显著位置「题目仅用于检验你对术语的理解，不涉及任何投资建议。」
  - [ ] **全站页脚**：全局兜底免责
- [ ] 🔴⚖️ **首页定位声明三条**（产品 L5）：「不提供行情，不提供投资建议，不替你做决定。」首次访问可见
- [ ] 🔴⚖️ **风险提示内嵌于释义卡片内**（产品 L2 ★，`regulatory_flags=yes` 的词条），**不需滚到底部** —— 抽 10 条 `regulatory_flags=yes` 词条逐一目视确认
- [ ] 🔴⚖️ **「这不代表什么」（`not_meaning`）在每条词条首屏可见** —— 抽 10 条确认（产品 C6 ★）
- [ ] 🔴⚖️ **免责版本一致性**：`curl $PROD/api/term/<slug>` 的 `disclaimer.version` == DB 中 `content_release` 对应的该 `code` 当前 version —— **抽 10 个词条全部一致**（告警 #27 的上线前基线验证）
- [ ] 🔴⚖️ `disclaimer` 表 4 个 code（`GENERAL` / `TERM_CARD` / `QUIZ_RESULT` / `TERM_DETAIL`）均 `is_active=true` 且 `approved_by` 非空（**法务署名留痕**）
- [ ] 🔴⚖️ 免责文案与 `content/lexicon/disclaimer-templates.yaml` **逐字一致**（`pnpm content:compliance --check-disclaimer-drift`）
- [ ] 🔴⚖️ **全站无行情、无标的、无收益承诺**（产品 L3 ★）：`pnpm content:compliance --strict --scope all-published` 零命中
- [ ] 🔴⚖️ 举例中涉及数字的地方**已标注为虚构假设**（架构 §4.6）
- [ ] ⚖️ 免责声明的主体署名口径已由法务确认（架构 §4.6.1：默认不署名，`entity_name` 留空）【产品 Q5 待确认】
- [ ] ⚖️ **法务/合规负责人书面签字确认可以上线**（邮件或 Issue comment 存档）

#### G. ⚖️ 隐私审计（§4.4.2 清单 12/12 全绿）
- [ ] 🔴⚖️ 全站零 `Set-Cookie`（CI `privacy:runtime` 通过 + 生产实测）
- [ ] 🔴⚖️ `document.cookie` 在所有页面返回空
- [ ] 🔴⚖️ 第三方域请求集合仅含 Vercel Analytics 必需域
- [ ] 🔴⚖️ Vercel Web Analytics 确认为 **Cookie-less 模式**（控制台截图存档）
- [ ] 🔴⚖️ 构建产物 grep 无 gtag/GA/GTM/fbq/hotjar/clarity/mixpanel/segment/doubleclick
- [ ] 🔴⚖️ `deviceId` 仅存 localStorage，**从未出现在任何上行请求中**（Playwright 断言）
- [ ] 🔴⚖️ `x-forwarded-for` 在源码中**仅出现于限流中间件 1 个文件**；生产日志抽样 200 行**无用户输入原文**
- [ ] 🔴⚖️ `answer_event` 表列集合 == 后端 §7.2 白名单；数据库无 `user`/`account`/`session` 表
- [ ] 🔴⚖️ `search_gap_pool` 输入过滤生效 + k≥3 展示门槛生效
- [ ] 🔴⚖️ 「清空我的学习记录」按钮可用且真的清空（产品 L7 ★）
- [ ] ⚖️ 页脚含一行数据说明（不使用 Cookie / 不采集个人信息 / 学习记录仅存本地）
- [ ] ⚖️ 若启用 Sentry：`beforeSend` 已剥离 PII + `sendDefaultPii: false`；**否则不启用**

#### H. SEO 与分享
- [ ] 🔴 `robots.txt` 可访问，**放行 `/terms/`**、**屏蔽 `/api/`、`/quiz/`**（避免低价值页稀释权重，架构 §4.2）
- [ ] 🔴 `sitemap.xml` 可访问，URL 数 == 已发布词条数 + 分类页数；按分类分片（每片 ≤1,000 URL）
- [ ] 🔴 **OG 图预览确认**：用 [opengraph.xyz](https://www.opengraph.xyz) 或微信/微博/X 的调试工具，验证首页 + 3 个术语页的分享卡片（1200×630，`/api/og/term/[slug]` 返回 `image/png` 且 200）
- [ ] 每页唯一 `title` 与 `description`（抽 5 个术语页核对格式：「市盈率是什么意思？白话解释 + 例子 - 黑话解释器」）
- [ ] `alternates.canonical` 指向 `/terms/{slug}` 唯一权威地址；旧别名 URL 做 301
- [ ] Schema.org `DefinedTerm` + `BreadcrumbList` 结构化数据通过 [Rich Results Test](https://search.google.com/test/rich-results) 校验，**零错误**
- [ ] **未使用 `FAQPage`**（架构 §4.2：Google 已收缩 FAQ 富媒体展示，不能依赖它做流量）
- [ ] Google Search Console + Bing Webmaster 已验证站点，sitemap 已提交
- [ ] 生产环境 `X-Robots-Tag` **未**含 `noindex`（只有 Preview/Staging 才应该有）

#### I. 内容基线
- [ ] 🔴 内容规模达标：**术语 ≥120 条、义项 ≥145 个、12 个一级分类均有词条、难度分布 L1≥40/L2≥50/L3≥10**（产品 C1 ★，`pnpm content:validate --assert-coverage`）
- [ ] 🔴 题库 **≥360 题**，100% 配 1 句 `answer_basis`，干扰项均来自真实术语（产品 C14 ★）
- [ ] 🔴 **每个关卡题池 ≥8 题**（`meta.repeated == 0`）
- [ ] 🔴 三级审核留痕完整：每条词条有 `reviewer` + `reviewed_at`（产品 C10 ★）
- [ ] 🔴 `content_release.version` 与 `checksum` 已初始化，`/api/health` 返回 `checksumAligned: true`
- [ ] 全量合规扫描零 BLOCK（`pnpm content:compliance --strict --scope all-published`）
- [ ] 零黑话扫描：`plain_explain` 与 `example` 零违规（产品 C4 ★）
- [ ] 内容抽检 20 条已由非团队成员复核（产品 C16：≥4/5 人能正确复述）

#### J. 数据库与备份
- [ ] 🔴 **Neon PITR 已启用，保留窗口 = 7 天**（§5.3）
- [ ] 🔴 **上线前手动创建一个备份分支** `backup-pre-launch-<date>`（保留 90 天，作为"已知良好的初始状态"锚点）
- [ ] 🔴 **PITR 恢复演练已完成一次**（在 staging 上），耗时记录在 `ops/drills/`
- [ ] 所有迁移已在 staging 执行成功，`__drizzle_migrations` 表记录完整
- [ ] 🔴 `main` / `staging` / `dev` 三个长驻分支的 `suspend_timeout` 已按 §6.4 设置
- [ ] `pg_trgm` 扩展已启用且索引已建（`pnpm content:verify-db` 通过）
- [ ] `answer_event` 的 **90 天自动清理任务已配置在 GitHub Actions schedule 中**（不是 Vercel Cron），并已跑通一次（告警 #32 的前提）
- [ ] 生产库连接串使用 **pooler 端点**；写 role 只在 CI Secrets 中

#### K. 监控与告警
- [ ] 🔴 **§4.3 的 33 条告警全部已配置**（14 条运行时 + 19 条运维侧），每条都有具体阈值与级别
- [ ] 🔴 **告警 #27（免责版本错配）已配置且测试触发过一次**（这是最高优先级告警，必须确认通道畅通）
- [ ] 🔴 告警 #6（checksum 不一致 >30min）已配置且测试触发过
- [ ] 🔴 外部黑盒探测已配置：3 地区 × 5min 间隔 × `/api/health` + 首页；**探测频率确认为 5min（不是 1min）**，以控制函数调用额度（§6.2.1）
- [ ] 🔴 Page 级告警通道已验证：**实际触发一次测试告警，确认值班人的手机/IM 收到**（未验证的告警通道 == 没有告警）
- [ ] Vercel Observability / Web Analytics / Speed Insights 均已开启且有数据流入
- [ ] Vercel Spend Management：Monthly Budget = $50，70%/100% 邮件通知已配，**hard usage limit 未开启**
- [ ] Neon Usage Alerts：CU-hrs 70%、存储 70% 已配
- [ ] `ops_event` 表已建，`pnpm ops:event` CLI 已跑通
- [ ] 告警静默流程已文档化（演练时必须先静默 #5/#6/#26/#27）

#### L. 回滚路径演练（🔴 **未演练的回滚路径不算存在**）
- [ ] 🔴 **Vercel 一键回滚（Promote）已在生产演练**：<2min 完成，冒烟全绿，用户无感
- [ ] 🔴 **内容 roll-forward 已演练**（staging）：`content:compile --at <3 版本前 sha>`，15min 内完成，checksum 与抽样内容校验通过
- [ ] 🔴 **全量 `revalidateTag` 已演练**（生产低峰）：120 页在 60s 内重建，无 `INDEX_NOT_READY`
- [ ] 🔴 **紧急下架单条词条已演练**：25min 内该 slug 返回 410，搜索不再命中，sitemap 已移除
- [ ] 🔴 **`content-publish` 的 auto-rollback 已验证**：故意让 `verify:post-publish` 失败一次（staging），确认 `auto-rollback` job 被触发并成功
- [ ] 🔴 **密钥轮换已演练**（staging）：4 个密钥完整轮换一遍，零停机
- [ ] `git revert` → 部署链路已走通一次
- [ ] §5.2 的 12 场景对照表已打印/置顶在值班频道；§3.4 决策树已贴在值班手册首页
- [ ] 故障复盘模板已放入 `ops/postmortems/TEMPLATE.md`

#### M. 性能与 SLO 基线
- [ ] 🔴 **Lighthouse CI（mobile, 4G throttle）**：首页/术语页/搜索页 LCP ≤1800ms、CLS ≤0.1、INP ≤200ms、a11y ≥95
- [ ] 🔴 **构建产物中术语页确认为 `○ (Static)` 而非 `λ`/`ISR`**（§6.2 的双赢优化项，直接决定 ISR 额度是否撞线）
- [ ] 🔴 性能预算全绿：JS ≤90KB / HTML ≤30KB / CSS ≤12KB / 字体 ≤40KB / 图片 ≤60KB（gzip）
- [ ] `next build` 时长 ≤3min；SSG 页数 == 已发布词条数
- [ ] 🔴 **搜索 API 端到端 p95 实测 ≤250ms**（k6 或 `autocannon`，50 并发 × 3min，**从目标用户地区打**，不是从 CI runner 打）
- [ ] 🔴 **索引预热 ≤30s、内存索引 ≤50MB** 实测通过（`/api/health` 的 `uptimeSeconds` + 函数内存指标）
- [ ] 🔴 **冷启动 ≤3s** 实测（让函数空闲 10min 后打第一个请求）
- [ ] 术语页 TTFB（CDN 命中）≤100ms 实测（`curl -w '%{time_starttransfer}'`，从 3 个地区）
- [ ] Speed Insights 已收集 ≥24h 的 RUM 数据作为 SLO 基线存档

#### N. Analytics 埋点校验
- [ ] 🔴 Vercel Web Analytics 面板能看到 PV/UV 数据流入
- [ ] 🔴 自定义事件已验证：`level_complete`、`wrongbook_retry`（**这两条必须客户端埋点**，服务端做不到，后端 §7.3）
- [ ] 🔴 事件属性符合白名单：**只有枚举/布尔/数值，无原始 query 文本、无任何用户标识**
- [ ] 🔴 WAL 的计算口径已在 Analytics 侧建好（周内 `quiz_answer_submit ≥1` 的去重用户），并跑通一次
- [ ] Speed Insights 的 LCP/INP/CLS 按路由可见
- [ ] Preview/Staging 环境确认**未上报** Analytics（`ANALYTICS_ENABLED=false`）

### 7.2 上线中（T0）

- [ ] 选择**工作日 11:00** 上线（避开凌晨、周五、节假日；保证出问题时全员在线）
- [ ] 🔴 上线前最后一次全量冒烟：`pnpm verify:production --base-url $PROD_ORIGIN` 全绿
- [ ] 🔴 `/api/health` 返回 `status: "ok"`（不是 `degraded`），且 `index.ready: true`、`checksumAligned: true`、`db.reachable: true`
- [ ] 生产部署完成，Vercel Deployment ID 记录到 `ops/go-live-<date>.md`（**这是回滚的目标 ID**）
- [ ] DNS 切换到生产域名（若之前指向别处）；确认 HTTPS 证书立即生效
- [ ] 🔴 切换后 5 分钟内：首页 200、随机 5 个术语页 200 且含免责文案、`/api/search?q=MACD` 命中、`/api/quiz/next` 返回 8 题
- [ ] 向 Google Search Console 提交 sitemap；请求首页与 3 个核心术语页的即时收录
- [ ] 🔴 **上线后 30 分钟内值班人不得离开屏幕**，持续观察：Vercel Observability 的 5xx 率与 p95、告警频道、Analytics 数据流入
- [ ] 上线后 1 小时：复核一次 §4.3 的 14 条运行时告警是否有任何触发
- [ ] 上线后 24 小时：出首份运营日报（PV/UV、无结果率、搜索成功率、p95、函数调用量占额度百分比）

### 7.3 上线后（T+1 ~ T+30）

- [ ] T+1：复核首日全部告警，误报的规则立即调阈值（§4.3 告警治理）
- [ ] T+3：第一次内容发布走完整流程（小批量 5~10 条），验证发布链路在真实运营节奏下的表现
- [ ] T+7：第一周复盘 —— SLO 达成情况、成本实际值 vs §6.1 预算、告警触发统计、内容缺口 Top-20
- [ ] 🔴 T+7：**复核 §6.5 的 12 项供应商政策**，用真实账单数据校正 §6.1 成本表与 §6.2 撞线模型
- [ ] T+14：Neon CU-hrs 与存储的实际消耗 vs §1.3 预算表；调整 `suspend_timeout` 与探测频率
- [ ] T+14：接入 Sentry Free（若决定接），**先配好 `beforeSend` 再开**
- [ ] T+30：**第一次月度回滚演练**（内容 roll-forward）；第一次月度告警复盘
- [ ] T+30：产品 §7.6 要求的上线后第 2 周全量抽查（20%）与第 6 周抽查（20%）由内容团队执行，运维提供 `verify:content-drift` 工具支持
- [ ] 每季度：PITR 恢复演练；Layer B 黑话词典全量复核（agent-content-pipeline §4.1）；`banned-word-exemptions.yaml` 中连续两季未使用的豁免归档

---

## 8. 【待确认】清单

> 按「阻塞上线」优先级排序。**标 🔴 的必须在上线前有明确答复。**

| # | 待确认项 | 影响 | 建议确认方 | 本文的默认假设 |
|---|---|---|---|---|
| 🔴 **1** | **`next build` 能否完全不查 DB**（消费 CI 产出的 `content-snapshot.json`）？需要后端在 `packages/db` 的读取层加一个 snapshot-first 分支 | §1.3 措施 ①（Preview 不连 Neon）的可行性前提。**若做不到，则 Preview 构建会消耗 CU-hrs，§1.3 的配额预算需重算，且必须为 Preview 单独建一条 Neon 分支** | 后端 + 架构 | 假设可以（编译产物本身就是纯 JSON，`generateStaticParams` 只需 slug 列表） |
| 🔴 **2** | **ICP 备案与金融类内容资质**：目标用户是否在中国大陆？是否需要备案？在中国大陆提供「金融术语解释」类内容是否需要特定资质？ | **直接决定 §3.2 的区域选择与能否上线**。若需备案 → 必须部署在境内（Vercel 不支持）→ **整个部署方案需要重做** | 法务 + 运营 | 假设**无需备案**（纯工具类内容、无行情、无交易、无账号），部署在新加坡 |
| 🔴 **3** | **`content-publish.yml` 与 `db-migrate.yml` 的 concurrency group 必须统一为 `prod-db-writes`**（两者组名不同则无法互斥 → schema 迁移与内容编译可能并发写库导致状态不一致，见 §5.2 场景 12） | 生产库数据一致性 | 运维（**本文 §2.3 的 YAML 已统一，实现时保留组名即可，无需讨论**） | 已在 §2.3.2 / §2.3.3 中统一为 `prod-db-writes` |
| 🔴 **4** | **架构 §8.1 的成本口径修正**：「超额 +$40~90/月」与「$0.60/百万次」不自洽（详见 §6.2.1 的修正框）。请复核并确认「真实成本风险是带宽而非函数调用」这一结论 | **用户决策的关键输入**。若按原口径，会误把优化重点放在函数调用上，而忽略真正会烧钱的带宽 | 架构师 | 已按修正口径重排优化优先级（§6.2.1） |
| 🔴 **5** | **Vercel Pro 的 Runtime Logs 留存时长与 Log Drains 可用性** | 决定 §4.2 三条补偿取证链的必要性。若 Pro 已支持 Log Drains → 可省掉 `ops_event` 自建时间序列（约 0.5 人日） | 运维（查 Vercel 文档/控制台） | 假设**留存约 1h、Log Drains 属 Enterprise** → 三条补偿链全部必须做 |
| 🔴 **6** | **`main` 分支的 `suspend_timeout` 与探测频率的最终组合**（§6.4 给了 A/B/C 三方案，本文推荐 C） | 搜索 p95 SLO vs Neon CU-hrs 成本（相差约 150 CU-hr/月 = 50% 额度） | 运维 + 架构（**上线首月实测后定**） | 方案 C：`suspend-timeout=600` + 探测间隔 5min |
| 🔴 **7** | **`/api/health` 在 Vercel Firewall 的豁免**（后端 §9.3#4 已列为待确认） | 不豁免 → 探针每次 429 → **假警报淹没真故障**，告警 #14 完全失效 | 运维（上线检查单 §7.1-E 已列） | 假设可以按路径豁免 |
| 8 | **团队规模与 Vercel 席位数**（架构假设 3 人；若 3 人都需 Vercel 账号则 $60/月而非 $20） | §6.1 成本表（差额 ¥2,880/年） | 产品 / 运营 | 1 席位 + 通过 GitHub 协作（**推荐**：内容作者不需要 Vercel 账号） |
| 9 | **GitHub 仓库可见性**（公开/私有）与 PR 频率（本文假设 30~50/月） | Actions 分钟数成本；公开仓库还能获得**无限免费 Actions** | 运维 + 产品 | 私有仓库 Free 档（2,000 min/月），实际用量约 450 min/月 |
| 10 | **上线时间**（本文所有「第 N 周」均指上线后第 N 周） | §6.2 撞线时间点、告警 #13（WAL 第 4 周）、产品 §7.6 的巡检节奏 | 产品 | 未定 |
| 11 | **Neon Launch 的 CU-hrs / 存储超额单价、分支数上限、PITR 窗口档位** | §1.3 配额预算、§6.1 成本表、§6.4 清理策略 | 运维（查 Neon 定价页） | 按架构 §8.1 的 $19/月 = 300 CU-hrs + 10GB |
| 12 | **Neon 是否提供 `aws-southeast-1`（新加坡）区域** | §3.2 区域配对方案 A 的可行性 | 运维（Neon 控制台创建项目时查看区域列表） | 假设提供；若不提供则改用方案 C（东京 `hnd1` + `aws-ap-northeast-1`） |
| 13 | **Vercel Fluid Compute 对 `maxDuration` 语义与冷启动的影响**（后端设了 `maxDuration=2`） | SLO「冷启动 ≤3s」；后端超时策略的正确性 | 后端 + 运维（实测） | 假设兼容 |
| 14 | **`unstable_cache` + `cacheLife` profile 在 Next 16 的具体配置值**（后端 §9.3#6） | 缓存 TTL 与 revalidate 行为 → 影响 §5.2 场景 11 的「TTL 兜底」承诺（术语页 1h、lexicon 5min） | 前端 + 架构 | 采用后端文档中给出的 TTL 值 |
| 15 | **免责文案的最终法务版本与主体署名口径**（架构附录 B #7、产品 Q5） | §7.1-F 的合规阻塞项无法闭环 → **不能上线** | 法务 | 默认不署名主体，`entity_name` 留空 |
| 16 | **是否启用 Sentry**（架构标注「免费版可后置」，运维建议 T+14 接） | 错误留存能力（Vercel 短日志的补偿）vs 隐私红线风险（需 `beforeSend` 剥离 PII） | 运维 + 架构 | v1 不启用，T+14 评估 |
| 17 | **Vercel OIDC Federation 在当前计划是否可用**（替代长期 `VERCEL_TOKEN`） | 消除交付链路中权限最大的一个长期密钥 | 运维 | 若不可用则退化为长期 token + 90 天轮换 |
| 18 | **`answer_event` 90 天保留期**是否满足「首次正确率」分析的样本需求（后端 §9.3#9） | 告警 #12 的可计算性 | 产品 + 数据 | 90 天（隐私友好的默认值） |
| 19 | **`search_miss_log` / `search_gap_pool` 的 k≥3 门槛**是否会在低流量期导致缺口池几乎为空（DAU 1,000 时，一个未命中词要 3 个人搜过才可见） | 内容补词的排期依据（告警 #3） | 产品 + 内容 | k=3（后端已定，隐私优先于运营便利） |
| 20 | **是否需要「运维可访问的用户支持通道」**：MVP 排除了站内反馈入口（产品 5.3 W4），纠错靠社群/邮箱线下收集 → **运维无法从系统内感知内容错误**，只能靠每周回溯扫描 | 内容错误的发现时延（可能长达 1 周） | 产品 + 运营 | 接受该时延，靠 `weekly-full-rescan` + 外部渠道 |
| 🔴 **21** | ⚠️ **CLI 脚本必须向 `$GITHUB_OUTPUT` 写入约定字段**：`content:compile --dry-run` → `checksum_changed=true/false`；`content:compile --commit` → `new_version=<n>`、`checksum=<hex>`；`verify:post-publish` → `result=pass/fail`；`content:compile --target snapshot` → `checksum=<hex>` | **这是 §2.3.2 全部 `if:` 条件与 `auto-rollback` 触发逻辑的前提。若未实现，`if: steps.precheck.outputs.checksum_changed == 'true'` 恒为假 → 生产发布步骤被静默跳过 → 内容永远发不出去，且 workflow 显示"成功"（最危险的失败形态：绿色但没生效）** | 运维 + 后端（CLI 实现方） | 已在 §2.3「YAML 的实现约定」表中列为必须落地项；**上线检查单 §7.1-L 的「auto-rollback 已验证」演练会同时验证此项** |
| 22 | **`pnpm ops:event` / `ops:quota-report` / `ops:quota-alert` / `verify:*` / `privacy:*` / `audit:*` 等运维 CLI 尚未存在**，需按本文规格实现（估算 3~5 人日） | §4.2 三条取证链、§6.2 额度预警、§4.4 隐私机器验证的落地前提 | 运维 + 后端 | 优先级：`verify:post-publish`（含免责硬断言）> `privacy:runtime` > `ops:event` > `ops:quota-*` > `verify:content-drift` |

---

## 附录 A · 值班手册速查卡（建议打印贴在值班位）

```
【一分钟判断】
站点挂了？        → curl $PROD/api/health
                    status=ok        → 不是后端问题，查 CDN/DNS/证书
                    status=degraded  → DB 或索引不一致，用户仍能读（SSG），不慌
                    status=error     → 索引未就绪，搜索挂了，SEV-1
                    连不上           → Vercel 或 DNS 问题，SEV-1

【三个最常用的命令】
① 全量刷缓存（先静默 INDEX_NOT_READY / checksum 告警 10min）
   pnpm content:revalidate --base-url $PROD_ORIGIN --all-tags

② 内容回滚到上一个版本（version 继续 +1，绝不回退数字）
   pnpm content:compile --at <prev_sha> --target production --commit
   然后 ①

③ 紧急下架单条词条
   改 MDX status → archived → PR（合规 approve）→ workflow_dispatch emergency=true

【应用回滚】
Vercel 控制台 → Deployments → 上一个成功部署 → Promote to Production（<2min）
⚠️ 回滚后 24h 内必须开 git revert PR，否则下次合并 main 会把 bug 带回来

【绝对不能做的事】
✗ 不要开 Vercel hard usage limit（停服比超额贵得多）
✗ 不要为了省 CU-hrs 把 Neon 降到 Free（冷启动会击穿 p95 SLO）
✗ 不要在 vercel.json 里写 CSP（nonce 需要动态生成）
✗ 不要直接改生产库（一切内容变更走 Git → CI → 发布窗口）
✗ 不要在免责错配时"先查清原因再动手"（先恢复一致，再排查）
✗ 不要因为被爬虫刷就收紧 WAF 到挡住 Googlebot（SEO 是命脉）
✗ 不要跳过演练（未演练的回滚路径不算存在）

【合规事故 vs 宕机的优先级】
宕机      → 目标：恢复服务      → 可以先排查再动手
合规事故  → 目标：停止传播      → 先下架/回滚，后排查
```

## 附录 B · 本文与上游文档的对应关系

| 本文章节 | 上游依据 | 是否偏离 |
|---|---|---|
| §1.1 环境分层 | 架构 §2.8（Vercel）、§2.6（Neon branching） | 否；**新增**「不做独立测试环境」的判断 |
| §1.2 Neon 分支策略 | 架构 §2.6「branching 一等公民」、产品 §7.6 三级审核 | 否；**具体化**为可执行流程 |
| §1.3 Preview 配额防爆 | — | **本文新增**（上游文档未覆盖，属实际痛点） |
| §2.1 内容发布流水线 | 架构 §3.4.1、agent-content-pipeline §0.3/§4.5、后端 §4.2 | 否；**新增**发布窗口审批、staging 预演、auto-rollback、乐观锁 |
| §2.1.2 校验清单 | agent-content-pipeline §4.1~4.6、产品 §9.2/§9.5 | 否（规则 ID 与级别原样引用） |
| §2.1.5 发布顺序 | 架构 §4.6「免责版本一致性」、后端 §6.7 | 否；**新增** Expand/Contract 与「禁混改 PR」的 CI 强制 |
| §3.1 Vercel 配置 | 架构 §2.8/§4.5、后端 §2.8/§6.5 | 否；**新增** Skew Protection、Firewall 豁免清单 |
| §3.2 区域配对 | 架构附录 B #8/#9 | **本文新增**（上游仅列为待确认） |
| §3.4 回滚三方案 | — | **本文新增**；含 Vercel Promote 的经典陷阱说明 |
| §4.3-A 运行时告警 | **后端 §7.7 的 13 条，阈值原样采用** | 否 |
| §4.3-B 运维告警 | — | **本文新增** 19 条（Neon/Vercel 额度/构建/证书/DNS/合规/隐私） |
| §4.4 隐私验证 | 架构 §4.1.2/§4.5、后端 §7.1/§7.2/§7.4/§7.5、产品 L6 | 否；**具体化**为 13 项 CI 断言 + 17 项检查单 |
| §5.2 场景对照表 | 后端 §5.1 降级矩阵、架构 §4.3 | 否；**转换为运维动作视角**，新增 4 个上游未覆盖场景 |
| §5.3 PITR | 架构 §6.5「生产库开启时间点恢复」 | 否；**具体化**为 5 类事故的恢复路径 + 6 项演练 |
| §6.1 成本明细 | **架构 §8.1/§8.2/§8.4，口径原样采用** | 否；**拆分到计费单元**并补充运维新增项 |
| §6.2 撞线模型 | 架构 §8.1「成本敏感度」 | ⚠️ **修正了超额成本的量级**（见 §8 待确认 #4） |
| §6.4 分支清理 | — | **本文新增** |
| §7 上线检查单 | 产品 §9.1~9.5 全部 ★ 项、架构 §4.5/§4.6、后端 §6/§9.3 | 否；**整合为可勾选形式** |

---

**文档结束。**

本文覆盖：环境规划与 Neon 分支策略、Preview 配额防爆、环境变量与密钥管理、内容发布流水线（含每步命令/失败处理/回滚点、CI 校验清单、幂等设计、双道人工审批、发布顺序）、应用发布流水线、5 个 GitHub Actions workflow 的完整 YAML、Vercel/Neon 部署配置与区域配对、回滚三方案对比与决策树、33 条告警（含具体阈值/级别/检测方式/处置动作）、隐私合规的机器验证方法、12 个故障场景的回滚对照表、PITR 与演练安排、成本明细与额度撞线模型、上线检查单、20 项待确认。

本文不覆盖（其他成员职责）：前端页面设计、API 业务逻辑实现、数据库 DDL、内容撰写规范本身。

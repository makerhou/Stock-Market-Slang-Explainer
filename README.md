# 股票黑话解释器 (stock-jargon-explainer)

面向金融小白（社会人士 / 职场人 / 学生）的股票术语白话解释 + 测验 Web 工具。
MVP 聚焦：**词条查询（白话解释 + 举例 + 风险提示）+ 小测验/闯关 + 错题本**；不接行情、零账号、零 Cookie、零 PII。

## 技术栈（M0 冻结）
- **Next.js 16**（App Router）+ React 19 + TypeScript
- **Tailwind CSS v4** + shadcn/ui + Radix
- **Neon Serverless Postgres** + **Drizzle ORM** + Zod
- 检索：**应用层内存词典 + Aho-Corasick 自动机**（`@glossary/matcher` 同构包），Postgres 仅作权威存储，不引搜索引擎
- 部署：**Vercel Pro**（海外区域）；CI：**GitHub Actions**

## 仓库结构（Monorepo / npm workspaces）
```
apps/
  web/                 # Next.js 应用（前端 + 路由 + 页面）
packages/
  contracts/           # 共享 TS 类型 + Zod schema（前后端契约）
  db/                  # Drizzle schema + 迁移 + Neon 客户端
  matcher/             # 同构匹配引擎（归一化 + 五级降级 + AC 自动机）
  content/             # MDX 内容 schema / Zod 校验 / 编译管线
  quiz/                # 自动出题生成器（纯函数）
  ui/                  # 设计 Token + 基础组件
content-rules/         # 内容管线配置（5 个 YAML，详见各文档）
```

## 脚本
```bash
npm install
npm run dev           # 启动 apps/web 开发服务器
npm run build
npm run lint
npm run typecheck
npm run db:generate   # drizzle-kit 生成迁移
npm run db:migrate    # 执行迁移（需 DATABASE_URL）
```

## 文档
需求 / 架构 / 设计 / 数据 / 内容 / 部署 / 测试 / 交付方案等 9 份设计文档均位于仓库根目录（见 `项目交付方案.md` 的交付清单）。

> 本工具仅用于理解金融术语，不构成投资建议。

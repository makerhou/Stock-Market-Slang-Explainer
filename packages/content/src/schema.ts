import { z } from "zod";

export const categoryL1Values = [
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
] as const;

// 两层分类的合法组合真源（与 data-model §2 / category_l1·l2 枚举一致）
export const categoryL2ByL1: Record<
  (typeof categoryL1Values)[number],
  string[]
> = {
  宏观经济: ["增长与产出", "物价水平", "货币与信用", "就业与收入", "汇率与国际"],
  宏观政策: ["央行与货币政策", "财政政策", "利率与政策工具", "监管与市场制度"],
  技术指标: ["均线类", "摆动指标", "量能指标", "波动率指标", "交叉与信号"],
  估值财务: ["估值倍数", "盈利能力", "现金流", "杠杆水平", "增长与口径"],
  基金产品: ["基金类型", "指数与市场", "规模与净值", "跨市场工具"],
  交易风险: ["收益与亏损", "回撤与风险度量", "交易机制", "发行与上市", "报价与成本"],
  市场情绪: ["多空立场", "群体心理", "风险偏好"],
  走势形态: ["趋势与反转", "盘整与区间", "突破与关键位", "极端走势"],
  买卖操作: ["方向与持仓", "进出场动作", "仓位管理", "持有者行为"],
  财报公司: ["财报发布与预期", "收入与利润", "公司质地", "股东回报"],
  机构与资金: ["机构类型", "资金与流动性", "杠杆与保证金", "市场结构事件"],
  常见误用: ["信号误读", "估值误读", "指标误读", "主体误读"],
};

// 词条 front-matter（CI 硬门校验的第一道关卡）
export const termFrontMatterObject = z
  .object({
    slug: z
      .string()
      .regex(/^[a-z0-9-]+$/, "slug 需 URL 安全（小写字母数字与连字符）"),
    headword: z.string().min(1),
    category_l1: z.enum(categoryL1Values),
    category_l2: z.string().min(1),
    difficulty: z.enum(["L1", "L2", "L3"]),
    plain_explain: z.string().max(40, "人话层 ≤40 字（C3）"),
    example: z.string().optional(),
    not_meaning: z.string().optional(),
    regulatory_flags: z.enum(["yes", "no"]).default("no"),
    risk_note: z.string().optional(),
    // 三级审核留痕（C10：必须经二级专业复核 + 三级合规终审）
    author: z.string().min(1, "需署名作者"),
    reviewer: z.string().min(1, "需二级专业复核人"),
    review_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "复核日期 YYYY-MM-DD"),
    compliance_approved: z.boolean().default(false),
  });

function refineTermFrontMatter(
  val: z.infer<typeof termFrontMatterObject>,
  ctx: z.RefinementCtx,
) {
    // 分类合法性：category_l2 必须属于 category_l1
    const allowed = categoryL2ByL1[val.category_l1];
    if (allowed && !allowed.includes(val.category_l2)) {
      ctx.addIssue({
        code: "custom",
        message: `category_l2「${val.category_l2}」不属于 ${val.category_l1}`,
        path: ["category_l2"],
      });
    }
    // C6：regulatory_flags=yes 必填 not_meaning（30~60 字）
    if (val.regulatory_flags === "yes") {
      if (!val.not_meaning) {
        ctx.addIssue({
          code: "custom",
          message: "regulatory_flags=yes 必须填写 not_meaning（30~60字）（C6）",
          path: ["not_meaning"],
        });
      } else if (
        val.not_meaning.length < 30 ||
        val.not_meaning.length > 60
      ) {
        ctx.addIssue({
          code: "custom",
          message: `not_meaning 需 30~60 字，当前 ${val.not_meaning.length} 字（C6）`,
          path: ["not_meaning"],
        });
      }
      // C7：risk_note 必填
      if (!val.risk_note) {
        ctx.addIssue({
          code: "custom",
          message: "regulatory_flags=yes 必须填写 risk_note（C7）",
          path: ["risk_note"],
        });
      }
    }
    // C10：合规终审
    if (val.compliance_approved !== true) {
      ctx.addIssue({
        code: "custom",
        message: "未经合规终审（compliance_approved=true）不可发布（C10）",
        path: ["compliance_approved"],
      });
    }
}

export const termFrontMatterSchema = termFrontMatterObject.superRefine(
  refineTermFrontMatter,
);

export type TermFrontMatter = z.infer<typeof termFrontMatterSchema>;

// 义项（一词多义）
export const senseSchema = z.object({
  sense_key: z.string().min(1),
  plain_explain: z.string().max(40),
  example: z.string().optional(),
  not_meaning: z.string().optional(),
  is_primary: z.boolean().default(false),
  // 消歧用上下文关键词（§3.3 第二级打分），前端 matcher 消费
  context_keywords: z.array(z.string()).optional(),
});

export type Sense = z.infer<typeof senseSchema>;

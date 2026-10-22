import { test } from "node:test";
import assert from "node:assert/strict";
import type { LexiconEntry } from "@jargon/contracts";
import { buildQuestionPool, toTermId } from "./generator";
import { composeQuestions } from "./compose";
import { findQuestion, scoreAnswer } from "./answer";

const mk = (
  slug: string,
  headword: string,
  cat: LexiconEntry["categoryL1"],
  diff: LexiconEntry["difficulty"],
  example: string,
  explain: string,
): LexiconEntry => ({
  slug,
  headword,
  categoryL1: cat,
  categoryL2: "测试",
  difficulty: diff,
  summaryPlain: explain,
  frequency: "mid",
  popularity: 600,
  senses: [{ senseKey: "default", plainExplain: explain, example, isPrimary: true }],
  aliases: [{ raw: headword, aliasType: "primary" }],
});

// 大语料：足够产出干扰项（每个词 ≥3 个其他词），用于校验出题与 compose 成功路径。
// 注：QUIZ-003 已改为“近似重复上界”判定，不再要求 char-bigram 覆盖率下界，
// 故此处释义无需共享后缀即可让 T1/T3 正常生成（贴近真实财经释义）。
const corpus: LexiconEntry[] = [
  mk("macd", "MACD", "技术指标", "L2", "你看指标在零轴上方金叉了说明多头占优", "指数平滑异同移动平均线，用于判断趋势与买卖点"),
  mk("pe", "市盈率", "估值财务", "L2", "你算了一下这个比值觉得估值并不贵", "股价与每股收益之比，衡量估值贵贱"),
  mk("qu-ku-cun", "去库存", "宏观经济", "L1", "新闻说上游产能要逐步消化掉", "降低工业企业的产成品存货水平"),
  mk("rsi", "RSI", "技术指标", "L2", "这个摆动指标进入了明显的超买区域", "相对强弱指标，衡量涨跌动量的超买超卖"),
  mk("kdj", "KDJ", "技术指标", "L2", "这个随机指标在高位出现了钝化", "随机指标，结合高低价与收盘价判断拐点"),
  mk("pb", "市净率", "估值财务", "L2", "你拿股价除以每股净资产比较了一下", "股价与每股净资产之比，衡量账面价值"),
  mk("gdp", "GDP", "宏观经济", "L1", "统计局公布的总量数据又创了新高", "一个国家或地区一段时期的产出总值"),
  mk("cpi", "CPI", "宏观经济", "L1", "上月物价同比涨幅超出了预期", "居民消费价格指数，反映通胀水平"),
];

// 小语料：模拟真实种子词典（仅 3 词）。每词只有 2 个其他词 → 凑不出 3 干扰项 → 题池为空，用于校验 409。
const smallEntries: LexiconEntry[] = [
  mk("macd", "MACD", "技术指标", "L2", "你看指标在零轴上方金叉了", "指数平滑异同移动平均线（金融术语）"),
  mk("pe", "市盈率", "估值财务", "L2", "你算了一下这个比值", "股价与每股收益之比（金融术语）"),
  mk("qu-ku-cun", "去库存", "宏观经济", "L1", "新闻说上游产能要消化", "降低工业企业的产成品存货水平（金融术语）"),
];

test("generator: 每词产出 T1/T2/T3，选项 4 个且正确项固定 o1", () => {
  const pool = buildQuestionPool(corpus);
  assert.ok(pool.length >= 8, `应至少每词 1 题，实际 ${pool.length}`);
  const byType = new Set(pool.map((q) => q.type));
  assert.ok(byType.has("T1") && byType.has("T2") && byType.has("T3"), "应覆盖 T1/T2/T3");
  for (const q of pool) {
    assert.equal(q.options.length, 4, `${q.questionId} 应有 4 个选项`);
    assert.equal(q.correctOptionId, "o1");
  }
});

test("generator: 真实多样化内容（无共享后缀）也能生成 T1/T3", () => {
  // 回归锁：修复前 QUIZ-003 下界(0.08)对真实中文金融释义几乎恒为 0，导致 T1/T3 永不生成。
  const realistic: LexiconEntry[] = [
    mk("macd", "MACD", "技术指标", "L2", "短期线从下往上穿过长期线常被看作上涨动能变强", "用两条快慢均线的差值看趋势强弱，交叉方向提示动能变化"),
    mk("rsi", "RSI", "技术指标", "L2", "该指标冲到七八十以上常被说成进入超买区域", "相对强弱指标，用涨跌幅对比衡量买卖动量冷热"),
    mk("pb", "市净率", "估值财务", "L2", "你拿当前价格除以每股净资产得到的比值就是它", "股价与每股净资产之比，衡量价格相对账面价值的贵贱"),
    mk("gdp", "GDP", "宏观经济", "L1", "统计局每季度公布的那串总量数字就是它", "一个国家或地区一段时期内生产的全部最终成果总值"),
  ];
  const pool = buildQuestionPool(realistic);
  const byType = new Set(pool.map((q) => q.type));
  assert.ok(byType.has("T1"), "真实内容应生成 T1");
  assert.ok(byType.has("T3"), "真实内容应生成 T3");
  assert.ok(byType.has("T2"), "真实内容应生成 T2");
});

test("generator: termId 派生稳定且 slug 安全", () => {
  assert.equal(toTermId("qu-ku-cun"), "t_qu_ku_cun");
  assert.equal(toTermId("macd"), "t_macd");
});

test("scoreAnswer: 命中/未命中", () => {
  const pool = buildQuestionPool(corpus);
  const q = pool.find((x) => x.type === "T1")!;
  assert.equal(scoreAnswer(q, q.correctOptionId), true);
  assert.equal(scoreAnswer(q, "o4"), false);
  const found = findQuestion(pool, q.questionId);
  assert.ok(found);
});

test("compose: 同一 seed → 同顺序；题目 id 不重复；payload 无答案键", () => {
  const pool = buildQuestionPool(corpus);
  const a = composeQuestions({ pool, levelId: "lv_01", count: 4, mode: "level", allowRepeat: false, seed: "abc" });
  const b = composeQuestions({ pool, levelId: "lv_01", count: 4, mode: "level", allowRepeat: false, seed: "abc" });
  assert.ok(a.ok && b.ok, "lv_01 + 充足题池 应成功出题");
  if (a.ok && b.ok) {
    assert.deepEqual(
      a.response.questions.map((q) => q.options.map((o) => o.id)),
      b.response.questions.map((q) => q.options.map((o) => o.id)),
      "相同 seed 必须得到相同展示顺序",
    );
    const ids = a.response.questions.map((q) => q.questionId);
    assert.equal(new Set(ids).size, ids.length, "一次响应内 questionId 不应重复");
    assert.ok(!("correctOptionId" in a.response.questions[0]), "payload 不得携带答案键");
  }
});

test("compose: 题池不足且不允许重复 → 409 QUIZ_POOL_EXHAUSTED", () => {
  const pool = buildQuestionPool(smallEntries); // 仅 3 词 → 干扰项不足 → 题池为空
  const r = composeQuestions({ pool, levelId: "lv_01", count: 8, mode: "level", allowRepeat: false });
  assert.ok(!r.ok);
  if (!r.ok) {
    assert.equal(r.status, 409);
    assert.equal(r.code, "QUIZ_POOL_EXHAUSTED");
  }
});

test("compose: 未知关卡 → 404 LEVEL_NOT_FOUND", () => {
  const pool = buildQuestionPool(corpus);
  const r = composeQuestions({ pool, levelId: "lv_99", count: 4, mode: "level", allowRepeat: false });
  assert.ok(!r.ok);
  if (!r.ok) assert.equal(r.code, "LEVEL_NOT_FOUND");
});

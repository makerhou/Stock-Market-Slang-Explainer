import Link from "next/link";

/**
 * 全局免责声明条（产品 S19 / 架构 §4.6）。
 * variant="line"：卡片内/页脚简短一行；variant="full"：详情页完整版。
 */
export function DisclaimerBanner({
  variant = "line",
}: {
  variant?: "line" | "full";
}) {
  if (variant === "full") {
    return (
      <section
        aria-label="免责声明"
        className="rounded-xl border border-[var(--color-risk-border)] bg-[var(--color-risk-bg)] px-4 py-3 text-sm text-[var(--color-risk-fg)]"
      >
        <p className="font-medium">免责声明</p>
        <p className="mt-1 leading-relaxed">
          本词条仅用于帮助理解股票术语，所有解释均为通俗化说明，<strong>不构成任何投资建议</strong>。
          市场有风险，投资需谨慎；具体决策请咨询持牌专业人士，并独立判断。
        </p>
        <p className="mt-1">
          <Link href="/disclaimer" className="underline">
            查看完整免责声明
          </Link>
        </p>
      </section>
    );
  }

  return (
    <p
      aria-label="免责声明"
      className="text-xs text-[var(--color-muted)]"
    >
      本工具仅用于理解股票术语，不构成投资建议。
    </p>
  );
}

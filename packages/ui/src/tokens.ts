// 设计 Token（数值表详见 frontend-design.md §32）。
// 双主题 + 三档字号；儿童友好、高对比、≥44×44 点击目标。

export const tokens = {
  fontSize: {
    base: "100%",
    large: "115%",
    xlarge: "130%",
  },
  color: {
    bg: "#ffffff",
    fg: "#0a0a0a",
    muted: "#525252",
    border: "#d4d4d4",
    riskBg: "#fffbeb",
    riskBorder: "#fcd34d",
    riskFg: "#92400e",
  },
} as const;

export type FontSizeTier = keyof typeof tokens.fontSize;

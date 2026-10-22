import type { QuizDifficulty } from "@jargon/contracts";

const MAP: Record<QuizDifficulty, { label: string; icon: string; cls: string }> = {
  1: { label: "L1 入门", icon: "●", cls: "text-emerald-700 bg-emerald-50 border-emerald-200" },
  2: { label: "L2 进阶", icon: "◆", cls: "text-indigo-700 bg-indigo-50 border-indigo-200" },
  3: { label: "L3 挑战", icon: "★", cls: "text-amber-700 bg-amber-50 border-amber-200" },
};

export function DifficultyBadge({
  level,
  size = "sm",
}: {
  level: QuizDifficulty;
  size?: "sm" | "md";
}) {
  const m = MAP[level];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border font-medium ${m.cls} ${
        size === "md" ? "px-3 py-1 text-sm" : "px-2.5 py-0.5 text-xs"
      }`}
    >
      <span aria-hidden>{m.icon}</span>
      {m.label}
    </span>
  );
}

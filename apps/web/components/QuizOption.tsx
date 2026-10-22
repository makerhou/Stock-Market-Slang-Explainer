import type { QuizOption } from "@jargon/contracts";

const LETTERS = ["A", "B", "C", "D", "E", "F"];

export type OptionState = "idle" | "selected" | "correct" | "wrong" | "pending";

export function QuizOption({
  option,
  index,
  state,
  disabled,
  onSelect,
}: {
  option: QuizOption;
  index: number;
  state: OptionState;
  disabled?: boolean;
  onSelect?: () => void;
}) {
  const isCorrect = state === "correct";
  const isWrong = state === "wrong";
  const isSelected = state === "selected";
  const isPending = state === "pending";

  const base =
    "group flex w-full min-h-[52px] items-center gap-3 rounded-2xl border px-4 py-3.5 text-left text-[15px] transition-all duration-150";
  const stateCls = isCorrect
    ? "border-emerald-400 bg-emerald-50 text-emerald-900"
    : isWrong
      ? "border-rose-400 bg-rose-50 text-rose-900"
      : isSelected
        ? "border-indigo-500 bg-indigo-50 text-indigo-950 ring-2 ring-indigo-200"
        : isPending
          ? "border-slate-300 bg-slate-100 text-slate-500"
          : "border-[var(--color-border)] bg-white text-[var(--color-body)] hover:border-indigo-300 hover:bg-indigo-50/40";

  const discCls = isCorrect
    ? "border-emerald-500 bg-emerald-500 text-white"
    : isWrong
      ? "border-rose-500 bg-rose-500 text-white"
      : isSelected
        ? "border-indigo-500 bg-indigo-500 text-white"
        : "border-[var(--color-border)] text-[var(--color-faint)] group-hover:border-indigo-300";

  return (
    <button
      type="button"
      role="radio"
      aria-checked={isSelected}
      disabled={disabled}
      onClick={onSelect}
      className={`${base} ${stateCls} ${disabled ? "cursor-default" : "cursor-pointer active:scale-[0.99]"}`}
    >
      <span
        aria-hidden
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-bold transition-colors ${discCls}`}
      >
        {isCorrect ? (
          <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2.5}>
            <path d="M5 10.5l3.5 3.5L15 6.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : isWrong ? (
          <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2.5}>
            <path d="M6 6l8 8M14 6l-8 8" strokeLinecap="round" />
          </svg>
        ) : (
          LETTERS[index] ?? index + 1
        )}
      </span>
      <span className="flex-1">{option.text}</span>
    </button>
  );
}

import type { Metadata } from "next";
import { QuizPlay } from "@/components/QuizPlay";

export const metadata: Metadata = {
  title: "答题",
  robots: { index: false, follow: false },
};

export default async function QuizLevelPage({
  params,
}: {
  params: Promise<{ levelId: string }>;
}) {
  const { levelId } = await params;
  return <QuizPlay levelId={levelId} mode="level" />;
}

import type { Metadata } from "next";
import { QuizPlay } from "@/components/QuizPlay";

export const metadata: Metadata = {
  title: "错题重练",
  robots: { index: false, follow: false },
};

export default async function QuizReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ termIds?: string }>;
}) {
  const { termIds } = await searchParams;
  const ids = termIds
    ? termIds.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 50)
    : [];
  return <QuizPlay levelId="lv_01" mode="review" termIds={ids} />;
}

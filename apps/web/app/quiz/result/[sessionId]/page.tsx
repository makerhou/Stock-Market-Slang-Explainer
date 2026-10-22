import type { Metadata } from "next";
import { QuizResultView } from "@/components/QuizResultView";

export const metadata: Metadata = {
  title: "答题结果",
  robots: { index: false, follow: false },
};

export default async function QuizResultPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  return <QuizResultView sessionId={sessionId} />;
}

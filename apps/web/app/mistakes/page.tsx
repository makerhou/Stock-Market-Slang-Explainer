import type { Metadata } from "next";
import { MistakesView } from "@/components/MistakesView";

export const metadata: Metadata = {
  title: "错题本",
  robots: { index: false, follow: false },
};

export default function MistakesPage() {
  return <MistakesView />;
}

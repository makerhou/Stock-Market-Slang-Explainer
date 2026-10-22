import type { Metadata } from "next";
import "./globals.css";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { FontSizeToggle } from "@/components/FontSizeToggle";
import { TabBar } from "@/components/TabBar";
import { OfflineBanner } from "@/components/OfflineBanner";
import { LexiconProvider } from "@/lib/lexicon-client";

export const metadata: Metadata = {
  title: {
    default: "股票黑话解释器",
    template: "%s · 股票黑话解释器",
  },
  description:
    "用大白话讲清股票术语，附举例与小测验。本工具仅用于理解，不构成投资建议。",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body className="flex min-h-screen flex-col">
        <LexiconProvider>
          <OfflineBanner />
          <Header />
          <main className="app-container flex-1 py-6 pb-28 md:pb-10">{children}</main>
          <div className="app-container flex justify-end pb-2">
            <FontSizeToggle />
          </div>
          <Footer />
          <div className="h-20 md:h-16" aria-hidden />
          <TabBar />
        </LexiconProvider>
      </body>
    </html>
  );
}

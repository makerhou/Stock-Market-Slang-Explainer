import Link from "next/link";
import { getLexiconManifest } from "@/lib/server-data";
import { SearchBar } from "@/components/SearchBar";
import { DisclaimerBanner } from "@/components/DisclaimerBanner";

/** E1：404 / 未收录（frontend-design §2.1 E1） */
export default function NotFound() {
  const hot = [...getLexiconManifest().entries]
    .sort((a, b) => b.popularity - a.popularity)
    .slice(0, 8);

  return (
    <div className="flex flex-col gap-5 py-6">
      <div className="text-center">
        <h1 className="text-xl font-bold text-[var(--color-fg)]">这个词我们还没收录</h1>
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          你可以换个说法再搜一次，或从下面的热门词里挑一个。
        </p>
      </div>

      <SearchBar variant="inline" />

      {hot.length > 0 ? (
        <div>
          <h2 className="mb-3 text-sm font-semibold text-[var(--color-fg)]">热门术语</h2>
          <div className="flex flex-wrap gap-2">
            {hot.map((t) => (
              <Link
                key={t.slug}
                href={`/terms/${t.slug}`}
                className="rounded-full border border-[var(--color-border)] px-3 py-1 text-sm hover:border-[var(--color-fg)]"
              >
                {t.headword}
              </Link>
            ))}
          </div>
        </div>
      ) : null}

      <div className="text-center">
        <Link href="/" className="text-sm underline">
          返回首页
        </Link>
      </div>

      <DisclaimerBanner variant="line" />
    </div>
  );
}

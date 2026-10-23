/**
 * GET /api/lexicon —— 对外契约（backend-implementation §2.3）
 * 下发客户端词典快照，供浏览器本地匹配 + IndexedDB 缓存。
 * 契约要点：
 *  - ETag = "lex-{version}-{checksum}"，内容不变永远 304
 *  - 支持 If-None-Match（接受完整 ETag 或仅含 checksum 的子串）
 *  - Cache-Control: public, max-age=300, s-maxage=3600, stale-while-revalidate=86400
 *  - tag: lexicon（内容发布后 revalidateTag 精准打掉）
 */
import { NextResponse } from "next/server";
import { getLexiconManifest } from "@/lib/server-data";

// 每请求执行，以支持 If-None-Match → 304（Cache-Control 由响应头手动控制）
export const dynamic = "force-dynamic";

function buildEtag(version: number, checksum: string): string {
  return `"lex-${version}-${checksum}"`;
}

export function GET(request: Request) {
  const manifest = getLexiconManifest();
  const etag = buildEtag(manifest.version, manifest.checksum);

  const incoming = request.headers.get("if-none-match");
  if (incoming && (incoming === etag || incoming.includes(manifest.checksum))) {
    return new NextResponse(null, {
      status: 304,
      headers: {
        ETag: etag,
        "Cache-Control":
          "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
      },
    });
  }

  // 客户端只用匹配/浏览字段（slug/headword/分类/释义/风险/义项/别名），
  // viz/insights 仅服务端详情页消费；下发前剥离以降低 payload（万级词条时显著）。
  const slim = {
    ...manifest,
    entries: manifest.entries.map(({ viz: _viz, insights: _insights, ...rest }) => rest),
  };

  return NextResponse.json(slim, {
    status: 200,
    headers: {
      ETag: etag,
      "Cache-Control":
        "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}

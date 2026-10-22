/**
 * 服务端数据层（M4）：读取 M2-4 编译产物 content/.compiled/lexicon.json。
 * 该文件是「客户端词典」的单一真源，离线即可驱动 SSG / SSR / /api/lexicon，
 * 不依赖 Neon（契合设计「离线可读」与 MVP 仅做单术语查询）。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { LexiconManifest } from "@jargon/contracts";
import { LexiconMatcher } from "@jargon/matcher";

const EMPTY: LexiconManifest = {
  version: 0,
  checksum: "",
  generatedAt: new Date(0).toISOString(),
  count: 0,
  entries: [],
};

function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(dir, "content/.compiled/lexicon.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // apps/web 下的兜底相对路径
  return path.resolve(process.cwd(), "..", "..");
}

let _manifest: LexiconManifest | null = null;
let _matcher: LexiconMatcher | null = null;

export function getLexiconManifest(): LexiconManifest {
  if (_manifest) return _manifest;
  const file = path.join(findRepoRoot(), "content/.compiled/lexicon.json");
  if (!existsSync(file)) {
    _manifest = EMPTY;
    return _manifest;
  }
  try {
    _manifest = JSON.parse(readFileSync(file, "utf8")) as LexiconManifest;
  } catch {
    _manifest = EMPTY;
  }
  return _manifest;
}

export function getServerMatcher(): LexiconMatcher {
  if (_matcher) return _matcher;
  _matcher = new LexiconMatcher(getLexiconManifest());
  return _matcher;
}

/** 按 slug 取词条（SSG 详情页 / generateStaticParams 用） */
export function getEntryBySlug(slug: string) {
  return getLexiconManifest().entries.find((e) => e.slug === slug) ?? null;
}

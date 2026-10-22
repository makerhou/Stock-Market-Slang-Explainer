import { existsSync } from "node:fs";
import path from "node:path";

/**
 * 从任意 cwd 向上定位仓库根（含 pnpm-workspace.yaml 或同时含 apps/·packages/·content/）。
 * 解决 `npm run <script> --workspace=@jargon/content` 时 cwd 被切到包目录的问题，
 * 使 content/terms、content-rules 等路径始终相对仓库根解析。
 */
export function findRepoRoot(start: string = process.cwd()): string {
  let dir = start;
  for (;;) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    if (
      existsSync(path.join(dir, "apps")) &&
      existsSync(path.join(dir, "packages")) &&
      existsSync(path.join(dir, "content"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

/**
 * 服务端测验数据层（M5）：从 M2-4 编译产物（content/.compiled/lexicon.json）确定性构建题目池。
 * 题目是编译产物而非数据（agent-content-pipeline-design §3.4），所以不依赖 Neon，离线即可出题。
 */
import type { LexiconEntry } from "@jargon/contracts";
import { getLexiconManifest } from "./server-data";
import { buildQuestionPool, type GeneratedQuestion } from "@jargon/quiz";

let _pool: GeneratedQuestion[] | null = null;
let _version = -1;

export function getQuizPool(): GeneratedQuestion[] {
  const manifest = getLexiconManifest();
  if (_pool && _version === manifest.version) return _pool;
  _pool = buildQuestionPool(manifest.entries as LexiconEntry[]);
  _version = manifest.version;
  return _pool;
}

export function getContentVersion(): number {
  return getLexiconManifest().version;
}

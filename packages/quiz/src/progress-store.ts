/**
 * ProgressStore —— 学习进度 / 错题本 / 连对 / 设置 的本地唯一真源。
 * 对齐 frontend-design.md §5.2。零账号、零 Cookie、零 PII：数据只落 localStorage（或隐私模式下的内存）。
 */

export const PROGRESS_SCHEMA_VERSION = 1;
export const STORAGE_KEY = "glossary:progress:v1";
export const SETTINGS_KEY = "glossary:settings:v1";

export type DifficultyLevel = 1 | 2 | 3;

export type LevelState = {
  levelId: string;
  currentIndex: number; // 0-based，已答到第几题
  questionIds: string[]; // 已下发题目 id（断点续做复用）
  answered: Record<string, AnswerRecord>;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  durationMs?: number;
  correctCount: number;
};

export type AnswerRecord = {
  questionId: string;
  termId: string;
  termSlug: string;
  optionId: string;
  correct: boolean;
  verification: "verified" | "pending";
  answeredAt: number;
};

export type MistakeEntry = {
  termId: string;
  termSlug: string;
  termName: string;
  gloss: string;
  wrongCount: number;
  lastWrongAt: number;
  mastered: boolean; // 是否已答对过
  inDefaultList: boolean; // 是否仍在默认复习列表
  masteredAt?: number;
  lastWrongQuestionId?: string;
  restoredAt?: number;
};

export type ComboState = { current: number; best: number };

export type Settings = {
  fontScale: 1 | 2 | 3;
  theme: "system" | "light" | "dark";
  reducedMotion?: "auto" | "on";
};

export type ProgressSnapshot = {
  schemaVersion: number;
  deviceId: string;
  levels: Record<string, LevelState>;
  mistakes: Record<string, MistakeEntry>;
  combo: ComboState;
  settings: Settings;
  stats: { learnedTermIds: string[]; masteredTermIds: string[] };
  updatedAt: number;
};

export interface ProgressStore {
  getLevelState(levelId: string): LevelState | null;
  saveLevelState(levelId: string, state: LevelState): void;
  listLevelStates(): LevelState[];
  clearLevelState(levelId: string): void;
  recordAnswer(a: AnswerRecord): void;
  getMistakes(): MistakeEntry[];
  getMastered(): MistakeEntry[];
  getMistake(termId: string): MistakeEntry | null;
  clearMistakes(termId: string): void;
  markMastered(termId: string): boolean;
  requeueMistake(termId: string, patch: Partial<MistakeEntry>): void;
  restoreToDefaultList(termId: string): boolean;
  getMistakeCounts(): { inDefaultList: number; mastered: number; total: number };
  getCombo(): ComboState;
  bumpCombo(correct: boolean): ComboState;
  getSettings(): Settings;
  saveSettings(s: Partial<Settings>): Settings;
  getLearnedCount(): number;
  getMasteredCount(): number;
  clearAllLearningData(): void;
  exportSnapshot(): ProgressSnapshot;
  importSnapshot(s: ProgressSnapshot): void;
  subscribe(cb: (snap: ProgressSnapshot) => void): () => void;
  readonly degraded: boolean;
}

function emptySnapshot(): ProgressSnapshot {
  return {
    schemaVersion: PROGRESS_SCHEMA_VERSION,
    deviceId: "",
    levels: {},
    mistakes: {},
    combo: { current: 0, best: 0 },
    settings: { fontScale: 1, theme: "system" },
    stats: { learnedTermIds: [], masteredTermIds: [] },
    updatedAt: Date.now(),
  };
}

function newDeviceId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return "dev-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

abstract class BaseProgressStore implements ProgressStore {
  abstract readonly degraded: boolean;
  protected snap: ProgressSnapshot = emptySnapshot();
  private listeners = new Set<(s: ProgressSnapshot) => void>();

  protected touch() {
    this.snap.updatedAt = Date.now();
    for (const cb of this.listeners) cb(this.snap);
  }
  subscribe(cb: (s: ProgressSnapshot) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  static async probe() {
    return true;
  }

  getLevelState(levelId: string) {
    return this.snap.levels[levelId] ?? null;
  }
  saveLevelState(levelId: string, state: LevelState) {
    this.snap.levels[levelId] = { ...state, updatedAt: Date.now() };
    this.touch();
  }
  listLevelStates() {
    return Object.values(this.snap.levels);
  }
  clearLevelState(levelId: string) {
    delete this.snap.levels[levelId];
    this.touch();
  }

  recordAnswer(a: AnswerRecord) {
    // 错题本同步维护 mastered / inDefaultList 两个独立布尔
    const m = this.snap.mistakes[a.termId];
    if (a.correct) {
      // 答对：若已在错题本 → 移出默认复习列表（markMastered 语义）
      if (m && m.inDefaultList) this.markMastered(a.termId);
    } else {
      if (!m) {
        this.snap.mistakes[a.termId] = {
          termId: a.termId,
          termSlug: a.termSlug,
          termName: a.termSlug,
          gloss: "",
          wrongCount: 1,
          lastWrongAt: a.answeredAt,
          mastered: false,
          inDefaultList: true,
          lastWrongQuestionId: a.questionId,
        };
      } else {
        m.wrongCount += 1;
        m.lastWrongAt = a.answeredAt;
        m.inDefaultList = true;
        m.mastered = false;
        m.lastWrongQuestionId = a.questionId;
      }
      if (!this.snap.stats.learnedTermIds.includes(a.termId))
        this.snap.stats.learnedTermIds.push(a.termId);
    }
    this.bumpCombo(a.correct);
    this.touch();
  }

  getMistakes() {
    return Object.values(this.snap.mistakes).filter((m) => m.inDefaultList);
  }
  getMastered() {
    return Object.values(this.snap.mistakes).filter((m) => m.mastered && !m.inDefaultList);
  }
  getMistake(termId: string) {
    return this.snap.mistakes[termId] ?? null;
  }
  clearMistakes(termId: string) {
    delete this.snap.mistakes[termId];
    this.touch();
  }

  markMastered(termId: string): boolean {
    const m = this.snap.mistakes[termId];
    if (!m) return false;
    const wasInDefault = m.inDefaultList;
    m.mastered = true;
    m.inDefaultList = false;
    m.masteredAt = Date.now();
    if (!this.snap.stats.masteredTermIds.includes(termId))
      this.snap.stats.masteredTermIds.push(termId);
    this.touch();
    return wasInDefault; // true = 本次确实把该词移出了默认复习列表
  }

  requeueMistake(termId: string, patch: Partial<MistakeEntry>) {
    const m = this.snap.mistakes[termId];
    if (!m) return;
    if (patch.gloss !== undefined) m.gloss = patch.gloss;
    m.mastered = false;
    m.inDefaultList = true;
    this.touch();
  }

  restoreToDefaultList(termId: string): boolean {
    const m = this.snap.mistakes[termId];
    if (!m) return false;
    if (m.inDefaultList) return false; // 幂等
    m.inDefaultList = true;
    m.restoredAt = Date.now();
    this.touch();
    return true;
  }

  getMistakeCounts() {
    const all = Object.values(this.snap.mistakes);
    const inDefaultList = all.filter((m) => m.inDefaultList).length;
    const mastered = all.filter((m) => m.mastered && !m.inDefaultList).length;
    return { inDefaultList, mastered, total: all.length };
  }

  getCombo() {
    return this.snap.combo;
  }
  bumpCombo(correct: boolean) {
    if (correct) {
      this.snap.combo.current += 1;
      this.snap.combo.best = Math.max(this.snap.combo.best, this.snap.combo.current);
    } else {
      this.snap.combo.current = 0;
    }
    return this.snap.combo;
  }

  getSettings() {
    return this.snap.settings;
  }
  saveSettings(s: Partial<Settings>) {
    this.snap.settings = { ...this.snap.settings, ...s };
    this.touch();
    return this.snap.settings;
  }

  getLearnedCount() {
    return this.snap.stats.learnedTermIds.length;
  }
  getMasteredCount() {
    return this.snap.stats.masteredTermIds.length;
  }

  clearAllLearningData() {
    const settings = this.snap.settings;
    const deviceId = this.snap.deviceId;
    this.snap = emptySnapshot();
    this.snap.settings = settings;
    this.snap.deviceId = deviceId;
    this.touch();
  }

  exportSnapshot() {
    return JSON.parse(JSON.stringify(this.snap)) as ProgressSnapshot;
  }
  importSnapshot(s: ProgressSnapshot) {
    this.snap = { ...emptySnapshot(), ...s, settings: { ...s.settings } };
    this.touch();
  }
}

class MemoryProgressStore extends BaseProgressStore {
  readonly degraded = true;
}

class LocalProgressStore extends BaseProgressStore {
  readonly degraded = false;
  constructor() {
    super();
    const raw = (globalThis as { localStorage?: Storage }).localStorage?.getItem(STORAGE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as ProgressSnapshot;
        if (parsed.schemaVersion === PROGRESS_SCHEMA_VERSION) {
          this.snap = { ...emptySnapshot(), ...parsed };
          if (!this.snap.deviceId) this.snap.deviceId = newDeviceId();
        }
      } catch {
        /* 损坏数据 → 重置 */
      }
    }
    if (!this.snap.deviceId) this.snap.deviceId = newDeviceId();
    if (typeof window !== "undefined") {
      window.addEventListener("storage", () => this.reload());
    }
  }
  private reload() {
    const raw = (globalThis as { localStorage?: Storage }).localStorage?.getItem(STORAGE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as ProgressSnapshot;
        if (parsed.updatedAt > this.snap.updatedAt) {
          this.snap = { ...emptySnapshot(), ...parsed };
          this.touch();
        }
      } catch {
        /* ignore */
      }
    }
  }
  protected touch() {
    super.touch();
    try {
      (globalThis as { localStorage?: Storage }).localStorage?.setItem(STORAGE_KEY, JSON.stringify(this.snap));
    } catch {
      /* 配额超限：忽略，内存态仍可用 */
    }
  }
}

let singleton: ProgressStore | null = null;

/** 探测并创建合适的 ProgressStore（隐私模式降级为内存实现） */
export async function createProgressStore(): Promise<ProgressStore> {
  if (singleton) return singleton;
  if (typeof window === "undefined") {
    singleton = new MemoryProgressStore();
    return singleton;
  }
  try {
    const probeKey = "__glossary_probe__";
    window.localStorage.setItem(probeKey, "1");
    window.localStorage.removeItem(probeKey);
    singleton = new LocalProgressStore();
  } catch {
    singleton = new MemoryProgressStore();
  }
  return singleton;
}

/** 同步获取（已初始化时）。仅在客户端组件挂载后调用。 */
export function getProgressStore(): ProgressStore | null {
  return singleton;
}

export async function initProgressStore(): Promise<ProgressStore> {
  return createProgressStore();
}

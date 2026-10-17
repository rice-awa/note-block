/**
 * 本机偏好：不进分享链接、不进撤销栈，单独一个 localStorage key。
 * 曲长 / 循环 / BPM 属于「曲子」，不在这里。
 */

export interface Prefs {
  /** 主音量 0..1 */
  masterGain: number;
  /** 混响送出量 0..1 */
  reverb: number;
  /** 可见列数 8..32（M4 才真正应用） */
  windowCols: number;
}

export const PREFS_KEY = 'note-block:prefs:v1';

export const DEFAULT_PREFS: Prefs = {
  masterGain: 0.82,
  reverb: 0.16,
  windowCols: 16,
};

export const WINDOW_COLS_MIN = 8;
export const WINDOW_COLS_MAX = 32;
export const WINDOW_COLS_STEP = 4;

const clamp01 = (v: unknown, fallback: number): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(1, Math.max(0, v));
};

export const clampWindowCols = (v: number): number => {
  const n = Number.isFinite(v) ? Math.round(v / WINDOW_COLS_STEP) * WINDOW_COLS_STEP : DEFAULT_PREFS.windowCols;
  return Math.min(WINDOW_COLS_MAX, Math.max(WINDOW_COLS_MIN, n));
};

function getStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** 读偏好：缺字段用默认值，越界值夹住，异常返回默认值 */
export function loadPrefs(): Prefs {
  try {
    const store = getStorage();
    const raw = store?.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== 'object') return { ...DEFAULT_PREFS };
    const obj = data as Record<string, unknown>;
    return {
      masterGain: clamp01(obj.masterGain, DEFAULT_PREFS.masterGain),
      reverb: clamp01(obj.reverb, DEFAULT_PREFS.reverb),
      windowCols: clampWindowCols(typeof obj.windowCols === 'number' ? obj.windowCols : DEFAULT_PREFS.windowCols),
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(prefs: Prefs): void {
  try {
    getStorage()?.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* 隐私模式等失败静默 */
  }
}

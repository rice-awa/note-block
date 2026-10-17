/**
 * 曲谱数据模型：状态定义、URL 分享编码、localStorage 自动存档、撤销栈。
 * 不依赖渲染层，可单独复用与测试。
 */

export interface Note {
  step: number;
  row: number;
  midi: number;
}

export interface SongState {
  notes: Note[];
  bpm: number;
  infinite: boolean;
  /** 曲长（小节，1..32），每小节 16 步 */
  bars: number;
  /** 播完循环 / 停在末尾 */
  loop: boolean;
}

/** 外部（旧调用、存档、分享）可能只给一部分字段，归一化时补默认值 */
export interface SongStateInput {
  notes: Note[];
  bpm: number;
  infinite: boolean;
  bars?: number;
  loop?: boolean;
}

export const MAX_STEPS: number = 512;
export const MEASURE: number = 16;
export const MAX_BARS: number = 32;
export const MIN_BARS: number = 1;
export const ROWS_COUNT: number = 8;
export const MIDI_MIN: number = 0;
export const MIDI_MAX: number = 24;
export const STORAGE_KEY: string = 'note-block:v1';

const VERSION = 2;
const VERSION_V1 = 1;
const BPM_MIN = 60;
const BPM_MAX = 180;
const DEFAULT_BPM = 120;
const COALESCE_MS = 900;
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

const clampBpm = (bpm: number): number => {
  if (!Number.isFinite(bpm)) return DEFAULT_BPM;
  return Math.min(BPM_MAX, Math.max(BPM_MIN, Math.round(bpm)));
};

export const clampBars = (bars: number): number => {
  if (!Number.isFinite(bars)) return MIN_BARS;
  return Math.min(MAX_BARS, Math.max(MIN_BARS, Math.round(bars)));
};

const copyState = (state: SongState): SongState => ({
  notes: state.notes.map((n) => ({ step: n.step, row: n.row, midi: n.midi })),
  bpm: state.bpm,
  infinite: state.infinite,
  bars: state.bars,
  loop: state.loop,
});

/** 校验单条音符：整数且在界内，返回新对象 */
export function sanitizeNote(note: Note): Note | null {
  if (typeof note !== 'object' || note === null) return null;
  const { step, row, midi } = note;
  if (!isInt(step) || step < 0 || step >= MAX_STEPS) return null;
  if (!isInt(row) || row < 0 || row >= ROWS_COUNT) return null;
  if (!isInt(midi) || midi < MIDI_MIN || midi > MIDI_MAX) return null;
  return { step, row, midi };
}

/** 曲长：最小一小节，按 16 步取整，上限 MAX_STEPS */
export function songLength(notes: Note[]): number {
  let maxStep = -1;
  for (const note of notes ?? []) {
    if (!isInt(note?.step) || note.step < 0 || note.step >= MAX_STEPS) continue;
    if (note.step > maxStep) maxStep = note.step;
  }
  if (maxStep < 0) return MEASURE;
  const rounded = Math.ceil((maxStep + 1) / MEASURE) * MEASURE;
  return Math.min(MAX_STEPS, Math.max(MEASURE, rounded));
}

/** 曲长（小节）：至少 1 小节，按 16 步向上取整，上限 MAX_BARS */
export function songBars(notes: Note[]): number {
  return clampBars(songLength(notes) / MEASURE);
}

/** 有限模式 / 内容长度（步） */
export function songSteps(bars: number): number {
  return clampBars(bars) * MEASURE;
}

/** 时长读数（秒）：bars * 16 步 * 每步时长 */
export function songDuration(bars: number, bpm: number): number {
  return (clampBars(bars) * MEASURE * 60) / (clampBpm(bpm) * 4);
}

/** 秒 → `0:08.9` */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const minutes = Math.floor(total / 60);
  const rest = total - minutes * 60;
  return `${minutes}:${rest.toFixed(1).padStart(4, '0')}`;
}

/**
 * 归一化：旧调用只给 notes/bpm/infinite 时，bars 取内容整小节，loop 默认开启。
 * 曲长下限始终不切掉已有音符。
 */
export function normalizeState(input: SongStateInput): SongState {
  const notes = normalizeNotes(input.notes ?? []);
  const content = Math.max(1, Math.ceil(songLength(notes) / MEASURE));
  const bars = clampBars(Math.max(content, typeof input.bars === 'number' ? input.bars : content));
  return {
    notes,
    bpm: clampBpm(input.bpm),
    infinite: input.infinite === true,
    bars,
    loop: input.loop !== false,
  };
}

/** 清洗并去重（同 step+row 保留最后一条，顺序按各自最后一次出现） */
function normalizeNotes(notes: Note[]): Note[] {
  const clean: Note[] = [];
  for (const note of notes ?? []) {
    const n = sanitizeNote(note);
    if (n) clean.push(n);
  }
  const seen = new Set<string>();
  const out: Note[] = [];
  for (let i = clean.length - 1; i >= 0; i--) {
    const n = clean[i];
    const key = `${n.step}:${n.row}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out.reverse();
}

function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const hasB = i + 1 < bytes.length;
    const hasC = i + 2 < bytes.length;
    const b = hasB ? bytes[i + 1] : 0;
    const c = hasC ? bytes[i + 2] : 0;
    out += B64[a >> 2];
    out += B64[((a & 0x03) << 4) | (b >> 4)];
    if (hasB) out += B64[((b & 0x0f) << 2) | (c >> 6)];
    if (hasC) out += B64[c & 0x3f];
  }
  return out;
}

function fromBase64Url(code: string): Uint8Array | null {
  const bytes: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const ch of code) {
    const v = B64.indexOf(ch);
    if (v < 0) return null;
    buf = ((buf << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buf >> bits) & 0xff);
    }
  }
  // 余 6 位说明长度非法；尾部补的零位必须为 0
  if (bits >= 6) return null;
  if ((buf & ((1 << bits) - 1)) !== 0) return null;
  return Uint8Array.from(bytes);
}

/**
 * 编码 v2：header 6 字节 [version, bpm, flags, bars, countLo, countHi] + 每条 3 字节。
 * flags bit0 = infinite，bit1 = loop。
 * b0 = step & 0xff
 * b1 = (step>>8)&0x03 | (row&0x07)<<2 | (midi&0x03)<<5
 * b2 = (midi>>2)&0x3f
 * 再转 URL-safe base64（无 =）。
 */
export function encodeSong(state: SongState): string {
  const notes = normalizeNotes(state.notes);
  const content = Math.max(1, Math.ceil(songLength(notes) / MEASURE));
  const bars = clampBars(Math.max(content, state.bars));
  const flags = (state.infinite ? 1 : 0) | (state.loop === false ? 0 : 2);
  const bytes = new Uint8Array(6 + notes.length * 3);
  bytes[0] = VERSION;
  bytes[1] = clampBpm(state.bpm);
  bytes[2] = flags;
  bytes[3] = bars;
  bytes[4] = notes.length & 0xff;
  bytes[5] = (notes.length >> 8) & 0xff;
  let i = 6;
  for (const note of notes) {
    bytes[i++] = note.step & 0xff;
    bytes[i++] = ((note.step >> 8) & 0x03) | ((note.row & 0x07) << 2) | ((note.midi & 0x03) << 5);
    bytes[i++] = (note.midi >> 2) & 0x3f;
  }
  return toBase64Url(bytes);
}

/** 解码：v2 读 bars/loop；v1（5 字节 header）按内容整小节补 bars、loop 默认开 */
export function decodeSong(code: string): SongState | null {
  try {
    if (typeof code !== 'string' || code.length === 0) return null;
    const bytes = fromBase64Url(code.replace(/=+$/, ''));
    if (!bytes || bytes.length < 5) return null;
    const version = bytes[0];
    if (version !== VERSION && version !== VERSION_V1) return null;
    const header = version === VERSION_V1 ? 5 : 6;
    if (bytes.length < header) return null;
    const bpm = bytes[1];
    if (bpm < BPM_MIN || bpm > BPM_MAX) return null;
    const flags = bytes[2];
    const maxFlags = version === VERSION_V1 ? 1 : 3;
    if ((flags & ~maxFlags) !== 0) return null;
    const bars = version === VERSION_V1 ? 0 : bytes[3];
    if (version === VERSION && (bars < MIN_BARS || bars > MAX_BARS)) return null;
    const countLo = bytes[version === VERSION_V1 ? 3 : 4];
    const countHi = bytes[version === VERSION_V1 ? 4 : 5];
    const count = countLo | (countHi << 8);
    if (count > MAX_STEPS * ROWS_COUNT) return null;
    if (bytes.length !== header + count * 3) return null;
    const notes: Note[] = [];
    let i = header;
    for (let k = 0; k < count; k++) {
      const b0 = bytes[i++];
      const b1 = bytes[i++];
      const b2 = bytes[i++];
      const note = sanitizeNote({
        step: b0 | ((b1 & 0x03) << 8),
        row: (b1 >> 2) & 0x07,
        midi: ((b1 >> 5) & 0x03) | ((b2 & 0x3f) << 2),
      });
      if (!note) return null;
      notes.push(note);
    }
    const content = Math.max(1, Math.ceil(songLength(notes) / MEASURE));
    return {
      notes,
      bpm,
      infinite: (flags & 1) === 1,
      bars: clampBars(Math.max(content, version === VERSION_V1 ? content : bars)),
      loop: version === VERSION_V1 ? true : (flags & 2) === 2,
    };
  } catch {
    return null;
  }
}

/** 分享链接：当前 origin/pathname + #s=code */
export function shareUrl(state: SongState): string {
  return `${location.origin}${location.pathname}#s=${encodeSong(state)}`;
}

/** 读取分享码：兼容 #s=... 与直接 #...，没有则 null */
export function readShareCode(): string | null {
  if (typeof location === 'undefined' || !location.hash) return null;
  const hash = location.hash.replace(/^#/, '');
  if (!hash) return null;
  const code = hash.startsWith('s=') ? hash.slice(2) : hash;
  return code.length > 0 ? code : null;
}

function getStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** 读取本地存档：v2 校验全字段；v1 自动迁移成 v2（bars 按内容、loop 开） */
export function loadLocal(): SongState | null {
  try {
    const store = getStorage();
    if (!store) return null;
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    const obj = data as Record<string, unknown>;
    if (!Array.isArray(obj.notes)) return null;
    if (obj.v !== VERSION && obj.v !== VERSION_V1) return null;
    const notes = normalizeNotes(obj.notes as Note[]);
    const content = Math.max(1, Math.ceil(songLength(notes) / MEASURE));
    const bars = obj.v === VERSION && typeof obj.bars === 'number' ? clampBars(obj.bars) : content;
    return normalizeState({
      notes,
      bpm: typeof obj.bpm === 'number' ? obj.bpm : DEFAULT_BPM,
      infinite: obj.infinite === true,
      bars,
      loop: obj.v === VERSION ? obj.loop !== false : true,
    });
  } catch {
    return null;
  }
}

/** 写入本地存档（v2）；隐私模式、配额满等失败一律静默 */
export function saveLocal(state: SongState): void {
  try {
    const store = getStorage();
    if (!store) return;
    const notes = normalizeNotes(state.notes);
    const content = Math.max(1, Math.ceil(songLength(notes) / MEASURE));
    const payload = {
      v: VERSION,
      notes,
      bpm: clampBpm(state.bpm),
      infinite: state.infinite === true,
      bars: clampBars(Math.max(content, state.bars)),
      loop: state.loop !== false,
    };
    store.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* 静默失败，不打断演奏 */
  }
}

export function clearLocal(): void {
  try {
    getStorage()?.removeItem(STORAGE_KEY);
  } catch {
    /* 静默失败 */
  }
}

/** 快照式撤销栈：保存「修改前」状态 */
export class History {
  private readonly limit: number;
  private undoStack: SongState[] = [];
  private redoStack: SongState[] = [];
  private lastKey: string | null = null;
  private lastAt = 0;

  constructor(limit: number = 40) {
    this.limit = Math.max(1, Math.floor(limit) || 40);
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** 调试 / QA：当前可撤销的条目数 */
  get undoDepth(): number {
    return this.undoStack.length;
  }

  get redoDepth(): number {
    return this.redoStack.length;
  }

  /** 修改前记录；同 key 且距上次记录 <900ms 时跳过（如滚轮连续改音高） */
  record(state: SongState, coalesceKey?: string): void {
    const now = Date.now();
    if (coalesceKey !== undefined && coalesceKey === this.lastKey && now - this.lastAt < COALESCE_MS) return;
    this.push(state);
    this.lastKey = coalesceKey ?? null;
    this.lastAt = now;
  }

  /** 显式压入「修改前」快照（拖动开始），并清空 redo */
  push(state: SongState): void {
    this.undoStack.push(copyState(state));
    while (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
    this.resetCoalesce();
  }

  /** 撤销：弹出上一份快照，当前状态进 redo */
  undo(current: SongState): SongState | null {
    const prev = this.undoStack.pop();
    if (!prev) return null;
    this.redoStack.push(copyState(current));
    while (this.redoStack.length > this.limit) this.redoStack.shift();
    this.resetCoalesce();
    return copyState(prev);
  }

  /** 重做：弹出 redo，当前状态回填 undo */
  redo(current: SongState): SongState | null {
    const next = this.redoStack.pop();
    if (!next) return null;
    this.undoStack.push(copyState(current));
    while (this.undoStack.length > this.limit) this.undoStack.shift();
    this.resetCoalesce();
    return copyState(next);
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.resetCoalesce();
  }

  private resetCoalesce(): void {
    this.lastKey = null;
    this.lastAt = 0;
  }
}

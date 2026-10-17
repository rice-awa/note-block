import './style.css';
import { AudioEngine, Clock } from './audio';
import { ConfigPanel, type GesturePhase } from './config-panel';
import { Drawer } from './drawer';
import { ExamplePanel } from './example-panel';
import { EXAMPLES, type Example } from './examples';
import { Hud } from './hud';
import { clampWindowCols, loadPrefs, savePrefs, type Prefs } from './prefs';
import { DEMO, MAX_MIDI, MIN_MIDI, ROWS } from './rows';
import { Studio, type BlockView, type Cell, type PaintCell } from './scene';
import {
  clampBars,
  clearBackup,
  decodeSong,
  hasBackup,
  History,
  loadBackup,
  loadLocal,
  MAX_BARS,
  MAX_STEPS,
  normalizeState,
  readShareCode,
  saveBackup,
  saveLocal,
  shareUrl,
  type Note,
  type SongState,
  type SongStateInput,
} from './song';

const MEASURE = 16;
/** 可见列数随边缘拖拽 / 配置面板变化，窗口跟随全部按它算 */
const windowCols = (): number => studio.windowCols;

const canvas = document.querySelector<HTMLCanvasElement>('#scene')!;
const studio = new Studio(canvas);
const audio = new AudioEngine();
const hud = new Hud();
const history = new History(40);
const mutedRows = new Set<number>();
const prefs: Prefs = loadPrefs();

audio.setMasterGain(prefs.masterGain);
audio.setReverbSend(prefs.reverb);

const voice = (row: number) => ({ sample: ROWS[row].sample, gain: ROWS[row].gain });

// ---------------------------------------------------------------- state

let infinite = false;
/** 曲长（小节）：有限模式 = 时钟长度；无限模式随内容增长 */
let bars = 1;
/** 播完循环 / 停在末尾 */
let loop = true;
/** 手动平移时间轴时累计的偏移（步） */
let viewOffset = 0;
let prevPos = 0;
let dragPre: SongState | null = null;
let saveTimer = 0;
let lastSavedAt = 0;

const capture = (): SongState => ({
  notes: studio.getNotes(),
  bpm: clock.bpm,
  infinite,
  bars,
  loop,
});

const record = (key?: string): void => {
  // 只要发生了新的可撤销操作，旧 toast 的"撤销"就不再指向那次操作了
  hud.hideToast();
  history.record(capture(), key);
};

function markDirty(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveLocal(capture());
    lastSavedAt = Date.now();
    updateSavedLabel();
  }, 500);
}

function updateSavedLabel(): void {
  if (!lastSavedAt) {
    configPanel?.setSavedLabel('自动存档 · 本地');
    return;
  }
  const seconds = Math.max(0, Math.round((Date.now() - lastSavedAt) / 1000));
  const when = seconds < 5 ? '刚刚' : seconds < 60 ? `${seconds} 秒前` : `${Math.floor(seconds / 60)} 分钟前`;
  configPanel?.setSavedLabel(`自动存档 · ${when}`);
}

/** 内容占用的整小节数 */
function contentBars(): number {
  return Math.max(1, Math.ceil((studio.maxStep + 1) / MEASURE));
}

/** 曲长：有限模式 = bars*16；无限模式取内容与 bars 的较大者，上限 32 小节 */
function syncLength(): void {
  const content = contentBars();
  if (infinite) bars = Math.min(MAX_BARS, Math.max(bars, content));
  const length = (infinite ? Math.max(bars, content) : bars) * MEASURE;
  clock.setLength(Math.min(MAX_BARS * MEASURE, length));
  studio.setScrollable(clock.length > windowCols());
  hud.setLength(clock.length);
  hud.setEmpty(studio.blockCount === 0);
  syncPanel();
}

function syncPanel(): void {
  configPanel?.sync({
    bars,
    bpm: clock.bpm,
    loop,
    infinite,
    notes: studio.blockCount,
    windowCols: prefs.windowCols,
    masterGain: audio.masterGain,
    reverb: audio.reverbSend,
    canRestore: hasBackup(),
  });
}

function sameNotes(a: Note[], b: Note[]): boolean {
  if (a.length !== b.length) return false;
  const key = (n: Note): string => `${n.step}:${n.row}:${n.midi}`;
  const set = new Set(a.map(key));
  for (const note of b) if (!set.has(key(note))) return false;
  return true;
}

function applyState(next: SongStateInput, animate = false): void {
  // 旧调用只给 notes/bpm/infinite：归一化补 bars/loop，不切掉任何音符
  const state = normalizeState(next);
  // 整首替换（撤销 / 载入示例）时先停播，否则时钟继续走、HUD 却显示暂停
  if (clock.playing) clock.pause();
  infinite = state.infinite;
  bars = state.bars;
  loop = state.loop;
  hud.setInfinite(infinite);
  hud.setSettingsOpen(drawer?.isOpen ?? false);
  studio.setInfinite(infinite);
  clock.setLoop(loop);
  clock.setBpm(state.bpm);
  hud.setBpm(clock.bpm);
  studio.setSong(state.notes, animate, animate ? 0.014 : 0);
  syncLength();
  clock.seek(Math.min(clock.position, clock.length - 1));
  viewOffset = 0;
  if (studio.canScroll) studio.setWindow(Math.max(0, clock.position - windowCols() * 0.7), true);
  else studio.setWindow(0, true);
  hud.setPlaying(false);
  hud.setAtEnd(false);
  hud.setStep(clock.playing ? Math.floor(clock.position) % MEASURE : -1);
  hud.setProgress(clock.position, clock.length);
  hud.setEmpty(studio.blockCount === 0);
  markDirty();
  if (examplesDrawer?.isOpen) examplePanel?.refresh();
}

function undo(animated = false): void {
  hud.hideToast();
  const prev = history.undo(capture());
  if (!prev) {
    hud.showToast('没有可撤销的操作', null, null, 2000);
    return;
  }
  applyState(prev, animated);
  if (animated) {
    void unlock().then(() => {
      audio.restoreSweep();
      audio.sfx('sfx_click', 0, 1.08, 0.12);
    });
  }
}

function redo(): void {
  hud.hideToast();
  const next = history.redo(capture());
  if (!next) return;
  applyState(next);
  audio.sfx('sfx_click', 0, 1.2, 0.14);
}

function toggleInfinite(): void {
  void unlock();
  record('mode');
  infinite = !infinite;
  hud.setInfinite(infinite);
  studio.setInfinite(infinite);
  syncLength();
  viewOffset = 0;
  if (studio.canScroll) {
    if (infinite) studio.setWindow(Math.max(0, clock.position - windowCols() * 0.7), true);
    else studio.setWindow(0, true);
  }
  clock.seek(Math.min(clock.position, clock.length - 1));
  hud.setStep(clock.playing ? Math.floor(clock.position) % MEASURE : -1);
  hud.setProgress(clock.position, clock.length);
  hud.dismissHint();
  markDirty();
}

/** 曲长改动：不得小于最后一个音符所在小节，低于时夹住并提示 */
function setBars(target: number): void {
  const min = contentBars();
  const wanted = Math.max(1, Math.min(MAX_BARS, Math.round(target)));
  const next = clampBars(Math.max(min, wanted));
  if (next > wanted) hud.showToast(`第 ${min} 小节还有音符`, null, null, 2400);
  if (next === bars) {
    syncPanel();
    return;
  }
  record();
  bars = next;
  syncLength();
  if (clock.position > clock.length - 1) {
    clock.seek(clock.length - 1);
    hud.setProgress(clock.position, clock.length);
  }
  markDirty();
}

function setLoop(on: boolean): void {
  if (on === loop) return;
  record();
  loop = on;
  clock.setLoop(on);
  if (!on) {
    hud.setAtEnd(clock.atEnd);
    if (clock.atEnd) hud.setPlaying(false);
  }
  hud.setProgress(clock.position, clock.length);
  syncPanel();
  markDirty();
}

/** BPM 滑杆：一次手势只压一条历史 */
function setBpm(value: number, phase: GesturePhase): void {
  if (phase === 'start') record('bpm');
  const next = Math.max(60, Math.min(180, Math.round(value)));
  if (next === clock.bpm) {
    syncPanel();
    return;
  }
  clock.setBpm(next);
  hud.setBpm(clock.bpm);
  syncPanel();
  markDirty();
}

function setMasterGain(value: number): void {
  prefs.masterGain = Math.min(1, Math.max(0, value));
  audio.setMasterGain(prefs.masterGain);
  savePrefs(prefs);
  syncPanel();
}

function setReverb(value: number): void {
  prefs.reverb = Math.min(1, Math.max(0, value));
  audio.setReverbSend(prefs.reverb);
  savePrefs(prefs);
  syncPanel();
}

/** 窗口列数：配置面板 stepper 与边缘手柄共用；偏好单独存档，不进撤销栈 */
function setWindowCols(value: number): void {
  prefs.windowCols = clampWindowCols(value);
  savePrefs(prefs);
  studio.setWindowCols(prefs.windowCols);
  // 宽度变了，"一屏是否装得下"也跟着变
  syncLength();
  syncPanel();
}

/** 上一次 tick 的列数：每跨过一小节（4 列）敲一声 */
let dragTickCols = 0;

/** 边缘拖拽回调：偏好随手更新，松手时落定并重算曲长 / 滚动能力 */
function applyDraggedCols(cols: number, phase: 'start' | 'move' | 'end'): void {
  const snapped = clampWindowCols(cols);
  if (phase === 'start') {
    hud.dismissHint();
    dragTickCols = snapped;
  } else if (phase === 'move' && snapped !== dragTickCols) {
    // 每跨过一小节一声极轻的 tick，方向决定音高
    const up = snapped > dragTickCols;
    dragTickCols = snapped;
    audio.sfx('sfx_click', 0, up ? 1.14 : 0.98, 0.06);
  }
  prefs.windowCols = snapped;
  savePrefs(prefs);
  syncLength();
  syncPanel();
  if (phase === 'end') audio.sfx('sfx_click', 0, 1.04, 0.09);
}

function clearAll(): void {
  const count = studio.blockCount;
  if (!count) return;
  void (async () => {
    await unlock();
    record();
    audio.wipe();
    window.setTimeout(() => audio.thump(0.42), 280);
    studio.clearAnimated();
    syncLength();
    hud.setEmpty(true);
    hud.setProgress(Math.min(clock.position, clock.length - 1), clock.length);
    markDirty();
    hud.dismissHint();
    hud.showToast(`已清空 ${count} 个方块`, '撤销', () => undo(true), 5200);
  })();
}

function seekTo(step: number): void {
  void unlock();
  const target = Math.max(0, Math.min(MAX_STEPS - 1, Math.round(step)));
  clock.seek(target);
  viewOffset = 0;
  if (studio.canScroll) studio.setWindow(Math.max(0, target - windowCols() * 0.7), true);
  hud.setStep(clock.playing ? Math.floor(clock.position) % MEASURE : -1);
  hud.setProgress(clock.position, clock.length);
}

function rewind(): void {
  void unlock();
  clock.rewind();
  viewOffset = 0;
  studio.setWindow(0, true);
  hud.setStep(clock.playing ? 0 : -1);
  hud.setProgress(0, clock.length);
  audio.sfx('sfx_click', 0, 0.9, 0.14);
}

async function share(): Promise<void> {
  void unlock();
  const url = shareUrl(capture());
  try {
    await navigator.clipboard.writeText(url);
    hud.showToast('分享链接已复制到剪贴板', null, null, 2800);
  } catch {
    window.prompt('复制这个链接分享你的作品', url);
  }
}

// ---------------------------------------------------------------- audio unlock

let unlocked = false;
async function unlock(): Promise<void> {
  if (unlocked) return;
  unlocked = true;
  await audio.unlock();
}

window.addEventListener('pointerdown', () => void unlock(), { capture: true });
window.addEventListener('keydown', () => void unlock(), { capture: true });

// 音序器：调度时只排音频，视觉由 drainVisual 按同一时间点触发
const clock = new Clock(audio, (step, when) => {
  const delay = when - audio.now;
  for (const b of studio.blocksAtStep(step)) {
    if (mutedRows.has(b.row)) continue;
    audio.play(voice(b.row), b.midi, delay);
  }
});
hud.setBpm(clock.bpm);

function togglePlay(): void {
  void (async () => {
    await unlock();
    viewOffset = 0;
    if (clock.playing) {
      clock.pause();
      hud.setPlaying(false);
      hud.setAtEnd(clock.atEnd);
      return;
    }
    // 非循环播到末尾后，播放键 = 从头播
    if (clock.atEnd) {
      clock.rewind();
      studio.setWindow(0, true);
      hud.setProgress(0, clock.length);
      hud.setStep(0);
    }
    clock.play();
    hud.setPlaying(true);
    hud.setAtEnd(false);
    hud.dismissHint();
  })();
}

// ---------------------------------------------------------------- hud wiring

hud.onPlay = togglePlay;
hud.onRewind = rewind;
hud.onBpm = (delta) => {
  const next = Math.max(60, Math.min(180, clock.bpm + delta));
  if (next === clock.bpm) return;
  record('bpm');
  clock.setBpm(next);
  hud.setBpm(clock.bpm);
  syncPanel();
  markDirty();
};
hud.onMuteRow = (row) => {
  if (mutedRows.has(row)) mutedRows.delete(row);
  else mutedRows.add(row);
};
hud.onSound = () => {
  void unlock();
  audio.setMuted(!audio.muted);
  hud.setMuted(audio.muted);
};
hud.onView = (id) => {
  void unlock();
  studio.setView(id);
  audio.sfx('sfx_click', 0, id === 'persp' ? 1 : id === 'top' ? 1.12 : 1.26, 0.16);
};
studio.onResize = applyDraggedCols;
hud.onInfinite = toggleInfinite;
hud.onClear = clearAll;
hud.onShare = () => void share();
hud.onSeek = seekTo;
studio.onViewChange = (id) => hud.setView(id);
hud.onSettings = () => {
  examplesDrawer?.hide();
  drawer.toggle();
};
hud.onExamples = () => {
  drawer.hide();
  examplesDrawer?.toggle();
};
clock.onEnd = () => {
  hud.setPlaying(false);
  hud.setAtEnd(true);
  hud.setStep(-1);
  hud.setProgress(clock.length, clock.length);
};

// ---------------------------------------------------------------- 配置抽屉

const configPanel = new ConfigPanel(document.querySelector<HTMLElement>('#settings-body')!, {
  bars: (delta) => setBars(bars + delta),
  bpm: setBpm,
  loop: setLoop,
  infinite: () => toggleInfinite(),
  windowCols: setWindowCols,
  masterGain: (value) => setMasterGain(value),
  reverb: (value) => setReverb(value),
  share: () => void share(),
  restore: () => restoreBackup(),
  clear: clearAll,
});

const drawer = new Drawer({
  panel: document.querySelector<HTMLElement>('#settings-panel')!,
  scrim: document.querySelector<HTMLElement>('#drawer-scrim'),
  trigger: document.querySelector<HTMLElement>('#settings'),
  closeButton: document.querySelector<HTMLElement>('#settings-close'),
  onOpen: () => {
    hud.setSettingsOpen(true);
    syncPanel();
    updateSavedLabel();
  },
  onClose: () => hud.setSettingsOpen(false),
});

// ---------------------------------------------------------------- 示例抽屉

let examplePanel: ExamplePanel | null = null;
let examplesDrawer: Drawer | null = null;

examplePanel = new ExamplePanel(document.querySelector<HTMLElement>('#examples-body')!, {
  getState: capture,
  onLoad: (example) => loadExample(example),
});

examplesDrawer = new Drawer({
  panel: document.querySelector<HTMLElement>('#examples-panel')!,
  scrim: document.querySelector<HTMLElement>('#drawer-scrim'),
  trigger: document.querySelector<HTMLElement>('#examples'),
  closeButton: document.querySelector<HTMLElement>('#examples-close'),
  onOpen: () => {
    hud.setExamplesOpen(true);
    examplePanel?.refresh();
  },
  onClose: () => hud.setExamplesOpen(false),
});

/** 载入示例：先备份当前作品，再按列波次装配；撤销栈只留一条，Ctrl+Z 回到载入前 */
function loadExample(example: Example): void {
  void unlock();
  saveBackup(capture(), `载入《${example.name}》前`);
  hud.hideToast();
  history.push(capture());
  applyState(
    {
      notes: example.notes,
      bpm: example.bpm,
      infinite: example.infinite,
      bars: example.bars,
      loop: true,
    },
    true,
  );
  // 示例一律从头开始：不自动播放，也不继承上一首的播放位置
  clock.rewind();
  studio.setWindow(0, true);
  hud.setPlaying(false);
  hud.setAtEnd(false);
  hud.setStep(0);
  hud.setProgress(0, clock.length);
  examplePanel?.refresh();
  hud.showToast(`已载入《${example.name}》`, '撤销', () => undo(true), 5600);
  hud.dismissHint();
}

/** 从备份槽恢复上次载入示例/清空前的内容，跨刷新可用 */
function restoreBackup(): boolean {
  const backup = loadBackup();
  if (!backup) {
    hud.showToast('没有可恢复的作品', null, null, 2200);
    return false;
  }
  void unlock();
  hud.hideToast();
  history.push(capture());
  applyState(backup.state, true);
  clearBackup();
  syncPanel();
  hud.showToast(backup.label ? `已恢复：${backup.label}` : '已恢复上次载入前的作品', null, null, 3400);
  return true;
}

// ---------------------------------------------------------------- boot

const sharedCode = readShareCode();
const sharedState = sharedCode ? decodeSong(sharedCode) : null;
const savedState = sharedState ? null : loadLocal();
const initial: SongState = normalizeState(
  sharedState ??
    savedState ?? {
      notes: DEMO.map(([step, row, midi]) => ({ step, row, midi })),
      bpm: 108,
      infinite: false,
    },
);

infinite = initial.infinite;
bars = initial.bars;
loop = initial.loop;
hud.setInfinite(infinite);
hud.setMuted(audio.muted);
studio.setInfinite(infinite);
clock.setLoop(loop);
clock.setBpm(initial.bpm);
hud.setBpm(clock.bpm);
// 先按偏好定宽（会重建舞台），再装配曲子
studio.setWindowCols(prefs.windowCols);
studio.setSong(initial.notes, true);
syncLength();
studio.setWindow(0, true);
hud.setLength(clock.length);
hud.setEmpty(studio.blockCount === 0);
hud.setView(studio.view);
hud.setStep(-1);
hud.setProgress(0, clock.length);
if (savedState) lastSavedAt = Date.now();
updateSavedLabel();
if (sharedState) {
  // 分享链接只负责"第一次打开"，之后编辑走本地存档，避免刷新又回到旧分享
  window.history.replaceState(null, '', window.location.pathname);
  window.setTimeout(() => hud.showToast('已载入分享的作品', null, null, 3000), 900);
}

// ---------------------------------------------------------------- input

let orbit: { x: number; y: number } | null = null;
let hoverBlock: BlockView | null = null;

type StrokeMode = 'paint' | 'erase';

/** 一笔：paint 记新增，erase 记删除；松手时若真的改了曲子才压一次历史 */
interface Stroke {
  mode: StrokeMode;
  before: SongState;
  startRow: number;
  row: number;
  lastStep: number;
  lastRow: number;
  added: number;
  removed: number;
  pointerId: number;
  clientX: number;
  clientY: number;
  shift: boolean;
}

const PAINT_MIDI = 12;
/** 单次 pointermove 最多补的格数，防止异常事件刷爆 */
const MOVE_LIMIT = 32;
/** 同一批补格最多发声的数量，其余交给压缩器兜底 */
const SOUND_LIMIT = 8;
/** 画到窗口右缘后停留多久开始自动前移 */
const EDGE_HOLD_MS = 120;

let stroke: Stroke | null = null;
let edgeTimer = 0;
let edgeArmed = false;
let suppressContextUntil = 0;

const touchPoints = new Map<number, { x: number; y: number }>();
let pinch: { cx: number; cy: number; dist: number } | null = null;

/** 指针捕获：合成事件（自动化测试）没有真实 pointerId，捕获失败不应打断笔触 */
function capturePointer(id: number): void {
  try {
    canvas.setPointerCapture(id);
  } catch {
    /* ignored */
  }
}

function updateHover(e: PointerEvent): void {
  if (studio.isDragging) {
    studio.setHover(studio.dragTargetCell(), false);
    return;
  }
  hoverBlock = studio.pickBlock(e);
  const cell = studio.pointerToCell(e);
  studio.setHover(cell);
  if (hoverBlock) canvas.style.cursor = 'grab';
  else if (cell) canvas.style.cursor = 'crosshair';
  else canvas.style.cursor = 'default';
}

/** 上一格到当前格的网格插值：Bresenham，去掉起点、保留终点，最多 32 格 */
function lineCells(sx: number, sy: number, ex: number, ey: number): Cell[] {
  const cells: Cell[] = [];
  let x = sx;
  let y = sy;
  const dx = Math.abs(ex - sx);
  const dy = -Math.abs(ey - sy);
  const ux = sx < ex ? 1 : sx > ex ? -1 : 0;
  const uy = sy < ey ? 1 : sy > ey ? -1 : 0;
  let err = dx + dy;
  while ((x !== ex || y !== ey) && cells.length < MOVE_LIMIT) {
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += ux;
    }
    if (e2 <= dx) {
      err += dx;
      y += uy;
    }
    cells.push({ step: x, row: y });
  }
  return cells;
}

/** 补格：跳过已占用格；每格发声，同一批只发前 8 格 */
function paintCells(cells: Cell[]): number {
  let added = 0;
  let sounded = 0;
  for (const cell of cells) {
    if (cell.step < 0 || cell.step >= MAX_STEPS) break;
    if (studio.blockAt(cell.step, cell.row)) continue;
    if (!studio.addBlock(cell.step, cell.row, PAINT_MIDI, false, 0, true)) continue;
    added++;
    if (sounded < SOUND_LIMIT && !mutedRows.has(cell.row)) {
      audio.play(voice(cell.row), PAINT_MIDI, 0, 0.3);
      sounded++;
    }
  }
  return added;
}

function startStroke(e: PointerEvent, mode: StrokeMode, step: number, row: number): void {
  stroke = {
    mode,
    before: capture(),
    startRow: row,
    row,
    lastStep: step,
    lastRow: row,
    added: 0,
    removed: 0,
    pointerId: e.pointerId,
    clientX: e.clientX,
    clientY: e.clientY,
    shift: e.shiftKey,
  };
  capturePointer(e.pointerId);
  hud.hideToast();
  hud.dismissHint();
}

function startPaint(e: PointerEvent, exact: PaintCell): void {
  startStroke(e, 'paint', exact.step, exact.row);
  canvas.style.cursor = 'crosshair';
  audio.sfx('sfx_place', 0, 1.2, 0.22);
  const added = paintCells([{ step: exact.step, row: exact.row }]);
  if (stroke) stroke.added += added;
  studio.setHover({ step: exact.step, row: exact.row }, false);
  if (added) {
    syncLength();
    markDirty();
  }
  armEdgeScroll();
}

/** 笔触继续：行跟随指针（半格滞回）或 Shift 锁定起始行，中间格补齐 */
function advancePaint(exact: PaintCell, shift: boolean): void {
  const s = stroke;
  if (!s || s.mode !== 'paint') return;
  const row = shift ? s.startRow : studio.rowWithHysteresis(exact.lz, s.row);
  const cells = lineCells(s.lastStep, s.lastRow, exact.step, row);
  const added = cells.length ? paintCells(cells) : 0;
  s.added += added;
  s.row = row;
  s.lastStep = exact.step;
  s.lastRow = row;
  s.shift = shift;
  studio.setHover({ step: exact.step, row }, false);
  if (added) {
    syncLength();
    markDirty();
  }
  armEdgeScroll();
}

function eraseCell(step: number, row: number, sound: boolean): number {
  if (!studio.blockAt(step, row)) return 0;
  if (sound) audio.sfx('sfx_break', 0, 1, 0.34);
  studio.removeBlock(step, row);
  return 1;
}

function startErase(e: PointerEvent): void {
  const exact = studio.pointerToCellExact(e);
  const block = studio.pickBlock(e);
  if (!exact && !block) return;
  const step = exact ? exact.step : block!.step;
  const row = exact ? exact.row : block!.row;
  startStroke(e, 'erase', step, row);
  suppressContextUntil = performance.now() + 800;
  canvas.style.cursor = 'crosshair';
  let removed = eraseCell(step, row, true);
  // 透视下拾取到的是悬空方块，与地板格不同格时两处都擦
  if (block && (block.step !== step || block.row !== row)) removed += eraseCell(block.step, block.row, true);
  if (stroke) stroke.removed += removed;
  studio.setHover({ step, row }, false);
  if (removed) {
    syncLength();
    markDirty();
  }
}

function advanceErase(exact: PaintCell): void {
  const s = stroke;
  if (!s || s.mode !== 'erase') return;
  const cells = lineCells(s.lastStep, s.lastRow, exact.step, exact.row);
  let removed = 0;
  let sounded = 0;
  for (const cell of cells) {
    if (!studio.blockAt(cell.step, cell.row)) continue;
    const sound = sounded < 3;
    removed += eraseCell(cell.step, cell.row, sound);
    if (sound) sounded++;
  }
  s.removed += removed;
  s.lastStep = exact.step;
  s.lastRow = exact.row;
  studio.setHover({ step: exact.step, row: exact.row }, false);
  if (removed) {
    syncLength();
    markDirty();
  }
}

function finishStroke(): void {
  const s = stroke;
  stroke = null;
  disarmEdge();
  canvas.style.cursor = 'default';
  if (!s) return;
  if (s.mode === 'paint' ? s.added > 0 : s.removed > 0) history.push(s.before);
  studio.setHover(null);
  syncLength();
  markDirty();
}

function paintMove(e: PointerEvent): void {
  const s = stroke;
  if (!s) return;
  s.clientX = e.clientX;
  s.clientY = e.clientY;
  s.shift = e.shiftKey;
  const exact = studio.pointerToCellExact(e);
  if (!exact) {
    disarmEdge();
    return;
  }
  if (s.mode === 'paint') advancePaint(exact, s.shift);
  else advanceErase(exact);
}

function disarmEdge(): void {
  if (edgeTimer) {
    window.clearTimeout(edgeTimer);
    edgeTimer = 0;
  }
  edgeArmed = false;
}

/**
 * 画到窗口右缘 1 列内并停留 120ms：窗口前移 1 列，笔触继续。
 * 前移后同一屏幕位置对应的步数 +1，正好落在新的最右列上，所以不用重算光标。
 */
function armEdgeScroll(): void {
  const s = stroke;
  if (!s || s.mode !== 'paint' || !studio.canScroll) {
    disarmEdge();
    return;
  }
  const lastCol = Math.floor(studio.windowTarget + windowCols() - 1);
  if (s.lastStep < lastCol - 1) {
    disarmEdge();
    return;
  }
  if (edgeArmed) return;
  edgeArmed = true;
  edgeTimer = window.setTimeout(() => {
    edgeTimer = 0;
    edgeArmed = false;
    const p = stroke;
    if (!p || p.mode !== 'paint' || !studio.canScroll) return;
    // 有限长曲只在曲长内翻页；无限模式画到哪长到哪，上限仍是 32 小节
    const limit = infinite ? MAX_STEPS : clock.length;
    if (studio.windowTarget + windowCols() >= limit) {
      disarmEdge();
      return;
    }
    studio.setWindow(studio.windowTarget + 1);
    const exact = studio.pointerToCellExactAt({ clientX: p.clientX, clientY: p.clientY }, studio.windowTarget);
    if (exact) advancePaint(exact, p.shift);
    armEdgeScroll();
  }, EDGE_HOLD_MS);
}

function pinchFromTouches(): { cx: number; cy: number; dist: number } | null {
  if (touchPoints.size < 2) return null;
  const [a, b] = [...touchPoints.values()];
  return {
    cx: (a.x + b.x) / 2,
    cy: (a.y + b.y) / 2,
    dist: Math.hypot(a.x - b.x, a.y - b.y),
  };
}

canvas.addEventListener('pointerdown', (e) => {
  if (drawer.isOpen) return;
  // 边缘手柄拖拽优先于方块拾取 / 绘制
  if (studio.isResizing) return;
  void unlock();
  if (e.pointerType === 'touch') {
    touchPoints.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touchPoints.size >= 2) {
      // 双指：结束笔触，进入 orbit / 捏合
      if (stroke) finishStroke();
      if (studio.isDragging) commitDrag();
      orbit = null;
      pinch = pinchFromTouches();
      capturePointer(e.pointerId);
      canvas.style.cursor = 'grabbing';
      return;
    }
  }
  if (e.button === 2) {
    if (!stroke && !studio.isDragging) startErase(e);
    return;
  }
  if (e.button !== 0) return;
  const resizeSide = studio.hitResizeHandle(e);
  if (resizeSide) {
    studio.startResize(resizeSide, e);
    return;
  }
  hud.dismissHint();

  const block = studio.pickBlock(e);
  if (block && !stroke) {
    dragPre = capture();
    studio.beginDrag(block, e);
    capturePointer(e.pointerId);
    canvas.style.cursor = 'grabbing';
    return;
  }

  const exact = studio.pointerToCellExact(e);
  if (exact && !stroke) {
    startPaint(e, exact);
    return;
  }

  if (!stroke) {
    orbit = { x: e.clientX, y: e.clientY };
    capturePointer(e.pointerId);
    canvas.style.cursor = 'grabbing';
  }
});

canvas.addEventListener('pointermove', (e) => {
  // 边缘拖拽中：手势归 Studio 的 window 监听，画布不再 hover / 绘制
  if (studio.isResizing) return;
  if (e.pointerType === 'touch' && touchPoints.has(e.pointerId)) {
    touchPoints.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && touchPoints.size >= 2) {
      const next = pinchFromTouches();
      if (next) {
        studio.orbit(next.cx - pinch.cx, next.cy - pinch.cy);
        if (Math.abs(next.dist - pinch.dist) > 2) studio.zoom((pinch.dist - next.dist) * 0.16);
        pinch = next;
      }
      return;
    }
  }
  studio.parallax(e);
  if (studio.isDragging) {
    studio.dragTo(e);
    studio.setHover(studio.dragTargetCell(), false);
    return;
  }
  if (orbit) {
    studio.orbit(e.clientX - orbit.x, e.clientY - orbit.y);
    orbit = { x: e.clientX, y: e.clientY };
    return;
  }
  if (stroke) {
    paintMove(e);
    return;
  }
  updateHover(e);
});

/** 块拖动落定：动量、选格、交换、越界删除；返回是否删除 */
function commitDrag(): { removed: boolean; drop: Cell | null } {
  const before = dragPre;
  const drop = studio.dragTargetCell();
  const { removed } = studio.endDrag();
  const after = capture();
  if (before && (removed || !sameNotes(before.notes, after.notes))) history.push(before);
  dragPre = null;
  audio.sfx(removed ? 'sfx_break' : 'sfx_place', 0, removed ? 0.95 : 0.85, removed ? 0.5 : 0.28);
  canvas.style.cursor = 'default';
  // 拖到窗口最右一列：松手后让出 4 列，像翻页
  if (studio.canScroll && !removed && drop && drop.step >= studio.windowStart + windowCols() - 1) {
    studio.setWindow(studio.windowTarget + 4);
  }
  syncLength();
  markDirty();
  return { removed, drop };
}

function endPointer(e: PointerEvent): void {
  if (e.pointerType === 'touch') {
    touchPoints.delete(e.pointerId);
    if (touchPoints.size < 2) pinch = null;
  }
  if (studio.isResizing) return;
  if (stroke) finishStroke();
  if (studio.isDragging) commitDrag();
  if (orbit) {
    orbit = null;
    canvas.style.cursor = 'default';
  }
  if (!stroke && !studio.isDragging && !orbit) updateHover(e);
}

canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', () => {
  studio.pointerNearEdge(null);
  if (!studio.isDragging && !stroke) {
    studio.setHover(null);
    hoverBlock = null;
  }
});

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    if (stroke) return;
    const block = studio.pickBlock(e);
    if (block && !studio.isDragging) {
      const dir = e.deltaY > 0 ? -1 : 1;
      const midi = Math.max(MIN_MIDI, Math.min(MAX_MIDI, block.midi + dir));
      if (midi !== block.midi) {
        record(`pitch:${block.step}:${block.row}`);
        studio.setPitch(block.step, block.row, midi);
        audio.play(voice(block.row), midi, 0, 0.8);
        markDirty();
      }
      return;
    }
    if (studio.canScroll && (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY))) {
      if (studio.isDragging) return;
      const delta = (e.shiftKey ? e.deltaY : e.deltaX) * 0.02;
      if (Math.abs(delta) < 0.01) return;
      viewOffset += delta;
      if (!clock.playing) studio.setWindow(studio.windowTarget + delta);
      return;
    }
    studio.zoom(e.deltaY);
  },
  { passive: false },
);

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  // 右键按下已经进入连续擦除，这一次 contextmenu 不再重复删
  if (performance.now() < suppressContextUntil) return;
  const block = studio.pickBlock(e);
  if (!block) return;
  record();
  audio.sfx('sfx_break', 0, 1, 0.5);
  studio.removeBlock(block.step, block.row);
  studio.setHover(null);
  hoverBlock = null;
  syncLength();
  markDirty();
});

type PresetView = 'persp' | 'top' | 'front';
const VIEW_CYCLE: PresetView[] = ['persp', 'top', 'front'];
function nextView(): PresetView {
  const current = studio.view as PresetView;
  const index = VIEW_CYCLE.indexOf(current);
  return VIEW_CYCLE[(index < 0 ? 0 : index + 1) % VIEW_CYCLE.length];
}

window.addEventListener('keydown', (e) => {
  const el = e.target as HTMLElement | null;
  if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
  const mod = e.metaKey || e.ctrlKey;

  if (mod && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
    return;
  }
  if (mod && (e.key === 'y' || e.key === 'Y')) {
    e.preventDefault();
    redo();
    return;
  }
  if (e.code === 'Space' && el?.tagName !== 'BUTTON') {
    e.preventDefault();
    togglePlay();
  }
  if (e.key === ',' || e.key === '，') {
    e.preventDefault();
    drawer.toggle();
    return;
  }
  if (e.key === 'e' || e.key === 'E') {
    e.preventDefault();
    drawer.hide();
    examplesDrawer?.toggle();
    return;
  }
  if (e.key === 'Escape') {
    if (studio.isResizing) {
      e.preventDefault();
      studio.cancelResize();
      return;
    }
    if (drawer.isOpen) {
      e.preventDefault();
      drawer.hide();
      return;
    }
    if (examplesDrawer?.isOpen) {
      e.preventDefault();
      examplesDrawer.hide();
      return;
    }
  }
  if (e.key === '1' || e.key === '2' || e.key === '3') {
    const id = e.key === '1' ? 'persp' : e.key === '2' ? 'top' : 'front';
    hud.onView?.(id);
  }
  if (e.key === 'v' || e.key === 'V') hud.onView?.(nextView());
  if (e.key === 'i' || e.key === 'I') toggleInfinite();
  if (e.key === 'Home') {
    e.preventDefault();
    rewind();
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && hoverBlock) {
    e.preventDefault();
    record();
    audio.sfx('sfx_break', 0, 1, 0.5);
    studio.removeBlock(hoverBlock.step, hoverBlock.row);
    hoverBlock = null;
    syncLength();
    markDirty();
  }
});

window.addEventListener('beforeunload', () => saveLocal(capture()));

// ---------------------------------------------------------------- frame

window.addEventListener('resize', () => studio.resize());

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
  last = now;

  clock.update();
  if (clock.playing) {
    for (const step of clock.drainVisual(audio.now)) studio.hit(step);
  }

  const pos = clock.position;
  const active = clock.playing || pos > 0.01;
  studio.setPlayhead(pos);
  studio.setPlayheadVisible(active);
  hud.setStep(active ? Math.floor(pos) % MEASURE : -1);
  hud.setMeasure(Math.floor(pos / MEASURE), Math.max(1, clock.length / MEASURE));
  hud.setProgress(pos, clock.length);

  if (studio.canScroll && !studio.isDragging && !studio.isResizing) {
    if (prevPos - pos > 1) {
      // 循环回卷：窗口直接归位，不做倒带长滑
      viewOffset = 0;
      studio.setWindow(Math.max(0, pos - windowCols() * 0.7), true);
    } else if (clock.playing) {
      studio.setWindow(Math.max(0, pos - windowCols() * 0.7 + viewOffset));
    }
  }
  prevPos = pos;

  studio.update(dt);
  studio.render();

  requestAnimationFrame(frame);
}

// 调试/QA 钩子（放一次即可，别每帧赋值）
Object.assign(window, {
  __studio: studio,
  __clock: clock,
  __audio: audio,
  __hud: hud,
  __config: configPanel,
  __drawer: drawer,
  get __examplesDrawer() {
    return examplesDrawer;
  },
  get __examples() {
    return examplePanel;
  },
});
Object.assign(window, {
  __nb: {
    capture,
    applyState,
    undo,
    redo,
    seekTo,
    history,
    share: () => shareUrl(capture()),
    clearAll,
    toggleInfinite,
    setBars,
    setLoop,
    setWindowCols,
    loadExample: (id: string) => {
      const example = EXAMPLES.find((e) => e.id === id);
      if (example) loadExample(example);
      return !!example;
    },
    restoreBackup,
    backup: () => loadBackup(),
    hasBackup: () => hasBackup(),
    examples: EXAMPLES,
    openExamples: () => {
      drawer.hide();
      examplesDrawer?.show();
    },
    syncLength,
    decode: decodeSong,
    get infinite() {
      return infinite;
    },
    get bars() {
      return bars;
    },
    get loop() {
      return loop;
    },
    get prefs() {
      return { ...prefs };
    },
  },
});

requestAnimationFrame(frame);

// 首屏淡出
window.setTimeout(() => document.body.classList.add('ready'), 620);

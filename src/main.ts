import './style.css';
import { AudioEngine, Clock } from './audio';
import { ConfigPanel, type GesturePhase } from './config-panel';
import { Drawer } from './drawer';
import { ExamplePanel } from './example-panel';
import { EXAMPLES, type Example } from './examples';
import { GestureController, type GestureHost } from './gestures';
import { Hud } from './hud';
import { formatHover } from './note-label';
import { NotePanel } from './note-panel';
import { SaveCoordinator, saveStatusText } from './persistence';
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
  MAX_BARS_FINITE,
  MAX_STEPS,
  normalizeState,
  readShareCode,
  saveBackup,
  shareUrl,
  storageAvailable,
  type Note,
  type SongState,
  type SongStateInput,
} from './song';
import { ViewportWatcher } from './viewport';

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
const readoutEl = document.querySelector<HTMLElement>('#readout')!;

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
let dragFrom: Cell | null = null;

interface Selection {
  step: number;
  row: number;
  midi: number;
}
/** UI 选择：不持久化、不进分享与撤销；坐标 + 音高用于确认还是同一个音符 */
let selected: Selection | null = null;
/** 绘制 / 擦除期间先保留编辑条，抬笔后再收起，避免中途改变有效视口导致取格偏移 */
let clearSelectionAfterStroke = false;

// 抽屉 / 面板引用在函数里使用，构造顺序靠后
let configPanel: ConfigPanel | null = null;
let drawer: Drawer | null = null;
let examplesDrawer: Drawer | null = null;
let helpDrawer: Drawer | null = null;
let examplePanel: ExamplePanel | null = null;
let notePanel: NotePanel | null = null;
let viewport: ViewportWatcher | null = null;
let gestures: GestureController | null = null;
let rowsUserSet = false;
let rowsInit = false;

const capture = (): SongState => ({
  notes: studio.getNotes(),
  bpm: clock.bpm,
  infinite,
  bars,
  loop,
});

const record = (key?: string): void => {
  // 只要发生了新的可撤销操作，旧提示的"撤销"就不再指向那次操作了
  hud.hideFeedback();
  history.record(capture(), key);
};

const persistence = new SaveCoordinator({
  getState: capture,
  onStatus: () => refreshSaveStatus(),
});

function markDirty(): void {
  persistence.markDirty();
}

function refreshSaveStatus(): void {
  const snap = persistence.snapshot;
  const text = saveStatusText(snap, Date.now());
  configPanel?.setSaveState(snap.status, text);
  hud.setSaveStatus(snap.status, text, snap.status === 'failed');
}

history.onChange = () => hud.setHistory(history.canUndo, history.canRedo);
hud.setHistory(false, false);

/** 内容占用的整小节数 */
function contentBars(): number {
  return Math.max(1, Math.ceil((studio.maxStep + 1) / MEASURE));
}

/** 曲长：有限模式 = bars*16；无限模式完全由内容决定，上限为工程安全边界 */
function syncLength(): void {
  const content = contentBars();
  if (infinite) bars = Math.max(1, Math.min(MAX_BARS, content));
  const length = clampBars(bars, infinite ? MAX_BARS : MAX_BARS_FINITE) * MEASURE;
  clock.setLength(Math.min(MAX_STEPS, length));
  // 无限模式始终允许滑动窗口：1 小节空曲也要能从右缘继续生长；
  // windowLimit 只比曲末多 1 列，避免窗口滑进大片空白。
  studio.setStepLimit(infinite ? MAX_STEPS : clock.length);
  studio.setWindowLimit(clock.length + (infinite ? 1 : 0));
  studio.setScrollable(infinite || clock.length > windowCols());
  hud.setLength(clock.length);
  hud.setTiming(60 / (clock.bpm * 4));
  hud.setEmpty(studio.blockCount === 0);
  syncPanel();
}

let panelSyncQueued = false;
function syncPanel(): void {
  // 绘制笔触时每个格子都会触发；用 rAF 合并，避免反复读 hasBackup / 重写面板
  if (panelSyncQueued) return;
  panelSyncQueued = true;
  requestAnimationFrame(() => {
    panelSyncQueued = false;
    configPanel?.sync({
      bars,
      bpm: clock.bpm,
      loop,
      infinite,
      notes: studio.blockCount,
      windowCols: prefs.windowCols,
      masterGain: audio.masterGain,
      reverb: audio.reverbSend,
      lengthSteps: clock.length,
      canRestore: hasBackup(),
      saveStatus: persistence.snapshot.status,
    });
  });
}

function sameNotes(a: Note[], b: Note[]): boolean {
  if (a.length !== b.length) return false;
  const key = (n: Note): string => `${n.step}:${n.row}:${n.midi}`;
  const set = new Set(a.map(key));
  for (const note of b) if (!set.has(key(note))) return false;
  return true;
}

// ---------------------------------------------------------------- selection

function selectNote(cell: Cell): void {
  const block = studio.blockAt(cell.step, cell.row);
  if (!block) {
    clearSelection();
    return;
  }
  selected = { step: block.step, row: block.row, midi: block.midi };
  studio.setSelection(selected);
  syncNotePanel();
}

function clearSelection(): void {
  const wasOpen = notePanel?.isOpen ?? false;
  selected = null;
  studio.setSelection(null);
  notePanel?.hide();
  document.body.classList.remove('note-open');
  hideReadout();
  if (wasOpen) viewport?.refresh();
}

function pauseNotePanel(): void {
  if (!notePanel?.isOpen) return;
  notePanel.hide();
  document.body.classList.remove('note-open');
  viewport?.refresh();
}

function resumeNotePanel(): void {
  window.setTimeout(() => {
    if (anyDrawerOpen()) return;
    if (selected) verifySelection();
  }, 0);
}

/** 撤销 / 重做 / 载入后重新确认选择仍指向同一个音符 */
function verifySelection(): void {
  if (!selected) {
    studio.setSelection(null);
    notePanel?.hide();
    return;
  }
  const block = studio.blockAt(selected.step, selected.row);
  if (!block || block.midi !== selected.midi) {
    clearSelection();
    return;
  }
  studio.setSelection(selected);
  syncNotePanel();
}

function syncNotePanel(): void {
  if (!selected) {
    notePanel?.hide();
    return;
  }
  // 模态抽屉打开时收起编辑条；选择本身保留，关闭抽屉后恢复
  if (anyDrawerOpen()) {
    pauseNotePanel();
    return;
  }
  const block = studio.blockAt(selected.step, selected.row);
  if (!block || block.midi !== selected.midi) {
    clearSelection();
    return;
  }
  const wasOpen = notePanel?.isOpen ?? false;
  notePanel?.show({
    step: block.step,
    row: block.row,
    midi: block.midi,
    rowLabel: ROWS[block.row].label,
    voice: ROWS[block.row].voice,
    canDown: block.midi > MIN_MIDI,
    canUp: block.midi < MAX_MIDI,
  });
  document.body.classList.add('note-open');
  if (!wasOpen) viewport?.refresh();
}

function shiftSelected(delta: -1 | 1): void {
  if (!selected) return;
  const block = studio.blockAt(selected.step, selected.row);
  if (!block) {
    clearSelection();
    return;
  }
  const next = Math.max(MIN_MIDI, Math.min(MAX_MIDI, block.midi + delta));
  if (next === block.midi) {
    syncNotePanel();
    return;
  }
  record(`pitch:${block.step}:${block.row}`);
  studio.setPitch(block.step, block.row, next);
  audio.play(voice(block.row), next, 0, 0.8);
  selected = { step: block.step, row: block.row, midi: next };
  syncNotePanel();
  markDirty();
}

function previewSelected(): void {
  if (!selected) return;
  const block = studio.blockAt(selected.step, selected.row);
  if (!block) return;
  void unlock().then(() => audio.play(voice(block.row), block.midi, 0, 1));
}

function deleteSelected(): void {
  if (!selected) return;
  const block = studio.blockAt(selected.step, selected.row);
  if (!block) {
    clearSelection();
    return;
  }
  const { step, row } = block;
  record();
  audio.sfx('sfx_break', 0, 1, 0.5);
  studio.removeBlock(step, row);
  clearSelection();
  hoverBlock = null;
  studio.setHover(null);
  syncLength();
  markDirty();
}

// ---------------------------------------------------------------- 状态切换

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
  verifySelection();
  markDirty();
  if (examplesDrawer?.isOpen) examplePanel?.refresh();
}

function undo(animated = false): void {
  hud.hideFeedback();
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
  hud.hideFeedback();
  const next = history.redo(capture());
  if (!next) return;
  applyState(next);
  audio.sfx('sfx_click', 0, 1.2, 0.14);
}

function toggleInfinite(): void {
  void unlock();
  const content = contentBars();
  if (infinite && content > MAX_BARS_FINITE) {
    hud.showToast(`内容已有 ${content} 小节，先删减到 ${MAX_BARS_FINITE} 小节以内`, null, null, 3000);
    return;
  }
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
  hud.showToast(
    infinite ? '无限模式：写到哪，曲子就长到哪' : `已回到有限模式（最多 ${MAX_BARS_FINITE} 小节）`,
    null,
    null,
    2400,
  );
  markDirty();
}

/** 曲长改动：只服务有限模式；不得小于最后一个音符所在小节 */
function setBars(target: number): void {
  if (infinite) {
    syncPanel();
    return;
  }
  const min = Math.min(MAX_BARS_FINITE, contentBars());
  const wanted = Math.max(1, Math.min(MAX_BARS_FINITE, Math.round(target)));
  const next = clampBars(Math.max(min, wanted), MAX_BARS_FINITE);
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
  hud.setTiming(60 / (clock.bpm * 4));
  syncPanel();
  markDirty();
}

/** 播放栏里就地输入的 BPM：一次提交一条历史 */
function setBpmValue(value: number): void {
  const next = Math.max(60, Math.min(180, Math.round(value)));
  if (!Number.isFinite(next) || next === clock.bpm) {
    syncPanel();
    return;
  }
  record('bpm');
  clock.setBpm(next);
  hud.setBpm(clock.bpm);
  hud.setTiming(60 / (clock.bpm * 4));
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

/** 抽屉内触发的操作把反馈留在抽屉里；否则回到主页面 */
function feedbackTarget(): 'page' | 'settings' | 'examples' {
  if (drawer?.isOpen) return 'settings';
  if (examplesDrawer?.isOpen) return 'examples';
  return 'page';
}

function showOperationFeedback(
  text: string,
  actionLabel: string | null,
  onAction: (() => void) | null,
  ttl = 5200,
  focusAction = false,
): void {
  const target = feedbackTarget();
  if (target === 'page') hud.showToast(text, actionLabel, onAction, ttl, focusAction);
  else hud.showDrawerFeedback(target, text, actionLabel, onAction, ttl, focusAction);
}

function backupWarning(result: { ok: boolean }): string {
  return result.ok ? '' : ' · 备份失败，刷新后无法恢复';
}

function clearAll(): void {
  const count = studio.blockCount;
  if (!count) return;
  const backup = saveBackup(capture(), '清空前');
  void unlock();
  record();
  audio.wipe();
  window.setTimeout(() => audio.thump(0.42), 280);
  const cleared = studio.clearAnimated();
  clearSelection();
  syncLength();
  hud.setEmpty(true);
  hud.setProgress(Math.min(clock.position, clock.length - 1), clock.length);
  markDirty();
  hud.dismissHint();
  showOperationFeedback(
    `已清空 ${cleared || count} 个音符${backupWarning(backup)}`,
    '撤销',
    () => undo(true),
    5600,
    true,
  );
  syncPanel();
}

function seekTo(step: number): void {
  void unlock();
  const target = Math.max(0, Math.min(clock.length - 1, Math.round(step)));
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
  const long = url.length > 8000;
  try {
    await navigator.clipboard.writeText(url);
    showOperationFeedback(
      long ? '分享链接较长，部分应用可能会截断' : '分享链接已复制到剪贴板',
      null,
      null,
      2800,
    );
  } catch {
    // 不能把「链接已生成」当成「已复制」：把链接放到地址栏，交给用户手动复制
    window.history.replaceState(null, '', url);
    showOperationFeedback('未能自动复制，链接已放到地址栏，可直接复制', null, null, 6000);
  }
}

// ---------------------------------------------------------------- audio unlock

let unlocked = false;
async function unlock(): Promise<void> {
  if (unlocked) return;
  unlocked = true;
  await audio.unlock();
}

window.addEventListener(
  'pointerdown',
  (e) => {
    void unlock();
    const touch = e.pointerType === 'touch' || e.pointerType === 'pen';
    document.body.dataset.input = touch ? 'touch' : 'mouse';
  },
  { capture: true },
);
window.addEventListener('keydown', () => void unlock(), { capture: true });

document.body.dataset.input =
  typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches ? 'touch' : 'mouse';

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
  hud.setTiming(60 / (clock.bpm * 4));
  syncPanel();
  markDirty();
};
hud.onBpmValue = setBpmValue;
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
hud.onFitStage = () => {
  void unlock();
  studio.fitStage();
  audio.sfx('sfx_click', 0, 1.06, 0.12);
};
studio.onResize = applyDraggedCols;
hud.onInfinite = toggleInfinite;
hud.onClear = clearAll;
hud.onShare = () => void share();
hud.onSeek = seekTo;
hud.onUndo = () => undo();
hud.onRedo = redo;
hud.onRowsToggle = () => {
  rowsUserSet = true;
  viewport?.refresh();
};
hud.onHintDismiss = () => {
  prefs.helpSeen = true;
  savePrefs(prefs);
};
hud.onRetrySave = () => {
  const result = persistence.retry();
  refreshSaveStatus();
  syncPanel();
  if (result.ok) hud.showToast('已保存到此浏览器', null, null, 2200);
  else hud.showToast('仍未保存到本机', null, null, 2600);
};

let scrubWasPlaying = false;
hud.onScrubStart = (step) => {
  scrubWasPlaying = clock.playing;
  if (clock.playing) {
    clock.pause();
    hud.setPlaying(false);
    hud.setAtEnd(clock.atEnd);
  }
  seekTo(step);
};
hud.onScrubMove = (step) => seekTo(step);
hud.onScrubEnd = (step) => {
  seekTo(step);
  const resume = scrubWasPlaying;
  scrubWasPlaying = false;
  if (resume) togglePlay();
};
studio.onViewChange = (id) => hud.setView(id);
clock.onEnd = () => {
  hud.setPlaying(false);
  hud.setAtEnd(true);
  hud.setStep(-1);
  hud.setProgress(clock.length, clock.length);
};

// ---------------------------------------------------------------- 配置抽屉

configPanel = new ConfigPanel(document.querySelector<HTMLElement>('#settings-body')!, {
  bars: (delta) => setBars(bars + delta),
  barsValue: (value) => setBars(value),
  bpm: setBpm,
  loop: setLoop,
  infinite: () => toggleInfinite(),
  windowCols: setWindowCols,
  masterGain: (value) => setMasterGain(value),
  reverb: (value) => setReverb(value),
  share: () => void share(),
  restore: () => restoreBackup(),
  clear: clearAll,
  retrySave: () => {
    const result = persistence.retry();
    refreshSaveStatus();
    syncPanel();
    if (!result.ok) hud.showToast('仍未保存到本机', null, null, 2600);
  },
});

drawer = new Drawer({
  panel: document.querySelector<HTMLElement>('#settings-panel')!,
  scrim: document.querySelector<HTMLElement>('#drawer-scrim'),
  trigger: document.querySelector<HTMLElement>('#settings'),
  closeButton: document.querySelector<HTMLElement>('#settings-close'),
  onOpen: () => {
    hud.setSettingsOpen(true);
    examplesDrawer?.hide();
    helpDrawer?.hide();
    gestures?.cancelAll();
    pauseNotePanel();
    syncPanel();
    refreshSaveStatus();
  },
  onClose: () => {
    hud.setSettingsOpen(false);
    hud.transferFeedback('settings');
    gestures?.cancelAll();
    resumeNotePanel();
    viewport?.refresh();
  },
});

// ---------------------------------------------------------------- 示例抽屉

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
    drawer?.hide();
    helpDrawer?.hide();
    gestures?.cancelAll();
    pauseNotePanel();
    examplePanel?.refresh();
  },
  onClose: () => {
    hud.setExamplesOpen(false);
    hud.transferFeedback('examples');
    gestures?.cancelAll();
    resumeNotePanel();
    viewport?.refresh();
  },
});

// ---------------------------------------------------------------- 玩法抽屉

helpDrawer = new Drawer({
  panel: document.querySelector<HTMLElement>('#help-panel')!,
  scrim: document.querySelector<HTMLElement>('#drawer-scrim'),
  trigger: document.querySelector<HTMLElement>('#help'),
  closeButton: document.querySelector<HTMLElement>('#help-close'),
  onOpen: () => {
    hud.setHelpOpen(true);
    drawer?.hide();
    examplesDrawer?.hide();
    gestures?.cancelAll();
    pauseNotePanel();
  },
  onClose: () => {
    hud.setHelpOpen(false);
    gestures?.cancelAll();
    resumeNotePanel();
    viewport?.refresh();
  },
});

hud.onSettings = () => {
  examplesDrawer?.hide();
  helpDrawer?.hide();
  drawer?.toggle();
};
hud.onExamples = () => {
  drawer?.hide();
  helpDrawer?.hide();
  examplesDrawer?.toggle();
};
hud.onHelp = () => {
  drawer?.hide();
  examplesDrawer?.hide();
  helpDrawer?.toggle();
};

// ---------------------------------------------------------------- 音符编辑条

notePanel = new NotePanel(document.querySelector<HTMLElement>('#note-panel')!, {
  onShift: (delta) => shiftSelected(delta),
  onPreview: () => previewSelected(),
  onDelete: () => deleteSelected(),
  onClose: () => clearSelection(),
});

/** 载入示例：先备份当前作品，再按列波次装配；撤销栈只留一条，Ctrl+Z 回到载入前 */
function loadExample(example: Example): void {
  void unlock();
  const backup = saveBackup(capture(), `载入《${example.name}》前`);
  hud.hideFeedback();
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
  showOperationFeedback(
    `已载入《${example.name}》${backupWarning(backup)}`,
    '撤销',
    () => undo(true),
    5600,
  );
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
  hud.hideFeedback();
  history.push(capture());
  applyState(backup.state, true);
  clearBackup();
  syncPanel();
  showOperationFeedback(backup.label ? `已恢复：${backup.label}` : '已恢复上次载入前的作品', null, null, 3400);
  return true;
}

// ---------------------------------------------------------------- viewport

viewport = new ViewportWatcher(canvas, (info) => {
  document.body.dataset.mode = info.mode;
  if (!rowsInit) {
    rowsInit = true;
    if (!rowsUserSet) hud.setRowsOpen(info.mode === 'desktop');
  }
  if (info.orientationChanged) {
    // 方向变了：旧坐标不再有效，结束当前手势，视图由场景重新适配
    gestures?.cancelAll();
    if (!rowsUserSet) hud.setRowsOpen(info.mode === 'desktop');
  }
  // 先同步画布尺寸，再把可用矩形交给相机
  studio.resize();
  studio.setStageRect(info.rect);
});
viewport.start();

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
persistence.adoptSavedAt(savedState ? Date.now() : null);
if (!storageAvailable()) {
  persistence.adoptFailure('unavailable');
}
refreshSaveStatus();
if (prefs.helpSeen) hud.dismissHint();
if (sharedState) {
  // 分享链接只负责"第一次打开"，之后编辑走本地存档，避免刷新又回到旧分享
  window.history.replaceState(null, '', window.location.pathname);
  window.setTimeout(() => hud.showToast('已载入分享的作品', null, null, 3000), 900);
}

// ---------------------------------------------------------------- input / strokes

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

function updateReadout(cell: Cell | null, block: BlockView | null): void {
  if (!cell || document.body.dataset.input === 'touch' || document.body.classList.contains('drawer-open')) {
    hideReadout();
    return;
  }
  readoutEl.textContent = formatHover(cell.step, ROWS[cell.row].label, ROWS[cell.row].voice, block?.midi ?? null);
  readoutEl.hidden = false;
}

function hideReadout(): void {
  readoutEl.hidden = true;
}

function updateHover(e: PointerEvent): void {
  if (studio.isDragging) {
    studio.setHover(studio.dragTargetCell(), false);
    hideReadout();
    return;
  }
  hoverBlock = studio.pickBlock(e);
  const cell = studio.pointerToCell(e);
  studio.setHover(cell);
  updateReadout(cell, hoverBlock);
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
  const limit = infinite ? MAX_STEPS : Math.min(MAX_STEPS, clock.length);
  for (const cell of cells) {
    if (cell.step < 0 || cell.step >= limit) break;
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
  hud.hideFeedback();
  hud.dismissHint();
  hideReadout();
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

function strokeMove(e: PointerEvent): void {
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

function finishStroke(): void {
  const s = stroke;
  stroke = null;
  disarmEdge();
  canvas.style.cursor = 'default';
  if (!s) return;
  if (s.mode === 'paint' ? s.added > 0 : s.removed > 0) history.push(s.before);
  studio.setHover(null);
  hoverBlock = null;
  syncLength();
  markDirty();
  settleStrokeSelection();
}

/** 多指接管 / pointercancel：回滚本次尚未结束的笔触，不产生历史 */
function cancelStroke(): void {
  const s = stroke;
  stroke = null;
  disarmEdge();
  canvas.style.cursor = 'default';
  if (!s) return;
  studio.setSong(s.before.notes, false);
  studio.setHover(null);
  hoverBlock = null;
  syncLength();
  markDirty();
  settleStrokeSelection();
}

/** 笔触结束后再收起编辑条：活动期间舞台矩形保持不变，取格不偏移 */
function settleStrokeSelection(): void {
  if (!clearSelectionAfterStroke) return;
  clearSelectionAfterStroke = false;
  clearSelection();
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
    // 无限模式可以画到曲末下一列；画出新音符后 syncLength 会把曲长顶上去
    const limit = infinite ? clock.length + 1 : clock.length;
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

/** 块拖动落定：动量、选格、交换、越界删除；返回是否删除 */
function commitDrag(): { removed: boolean; drop: Cell | null } {
  const before = dragPre;
  const from = dragFrom;
  const landed = studio.endDrag();
  const { removed } = landed;
  const drop = removed ? null : { step: landed.step, row: landed.row };
  const after = capture();
  if (before && (removed || !sameNotes(before.notes, after.notes))) history.push(before);
  dragPre = null;
  dragFrom = null;
  audio.sfx(removed ? 'sfx_break' : 'sfx_place', 0, removed ? 0.95 : 0.85, removed ? 0.5 : 0.28);
  canvas.style.cursor = 'default';
  // 拖到窗口最右一列：松手后让出 4 列，像翻页
  if (studio.canScroll && !removed && drop && drop.step >= studio.windowStart + windowCols() - 1) {
    studio.setWindow(studio.windowTarget + 4);
  }
  syncLength();
  markDirty();
  if (removed) {
    clearSelection();
  } else if (drop) {
    const block = studio.blockAt(drop.step, drop.row);
    if (block) selectNote({ step: block.step, row: block.row });
    else if (from) clearSelection();
  }
  return { removed, drop };
}

// ---------------------------------------------------------------- gestures

const gestureHost: GestureHost = {
  isBlocked: () =>
    document.body.classList.contains('drawer-open') ||
    (drawer?.isOpen ?? false) ||
    (examplesDrawer?.isOpen ?? false) ||
    (helpDrawer?.isOpen ?? false) ||
    studio.isResizing,
  hitResizeHandle: (e) => studio.hitResizeHandle(e),
  startResize: (side, e) => studio.startResize(side, e),
  pickBlock: (e) => {
    const block = studio.pickBlock(e);
    return block ? { step: block.step, row: block.row } : null;
  },
  cellAt: (e) => studio.pointerToCellExact(e),

  notePointerDown: () => {
    dragPre = capture();
    dragFrom = null;
    hud.dismissHint();
  },
  noteDragStart: (note, origin) => {
    const block = studio.blockAt(note.step, note.row);
    if (!block) return;
    dragFrom = { step: note.step, row: note.row };
    dragPre = capture();
    studio.beginDrag(block, origin);
  },
  noteDragMove: (e) => {
    studio.dragTo(e);
    studio.setHover(studio.dragTargetCell(), false);
  },
  noteDragEnd: () => {
    commitDrag();
  },
  noteDragCancel: () => {
    studio.cancelDrag();
    dragPre = null;
    dragFrom = null;
  },
  noteSelect: (note) => selectNote(note),
  backgroundClick: () => clearSelection(),

  paintStart: (e, cell) => {
    clearSelectionAfterStroke = clearSelectionAfterStroke || selected !== null;
    startPaint(e, cell);
  },
  paintMove: (e) => strokeMove(e),
  paintEnd: () => finishStroke(),
  cancelStroke: () => cancelStroke(),

  eraseStart: (e) => {
    clearSelectionAfterStroke = clearSelectionAfterStroke || selected !== null;
    startErase(e);
  },
  eraseMove: (e) => strokeMove(e),
  eraseEnd: () => finishStroke(),

  orbitMove: (dx, dy) => studio.orbit(dx, dy),
  orbitEnd: () => {
    hideReadout();
  },
  panMove: (dx, dy) => studio.pan(dx, dy),
  panEnd: () => undefined,

  twoFingerStart: (anchor) => {
    hideReadout();
    studio.setHover(null);
    studio.beginPinch({ clientX: anchor.x, clientY: anchor.y });
  },
  twoFingerMove: (scale, cx, cy) =>
    studio.updatePinch(scale, { clientX: cx, clientY: cy }),
  twoFingerEnd: () => studio.endPinch(),

  parallax: (e) => studio.parallax(e),
  hover: (e) => updateHover(e),
  leave: () => {
    studio.pointerNearEdge(null);
    hideReadout();
    if (!studio.isDragging && !stroke) {
      studio.setHover(null);
      hoverBlock = null;
    }
  },
  interaction: () => {
    void unlock();
    hud.dismissHint();
    // 点击舞台后把焦点交给画布，页面快捷键不再被之前的按钮吞掉
    canvas.focus({ preventScroll: true });
  },
  cursor: (kind) => {
    canvas.style.cursor = kind;
  },
};

gestures = new GestureController(canvas, gestureHost);
gestures.attach();

// ---------------------------------------------------------------- 键盘 / 滚轮

function isTextEntry(el: HTMLElement | null): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  return el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.tagName === 'INPUT';
}

function isStageFocus(el: HTMLElement | null): boolean {
  return !el || el === document.body || el === document.documentElement || el === canvas;
}

function anyDrawerOpen(): boolean {
  return !!drawer?.isOpen || !!examplesDrawer?.isOpen || !!helpDrawer?.isOpen;
}

type PresetView = 'persp' | 'top' | 'front';
const VIEW_CYCLE: PresetView[] = ['persp', 'top', 'front'];
function nextView(): PresetView {
  const current = studio.view as PresetView;
  const index = VIEW_CYCLE.indexOf(current);
  return VIEW_CYCLE[(index < 0 ? 0 : index + 1) % VIEW_CYCLE.length];
}

window.addEventListener('keydown', (e) => {
  const el = e.target as HTMLElement | null;

  if (e.key === 'Escape') {
    if (studio.isResizing) {
      e.preventDefault();
      studio.cancelResize();
      return;
    }
    if (gestures && gestures.modeName !== 'idle') {
      e.preventDefault();
      gestures.cancelAll();
      return;
    }
    if (notePanel?.isOpen) {
      e.preventDefault();
      clearSelection();
      return;
    }
    // 一次按键只关闭一层
    if (anyDrawerOpen()) {
      e.preventDefault();
      if (helpDrawer?.isOpen) helpDrawer.hide();
      else if (examplesDrawer?.isOpen) examplesDrawer.hide();
      else if (drawer?.isOpen) drawer.hide();
    }
    return;
  }

  // 抽屉打开时，页面快捷键不得修改背后的舞台
  if (anyDrawerOpen()) return;

  // 空格只服务舞台 / 页面背景；按钮、开关、输入保留原生语义
  if (e.code === 'Space') {
    if (!isStageFocus(el) || isTextEntry(el)) return;
    e.preventDefault();
    if (!e.repeat) togglePlay();
    return;
  }

  if (isTextEntry(el)) return;
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
  if (e.key === ',' || e.key === '，') {
    e.preventDefault();
    hud.onSettings?.();
    return;
  }
  if (e.key === 'e' || e.key === 'E') {
    e.preventDefault();
    hud.onExamples?.();
    return;
  }
  if (e.key === 'f' || e.key === 'F') {
    e.preventDefault();
    hud.onFitStage?.();
    return;
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
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (selected) {
      e.preventDefault();
      deleteSelected();
      return;
    }
    if (hoverBlock) {
      e.preventDefault();
      record();
      audio.sfx('sfx_break', 0, 1, 0.5);
      studio.removeBlock(hoverBlock.step, hoverBlock.row);
      hoverBlock = null;
      studio.setHover(null);
      syncLength();
      markDirty();
    }
  }
});

// 中键拖拽：压掉浏览器自带的自动滚动 / 粘贴行为
canvas.addEventListener('mousedown', (e) => {
  if (e.button === 1) e.preventDefault();
});
canvas.addEventListener('auxclick', (e) => {
  if (e.button === 1) e.preventDefault();
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
        if (selected && selected.step === block.step && selected.row === block.row) {
          selected.midi = midi;
          syncNotePanel();
        }
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
  const { step, row } = block;
  record();
  audio.sfx('sfx_break', 0, 1, 0.5);
  studio.removeBlock(step, row);
  studio.setHover(null);
  hoverBlock = null;
  if (selected && selected.step === step && selected.row === row) clearSelection();
  syncLength();
  markDirty();
});

// ---------------------------------------------------------------- 持久化兜底

window.addEventListener('beforeunload', () => persistence.flush());
window.addEventListener('pagehide', () => persistence.flush());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden') return;
  // 半拖动 / 半清空不写入：先按统一规则取消，再提交最近完成的编辑
  gestures?.cancelAll();
  persistence.flush();
});

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
  get __helpDrawer() {
    return helpDrawer;
  },
  get __examples() {
    return examplePanel;
  },
  get __gestures() {
    return gestures;
  },
  get __viewport() {
    return viewport;
  },
  get __notePanel() {
    return notePanel;
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
    setBpmValue,
    selectNote,
    clearSelection,
    deleteSelected,
    shiftSelected,
    previewSelected,
    fitStage: () => studio.fitStage(),
    save: () => {
      const result = persistence.flush();
      refreshSaveStatus();
      return result;
    },
    saveSnapshot: () => persistence.snapshot,
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
      drawer?.hide();
      examplesDrawer?.show();
    },
    openHelp: () => {
      drawer?.hide();
      examplesDrawer?.hide();
      helpDrawer?.show();
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
    get selected() {
      return selected ? { ...selected } : null;
    },
    get prefs() {
      return { ...prefs };
    },
    get mode() {
      return document.body.dataset.mode;
    },
    get stageRect() {
      return viewport?.rect ?? null;
    },
  },
});

requestAnimationFrame(frame);

// 首屏淡出
window.setTimeout(() => document.body.classList.add('ready'), 620);

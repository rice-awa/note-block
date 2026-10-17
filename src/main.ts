import './style.css';
import { AudioEngine, Clock } from './audio';
import { Hud } from './hud';
import { COLS, DEMO, MAX_MIDI, MIN_MIDI, ROWS } from './rows';
import { Studio, type BlockView } from './scene';
import {
  decodeSong,
  History,
  loadLocal,
  MAX_STEPS,
  readShareCode,
  saveLocal,
  shareUrl,
  songLength,
  type Note,
  type SongState,
} from './song';

const MEASURE = 16;
const WINDOW = COLS;

const canvas = document.querySelector<HTMLCanvasElement>('#scene')!;
const studio = new Studio(canvas);
const audio = new AudioEngine();
const hud = new Hud();
const history = new History(40);
const mutedRows = new Set<number>();

const voice = (row: number) => ({ sample: ROWS[row].sample, gain: ROWS[row].gain });

// ---------------------------------------------------------------- state

let infinite = false;
/** 手动平移时间轴时累计的偏移（步） */
let viewOffset = 0;
let prevPos = 0;
let dragPre: SongState | null = null;
let saveTimer = 0;

const capture = (): SongState => ({ notes: studio.getNotes(), bpm: clock.bpm, infinite });
const record = (key?: string): void => {
  // 只要发生了新的可撤销操作，旧 toast 的"撤销"就不再指向那次操作了
  hud.hideToast();
  history.record(capture(), key);
};

function markDirty(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => saveLocal(capture()), 500);
}

/** 曲长：无限模式按内容整小节扩展，有限模式永远是 16 步 */
function syncLength(): void {
  const length = infinite ? songLength(studio.getNotes()) : MEASURE;
  clock.setLength(length);
  hud.setLength(length);
  hud.setEmpty(studio.blockCount === 0);
}

function sameNotes(a: Note[], b: Note[]): boolean {
  if (a.length !== b.length) return false;
  const key = (n: Note): string => `${n.step}:${n.row}:${n.midi}`;
  const set = new Set(a.map(key));
  for (const note of b) if (!set.has(key(note))) return false;
  return true;
}

function applyState(next: SongState, animate = false): void {
  infinite = next.infinite;
  hud.setInfinite(infinite);
  studio.setInfinite(infinite);
  clock.setBpm(next.bpm);
  hud.setBpm(clock.bpm);
  studio.setSong(next.notes, animate);
  syncLength();
  clock.seek(Math.min(clock.position, clock.length - 1));
  viewOffset = 0;
  if (infinite) studio.setWindow(Math.max(0, clock.position - WINDOW * 0.7), true);
  else studio.setWindow(0, true);
  hud.setStep(clock.playing ? Math.floor(clock.position) % MEASURE : -1);
  hud.setProgress(clock.position, clock.length);
  hud.setEmpty(studio.blockCount === 0);
  markDirty();
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
  if (infinite) studio.setWindow(Math.max(0, clock.position - WINDOW * 0.7), true);
  else {
    studio.setWindow(0, true);
    clock.seek(Math.min(clock.position, MEASURE - 1));
  }
  hud.setStep(clock.playing ? Math.floor(clock.position) % MEASURE : -1);
  hud.setProgress(clock.position, clock.length);
  hud.dismissHint();
  markDirty();
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
  if (infinite) studio.setWindow(Math.max(0, target - WINDOW * 0.7), true);
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
    const playing = clock.toggle();
    hud.setPlaying(playing);
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
hud.onInfinite = toggleInfinite;
hud.onClear = clearAll;
hud.onShare = () => void share();
hud.onSeek = seekTo;
studio.onViewChange = (id) => hud.setView(id);

// ---------------------------------------------------------------- boot

const sharedCode = readShareCode();
const sharedState = sharedCode ? decodeSong(sharedCode) : null;
const savedState = sharedState ? null : loadLocal();
const initial: SongState =
  sharedState ??
  savedState ?? {
    notes: DEMO.map(([step, row, midi]) => ({ step, row, midi })),
    bpm: 108,
    infinite: false,
  };

infinite = initial.infinite;
hud.setInfinite(infinite);
hud.setMuted(audio.muted);
studio.setInfinite(infinite);
clock.setBpm(initial.bpm);
hud.setBpm(clock.bpm);
studio.setSong(initial.notes, true);
syncLength();
studio.setWindow(0, true);
hud.setLength(clock.length);
hud.setEmpty(studio.blockCount === 0);
hud.setView(studio.view);
hud.setStep(-1);
hud.setProgress(0, clock.length);
if (sharedState) {
  // 分享链接只负责"第一次打开"，之后编辑走本地存档，避免刷新又回到旧分享
  window.history.replaceState(null, '', window.location.pathname);
  window.setTimeout(() => hud.showToast('已载入分享的作品', null, null, 3000), 900);
}

// ---------------------------------------------------------------- input

let orbit: { x: number; y: number } | null = null;
let hoverBlock: BlockView | null = null;

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

canvas.addEventListener('pointerdown', (e) => {
  void unlock();
  if (e.button !== 0) return;
  hud.dismissHint();

  const block = studio.pickBlock(e);
  if (block) {
    dragPre = capture();
    studio.beginDrag(block, e);
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
    return;
  }

  const cell = studio.pointerToCell(e);
  if (cell) {
    record();
    const created = studio.addBlock(cell.step, cell.row, 12, false);
    if (created) {
      studio.beginDrag(created, e);
      canvas.setPointerCapture(e.pointerId);
      audio.sfx('sfx_place', 0, 1.15, 0.4);
      audio.play(voice(cell.row), 12, 0, 0.7);
      syncLength();
      markDirty();
    }
    return;
  }

  orbit = { x: e.clientX, y: e.clientY };
  canvas.setPointerCapture(e.pointerId);
  canvas.style.cursor = 'grabbing';
});

canvas.addEventListener('pointermove', (e) => {
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
  updateHover(e);
});

function endPointer(e: PointerEvent): void {
  if (studio.isDragging) {
    const before = dragPre;
    const drop = studio.dragTargetCell();
    const { removed } = studio.endDrag();
    const after = capture();
    if (before && (removed || !sameNotes(before.notes, after.notes))) history.push(before);
    dragPre = null;
    audio.sfx(removed ? 'sfx_break' : 'sfx_place', 0, removed ? 0.95 : 0.85, removed ? 0.5 : 0.28);
    canvas.style.cursor = 'default';
    // 写到窗口最右一列：松手后让出 4 列，像翻页
    if (infinite && !removed && drop && drop.step >= studio.windowStart + WINDOW - 1) {
      studio.setWindow(studio.windowTarget + 4);
    }
    syncLength();
    markDirty();
    updateHover(e);
  }
  if (orbit) {
    orbit = null;
    canvas.style.cursor = 'default';
  }
}

canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', () => {
  if (!studio.isDragging) {
    studio.setHover(null);
    hoverBlock = null;
  }
});

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
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
    if (infinite && (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY))) {
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

  if (infinite && !studio.isDragging) {
    if (prevPos - pos > 1) {
      // 循环回卷：窗口直接归位，不做倒带长滑
      viewOffset = 0;
      studio.setWindow(Math.max(0, pos - WINDOW * 0.7), true);
    } else if (clock.playing) {
      studio.setWindow(Math.max(0, pos - WINDOW * 0.7 + viewOffset));
    }
  }
  prevPos = pos;

  studio.update(dt);
  studio.render();

  requestAnimationFrame(frame);
}

// 调试/QA 钩子（放一次即可，别每帧赋值）
Object.assign(window, { __studio: studio, __clock: clock, __audio: audio, __hud: hud });
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
    get infinite() {
      return infinite;
    },
  },
});

requestAnimationFrame(frame);

// 首屏淡出
window.setTimeout(() => document.body.classList.add('ready'), 620);

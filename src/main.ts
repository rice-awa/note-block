import './style.css';
import { AudioEngine, Clock } from './audio';
import { Hud } from './hud';
import { DEMO, MAX_MIDI, MIN_MIDI, ROWS } from './rows';
import { Studio, type BlockView } from './scene';

const canvas = document.querySelector<HTMLCanvasElement>('#scene')!;
const studio = new Studio(canvas);
const audio = new AudioEngine();
const hud = new Hud();
const mutedRows = new Set<number>();

const voice = (row: number) => ({ sample: ROWS[row].sample, gain: ROWS[row].gain });

// 音序器：调度时只排音频，视觉由 drainVisual 按同一时间点触发
const clock = new Clock(audio, (step, when) => {
  const delay = when - audio.now;
  for (const b of studio.blocks.values()) {
    if (b.step !== step || mutedRows.has(b.row)) continue;
    audio.play(voice(b.row), b.midi, delay);
  }
});
hud.setBpm(clock.bpm);

let unlocked = false;
async function unlock(): Promise<void> {
  if (unlocked) return;
  unlocked = true;
  await audio.unlock();
}

window.addEventListener('pointerdown', () => void unlock(), { capture: true });
window.addEventListener('keydown', () => void unlock(), { capture: true });

function togglePlay(): void {
  void (async () => {
    await unlock();
    const playing = clock.toggle();
    hud.setPlaying(playing);
    hud.dismissHint();
  })();
}

hud.onPlay = togglePlay;
hud.onBpm = (delta) => {
  clock.setBpm(clock.bpm + delta);
  hud.setBpm(clock.bpm);
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

// 演示曲
for (const [step, row, midi] of DEMO) studio.addBlock(step, row, midi, true);

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
    studio.beginDrag(block, e);
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
    return;
  }

  const cell = studio.pointerToCell(e);
  if (cell) {
    const created = studio.addBlock(cell.step, cell.row, 12, false);
    if (created) {
      studio.beginDrag(created, e);
      canvas.setPointerCapture(e.pointerId);
      audio.sfx('sfx_place', 0, 1.15, 0.4);
      audio.play(voice(cell.row), 12, 0, 0.7);
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
    const { removed } = studio.endDrag();
    audio.sfx(removed ? 'sfx_break' : 'sfx_place', 0, removed ? 0.95 : 0.85, removed ? 0.5 : 0.28);
    canvas.style.cursor = 'default';
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
        studio.setPitch(block.step, block.row, midi);
        audio.play(voice(block.row), midi, 0, 0.8);
      }
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
  audio.sfx('sfx_break', 0, 1, 0.5);
  studio.removeBlock(block.step, block.row);
  studio.setHover(null);
  hoverBlock = null;
});

window.addEventListener('keydown', (e) => {
  const el = e.target as HTMLElement | null;
  if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;

  if (e.code === 'Space' && el?.tagName !== 'BUTTON') {
    e.preventDefault();
    togglePlay();
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && hoverBlock) {
    e.preventDefault();
    audio.sfx('sfx_break', 0, 1, 0.5);
    studio.removeBlock(hoverBlock.step, hoverBlock.row);
    hoverBlock = null;
  }
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
  studio.setPlayhead(pos);
  studio.setPlayheadVisible(clock.playing || pos > 0.01);
  hud.setStep(clock.playing ? Math.floor(pos) % 16 : -1);

  studio.update(dt);
  studio.render();
  (window as unknown as { __studio: Studio; __clock: Clock; __audio: AudioEngine }).__studio = studio;
(window as unknown as { __studio: Studio; __clock: Clock; __audio: AudioEngine }).__clock = clock;
(window as unknown as { __studio: Studio; __clock: Clock; __audio: AudioEngine }).__audio = audio;

requestAnimationFrame(frame);
}

(window as unknown as { __studio: Studio; __clock: Clock; __audio: AudioEngine }).__studio = studio;
(window as unknown as { __studio: Studio; __clock: Clock; __audio: AudioEngine }).__clock = clock;
(window as unknown as { __studio: Studio; __clock: Clock; __audio: AudioEngine }).__audio = audio;

requestAnimationFrame(frame);

// 首屏淡出
window.setTimeout(() => document.body.classList.add('ready'), 620);

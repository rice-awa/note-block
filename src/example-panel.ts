/**
 * 示例面板内容：卡片、mini-map 画布与「当前」高亮。
 * 只管面板内容与绘制，开合/焦点/遮罩交给 src/drawer.ts；载入行为由 main.ts 接线。
 */
import { ROWS } from './rows';
import type { Note, SongState } from './song';
import { EXAMPLES, type Example } from './examples';

export interface ExamplePanelContext {
  /** 当前曲子快照，用于判断「当前」高亮 */
  getState: () => SongState;
  /** 载入一套示例：备份、撤销、装配动画与 toast 由 main.ts 负责 */
  onLoad: (example: Example) => void;
}

const MAP_CELL = 3;
const MAP_ROWS = 8;

/** 小节数 → 卡片上的读数 */
const barLabel = (bars: number): string => `${bars} 小节`;

/** 音符集合归一化：顺序无关，用于判断当前曲子是否就是这套示例 */
function noteKey(notes: Note[]): string {
  return notes
    .map((n) => `${n.step}:${n.row}:${n.midi}`)
    .sort()
    .join('|');
}

/** notes + bpm + bars 完全一致才算「当前示例」（与 ROADMAP §5.2 一致） */
export function isCurrentExample(example: Example, state: SongState): boolean {
  return (
    example.bpm === state.bpm &&
    example.bars === state.bars &&
    noteKey(example.notes) === noteKey(state.notes)
  );
}

/** 音高 → 色相：与 scene.ts 的 pitchColor 同一公式，mini-map 不引入 three */
function pitchHue(midi: number): string {
  const t = Math.min(1, Math.max(0, (midi - 0) / 24));
  const hue = (0.58 - t * 0.53) * 360;
  return `hsl(${hue.toFixed(1)} 60% 46%)`;
}

/** 用 DOM 的 CSS 变量画 mini-map：bars × 16 列 × 8 行 */
function drawMiniMap(canvas: HTMLCanvasElement, example: Example): void {
  const cols = example.bars * 16;
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const w = cols * MAP_CELL;
  const h = MAP_ROWS * MAP_CELL * 2;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  // 行底色 + 小节分隔线，先给一张「空棋盘」
  const rowH = h / MAP_ROWS;
  ROWS.forEach((row, r) => {
    ctx.fillStyle = row.color;
    ctx.globalAlpha = 0.14;
    ctx.fillRect(0, r * rowH, w, rowH);
  });
  ctx.globalAlpha = 1;
  ctx.strokeStyle = 'rgba(32, 30, 26, 0.12)';
  ctx.lineWidth = 1;
  for (let bar = 0; bar <= example.bars; bar++) {
    const x = Math.round(bar * 16 * MAP_CELL) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }

  // 音符：行色打底，音高色相覆盖，块宽随窗口
  const cw = Math.max(1.5, MAP_CELL * 0.8);
  for (const note of example.notes) {
    const x = note.step * MAP_CELL;
    const y = note.row * rowH;
    ctx.fillStyle = pitchHue(note.midi);
    ctx.globalAlpha = 0.9;
    ctx.fillRect(x, y + 0.5, cw, rowH - 1);
  }
  ctx.globalAlpha = 1;
}

const rowCount = (example: Example): number => new Set(example.notes.map((n) => n.row)).size;

/** 示例列表渲染器：重复 refresh() 只更新高亮，不重建卡片 */
export class ExamplePanel {
  private readonly ctx: ExamplePanelContext;
  private readonly cards = new Map<string, HTMLButtonElement>();
  private readonly badges = new Map<string, HTMLElement>();
  private current: string | null = null;

  constructor(root: HTMLElement, ctx: ExamplePanelContext) {
    this.ctx = ctx;
    root.classList.add('example-panel');
    root.innerHTML = '';

    const list = document.createElement('div');
    list.className = 'example-list';
    for (const example of EXAMPLES) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'example-card';
      card.dataset.example = example.id;
      card.setAttribute('aria-label', `载入示例《${example.name}》`);

      const map = document.createElement('canvas');
      map.className = 'example-map';
      map.setAttribute('aria-hidden', 'true');
      drawMiniMap(map, example);

      const meta = document.createElement('div');
      meta.className = 'example-meta';
      meta.innerHTML =
        `<span class="example-title"><span class="example-name">${example.name}</span>` +
        `<span class="example-en">${example.en}</span></span>` +
        `<span class="example-chips">` +
        `<span class="chip">${barLabel(example.bars)}</span>` +
        `<span class="chip">${example.bpm} BPM</span>` +
        `<span class="chip">${rowCount(example)} 乐器</span>` +
        `</span>`;

      const badge = document.createElement('span');
      badge.className = 'example-badge';
      badge.textContent = '当前';
      badge.hidden = true;

      const tag = document.createElement('span');
      tag.className = 'example-tag';
      tag.textContent = example.tag;

      card.append(map, meta, badge, tag);
      card.addEventListener('click', () => this.ctx.onLoad(example));
      list.appendChild(card);
      this.cards.set(example.id, card);
      this.badges.set(example.id, badge);
    }
    root.appendChild(list);
    this.refresh();
  }

  /** 按当前曲子状态更新「当前」高亮；不重建 DOM */
  refresh(): void {
    const state = this.ctx.getState();
    const active = EXAMPLES.find((example) => isCurrentExample(example, state))?.id ?? null;
    if (active === this.current) return;
    this.current = active;
    for (const [id, card] of this.cards) {
      const on = id === active;
      card.classList.toggle('is-current', on);
      card.setAttribute('aria-current', on ? 'true' : 'false');
      const badge = this.badges.get(id);
      if (badge) badge.hidden = !on;
    }
  }
}

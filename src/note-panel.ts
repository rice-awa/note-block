/**
 * 底部音符编辑条：显示选中音符的位置/音高，并提供升降半音、试听、删除与关闭。
 * 只负责 DOM 与按钮语义，状态修改由 main.ts 接线。
 */

import { formatPitch, formatPosition } from './note-label';

export interface NoteSelection {
  step: number;
  row: number;
  midi: number;
  rowLabel: string; // 草地
  voice: string;    // Harp
  canDown: boolean; // midi > MIN_MIDI
  canUp: boolean;   // midi < MAX_MIDI
}

export interface NotePanelHandlers {
  onShift(delta: -1 | 1): void;
  onPreview(): void;
  onDelete(): void;
  onClose(): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const button = (className: string, text: string, label: string): HTMLButtonElement => {
  const btn = el('button', className, text);
  btn.type = 'button';
  btn.setAttribute('aria-label', label);
  btn.title = label;
  return btn;
};

/** 行材质色的本地副本；不依赖 rows.ts，行号越界时退回中性色。 */
const ROW_TINTS = [
  '#8FBF63',
  '#A8865C',
  '#D9C998',
  '#A9D3D6',
  '#E4DED2',
  '#B9BEC4',
  '#D9B24C',
  '#A9C6DB',
];
const NEUTRAL_TINT = '#9AA0A6';

export class NotePanel {
  private readonly root: HTMLElement;
  private readonly handlers: NotePanelHandlers;

  private readonly swatch = el('span', 'note-panel-swatch');
  private readonly meta = el('span', 'note-panel-meta');
  private readonly pitch = el('span', 'note-panel-pitch');
  private readonly position = el('span', 'note-panel-position');

  private readonly downBtn = button(
    'note-btn note-btn--shift note-btn--down',
    '−半音',
    '降低半音',
  );
  private readonly upBtn = button(
    'note-btn note-btn--shift note-btn--up',
    '+半音',
    '升高半音',
  );
  private readonly previewBtn = button('note-btn note-btn--preview', '试听', '试听这个音符');
  private readonly deleteBtn = button('note-btn note-btn--delete', '删除', '删除这个音符');
  private readonly closeBtn = button('note-btn note-btn--close', '关闭', '关闭音符编辑');

  private current: NoteSelection | null = null;

  constructor(root: HTMLElement, handlers: NotePanelHandlers) {
    this.root = root;
    this.handlers = handlers;

    root.classList.add('note-panel');
    root.hidden = true;
    root.setAttribute('role', 'toolbar');
    root.setAttribute('aria-label', '音符编辑');

    this.swatch.setAttribute('aria-hidden', 'true');
    this.swatch.style.backgroundColor = NEUTRAL_TINT;

    this.pitch.setAttribute('aria-live', 'polite');
    this.position.setAttribute('aria-live', 'polite');

    const info = el('div', 'note-panel-info');
    const readout = el('div', 'note-panel-readout');
    readout.append(this.meta, this.pitch, this.position);
    info.append(this.swatch, readout);

    const actions = el('div', 'note-panel-actions');
    actions.append(
      this.downBtn,
      this.upBtn,
      this.previewBtn,
      this.deleteBtn,
      this.closeBtn,
    );

    root.replaceChildren(info, actions);

    this.downBtn.addEventListener('click', () => this.handlers.onShift(-1));
    this.upBtn.addEventListener('click', () => this.handlers.onShift(1));
    this.previewBtn.addEventListener('click', () => this.handlers.onPreview());
    this.deleteBtn.addEventListener('click', () => this.handlers.onDelete());
    this.closeBtn.addEventListener('click', () => this.handlers.onClose());
  }

  show(selection: NoteSelection): void {
    this.apply(selection);
    this.root.hidden = false;
    this.root.classList.add('is-open');
  }

  hide(): void {
    this.root.hidden = true;
    this.root.classList.remove('is-open');
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /** 打开状态下同步内容；只改文本与禁用态，不重建 DOM、不移动焦点。 */
  sync(selection: NoteSelection): void {
    this.apply(selection);
  }

  private apply(next: NoteSelection): void {
    const prev = this.current;

    const metaText = `${next.rowLabel} · ${next.voice}`;
    if (!prev || prev.rowLabel !== next.rowLabel || prev.voice !== next.voice) {
      this.meta.textContent = metaText;
    }

    if (!prev || prev.midi !== next.midi) {
      this.pitch.textContent = formatPitch(next.midi);
    }

    if (!prev || prev.step !== next.step) {
      this.position.textContent = formatPosition(next.step);
    }

    if (!prev || prev.row !== next.row) {
      const tint = ROW_TINTS[next.row % ROW_TINTS.length] ?? NEUTRAL_TINT;
      this.swatch.style.backgroundColor = tint;
    }

    const downDisabled = !next.canDown;
    if (this.downBtn.disabled !== downDisabled) this.downBtn.disabled = downDisabled;

    const upDisabled = !next.canUp;
    if (this.upBtn.disabled !== upDisabled) this.upBtn.disabled = upDisabled;

    this.current = { ...next };
  }
}

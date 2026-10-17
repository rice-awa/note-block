/**
 * 配置面板内容：曲子 / 窗口 / 声音 / 数据。
 * 只负责 DOM 与输入语义，状态与撤销由 main.ts 接线；开合交给 drawer.ts。
 */

import { formatDuration, songDuration, MEASURE } from './song';

export type GesturePhase = 'start' | 'move' | 'end';

export interface ConfigSnapshot {
  bars: number;
  bpm: number;
  loop: boolean;
  infinite: boolean;
  notes: number;
  windowCols: number;
  masterGain: number;
  reverb: number;
}

export interface ConfigHandlers {
  bars(delta: number): void;
  bpm(value: number, phase: GesturePhase): void;
  loop(on: boolean): void;
  infinite(on: boolean): void;
  windowCols(value: number): void;
  masterGain(value: number, phase: GesturePhase): void;
  reverb(value: number, phase: GesturePhase): void;
  share(): void;
  clear(): void;
}

type SliderKind = 'bpm' | 'master' | 'reverb';

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

export class ConfigPanel {
  private readonly handlers: ConfigHandlers;
  private readonly barsValue = el('span', 'cfg-value cfg-value--mono', '1 小节');
  private readonly duration = el('p', 'cfg-readout', '0:08.9 · 16 步');
  private readonly bpmInput = el('input', 'cfg-range');
  private readonly bpmOut = el('output', 'cfg-num', '108');
  private readonly loopSwitch = el('button', 'cfg-switch');
  private readonly loopText = el('span', 'cfg-switch-text', '开');
  private readonly infiniteSwitch = el('button', 'cfg-switch');
  private readonly infiniteText = el('span', 'cfg-switch-text', '关');
  private readonly windowValue = el('span', 'cfg-value cfg-value--mono', '16 列');
  private readonly masterInput = el('input', 'cfg-range');
  private readonly masterOut = el('output', 'cfg-num', '82%');
  private readonly reverbInput = el('input', 'cfg-range');
  private readonly reverbOut = el('output', 'cfg-num', '16%');
  private readonly autosave = el('p', 'cfg-note', '自动存档 · 刚刚');
  private readonly shareBtn = el('button', 'cfg-btn', '复制分享链接');
  private readonly clearBtn = el('button', 'cfg-btn cfg-btn--danger', '清空舞台');

  private readonly barsDec = el('button', 'cfg-step', '−');
  private readonly barsInc = el('button', 'cfg-step', '＋');
  private readonly windowDec = el('button', 'cfg-step', '−');
  private readonly windowInc = el('button', 'cfg-step', '＋');

  private snapshot: ConfigSnapshot = {
    bars: 1,
    bpm: 108,
    loop: true,
    infinite: false,
    notes: 0,
    windowCols: 16,
    masterGain: 0.82,
    reverb: 0.16,
  };
  private gesture: SliderKind | null = null;

  constructor(root: HTMLElement, handlers: ConfigHandlers) {
    this.handlers = handlers;
    this.barsValue.id = 'cfg-bars-value';
    this.duration.id = 'cfg-duration';
    this.loopSwitch.id = 'cfg-loop';
    this.infiniteSwitch.id = 'cfg-infinite';
    this.windowValue.id = 'cfg-window-cols';
    this.masterOut.id = 'cfg-master-out';
    this.reverbOut.id = 'cfg-reverb-out';
    this.autosave.id = 'cfg-autosave';
    this.shareBtn.id = 'cfg-share';
    this.clearBtn.id = 'cfg-clear';
    this.barsDec.id = 'cfg-bars-dec';
    this.barsInc.id = 'cfg-bars-inc';
    this.windowDec.id = 'cfg-window-dec';
    this.windowInc.id = 'cfg-window-inc';

    root.append(
      this.section('曲子', [
        this.stepperRow('时长', 'cfg-bars-label', this.barsDec, this.barsValue, this.barsInc),
        this.duration,
        this.sliderRow('BPM', 'cfg-bpm', this.bpmInput, this.bpmOut, 60, 180, 1),
        this.switchRow('循环', 'cfg-loop-label', this.loopSwitch, this.loopText),
        this.switchRow('无限延长', 'cfg-infinite-label', this.infiniteSwitch, this.infiniteText),
      ]),
      this.section('窗口', [
        this.stepperRow('可见列数', 'cfg-window-label', this.windowDec, this.windowValue, this.windowInc),
        el('p', 'cfg-hint', '8–32 列，也可以直接拖棋盘边缘'),
      ]),
      this.section('声音', [
        this.sliderRow('主音量', 'cfg-master', this.masterInput, this.masterOut, 0, 100, 1),
        this.sliderRow('混响', 'cfg-reverb', this.reverbInput, this.reverbOut, 0, 100, 1),
      ]),
      this.section('数据', [
        this.autosave,
        this.shareBtn,
        this.clearBtn,
      ]),
    );

    this.bindStepper(this.barsDec, this.barsInc, () => -1, () => 1);
    this.windowDec.addEventListener('click', () => this.handlers.windowCols(this.snapshot.windowCols - 4));
    this.windowInc.addEventListener('click', () => this.handlers.windowCols(this.snapshot.windowCols + 4));
    this.bindSwitch(this.loopSwitch, () => this.handlers.loop(!this.snapshot.loop));
    this.bindSwitch(this.infiniteSwitch, () => this.handlers.infinite(!this.snapshot.infinite));
    this.shareBtn.addEventListener('click', () => this.handlers.share());
    this.clearBtn.addEventListener('click', () => this.handlers.clear());
    this.bindSlider('bpm', this.bpmInput, (value, phase) => this.handlers.bpm(value, phase), (value) => {
      this.bpmOut.textContent = String(value);
    });
    this.bindSlider('master', this.masterInput, (value, phase) => this.handlers.masterGain(value / 100, phase), (value) => {
      this.masterOut.textContent = `${value}%`;
    });
    this.bindSlider('reverb', this.reverbInput, (value, phase) => this.handlers.reverb(value / 100, phase), (value) => {
      this.reverbOut.textContent = `${value}%`;
    });

    this.clearBtn.disabled = true;
  }

  sync(next: ConfigSnapshot): void {
    this.snapshot = { ...next };
    this.barsValue.textContent = `${next.bars} 小节`;
    this.duration.textContent = `${formatDuration(songDuration(next.bars, next.bpm))} · ${next.bars * MEASURE} 步`;
    if (document.activeElement !== this.bpmInput) {
      this.bpmInput.value = String(next.bpm);
      this.bpmOut.textContent = String(next.bpm);
    }
    this.setSwitch(this.loopSwitch, this.loopText, next.loop);
    this.setSwitch(this.infiniteSwitch, this.infiniteText, next.infinite);
    this.windowValue.textContent = `${next.windowCols} 列`;
    if (document.activeElement !== this.masterInput) {
      this.masterInput.value = String(Math.round(next.masterGain * 100));
      this.masterOut.textContent = `${Math.round(next.masterGain * 100)}%`;
    }
    if (document.activeElement !== this.reverbInput) {
      this.reverbInput.value = String(Math.round(next.reverb * 100));
      this.reverbOut.textContent = `${Math.round(next.reverb * 100)}%`;
    }
    this.clearBtn.disabled = next.notes === 0;
    this.clearBtn.setAttribute('aria-label', next.notes === 0 ? '舞台已经是空的' : '清空舞台');
  }

  /** 数据区的自动存档读数 */
  setSavedLabel(text: string): void {
    this.autosave.textContent = text;
  }

  private section(title: string, children: HTMLElement[]): HTMLElement {
    const box = el('section', 'cfg-section');
    const heading = el('h3', 'cfg-heading', title);
    box.append(heading, ...children);
    return box;
  }

  private stepperRow(
    label: string,
    labelId: string,
    dec: HTMLButtonElement,
    value: HTMLElement,
    inc: HTMLButtonElement,
  ): HTMLElement {
    for (const btn of [dec, inc]) {
      btn.type = 'button';
      btn.setAttribute('aria-label', btn === dec ? `减少${label}` : `增加${label}`);
    }
    const labelEl = el('span', 'cfg-label', label);
    labelEl.id = labelId;
    const group = el('div', 'cfg-stepper');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-labelledby', labelId);
    group.append(dec, value, inc);
    const row = el('div', 'cfg-row cfg-row--split');
    row.append(labelEl, group);
    return row;
  }

  private sliderRow(
    label: string,
    id: string,
    input: HTMLInputElement,
    out: HTMLElement,
    min: number,
    max: number,
    step: number,
  ): HTMLElement {
    input.type = 'range';
    input.id = id;
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.setAttribute('aria-label', label);
    out.setAttribute('for', id);
    out.setAttribute('aria-live', 'off');
    const labelEl = el('label', 'cfg-label', label);
    labelEl.htmlFor = id;
    const row = el('div', 'cfg-row cfg-row--slider');
    row.append(labelEl, input, out);
    return row;
  }

  private switchRow(label: string, labelId: string, button: HTMLButtonElement, text: HTMLElement): HTMLElement {
    button.type = 'button';
    button.setAttribute('role', 'switch');
    button.setAttribute('aria-checked', 'false');
    text.textContent = '关';
    const dot = el('span', 'cfg-switch-dot');
    button.append(dot, text);
    const labelEl = el('span', 'cfg-label', label);
    labelEl.id = labelId;
    button.setAttribute('aria-labelledby', labelId);
    const row = el('div', 'cfg-row cfg-row--split');
    row.append(labelEl, button);
    return row;
  }

  private bindStepper(dec: HTMLButtonElement, inc: HTMLButtonElement, deltaDec: () => number, deltaInc: () => number): void {
    dec.addEventListener('click', () => this.handlers.bars(deltaDec()));
    inc.addEventListener('click', () => this.handlers.bars(deltaInc()));
  }

  private bindSwitch(button: HTMLButtonElement, toggle: () => void): void {
    button.addEventListener('click', toggle);
  }

  private setSwitch(button: HTMLButtonElement, text: HTMLElement, on: boolean): void {
    button.setAttribute('aria-checked', String(on));
    button.classList.toggle('is-on', on);
    text.textContent = on ? '开' : '关';
  }

  private bindSlider(
    kind: SliderKind,
    input: HTMLInputElement,
    apply: (value: number, phase: GesturePhase) => void,
    paint: (value: number) => void,
  ): void {
    const value = (): number => Number(input.value);
    const begin = (): void => {
      if (this.gesture === kind) return;
      this.gesture = kind;
      apply(value(), 'start');
    };
    const move = (): void => {
      paint(value());
      if (this.gesture !== kind) begin();
      apply(value(), 'move');
    };
    const end = (): void => {
      if (this.gesture !== kind) return;
      this.gesture = null;
      apply(value(), 'end');
    };
    input.addEventListener('pointerdown', begin);
    input.addEventListener('keydown', (e) => {
      if (/^(Arrow|Page|Home|End)/.test(e.key)) begin();
    });
    input.addEventListener('keyup', end);
    input.addEventListener('input', move);
    input.addEventListener('pointerup', end);
    input.addEventListener('pointercancel', end);
    input.addEventListener('blur', end);
  }
}

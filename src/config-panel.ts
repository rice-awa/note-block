/**
 * 配置面板内容：曲子 / 窗口 / 声音 / 数据。
 * 只负责 DOM 与输入语义，状态与撤销由 main.ts 接线；开合交给 drawer.ts。
 */

import { formatDuration, stepsDuration } from './song';

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
  /** 时钟实际长度（步），无限模式下也是真实曲长 */
  lengthSteps: number;
  /** 备份槽里是否有可恢复的作品 */
  canRestore: boolean;
}

export interface ConfigHandlers {
  bars(delta: number): void;
  barsValue(value: number): void;
  bpm(value: number, phase: GesturePhase): void;
  loop(on: boolean): void;
  infinite(on: boolean): void;
  windowCols(value: number): void;
  masterGain(value: number, phase: GesturePhase): void;
  reverb(value: number, phase: GesturePhase): void;
  share(): void;
  restore(): void;
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

const numBox = (input: HTMLInputElement, unit: string): HTMLElement => {
  input.type = 'number';
  input.inputMode = 'numeric';
  const wrap = el('span', 'cfg-num-wrap');
  wrap.append(input, el('span', 'cfg-unit', unit));
  return wrap;
};

export class ConfigPanel {
  private readonly handlers: ConfigHandlers;
  private readonly barsInput = el('input', 'cfg-value cfg-value--mono cfg-num--input');
  private readonly duration = el('p', 'cfg-readout', '0:08.9 · 16 步');
  private readonly infiniteHint = el('p', 'cfg-hint', '无限模式：曲长随内容自动延长');
  private readonly bpmInput = el('input', 'cfg-range');
  private readonly bpmOut = el('input', 'cfg-num cfg-num--input');
  private readonly loopSwitch = el('button', 'cfg-switch');
  private readonly loopText = el('span', 'cfg-switch-text', '开');
  private readonly infiniteSwitch = el('button', 'cfg-switch');
  private readonly infiniteText = el('span', 'cfg-switch-text', '关');
  private readonly windowInput = el('input', 'cfg-value cfg-value--mono cfg-num--input');
  private readonly masterInput = el('input', 'cfg-range');
  private readonly masterNum = el('input', 'cfg-num cfg-num--input');
  private readonly masterOut = numBox(this.masterNum, '%');
  private readonly reverbInput = el('input', 'cfg-range');
  private readonly reverbNum = el('input', 'cfg-num cfg-num--input');
  private readonly reverbOut = numBox(this.reverbNum, '%');
  private readonly autosave = el('p', 'cfg-note', '自动存档 · 刚刚');
  private readonly shareBtn = el('button', 'cfg-btn', '复制分享链接');
  private readonly restoreBtn = el('button', 'cfg-btn', '恢复上次载入前的作品');
  private readonly clearBtn = el('button', 'cfg-btn cfg-btn--danger', '清空舞台');

  private readonly barsDec = el('button', 'cfg-step', '−');
  private readonly barsInc = el('button', 'cfg-step', '＋');
  private readonly windowDec = el('button', 'cfg-step', '−');
  private readonly windowInc = el('button', 'cfg-step', '＋');

  private readonly barsRow: HTMLElement;
  private readonly windowRow: HTMLElement;

  private snapshot: ConfigSnapshot = {
    bars: 1,
    bpm: 108,
    loop: true,
    infinite: false,
    notes: 0,
    windowCols: 16,
    masterGain: 0.82,
    reverb: 0.16,
    lengthSteps: 16,
    canRestore: false,
  };
  private gesture: SliderKind | null = null;
  /** 滑杆原生 input → 视觉外壳（轨道 + 缓动滑块） */
  private readonly sliders = new Map<HTMLInputElement, HTMLElement>();

  constructor(root: HTMLElement, handlers: ConfigHandlers) {
    this.handlers = handlers;
    this.barsInput.id = 'cfg-bars-value';
    this.duration.id = 'cfg-duration';
    this.loopSwitch.id = 'cfg-loop';
    this.infiniteSwitch.id = 'cfg-infinite';
    this.windowInput.id = 'cfg-window-cols';
    this.masterNum.id = 'cfg-master-out';
    this.reverbNum.id = 'cfg-reverb-out';
    this.autosave.id = 'cfg-autosave';
    this.shareBtn.id = 'cfg-share';
    this.restoreBtn.id = 'cfg-restore';
    this.clearBtn.id = 'cfg-clear';
    this.barsDec.id = 'cfg-bars-dec';
    this.barsInc.id = 'cfg-bars-inc';
    this.windowDec.id = 'cfg-window-dec';
    this.windowInc.id = 'cfg-window-inc';
    this.bpmOut.id = 'cfg-bpm-out';
    this.bpmOut.setAttribute('aria-label', 'BPM 数值');

    this.barsRow = this.stepperRow(
      '时长',
      'cfg-bars-label',
      this.barsDec,
      numBox(this.barsInput, '小节'),
      this.barsInc,
    );
    this.windowRow = this.stepperRow(
      '可见列数',
      'cfg-window-label',
      this.windowDec,
      numBox(this.windowInput, '列'),
      this.windowInc,
    );
    this.infiniteHint.hidden = true;

    root.append(
      this.section('曲子', [
        this.barsRow,
        this.infiniteHint,
        this.duration,
        this.sliderRow('BPM', 'cfg-bpm', this.bpmInput, this.bpmOut, 60, 180, 1),
        this.switchRow('循环', 'cfg-loop-label', this.loopSwitch, this.loopText),
        this.switchRow('无限延长', 'cfg-infinite-label', this.infiniteSwitch, this.infiniteText),
      ]),
      this.section('窗口', [
        this.windowRow,
        el('p', 'cfg-hint', '8–32 列，也可以直接拖棋盘边缘'),
      ]),
      this.section('声音', [
        this.sliderRow('主音量', 'cfg-master', this.masterInput, this.masterOut, 0, 100, 1),
        this.sliderRow('混响', 'cfg-reverb', this.reverbInput, this.reverbOut, 0, 100, 1),
      ]),
      this.section('数据', [
        this.autosave,
        this.shareBtn,
        this.restoreBtn,
        this.clearBtn,
      ]),
    );

    this.bindStepper(this.barsDec, this.barsInc, () => -1, () => 1);
    this.windowDec.addEventListener('click', () => this.handlers.windowCols(this.snapshot.windowCols - 4));
    this.windowInc.addEventListener('click', () => this.handlers.windowCols(this.snapshot.windowCols + 4));
    this.bindSwitch(this.loopSwitch, () => this.handlers.loop(!this.snapshot.loop));
    this.bindSwitch(this.infiniteSwitch, () => this.handlers.infinite(!this.snapshot.infinite));
    this.shareBtn.addEventListener('click', () => this.handlers.share());
    this.restoreBtn.addEventListener('click', () => this.handlers.restore());
    this.clearBtn.addEventListener('click', () => this.handlers.clear());
    this.bindNumber(this.barsInput, 1, 32, 1, (value) => this.handlers.barsValue(value));
    this.bindNumber(this.windowInput, 8, 32, 4, (value) => this.handlers.windowCols(value));
    this.bindNumber(this.bpmOut, 60, 180, 1, (value) => {
      this.handlers.bpm(value, 'start');
      this.handlers.bpm(value, 'end');
    });
    this.bindNumber(this.masterNum, 0, 100, 1, (value) => {
      this.handlers.masterGain(value / 100, 'start');
      this.handlers.masterGain(value / 100, 'end');
    });
    this.bindNumber(this.reverbNum, 0, 100, 1, (value) => {
      this.handlers.reverb(value / 100, 'start');
      this.handlers.reverb(value / 100, 'end');
    });
    this.bindSlider('bpm', this.bpmInput, (value, phase) => this.handlers.bpm(value, phase), (value) => {
      this.bpmOut.value = String(value);
    });
    this.bindSlider('master', this.masterInput, (value, phase) => this.handlers.masterGain(value / 100, phase), (value) => {
      this.masterNum.value = String(value);
    });
    this.bindSlider('reverb', this.reverbInput, (value, phase) => this.handlers.reverb(value / 100, phase), (value) => {
      this.reverbNum.value = String(value);
    });

    this.clearBtn.disabled = true;
    this.restoreBtn.disabled = true;
  }

  sync(next: ConfigSnapshot): void {
    this.snapshot = { ...next };
    this.barsRow.hidden = next.infinite;
    this.infiniteHint.hidden = !next.infinite;
    if (document.activeElement !== this.barsInput) this.barsInput.value = String(next.bars);
    const auto = next.infinite ? '自动延长 · ' : '';
    this.duration.textContent = `${auto}${formatDuration(stepsDuration(next.lengthSteps, next.bpm))} · ${next.lengthSteps} 步`;
    if (document.activeElement !== this.bpmInput && document.activeElement !== this.bpmOut) {
      this.bpmInput.value = String(next.bpm);
      this.bpmOut.value = String(next.bpm);
    }
    this.setSwitch(this.loopSwitch, this.loopText, next.loop);
    this.setSwitch(this.infiniteSwitch, this.infiniteText, next.infinite);
    if (document.activeElement !== this.windowInput) {
      this.windowInput.value = String(next.windowCols);
    }
    if (document.activeElement !== this.masterInput && document.activeElement !== this.masterNum) {
      this.masterInput.value = String(Math.round(next.masterGain * 100));
      this.masterNum.value = String(Math.round(next.masterGain * 100));
    }
    if (document.activeElement !== this.reverbInput && document.activeElement !== this.reverbNum) {
      this.reverbInput.value = String(Math.round(next.reverb * 100));
      this.reverbNum.value = String(Math.round(next.reverb * 100));
    }
    this.paintSlider(this.bpmInput);
    this.paintSlider(this.masterInput);
    this.paintSlider(this.reverbInput);
    this.clearBtn.disabled = next.notes === 0;
    this.clearBtn.setAttribute('aria-label', next.notes === 0 ? '舞台已经是空的' : '清空舞台');
    this.restoreBtn.disabled = !next.canRestore;
    this.restoreBtn.setAttribute('aria-label', next.canRestore ? '恢复上次载入前的作品' : '没有可恢复的作品');
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
    if (out instanceof HTMLInputElement) {
      out.setAttribute('aria-label', `${label} 数值`);
    } else {
      out.setAttribute('aria-live', 'off');
    }
    const labelEl = el('label', 'cfg-label', label);
    labelEl.htmlFor = id;
    const shell = el('span', 'cfg-slider');
    const knob = el('span', 'cfg-slider-knob');
    knob.setAttribute('aria-hidden', 'true');
    shell.append(input, knob);
    this.sliders.set(input, shell);
    const row = el('div', 'cfg-row cfg-row--slider');
    row.append(labelEl, shell, out);
    return row;
  }

  /** 把 0..1 的位置写到外壳上，滑块位置与缓动全部由 CSS 完成 */
  private paintSlider(input: HTMLInputElement): void {
    const shell = this.sliders.get(input);
    if (!shell) return;
    const min = Number(input.min);
    const max = Number(input.max);
    const value = Number(input.value);
    const p = max > min ? (value - min) / (max - min) : 0;
    shell.style.setProperty('--p', String(Math.min(1, Math.max(0, p))));
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

  /** 数字框：Enter / 失焦提交，Esc 还原；只在值真正变化时回调 */
  private bindNumber(
    input: HTMLInputElement,
    min: number,
    max: number,
    step: number,
    commit: (value: number) => void,
  ): void {
    input.type = 'number';
    input.inputMode = 'numeric';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    if (!input.hasAttribute('aria-label')) input.setAttribute('aria-label', '数值');
    const current = (): number => {
      const raw = Number(input.value);
      return Number.isFinite(raw) ? Math.min(max, Math.max(min, Math.round(raw))) : min;
    };
    const apply = (): void => {
      const value = current();
      input.value = String(value);
      const prev = this.snapshotValue(input);
      if (value !== prev) commit(value);
    };
    input.addEventListener('change', apply);
    input.addEventListener('blur', apply);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        input.value = String(this.snapshotValue(input));
        input.blur();
      }
    });
  }

  /** 数字框对应的当前快照值，用于避免无效提交 / Esc 还原 */
  private snapshotValue(input: HTMLInputElement): number {
    if (input === this.barsInput) return this.snapshot.bars;
    if (input === this.windowInput) return this.snapshot.windowCols;
    if (input === this.bpmOut) return this.snapshot.bpm;
    if (input === this.masterNum) return Math.round(this.snapshot.masterGain * 100);
    if (input === this.reverbNum) return Math.round(this.snapshot.reverb * 100);
    return Number(input.value);
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
      this.paintSlider(input);
      paint(value());
      if (this.gesture !== kind) begin();
      apply(value(), 'move');
    };
    const end = (): void => {
      if (this.gesture !== kind) return;
      this.gesture = null;
      apply(value(), 'end');
    };
    const shell = this.sliders.get(input);
    let pressed = false;
    input.addEventListener('pointerdown', () => {
      pressed = true;
      begin();
    });
    // 点轨道时让滑块缓动过去；一旦开始拖动就切回 1:1 跟手
    input.addEventListener('pointermove', () => {
      if (pressed) shell?.classList.add('is-scrubbing');
    });
    const release = (): void => {
      pressed = false;
      shell?.classList.remove('is-scrubbing');
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    input.addEventListener('blur', release);
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

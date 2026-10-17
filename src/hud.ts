import { ROWS } from './rows';
import type { ViewId } from './views';

export class Hud {
  onPlay: (() => void) | null = null;
  onBpm: ((delta: number) => void) | null = null;
  onMuteRow: ((row: number) => void) | null = null;
  onSound: (() => void) | null = null;
  onView: ((id: Exclude<ViewId, 'free'>) => void) | null = null;
  onInfinite: (() => void) | null = null;
  onClear: (() => void) | null = null;
  onShare: (() => void) | null = null;
  onSeek: ((step: number) => void) | null = null;
  onRewind: (() => void) | null = null;
  onSettings: (() => void) | null = null;
  onExamples: (() => void) | null = null;

  private playBtn = document.querySelector<HTMLButtonElement>('#play')!;
  private rewindBtn = document.querySelector<HTMLButtonElement>('#rewind')!;
  private bpmEl = document.querySelector<HTMLElement>('#bpm')!;
  private stepsEl = document.querySelector<HTMLElement>('#steps')!;
  private rowsEl = document.querySelector<HTMLElement>('#rows')!;
  private hintEl = document.querySelector<HTMLElement>('#hint')!;
  private soundBtn = document.querySelector<HTMLButtonElement>('#sound')!;
  private infiniteBtn = document.querySelector<HTMLButtonElement>('#infinite')!;
  private clearBtn = document.querySelector<HTMLButtonElement>('#clear')!;
  private shareBtn = document.querySelector<HTMLButtonElement>('#share')!;
  private settingsBtn = document.querySelector<HTMLButtonElement>('#settings')!;
  private examplesBtn = document.querySelector<HTMLButtonElement>('#examples')!;
  private measureEl = document.querySelector<HTMLElement>('#measure')!;
  private barsEl = document.querySelector<HTMLElement>('#bars')!;
  private rail = document.querySelector<HTMLElement>('#rail')!;
  private railFill = document.querySelector<HTMLElement>('#railFill')!;
  private railThumb = document.querySelector<HTMLElement>('#railThumb')!;
  private toastEl = document.querySelector<HTMLElement>('#toast')!;
  private toastText = document.querySelector<HTMLElement>('#toast-text')!;
  private toastAction = document.querySelector<HTMLButtonElement>('#toast-action')!;

  private viewBtns: HTMLButtonElement[] = [];
  private stepDots: HTMLElement[] = [];
  private rowItems: HTMLButtonElement[] = [];
  private hintGone = false;

  private length = 16;
  private position = 0;
  private atEnd = false;
  private measureIndex = 0;
  private toastTimer = 0;
  private toastHandler: (() => void) | null = null;
  private railScrubbing = false;

  constructor() {
    this.buildRows();
    this.buildSteps();
    this.playBtn.addEventListener('click', () => this.onPlay?.());
    this.rewindBtn.addEventListener('click', () => this.onRewind?.());
    this.soundBtn.addEventListener('click', () => this.onSound?.());
    this.infiniteBtn.addEventListener('click', () => this.onInfinite?.());
    this.clearBtn.addEventListener('click', () => this.onClear?.());
    this.shareBtn.addEventListener('click', () => this.onShare?.());
    this.settingsBtn.addEventListener('click', () => this.onSettings?.());
    this.examplesBtn.addEventListener('click', () => this.onExamples?.());
    document.querySelectorAll<HTMLButtonElement>('[data-bpm]').forEach((btn) => {
      btn.addEventListener('click', () => this.onBpm?.(Number(btn.dataset.bpm)));
    });
    document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((btn) => {
      this.viewBtns.push(btn);
      btn.addEventListener('click', () => this.onView?.(btn.dataset.view as Exclude<ViewId, 'free'>));
    });
    this.toastAction.addEventListener('click', () => {
      const handler = this.toastHandler;
      this.hideToast();
      handler?.();
    });
    this.bindRail();
  }

  private buildRows(): void {
    this.rowsEl.innerHTML = '';
    ROWS.forEach((row, i) => {
      const li = document.createElement('button');
      li.type = 'button';
      li.className = 'row-item';
      li.dataset.row = String(i);
      li.setAttribute('aria-pressed', 'false');
      li.innerHTML =
        `<span class="row-swatch" style="background-image:url('/tex/${row.tex}.png')"></span>` +
        `<span class="row-text"><span class="row-name">${row.label}</span><span class="row-voice">${row.voice}</span></span>`;
      li.addEventListener('click', () => {
        const muted = li.classList.toggle('muted');
        li.setAttribute('aria-pressed', String(muted));
        this.onMuteRow?.(i);
      });
      this.rowsEl.appendChild(li);
      this.rowItems.push(li);
    });
  }

  private buildSteps(): void {
    this.stepsEl.innerHTML = '';
    for (let i = 0; i < 16; i++) {
      // 装饰性步进点：键盘用户走 progress bar 的 slider 语义，这里不做 tab 停靠
      const dot = document.createElement('span');
      dot.className = 'step';
      dot.title = `跳到第 ${i + 1} 步`;
      dot.addEventListener('click', () => this.onSeek?.(this.measureIndex * 16 + i));
      this.stepsEl.appendChild(dot);
      this.stepDots.push(dot);
    }
  }

  private bindRail(): void {
    const seekFromEvent = (clientX: number): void => {
      const rect = this.rail.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      this.onSeek?.(Math.round(ratio * Math.max(1, this.length - 1)));
    };
    this.rail.addEventListener('pointerdown', (e) => {
      this.railScrubbing = true;
      this.rail.setPointerCapture(e.pointerId);
      seekFromEvent(e.clientX);
    });
    this.rail.addEventListener('pointermove', (e) => {
      if (this.railScrubbing) seekFromEvent(e.clientX);
    });
    const end = (): void => {
      this.railScrubbing = false;
    };
    this.rail.addEventListener('pointerup', end);
    this.rail.addEventListener('pointercancel', end);
    this.rail.addEventListener('keydown', (e) => {
      const coarse = e.shiftKey ? 4 : 1;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        this.onSeek?.(Math.max(0, Math.round(this.position) - coarse));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        this.onSeek?.(Math.min(this.length - 1, Math.round(this.position) + coarse));
      } else if (e.key === 'Home') {
        e.preventDefault();
        this.onSeek?.(0);
      }
    });
  }

  setPlaying(playing: boolean): void {
    document.body.classList.toggle('is-playing', playing);
    if (playing) this.atEnd = false;
    this.playBtn.setAttribute('aria-label', playing ? '暂停' : this.atEnd ? '从头播放' : '播放');
  }

  /** 非循环播到末尾：播放键语义变成「从头播」 */
  setAtEnd(atEnd: boolean): void {
    this.atEnd = atEnd;
    this.playBtn.dataset.atEnd = String(atEnd);
    if (!document.body.classList.contains('is-playing')) {
      this.playBtn.setAttribute('aria-label', atEnd ? '从头播放' : '播放');
    }
  }

  setSettingsOpen(open: boolean): void {
    this.settingsBtn.classList.toggle('is-on', open);
    this.settingsBtn.setAttribute('aria-expanded', String(open));
    this.settingsBtn.setAttribute('aria-label', open ? '关闭设置' : '设置');
  }

  setExamplesOpen(open: boolean): void {
    this.examplesBtn.classList.toggle('is-on', open);
    this.examplesBtn.setAttribute('aria-expanded', String(open));
    this.examplesBtn.setAttribute('aria-label', open ? '关闭示例' : '示例');
  }

  setBpm(bpm: number): void {
    this.bpmEl.textContent = String(bpm);
  }

  setView(id: ViewId): void {
    for (const btn of this.viewBtns) {
      const active = btn.dataset.view === id;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    }
  }

  setInfinite(on: boolean): void {
    document.body.classList.toggle('infinite', on);
    this.infiniteBtn.classList.toggle('is-on', on);
    this.infiniteBtn.setAttribute('aria-pressed', String(on));
    this.infiniteBtn.setAttribute('aria-label', on ? '退出无限模式' : '进入无限模式');
  }

  setLength(length: number): void {
    this.length = Math.max(1, Math.round(length));
    this.rail.setAttribute('aria-valuemax', String(this.length));
    this.updateMeasure();
  }

  setMeasure(measure: number, bars: number): void {
    this.measureIndex = Math.max(0, Math.floor(measure));
    this.measureEl.textContent = `M${pad2(this.measureIndex + 1)}`;
    this.barsEl.textContent = pad2(Math.max(1, bars));
  }

  private updateMeasure(): void {
    this.measureEl.textContent = `M${pad2(this.measureIndex + 1)}`;
    this.barsEl.textContent = pad2(Math.max(1, Math.ceil(this.length / 16)));
  }

  setProgress(position: number, length: number): void {
    if (length !== this.length) this.setLength(length);
    this.position = position;
    const ratio = length <= 1 ? 0 : Math.min(1, Math.max(0, position / (length - 1)));
    this.railFill.style.transform = `scaleX(${ratio.toFixed(4)})`;
    this.railThumb.style.left = `${(ratio * 100).toFixed(3)}%`;
    this.rail.setAttribute('aria-valuenow', String(Math.round(position)));
  }

  setStep(step: number): void {
    for (let i = 0; i < this.stepDots.length; i++) {
      this.stepDots[i].classList.toggle('on', i === step);
    }
  }

  setMuted(muted: boolean): void {
    this.soundBtn.classList.toggle('is-muted', muted);
    this.soundBtn.setAttribute('aria-label', muted ? '取消静音' : '静音');
  }

  setEmpty(empty: boolean): void {
    this.clearBtn.disabled = empty;
    this.clearBtn.setAttribute('aria-label', empty ? '舞台已经是空的' : '清空舞台');
  }

  showToast(text: string, actionLabel: string | null, onAction: (() => void) | null, ttl = 5200): void {
    this.toastText.textContent = text;
    this.toastHandler = onAction;
    this.toastEl.classList.toggle('has-action', !!actionLabel);
    this.toastAction.hidden = !actionLabel;
    if (actionLabel) this.toastAction.textContent = actionLabel;
    this.toastEl.hidden = false;
    requestAnimationFrame(() => this.toastEl.classList.add('in'));
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.hideToast(), ttl);
  }

  hideToast(): void {
    window.clearTimeout(this.toastTimer);
    this.toastHandler = null;
    this.toastEl.classList.remove('in');
    window.setTimeout(() => {
      if (!this.toastEl.classList.contains('in')) this.toastEl.hidden = true;
    }, 200);
  }

  dismissHint(): void {
    if (this.hintGone) return;
    this.hintGone = true;
    this.hintEl.classList.add('gone');
  }
}

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));


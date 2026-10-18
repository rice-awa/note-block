import { ROWS } from './rows';
import { formatDuration } from './song';
import type { SaveStatus } from './persistence';
import type { ViewId } from './views';

export type FeedbackTarget = 'page' | 'settings' | 'examples';

interface FeedbackSlot {
  root: HTMLElement;
  text: HTMLElement;
  action: HTMLButtonElement;
}

interface ActiveFeedback {
  target: FeedbackTarget;
  text: string;
  actionLabel: string | null;
  handler: (() => void) | null;
  ttl: number;
  remaining: number;
  startedAt: number;
  timer: number;
  paused: boolean;
}

export class Hud {
  onPlay: (() => void) | null = null;
  onBpm: ((delta: number) => void) | null = null;
  onBpmValue: ((value: number) => void) | null = null;
  onMuteRow: ((row: number) => void) | null = null;
  onSound: (() => void) | null = null;
  onView: ((id: Exclude<ViewId, 'free'>) => void) | null = null;
  onFitStage: (() => void) | null = null;
  onInfinite: (() => void) | null = null;
  onClear: (() => void) | null = null;
  onShare: (() => void) | null = null;
  onSeek: ((step: number) => void) | null = null;
  onScrubStart: ((step: number) => void) | null = null;
  onScrubMove: ((step: number) => void) | null = null;
  onScrubEnd: ((step: number) => void) | null = null;
  onRewind: (() => void) | null = null;
  onSettings: (() => void) | null = null;
  onExamples: (() => void) | null = null;
  onHelp: (() => void) | null = null;
  onUndo: (() => void) | null = null;
  onRedo: (() => void) | null = null;
  onRowsToggle: ((open: boolean) => void) | null = null;
  onHintDismiss: (() => void) | null = null;
  onRetrySave: (() => void) | null = null;

  private playBtn = document.querySelector<HTMLButtonElement>('#play')!;
  private rewindBtn = document.querySelector<HTMLButtonElement>('#rewind')!;
  private undoBtn = document.querySelector<HTMLButtonElement>('#undo')!;
  private redoBtn = document.querySelector<HTMLButtonElement>('#redo')!;
  private bpmEl = document.querySelector<HTMLButtonElement>('#bpm')!;
  private bpmInput = document.querySelector<HTMLInputElement>('#bpm-input')!;
  private stepsEl = document.querySelector<HTMLElement>('#steps')!;
  private rowsEl = document.querySelector<HTMLElement>('#rows')!;
  private rowsWrap = document.querySelector<HTMLElement>('#rows-wrap')!;
  private rowsToggle = document.querySelector<HTMLButtonElement>('#rows-toggle')!;
  private rowsToggleText = document.querySelector<HTMLElement>('#rows-toggle-text')!;
  private hintEl = document.querySelector<HTMLElement>('#hint')!;
  private hintClose = document.querySelector<HTMLButtonElement>('#hint-close')!;
  private emptyHint = document.querySelector<HTMLElement>('#empty-hint')!;
  private emptyExamples = document.querySelector<HTMLButtonElement>('#empty-examples')!;
  private soundBtn = document.querySelector<HTMLButtonElement>('#sound')!;
  private infiniteBtn = document.querySelector<HTMLButtonElement>('#infinite')!;
  private clearBtn = document.querySelector<HTMLButtonElement>('#clear')!;
  private shareBtn = document.querySelector<HTMLButtonElement>('#share')!;
  private settingsBtn = document.querySelector<HTMLButtonElement>('#settings')!;
  private examplesBtn = document.querySelector<HTMLButtonElement>('#examples')!;
  private helpBtn = document.querySelector<HTMLButtonElement>('#help')!;
  private moreBtn = document.querySelector<HTMLButtonElement>('#more')!;
  private viewMenuBtn = document.querySelector<HTMLButtonElement>('#view-menu-btn')!;
  private fitStageBtn = document.querySelector<HTMLButtonElement>('#fit-stage')!;
  private viewMenu = document.querySelector<HTMLElement>('#view-menu')!;
  private viewFit = document.querySelector<HTMLButtonElement>('#view-fit')!;
  private moreMenu = document.querySelector<HTMLElement>('#more-menu')!;
  private moreInfinite = document.querySelector<HTMLButtonElement>('[data-more="infinite"]')!;
  private moreClear = document.querySelector<HTMLButtonElement>('[data-more="clear"]')!;
  private saveStatus = document.querySelector<HTMLButtonElement>('#save-status')!;
  private saveStatusText = document.querySelector<HTMLElement>('#save-status .save-status-text')!;
  private measureEl = document.querySelector<HTMLElement>('#measure')!;
  private barsEl = document.querySelector<HTMLElement>('#bars')!;
  private rail = document.querySelector<HTMLElement>('#rail')!;
  private railFill = document.querySelector<HTMLElement>('#railFill')!;
  private railThumb = document.querySelector<HTMLElement>('#railThumb')!;
  private railTicks = document.querySelector<HTMLElement>('#railTicks')!;
  private railTip = document.querySelector<HTMLElement>('#railTip')!;
  private railNow = document.querySelector<HTMLElement>('#railNow')!;
  private railEnd = document.querySelector<HTMLElement>('#railEnd')!;

  private readonly slots: Record<FeedbackTarget, FeedbackSlot> = {
    page: {
      root: document.querySelector<HTMLElement>('#toast')!,
      text: document.querySelector<HTMLElement>('#toast-text')!,
      action: document.querySelector<HTMLButtonElement>('#toast-action')!,
    },
    settings: {
      root: document.querySelector<HTMLElement>('#settings-feedback')!,
      text: document.querySelector<HTMLElement>('#settings-feedback .drawer-feedback-text')!,
      action: document.querySelector<HTMLButtonElement>('#settings-feedback .drawer-feedback-action')!,
    },
    examples: {
      root: document.querySelector<HTMLElement>('#examples-feedback')!,
      text: document.querySelector<HTMLElement>('#examples-feedback .drawer-feedback-text')!,
      action: document.querySelector<HTMLButtonElement>('#examples-feedback .drawer-feedback-action')!,
    },
  };

  private viewBtns: HTMLButtonElement[] = [];
  private stepDots: HTMLElement[] = [];
  private rowItems: HTMLButtonElement[] = [];
  private hintGone = false;
  private mutedRows = 0;

  private length = 16;
  private position = 0;
  private stepDur = 60 / (108 * 4);
  private nowText = '';
  private endText = '';
  private atEnd = false;
  private measureIndex = 0;
  private railScrubbing = false;
  private feedback: ActiveFeedback | null = null;
  private openMenu: HTMLElement | null = null;
  private menuTrigger: HTMLElement | null = null;

  constructor() {
    this.buildRows();
    this.buildSteps();
    this.playBtn.addEventListener('click', () => this.onPlay?.());
    this.rewindBtn.addEventListener('click', () => this.onRewind?.());
    this.undoBtn.addEventListener('click', () => this.onUndo?.());
    this.redoBtn.addEventListener('click', () => this.onRedo?.());
    this.soundBtn.addEventListener('click', () => this.onSound?.());
    this.infiniteBtn.addEventListener('click', () => this.onInfinite?.());
    this.clearBtn.addEventListener('click', () => this.onClear?.());
    this.shareBtn.addEventListener('click', () => this.onShare?.());
    this.settingsBtn.addEventListener('click', () => this.onSettings?.());
    this.examplesBtn.addEventListener('click', () => this.onExamples?.());
    this.helpBtn.addEventListener('click', () => this.onHelp?.());
    this.fitStageBtn.addEventListener('click', () => this.onFitStage?.());
    this.emptyExamples.addEventListener('click', () => this.onExamples?.());
    this.hintClose.addEventListener('click', () => this.dismissHint());
    this.saveStatus.addEventListener('click', () => this.onRetrySave?.());

    document.querySelectorAll<HTMLButtonElement>('[data-bpm]').forEach((btn) => {
      btn.addEventListener('click', () => this.onBpm?.(Number(btn.dataset.bpm)));
    });
    document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((btn) => {
      this.viewBtns.push(btn);
      btn.addEventListener('click', () => {
        this.closeMenus();
        this.onView?.(btn.dataset.view as Exclude<ViewId, 'free'>);
      });
    });
    document.querySelectorAll<HTMLButtonElement>('[data-more]').forEach((btn) => {
      btn.addEventListener('click', () => this.runMore(btn.dataset.more ?? ''));
    });
    this.bindBpmEditor();
    this.bindMenus();
    this.bindRowsToggle();
    this.bindFeedback(this.slots.page);
    this.bindFeedback(this.slots.settings);
    this.bindFeedback(this.slots.examples);
    this.bindRail();
  }

  // ---------------------------------------------------------------- 构建

  private buildRows(): void {
    this.rowsEl.innerHTML = '';
    ROWS.forEach((row, i) => {
      const li = document.createElement('button');
      li.type = 'button';
      li.className = 'row-item';
      li.dataset.row = String(i);
      li.setAttribute('aria-pressed', 'false');
      li.setAttribute('aria-label', `${row.label} ${row.voice}，点击静音`);
      li.innerHTML =
        `<span class="row-swatch" style="background-image:url('/tex/${row.tex}.png')"></span>` +
        `<span class="row-text"><span class="row-name">${row.label}</span><span class="row-voice">${row.voice}</span></span>` +
        `<span class="row-mute">静音</span>`;
      li.addEventListener('click', () => {
        const muted = li.classList.toggle('muted');
        li.setAttribute('aria-pressed', String(muted));
        li.setAttribute(
          'aria-label',
          `${row.label} ${row.voice}，${muted ? '已静音，点击取消静音' : '点击静音'}`,
        );
        this.mutedRows += muted ? 1 : -1;
        this.setRowsMuted(this.mutedRows);
        this.onMuteRow?.(i);
      });
      this.rowsEl.appendChild(li);
      this.rowItems.push(li);
    });
    this.setRowsMuted(0);
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

  private bindRowsToggle(): void {
    this.rowsToggle.addEventListener('click', () => {
      const open = !this.rowsWrap.classList.contains('is-open');
      this.setRowsOpen(open);
      this.onRowsToggle?.(open);
    });
  }

  setRowsOpen(open: boolean): void {
    this.rowsWrap.classList.toggle('is-open', open);
    this.rowsToggle.setAttribute('aria-expanded', String(open));
    document.body.classList.toggle('rows-open', open);
  }

  private setRowsMuted(muted: number): void {
    this.mutedRows = Math.max(0, Math.min(ROWS.length, muted));
    const on = ROWS.length - this.mutedRows;
    this.rowsToggleText.textContent = `音色 · ${on}/${ROWS.length} 开启`;
    this.rowsHoldState();
  }

  private rowsHoldState(): void {
    this.rowsToggle.classList.toggle('has-muted', this.mutedRows > 0);
  }

  // ---------------------------------------------------------------- BPM 就地编辑

  private bindBpmEditor(): void {
    this.bpmEl.addEventListener('click', () => this.openBpmEditor());
    const commit = (): void => {
      if (this.bpmInput.hidden) return;
      const raw = Number(this.bpmInput.value);
      const value = Number.isFinite(raw) ? Math.max(60, Math.min(180, Math.round(raw))) : null;
      this.closeBpmEditor();
      if (value !== null) this.onBpmValue?.(value);
    };
    this.bpmInput.addEventListener('blur', commit);
    this.bpmInput.addEventListener('change', commit);
    this.bpmInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.closeBpmEditor();
      }
    });
  }

  private openBpmEditor(): void {
    this.bpmInput.value = this.bpmEl.textContent ?? '';
    this.bpmInput.hidden = false;
    this.bpmEl.hidden = true;
    this.bpmInput.focus();
    this.bpmInput.select();
  }

  private closeBpmEditor(): void {
    if (this.bpmInput.hidden) return;
    this.bpmInput.hidden = true;
    this.bpmEl.hidden = false;
  }

  // ---------------------------------------------------------------- 弹出菜单

  private bindMenus(): void {
    this.moreMenu.querySelectorAll<HTMLAnchorElement>('a').forEach((link) => {
      link.addEventListener('click', () => this.closeMenus(true));
    });
    this.viewMenuBtn.addEventListener('click', () => this.toggleMenu(this.viewMenu, this.viewMenuBtn));
    this.moreBtn.addEventListener('click', () => this.toggleMenu(this.moreMenu, this.moreBtn));
    this.viewFit.addEventListener('click', () => {
      this.closeMenus();
      this.onFitStage?.();
    });
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (!this.openMenu) return;
        const target = e.target as Node | null;
        if (target && (this.openMenu.contains(target) || this.menuTrigger?.contains(target))) return;
        this.closeMenus();
      },
      true,
    );
    document.addEventListener(
      'keydown',
      (e) => {
        if (!this.openMenu) return;
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          this.closeMenus(true);
        }
      },
      true,
    );
  }

  private toggleMenu(menu: HTMLElement, trigger: HTMLElement): void {
    if (this.openMenu === menu) {
      this.closeMenus(true);
      return;
    }
    this.closeMenus(false);
    this.openMenu = menu;
    this.menuTrigger = trigger;
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    const first = menu.querySelector<HTMLButtonElement>('button:not(:disabled)');
    first?.focus();
  }

  closeMenus(refocus = false): void {
    if (!this.openMenu) return;
    const trigger = this.menuTrigger;
    this.openMenu.hidden = true;
    trigger?.setAttribute('aria-expanded', 'false');
    this.openMenu = null;
    this.menuTrigger = null;
    if (refocus) trigger?.focus();
  }

  private runMore(action: string): void {
    this.closeMenus();
    if (action === 'examples') this.onExamples?.();
    else if (action === 'infinite') this.onInfinite?.();
    else if (action === 'share') this.onShare?.();
    else if (action === 'help') this.onHelp?.();
    else if (action === 'clear') this.onClear?.();
  }

  // ---------------------------------------------------------------- 弧线 / 进度

  private railStep(clientX: number): number {
    const rect = this.rail.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width)));
    return Math.round(ratio * Math.max(0, this.length - 1));
  }

  private showTip(clientX: number): void {
    const rect = this.rail.getBoundingClientRect();
    const step = this.railStep(clientX);
    const bar = Math.floor(step / 16) + 1;
    this.railTip.textContent = `M${pad2(bar)} · ${formatDuration(step * this.stepDur)}`;
    this.railTip.style.left = `${Math.min(rect.width, Math.max(0, clientX - rect.left))}px`;
    this.railTip.hidden = false;
  }

  private hideTip(): void {
    this.railTip.hidden = true;
  }

  private bindRail(): void {
    this.rail.addEventListener('pointerdown', (e) => {
      this.railScrubbing = true;
      this.rail.setPointerCapture(e.pointerId);
      const step = this.railStep(e.clientX);
      this.showTip(e.clientX);
      this.onScrubStart?.(step);
    });
    this.rail.addEventListener('pointermove', (e) => {
      this.showTip(e.clientX);
      if (this.railScrubbing) this.onScrubMove?.(this.railStep(e.clientX));
    });
    const end = (e: PointerEvent): void => {
      if (!this.railScrubbing) return;
      this.railScrubbing = false;
      this.onScrubEnd?.(this.railStep(e.clientX));
    };
    this.rail.addEventListener('pointerup', end);
    this.rail.addEventListener('pointercancel', end);
    this.rail.addEventListener('lostpointercapture', end);
    this.rail.addEventListener('pointerleave', () => {
      if (!this.railScrubbing) this.hideTip();
    });
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
      } else if (e.key === 'End') {
        e.preventDefault();
        this.onSeek?.(Math.max(0, this.length - 1));
      }
    });
  }

  // ---------------------------------------------------------------- 状态

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

  setHelpOpen(open: boolean): void {
    this.helpBtn.classList.toggle('is-on', open);
    this.helpBtn.setAttribute('aria-expanded', String(open));
    this.helpBtn.setAttribute('aria-label', open ? '关闭玩法' : '玩法');
  }

  setHistory(canUndo: boolean, canRedo: boolean): void {
    this.undoBtn.disabled = !canUndo;
    this.redoBtn.disabled = !canRedo;
    this.undoBtn.setAttribute('aria-disabled', String(!canUndo));
    this.redoBtn.setAttribute('aria-disabled', String(!canRedo));
  }

  setBpm(bpm: number): void {
    this.bpmEl.textContent = String(bpm);
    if (!this.bpmInput.hidden && document.activeElement !== this.bpmInput) {
      this.bpmInput.value = String(bpm);
    }
  }

  setView(id: ViewId): void {
    for (const btn of this.viewBtns) {
      const active = btn.dataset.view === id;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
      if (btn.getAttribute('role') === 'menuitemradio') btn.setAttribute('aria-checked', String(active));
    }
  }

  setInfinite(on: boolean): void {
    document.body.classList.toggle('infinite', on);
    this.infiniteBtn.classList.toggle('is-on', on);
    this.infiniteBtn.setAttribute('aria-pressed', String(on));
    this.infiniteBtn.setAttribute('aria-label', on ? '退出无限模式' : '进入无限模式');
    this.moreInfinite.setAttribute('aria-pressed', String(on));
    this.moreInfinite.textContent = on ? '无限模式 · 开' : '无限模式';
  }

  /** 每步时长（秒）：由 main 在 BPM / 曲长变化时传入 */
  setTiming(stepDur: number): void {
    const next = Number.isFinite(stepDur) ? Math.max(0.0001, stepDur) : this.stepDur;
    if (next === this.stepDur) return;
    this.stepDur = next;
    this.updateTime(true);
  }

  setLength(length: number): void {
    const next = Math.max(1, Math.round(length));
    if (next !== this.length) {
      this.length = next;
      this.rail.setAttribute('aria-valuemax', String(Math.max(0, this.length - 1)));
    }
    this.updateTicks();
    this.updateMeasure();
    this.updateTime(true);
  }

  private updateTicks(): void {
    const bars = Math.max(1, Math.ceil(this.length / 16));
    let every = 1;
    while (bars / every > 12) every *= 2;
    const count = bars / every;
    this.railTicks.style.setProperty('--tick', `${100 / count}%`);
    this.railTicks.classList.toggle('is-hidden', bars < 2);
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

  private updateTime(force = false): void {
    const now = formatDuration(this.position * this.stepDur);
    const end = formatDuration(this.length * this.stepDur);
    if (force || now !== this.nowText) {
      this.railNow.textContent = now;
      this.nowText = now;
    }
    if (force || end !== this.endText) {
      this.railEnd.textContent = end;
      this.endText = end;
    }
    this.rail.setAttribute(
      'aria-valuetext',
      `M${pad2(this.measureIndex + 1)} · ${now} / ${end}`,
    );
  }

  setProgress(position: number, length: number): void {
    if (length !== this.length) this.setLength(length);
    this.position = position;
    const ratio = length <= 1 ? 0 : Math.min(1, Math.max(0, position / (length - 1)));
    this.railFill.style.transform = `scaleX(${ratio.toFixed(4)})`;
    this.railThumb.style.left = `${(ratio * 100).toFixed(3)}%`;
    this.rail.setAttribute('aria-valuenow', String(Math.round(position)));
    this.updateTime();
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
    this.moreClear.disabled = empty;
    this.emptyHint.hidden = !empty;
  }

  /** 保存状态：失败时常驻一条低干扰提示，点击重试 */
  setSaveStatus(status: SaveStatus, text: string, retryable = false): void {
    const failed = status === 'failed';
    this.saveStatus.hidden = !failed;
    this.saveStatus.classList.toggle('is-failed', failed);
    this.saveStatusText.textContent = failed
      ? `${text}${retryable ? ' · 点击重试' : ''}`
      : text;
    this.saveStatus.setAttribute('aria-label', failed ? `${text}，点击重试保存` : text);
  }

  dismissHint(): void {
    if (this.hintGone) return;
    this.hintGone = true;
    this.hintEl.classList.add('gone');
    this.hintEl.setAttribute('aria-hidden', 'true');
    this.onHintDismiss?.();
  }

  // ---------------------------------------------------------------- 反馈

  showToast(
    text: string,
    actionLabel: string | null,
    onAction: (() => void) | null,
    ttl = 5200,
    focusAction = false,
  ): void {
    this.showFeedback('page', text, actionLabel, onAction, ttl, focusAction);
  }

  showDrawerFeedback(
    which: Exclude<FeedbackTarget, 'page'>,
    text: string,
    actionLabel: string | null,
    onAction: (() => void) | null,
    ttl = 5200,
    focusAction = false,
  ): void {
    this.showFeedback(which, text, actionLabel, onAction, ttl, focusAction);
  }

  private showFeedback(
    target: FeedbackTarget,
    text: string,
    actionLabel: string | null,
    onAction: (() => void) | null,
    ttl: number,
    focusAction = false,
  ): void {
    this.clearFeedbackSlots();
    const slot = this.slots[target];
    this.feedback = {
      target,
      text,
      actionLabel,
      handler: onAction,
      ttl,
      remaining: ttl,
      startedAt: performance.now(),
      timer: 0,
      paused: false,
    };
    slot.text.textContent = text;
    slot.action.hidden = !actionLabel;
    if (actionLabel) slot.action.textContent = actionLabel;
    slot.root.hidden = false;
    slot.root.classList.toggle('has-action', !!actionLabel);
    requestAnimationFrame(() => slot.root.classList.add('in'));
    this.scheduleFeedback(ttl);
    if (focusAction && actionLabel) {
      requestAnimationFrame(() => {
        if (this.feedback?.target === target) slot.action.focus();
      });
    }
  }

  private scheduleFeedback(ms: number): void {
    const active = this.feedback;
    if (!active) return;
    window.clearTimeout(active.timer);
    active.startedAt = performance.now();
    active.remaining = ms;
    active.timer = window.setTimeout(() => this.hideFeedback(), Math.max(0, ms));
  }

  private pauseFeedback(): void {
    const active = this.feedback;
    if (!active || active.paused) return;
    active.paused = true;
    window.clearTimeout(active.timer);
    active.remaining = Math.max(0, active.remaining - (performance.now() - active.startedAt));
  }

  private resumeFeedback(): void {
    const active = this.feedback;
    if (!active || !active.paused) return;
    active.paused = false;
    this.scheduleFeedback(active.remaining);
  }

  private bindFeedback(slot: FeedbackSlot): void {
    const isActive = (): boolean => this.feedback?.target === this.slotTarget(slot);
    slot.root.addEventListener('pointerenter', () => {
      if (isActive()) this.pauseFeedback();
    });
    slot.root.addEventListener('pointerleave', () => {
      if (isActive()) this.resumeFeedback();
    });
    slot.root.addEventListener('focusin', () => {
      if (isActive()) this.pauseFeedback();
    });
    slot.root.addEventListener('focusout', () => {
      if (isActive()) this.resumeFeedback();
    });
    slot.action.addEventListener('click', () => {
      const handler = this.feedback?.handler ?? null;
      this.hideFeedback();
      handler?.();
    });
  }

  private slotTarget(slot: FeedbackSlot): FeedbackTarget {
    if (slot === this.slots.settings) return 'settings';
    if (slot === this.slots.examples) return 'examples';
    return 'page';
  }

  /** 面板关闭：未过期反馈转交主页面，保留剩余时间和回调 */
  transferFeedback(which: Exclude<FeedbackTarget, 'page'>): void {
    const active = this.feedback;
    if (!active || active.target !== which) return;
    const remaining = active.paused
      ? active.remaining
      : Math.max(0, active.remaining - (performance.now() - active.startedAt));
    if (remaining <= 0) {
      this.hideFeedback();
      return;
    }
    const handler = active.handler;
    const label = active.actionLabel;
    const text = active.text;
    this.hideFeedback();
    this.showFeedback('page', text, label, handler, remaining);
  }

  hideToast(): void {
    this.hideFeedback();
  }

  /** 新编辑 / 撤销 / 重做后，旧提示的撤销回调已经指向另一次操作 */
  hideFeedback(): void {
    const active = this.feedback;
    window.clearTimeout(active?.timer ?? 0);
    this.feedback = null;
    const hadFocus =
      typeof document !== 'undefined' && !!document.activeElement &&
      Object.values(this.slots).some((slot) => slot.root.contains(document.activeElement));
    this.clearFeedbackSlots();
    if (hadFocus) {
      const canvas = document.querySelector<HTMLElement>('#scene');
      canvas?.focus({ preventScroll: true });
    }
  }

  private clearFeedbackSlots(): void {
    for (const slot of Object.values(this.slots)) {
      slot.root.classList.remove('in');
      slot.root.hidden = true;
      slot.action.hidden = true;
    }
  }
}

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

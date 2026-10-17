/**
 * 通用玻璃抽屉：开合、焦点进入/归还、Esc、窄屏遮罩。
 * 只负责容器行为，内容（配置 / 示例）由各自的 panel 模块填进 body。
 */

export interface DrawerOptions {
  panel: HTMLElement;
  scrim?: HTMLElement | null;
  trigger?: HTMLElement | null;
  closeButton?: HTMLElement | null;
  onOpen?: () => void;
  onClose?: () => void;
}

const FOCUSABLE = [
  'button:not(:disabled)',
  '[href]',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const prefersReducedMotion = (): boolean =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export class Drawer {
  private readonly panel: HTMLElement;
  private readonly scrim: HTMLElement | null;
  private readonly trigger: HTMLElement | null;
  private readonly closeButton: HTMLElement | null;
  private readonly onOpen: (() => void) | null;
  private readonly onClose: (() => void) | null;
  private open = false;
  private lastFocus: HTMLElement | null = null;
  private hideTimer = 0;

  constructor(opts: DrawerOptions) {
    this.panel = opts.panel;
    this.scrim = opts.scrim ?? null;
    this.trigger = opts.trigger ?? null;
    this.closeButton = opts.closeButton ?? null;
    this.onOpen = opts.onOpen ?? null;
    this.onClose = opts.onClose ?? null;

    this.closeButton?.addEventListener('click', () => this.hide());
    this.scrim?.addEventListener('click', () => this.hide());
    this.panel.addEventListener('keydown', (e) => this.onKeydown(e));
    document.addEventListener('pointerdown', (e) => this.onOutside(e), true);
    if (this.trigger) this.trigger.setAttribute('aria-expanded', 'false');
  }

  get isOpen(): boolean {
    return this.open;
  }

  toggle(): void {
    if (this.open) this.hide();
    else this.show();
  }

  show(): void {
    if (this.open) return;
    this.open = true;
    window.clearTimeout(this.hideTimer);
    this.lastFocus = (document.activeElement as HTMLElement | null) ?? null;

    this.panel.hidden = false;
    this.panel.setAttribute('aria-hidden', 'false');
    this.panel.dataset.open = 'true';
    // 先上屏再切 transform，避免 hidden → display 那一帧吞掉过渡
    void this.panel.offsetWidth;
    this.panel.classList.add('is-open');
    if (this.scrim) {
      this.scrim.hidden = false;
      this.scrim.classList.add('is-open');
    }
    document.body.classList.add('drawer-open');
    this.trigger?.setAttribute('aria-expanded', 'true');
    this.focusFirst();
    this.onOpen?.();
  }

  hide(): void {
    if (!this.open) return;
    this.open = false;
    this.panel.classList.remove('is-open');
    this.panel.dataset.open = 'false';
    this.panel.setAttribute('aria-hidden', 'true');
    if (this.scrim) {
      this.scrim.classList.remove('is-open');
      this.scrim.hidden = true;
    }
    document.body.classList.remove('drawer-open');
    this.trigger?.setAttribute('aria-expanded', 'false');

    const done = (): void => {
      if (this.open) return;
      this.panel.hidden = true;
      if (this.lastFocus && document.contains(this.lastFocus)) this.lastFocus.focus();
      else this.trigger?.focus();
      this.lastFocus = null;
    };
    window.clearTimeout(this.hideTimer);
    if (prefersReducedMotion()) done();
    else this.hideTimer = window.setTimeout(done, 260);
    this.onClose?.();
  }

  private focusable(): HTMLElement[] {
    return [...this.panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    );
  }

  private focusFirst(): void {
    const list = this.focusable();
    const target = list[0] ?? this.panel;
    if (!this.panel.hasAttribute('tabindex')) this.panel.setAttribute('tabindex', '-1');
    target.focus();
  }

  private onKeydown(e: KeyboardEvent): void {
    if (!this.open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.hide();
      return;
    }
    if (e.key !== 'Tab') return;
    const list = this.focusable();
    if (!list.length) return;
    const first = list[0];
    const last = list[list.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey && (active === first || !this.panel.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !this.panel.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  }

  /** 桌面没有遮罩：点面板外关闭（触发按钮的点击交给 toggle，不重复处理） */
  private onOutside(e: PointerEvent): void {
    if (!this.open) return;
    const target = e.target as Node | null;
    if (!target) return;
    if (this.panel.contains(target)) return;
    if (this.trigger && (this.trigger === target || this.trigger.contains(target))) return;
    // 关闭的那一下不要穿透到舞台，避免顺手画出一个音符
    e.stopPropagation();
    this.hide();
  }
}

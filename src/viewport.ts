/**
 * 舞台有效视口：把「顶栏与底部控制区之间的可用矩形」量出来交给场景。
 * 相机适配、投影与拾取共用同一个矩形；轻微尺寸变化合并到下一帧处理。
 */

export interface StageViewport {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type LayoutMode = 'desktop' | 'portrait' | 'landscape';

export interface ViewportInfo {
  rect: StageViewport;
  mode: LayoutMode;
  /** 横竖屏真正切换时置 true；地址栏伸缩不算 */
  orientationChanged: boolean;
  /** canvas 的 CSS 像素尺寸（渲染器 / 投影用） */
  canvasWidth: number;
  canvasHeight: number;
}

const EPSILON = 1;

const readSize = (): { width: number; height: number } => {
  // 用布局视口：软键盘收起 / 弹出时 visualViewport 会变，但舞台不应跟着重排
  const root = typeof document !== 'undefined' ? document.documentElement : null;
  return {
    width: Math.max(1, Math.round(root?.clientWidth || window.innerWidth || 1)),
    height: Math.max(1, Math.round(root?.clientHeight || window.innerHeight || 1)),
  };
};

const rectOf = (el: Element | null): DOMRect | null => {
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return rect;
};

export class ViewportWatcher {
  private readonly onChange: (info: ViewportInfo) => void;
  private readonly canvas: HTMLElement | null;
  private observer: ResizeObserver | null = null;
  private raf = 0;
  private started = false;
  private last: ViewportInfo | null = null;
  private prevPortrait: boolean | null = null;
  private forceOrientation = false;
  private forceNext = false;
  private safeProbe: HTMLElement | null = null;
  private readonly mobileLike =
    typeof window !== 'undefined' &&
    (window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0);

  constructor(canvas: HTMLElement | null, onChange: (info: ViewportInfo) => void) {
    this.canvas = canvas;
    this.onChange = onChange;
  }

  get info(): ViewportInfo {
    return this.last ?? this.measure(false);
  }

  get mode(): LayoutMode {
    return this.info.mode;
  }

  get rect(): StageViewport {
    return this.info.rect;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const schedule = (): void => this.schedule();
    window.addEventListener('resize', schedule, { passive: true });
    window.addEventListener('orientationchange', () => {
      this.forceOrientation = true;
      this.schedule();
    });
    window.visualViewport?.addEventListener('resize', schedule, { passive: true });
    window.visualViewport?.addEventListener('scroll', schedule, { passive: true });

    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(schedule);
      const topbar = document.querySelector('.topbar');
      const transport = document.querySelector('.transport');
      const rows = document.querySelector('#rows-wrap');
      const notePanel = document.querySelector('#note-panel');
      const legal = document.querySelector('.legal');
      for (const el of [document.body, topbar, transport, rows, notePanel, legal]) {
        if (el) this.observer.observe(el);
      }
    }
    this.schedule();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.observer?.disconnect();
    this.observer = null;
    window.cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.safeProbe?.remove();
    this.safeProbe = null;
  }

  /** 布局变化（展开材料行、显示编辑条等）后主动重测 */
  refresh(force = true): void {
    this.forceNext = this.forceNext || force;
    this.schedule();
  }

  private schedule(): void {
    if (!this.started || this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      const orientationChanged = this.forceOrientation;
      const force = this.forceNext;
      this.forceOrientation = false;
      this.forceNext = false;
      const next = this.measure(orientationChanged);
      if (force || !this.last || this.changed(this.last, next)) {
        this.last = next;
        this.onChange(next);
      }
    });
  }

  private changed(a: ViewportInfo, b: ViewportInfo): boolean {
    return (
      a.mode !== b.mode ||
      b.orientationChanged ||
      Math.abs(a.rect.left - b.rect.left) > EPSILON ||
      Math.abs(a.rect.top - b.rect.top) > EPSILON ||
      Math.abs(a.rect.width - b.rect.width) > EPSILON ||
      Math.abs(a.rect.height - b.rect.height) > EPSILON ||
      Math.abs(a.canvasWidth - b.canvasWidth) > EPSILON ||
      Math.abs(a.canvasHeight - b.canvasHeight) > EPSILON
    );
  }

  measure(forceOrientation: boolean): ViewportInfo {
    const { width, height } = readSize();
    const portraitNow = height >= width;
    let orientationChanged = forceOrientation;
    // 桌面拖动窗口跨过正方形不是「旋转屏幕」，不能因此取消正在进行的笔触
    if (this.mobileLike && this.prevPortrait !== null && this.prevPortrait !== portraitNow) {
      orientationChanged = true;
    }
    this.prevPortrait = portraitNow;

    // 低高度横屏优先于桌面宽度：手机横屏宽但很矮
    let mode: LayoutMode;
    if (width > height && height < 500) mode = 'landscape';
    else if (width >= 1024 && height >= 600) mode = 'desktop';
    else mode = 'portrait';

    const pad = mode === 'landscape' ? 4 : mode === 'portrait' ? 8 : 10;

    const topbar = rectOf(document.querySelector('.topbar'));
    let top = (topbar?.bottom ?? 0) + pad;

    let bottom = height - pad;
    const exclusions: Element[] = [];
    const transport = document.querySelector('.transport');
    const legal = document.querySelector('.legal');
    const notePanel = document.querySelector('#note-panel');
    if (transport) {
      exclusions.push(transport);
      // 播放栏实际高度随字号 / 安全区 / 换行变化，量出来供材料行与提示条定位
      const t = rectOf(transport);
      if (t) {
        document.body.style.setProperty('--transport-height', `${Math.round(t.height)}px`);
      }
    }
    if (legal) exclusions.push(legal);
    if (notePanel && !(notePanel as HTMLElement).hidden) {
      exclusions.push(notePanel);
      // 材料折叠按钮 / 提示条据此让到编辑条上方（编辑条可能换行变高）
      const panelRect = rectOf(notePanel);
      if (panelRect) {
        document.body.style.setProperty('--note-panel-height', `${Math.round(panelRect.height)}px`);
      }
    }
    // 桌面材料行是侧栏，不挤占中央舞台；手机材料行横跨舞台，必须让开
    const rows = document.querySelector('#rows-wrap');
    if (rows && mode !== 'desktop') exclusions.push(rows);

    for (const el of exclusions) {
      const r = rectOf(el);
      if (!r) continue;
      const overlapsWidth = r.right > 0 && r.left < width;
      if (overlapsWidth && r.top < bottom) bottom = r.top;
    }
    bottom -= pad;

    if (bottom - top < 80) {
      // 空间实在不够时宁可舞台很矮，也不能把 bottom 抬回被顶栏 / 播放栏覆盖的区域
      bottom = Math.max(top + 40, bottom);
    }

    const safe = this.safeInsets();
    const left = Math.max(pad + safe.left, pad);
    const right = Math.max(left + 120, width - pad - safe.right);
    const rect: StageViewport = {
      left: Math.round(left),
      top: Math.round(top),
      width: Math.max(120, Math.round(right - left)),
      height: Math.max(40, Math.round(bottom - top)),
    };

    const canvasRect = this.canvas?.getBoundingClientRect();
    const canvasWidth = Math.max(1, Math.round(canvasRect?.width || width));
    const canvasHeight = Math.max(1, Math.round(canvasRect?.height || height));

    return { rect, mode, orientationChanged, canvasWidth, canvasHeight };
  }

  /** 刘海 / 圆角安全区：用一个隐藏探针读出 env()，避免左右列落进不可见区域 */
  private safeInsets(): { left: number; right: number } {
    if (typeof document === 'undefined') return { left: 0, right: 0 };
    if (!this.safeProbe) {
      const probe = document.createElement('div');
      probe.style.cssText =
        'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
        'padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);';
      document.body.appendChild(probe);
      this.safeProbe = probe;
    }
    const style = getComputedStyle(this.safeProbe);
    return {
      left: parseFloat(style.paddingLeft) || 0,
      right: parseFloat(style.paddingRight) || 0,
    };
  }
}

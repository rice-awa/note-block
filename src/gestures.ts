/**
 * 舞台指针状态机：单指绘制 / 选中 / 拖动 / 转视角，双指平移 + 缩放。
 *
 * 只做「谁在操作、什么时候接管」的判断；真正的曲谱、相机与历史由 main 注入。
 * 多指接管时只回滚当前尚未完成的事务，不产生新的撤销条目。
 */
import type { HandleSide, PaintCell, ScreenPoint } from './scene';

export interface GestureNote {
  step: number;
  row: number;
}

export interface GestureHost {
  /** 抽屉打开 / 正在拖边缘时，画布不处理新指针 */
  isBlocked(): boolean;
  hitResizeHandle(e: ScreenPoint): HandleSide | null;
  startResize(side: HandleSide, e: PointerEvent): void;

  pickBlock(e: ScreenPoint): GestureNote | null;
  cellAt(e: ScreenPoint): PaintCell | null;

  /** 第一指按下音符：记录手势前快照，但还不开始移动 */
  notePointerDown(note: GestureNote): void;
  noteDragStart(note: GestureNote, origin: ScreenPoint, e: PointerEvent): void;
  noteDragMove(e: PointerEvent): void;
  noteDragEnd(): void;
  noteDragCancel(): void;
  /** 未超过阈值就松手：选中 */
  noteSelect(note: GestureNote): void;
  /** 点背景（未拖动）：清除选择 */
  backgroundClick(): void;

  paintStart(e: PointerEvent, cell: PaintCell): void;
  paintMove(e: PointerEvent): void;
  paintEnd(): void;
  /** 双指接管时回滚当前笔触（绘制或擦除） */
  cancelStroke(): void;

  eraseStart(e: PointerEvent): void;
  eraseMove(e: PointerEvent): void;
  eraseEnd(): void;

  orbitMove(dx: number, dy: number): void;
  orbitEnd(): void;
  panMove(dx: number, dy: number): void;
  panEnd(): void;

  twoFingerStart(anchor: { x: number; y: number }): void;
  /** scale = 当前两指距离 / 手势起始距离（>1 表示张开） */
  twoFingerMove(scale: number, cx: number, cy: number): void;
  twoFingerEnd(): void;

  parallax(e: PointerEvent): void;
  hover(e: PointerEvent): void;
  leave(): void;
  interaction(): void;
  cursor(kind: 'default' | 'crosshair' | 'grab' | 'grabbing' | 'move'): void;
}

type Mode =
  | 'idle'
  | 'pending-note'
  | 'drag-note'
  | 'paint'
  | 'erase'
  | 'orbit'
  | 'pan'
  | 'two-finger'
  | 'wait-release';

interface PointerState {
  x: number;
  y: number;
  type: string;
}

interface PendingNote {
  note: GestureNote;
  pointerId: number;
  downX: number;
  downY: number;
  threshold: number;
}

export class GestureController {
  private readonly canvas: HTMLCanvasElement;
  private readonly host: GestureHost;
  private readonly pointers = new Map<number, PointerState>();
  private mode: Mode = 'idle';
  private pending: PendingNote | null = null;
  private orbitLast: { x: number; y: number } | null = null;
  private orbitMoved = false;
  private panLast: { x: number; y: number } | null = null;
  private two: { startDist: number } | null = null;
  private orbitTravel = 0;
  private orbitPending = { x: 0, y: 0 };
  private bound = false;

  constructor(canvas: HTMLCanvasElement, host: GestureHost) {
    this.canvas = canvas;
    this.host = host;
  }

  get modeName(): Mode {
    return this.mode;
  }

  get pointerCount(): number {
    return this.pointers.size;
  }

  attach(): void {
    if (this.bound) return;
    this.bound = true;
    this.canvas.addEventListener('pointerdown', this.onDown);
    this.canvas.addEventListener('pointermove', this.onMove);
    this.canvas.addEventListener('pointerup', this.onUp);
    this.canvas.addEventListener('pointercancel', this.onCancel);
    this.canvas.addEventListener('lostpointercapture', this.onLostCapture);
    this.canvas.addEventListener('pointerleave', this.onLeave);
  }

  detach(): void {
    if (!this.bound) return;
    this.bound = false;
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointercancel', this.onCancel);
    this.canvas.removeEventListener('lostpointercapture', this.onLostCapture);
    this.canvas.removeEventListener('pointerleave', this.onLeave);
  }

  /** Esc / 打开抽屉 / 旋转屏幕：结束所有事务并清空指针集合 */
  cancelAll(): void {
    this.cancelActive();
    this.pointers.clear();
    this.mode = 'idle';
    this.two = null;
    this.pending = null;
    this.orbitLast = null;
    this.panLast = null;
    this.host.cursor('default');
  }

  private cancelActive(): void {
    switch (this.mode) {
      case 'pending-note':
      case 'drag-note':
        this.host.noteDragCancel();
        break;
      case 'paint':
      case 'erase':
        this.host.cancelStroke();
        break;
      case 'orbit':
        this.host.orbitEnd();
        break;
      case 'pan':
        this.host.panEnd();
        break;
      case 'two-finger':
        this.host.twoFingerEnd();
        break;
      default:
        break;
    }
    this.pending = null;
    this.orbitLast = null;
    this.panLast = null;
    this.two = null;
    this.orbitPending = { x: 0, y: 0 };
  }

  private capture(id: number): void {
    try {
      this.canvas.setPointerCapture(id);
    } catch {
      /* 合成事件没有真实 pointerId */
    }
  }

  private readonly onDown = (e: PointerEvent): void => {
    if (this.host.isBlocked()) return;
    this.host.interaction();

    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });

    // 等待全部手指离开：双指结束后剩余的手指不能立刻变成绘制 / 转向
    if (this.mode === 'wait-release') return;

    // 三指及以上：首版进入 wait-release，避免换指时基准跳动
    if (this.pointers.size >= 3) {
      this.cancelActive();
      this.mode = 'wait-release';
      this.host.cursor('default');
      return;
    }

    // 第二根有效手指：多指导航优先，回滚尚未完成的事务
    if (this.pointers.size >= 2) {
      this.cancelActive();
      this.beginTwoFinger(e);
      return;
    }

    if (e.button === 1) {
      e.preventDefault();
      this.mode = 'pan';
      this.panLast = { x: e.clientX, y: e.clientY };
      this.capture(e.pointerId);
      this.host.cursor('move');
      return;
    }

    if (e.button === 2) {
      if (this.mode === 'idle') {
        this.mode = 'erase';
        this.host.eraseStart(e);
        this.capture(e.pointerId);
      }
      return;
    }

    if (e.button !== 0) return;

    // 同一指针的第二个按钮（例如擦除中按下左键）不开启新事务
    if (this.mode !== 'idle') return;

    const side = this.host.hitResizeHandle(e);
    if (side) {
      this.mode = 'idle';
      this.host.startResize(side, e);
      return;
    }

    const note = this.host.pickBlock(e);
    if (note) {
      this.mode = 'pending-note';
      this.pending = {
        note,
        pointerId: e.pointerId,
        downX: e.clientX,
        downY: e.clientY,
        threshold: e.pointerType === 'mouse' ? 4 : 8,
      };
      this.host.notePointerDown(note);
      this.capture(e.pointerId);
      this.host.cursor('grab');
      return;
    }

    const cell = this.host.cellAt(e);
    if (cell) {
      this.mode = 'paint';
      this.host.paintStart(e, cell);
      this.capture(e.pointerId);
      this.host.cursor('crosshair');
      return;
    }

    this.mode = 'orbit';
    this.orbitLast = { x: e.clientX, y: e.clientY };
    this.orbitMoved = false;
    this.orbitTravel = 0;
    this.orbitPending = { x: 0, y: 0 };
    this.capture(e.pointerId);
    this.host.cursor('grabbing');
  };

  private beginTwoFinger(e: PointerEvent): void {
    this.mode = 'two-finger';
    this.two = { startDist: this.distance() };
    this.capture(e.pointerId);
    this.host.cursor('grabbing');
    this.host.twoFingerStart(this.midpoint());
  }

  private readonly onMove = (e: PointerEvent): void => {
    const p = this.pointers.get(e.pointerId);
    if (p) {
      p.x = e.clientX;
      p.y = e.clientY;
    }

    if (this.mode === 'wait-release') return;

    if (this.mode === 'two-finger') {
      if (this.pointers.size >= 2 && this.two) {
        const mid = this.midpoint();
        const scale = Math.max(8, this.distance()) / Math.max(8, this.two.startDist);
        this.host.twoFingerMove(scale, mid.x, mid.y);
      }
      return;
    }

    switch (this.mode) {
      case 'pending-note': {
        const pending = this.pending;
        if (!pending || e.pointerId !== pending.pointerId) return;
        const dx = e.clientX - pending.downX;
        const dy = e.clientY - pending.downY;
        if (Math.hypot(dx, dy) < pending.threshold) return;
        this.mode = 'drag-note';
        this.host.noteDragStart(pending.note, { clientX: pending.downX, clientY: pending.downY }, e);
        this.host.noteDragMove(e);
        this.host.cursor('grabbing');
        return;
      }
      case 'drag-note':
        this.host.noteDragMove(e);
        return;
      case 'paint':
        this.host.paintMove(e);
        return;
      case 'erase':
        this.host.eraseMove(e);
        return;
      case 'orbit': {
        const last = this.orbitLast;
        if (!last) return;
        const dx = e.clientX - last.x;
        const dy = e.clientY - last.y;
        if (dx !== 0 || dy !== 0) {
          this.orbitTravel += Math.abs(dx) + Math.abs(dy);
          if (!this.orbitMoved && this.orbitTravel > 3) {
            // 越过阈值才真正开始旋转，先补发阈值内的累计位移
            this.orbitMoved = true;
            this.host.orbitMove(this.orbitPending.x + dx, this.orbitPending.y + dy);
            this.orbitPending = { x: 0, y: 0 };
          } else if (this.orbitMoved) {
            this.host.orbitMove(dx, dy);
          } else {
            this.orbitPending.x += dx;
            this.orbitPending.y += dy;
          }
        }
        last.x = e.clientX;
        last.y = e.clientY;
        return;
      }
      case 'pan': {
        const last = this.panLast;
        if (!last) return;
        this.host.panMove(e.clientX - last.x, e.clientY - last.y);
        last.x = e.clientX;
        last.y = e.clientY;
        return;
      }
      case 'idle':
        this.host.parallax(e);
        if (e.pointerType !== 'touch') this.host.hover(e);
        return;
      default:
        return;
    }
  };

  private readonly onUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);

    if (this.mode === 'two-finger') {
      this.host.twoFingerEnd();
      this.two = null;
      this.mode = this.pointers.size > 0 ? 'wait-release' : 'idle';
      this.host.cursor('default');
      return;
    }

    if (this.mode === 'wait-release') {
      if (this.pointers.size === 0) this.mode = 'idle';
      return;
    }

    if (this.pending && e.pointerId !== this.pending.pointerId) return;

    switch (this.mode) {
      case 'pending-note': {
        const pending = this.pending;
        this.pending = null;
        this.mode = 'idle';
        this.host.cursor('default');
        if (pending) this.host.noteSelect(pending.note);
        return;
      }
      case 'drag-note':
        this.mode = 'idle';
        this.pending = null;
        this.host.noteDragEnd();
        this.host.cursor('default');
        return;
      case 'paint':
        this.mode = 'idle';
        this.host.paintEnd();
        this.host.cursor('default');
        return;
      case 'erase':
        this.mode = 'idle';
        this.host.eraseEnd();
        this.host.cursor('default');
        return;
      case 'orbit': {
        const moved = this.orbitMoved;
        this.mode = 'idle';
        this.orbitMoved = false;
        this.orbitLast = null;
        this.orbitPending = { x: 0, y: 0 };
        this.host.orbitEnd();
        this.host.cursor('default');
        if (!moved) this.host.backgroundClick();
        return;
      }
      case 'pan':
        this.mode = 'idle';
        this.panLast = null;
        this.host.panEnd();
        this.host.cursor('default');
        return;
      default:
        if (this.pointers.size === 0) {
          this.mode = 'idle';
          this.host.cursor('default');
        }
    }
  };

  private readonly onCancel = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    this.cancelActive();
    this.mode = this.pointers.size > 0 ? 'wait-release' : 'idle';
    this.host.cursor('default');
  };

  private readonly onLostCapture = (e: PointerEvent): void => {
    // pointerup 后浏览器也会触发 lostpointercapture；只有事务仍处于活动状态才取消
    if (this.mode === 'idle' || this.mode === 'wait-release') return;
    if (!this.pointers.has(e.pointerId)) return;
    this.onCancel(e);
  };

  private readonly onLeave = (): void => {
    if (this.mode === 'idle') this.host.leave();
  };

  private distance(): number {
    const list = [...this.pointers.values()];
    if (list.length < 2) return 0;
    return Math.hypot(list[0].x - list[1].x, list[0].y - list[1].y);
  }

  private midpoint(): { x: number; y: number } {
    const list = [...this.pointers.values()];
    if (list.length < 2) return { x: 0, y: 0 };
    return { x: (list[0].x + list[1].x) / 2, y: (list[0].y + list[1].y) / 2 };
  }
}

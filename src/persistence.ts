/**
 * 保存协调器：防抖、revision、可判别结果与状态文案。
 * 底层存取仍在 song.ts；这里只决定「什么时候写、写的是哪一版、UI 该显示什么」。
 */
import { saveLocal, type SaveFailure, type SaveResult, type SongState } from './song';

export type SaveStatus = 'local' | 'dirty' | 'saving' | 'saved' | 'failed';

export interface SaveSnapshot {
  status: SaveStatus;
  /** 最后一次成功写入的时间（ms）；失败不会覆盖它 */
  lastSavedAt: number | null;
  /** 只存在当前 revision 的失败原因 */
  reason: SaveFailure | null;
  revision: number;
  /** 是否有未写入成功的最新改动 */
  pending: boolean;
}

export interface SaveCoordinatorOptions {
  getState: () => SongState;
  onStatus: (snapshot: SaveSnapshot) => void;
  debounceMs?: number;
  now?: () => number;
}

export function saveFailureText(reason: SaveFailure | null): string {
  if (reason === 'quota') return '存储空间已满';
  if (reason === 'unavailable') return '浏览器不允许访问存储';
  return '写入失败';
}

/** 相对时间：刚刚 / N 秒前 / N 分钟前 */
export function savedAgoText(lastSavedAt: number | null, nowMs: number): string {
  if (!lastSavedAt) return '';
  const seconds = Math.max(0, Math.round((nowMs - lastSavedAt) / 1000));
  if (seconds < 5) return '刚刚';
  if (seconds < 60) return `${seconds} 秒前`;
  return `${Math.floor(seconds / 60)} 分钟前`;
}

/** 数据区 / 主界面共用的状态文案 */
export function saveStatusText(snapshot: SaveSnapshot, nowMs: number): string {
  switch (snapshot.status) {
    case 'local':
      return '保存在此浏览器';
    case 'dirty':
      return '有修改，等待保存';
    case 'saving':
      return '正在保存…';
    case 'saved':
      return `已保存到此浏览器 · ${savedAgoText(snapshot.lastSavedAt, nowMs)}`;
    case 'failed':
      return `未保存到本机 · ${saveFailureText(snapshot.reason)}`;
  }
}

export class SaveCoordinator {
  private readonly getState: () => SongState;
  private readonly onStatus: (snapshot: SaveSnapshot) => void;
  private readonly debounceMs: number;
  private readonly now: () => number;

  private status: SaveStatus = 'local';
  private lastSavedAt: number | null = null;
  private reason: SaveFailure | null = null;
  private revision = 0;
  private timer = 0;
  private disposed = false;

  constructor(opts: SaveCoordinatorOptions) {
    this.getState = opts.getState;
    this.onStatus = opts.onStatus;
    this.debounceMs = Math.max(0, opts.debounceMs ?? 500);
    this.now = opts.now ?? (() => Date.now());
  }

  get snapshot(): SaveSnapshot {
    return {
      status: this.status,
      lastSavedAt: this.lastSavedAt,
      reason: this.reason,
      revision: this.revision,
      pending: this.status === 'dirty' || this.status === 'saving' || this.status === 'failed',
    };
  }

  /** 载入已有存档时把「最后成功时间」交给协调器，避免启动后显示 0 分钟前 */
  adoptSavedAt(at: number | null): void {
    this.lastSavedAt = at && at > 0 ? at : null;
    this.status = 'local';
    this.reason = null;
    this.emit();
  }

  /** 启动时存储不可用：不要假装作品已经在本机保存 */
  adoptFailure(reason: SaveFailure): void {
    this.reason = reason;
    this.status = 'failed';
    this.emit();
  }

  /** 曲谱发生变化：revision 递增，防抖后写入 */
  markDirty(): void {
    if (this.disposed) return;
    this.revision += 1;
    // 一次写入失败后保持「未保存」外观，直到真正写成功，避免状态闪烁
    if (this.status !== 'failed') this.status = 'dirty';
    this.emit();
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.flush(), this.debounceMs);
  }

  /** 立即提交最新 revision（切后台 / 关闭页面 / 手动重试） */
  flush(): SaveResult {
    if (this.disposed) return { ok: true };
    window.clearTimeout(this.timer);
    this.timer = 0;
    const rev = this.revision;
    this.status = 'saving';
    this.emit();

    const result = saveLocal(this.getState());

    // 写入期间若又发生编辑，旧结果不能覆盖新的 dirty 状态
    if (rev !== this.revision) {
      if (result.ok) {
        this.lastSavedAt = this.now();
        this.status = 'dirty';
      } else {
        this.reason = result.reason;
        this.status = 'failed';
      }
      this.emit();
      return result;
    }

    if (result.ok) {
      this.lastSavedAt = this.now();
      this.reason = null;
      this.status = 'saved';
    } else {
      // 失败不更新最后成功时间，也不显示「刚刚保存」
      this.reason = result.reason;
      this.status = 'failed';
    }
    this.emit();
    return result;
  }

  /** 失败后重试：只写最新内容 */
  retry(): SaveResult {
    if (this.status !== 'failed') return { ok: true };
    return this.flush();
  }

  dispose(): void {
    this.disposed = true;
    window.clearTimeout(this.timer);
    this.timer = 0;
  }

  private emit(): void {
    if (this.disposed) return;
    this.onStatus(this.snapshot);
  }
}

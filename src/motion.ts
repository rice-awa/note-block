/**
 * 弹簧：半隐式欧拉 + 固定 240Hz 子步。
 * response 不是时长，是"回到目标的大致时间"；damping < 1 才会回弹。
 * setTarget 时保留速度 —— 手势结束时交接速度靠的就是它。
 */
export class Spring {
  value: number;
  target: number;
  velocity = 0;
  response: number;
  damping: number;

  constructor(value = 0, response = 0.3, damping = 1) {
    this.value = value;
    this.target = value;
    this.response = response;
    this.damping = damping;
  }

  update(dt: number): number {
    const w = (Math.PI * 2) / Math.max(0.02, this.response);
    let remain = Math.min(Math.max(dt, 0), 0.1);
    const hMax = 1 / 240;
    while (remain > 0) {
      const h = Math.min(hMax, remain);
      remain -= h;
      const a = -w * w * (this.value - this.target) - 2 * this.damping * w * this.velocity;
      this.velocity += a * h;
      this.value += this.velocity * h;
    }
    return this.value;
  }

  setTarget(v: number, velocity?: number): void {
    this.target = v;
    if (velocity !== undefined) this.velocity = velocity;
  }

  impulse(v: number): void {
    this.velocity += v;
  }

  snap(v: number): void {
    this.value = v;
    this.target = v;
    this.velocity = 0;
  }
}

/** 帧率无关的指数平滑：永远别用 lerp(a,b,0.1) */
export const damp = (current: number, target: number, lambda: number, dt: number): number =>
  target + (current - target) * Math.exp(-lambda * dt);

export const clamp = (v: number, min: number, max: number): number =>
  v < min ? min : v > max ? max : v;

/** Apple 的动量投影：指数衰减，不是 v²/2a */
export const projectMomentum = (velocity: number, decel = 0.998): number =>
  (velocity / 1000) * (decel / (1 - decel));

/** 速度 → 倾斜（有上限，别让方块翻倒） */
export const tiltFromVelocity = (v: number, factor = 0.0018, max = 0.16): number =>
  clamp(v * factor, -max, max);

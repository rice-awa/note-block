import { BASE_MIDI } from './rows';

type Voice = { gain: number; sample: string };

const SFX = ['sfx_place', 'sfx_break', 'sfx_click'] as const;

/**
 * 全合成信号链之外的"原声"部分：音符盒采样 + 卷积混响 + 压缩。
 * AudioContext 只在第一次手势后创建/恢复（浏览器自动播放策略）。
 */
export class AudioEngine {
  ctx: AudioContext | null = null;
  buffers = new Map<string, AudioBuffer>();
  ready = false;
  muted = false;

  private master: GainNode | null = null;
  private dry: GainNode | null = null;
  private send: GainNode | null = null;
  private initPromise: Promise<void> | null = null;

  get now(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  async unlock(): Promise<void> {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
    }
    if (!this.initPromise) this.initPromise = this.init();
    try {
      await this.initPromise;
    } catch (err) {
      console.warn('[audio] init failed', err);
      return;
    }
    if (this.ctx.state !== 'running') {
      try {
        await this.ctx.resume();
      } catch {
        /* ignored */
      }
    }
  }

  private async init(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) throw new Error('no context');

    const master = ctx.createGain();
    master.gain.value = 0.82;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20;
    comp.knee.value = 26;
    comp.ratio.value = 3.2;
    comp.attack.value = 0.004;
    comp.release.value = 0.24;

    const dry = ctx.createGain();
    dry.gain.value = 1;

    const send = ctx.createGain();
    send.gain.value = 0.16;

    const conv = ctx.createConvolver();
    conv.buffer = this.makeIR(ctx, 1.9);

    dry.connect(master);
    send.connect(conv);
    conv.connect(master);
    master.connect(comp);
    comp.connect(ctx.destination);

    this.master = master;
    this.dry = dry;
    this.send = send;

    const samples = ['harp', 'bass', 'snare', 'hat', 'guitar', 'iron_xylophone', 'bell', 'chime', ...SFX];
    await Promise.all(
      samples.map(async (name) => {
        try {
          const res = await fetch(`/audio/${name}.wav`);
          if (!res.ok) throw new Error(String(res.status));
          const data = await res.arrayBuffer();
          const buf = await ctx.decodeAudioData(data);
          this.buffers.set(name, buf);
        } catch (err) {
          console.warn('[audio] sample failed', name, err);
        }
      }),
    );
    this.ready = this.buffers.size > 0;
  }

  private makeIR(ctx: BaseAudioContext, seconds: number): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * seconds);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = ir.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const noise = Math.random() * 2 - 1;
        // 高频先衰减，混响尾巴偏暖
        lp += (noise - lp) * (0.35 - t * 0.3);
        data[i] = lp * Math.pow(1 - t, 2.6);
      }
    }
    return ir;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master && this.ctx) {
      this.master.gain.cancelScheduledValues(this.ctx.currentTime);
      this.master.gain.setTargetAtTime(muted ? 0 : 0.82, this.ctx.currentTime, 0.03);
    }
  }

  /** when 是相对当前时间的秒数；midi 0..24，12 = 原速 */
  play(voice: Voice, midi: number, when = 0, extraGain = 1): void {
    const ctx = this.ctx;
    if (!ctx || !this.ready || this.muted) return;
    const buf = this.buffers.get(voice.sample);
    if (!buf) return;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = Math.pow(2, (midi - BASE_MIDI) / 12);

    const g = ctx.createGain();
    g.gain.value = voice.gain * extraGain;

    src.connect(g);
    if (this.dry) g.connect(this.dry);
    if (this.send) g.connect(this.send);

    src.start(ctx.currentTime + Math.max(0, when));
  }

  sfx(name: (typeof SFX)[number], when = 0, rate = 1, gain = 1): void {
    const ctx = this.ctx;
    if (!ctx || !this.ready || this.muted) return;
    const buf = this.buffers.get(name);
    if (!buf) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g);
    if (this.dry) g.connect(this.dry);
    if (this.send) g.connect(this.send);
    src.start(ctx.currentTime + Math.max(0, when));
  }
}

export interface ScheduledStep {
  time: number;
  step: number;
}

/**
 * 音序器时钟：以 AudioContext 为主时钟，向前调度 120ms。
 * 视觉不在 setTimeout 里播 —— 视觉读的是 scheduled 队列，到点才触发。
 */
export class Clock {
  bpm = 108;
  playing = false;
  scheduled: ScheduledStep[] = [];

  private anchor = 0;
  private basePos = 0;
  private nextTime = 0;
  private nextStep = 0;

  constructor(
    private audio: AudioEngine,
    private onSchedule: (step: number, when: number) => void,
  ) {}

  get stepDur(): number {
    return 60 / this.bpm / 4;
  }

  get position(): number {
    if (!this.audio.ctx) return 0;
    if (!this.playing) return this.basePos;
    const p = this.basePos + (this.audio.now - this.anchor) / this.stepDur;
    return ((p % 16) + 16) % 16;
  }

  play(): void {
    if (this.playing || !this.audio.ctx) return;
    this.playing = true;
    const now = this.audio.now;
    this.anchor = now + 0.06;
    this.nextStep = Math.ceil(this.basePos) % 16;
    const offset = Math.ceil(this.basePos) - this.basePos;
    this.nextTime = this.anchor + offset * this.stepDur;
    this.scheduled.length = 0;
  }

  pause(): void {
    if (!this.playing) return;
    this.basePos = this.position;
    this.playing = false;
    this.scheduled.length = 0;
  }

  toggle(): boolean {
    if (this.playing) this.pause();
    else this.play();
    return this.playing;
  }

  setBpm(bpm: number): void {
    const clamped = Math.max(60, Math.min(180, Math.round(bpm)));
    if (clamped === this.bpm) return;
    if (this.playing) {
      this.basePos = this.position;
      this.anchor = this.audio.now;
      this.nextStep = Math.ceil(this.basePos) % 16;
      const offset = Math.ceil(this.basePos) - this.basePos;
      this.bpm = clamped;
      this.nextTime = this.anchor + offset * this.stepDur;
      this.scheduled.length = 0;
    } else {
      this.bpm = clamped;
    }
  }

  /** 每帧调用：向前调度 + 到点交出视觉事件 */
  update(): void {
    const ctx = this.audio.ctx;
    if (!ctx || !this.playing) return;
    const now = ctx.currentTime;
    while (this.nextTime < now + 0.12) {
      this.onSchedule(this.nextStep, this.nextTime);
      this.scheduled.push({ time: this.nextTime, step: this.nextStep });
      this.nextTime += this.stepDur;
      this.nextStep = (this.nextStep + 1) % 16;
    }
  }

  /** 取出所有已到点的视觉步骤 */
  drainVisual(now: number): number[] {
    const out: number[] = [];
    while (this.scheduled.length && this.scheduled[0].time <= now) {
      out.push(this.scheduled.shift()!.step);
    }
    return out;
  }
}

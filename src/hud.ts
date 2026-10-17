import { ROWS } from './rows';

export class Hud {
  onPlay: (() => void) | null = null;
  onBpm: ((delta: number) => void) | null = null;
  onMuteRow: ((row: number) => void) | null = null;
  onSound: (() => void) | null = null;

  private playBtn = document.querySelector<HTMLButtonElement>('#play')!;
  private bpmEl = document.querySelector<HTMLElement>('#bpm')!;
  private stepsEl = document.querySelector<HTMLElement>('#steps')!;
  private rowsEl = document.querySelector<HTMLElement>('#rows')!;
  private hintEl = document.querySelector<HTMLElement>('#hint')!;
  private soundBtn = document.querySelector<HTMLButtonElement>('#sound')!;
  private stepDots: HTMLElement[] = [];
  private rowItems: HTMLButtonElement[] = [];
  private hintGone = false;

  constructor() {
    this.buildRows();
    this.buildSteps();
    this.playBtn.addEventListener('click', () => this.onPlay?.());
    this.soundBtn.addEventListener('click', () => this.onSound?.());
    document.querySelectorAll<HTMLButtonElement>('[data-bpm]').forEach((btn) => {
      btn.addEventListener('click', () => this.onBpm?.(Number(btn.dataset.bpm)));
    });
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
      const dot = document.createElement('span');
      dot.className = 'step';
      this.stepsEl.appendChild(dot);
      this.stepDots.push(dot);
    }
  }

  setPlaying(playing: boolean): void {
    document.body.classList.toggle('is-playing', playing);
    this.playBtn.setAttribute('aria-label', playing ? '暂停' : '播放');
  }

  setBpm(bpm: number): void {
    this.bpmEl.textContent = String(bpm);
  }

  setStep(step: number): void {
    this.stepDots.forEach((dot, i) => dot.classList.toggle('on', i === step));
  }

  setMuted(muted: boolean): void {
    this.soundBtn.classList.toggle('is-muted', muted);
    this.soundBtn.setAttribute('aria-label', muted ? '取消静音' : '静音');
  }

  dismissHint(): void {
    if (this.hintGone) return;
    this.hintGone = true;
    this.hintEl.classList.add('gone');
  }
}

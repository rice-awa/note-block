import { BASE_MIDI, MAX_MIDI, MIN_MIDI } from './rows';

/**
 * 音高是相对基准采样的偏移索引，不是绝对音名：
 * 显示时一律相对 BASE_MIDI 表述，避免暗示具体音高。
 */
export function clampMidi(midi: number): number {
  if (!Number.isFinite(midi)) return BASE_MIDI;
  return Math.min(MAX_MIDI, Math.max(MIN_MIDI, Math.round(midi)));
}

/** 相对基准音的半音差（基准音 = 0）。 */
export function relativeSemitones(midi: number): number {
  return clampMidi(midi) - BASE_MIDI;
}

/** '基准音' / '+3 半音' / '−4 半音'（负号用 U+2212）。 */
export function formatRelative(midi: number): string {
  const semitones = relativeSemitones(midi);
  if (semitones === 0) return '基准音';
  return semitones > 0 ? `+${semitones} 半音` : `−${-semitones} 半音`;
}

/** '音高 15 / 24 · +3 半音' */
export function formatPitch(midi: number): string {
  return `音高 ${clampMidi(midi)} / ${MAX_MIDI} · ${formatRelative(midi)}`;
}

/** 步序号规整：四舍五入，负数与非有限值归 0。 */
function normalizeStep(step: number): number {
  if (!Number.isFinite(step)) return 0;
  return Math.max(0, Math.round(step));
}

const STEPS_PER_BAR = 16;
const STEPS_PER_BEAT = 4;

/** '第 2 小节 · 第 4 步'（面向用户，步从 1 数起） */
export function formatPosition(step: number): string {
  const s = normalizeStep(step);
  const bar = Math.floor(s / STEPS_PER_BAR) + 1;
  const stepInBar = (s % STEPS_PER_BAR) + 1;
  return `第 ${bar} 小节 · 第 ${stepInBar} 步`;
}

/** '第 2 拍'（每 4 步一拍，按小节内位置计） */
export function formatBeat(step: number): string {
  const s = normalizeStep(step);
  const beat = Math.floor((s % STEPS_PER_BAR) / STEPS_PER_BEAT) + 1;
  return `第 ${beat} 拍`;
}

/** 悬停提示：无音符时省略音高段。 */
export function formatHover(
  step: number,
  rowLabel: string,
  voice: string,
  midi: number | null,
): string {
  const parts = [rowLabel, voice];
  if (midi !== null) parts.push(formatPitch(midi));
  parts.push(formatPosition(step));
  return parts.join(' · ');
}

/** 编辑栏标题用的位置描述。 */
export function formatSelectionTitle(
  step: number,
  rowLabel: string,
  voice: string,
  midi: number,
): string {
  return `${rowLabel} · ${voice} · ${formatPosition(step)}`;
}

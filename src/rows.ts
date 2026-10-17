export interface RowDef {
  key: string;
  label: string;
  voice: string;
  tex: string;
  color: string;
  sample: string;
  gain: number;
  cutout?: boolean;
  emissive?: number;
}

/** 8 行 = 8 种地板材质 = 8 种音符盒音色（对应 Minecraft 的材质→乐器机制） */
export const ROWS: RowDef[] = [
  { key: 'harp', label: '草地', voice: 'Harp', tex: 'grass_block_top', color: '#8FBF63', sample: 'harp', gain: 0.95 },
  { key: 'bass', label: '原木', voice: 'Bass', tex: 'oak_log', color: '#A8865C', sample: 'bass', gain: 1.0 },
  { key: 'snare', label: '沙', voice: 'Snare', tex: 'sand', color: '#D9C998', sample: 'snare', gain: 0.72 },
  { key: 'hat', label: '玻璃', voice: 'Hat', tex: 'glass', color: '#A9D3D6', sample: 'hat', gain: 0.5, cutout: true },
  { key: 'guitar', label: '羊毛', voice: 'Guitar', tex: 'white_wool', color: '#E4DED2', sample: 'guitar', gain: 0.9 },
  { key: 'iron', label: '铁块', voice: 'Iron Xylo', tex: 'iron_block', color: '#B9BEC4', sample: 'iron_xylophone', gain: 0.6 },
  { key: 'bell', label: '金块', voice: 'Bell', tex: 'gold_block', color: '#D9B24C', sample: 'bell', gain: 0.55, emissive: 0.04 },
  { key: 'chime', label: '浮冰', voice: 'Chime', tex: 'packed_ice', color: '#A9C6DB', sample: 'chime', gain: 0.55 },
];

export const COLS = 16;
export const ROW_COUNT = ROWS.length;
export const BASE_MIDI = 12;
export const MIN_MIDI = 0;
export const MAX_MIDI = 24;

/** 演示曲：D 大调五声（midi 以 F#4 = 12 为基准） */
export const DEMO: Array<[step: number, row: number, midi: number]> = [
  // Harp — 主旋律
  [0, 0, 20], [3, 0, 15], [4, 0, 22], [6, 0, 12],
  [8, 0, 17], [10, 0, 24], [12, 0, 20], [14, 0, 15],
  // Bass — 根音
  [0, 1, 8], [4, 1, 3], [8, 1, 5], [12, 1, 3],
  // Snare — 反拍
  [4, 2, 12], [12, 2, 12], [14, 2, 12],
  // Hat — 四分（玻璃太多会变成一堆线框）
  [0, 3, 12], [4, 3, 14], [8, 3, 12], [12, 3, 14],
  // Guitar — 分解和弦
  [1, 4, 15], [2, 4, 17], [5, 4, 19], [6, 4, 17],
  [9, 4, 15], [10, 4, 17], [13, 4, 19], [14, 4, 17],
  // Iron xylophone — 点缀
  [2, 5, 19], [10, 5, 17],
  // Pling — 高光
  [7, 6, 24], [15, 6, 20],
  // Chime — 氛围
  [0, 7, 12], [8, 7, 15],
];

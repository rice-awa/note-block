import * as THREE from 'three';

/**
 * 相机预设：把"三视图"当成相机的一个状态机。
 * persp / top / front 是预设位，free 是用户手动 orbit / zoom 之后的状态；
 * 两者共享同一套 az / el / dist，所以切换永远从当前呈现值开始，天然可打断。
 */
export type ViewId = 'persp' | 'top' | 'front' | 'free';

export interface ViewPreset {
  id: Exclude<ViewId, 'free'>;
  label: string;
  az: number;
  el: number;
  fov: number;
  lookY: number;
  /** 视差强度：1 = 今天的透视全量，俯视要压到近乎 0 才不会让网格发糊 */
  parallax: number;
  /** 竖屏时把机位旋转 90°，让 16 列沿屏幕长边排 */
  rotatePortrait: boolean;
}

export const VIEW_ORDER: Array<Exclude<ViewId, 'free'>> = ['persp', 'top', 'front'];

export const VIEWS: Record<Exclude<ViewId, 'free'>, ViewPreset> = {
  persp: {
    id: 'persp',
    label: '透视',
    az: 0.5,
    el: 0.7,
    fov: 30,
    lookY: -1.25,
    parallax: 1,
    rotatePortrait: true,
  },
  top: {
    // 83°，真 90° 会丢高度感，且 lookAt 与 up 共线
    id: 'top',
    label: '俯视',
    az: 0,
    el: 1.45,
    fov: 30,
    lookY: -0.4,
    parallax: 0.12,
    rotatePortrait: true,
  },
  front: {
    id: 'front',
    label: '正视',
    az: 0,
    el: 0.34,
    fov: 30,
    lookY: -0.75,
    parallax: 0.35,
    rotatePortrait: true,
  },
};

const DEG = Math.PI / 180;

interface Basis {
  /** lookAt → 相机 */
  dir: THREE.Vector3;
  /** 相机 → lookAt */
  forward: THREE.Vector3;
  right: THREE.Vector3;
  up: THREE.Vector3;
}

export function cameraBasis(az: number, el: number): Basis {
  const dir = new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
  const forward = dir.clone().negate();
  const worldUp = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(forward, worldUp);
  if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
  right.normalize();
  const up = new THREE.Vector3().crossVectors(right, forward).normalize();
  return { dir, forward, right, up };
}

/**
 * 用"舞台 + 方块高度"的包围盒八个角反投影，求刚好装下它的相机距离。
 * 横竖屏、任何机位都同一套算法，不再手写 dist。
 */
export function fitDistance(opts: {
  az: number;
  el: number;
  fov: number;
  aspect: number;
  lookY: number;
  halfW: number;
  halfD: number;
  topY: number;
  margin?: number;
}): number {
  const { az, el, fov, aspect, lookY, halfW, halfD, topY } = opts;
  const margin = opts.margin ?? 1.06;
  const { forward, right, up } = cameraBasis(az, el);
  const tanV = Math.tan((fov * DEG) / 2);
  const tanH = tanV * Math.max(0.2, aspect);
  let dist = 0;
  for (const x of [-halfW, halfW]) {
    for (const z of [-halfD, halfD]) {
      for (const y of [0, topY]) {
        const p = new THREE.Vector3(x, y - lookY, z);
        const depthOffset = p.dot(forward); // 正 = 比 lookAt 更远离相机
        const cx = Math.abs(p.dot(right));
        const cy = Math.abs(p.dot(up));
        dist = Math.max(dist, cx / tanH - depthOffset, cy / tanV - depthOffset);
      }
    }
  }
  return Math.max(12, dist * margin);
}

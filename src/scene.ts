import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { clamp, damp, projectMomentum, Spring, tiltFromVelocity } from './motion';
import { BASE_MIDI, COLS, MAX_MIDI, MIN_MIDI, ROWS, ROW_COUNT } from './rows';

const CELL = 1;
const X0 = -COLS / 2; // -8
const Z0 = -ROW_COUNT / 2; // -4
const BLOCK_Y = 0.5;
const LIFT_Y = 0.94;

const cellX = (step: number): number => X0 + step + 0.5;
const cellZ = (row: number): number => Z0 + row + 0.5;
const stepFromX = (x: number): number => Math.round(x - X0 - 0.5);
const rowFromZ = (z: number): number => Math.round(z - Z0 - 0.5);

export interface Cell {
  step: number;
  row: number;
}

export interface BlockView {
  step: number;
  row: number;
  midi: number;
  mesh: THREE.Mesh;
  mat: THREE.MeshStandardMaterial;
  sx: Spring;
  sy: Spring;
  sz: Spring;
  ss: Spring;
  glow: number;
  delay: number;
  dragging: boolean;
  tiltX: number;
  tiltZ: number;
}

/** 音高 → 色相：低音青、高音橙，顶面颜色就是你在钢琴卷上的位置 */
export function pitchColor(midi: number, out = new THREE.Color()): THREE.Color {
  const t = clamp((midi - MIN_MIDI) / (MAX_MIDI - MIN_MIDI), 0, 1);
  const hue = 0.58 - t * 0.53;
  return out.setHSL(hue, 0.6, 0.46, THREE.SRGBColorSpace);
}

export class Studio {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;

  private cam = {
    az: 0.8,
    el: 1.0,
    dist: 38,
    taz: 0.5,
    tel: 0.7,
    tdist: 28,
    px: 0,
    py: 0,
    tpx: 0,
    tpy: 0,
  };
  private readonly lookAt = new THREE.Vector3(0, -1.25, 0);

  readonly blocks = new Map<string, BlockView>();
  private readonly blockGroup = new THREE.Group();
  private readonly textures = new Map<string, THREE.Texture>();
  private readonly floorTextures = new Map<string, THREE.Texture>();
  private readonly maxAniso: number;

  private caps!: THREE.InstancedMesh;
  private blobs!: THREE.InstancedMesh;
  private blobDummy = new THREE.Object3D();
  private capDummy = new THREE.Object3D();
  private capColor = new THREE.Color();
  private ghost!: THREE.Mesh;
  private ghostMat!: THREE.MeshStandardMaterial;
  private outline!: THREE.LineSegments;
  private playhead!: THREE.Group;
  private dust!: Dust;
  private motes!: Motes;

  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private dragPoint = new THREE.Vector3();

  private drag: {
    block: BlockView;
    ox: number;
    oz: number;
    vx: number;
    vz: number;
    lastX: number;
    lastZ: number;
    time: number;
  } | null = null;

  private elapsed = 0;
  private portrait = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.94;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.maxAniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 120);

    this.buildEnvironment();
    this.buildStage();
    this.buildFloor();
    this.buildProps();
    this.resize();
  }

  // ---------------------------------------------------------------- build

  private buildEnvironment(): void {
    const hemi = new THREE.HemisphereLight(0xfff8ec, 0xc9bda6, 0.32);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xfff1d8, 1.95);
    key.position.set(-7, 13.5, -5);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -14;
    key.shadow.camera.right = 14;
    key.shadow.camera.top = 14;
    key.shadow.camera.bottom = -14;
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 46;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.025;
    key.shadow.radius = 3;
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0xdfe8ff, 0.3);
    fill.position.set(9, 5, -7);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight(0xffe9c9, 0.22);
    rim.position.set(2, 3, -14);
    this.scene.add(rim);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.22;
    pmrem.dispose();

    // 悬浮舞台落在"隐形地面"上的柔影
    const shadowPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(70, 70),
      new THREE.ShadowMaterial({ color: 0x2f271b, opacity: 0.14 }),
    );
    shadowPlane.rotation.x = -Math.PI / 2;
    shadowPlane.position.y = -1.75;
    shadowPlane.receiveShadow = true;
    this.scene.add(shadowPlane);
  }

  private buildStage(): void {
    const slab = new THREE.Mesh(
      new RoundedBoxGeometry(17.8, 0.62, 9.8, 6, 0.16),
      new THREE.MeshStandardMaterial({ color: 0xfbf7ee, roughness: 0.94, metalness: 0 }),
    );
    slab.position.y = -0.33;
    slab.receiveShadow = true;
    slab.castShadow = true;
    this.scene.add(slab);

    const base = new THREE.Mesh(
      new RoundedBoxGeometry(18.5, 0.34, 10.5, 5, 0.15),
      new THREE.MeshStandardMaterial({ color: 0xeee5d4, roughness: 0.96, metalness: 0 }),
    );
    base.position.y = -0.78;
    base.receiveShadow = true;
    this.scene.add(base);
  }

  private loadTexture(name: string, repeatX = 1, repeatY = 1): THREE.Texture {
    const tex = new THREE.TextureLoader().load(`/tex/${name}.png`);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.maxAniso;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeatX, repeatY);
    return tex;
  }

  /** 地板是"安静的"，方块才是主角：把材质贴图提亮、去饱和 */
  private loadFloorTexture(name: string): THREE.Texture {
    const tex = new THREE.Texture();
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.maxAniso;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(COLS, 1);
    const placeholder = document.createElement('canvas');
    placeholder.width = placeholder.height = 1;
    const pctx = placeholder.getContext('2d');
    if (pctx) {
      pctx.fillStyle = '#f3ecdd';
      pctx.fillRect(0, 0, 1, 1);
    }
    tex.image = placeholder;
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = 16;
      c.height = 16;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 0, 0, 16, 16);
      ctx.fillStyle = 'rgba(250, 246, 235, 0.42)';
      ctx.fillRect(0, 0, 16, 16);
      tex.image = c;
      tex.needsUpdate = true;
    };
    img.src = `/tex/${name}.png`;
    return tex;
  }

  private buildFloor(): void {
    ROWS.forEach((row, r) => {
      const floorTex = this.loadFloorTexture(row.tex);
      this.floorTextures.set(row.key, floorTex);
      const mat = new THREE.MeshStandardMaterial({
        map: floorTex,
        roughness: 0.96,
        metalness: 0,
        transparent: !!row.cutout,
        alphaTest: row.cutout ? 0.3 : 0,
      });
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(COLS * CELL, CELL), mat);
      plane.rotation.x = -Math.PI / 2;
      plane.position.set(0, 0.001, cellZ(r));
      plane.receiveShadow = true;
      this.scene.add(plane);

      // 方块用的贴图：不重复
      this.textures.set(row.key, this.loadTexture(row.tex));
    });

    const veil = new THREE.Mesh(
      new THREE.PlaneGeometry(COLS * CELL, ROW_COUNT * CELL),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.07, depthWrite: false }),
    );
    veil.rotation.x = -Math.PI / 2;
    veil.position.y = 0.003;
    this.scene.add(veil);

    // 网格
    const thin: number[] = [];
    const bold: number[] = [];
    for (let i = 0; i <= COLS; i++) {
      const x = X0 + i;
      const arr = i % 4 === 0 ? bold : thin;
      arr.push(x, 0, Z0, x, 0, Z0 + ROW_COUNT);
    }
    for (let j = 0; j <= ROW_COUNT; j++) {
      const z = Z0 + j;
      thin.push(X0, 0, z, X0 + COLS, 0, z);
    }
    const mkLines = (pts: number[], opacity: number) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const lines = new THREE.LineSegments(
        g,
        new THREE.LineBasicMaterial({ color: 0x6b5c47, transparent: true, opacity: opacity * 0.55, depthWrite: false }),
      );
      lines.position.y = 0.006;
      return lines;
    };
    this.scene.add(mkLines(thin, 0.4));
    this.scene.add(mkLines(bold, 0.85));
  }

  private blockTexture(row: number): THREE.Texture {
    return this.textures.get(ROWS[row].key)!;
  }

  private buildProps(): void {
    // 悬停幽灵
    this.ghostMat = new THREE.MeshStandardMaterial({
      map: this.blockTexture(0),
      transparent: true,
      opacity: 0.45,
      roughness: 0.9,
      depthWrite: false,
    });
    this.ghost = new THREE.Mesh(new THREE.BoxGeometry(0.97, 0.97, 0.97), this.ghostMat);
    this.ghost.visible = false;
    this.ghost.castShadow = false;
    this.scene.add(this.ghost);

    // 选中框
    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.02, 1.02, 1.02));
    this.outline = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({ color: 0xc0392b, transparent: true, opacity: 0.9 }),
    );
    this.outline.visible = false;
    this.scene.add(this.outline);

    this.scene.add(this.blockGroup);

    // 音高色片：方块顶面的"珐琅嵌片"，一个 instanced mesh 画完所有音符
    this.caps = new THREE.InstancedMesh(
      new RoundedBoxGeometry(0.84, 0.035, 0.84, 2, 0.018),
      new THREE.MeshStandardMaterial({ roughness: 0.42, metalness: 0.02 }),
      256,
    );
    this.caps.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.caps.frustumCulled = false;
    this.caps.castShadow = false;
    this.caps.receiveShadow = true;
    this.caps.count = 0;
    this.caps.setColorAt(0, new THREE.Color(1, 1, 1));
    this.scene.add(this.caps);

    // 每块底下的接触阴影，把方块"按"在地板上
    const blobCanvas = document.createElement('canvas');
    blobCanvas.width = blobCanvas.height = 64;
    const bctx = blobCanvas.getContext('2d')!;
    const grad = bctx.createRadialGradient(32, 32, 2, 32, 32, 32);
    grad.addColorStop(0, 'rgba(40, 30, 14, 0.55)');
    grad.addColorStop(0.55, 'rgba(40, 30, 14, 0.22)');
    grad.addColorStop(1, 'rgba(40, 30, 14, 0)');
    bctx.fillStyle = grad;
    bctx.fillRect(0, 0, 64, 64);
    const blobTex = new THREE.CanvasTexture(blobCanvas);
    this.blobs = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1.5, 1.5),
      new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false, opacity: 0.5 }),
      256,
    );
    this.blobs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.blobs.frustumCulled = false;
    this.blobs.count = 0;
    this.blobs.renderOrder = 1;
    this.scene.add(this.blobs);

    // 播放头：地面一条暖色扫描线 + 前沿小立柱（浅色场景里不做光墙）
    this.playhead = new THREE.Group();
    const band = new THREE.Mesh(
      new THREE.PlaneGeometry(0.2, ROW_COUNT * CELL),
      new THREE.MeshBasicMaterial({ color: 0xcc4f22, transparent: true, opacity: 0.85, depthWrite: false }),
    );
    band.rotation.x = -Math.PI / 2;
    band.position.set(0, 0.014, 0);
    this.playhead.add(band);

    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(1.2, ROW_COUNT * CELL),
      new THREE.MeshBasicMaterial({ color: 0xf3a24a, transparent: true, opacity: 0.16, depthWrite: false }),
    );
    glow.rotation.x = -Math.PI / 2;
    glow.position.set(0, 0.012, 0);
    this.playhead.add(glow);

    const postMat = new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.55, metalness: 0.04 });
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.042, 1.08, 0.042), postMat);
    post.position.set(0, 0.51, Z0 + ROW_COUNT + 0.3);
    post.castShadow = true;
    this.playhead.add(post);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.11, 0.11), postMat);
    head.position.set(0, 1.04, Z0 + ROW_COUNT + 0.3);
    head.castShadow = true;
    this.playhead.add(head);

    this.playhead.position.x = X0 + 0.2;
    this.scene.add(this.playhead);

    this.dust = new Dust(this.scene);
    this.motes = new Motes(this.scene);
  }

  // ---------------------------------------------------------------- blocks

  private key(step: number, row: number): string {
    return `${step}:${row}`;
  }

  blockAt(step: number, row: number): BlockView | undefined {
    return this.blocks.get(this.key(step, row));
  }

  addBlock(step: number, row: number, midi = BASE_MIDI, animated = true): BlockView | null {
    if (this.blockAt(step, row)) return null;
    const rowDef = ROWS[row];
    const geom = new THREE.BoxGeometry(0.985, 0.985, 0.985);
    const colors = new Float32Array(24 * 3).fill(1);
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const mat = new THREE.MeshStandardMaterial({
      map: this.blockTexture(row),
      vertexColors: true,
      roughness: 0.82,
      metalness: 0.04,
    });
    if (rowDef.cutout) {
      mat.alphaTest = 0.35;
      mat.transparent = false;
    }
    mat.emissive = pitchColor(midi);
    mat.emissiveIntensity = rowDef.emissive ?? 0;

    const mesh = new THREE.Mesh(geom, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    const x = cellX(step);
    const z = cellZ(row);
    const y = animated ? 2.6 : BLOCK_Y;
    mesh.position.set(x, y, z);

    const block: BlockView = {
      step,
      row,
      midi,
      mesh,
      mat,
      sx: new Spring(x, 0.3, 0.85),
      sy: new Spring(y, 0.26, 0.66),
      sz: new Spring(z, 0.3, 0.85),
      ss: new Spring(animated ? 0.2 : 1, 0.32, 0.8),
      glow: 0,
      delay: animated ? (row * 0.55 + step) * 0.012 + 0.15 : 0,
      dragging: false,
      tiltX: 0,
      tiltZ: 0,
    };
    mesh.userData.block = block;
    this.applyPitch(block);
    this.blockGroup.add(mesh);
    this.blocks.set(this.key(step, row), block);

    if (animated) {
      block.sy.setTarget(BLOCK_Y, -1.5);
      block.ss.setTarget(1);
    }
    return block;
  }

  removeBlock(step: number, row: number, burst = 9): void {
    const key = this.key(step, row);
    const block = this.blocks.get(key);
    if (!block) return;
    this.blocks.delete(key);
    this.blockGroup.remove(block.mesh);
    const pos = block.mesh.position;
    if (burst > 0) {
      const color = ROWS[row].color;
      this.dust.spawn(pos.x, pos.y + 0.2, pos.z, color, burst, 2.1);
    }
    block.mesh.geometry.dispose();
    block.mat.dispose();
  }

  clear(): void {
    for (const b of [...this.blocks.values()]) {
      this.blockGroup.remove(b.mesh);
      b.mesh.geometry.dispose();
      b.mat.dispose();
    }
    this.blocks.clear();
  }

  setPitch(step: number, row: number, midi: number): void {
    const block = this.blockAt(step, row);
    if (!block) return;
    const next = Math.round(clamp(midi, MIN_MIDI, MAX_MIDI));
    if (next === block.midi) return;
    block.midi = next;
    this.applyPitch(block);
    block.glow = Math.max(block.glow, 0.7);
  }

  private applyPitch(block: BlockView): void {
    const c = pitchColor(block.midi);
    const attr = block.mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    // BoxGeometry 面顺序：px, nx, py, ny, pz, nz —— 8..11 是顶面
    for (let i = 8; i < 12; i++) {
      attr.setXYZ(i, c.r * 1.06, c.g * 1.06, c.b * 1.06);
    }
    attr.needsUpdate = true;
    block.mat.emissive.copy(c);
    block.mat.emissiveIntensity = ROWS[block.row].emissive ?? 0;
  }

  // ---------------------------------------------------------------- picking

  private setNDC(e: PointerEvent | WheelEvent | MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    this.ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  }

  private pointOnPlane(e: PointerEvent | WheelEvent | MouseEvent, y: number): THREE.Vector3 | null {
    this.setNDC(e);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    this.dragPlane.constant = -y;
    const hit = this.raycaster.ray.intersectPlane(this.dragPlane, this.dragPoint);
    return hit ? this.dragPoint.clone() : null;
  }

  pointerToCell(e: PointerEvent | WheelEvent | MouseEvent): Cell | null {
    const p = this.pointOnPlane(e, 0);
    if (!p) return null;
    const step = stepFromX(p.x);
    const row = rowFromZ(p.z);
    if (step < 0 || step >= COLS || row < 0 || row >= ROW_COUNT) return null;
    return { step, row };
  }

  pickBlock(e: PointerEvent | WheelEvent | MouseEvent): BlockView | null {
    this.setNDC(e);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.blockGroup.children, false);
    if (!hits.length) return null;
    return (hits[0].object.userData.block as BlockView) ?? null;
  }

  // ---------------------------------------------------------------- drag

  beginDrag(block: BlockView, e: PointerEvent): void {
    const p = this.pointOnPlane(e, LIFT_Y + 0.2);
    if (!p) return;
    this.drag = {
      block,
      ox: p.x - block.mesh.position.x,
      oz: p.z - block.mesh.position.z,
      vx: 0,
      vz: 0,
      lastX: p.x,
      lastZ: p.z,
      time: performance.now(),
    };
    block.dragging = true;
    block.sy.setTarget(BLOCK_Y + 0.42, 4.2);
  }

  dragTo(e: PointerEvent): void {
    if (!this.drag) return;
    const p = this.pointOnPlane(e, LIFT_Y + 0.2);
    if (!p) return;
    const b = this.drag.block;
    const nx = clamp(p.x - this.drag.ox, X0 - 0.5, X0 + COLS + 0.5);
    const nz = clamp(p.z - this.drag.oz, Z0 - 0.5, Z0 + ROW_COUNT + 0.5);
    const now = performance.now();
    const dt = Math.max(0.008, (now - this.drag.time) / 1000);
    this.drag.vx = damp(this.drag.vx, (nx - b.mesh.position.x) / dt, 18, dt);
    this.drag.vz = damp(this.drag.vz, (nz - b.mesh.position.z) / dt, 18, dt);
    this.drag.time = now;
    b.mesh.position.x = nx;
    b.mesh.position.z = nz;
    b.sx.snap(nx);
    b.sz.snap(nz);
    b.sy.update(0.016);
  }

  /** 松手：动量投影 → 选格 → 速度继承吸附；丢到场外 = 删除 */
  endDrag(): { removed: boolean } {
    const d = this.drag;
    if (!d) return { removed: false };
    this.drag = null;
    const b = d.block;
    b.dragging = false;
    // 松手前若停顿，速度要自然衰减，否则"停住再松手"也会飞出去
    const age = Math.max(0, (performance.now() - d.time) / 1000);
    const decay = Math.exp(-age * 14);
    const vx = d.vx * decay;
    const vz = d.vz * decay;
    const throwX = clamp(projectMomentum(vx, 0.9925), -3, 3);
    const throwZ = clamp(projectMomentum(vz, 0.9925), -3, 3);
    const px = b.mesh.position.x + throwX;
    const pz = b.mesh.position.z + throwZ;
    const rawStep = stepFromX(px);
    const rawRow = rowFromZ(pz);
    const outside = px < X0 - 0.45 || px > X0 + COLS + 0.45 || pz < Z0 - 0.45 || pz > Z0 + ROW_COUNT + 0.45;

    if (outside) {
      const { step, row } = b;
      this.removeBlock(step, row, 10);
      return { removed: true };
    }

    const step = clamp(rawStep, 0, COLS - 1);
    const row = clamp(rawRow, 0, ROW_COUNT - 1);
    const other = this.blockAt(step, row);
    const sameCell = step === b.step && row === b.row;

    if (other && other !== b) {
      // 占用 → 两块交换
      const oldStep = b.step;
      const oldRow = b.row;
      this.blocks.delete(this.key(step, row));
      this.blocks.delete(this.key(oldStep, oldRow));
      b.step = step;
      b.row = row;
      other.step = oldStep;
      other.row = oldRow;
      this.blocks.set(this.key(b.step, b.row), b);
      this.blocks.set(this.key(other.step, other.row), other);
      other.sx.setTarget(cellX(other.step), vx);
      other.sz.setTarget(cellZ(other.row), vz);
      other.sy.setTarget(BLOCK_Y, 1.2);
      other.glow = Math.max(other.glow, 0.35);
    }

    if (!sameCell && (!other || other === b)) {
      this.blocks.delete(this.key(b.step, b.row));
      b.step = step;
      b.row = row;
      this.blocks.set(this.key(step, row), b);
    }
    b.sx.setTarget(cellX(step), vx);
    b.sz.setTarget(cellZ(row), vz);
    b.sy.setTarget(BLOCK_Y, -1.2);
    b.glow = Math.max(b.glow, 0.25);
    b.mesh.position.y = BLOCK_Y;
    return { removed: false };
  }

  get isDragging(): boolean {
    return this.drag !== null;
  }

  dragTargetCell(): Cell | null {
    const b = this.drag?.block;
    if (!b) return null;
    return {
      step: clamp(stepFromX(b.mesh.position.x), 0, COLS - 1),
      row: clamp(rowFromZ(b.mesh.position.z), 0, ROW_COUNT - 1),
    };
  }

  // ---------------------------------------------------------------- hover / play

  setHover(cell: Cell | null, showGhost = true): void {
    if (!cell) {
      this.ghost.visible = false;
      this.outline.visible = false;
      return;
    }
    const occupied = !!this.blockAt(cell.step, cell.row);
    this.outline.visible = true;
    this.outline.position.set(cellX(cell.step), occupied ? BLOCK_Y : 0.505, cellZ(cell.row));
    this.outline.scale.setScalar(occupied ? 1 : 0.99);
    this.ghost.visible = !occupied && showGhost;
    if (!occupied && showGhost) {
      this.ghost.position.set(cellX(cell.step), 0.5, cellZ(cell.row));
      this.ghostMat.map = this.blockTexture(cell.row);
      this.ghostMat.needsUpdate = true;
    }
  }

  setPlayhead(pos: number): void {
    this.playhead.position.x = X0 + pos;
  }

  setPlayheadVisible(visible: boolean): void {
    this.playhead.visible = visible;
  }

  hit(step: number): void {
    for (const b of this.blocks.values()) {
      if (b.step !== step) continue;
      b.sy.impulse(3.6 + Math.random() * 1.2);
      b.glow = 1;
    }
  }

  // ---------------------------------------------------------------- camera

  orbit(dx: number, dy: number): void {
    this.cam.taz = clamp(this.cam.taz - dx * 0.0045, 0.12, 1.72);
    this.cam.tel = clamp(this.cam.tel + dy * 0.0035, 0.34, 0.92);
  }

  zoom(delta: number): void {
    this.cam.tdist = clamp(this.cam.tdist + delta * 0.012, 19, 36);
  }

  parallax(e: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    this.cam.tpx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.cam.tpy = ((e.clientY - rect.top) / rect.height) * 2 - 1;
  }

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const portrait = this.camera.aspect < 0.82;
    if (portrait !== this.portrait) {
      this.portrait = portrait;
      if (portrait) {
        this.cam.taz = 1.3;
        this.cam.tel = 0.82;
        this.cam.tdist = 46;
        this.lookAt.set(0, -1.0, 0);
      } else {
        this.cam.taz = 0.5;
        this.cam.tel = 0.7;
        this.cam.tdist = 28;
        this.lookAt.set(0, -1.25, 0);
      }
    }
  }

  // ---------------------------------------------------------------- frame

  update(dt: number): void {
    this.elapsed += dt;

    this.cam.az = damp(this.cam.az, this.cam.taz, 6, dt);
    this.cam.el = damp(this.cam.el, this.cam.tel, 6, dt);
    this.cam.dist = damp(this.cam.dist, this.cam.tdist, 4, dt);
    this.cam.px = damp(this.cam.px, this.cam.tpx, 4, dt);
    this.cam.py = damp(this.cam.py, this.cam.tpy, 4, dt);

    const az = this.cam.az + this.cam.px * 0.055 + Math.sin(this.elapsed * 0.16) * 0.006;
    const el = this.cam.el + this.cam.py * 0.03;
    const r = this.cam.dist;
    this.camera.position.set(
      this.lookAt.x + Math.cos(el) * Math.sin(az) * r,
      this.lookAt.y + Math.sin(el) * r,
      this.lookAt.z + Math.cos(el) * Math.cos(az) * r,
    );
    this.camera.lookAt(this.lookAt);

    for (const b of this.blocks.values()) {
      if (b.delay > 0) {
        b.delay -= dt;
      } else {
        b.ss.update(dt);
      }
      b.sx.update(dt);
      b.sy.update(dt);
      b.sz.update(dt);
      b.mesh.position.set(b.sx.value, b.sy.value, b.sz.value);
      b.mesh.scale.setScalar(Math.max(0.001, b.ss.value));

      const tvx = this.drag && this.drag.block === b ? this.drag.vx : 0;
      const tvz = this.drag && this.drag.block === b ? this.drag.vz : 0;
      b.tiltZ = damp(b.tiltZ, this.drag && this.drag.block === b ? -tiltFromVelocity(tvx) : 0, 14, dt);
      b.tiltX = damp(b.tiltX, this.drag && this.drag.block === b ? tiltFromVelocity(tvz) : 0, 14, dt);
      b.mesh.rotation.set(b.tiltX, 0, b.tiltZ);

      b.glow = Math.max(0, b.glow - dt * 6.5);
      b.mat.emissiveIntensity = (ROWS[b.row].emissive ?? 0) + b.glow * 0.42;
    }

    // 顶面音高色片跟随方块
    let ci = 0;
    for (const b of this.blocks.values()) {
      this.capDummy.position.set(b.sx.value, b.sy.value + 0.5 * b.ss.value, b.sz.value);
      this.capDummy.scale.setScalar(Math.max(0.001, b.ss.value));
      this.capDummy.rotation.set(b.tiltX, 0, b.tiltZ);
      this.capDummy.updateMatrix();
      this.caps.setMatrixAt(ci, this.capDummy.matrix);
      pitchColor(b.midi, this.capColor);
      this.caps.setColorAt(ci, this.capColor);
      ci++;
    }
    this.caps.count = ci;
    this.caps.instanceMatrix.needsUpdate = true;
    if (this.caps.instanceColor) this.caps.instanceColor.needsUpdate = true;

    let bi = 0;
    for (const b of this.blocks.values()) {
      const lift = Math.max(0, b.sy.value - 0.5);
      const k = Math.max(0.25, 1 - lift * 0.9) * b.ss.value;
      this.blobDummy.position.set(b.sx.value + 0.05, 0.02, b.sz.value + 0.05);
      this.blobDummy.rotation.set(-Math.PI / 2, 0, 0);
      this.blobDummy.scale.set(k, k, 1);
      this.blobDummy.updateMatrix();
      this.blobs.setMatrixAt(bi, this.blobDummy.matrix);
      bi++;
    }
    this.blobs.count = bi;
    this.blobs.instanceMatrix.needsUpdate = true;

    this.dust.update(dt);
    this.motes.update(dt, this.elapsed);

    if (this.outline.visible) {
      (this.outline.material as THREE.LineBasicMaterial).opacity = this.drag ? 0.35 : 0.9;
    }
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }
}

// ------------------------------------------------------------------ 粒子

interface DustItem {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  max: number;
  size: number;
  color: THREE.Color;
}

class Dust {
  private mesh: THREE.InstancedMesh;
  private items: DustItem[] = [];
  private capacity = 140;
  private dummy = new THREE.Object3D();

  constructor(scene: THREE.Scene) {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.02, transparent: true, opacity: 0.95 });
    this.mesh = new THREE.InstancedMesh(geo, mat, this.capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.count = 0;
    this.mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    scene.add(this.mesh);
  }

  spawn(x: number, y: number, z: number, color: string, count: number, power = 1): void {
    const c = new THREE.Color(color);
    for (let i = 0; i < count; i++) {
      const life = 0.42 + Math.random() * 0.3;
      this.items.push({
        pos: new THREE.Vector3(x + (Math.random() - 0.5) * 0.5, y + Math.random() * 0.25, z + (Math.random() - 0.5) * 0.5),
        vel: new THREE.Vector3(
          (Math.random() - 0.5) * 2.4 * power,
          1.6 * power + Math.random() * 1.6,
          (Math.random() - 0.5) * 2.4 * power,
        ),
        life,
        max: life,
        size: 0.055 + Math.random() * 0.055,
        color: c,
      });
      if (this.items.length > this.capacity) this.items.shift();
    }
  }

  update(dt: number): void {
    let n = 0;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.life -= dt;
      if (it.life <= 0) {
        this.items.splice(i, 1);
        continue;
      }
      it.vel.y -= 9.5 * dt;
      it.vel.multiplyScalar(1 - 1.6 * dt);
      it.pos.addScaledVector(it.vel, dt);
      const t = it.life / it.max;
      this.dummy.position.copy(it.pos);
      this.dummy.rotation.set(it.pos.x * 2, it.pos.y * 2, it.pos.z * 2);
      this.dummy.scale.setScalar(it.size * (0.35 + t * 0.65));
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(n, this.dummy.matrix);
      this.mesh.setColorAt(n, it.color);
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ 空气里的尘

class Motes {
  private mesh: THREE.InstancedMesh;
  private base: Array<{ x: number; y: number; z: number; s: number; p: number }> = [];
  private dummy = new THREE.Object3D();

  constructor(scene: THREE.Scene) {
    const n = 22;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xe2d9c6,
      roughness: 1,
      metalness: 0,
      transparent: true,
      opacity: 0.28,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, n);
    this.mesh.frustumCulled = false;
    for (let i = 0; i < n; i++) {
      this.base.push({
        x: (Math.random() - 0.5) * 26,
        y: -1 + Math.random() * 9,
        z: (Math.random() - 0.5) * 18,
        s: 0.018 + Math.random() * 0.03,
        p: Math.random() * Math.PI * 2,
      });
    }
    scene.add(this.mesh);
  }

  update(dt: number, t: number): void {
    void dt;
    this.base.forEach((m, i) => {
      this.dummy.position.set(
        m.x + Math.sin(t * 0.12 + m.p) * 0.7,
        m.y + Math.sin(t * 0.18 + m.p * 1.7) * 0.45,
        m.z + Math.cos(t * 0.1 + m.p) * 0.5,
      );
      this.dummy.rotation.set(t * 0.1 + m.p, t * 0.14 + m.p, 0);
      this.dummy.scale.setScalar(m.s);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

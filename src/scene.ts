import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { clamp, damp, projectMomentum, Spring, tiltFromVelocity } from './motion';
import { clampWindowCols, WINDOW_COLS_MAX, WINDOW_COLS_MIN, WINDOW_COLS_STEP } from './prefs';
import { BASE_MIDI, COLS, MAX_MIDI, MIN_MIDI, ROWS, ROW_COUNT } from './rows';
import { MAX_STEPS, MAX_STEPS_FINITE, type Note } from './song';
import { fitDistance, VIEW_ORDER, VIEWS, type ViewId } from './views';

const CELL = 1;
const Z0 = -ROW_COUNT / 2; // -4
const BLOCK_Y = 0.5;
const LIFT_Y = 0.94;

/**
 * 坐标解耦（v0.3 / M4）：方块局部坐标只依赖 step，窗口偏移全部落在 songGroup。
 *   block local x = step + 0.5
 *   songGroup.x   = -W/2 - viewStart
 *   world x       = step + 0.5 - W/2 - viewStart
 * 默认 W = 16 时与 v0.2 逐像素等价（v0.2 的 X0 = -8 已经合进 songGroup 的 -W/2）。
 */
const cellX = (step: number): number => step + 0.5;
const cellZ = (row: number): number => Z0 + row + 0.5;
/** 曲内局部 x → 步（取最近的格心） */
const stepFromX = (x: number): number => Math.round(x - 0.5);
/** 曲内局部 x → 步（格内 floor，绘制用） */
const stepFromXFloor = (x: number): number => Math.floor(x);
const rowFromZ = (z: number): number => Math.round(z - Z0 - 0.5);

/** 舞台的包围盒半尺寸，用于相机 fit（比石板本身略大，留出安全边） */
const STAGE_HALF_W_PAD = 1.2; // v0.2 的 9.2 = 16/2 + 1.2，默认构图保持不变
const STAGE_HALF_D = 5.4;
const STAGE_TOP_Y = 1.7;
/** 石板半宽 = W/2 + 0.9（默认 8.9 → 宽 17.8）；底座半宽 = W/2 + 1.25（默认 18.5） */
const SLAB_PAD = 0.9;
const BASE_PAD = 1.25;
/** 边缘手柄中心挂在石板边缘（比网格边缘外 0.9 格），命中区不在网格内 */
const HANDLE_EDGE_PAD = SLAB_PAD;

const prefersReducedMotion = (): boolean =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export interface Cell {
  step: number;
  row: number;
}

/** 绘制落格：格内按 floor 取整，并带回地板平面的局部 z（行滞回要用） */
export interface PaintCell extends Cell {
  lz: number;
}

/** 只需要屏幕坐标的事件（指针 / 滚轮 / 测试里构造的点） */
export interface ScreenPoint {
  clientX: number;
  clientY: number;
}

export type HandleSide = 'left' | 'right';
/** 边缘拖拽的三个阶段：按下 / 变换中 / 松手（含 Esc 取消） */
export type ResizePhase = 'start' | 'move' | 'end';

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
    fov: 30,
    tfov: 30,
    lookY: -1.25,
    tlookY: -1.25,
    parallax: 1,
    tparallax: 1,
    px: 0,
    py: 0,
    tpx: 0,
    tpy: 0,
    /** 中键平移：地面平面内的目标/当前偏移 */
    panX: 0,
    panZ: 0,
    tpanX: 0,
    tpanZ: 0,
  };
  private readonly lookAt = new THREE.Vector3(0, -1.25, 0);
  private viewId: ViewId = 'persp';
  private zoomMin = 18;
  private zoomMax = 46;
  /** 预设 / 自由状态变化时通知 UI */
  onViewChange: ((id: ViewId) => void) | null = null;

  readonly blocks = new Map<string, BlockView>();
  private readonly blockGroup = new THREE.Group();
  /** 所有"跟着曲子走"的东西都挂在这里：只动 position.x = -W/2 - viewStart */
  private readonly songGroup = new THREE.Group();
  private readonly stepIndex = new Map<number, BlockView[]>();
  private viewStart = 0;
  private viewStartTarget = 0;
  private infinite = false;
  /** 坐标上限：有限模式为曲长，无限模式为工程安全边界 */
  private stepLimit = MAX_STEPS_FINITE;
  /** 窗口能滑到的最远步数（避免滑进大片空白） */
  private windowLimit = MAX_STEPS_FINITE;
  /** 曲长超过一屏：有限长曲与无限模式都要能横向滑动窗口 */
  private scrollable = false;
  private playheadPos = 0;
  private playheadShown = false;
  private maxStepValue = -1;
  private maxStepDirty = false;
  /** 当前窗口内可见的方块（每帧重收，渲染循环只遍历它） */
  private visibleBlocks: BlockView[] = [];
  private readonly textures = new Map<string, THREE.Texture>();
  private readonly floorTextures = new Map<string, THREE.Texture>();
  private readonly maxAniso: number;

  /** 可见列数（8..32，4 列吸附）：拖边缘或配置面板都改它 */
  private windowColsValue = COLS;
  /** 每次重建舞台几何的耗时（ms），给性能验收用 */
  private rebuildMs = 0;
  /** 舞台变宽/变窄后通知外部（main 负责偏好、音效、滚动能力） */
  onResize: ((cols: number, phase: ResizePhase) => void) | null = null;

  private slab: THREE.Mesh | null = null;
  private base: THREE.Mesh | null = null;
  private veil: THREE.Mesh | null = null;
  private readonly floorPlanes: THREE.Mesh[] = [];
  private hLines: THREE.LineSegments | null = null;
  private slabMat!: THREE.MeshStandardMaterial;
  private baseMat!: THREE.MeshStandardMaterial;
  private veilMat!: THREE.MeshBasicMaterial;
  private hLineMat!: THREE.LineBasicMaterial;
  private readonly floorMats: Record<string, THREE.MeshStandardMaterial> = {};
  private keyLight!: THREE.DirectionalLight;

  private handles: { left: HTMLDivElement; right: HTMLDivElement } | null = null;
  private capsule: HTMLDivElement | null = null;
  /** 手柄屏幕中心（每帧投影石板边缘中点） */
  private readonly handleScreen: Record<HandleSide, { x: number; y: number }> = {
    left: { x: 0, y: 0 },
    right: { x: 0, y: 0 },
  };
  /** 网格边缘中点的屏幕位置（淡入判定用） */
  private readonly edgeScreen: Record<HandleSide, { x: number; y: number }> = {
    left: { x: 0, y: 0 },
    right: { x: 0, y: 0 },
  };
  /** 手柄"落位"弹簧：松手后从手指位置弹回吸附后的边缘 */
  private readonly handleSpring: Record<HandleSide, Spring> = {
    left: new Spring(0, 0.35, 0.9),
    right: new Spring(0, 0.35, 0.9),
  };
  /** 手柄沿屏幕外法线的角度（弧度）：命中区跟着转，避免压住网格 */
  private readonly handleAngle: Record<HandleSide, number> = { left: 0, right: 0 };
  /** 触屏命中区 44px，与 CSS @media (pointer: coarse) 对齐 */
  private coarse = false;
  private handleNear: HandleSide | null = null;
  private resizeDrag: {
    side: HandleSide;
    pointerId: number;
    startCols: number;
    startWorldX: number;
    startView: number;
    clientX: number;
    clientY: number;
    /** 拖动中"想要"的半宽（未吸附、未夹住），手柄跟手用 */
    rawHalfW: number;
  } | null = null;

  private gridThin!: { lines: THREE.LineSegments; pos: Float32Array; attr: THREE.BufferAttribute };
  private gridBold!: { lines: THREE.LineSegments; pos: Float32Array; attr: THREE.BufferAttribute };
  private wipeBand!: THREE.Group;
  private wipe = { active: false, t: 0, dur: 0.34 };

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
  private readonly tempCamera = new THREE.PerspectiveCamera();

  /** 布局层量出的可用矩形：相机适配、投影、拾取共用这一套基准 */
  private stageRect = { left: 0, top: 0, width: 1, height: 1 };
  private stageRectSet = false;
  private pinch: { dist0: number; anchorWorld: THREE.Vector3 | null } | null = null;
  /** 正在播放销毁动画、但已经从曲谱数据里移除的方块 */
  private dying: Array<{ block: BlockView; at: number }> = [];
  private selection: Cell | null = null;
  private hoverCell: Cell | null = null;

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
    this.scene.add(this.songGroup);

    this.buildEnvironment();
    this.buildMaterials();
    this.buildStage();
    this.buildProps();
    this.buildHandles();
    this.coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
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
    this.keyLight = key;

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

  /** 材质与贴图只建一次：舞台宽度变化时复用（贴图只改 repeat） */
  private buildMaterials(): void {
    this.slabMat = new THREE.MeshStandardMaterial({ color: 0xfbf7ee, roughness: 0.94, metalness: 0 });
    this.baseMat = new THREE.MeshStandardMaterial({ color: 0xeee5d4, roughness: 0.96, metalness: 0 });
    this.veilMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.07, depthWrite: false });
    this.hLineMat = new THREE.LineBasicMaterial({ color: 0x6b5c47, transparent: true, opacity: 0.22, depthWrite: false });

    ROWS.forEach((row) => {
      const floorTex = this.loadFloorTexture(row.tex);
      this.floorTextures.set(row.key, floorTex);
      this.floorMats[row.key] = new THREE.MeshStandardMaterial({
        map: floorTex,
        roughness: 0.96,
        metalness: 0,
        transparent: !!row.cutout,
        alphaTest: row.cutout ? 0.3 : 0,
      });
      // 方块用的贴图：不重复
      this.textures.set(row.key, this.loadTexture(row.tex));
    });

    this.buildGrid();
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
    tex.repeat.set(this.windowColsValue, 1);
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

  /**
   * 竖向网格：容量一次按最大列数分配（32 + 4 / 32/4 + 4），
   * 宽度变化时不用重建缓冲，只改每帧写入的顶点数（见 updateGrid）。
   */
  private buildGrid(): void {
    // 竖向分隔线：无限模式下必须跟着 viewStart 滚，否则格线和音符会错位。
    // 只画窗口内可见的绝对步边界，每帧重写这几十个顶点，比"传送带"更简单也更准。
    const mkMovingGrid = (capacity: number, opacity: number) => {
      const pos = new Float32Array(capacity * 2 * 3);
      const g = new THREE.BufferGeometry();
      const attr = new THREE.BufferAttribute(pos, 3);
      attr.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('position', attr);
      g.setDrawRange(0, 0);
      const lines = new THREE.LineSegments(
        g,
        new THREE.LineBasicMaterial({ color: 0x6b5c47, transparent: true, opacity, depthWrite: false }),
      );
      lines.position.y = 0.006;
      lines.frustumCulled = false;
      this.scene.add(lines);
      return { lines, pos, attr };
    };
    this.gridThin = mkMovingGrid(WINDOW_COLS_MAX + 4, 0.2);
    this.gridBold = mkMovingGrid(WINDOW_COLS_MAX / WINDOW_COLS_STEP + 4, 0.47);
  }

  /**
   * 舞台几何只建一次（按默认 W=16 的原尺寸 = v0.2 的逐像素基准），
   * 宽度变化时只改 scale / 贴图 repeat：零分配，实测 <0.1ms（见 resizeStage）。
   * 之所以不重建几何：RoundedBoxGeometry(6 段) 单次就 3.3ms，两条就超过 2ms 预算。
   */
  private buildStage(): void {
    const slab = new THREE.Mesh(new RoundedBoxGeometry(COLS + SLAB_PAD * 2, 0.62, 9.8, 6, 0.16), this.slabMat);
    slab.position.y = -0.33;
    slab.receiveShadow = true;
    slab.castShadow = true;
    this.scene.add(slab);
    this.slab = slab;

    const base = new THREE.Mesh(new RoundedBoxGeometry(COLS + BASE_PAD * 2, 0.34, 10.5, 5, 0.15), this.baseMat);
    base.position.y = -0.78;
    base.receiveShadow = true;
    this.scene.add(base);
    this.base = base;

    ROWS.forEach((row, r) => {
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(COLS * CELL, CELL), this.floorMats[row.key]);
      plane.rotation.x = -Math.PI / 2;
      plane.position.set(0, 0.001, cellZ(r));
      plane.receiveShadow = true;
      this.scene.add(plane);
      this.floorPlanes.push(plane);
    });

    const veil = new THREE.Mesh(new THREE.PlaneGeometry(COLS * CELL, ROW_COUNT * CELL), this.veilMat);
    veil.rotation.x = -Math.PI / 2;
    veil.position.y = 0.003;
    this.scene.add(veil);
    this.veil = veil;

    // 横向分隔线（不随时间滚动）：按默认宽度建，宽度变化时只缩放 x
    const horizontal: number[] = [];
    for (let j = 0; j <= ROW_COUNT; j++) {
      const z = Z0 + j;
      horizontal.push(-COLS / 2, 0, z, COLS / 2, 0, z);
    }
    const hg = new THREE.BufferGeometry();
    hg.setAttribute('position', new THREE.Float32BufferAttribute(horizontal, 3));
    const hLines = new THREE.LineSegments(hg, this.hLineMat);
    hLines.position.y = 0.006;
    this.scene.add(hLines);
    this.hLines = hLines;

    this.resizeStage();
  }

  /** 跨过 4 列吸附时执行：改 slab/base/地板/veil/水平线的 x 缩放与地板贴图 repeat */
  private resizeStage(): void {
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    const cols = this.windowColsValue;
    const k = cols / COLS;
    if (!this.slab || !this.base || !this.veil || !this.hLines) return;
    this.slab.scale.x = (cols + SLAB_PAD * 2) / (COLS + SLAB_PAD * 2);
    this.base.scale.x = (cols + BASE_PAD * 2) / (COLS + BASE_PAD * 2);
    this.veil.scale.x = k;
    this.hLines.scale.x = k;
    for (const plane of this.floorPlanes) plane.scale.x = k;
    for (const tex of this.floorTextures.values()) tex.repeat.set(cols, 1);
    this.rebuildMs = typeof performance !== 'undefined' ? performance.now() - t0 : 0;
  }

  /** 阴影相机范围随宽度扩：默认 W=16 时仍是 ±14，和 v0.2 一致 */
  private updateShadowCamera(): void {
    const r = Math.max(14, this.halfW + 6);
    const cam = this.keyLight.shadow.camera as THREE.OrthographicCamera;
    if (cam.right === r && cam.top === r) return;
    cam.left = -r;
    cam.right = r;
    cam.top = r;
    cam.bottom = -r;
    cam.updateProjectionMatrix();
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
    this.songGroup.add(this.ghost);

    // 选中框
    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.02, 1.02, 1.02));
    this.outline = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({ color: 0xc0392b, transparent: true, opacity: 0.9 }),
    );
    this.outline.visible = false;
    this.songGroup.add(this.outline);

    this.songGroup.add(this.blockGroup);

    // 音高色片：方块顶面的"珐琅嵌片"，一个 instanced mesh 画完所有音符
    this.caps = new THREE.InstancedMesh(
      new RoundedBoxGeometry(0.84, 0.035, 0.84, 2, 0.018),
      new THREE.MeshStandardMaterial({ roughness: 0.42, metalness: 0.02 }),
      // W=32 时窗口含 ±1 列最多 272 块，留余量避免越界写实例
      320,
    );
    this.caps.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.caps.frustumCulled = false;
    this.caps.castShadow = false;
    this.caps.receiveShadow = true;
    this.caps.count = 0;
    this.caps.setColorAt(0, new THREE.Color(1, 1, 1));
    this.songGroup.add(this.caps);

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
      320,
    );
    this.blobs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.blobs.frustumCulled = false;
    this.blobs.count = 0;
    this.blobs.renderOrder = 1;
    this.songGroup.add(this.blobs);

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

    this.playhead.position.x = 0.2;
    this.songGroup.add(this.playhead);

    this.dust = new Dust(this.songGroup);

    // 一键清屏的波前：一条贴地扫描带（红核 + 暖色外圈），世界坐标，不随曲子滚
    this.wipeBand = new THREE.Group();
    const core = new THREE.Mesh(
      new THREE.PlaneGeometry(0.075, ROW_COUNT * CELL),
      new THREE.MeshBasicMaterial({ color: 0xd4552c, transparent: true, opacity: 0, depthWrite: false }),
    );
    core.rotation.x = -Math.PI / 2;
    const halo = new THREE.Mesh(
      new THREE.PlaneGeometry(0.95, ROW_COUNT * CELL),
      new THREE.MeshBasicMaterial({ color: 0xf3a24a, transparent: true, opacity: 0, depthWrite: false }),
    );
    halo.rotation.x = -Math.PI / 2;
    this.wipeBand.add(core, halo);
    this.wipeBand.position.y = 0.02;
    this.wipeBand.visible = false;
    this.scene.add(this.wipeBand);

    this.motes = new Motes(this.scene);
  }

  // ---------------------------------------------------------------- blocks

  private key(step: number, row: number): string {
    return `${step}:${row}`;
  }

  blockAt(step: number, row: number): BlockView | undefined {
    return this.blocks.get(this.key(step, row));
  }

  /** 按步查音符（音序器每步调度用，避免全表扫描） */
  blocksAtStep(step: number): BlockView[] {
    return this.stepIndex.get(step) ?? [];
  }

  /** QA / 调试：把某个格子中心投到画布 CSS 像素坐标（y=0 是地板拾取面） */
  cellToScreen(step: number, row: number, y = BLOCK_Y, zf = 0.5): { x: number; y: number } {
    // 不依赖上一帧的 render()：直接刷新世界矩阵，QA/测试在任意时刻调用都准
    this.songGroup.updateWorldMatrix(true, false);
    const v = new THREE.Vector3(cellX(step), y, Z0 + row + zf);
    this.songGroup.localToWorld(v);
    this.camera.updateMatrixWorld();
    v.project(this.camera);
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: rect.left + (v.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (-v.y * 0.5 + 0.5) * rect.height,
    };
  }

  /**
   * 新增方块。pop = 笔触落子：贴地出现，只做 0.85 → 1 的缩放，不走高空落下。
   */
  addBlock(
    step: number,
    row: number,
    midi = BASE_MIDI,
    animated = true,
    delay?: number,
    pop = false,
  ): BlockView | null {
    if (step < 0 || step >= MAX_STEPS || row < 0 || row >= ROW_COUNT) return null;
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
    mesh.visible = this.inWindow(step);

    const x = cellX(step);
    const z = cellZ(row);
    const y = pop ? BLOCK_Y : animated ? 2.6 : BLOCK_Y;
    mesh.position.set(x, y, z);

    const block: BlockView = {
      step,
      row,
      midi,
      mesh,
      mat,
      sx: new Spring(x, pop ? 0.2 : 0.3, 0.85),
      sy: new Spring(y, pop ? 0.2 : 0.26, pop ? 0.9 : 0.66),
      sz: new Spring(z, pop ? 0.2 : 0.3, 0.85),
      ss: new Spring(pop ? 0.85 : animated ? 0.2 : 1, pop ? 0.2 : 0.32, pop ? 0.9 : 0.8),
      glow: 0,
      delay: pop ? 0 : (delay ?? (animated ? Math.min(0.55, (row * 0.55 + (step % 16)) * 0.012 + 0.15) : 0)),
      dragging: false,
      tiltX: 0,
      tiltZ: 0,
    };
    mesh.userData.block = block;
    this.applyPitch(block);
    this.blockGroup.add(mesh);
    this.blocks.set(this.key(step, row), block);
    this.indexBlock(block);
    if (step > this.maxStepValue) {
      this.maxStepValue = step;
      this.maxStepDirty = false;
    }

    if (pop) {
      block.ss.setTarget(1);
    } else if (animated) {
      block.sy.setTarget(BLOCK_Y, -1.5);
      block.ss.setTarget(1);
    }
    return block;
  }

  private indexBlock(block: BlockView): void {
    let list = this.stepIndex.get(block.step);
    if (!list) {
      list = [];
      this.stepIndex.set(block.step, list);
    }
    list.push(block);
  }

  private unindexBlock(block: BlockView): void {
    const list = this.stepIndex.get(block.step);
    if (!list) return;
    const at = list.indexOf(block);
    if (at >= 0) list.splice(at, 1);
    if (!list.length) this.stepIndex.delete(block.step);
  }

  private reindexBlock(block: BlockView, oldStep: number): void {
    const list = this.stepIndex.get(oldStep);
    if (list) {
      const at = list.indexOf(block);
      if (at >= 0) list.splice(at, 1);
      if (!list.length) this.stepIndex.delete(oldStep);
    }
    this.indexBlock(block);
  }

  removeBlock(step: number, row: number, burst = 9): void {
    const key = this.key(step, row);
    const block = this.blocks.get(key);
    if (!block) return;
    this.blocks.delete(key);
    this.unindexBlock(block);
    if (step >= this.maxStepValue) this.maxStepDirty = true;
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
    this.stepIndex.clear();
    this.maxStepValue = -1;
    this.maxStepDirty = false;
    // 清空动画中的临时视觉对象也要释放：撤销/重做/载入后旧队列不能继续删东西
    for (const item of this.dying) {
      this.blockGroup.remove(item.block.mesh);
      item.block.mesh.geometry.dispose();
      item.block.mat.dispose();
    }
    this.dying.length = 0;
    this.wipe.active = false;
    if (this.wipeBand) this.wipeBand.visible = false;
    this.drag = null;
    this.selection = null;
    this.hoverCell = null;
    this.outline.visible = false;
    this.ghost.visible = false;
  }

  // ---------------------------------------------------------------- song / window

  /** 当前曲谱快照（给撤销 / 自动存档 / 分享用） */
  getNotes(): Note[] {
    return [...this.blocks.values()].map((b) => ({ step: b.step, row: b.row, midi: b.midi }));
  }

  get maxStep(): number {
    if (this.maxStepDirty) {
      this.maxStepValue = -1;
      for (const step of this.stepIndex.keys()) {
        if (step > this.maxStepValue) this.maxStepValue = step;
      }
      this.maxStepDirty = false;
    }
    return this.maxStepValue;
  }

  get blockCount(): number {
    return this.blocks.size;
  }

  /**
   * 整首装配。columnDelay > 0 时按列波次出现（示例载入的 14ms/列），
   * 否则沿用每块自带的行/步错峰。
   */
  setSong(notes: Note[], animated = false, columnDelay = 0): void {
    this.clear();
    const sorted = [...notes].sort((a, b) => a.step - b.step || a.row - b.row);
    for (const note of sorted) {
      const delay = animated && columnDelay > 0 ? note.step * columnDelay : undefined;
      this.addBlock(note.step, note.row, note.midi, animated, delay);
    }
  }

  setInfinite(on: boolean): void {
    this.infinite = on;
    this.stepLimit = on ? MAX_STEPS : MAX_STEPS_FINITE;
  }

  get isInfinite(): boolean {
    return this.infinite;
  }

  /** 当前模式允许到达的步号上限（不影响已载入但超出曲长的音符） */
  setStepLimit(limit: number): void {
    this.stepLimit = Math.max(1, Math.min(MAX_STEPS, Math.round(limit)));
  }

  get stepLimitValue(): number {
    return this.stepLimit;
  }

  /** 窗口能滑到的最远步数：由 main 按曲长 / 无限模式传入 */
  setWindowLimit(limit: number): void {
    this.windowLimit = Math.max(1, Math.min(MAX_STEPS, Math.round(limit)));
  }

  /** 曲长超过一屏才允许窗口滚动；关掉时立即回到第一屏 */
  setScrollable(on: boolean): void {
    if (on === this.scrollable) return;
    this.scrollable = on;
    if (!on) this.setWindow(0, true);
  }

  get canScroll(): boolean {
    return this.scrollable;
  }

  get windowStart(): number {
    return this.viewStart;
  }

  get windowTarget(): number {
    return this.viewStartTarget;
  }

  /** 目标窗口左缘（步）。snap=true 用于 seek / 模式切换，普通跟随走阻尼 */
  setWindow(target: number, snap = false): void {
    const maxStart = Math.max(0, Math.min(this.stepLimit, this.windowLimit) - this.windowColsValue);
    this.viewStartTarget = clamp(target, 0, maxStart);
    if (!this.scrollable) {
      this.viewStart = 0;
      this.viewStartTarget = 0;
    } else if (snap) {
      this.viewStart = this.viewStartTarget;
    }
    this.applyWindow();
  }

  private applyWindow(): void {
    this.songGroup.position.x = -this.halfW - this.viewStart;
    this.updateGrid();
    this.playhead.visible = this.playheadShown && this.playheadInWindow();
  }

  private playheadInWindow(): boolean {
    return this.playheadPos >= this.viewStart - 0.5 && this.playheadPos <= this.viewStart + this.windowColsValue + 0.5;
  }

  private inWindow(step: number): boolean {
    return step >= this.viewStart - 1 && step <= this.viewStart + this.windowColsValue + 1;
  }

  /** 每帧重写可见的绝对步边界；粗线永远落在 4 的倍数上 */
  private updateGrid(): void {
    const first = Math.floor(this.viewStart);
    let ti = 0;
    let bi = 0;
    const write = (pos: Float32Array, at: number, x: number): void => {
      pos[at] = x;
      pos[at + 1] = 0;
      pos[at + 2] = Z0;
      pos[at + 3] = x;
      pos[at + 4] = 0;
      pos[at + 5] = Z0 + ROW_COUNT;
    };
    const cols = this.windowColsValue;
    for (let s = first; s <= first + cols + 1; s++) {
      const wx = s - this.viewStart - cols / 2;
      if (wx < -cols / 2 - 0.001 || wx > cols / 2 + 0.001) continue;
      if ((((s % 4) + 4) % 4) === 0) {
        if (bi < this.gridBold.pos.length / 6) write(this.gridBold.pos, bi * 6, wx);
        bi++;
      } else {
        if (ti < this.gridThin.pos.length / 6) write(this.gridThin.pos, ti * 6, wx);
        ti++;
      }
    }
    this.gridThin.lines.geometry.setDrawRange(0, ti * 2);
    this.gridBold.lines.geometry.setDrawRange(0, bi * 2);
    this.gridThin.attr.needsUpdate = true;
    this.gridBold.attr.needsUpdate = true;
  }

  /**
   * 一键清屏：数据立刻提交为空，视觉销毁独立播放。
   * 这样保存 / 撤销 / 历史读到的永远是「已清空」，而不是动画中间状态；
   * 撤销恢复的方块也不会被旧动画队列二次删除。
   */
  clearAnimated(): number {
    if (!this.blocks.size) return 0;
    if (this.wipe.active) return this.blocks.size;
    const count = this.blocks.size;
    this.drag = null;
    this.setHover(null);
    this.setSelection(null);
    const reduced = prefersReducedMotion();
    const queue: Array<{ block: BlockView; at: number }> = [];
    for (const b of [...this.blocks.values()]) {
      // 逻辑提交：立刻从曲谱数据与索引中移除
      this.blocks.delete(this.key(b.step, b.row));
      this.unindexBlock(b);
      b.mesh.userData.block = null;
      b.dragging = false;
      b.sy.setTarget(BLOCK_Y);
      b.ss.setTarget(reduced ? 1 : 0.9);
      const rel = b.step - this.viewStart;
      queue.push({ block: b, at: reduced ? 0 : clamp(0.05 + rel * 0.016, 0, 0.3) });
    }
    this.maxStepValue = -1;
    this.maxStepDirty = false;
    queue.sort((a, b) => a.at - b.at);
    this.dying = queue;
    this.wipe = { active: !reduced, t: 0, dur: 0.34 };
    if (reduced) {
      // reduced-motion 走同一数据提交路径，只省略视觉
      this.flushDying(Infinity, false);
      this.wipe.active = false;
      this.wipeBand.visible = false;
    } else {
      this.setWipeOpacity(0);
      this.wipeBand.position.x = -this.halfW - 0.8;
      this.wipeBand.visible = true;
    }
    return count;
  }

  private flushDying(upTo: number, dust: boolean): void {
    while (this.dying.length && this.dying[0].at <= upTo) {
      const item = this.dying.shift()!;
      const { block } = item;
      const pos = block.mesh.position;
      if (dust) this.dust.spawn(pos.x, pos.y + 0.15, pos.z, ROWS[block.row].color, 6, 2.4);
      this.blockGroup.remove(block.mesh);
      block.mesh.geometry.dispose();
      block.mat.dispose();
    }
  }

  private setWipeOpacity(env: number): void {
    const core = this.wipeBand.children[0] as THREE.Mesh;
    const halo = this.wipeBand.children[1] as THREE.Mesh;
    (core.material as THREE.MeshBasicMaterial).opacity = 0.65 * env;
    (halo.material as THREE.MeshBasicMaterial).opacity = 0.16 * env;
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

  private setNDC(e: ScreenPoint): void {
    const rect = this.canvas.getBoundingClientRect();
    this.ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  }

  private pointOnPlane(e: ScreenPoint, y: number): THREE.Vector3 | null {
    this.setNDC(e);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    this.dragPlane.constant = -y;
    const hit = this.raycaster.ray.intersectPlane(this.dragPlane, this.dragPoint);
    return hit ? this.dragPoint.clone() : null;
  }

  pointerToCell(e: ScreenPoint): Cell | null {
    return this.pointerToCellAt(e, this.viewStart);
  }

  /** 按指定窗口左缘求格（自动滚动 / 拖边缘缩放时用目标窗口位置反算） */
  private pointerToCellAt(e: ScreenPoint, viewStart: number): Cell | null {
    const p = this.pointOnPlane(e, 0);
    if (!p) return null;
    const localX = p.x + this.halfW + viewStart;
    const step = stepFromX(localX);
    const row = rowFromZ(p.z);
    if (step < 0 || step >= this.stepLimit || row < 0 || row >= ROW_COUNT) return null;
    // 舞台内坐标 stageX = worldX + W/2 ∈ [-0.5, W + 0.5]，与 viewStart 无关
    const stageX = p.x + this.halfW;
    if (stageX < -0.5 || stageX > this.windowColsValue + 0.5) return null;
    const first = Math.floor(viewStart);
    const last = Math.floor(viewStart + this.windowColsValue - 1);
    if (step < first || step > last) return null;
    return { step, row };
  }

  /**
   * 绘制落格：地板平面求交后按格取整（floor），并把局部 z 带出来给行滞回用。
   * 与 pointerToCell 的区别只在格内取整方式；舞台边界判定一致。
   */
  pointerToCellExact(e: ScreenPoint): PaintCell | null {
    return this.pointerToCellExactAt(e, this.viewStart);
  }

  /** 同上，但按指定窗口左缘求格：自动滚动时用目标窗口位置继续笔触 */
  pointerToCellExactAt(e: ScreenPoint, viewStart: number): PaintCell | null {
    const p = this.pointOnPlane(e, 0);
    if (!p) return null;
    const localX = p.x + this.halfW + viewStart;
    const step = stepFromXFloor(localX);
    const row = Math.floor(p.z - Z0);
    if (step < 0 || step >= this.stepLimit || row < 0 || row >= ROW_COUNT) return null;
    const stageX = p.x + this.halfW;
    if (stageX < -0.5 || stageX > this.windowColsValue + 0.5) return null;
    const first = Math.floor(viewStart);
    const last = Math.floor(viewStart + this.windowColsValue - 1);
    if (step < first || step > last) return null;
    return { step, row, lz: p.z };
  }

  /**
   * 行滞回：换行要越过相邻行的中线（半格），手抖不会串音色。
   * current 为 null 时直接取指针所在行。
   */
  rowWithHysteresis(lz: number, current: number | null): number {
    const local = lz - Z0;
    const raw = clamp(Math.floor(local), 0, ROW_COUNT - 1);
    if (current === null) return raw;
    if (raw === current) return current;
    if (raw > current) return local >= current + 1.5 ? raw : current;
    return local <= current - 0.5 ? raw : current;
  }

  pickBlock(e: ScreenPoint): BlockView | null {
    this.setNDC(e);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.blockGroup.children, false);
    for (const hit of hits) {
      // 清空动画中的方块已经从曲谱数据里移出，不能再次被拾取
      const block = hit.object.userData.block as BlockView | null | undefined;
      if (block) return block;
    }
    return null;
  }

  // ---------------------------------------------------------------- drag

  beginDrag(block: BlockView, e: ScreenPoint): void {
    const p = this.pointOnPlane(e, LIFT_Y + 0.2);
    if (!p) return;
    const localX = p.x + this.halfW + this.viewStart;
    this.drag = {
      block,
      ox: localX - block.mesh.position.x,
      oz: p.z - block.mesh.position.z,
      vx: 0,
      vz: 0,
      lastX: localX,
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
    const localX = p.x + this.halfW + this.viewStart;
    const nx = clamp(
      localX - this.drag.ox,
      this.viewStart - 0.5,
      this.viewStart + this.windowColsValue + 0.5,
    );
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
  endDrag(): { removed: boolean; step: number; row: number } {
    const d = this.drag;
    if (!d) return { removed: false, step: -1, row: -1 };
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
    // stageX = worldX + W/2 = 曲内局部 x - viewStart，∈ [0, W]
    const stageX = px - this.viewStart;
    const outside =
      stageX < -0.45 || stageX > this.windowColsValue + 0.45 || pz < Z0 - 0.45 || pz > Z0 + ROW_COUNT + 0.45;

    if (outside) {
      const { step, row } = b;
      this.removeBlock(step, row, 10);
      return { removed: true, step, row };
    }

    const step = clamp(rawStep, 0, this.stepLimit - 1);
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
      this.reindexBlock(b, oldStep);
      this.reindexBlock(other, step);
      other.sx.setTarget(cellX(other.step), vx);
      other.sz.setTarget(cellZ(other.row), vz);
      other.sy.setTarget(BLOCK_Y, 1.2);
      other.glow = Math.max(other.glow, 0.35);
    }

    if (!sameCell && (!other || other === b)) {
      const oldStep = b.step;
      this.blocks.delete(this.key(b.step, b.row));
      b.step = step;
      b.row = row;
      this.blocks.set(this.key(step, row), b);
      this.reindexBlock(b, oldStep);
      if (step > this.maxStepValue) {
        this.maxStepValue = step;
        this.maxStepDirty = false;
      } else if (oldStep >= this.maxStepValue) {
        this.maxStepDirty = true;
      }
    }
    b.sx.setTarget(cellX(step), vx);
    b.sz.setTarget(cellZ(row), vz);
    b.sy.setTarget(BLOCK_Y, -1.2);
    b.glow = Math.max(b.glow, 0.25);
    b.mesh.position.y = BLOCK_Y;
    return { removed: false, step: b.step, row: b.row };
  }

  /**
   * 取消拖动：方块回到按下时的格心，不产生交换 / 删除 / 历史。
   * 多指接管或 pointercancel 时使用；数据里的 step/row 在落定前从未改变。
   */
  cancelDrag(): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    const b = d.block;
    b.dragging = false;
    const x = cellX(b.step);
    const z = cellZ(b.row);
    b.mesh.position.set(x, BLOCK_Y, z);
    b.sx.snap(x);
    b.sz.snap(z);
    b.sy.setTarget(BLOCK_Y);
    b.tiltX = 0;
    b.tiltZ = 0;
  }

  get isDragging(): boolean {
    return this.drag !== null;
  }

  dragTargetCell(): Cell | null {
    const b = this.drag?.block;
    if (!b) return null;
    return {
      step: clamp(
        stepFromX(b.mesh.position.x),
        Math.floor(this.viewStart),
        Math.floor(this.viewStart + this.windowColsValue - 1),
      ),
      row: clamp(rowFromZ(b.mesh.position.z), 0, ROW_COUNT - 1),
    };
  }

  // ---------------------------------------------------------------- window width / edge handles

  /** 可见列数（8..32，4 列吸附） */
  get windowCols(): number {
    return this.windowColsValue;
  }

  /** 舞台半宽 W/2：世界坐标里网格恒定占据 [-halfW, +halfW]，内容在里面滑 */
  get halfW(): number {
    return this.windowColsValue / 2;
  }

  /** 相机 fit 用的舞台半尺寸（默认 W=16 时 9.2，与 v0.2 一致） */
  get stageHalfW(): number {
    return this.halfW + STAGE_HALF_W_PAD;
  }

  get isResizing(): boolean {
    return this.resizeDrag !== null;
  }

  /** QA：最近一次舞台重建耗时（ms） */
  get lastRebuildMs(): number {
    return this.rebuildMs;
  }

  /** QA：手柄 / 网格边缘的屏幕位置 */
  get handleScreens(): Record<HandleSide, { x: number; y: number }> {
    return { left: { ...this.handleScreen.left }, right: { ...this.handleScreen.right } };
  }

  get edgeScreens(): Record<HandleSide, { x: number; y: number }> {
    return { left: { ...this.edgeScreen.left }, right: { ...this.edgeScreen.right } };
  }

  /** QA：落位弹簧当前偏移（px） */
  get handleOffsets(): Record<HandleSide, number> {
    return { left: this.handleSpring.left.value, right: this.handleSpring.right.value };
  }

  /**
   * 配置面板 / 偏好 / 边缘拖拽的统一入口：内部按 4 列吸附并夹到 8..32。
   * 外部调用（面板 stepper）不经过 onResize；边缘拖拽自己带 phase 走 applyWindowCols。
   */
  setWindowCols(cols: number): void {
    const next = clampWindowCols(cols);
    if (next === this.windowColsValue) return;
    this.applyWindowCols(next);
  }

  /** phase = null 表示外部调用（面板），不触发 onResize，避免和 main 的 setWindowCols 重复记账 */
  private applyWindowCols(next: number, phase: ResizePhase | null = null): void {
    this.windowColsValue = next;
    this.resizeStage();
    this.updateShadowCamera();
    // 窗口变宽后原来的滚动位可能越界：夹回 [0, min(stepLimit, windowLimit) - W]
    this.setWindow(this.viewStartTarget, true);
    this.fitView(this.viewId !== 'free');
    if (phase) this.onResize?.(next, phase);
  }

  private buildHandles(): void {
    if (typeof document === 'undefined') return;
    const mk = (side: HandleSide): HTMLDivElement => {
      const el = document.createElement('div');
      el.className = `edge-handle edge-handle--${side}`;
      el.setAttribute('aria-hidden', 'true');
      el.dataset.side = side;
      const bar = document.createElement('span');
      bar.className = 'edge-handle-bar';
      el.append(bar);
      el.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return; // 右键仍走擦除 / 上下文菜单
        e.preventDefault();
        e.stopPropagation();
        this.startResize(side, e);
      });
      el.addEventListener('pointerenter', () => this.setHandleNear(side));
      el.addEventListener('pointerleave', () => this.setHandleNear(null));
      document.body.append(el);
      return el;
    };
    this.handles = { left: mk('left'), right: mk('right') };

    const capsule = document.createElement('div');
    capsule.className = 'resize-capsule';
    capsule.setAttribute('aria-hidden', 'true');
    document.body.append(capsule);
    this.capsule = capsule;
  }

  /** 指针是否靠近网格左/右边缘（18px 内）→ 手柄淡入 */
  pointerNearEdge(e: ScreenPoint | null): void {
    if (!this.handles) return;
    if (!e) {
      this.setHandleNear(null);
      return;
    }
    let near: HandleSide | null = null;
    for (const side of ['left', 'right'] as const) {
      const p = this.edgeScreen[side];
      if (Math.abs(e.clientX - p.x) <= 18 && Math.abs(e.clientY - p.y) <= 64) {
        near = side;
        break;
      }
    }
    this.setHandleNear(near);
  }

  private setHandleNear(side: HandleSide | null): void {
    if (side === this.handleNear) return;
    this.handleNear = side;
    this.paintHandleState();
  }

  /**
   * 手柄命中判定：手柄盒沿屏幕外法线摆放，用自身局部坐标判断，
   * 内侧边正好落在石板边缘，命中区不侵入网格。
   */
  hitResizeHandle(e: ScreenPoint): HandleSide | null {
    if (!this.handles) return null;
    const half = this.coarse ? 22 : 13;
    const halfH = this.coarse ? 80 : 64;
    for (const side of ['left', 'right'] as const) {
      const p = this.handleScreen[side];
      const a = this.handleAngle[side];
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      const along = dx * Math.cos(a) + dy * Math.sin(a);
      const perp = -dx * Math.sin(a) + dy * Math.cos(a);
      if (Math.abs(along) <= half && Math.abs(perp) <= halfH) return side;
    }
    return null;
  }

  private paintHandleState(): void {
    if (!this.handles) return;
    for (const side of ['left', 'right'] as const) {
      const el = this.handles[side];
      const dragging = this.resizeDrag?.side === side;
      const visible = dragging || this.handleNear === side;
      el.classList.toggle('is-visible', visible);
      el.classList.toggle('is-dragging', dragging);
    }
  }

  /**
   * 按下边缘手柄：进入 resize 状态。命中优先于方块拾取（main 在 pointerdown 里先问这个）。
   * Esc 取消 → 回到按下时的列数与滚动位。
   */
  startResize(side: HandleSide, e: PointerEvent): void {
    if (this.resizeDrag) return;
    const p = this.pointOnPlane(e, 0);
    if (!p) return;
    this.resizeDrag = {
      side,
      pointerId: e.pointerId,
      startCols: this.windowColsValue,
      startWorldX: p.x,
      startView: this.viewStartTarget,
      clientX: e.clientX,
      clientY: e.clientY,
      rawHalfW: this.windowColsValue / 2,
    };
    try {
      (e.currentTarget as HTMLElement | null)?.setPointerCapture(e.pointerId);
    } catch {
      /* 合成事件没有真实 pointerId */
    }
    window.addEventListener('pointermove', this.onResizeMove, true);
    window.addEventListener('pointerup', this.onResizeUp, true);
    window.addEventListener('pointercancel', this.onResizeUp, true);
    this.paintHandleState();
    this.showCapsule(e.clientX, e.clientY);
    this.onResize?.(this.windowColsValue, 'start');
  }

  private readonly onResizeMove = (e: PointerEvent): void => {
    const r = this.resizeDrag;
    if (!r || e.pointerId !== r.pointerId) return;
    const p = this.pointOnPlane(e, 0);
    if (!p) return;
    r.clientX = e.clientX;
    r.clientY = e.clientY;
    // 以棋盘中心为锚点对称伸缩：位移 dx（世界列）→ W' = W ± 2dx
    const dx = p.x - r.startWorldX;
    const raw = r.startCols + (r.side === 'right' ? 2 : -2) * dx;
    r.rawHalfW = raw / 2;
    const bounded = clamp(raw, WINDOW_COLS_MIN, WINDOW_COLS_MAX);
    const next = clampWindowCols(bounded);
    // 撞到 8/32 后继续拖：宽度不再变，退化为窗口平移（夹在 0 / 最大滚动位）
    const overflow = raw - bounded;
    const pan = r.side === 'right' ? overflow : -overflow;
    const maxStart = Math.max(0, Math.min(this.stepLimit, this.windowLimit) - next);
    const targetView = clamp(r.startView + pan, 0, maxStart);
    if (next !== this.windowColsValue) this.applyWindowCols(next, 'move');
    if (this.scrollable && Math.abs(targetView - this.viewStartTarget) > 1e-6) this.setWindow(targetView, true);
    // 被夹住（撞边界）时手柄不再跟手：偏移量按夹住后的宽度算
    this.showCapsule(e.clientX, e.clientY);
  };

  private readonly onResizeUp = (e: PointerEvent): void => {
    const r = this.resizeDrag;
    if (!r || e.pointerId !== r.pointerId) return;
    this.endResize(false);
  };

  /** 松手 / Esc：结束 resize，交出落位弹簧 */
  cancelResize(): void {
    if (!this.resizeDrag) return;
    this.endResize(true);
  }

  private endResize(cancelled: boolean): void {
    const r = this.resizeDrag;
    if (!r) return;
    this.resizeDrag = null;
    window.removeEventListener('pointermove', this.onResizeMove, true);
    window.removeEventListener('pointerup', this.onResizeUp, true);
    window.removeEventListener('pointercancel', this.onResizeUp, true);
    if (cancelled) {
      this.setWindowCols(r.startCols);
      this.setWindow(r.startView, true);
    }
    this.hideCapsule();
    // 弹簧落位（response 0.35 / damping 0.9）：手柄从手指位置弹回吸附后的边缘；
    // reduced-motion 直接落位，不做回弹
    if (prefersReducedMotion()) this.handleSpring[r.side].snap(0);
    else this.handleSpring[r.side].setTarget(0);
    this.paintHandleState();
    this.onResize?.(this.windowColsValue, 'end');
  }

  private showCapsule(x: number, y: number): void {
    const c = this.capsule;
    if (!c) return;
    const cols = this.windowColsValue;
    c.textContent = `${cols / WINDOW_COLS_STEP} 小节 · ${cols} 列`;
    c.dataset.cols = String(cols);
    const pad = 18;
    const w = typeof innerWidth === 'number' ? innerWidth : 0;
    const h = typeof innerHeight === 'number' ? innerHeight : 0;
    const left = Math.min(Math.max(x + pad, pad), Math.max(pad, w - 132));
    const top = Math.min(Math.max(y - 14, 56), Math.max(56, h - 72));
    c.style.transform = `translate3d(${left}px, ${top}px, 0)`;
    c.classList.add('is-visible');
  }

  private hideCapsule(): void {
    this.capsule?.classList.remove('is-visible');
  }

  /** 世界点 → 画布 CSS 像素 */
  private projectWorld(x: number, y: number, z: number): { x: number; y: number } {
    const v = new THREE.Vector3(x, y, z);
    this.camera.updateMatrixWorld();
    v.project(this.camera);
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: rect.left + (v.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (-v.y * 0.5 + 0.5) * rect.height,
    };
  }

  /** 每帧把手柄贴到石板边缘中点；拖动时跟手，松手后弹簧落位 */
  private updateHandles(dt: number): void {
    if (!this.handles) return;
    const y = -0.33; // 石板侧面中点高度
    const r = this.resizeDrag;
    const half = this.coarse ? 22 : 13; // 与 CSS 26 / 44px 命中区对齐
    for (const side of ['left', 'right'] as const) {
      const sign = side === 'left' ? -1 : 1;
      // 石板边缘中点：手柄贴着它，向外展开半个命中区
      const anchor = this.projectWorld(sign * (this.halfW + HANDLE_EDGE_PAD), y, 0);
      this.edgeScreen[side] = anchor;
      // 屏幕空间外法线：沿世界 x 再向外一格投影取方向（竖屏旋转下也正确）
      const outer = this.projectWorld(sign * (this.halfW + HANDLE_EDGE_PAD + 1), y, 0);
      const vx = outer.x - anchor.x;
      const vy = outer.y - anchor.y;
      const len = Math.hypot(vx, vy) || 1;
      const nx = vx / len;
      const ny = vy / len;
      this.handleAngle[side] = Math.atan2(ny, nx);

      const spring = this.handleSpring[side];
      if (r && r.side === side) {
        // 拖动中手柄跟"想要"的宽度走（连续），棋盘按 4 列吸附（离散）
        const raw = clamp(r.rawHalfW, WINDOW_COLS_MIN / 2, WINDOW_COLS_MAX / 2 + 2);
        const finger = this.projectWorld(sign * (raw + HANDLE_EDGE_PAD), y, 0);
        spring.snap(Math.hypot(finger.x - anchor.x, finger.y - anchor.y));
      } else {
        spring.update(dt);
      }

      const dist = half + spring.value;
      const cx = anchor.x + nx * dist;
      const cy = anchor.y + ny * dist;
      this.handleScreen[side] = { x: cx, y: cy };
      const deg = (this.handleAngle[side] * 180) / Math.PI;
      this.handles[side].style.transform =
        `translate3d(${cx}px, ${cy}px, 0) translate(-50%, -50%) rotate(${deg}deg)`;
    }
  }

  // ---------------------------------------------------------------- hover / play

  setSelection(cell: Cell | null): void {
    this.selection = cell ? { step: cell.step, row: cell.row } : null;
    this.paintOutline();
  }

  get selectedCell(): Cell | null {
    return this.selection ? { ...this.selection } : null;
  }

  setHover(cell: Cell | null, showGhost = true): void {
    this.hoverCell = cell ? { step: cell.step, row: cell.row } : null;
    this.paintOutline(showGhost);
  }

  /** 悬停优先，其次是选中：两者共用一个线框，但幽灵只服务悬停 */
  private paintOutline(showGhost = true): void {
    const cell = this.hoverCell ?? this.selection;
    if (!cell) {
      this.ghost.visible = false;
      this.outline.visible = false;
      return;
    }
    const block = this.blockAt(cell.step, cell.row);
    const occupied = !!block;
    this.outline.visible = true;
    this.outline.position.set(cellX(cell.step), occupied ? BLOCK_Y : 0.505, cellZ(cell.row));
    this.outline.scale.setScalar(occupied ? 1 : 0.99);
    // 俯视图看不到方块侧面，幽灵方块没有意义，只留选中框
    this.ghost.visible =
      !occupied && showGhost && !!this.hoverCell && this.viewId !== 'top';
    if (this.ghost.visible && this.hoverCell) {
      this.ghost.position.set(cellX(cell.step), 0.5, cellZ(cell.row));
      this.ghostMat.map = this.blockTexture(cell.row);
      this.ghostMat.needsUpdate = true;
    }
  }

  setPlayhead(pos: number): void {
    this.playheadPos = pos;
    this.playhead.position.x = pos;
    if (this.playheadShown) this.playhead.visible = this.playheadInWindow();
  }

  setPlayheadVisible(visible: boolean): void {
    this.playheadShown = visible;
    this.playhead.visible = visible && this.playheadInWindow();
  }

  hit(step: number): void {
    const list = this.stepIndex.get(step);
    if (!list) return;
    for (const b of list) {
      if (!this.inWindow(b.step)) continue;
      b.sy.impulse(3.6 + Math.random() * 1.2);
      b.glow = 1;
    }
  }

  // ---------------------------------------------------------------- camera

  /** 任何手动 orbit / zoom 都进入自由状态，UI 上的预设高亮随之熄灭 */
  private markFree(): void {
    if (this.viewId === 'free') return;
    this.viewId = 'free';
    this.cam.tparallax = 1;
    this.zoomMin = Math.min(this.zoomMin, 16);
    this.zoomMax = Math.max(this.zoomMax, 72);
    this.onViewChange?.('free');
  }

  get view(): ViewId {
    return this.viewId;
  }

  /** QA：当前相机与目标状态（不参与业务逻辑） */
  get cameraState(): {
    az: number;
    el: number;
    dist: number;
    taz: number;
    tel: number;
    tdist: number;
    panX: number;
    panZ: number;
    tpanX: number;
    tpanZ: number;
  } {
    return {
      az: this.cam.az,
      el: this.cam.el,
      dist: this.cam.dist,
      taz: this.cam.taz,
      tel: this.cam.tel,
      tdist: this.cam.tdist,
      panX: this.cam.panX,
      panZ: this.cam.panZ,
      tpanX: this.cam.tpanX,
      tpanZ: this.cam.tpanZ,
    };
  }

  setView(id: Exclude<ViewId, 'free'>): void {
    this.applyPreset(id, true);
  }

  cycleView(): void {
    const current = this.viewId as Exclude<ViewId, 'free'>;
    const index = VIEW_ORDER.indexOf(current);
    this.setView(VIEW_ORDER[(index < 0 ? 0 : index + 1) % VIEW_ORDER.length]);
  }

  private applyPreset(id: Exclude<ViewId, 'free'>, notify: boolean): void {
    const preset = VIEWS[id];
    this.viewId = id;
    this.cam.tpanX = 0;
    this.cam.tpanZ = 0;
    this.cam.panX = 0;
    this.cam.panZ = 0;
    // 竖屏：统一从 +x 方向看，让 16 列沿屏幕长边走（保留各预设的仰角/构图）
    this.cam.taz = this.portrait && preset.rotatePortrait ? Math.PI / 2 : preset.az;
    this.cam.tel = preset.el;
    this.cam.tfov = preset.fov;
    this.cam.tlookY = preset.lookY;
    this.cam.tparallax = preset.parallax;
    this.fitView();
    if (notify) this.onViewChange?.(id);
  }

  /**
   * 按当前机位/窗口比例求刚好装下舞台的距离。
   * apply=false（自由状态）只更新缩放范围，不抢用户机位。
   */
  private fitView(apply = true): void {
    const dist = this.fitDistanceNow();
    if (this.viewId === 'free') {
      // 自由状态保留用户放大的范围，只保证新宽度也装得下
      this.zoomMin = Math.min(16, dist * 0.62);
      this.zoomMax = Math.max(72, dist * 1.55);
      this.cam.tdist = clamp(this.cam.tdist, this.zoomMin, this.zoomMax);
      return;
    }
    if (apply) this.cam.tdist = dist;
    this.zoomMin = dist * 0.62;
    this.zoomMax = dist * 1.55;
  }

  /**
   * 用有效视口（而不是整块 canvas）求相机距离：
   * 通过 camera.setViewOffset 把舞台中心挪到可用矩形中心，
   * 渲染、投影、raycast 仍然共用同一个投影矩阵，所以拾取不会偏。
   */
  private fitDistanceNow(): number {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    const rect = this.stageRectSet ? this.stageRect : { left: 0, top: 0, width: w, height: h };
    const aspect = Math.max(0.2, rect.width / Math.max(1, rect.height));
    // 有效矩形只占画布一部分时，同样的世界尺寸要占更多屏幕像素 → 距离按比例放大
    const scale = Math.max(1, h / Math.max(1, rect.height));
    return fitDistance({
      az: this.cam.taz,
      el: this.cam.tel,
      fov: this.cam.tfov,
      aspect,
      lookY: this.cam.tlookY,
      halfW: this.halfW + STAGE_HALF_W_PAD,
      halfD: STAGE_HALF_D,
      topY: STAGE_TOP_Y,
      margin: 1.06 * scale,
    });
  }

  /** 布局层量出的可用矩形；变化时重新构图（自由相机只约束距离，不抢角度） */
  setStageRect(rect: { left: number; top: number; width: number; height: number }): void {
    const next = {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
    };
    const same =
      this.stageRectSet &&
      next.left === this.stageRect.left &&
      next.top === this.stageRect.top &&
      next.width === this.stageRect.width &&
      next.height === this.stageRect.height;
    this.stageRect = next;
    this.stageRectSet = true;
    this.applyViewOffset();
    if (same) return;
    if (this.viewId === 'free') this.fitView(false);
    else this.applyPreset(this.viewId, false);
  }

  private applyViewOffset(): void {
    const w = this.canvas.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 1) || 1;
    const h = this.canvas.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 1) || 1;
    const r = this.stageRectSet ? this.stageRect : { left: 0, top: 0, width: w, height: h };
    const dx = r.left + r.width / 2 - w / 2;
    const dy = r.top + r.height / 2 - h / 2;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
      this.camera.clearViewOffset();
    } else {
      this.camera.setViewOffset(w, h, -dx, -dy, w, h);
    }
  }

  /** 「适配舞台」：回到当前视角的完整构图，不改曲谱、播放位置或历史 */
  fitStage(): void {
    this.cam.tpanX = 0;
    this.cam.tpanZ = 0;
    if (this.viewId === 'free') {
      const dist = this.fitDistanceNow();
      this.zoomMin = Math.min(16, dist * 0.62);
      this.zoomMax = Math.max(72, dist * 1.55);
      this.cam.tdist = clamp(dist, this.zoomMin, this.zoomMax);
      return;
    }
    this.applyPreset(this.viewId, false);
  }

  // ---------------------------------------------------------------- 双指相机

  /** 双指开始：以当前目标机位与屏幕中心对应的舞台点为基准 */
  beginPinch(anchor: ScreenPoint): void {
    this.markFree();
    const world = this.pointOnPlane(anchor, 0);
    this.pinch = {
      dist0: this.cam.tdist,
      anchorWorld: world ? world.clone() : null,
    };
  }

  /**
   * scale = 当前两指距离 / 起始距离。缩放按绝对比例计算，不受事件频率影响；
   * 同时把起始锚点留在当前双指中心，实现「边平移边缩放」。
   */
  updatePinch(scale: number, anchor: ScreenPoint): void {
    const p = this.pinch;
    if (!p) return;
    this.markFree();
    this.cam.tdist = clamp(p.dist0 / Math.max(0.2, scale), this.zoomMin, this.zoomMax);
    if (!p.anchorWorld) return;
    // 透视下平移与投影近似线性，迭代两次足够收敛到亚像素
    for (let i = 0; i < 2; i++) {
      const projected = this.projectWithTargets(p.anchorWorld);
      const dx = anchor.clientX - projected.x;
      const dy = anchor.clientY - projected.y;
      if (Math.abs(dx) < 0.25 && Math.abs(dy) < 0.25) break;
      this.panTargetByScreen(dx, dy);
    }
  }

  endPinch(): void {
    this.pinch = null;
  }

  /** 用「目标机位」投影世界点，避免阻尼让锚点补偿滞后 */
  private projectWithTargets(point: THREE.Vector3): { x: number; y: number } {
    const cam = this.tempCamera;
    // 与渲染相机保持同一套视差 / 空闲漂移，否则锚点补偿会多推一段
    const drift = this.viewId === 'persp' || this.viewId === 'free' ? Math.sin(this.elapsed * 0.16) * 0.006 : 0;
    const az = this.cam.taz + this.cam.px * 0.055 * this.cam.parallax + drift;
    const el = this.cam.tel + this.cam.py * 0.03 * this.cam.parallax;
    const r = this.cam.tdist;
    cam.fov = this.cam.tfov;
    cam.aspect = this.camera.aspect;
    cam.near = this.camera.near;
    cam.far = this.camera.far;
    cam.position.set(
      this.cam.tpanX + Math.cos(el) * Math.sin(az) * r,
      this.cam.tlookY + Math.sin(el) * r,
      this.cam.tpanZ + Math.cos(el) * Math.cos(az) * r,
    );
    cam.lookAt(this.cam.tpanX, this.cam.tlookY, this.cam.tpanZ);
    cam.updateMatrixWorld();
    // 主相机的投影矩阵包含 view offset，直接复用
    cam.projectionMatrix.copy(this.camera.projectionMatrix);
    cam.projectionMatrixInverse.copy(this.camera.projectionMatrixInverse);
    const v = point.clone().project(cam);
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: rect.left + (v.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (-v.y * 0.5 + 0.5) * rect.height,
    };
  }

  /** 按屏幕位移平移相机目标（与 pan() 同一套方向约定，但使用目标机位） */
  private panTargetByScreen(dx: number, dy: number): void {
    const height = Math.max(1, this.canvas.clientHeight);
    const k = (2 * this.cam.tdist * Math.tan((this.cam.tfov * Math.PI) / 360)) / height;
    const az = this.cam.taz;
    const rightX = Math.cos(az);
    const rightZ = -Math.sin(az);
    const sinEl = Math.max(0.35, Math.sin(this.cam.tel));
    const upX = Math.sin(az);
    const upZ = Math.cos(az);
    const limitX = this.halfW + 8;
    const limitZ = STAGE_HALF_D + 4;
    this.cam.tpanX = clamp(
      this.cam.tpanX - rightX * dx * k - (upX * dy * k) / sinEl,
      -limitX,
      limitX,
    );
    this.cam.tpanZ = clamp(
      this.cam.tpanZ - rightZ * dx * k - (upZ * dy * k) / sinEl,
      -limitZ,
      limitZ,
    );
  }

  orbit(dx: number, dy: number): void {
    this.markFree();
    this.cam.taz = clamp(this.cam.taz - dx * 0.0045, -1.35, 1.35);
    this.cam.tel = clamp(this.cam.tel + dy * 0.0035, 0.16, 1.52);
  }

  /** 中键平移：在地面平面内移动相机目标点，保持俯仰/距离不变 */
  pan(dx: number, dy: number): void {
    this.markFree();
    const height = Math.max(1, this.canvas.clientHeight);
    const k = (2 * this.cam.dist * Math.tan((this.cam.fov * Math.PI) / 360)) / height;
    const az = this.cam.az;
    const rightX = Math.cos(az);
    const rightZ = -Math.sin(az);
    // 屏幕"上"方向投影到地面：朝相机的一侧；除以 sin(el) 补偿俯视压缩
    const sinEl = Math.max(0.35, Math.sin(this.cam.el));
    const upX = Math.sin(az);
    const upZ = Math.cos(az);
    const limitX = this.halfW + 8;
    const limitZ = STAGE_HALF_D + 4;
    this.cam.tpanX = clamp(
      this.cam.tpanX - rightX * dx * k - (upX * dy * k) / sinEl,
      -limitX,
      limitX,
    );
    this.cam.tpanZ = clamp(
      this.cam.tpanZ - rightZ * dx * k - (upZ * dy * k) / sinEl,
      -limitZ,
      limitZ,
    );
  }

  zoom(delta: number): void {
    this.markFree();
    this.cam.tdist = clamp(this.cam.tdist + delta * 0.012, this.zoomMin, this.zoomMax);
  }

  parallax(e: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    this.cam.tpx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.cam.tpy = ((e.clientY - rect.top) / rect.height) * 2 - 1;
    // 指针靠近网格左右边缘 18px → 该侧手柄淡入
    this.pointerNearEdge(e);
  }

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.applyViewOffset();
    this.portrait = this.camera.aspect < 0.82;
    // 自由状态不抢用户的机位；预设状态则按新的窗口比例重新构图
    if (this.viewId !== 'free') this.applyPreset(this.viewId, false);
    else this.fitView(false);
  }

  // ---------------------------------------------------------------- frame

  /**
   * 只收集窗口附近的方块：长曲的每帧成本与全曲长度无关。
   * 先把上一帧的可见方块隐藏，再按步范围从 stepIndex 取本帧可见项。
   */
  private collectVisible(): void {
    for (const b of this.visibleBlocks) b.mesh.visible = false;
    this.visibleBlocks.length = 0;
    const first = Math.max(0, Math.floor(this.viewStart) - 1);
    const last = Math.min(MAX_STEPS - 1, Math.ceil(this.viewStart + this.windowColsValue) + 1);
    for (let step = first; step <= last; step++) {
      const list = this.stepIndex.get(step);
      if (!list) continue;
      for (const b of list) {
        b.mesh.visible = true;
        this.visibleBlocks.push(b);
      }
    }
    // 清空动画中的方块已不在 stepIndex，但仍要参与本帧的弹簧与渲染
    for (const item of this.dying) {
      item.block.mesh.visible = true;
      this.visibleBlocks.push(item.block);
    }
  }

  update(dt: number): void {
    this.elapsed += dt;

    this.cam.az = damp(this.cam.az, this.cam.taz, prefersReducedMotion() ? 30 : 5.2, dt);
    this.cam.el = damp(this.cam.el, this.cam.tel, prefersReducedMotion() ? 30 : 5.2, dt);
    this.cam.dist = damp(this.cam.dist, this.cam.tdist, prefersReducedMotion() ? 26 : 4.6, dt);
    this.cam.px = damp(this.cam.px, this.cam.tpx, 4, dt);
    this.cam.py = damp(this.cam.py, this.cam.tpy, 4, dt);
    this.cam.fov = damp(this.cam.fov, this.cam.tfov, prefersReducedMotion() ? 30 : 5, dt);
    this.cam.lookY = damp(this.cam.lookY, this.cam.tlookY, prefersReducedMotion() ? 30 : 5.2, dt);
    this.cam.parallax = damp(this.cam.parallax, this.cam.tparallax, 6, dt);
    this.cam.panX = damp(this.cam.panX, this.cam.tpanX, prefersReducedMotion() ? 30 : 5.2, dt);
    this.cam.panZ = damp(this.cam.panZ, this.cam.tpanZ, prefersReducedMotion() ? 30 : 5.2, dt);

    if (Math.abs(this.camera.fov - this.cam.fov) > 0.002) {
      this.camera.fov = this.cam.fov;
      this.camera.updateProjectionMatrix();
    }
    this.lookAt.set(this.cam.panX, this.cam.lookY, this.cam.panZ);

    // 俯视/正视要当"静图"看：去掉空闲漂移，视差也按预设压到很低
    const drift = this.viewId === 'persp' || this.viewId === 'free' ? Math.sin(this.elapsed * 0.16) * 0.006 : 0;
    const az = this.cam.az + this.cam.px * 0.055 * this.cam.parallax + drift;
    const el = this.cam.el + this.cam.py * 0.03 * this.cam.parallax;
    const r = this.cam.dist;
    this.camera.position.set(
      this.lookAt.x + Math.cos(el) * Math.sin(az) * r,
      this.lookAt.y + Math.sin(el) * r,
      this.lookAt.z + Math.cos(el) * Math.cos(az) * r,
    );
    this.camera.lookAt(this.lookAt);

    // 可滚动时窗口左缘用阻尼追目标；一屏装得下就立即归零
    if (this.scrollable) {
      this.viewStart = damp(this.viewStart, this.viewStartTarget, 7, dt);
      if (Math.abs(this.viewStart - this.viewStartTarget) < 0.0005) this.viewStart = this.viewStartTarget;
    } else if (this.viewStart !== 0) {
      this.viewStart = 0;
      this.viewStartTarget = 0;
    }
    this.applyWindow();

    // 一键清屏：波前扫过，方块被扫到就碎掉
    if (this.wipe.active) {
      this.wipe.t += dt;
      const progress = clamp(this.wipe.t / this.wipe.dur, 0, 1);
      this.wipeBand.position.x = -this.halfW - 0.8 + (this.windowColsValue + 1.6) * progress;
      this.setWipeOpacity(Math.sin(Math.PI * progress));
      this.flushDying(this.wipe.t, true);
      if (progress >= 1) {
        this.flushDying(Infinity, true);
        this.wipe.active = false;
        this.wipeBand.visible = false;
      }
    }

    this.collectVisible();

    for (const b of this.visibleBlocks) {
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
    for (const b of this.visibleBlocks) {
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
    for (const b of this.visibleBlocks) {
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

    this.updateHandles(dt);
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
  private capacity = 384;
  private dummy = new THREE.Object3D();

  constructor(scene: THREE.Object3D) {
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

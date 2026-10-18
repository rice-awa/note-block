# AGENTS.md

This file provides guidance to coding agents (including Claude Code) when working with code in this repository.

## 命令

```bash
npm install
npm run dev      # Vite 开发服务器 http://127.0.0.1:5191
npm run build    # tsc --noEmit（strict 类型检查）+ vite build，产物在 dist/
npm run preview  # 预览构建产物 http://127.0.0.1:5192
```

- **没有测试框架、lint 或格式化脚本**。不要臆造 `npm test`。验证方式是 `npm run build` 加浏览器实测。
- 浏览器 QA 使用 Playwright CLI（项目根目录有 `.playwright-cli/` 日志）；验收脚本与截图放在 `.scratch/`。两者都在 `.gitignore` 中。用完关闭浏览器，失败路径也要关闭，别留下 headless Chromium。
- `src/main.ts` 暴露了调试钩子：`window.__nb`（capture/applyState/undo/redo/选择/存档/示例等）、`__studio`、`__clock`、`__audio`、`__hud`、`__gestures`、`__viewport`、`__notePanel`。脚本化验收优先用它们断言状态，不要只截图看表面。
- 没有 `vite.config.ts`；`index.html` 是 Vite 入口，`public/` 按根路径提供。

## 架构

**栈**：Vite + TypeScript（strict）+ three.js。无 React、无动画库、无状态管理库。页面骨架与固定控件在 `index.html`；抽屉/编辑条的内部内容由 `config-panel.ts`、`note-panel.ts` 等生成。样式集中在 `src/style.css`，各模块用 `document.querySelector('#id')!` 取节点。注释和界面文案使用中文，新代码保持一致。

### 组合根与状态归属

`src/main.ts` 是唯一的接线层与事务边界：

- 权威状态分散在服务里：音符在 `Studio`，`bpm`/播放位置在 `Clock`，`infinite` / `bars` / `loop` / 选中项在 `main.ts` 的模块变量里。`capture()` 把它们合成 `SongState` 快照。
- 构造顺序：`Studio`、`AudioEngine`/`Clock`、`Hud`、`History`、`SaveCoordinator`，再是各抽屉/面板、`GestureController`、`ViewportWatcher`。
- 一次编辑的典型链路：手势 → `Studio` 变更 + `main.ts` 记录事务前快照 → `syncLength()`（由内容/曲长推导时钟长度、`stepLimit`、能否滚动）→ `markDirty()`（防抖写存档）→ HUD/面板同步。
- 撤销/重做、载入示例、恢复备份都走 `applyState()`：整首替换并重新校准时钟、窗口、播放位置与选择。不要为这些操作用第二套状态通道。

### 数据与持久化

- `src/song.ts` 是纯模型层（不 import DOM / three）：`SongState`、规范化、分享码、本地存档、备份槽、`History`。
- `History` 是快照式（40 条上限 + 总音符预算），连续手势一笔一条；滚轮调音按约 900ms 合并。选择、相机、面板开关、偏好**不得**进入撤销栈。
- 分享码 `#s=` 有三代格式（v1/v2/v3），解码必须继续兼容旧链接。改动 `SongState` 时必须同时处理 `normalizeState()` 和编解码兼容；不要重命名 `midi` 字段。
- 存储键固定为：曲谱 `note-block:v1`、偏好 `note-block:prefs:v1`、示例/清空前备份 `note-block:backup:v1`。
- `src/persistence.ts` 的 `SaveCoordinator` 负责 500ms 防抖、revision 防旧结果覆盖、保存状态（local/dirty/saving/saved/failed）。只有真正写入成功才更新“已保存”时间；失败必须显示“未保存到本机”。不要绕过它直接调用 `saveLocal`（启动时读存档、备份写入除外）。
- `src/prefs.ts` 的音量、混响、可见列数、玩法提示状态属于本机偏好，不进分享、不进撤销。

### 渲染与坐标模型（最容易改错的部分）

`src/scene.ts` 的 `Studio` 封装 three.js：舞台/网格/地板贴图、相机与三组预设视图、实例化顶面色片与接触阴影、粒子、播放头、拾取、拖动、清屏波前、边缘缩放手柄。

- 坐标解耦：方块局部 x 只依赖 `step`（`x = step + 0.5`）；时间窗口偏移只放在 `songGroup.position.x = -W/2 - viewStart`。**不要**把 `viewStart` 重新塞回方块坐标。
- 指针反算统一走 `pointerToCell` / `pointerToCellExact` / `pointerToCellExactAt`；屏幕投影走 `cellToScreen`。新增交互不要自己算一套投影。
- 可见列数 `W` 存在偏好里，8–32 按 4 列吸附。跨档位才重建 slab/地板/网格，并重新求相机距离；默认 16 列必须保持既有构图。
- 长曲每帧只遍历窗口附近的方块（`visibleBlocks`），不要退回全表扫描。
- `src/views.ts` 存预设机位，相机距离由舞台包围盒八角的投影反求，不写死。

### 声音与音画同步

`src/audio.ts`：

- `AudioEngine` 用 `playbackRate` 变调播放采样，链路为 bus → 混响 → 压缩器；UI 音效（wipe/thump/restoreSweep）全部实时合成。首次指针/键盘事件解锁 `AudioContext`。
- `Clock` 以 `AudioContext.currentTime` 为主时钟，提前约 120ms 调度音频，并把同一队列交给视觉。`main.ts` 每帧 `clock.update()` 后用 `drainVisual(audio.now)` 触发 `Studio.hit()`。
- 视觉时间不要改用 `performance.now()`；改 BPM/曲长/循环/seek 时要像现有实现一样重锚时钟。

### 输入与布局

- `src/gestures.ts` 是画布指针状态机：单指绘制/选中/拖动/转视角、双指平移+缩放、多指接管与取消。它只通过 `GestureHost` 回调请求操作，**不直接改曲谱、存档或 DOM 文案**；事务与历史仍由 `main.ts` 负责。
- 第二根手指、横竖屏切换、打开抽屉时必须结束/回滚未完成事务；多指接管不能误撤销之前已完成的笔触。
- `src/viewport.ts` 测量顶栏与底栏之间的有效舞台矩形，并给出 `desktop | portrait | landscape` 布局模式（写在 `body.dataset.mode`）。相机适配、投影、拾取必须共用这个矩形（`studio.setStageRect`）。
- 键盘语义：按钮/开关/输入框保留原生行为；Space 只在舞台或页面背景上播放；抽屉打开时页面快捷键不得修改背后的舞台；Escape 一次只关闭一层。

### UI 模块

- `hud.ts`：顶栏、播放栏、进度条、音色行、撤销/重做、保存状态、toast 与抽屉内反馈槽。
- `drawer.ts`：通用玻璃抽屉（开合、焦点圈定、Esc、窄屏遮罩），`config-panel.ts` / `example-panel.ts` / 帮助抽屉只填内容。
- `note-panel.ts` + `note-label.ts`：选中音符的编辑条与音高/位置格式化（区分“相对半音索引”和绝对音名）。
- `examples.ts` / `rows.ts`：内置示例编配、8 行音色定义与 demo 音符。
- `motion.ts`：自写弹簧（response/damping 口径）、阻尼、动量投影。物理交互用弹簧，一次性 UI 用 CSS 曲线；具体参数与设计规则见 `DESIGN.md`。

## 项目约定与文档

- `README.md` 面向用户，可能落后于工作区；`DESIGN.md` 记录设计决策与历史增量，同样可能滞后；**以源码为准**。
- `docs/UX-OPTIMIZATION-PLAN.md` 是当前 UX 工作的实施计划与验收矩阵，其中的复选框不代表已完成。`docs/ux-audit/REPORT.md` 是改动前的基线实测。做相关功能前先读对应章节。
- 第三方素材：`public/tex/`（Minecraft 贴图）与 `public/audio/`（音符盒音效）**不在 MIT 覆盖范围**，归属与限制见 `NOTICE`。不要替换、再分发或把它们说成项目自有资产。代码新增素材优先程序化生成/合成。
- 修改 UI 后如更新 README 截图（`docs/show-*.png`），保持真实 DPR 的完整页面截图，不要用降画质截图充当视觉验收。

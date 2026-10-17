# NOTE BLOCK · 音符方块

> 一台用 Minecraft 的语法写成、用 Apple 的手感演奏的 3D 合成器。

一块 16 × 8 的悬浮体素舞台就是钢琴卷：**列是时间，行是地板材质，材质就是音色**。
往舞台里丢方块，世界开始演奏；光柱击中方块的那一帧，整个场景为它让路。

![idle](docs/show-idle.png)

## 运行

```bash
npm install
npm run dev        # http://127.0.0.1:5191
npm run build      # 产物在 dist/
```

## 玩法

| 操作 | 结果 |
| --- | --- |
| 在空格子上按下 | 放下一块音符方块（并立刻可以拖动） |
| 拖动方块 | 1:1 跟手、速度倾斜；松手按动量投影吸附到格子 |
| 滚轮（悬停方块上） | 每次半音改变音高，顶面色相跟着变 |
| 右键 / Delete | 打碎方块（8 粒体素粉尘） |
| 拖到舞台外松手 | 删掉方块 |
| 空格 / 播放键 | 播放 / 暂停 |
| 点击左下角材质行 | 静音该行 |
| BPM +/− | 60–180 |

## 实现

- **栈**：Vite + TypeScript + three.js，无 React / 无 GSAP。
- **零外部 3D 资产**：8 张 16×16 方块贴图 + 程序化顶面色片 + 程序化接触阴影。
- **动画**：自己写的弹簧（半隐式欧拉、240Hz 子步、`setTarget` 保留速度），
  配合 Apple 的动量投影 `v/1000 · 0.998/(1-0.998)` 做拖动吸附。
- **音频**：Web Audio，24 个半音的 `playbackRate` 变调；主链路为
  dry + 程序化卷积混响 → 压缩器；音序器以 `AudioContext.currentTime` 为主时钟，
  提前 120ms 调度，视觉从同一队列出队，音画同帧。
- **渲染**：ACES tone mapping、PCFSoft 阴影、RoomEnvironment 环境光、
  InstancedMesh 画所有音高色片与粒子。

## 资产与版权

- 方块贴图来自 Minecraft（Mojang），取自
  [InventivetalentDev/minecraft-assets](https://github.com/InventivetalentDev/minecraft-assets) 1.20.1，
  仅用于个人非商业演示。
- 音符盒音效来自 [MCSounds](https://o.xbottle.top/mcsounds/)（SomeBottle）的公开资源站。
- 项目源码以 [MIT](LICENSE) 许可发布；`public/tex/` 与 `public/audio/` 下的第三方素材**不在 MIT 覆盖范围内**，
  详见 [NOTICE](NOTICE)。若要公开部署，请替换为自绘贴图与自录/合成音色。
- 本项目与 Mojang / Microsoft 无关，未经其授权、认可或赞助。

## 已知限制

- 手机竖屏是"凑近看"的视角（旋转 90° 观察），没有做双指缩放。
- 还没有存档 / 分享 / 撤销。
- 音符只有 24 个半音（和游戏内音符盒音域一致）。

## 许可证

代码采用 [MIT License](LICENSE)。第三方素材的归属与限制见 [NOTICE](NOTICE) 和上文「资产与版权」。

# 参考项目调研：无限画布 / 生图工作台

> 调研对象：`D:\Download games\刘志远的魔怔工作台\s'r'c\` 下四个参考项目
> 调研目的：为 imagora 画布能力的下一轮迭代找「可移植的实现」与「只可读的设计」
> 结论形态：每个方向给出**具体到函数名/设计点**的借鉴清单 + license 判定 + 优先级

本文所有参考项目路径都写在反引号里（不是超链接）——它们**在 imagora 仓库之外**，随时可能被删，不能让
`scripts/check_docs.py` 的链接校验依赖它们。基准目录：

```
s'r'c/                                  ← 参考项目根（注意目录名带单引号）
├── basketikun-infinite-canvas/         ← MIT，唯一可代码级移植
├── tigerowo-infinite-canvas/           ← AGPL-3.0，不可移植
├── OpenAI-X-infinite-canvas/           ← AGPL-3.0，不可移植
└── tldraw/                             ← 自有商业许可，一行都不能抄
```

---

## 0. 结论速览

| # | 建议项 | 方向 | 参考来源 / 可移植性 | 收益 | 成本 | 优先级 |
|---|---|---|---|---|---|---|
| 1 | 生成中占位卡 + 单张状态（进度条 / 耗时 / 失败原因） | 批量与状态 | basketikun `image-generation-pending.tsx`（MIT，可重写移植） | 高 | 低 | **P0** |
| 2 | 画布小地图 + 缩放滑杆 | 画布交互 | basketikun `canvas-mini-map.tsx` / `canvas-zoom-controls.tsx`（MIT）；React Flow 自带 `<MiniMap>` | 中高 | 极低 | **P0** |
| 3 | 图像本地编辑：裁剪 + 放大 | 节点能力 | basketikun `canvas-image-data.ts` / `use-image-editor-viewport.ts` / `canvas-node-crop-dialog.tsx`（MIT） | **最高** | 中 | **P0** |
| 4 | 尺寸「倍率 × 比例」模型 + 比例预览图标 | 设置面板 | basketikun `image-settings-panel.tsx` 的 `AspectIcon` / `readMediaDimensions`（MIT） | 中 | 低 | P1 |
| 5 | 提示词 `@` 引用资源（textarea 覆盖层方案） | 提示词输入 | basketikun `canvas-resource-mention-textarea.tsx`（MIT） | 高 | 中（需动契约） | P1 |
| 6 | 节点悬停工具栏改数据驱动 + 可配置 | 画布交互 | basketikun `canvas-image-toolbar-tools.tsx` / `canvas-node-hover-toolbar.tsx`（MIT） | 中 | 中 | P1 |
| 7 | 蒙版笔刷编辑（局部重绘） | 节点能力 | basketikun `canvas-node-mask-edit-dialog.tsx`（MIT） | 高 | 高 | P1 |
| 8 | 模型选择器：品牌图标 + 跨选择器互斥打开 | 设置面板 | basketikun `model-picker.tsx`（MIT） | 低中 | 低 | P2 |
| 9 | 尺寸选择器支持自由输入自定义比例 | 设置面板 | basketikun `canvas-size-picker.tsx`（MIT） | 低中 | 低 | P2 |
| 10 | 节点右键菜单 | 画布交互 | basketikun `canvas-context-menu.tsx`（MIT） | 中 | 中 | P2 |
| 11 | 图像切分（九宫格 / 自定义切割线） | 节点能力 | basketikun `canvas-node-split-dialog.tsx`（MIT） | 中 | 中 | P2 |
| 12 | 撤销栈从「全量快照」改「diff 三桶 + mark」 | 历史栈 | tldraw `HistoryManager.ts`（**只读设计，不可移植**） | 中 | 高 | P2 |
| 13 | 拖拽吸附对齐（网格 / 边 / 中心） | 画布交互 | tldraw `SnapManager.ts`（**只读设计，不可移植**） | 中 | 高 | P2 |
| 14 | 多图批次节点（一张卡内 N 张图 + 展开网格） | 批量与状态 | basketikun `canvas-node.tsx` 的 `BatchFrame`（MIT） | 高 | **很高**（改数据模型） | P2 |

**一句话建议**：先做 1 + 2 + 3。第 1、2 项各是「一个组件 / 一个内置控件」的量级，能立刻改变画布的手感；
第 3 项是用户价值最高的一块，且**完全不碰后端契约**（纯前端 canvas 运算），是低风险高回报的典型。
第 5 项（`@` 引用）收益同样很高，但它要改 `collectIncomingImages` 的选取口径与生成请求体，属于契约改动，
应单独立项、单独排期。

---

## 1. license 边界（先读这一节，再看代码）

| 项目 | 许可 | 能做什么 | 不能做什么 |
|---|---|---|---|
| `basketikun-infinite-canvas` | **MIT** | 读代码、移植代码、改后商用；**保留原版权声明与许可文本** | 无实质限制（仅需保留声明） |
| `tigerowo-infinite-canvas` | **AGPL-3.0** | 读设计思路，理解它怎么解决问题 | **不可复制任何代码片段**；AGPL 传染性会要求 imagora 整体开源为 AGPL |
| `OpenAI-X-infinite-canvas` | **AGPL-3.0** | 同上，只读设计 | 同上 |
| `tldraw` | **自有商业许可**（`s'r'c/tldraw/LICENSE.md`） | 仅内部开发环境使用其软件本体 | **一行代码都不能进 imagora**。原文明确 `Not to use the Software in Production Environments.`、`Not to distribute the Software or modifications of the Software as a standalone product`、`Not to make the Software available under a license that supersedes or negates the effect of this License.` |

imagora 自身是 **MIT**。因此：

1. **只有 basketikun 可以代码级移植。** 移植时在文件头注明来源与 MIT 版权（imagora 已有先例：
   `frontend/src/optionGroups.ts` 头注释写着「移植自 DeepSeek Harness，MIT」）。
2. **两份 AGPL 与 tldraw 只能「读完 → 合上 → 自己重写」。** 判定标准不是「改了多少行」，而是
   「结构、命名、算法实现是否可追溯到原文」。本文对这三份只记录**设计原则**（为什么这么做、
   解决了什么问题），不给实现细节。
3. 本文档第 7 节（tldraw）通篇是设计层面的转述，**不含任何可抄的代码**；后续实现子代理若在 tldraw
   里看到具体实现，必须自己重新推导，不得逐行翻译。

---

## 2. 方向一：画布节点能力（图像编辑器）

### 2.1 参考位置

| 文件 | 行数 | 作用 |
|---|---|---|
| `s'r'c/basketikun-infinite-canvas/web/src/components/canvas/canvas-node.tsx` | 997 | 节点外壳：拖拽 / 缩放 / 标题编辑 / 批次叠卡 / 内容分发 |
| `s'r'c/basketikun-infinite-canvas/web/src/components/canvas/use-image-editor-viewport.ts` | 217 | **六个编辑器共用的缩放平移 hook（最大可复用资产）** |
| `s'r'c/basketikun-infinite-canvas/web/src/lib/canvas/canvas-image-data.ts` | 174 | 纯函数：裁剪 / 切分 / 转角度 / 放大 |
| `s'r'c/basketikun-infinite-canvas/web/src/components/canvas/canvas-node-crop-dialog.tsx` | 271 | 裁剪对话框 |
| `s'r'c/basketikun-infinite-canvas/web/src/components/canvas/canvas-node-mask-edit-dialog.tsx` | 438 | 笔刷蒙版（局部重绘） |
| `s'r'c/basketikun-infinite-canvas/web/src/components/canvas/canvas-node-split-dialog.tsx` | 299 | 网格切分（可自定义切割线） |
| `s'r'c/basketikun-infinite-canvas/web/src/components/canvas/canvas-node-upscale-dialog.tsx` | 110 | 放大到 1K/2K/4K |
| `s'r'c/basketikun-infinite-canvas/web/src/components/canvas/canvas-node-angle-dialog.tsx` | 93 | 「AI 转角度」参数面板 |
| `s'r'c/basketikun-infinite-canvas/web/src/components/canvas/canvas-image-toolbar-tools.tsx` | 166 | 图片工具栏的**数据驱动注册表** |
| `s'r'c/basketikun-infinite-canvas/web/src/lib/canvas/node-registry.ts` | 61 | 节点类型注册表（`getNodeDefinition`） |

### 2.2 能借鉴什么（具体到函数名）

#### (1) `useImageEditorViewport(image, open)` —— 优先级最高的单个资产

basketikun 的六个图像编辑器（裁剪 / 蒙版 / 切分 / 放大 / 转角度 / 查看大图）**共用同一个缩放平移 hook**。
签名与返回值：

```ts
useImageEditorViewport(image: { width: number; height: number } | null, open: boolean): {
  viewportRef; stageRef; zoom; isPanning; spacePressed; scrollClassName;
  panHandlers; canZoomIn; canZoomOut; imageScale;
  zoomIn; zoomOut; resetZoom;
  contentStyle; stageStyle; mediaStyle;
}
```

值得抄的四个机制：

1. **以鼠标位置为锚点缩放**（`setZoomAround(nextZoom, clientX?, clientY?)`）。先记录
   `{ zoom, ratioX, ratioY, viewportX, viewportY }`（`ratioX/Y` 是鼠标点在内容上的归一化位置），
   再在 `useLayoutEffect` 里反算滚动位置：
   `viewport.scrollLeft = nextLeft + anchor.ratioX * nextWidth - anchor.viewportX`。
   直接 `setZoom` 会让画面以左上角为锚点乱跳，这是必须抄的那一段。
2. **滚轮 `preventDefault` + `stopPropagation`**：
   `viewportElement.addEventListener("wheel", handleWheel, { passive: false })`。
   不 `stopPropagation`，滚轮会冒泡到画布，**编辑器和画布一起缩放**——这是最容易踩的坑。
3. **空格拖拽**：window 上 capture 阶段监听 `keydown` / `keyup`，`event.code !== "Space" || event.repeat`
   早退；跳过 `input, textarea, [contenteditable='true']`；并且先 `document.activeElement.blur()`
   （否则空格会触发当前聚焦的按钮）。平移本身用 `onPointerDownCapture` 等 **capture 阶段**的
   `panHandlers`，中键或空格+左键，配 `setPointerCapture`。
4. **只动 `transform`，不动宽高**：`mediaStyle` 是
   `{ transform: \`translateZ(0) scale(${zoom})\`, transformOrigin: "top left" }`。
   改宽高会触发重排并让 `getBoundingClientRect` 在拖拽中抖动。

#### (2) `canvas-image-data.ts` —— 五个纯函数，可直接照抄语义

| 函数 | 语义 | 关键常量 / 细节 |
|---|---|---|
| `cropDataUrl(dataUrl, crop?)` | 裁剪；无 `crop` 时取**居中正方形** | `crop` 全部是**归一化 0~1**，不是像素 |
| `splitDataUrl(dataUrl, params)` | 按行/列切分，支持**自定义切割线** | 返回 `ImageSplitPiece[] = { row, column, dataUrl }` |
| `transformAngleDataUrl(dataUrl, params)` | 伪 3D 斜切（本地近似） | `setTransform(1, pitch*0.08, horizontal*-0.1, 1, 0, 0)` + 外扩 18% padding + 广角暗角 |
| `upscaleDataUrl(dataUrl, params)` | 放大 | `algorithm === "high"` 走**逐级 ×2**（`drawStepUpscale`），避免一次性放大的糊 |
| `resolveUpscaleSize(width, height, targetLongEdge)` | 按长边等比算目标尺寸 | `MAX_UPSCALE_LONG_EDGE = 4096` 夹紧 |

内部还有三个小工具值得照搬：`drawResizeCanvas`（`imageSmoothingEnabled = algorithm !== "nearest"`，
`imageSmoothingQuality = bilinear ? "medium" : "high"`）、`buildSplitCuts(lines, size, count)`
（无自定义线时均分、有时过滤越界点后 sort）、`loadImage(dataUrl)`（Promise 包 `new Image()`）。

**关键结论：这一整套全部在浏览器 canvas 上完成，后端零参与。** 数据流是
`dataUrl → 编辑 → 新 dataUrl → 写回节点`。imagora 的图像来自后端 registry（`absPath` + `url`），
所以移植时要多一步「取图 → 编辑 → 上传/落盘」，但**运算部分可以原样搬**。

#### (3) 裁剪对话框：`AbortController` 绑事件 + 归一化 rect 的夹紧算法

- 拖拽监听用 `AbortController` + `document.addEventListener("pointermove", move, { signal })`，
  关闭时 `controller.abort()` —— **组件卸载/关闭即自动解绑**，比手工 `removeEventListener` 不易漏。
- `moveCrop(crop, dx, dy)` / `resizeCrop(crop, dx, dy, handle, aspectRatio, box)`：
  `minSize = 0.06`（归一化）；锁比例时要做
  `normalizedRatio = aspectRatio * (box.height / box.width)`（**像素比例 ↔ 归一化比例的换算**，
  这一步漏了会导致「1:1 裁出来是长方形」）；两轮夹紧（先 scaleDown 防越界，再 minSize 兜底）。
- `fitCropToRatio(crop, ratio, image)`：切比例时**保持中心**收缩。
- `CropMask` 用 **4 个 `bg-black/55` 的 div** 做遮罩（上/下/左/右），不是 canvas 绘制——成本极低。
- 三分线就是 `top-1/3 / top-2/3 / left-1/3 / left-2/3` 的 `border-white/50`。
- 底部 `Segmented` 切比例预设（`free / fixed / original / 1:1 / 4:3 / 16:9 / 9:16`），
  用 `gcd` 把结果约分显示（`formatRatio`）。

#### (4) 蒙版笔刷：双 canvas 架构 + `destination-out` 橡皮

- **两层 canvas**：`maskCanvasRef`（隐藏、纯黑、尺寸=原图像素尺寸，**这是真蒙版**）+
  `previewCanvasRef`（可见、蓝色 `#2563eb`、`opacity: 0.4`、叠在 `<img>` 上、`cursor-none touch-none`）。
- 橡皮不是「擦图」，是 `globalCompositeOperation = mode === "paint" ? "source-over" : "destination-out"`
  ——**只擦蒙版，不动原图**。
- 笔触以 `MaskStroke = { mode, size, points }` 数组保存；撤销/重做是
  `replayMask(strokes, maskCanvas, previewCanvas)` **全量重放**（清空后逐 stroke 重画）。
  笔触数一般几十条，重放开销可忽略，换来实现极简。
- `readCanvasPoint(canvas, clientX, clientY)` 用 `getBoundingClientRect()` 换算，
  **不受 CSS 缩放影响**。
- 笔刷光标用 `createPortal` 到 `document.body`、`fixed z-[1100]`，
  直径 `Math.max(4, brushPreview.size * viewport.imageScale)` —— **随画布缩放同步**。
- Alt+拖拽调笔刷大小：`nextSize = clampBrushSize(startSize + clientX - startX)`。
- 提交前必须校验「真的画了」：`canvasHasPaint(canvas)` 遍历 `getImageData` 的 alpha 通道。
- 两个出口：`submit(false)` 只导出蒙版图，`submit(true)` 导出并触发 AI 生成。

#### (5) 切分：加宽命中区的可拖切割线

- `SplitGrid` 每条切割线渲染成 `absolute inset-y-0 -ml-2 w-4 cursor-ew-resize` 的容器，
  **视觉线只有 1px**（`border-white/90`），命中区 16px —— 这是「细线可拖」的标准做法。
- `clampLine(value, min, max)` 夹在相邻线 ±0.01 之间防交叉；
  `buildGridLines(count)` 均分；`findLineSpot(lines)` **找最大空隙的中点**插入新线。
- 历史 `pushHistory(...)` 存参数快照，`> 50` 时 `shift()` 截断。
- 右侧实时显示「片数 / 平均尺寸」：`{ width: floor(image.width / columns), ... }`。

#### (6) 放大：档位自动选择

- `targetOptions = [{1K:1024}, {2K:2048}, {4K:4096}]`；打开时**自动选第一个大于源长边的档位**。
- `canUpscale = sourceLongEdge < targetLongEdge && targetLongEdge <= MAX_UPSCALE_LONG_EDGE`；
  `reachedMax = sourceLongEdge >= MAX_UPSCALE_LONG_EDGE` 时禁用并提示。

#### (7) 工具栏数据表 + 用户可配置可见集合

`canvas-image-toolbar-tools.tsx` 的核心不是某个按钮，而是**声明式注册表**：

```ts
type ImageToolDefinition = {
  id: ImageQuickToolId;
  defaultVisible: boolean;
  label: string | ((node) => string);
  title: string | ((node) => string);
  icon: (node) => ReactNode;
  active?: (node) => boolean;
  run: (node, handlers: ImageToolHandlers) => void;
};
```

`buildImageToolbarTools(node, handlers)` 把定义映射成 `{id,label,title,icon,active,onClick}`；
`normalizeImageQuickToolIds(value)` 用 `allIds.filter(...)` **按白名单顺序重排并过滤非法 id**；
配置存 `localStorage`，键名带版本后缀（`canvas-image-quick-tools-v7`）——**换版式就改后缀，
旧配置自动失效**，不需要写迁移代码。这条技巧 imagora 可以直接用（`canvasBounds.ts` /
`wallpaperStore.ts` 的存储键已经有 `.v1` 后缀，风格一致）。

#### (8) 节点内浮层的反向缩放

节点面板（配置面板 / 参考栏）用：

```
style={{ transform: \`translateX(-50%) scale(${1 / scale})\`, transformOrigin: "top center" }}
```

让面板**在屏幕上尺寸恒定**——画布缩小时面板不跟着变小。imagora 用 React Flow，
若以后在节点里放浮层（如 prompt 卡片上的参数弹层），同样需要这个反向缩放。

#### (9) 节点拖拽缩放的坐标换算

`handleResizeMove` 里第一行就是 `const dx = (event.clientX - resizeRef.current.startX) / scale`
——**把屏幕像素除回画布坐标**。`minWidth = 220; minHeight = 160`；
`keepRatio` 时按 `Math.abs(dx) >= Math.abs(dy)` 决定由宽还是高主导，再二次夹紧最小值；
位置回写 `{ x: fromLeft ? startRight - width : startLeft, y: fromTop ? startBottom - height : startTop }`。
imagora 用的是 React Flow 的 `NodeResizer`，这套换算不需要手写，但**「拖左边要改 x」的对称逻辑**
在自定义节点尺寸时仍然适用。

### 2.3 不能借鉴什么

| 项 | 原因 |
|---|---|
| antd `Modal` / `Segmented` / `Slider` / `Image` / `ConfigProvider` | imagora 不依赖 antd，自研 `ModalShell` + `Select` + `Field` + `index.css` token 体系 |
| `canvasThemes` 主题对象（`theme.node.panel` / `theme.canvas.background` …） | imagora 的底色只能来自 `frontend/src/surface.ts`，角色类挂 `.surface-*` |
| i18n key（`canvas.editors.*` / `canvas.node.*`） | imagora 是中文硬编码 + 少量 `t()`，不引 i18next |
| Zustand store（`use-canvas-store` / `use-canvas-ui-store`） | imagora 用 React state + `useNodesState` / `useEdgesState` |
| 节点内容存 base64（`node.metadata.content = "data:image/png;base64,..."`） | imagora 的图片走 registry（`registryId` + `absPath` + `url`），节点 data 只有引用，**不能把 base64 塞进节点**，否则快照 / 工作流文件会爆 |
| `plugin-*` 插件体系（`plugin-loader` / `plugin-registry` / `node-registry` 的插件部分） | imagora 只有 image / prompt / group 三类节点，引入插件体系是过度设计 |
| `canvas-node-generation.ts` 的 `hydrateNodeGenerationContext` | 它把 storageKey 惰性转 dataUrl；imagora 的生成请求发的是 `absPath`，链路不同 |

### 2.4 imagora 现状

`frontend/src/components/CanvasNodes.tsx`（415 行）的 `ImageNode` 只有三个 hover 按钮
（`NodeActions` 竖排在节点右侧 `left-full top-2`）：**预览大图 / 替换图片 / 删除图片**。
`useImageZoom.ts`（56 行）只是「单击延时开原图 vs 双击开 ZoomModal」的区分，不是编辑器。

**完全没有**：裁剪 / 蒙版 / 放大 / 切分 / 转角度 / 缩放平移编辑视图。
即「图像编辑能力」这一整块是空白，而 basketikun 这块的**全部实现都是 MIT 且全部在前端**。

### 2.5 建议

- **P0**：`cropDataUrl` + `upscaleDataUrl` 两个纯函数 + `useImageEditorViewport` 一个 hook +
  两个对话框（裁剪、放大）。理由是：收益最高、纯前端零契约、`imageOps.ts` 还能配单测
  （imagora 规定 `src` 根纯函数必须配 `*.test.ts`）。
- **P1**：蒙版笔刷（`destination-out` + 全量重放）。价值高但要接后端的图生图 / 编辑链路，
  需确认 `core/api.py` 是否支持 `mask` 参数。
- **P2**：切分、转角度。切分纯前端可做但用户频次低；转角度 basketikun 自己也是「AI 生成」
  而非本地变换（本地 `transformAngleDataUrl` 只是预览级近似），移植价值有限。

---

## 3. 方向二：画布交互

### 3.1 参考位置

| 文件 | 行数 | 作用 |
|---|---|---|
| `s'r'c/basketikun-infinite-canvas/web/src/lib/canvas/canvas-node-geometry.ts` | 176 | **纯函数几何层**：包围盒 / 分组吸附 / 视口聚焦 |
| `s'r'c/basketikun-infinite-canvas/web/src/components/canvas/canvas-selection-toolbar.tsx` | 85 | 多选时 SVG 虚线框 + 上方浮操作栏 |
| `s'r'c/basketikun-infinite-canvas/web/src/components/canvas/canvas-mini-map.tsx` | 137 | 小地图（点击/拖拽移动视口） |
| `s'r'c/basketikun-infinite-canvas/web/src/components/canvas/canvas-context-menu.tsx` | 56 | 节点右键菜单 |
| `s'r'c/basketikun-infinite-canvas/web/src/components/canvas/canvas-node-hover-toolbar.tsx` | 312 | 节点悬停工具栏（三级工具组装） |
| `s'r'c/basketikun-infinite-canvas/web/src/components/canvas/canvas-toolbar.tsx` | 385 | 底部 dock 工具栏（自绘 tooltip） |
| `s'r'c/basketikun-infinite-canvas/web/src/components/canvas/canvas-zoom-controls.tsx` | 85 | 左下角缩放 dock + 快捷键帮助 |
| `s'r'c/basketikun-infinite-canvas/web/src/components/canvas/canvas-connections.tsx` | 78 | 贝塞尔连线 + 双层点击热区 |

### 3.2 能借鉴什么

#### (1) `canvas-node-geometry.ts` —— 值得整份重写成 imagora 的纯函数模块

这是纯函数、无 React、无 antd，**可以直接照语义重写**（imagora 规定纯函数放 `src` 根并配单测）：

| 导出 | 语义 | 抄的时候注意 |
|---|---|---|
| `nodeBounds(nodes)` | 一次 `reduce` 求 `{left, top, right, bottom}` | 初值用 `±Infinity`，空数组返回退化盒 |
| `containsCenter(group, node)` | 用**节点中心点**判是否落在 group 矩形内 | 不是「整体包含」——整体包含会让大节点永远拖不进组 |
| `findGroupDropTarget(movedIds, nodes)` | 拖拽中找落点 group | **从后往前遍历**（注释写明「每帧拖拽都跑，所以倒序遍历而不是 copy+reverse」）；被拖集合含 Group 直接 `null`（禁止组嵌套组） |
| `snapNodesIntoGroup(movedIds, nodes, group)` | 把成员整组平移进 group 内缩 `pad = 24` 的矩形 | 超宽时贴左、否则贴右，一次算出 dx/dy |
| `collectGroupMemberNodes(selectedIds, nodes)` | 选中的 Group 展开成全部成员 | 靠 `metadata.groupId` 反查 |
| `getGroupWrapRect(members)` | 包围盒外扩 `GROUP_WRAP_PADDING = 24`，顶部多留 `GROUP_WRAP_TOP_PADDING = 52` | 顶部多留是**给工具栏腾位置** |
| `applyGroupSelection` / `applyUngroupSelection` | 纯函数版分组/解组 | 返回 `{nodes, connections, selectedIds}`；插入位置取「第一个成员的位置」以保持渲染层级 |
| `focusViewportForNode(node, size, frame)` | **核心视口算法**：算出让节点恰好落在可用区域中央的 `{x, y, k}` | 见下 |

`focusViewportForNode` 的实现要点（imagora 现在用 `fitView`，只会「全部塞进屏幕」，不会「聚焦单个节点」）：

```
usableBottom = size.height - frame.bottomInset
verticalRoom = usableBottom * 0.92 - frame.above - frame.below
k = clamp(min(width*0.6/node.width, height*0.6/node.height, verticalRoom/node.height), 0.05, 1)
slack = usableBottom - (above + node.height*k + below)
groupTop = slack * (below > 0 && slack > 0 ? 0.75 : 0.5)   // 下方有浮层时按 3:1 分
x = width/2 - nodeCenterX * k
y = groupTop + groupHeight/2 - nodeCenterY * k - (below - above)/2
```

即「节点最多占视口 60%」，且下方有面板时把节点往上推——这条规则比 `fitView` 精细得多。

#### (2) 小地图：imagora 可以只用一个内置组件

basketikun 的 `Minimap`（137 行）是手写的：固定 240×160，`useMemo` 算 `worldBounds`
（所有节点包围盒外扩 **500**，空画布回落 `{-500,-500,1000,1000}`），
`scale = min(240/bw, 160/bh)`，`toMinimap` / `toWorld` 双向换算，
点击/拖拽用 `setPointerCapture` 反算 `{x: width/2 - world.x*k, y: ..., k}`
（**点小地图任意点 = 把该点移到视口中心**），每个节点画 `Math.max(node.width*scale, 2)` 的 div。

**但 imagora 用 React Flow，`<MiniMap>` 是内置组件**，只需要：

- 一个开关（复用 `canvasBounds.ts` 的 localStorage 读写风格，新建 `minimapVisible.ts`）；
- `nodeColor` 按节点类型分色（image / prompt / group）；
- `pannable zoomable`。

**结论：手写算法不必移植，直接上 `<MiniMap>`；但 `worldBounds 外扩 500` 这个「留白比例」的
直觉值得照抄到 `fitView` 的 `padding` 上。**

#### (3) 缩放控件：`<input type="range">` 而不是按钮堆

`canvas-zoom-controls.tsx` 的左下 dock 是：
小地图开关 → 重置视图 → **`<input type="range" min={5} max={500} step={1} value={Math.round(scale*100)}>`**
→ 百分比数字 → 快捷键帮助（打开 Modal）。

**用滑杆而不是 `+/-` 按钮**的理由：无限画布的缩放跨度是 5%~500%（imagora 是 `minZoom=0.05 maxZoom=2`），
按钮要按十几次才能到目标，滑杆一次到位。imagora 现在用 React Flow `<Controls>`（只有 `+/-/fit`），
可以在 `<Controls>` 里用 `<ControlButton>` 之外再叠一个滑杆——React Flow 的 `<Controls>` 是 flex 容器，
允许插入自定义子元素（imagora 已经这么做了：塞了一个 `?` 帮助按钮）。

#### (4) 连线：双层 path 的点击热区

```
第一层：stroke="transparent" strokeWidth={16} pointerEvents="stroke"   ← 命中区
第二层：视觉线 pointerEvents="none"，active 时 strokeWidth=3 + drop-shadow
```

**16px 宽的透明热区**解决「1px 线点不中」。imagora 用 React Flow 的边，React Flow 自带
`interactionWidth`（默认 20），等价能力已内置；但 imagora 现在是「双击删边」，
**没有 hover 高亮与选中态**——可以给 `defaultEdgeOptions` 加 `style` 与 `markerEnd`，
并在 `onEdgeMouseEnter` 里改 `className`（React Flow 允许动态改边数据）。

贝塞尔曲率参数也值得记：`curvature = Math.max(dx * 0.5, 50)`，
路径 `M s C s+cx,s e-cx,e e` —— 水平进出、最小曲率 50，避免两个靠近的节点连出一条直线。

#### (5) 节点悬停工具栏：三级组装 + 图片节点走白名单

`canvas-node-hover-toolbar.tsx` 的组装逻辑：

```
baseToolbarTools（info / ungroup / delete）
  ↓ 按 node.type 与 metadata 条件展开
nodeToolbarTools（canRetry / canQueryVideoTask / saveAsset / download / edit /
                  generateImage / config / decreaseFont / increaseFont / upload / imageTools）
  ↓
hasImage ? [...base, ...node].filter(t => quickImageToolIdSet.has(t.id))   // 图片节点：用户白名单
         : [...base, ...node, ...extraTools]                              // 其它节点：全显示
```

**「图片节点走用户可配置白名单，其它节点全显示」**这条非对称规则值得抄：图片节点的操作最多
（十来个），必须让用户裁；文本/配置节点只有两三个操作，加配置界面纯属负担。

定位：`left = viewport.x + (node.position.x + node.width/2) * viewport.k`，
`top = viewport.y + node.position.y * viewport.k - 14`，样式 `h-12 -translate-x-1/2 -translate-y-full`。
**工具栏永远在节点正上方、水平居中、随画布缩放同步移动**。

悬停延时消失用 `onKeep(node.id)` / `onLeave()` 双回调：鼠标移进工具栏本身时不 onLeave。
imagora 现在的 `NodeActions` 是纯 CSS `group-hover:opacity-100`，
**鼠标从节点移到操作栏的瞬间会闪**（中间有空隙）——这是个真实的可用性缺陷。

#### (6) 底部工具栏的自绘 tooltip

`ToolbarButton` 在 `onMouseEnter` 里调 `getTipX(wrapRef.current, event.currentTarget)`
算出 `box.left - wrapBox.left + box.width/2` 传给父组件，父组件渲染
`<div className="absolute bottom-[calc(100%+8px)] -translate-x-1/2">`。
**比通用 Tooltip 更贴合横向滚动 dock**（通用 Tooltip 会算出视口外的位置）。

#### (7) 多选框：SVG 虚线框

`canvas-selection-toolbar.tsx` 用 `<svg className="pointer-events-none absolute z-[65]">` 画
`<rect rx={16} ry={16} strokeDasharray="7 5" strokeOpacity={0.55} strokeWidth={1.5}>`，
`SELECTION_PAD = 14` 外扩，框上方浮 `h-12 rounded-[18px]` 操作栏，按钮上
`onMouseDown/onPointerDown stopPropagation` 防止拖到画布。

imagora 现在用 `boxRect` state + `rf.flowToScreenPosition` 画一个普通 div 选框
（`CanvasPage.tsx` 尾部）。**SVG 的好处是圆角 + 虚线 + 半透明描边一次到位**，div 要叠 border + radius，
效果接近但 SVG 更干净。

#### (8) 右键菜单的「点外关闭」细节

`useEffect` 挂 `window.addEventListener("pointerdown", close)`，但**先判断
`target.closest(".ant-popover")` 则跳过**——避免点菜单内部的浮层（如子菜单）时被关掉。
imagora 若做右键菜单，等价判断是「点是否在菜单 DOM 内」，可以直接用 `rootRef.contains(target)`。

### 3.3 不能借鉴什么

| 项 | 原因 |
|---|---|
| 整套自研视口变换（`ViewportTransform` / `screenToWorld` / `worldToScreen`） | imagora 用 React Flow，`screenToFlowPosition` / `flowToScreenPosition` / `getViewport` 已内置 |
| 自研小地图的坐标换算 | React Flow 有 `<MiniMap>` |
| 自研连线渲染与拖拽预览 | React Flow 的 `edges` + `connectionLineType` 已内置 |
| `canvas-event-bus.ts` / `plugin-*` | 过度设计 |
| `canvasThemes` 主题体系 | imagora 走 `surface.ts` + `index.css` token |

### 3.4 imagora 现状

`frontend/src/components/CanvasPage.tsx`（1620 行）用 **`@xyflow/react`**（React Flow），已有：

- `<Background variant={BackgroundVariant.Dots} gap={24} size={1} />`
- `<Controls fitViewOptions={{ padding: 0.15, minZoom: MIN_FIT_ZOOM, maxZoom: 2 }}>` + 一个 `?` 帮助按钮
- `onlyRenderVisibleElements`（视口虚拟化）、`minZoom={0.05} maxZoom={2}`
- `deleteKeyCode={null}` / `selectionKeyCode={null}` / `multiSelectionKeyCode={["Meta","Control"]}`
- **右键拖拽框选**（`boxRect` + `screenToFlowPosition`，替代 React Flow 默认的 Shift+左键）
- 选中操作栏（`studio-inspector surface-float absolute right-3 top-3`）：运行所选 / 自动整理 /
  自动连线 / 设置输出路径 / 删除所选
- LOD 抽象模式（`LOD_IN_ZOOM = 0.1` / `LOD_OUT_ZOOM = 0.2`）
- 快捷键：Ctrl+A 全选 / Ctrl+Z 撤销 / Ctrl+Shift+Z 与 Ctrl+Y 恢复 / Ctrl+S 保存 / Delete 删除
  （`isEditable(target)` 跳过输入框）
- 画布右下角日志轮播 `CanvasLog`（`LOG_VISIBLE_COUNT = 5`，`pointer-events-none`）

**缺口**：小地图、缩放滑杆、节点右键菜单、hover 工具栏（现为 CSS `group-hover` 竖排）、
选中虚线框（现为普通 div）、连线的 hover 高亮。

### 3.5 建议

- **P0**：`<MiniMap>` 开关 + 缩放滑杆进 `<Controls>`。两项都是「加几十行」的量级。
- **P1**：节点 hover 工具栏从 CSS `group-hover` 改成「带 keep/leave 延时的定位浮层」，
  修掉「鼠标从节点移到操作栏时闪一下」的缺陷；顺带把按钮改成横排（竖排在节点右侧会压住邻居节点）。
- **P1**：`focusViewportForNode` 的「节点最多占视口 60%」规则——imagora 的「双击放大」
  与「定位到某节点」可以复用它。
- **P2**：节点右键菜单（`canvas-context-menu.tsx` 56 行，成本不高但优先级低于上面几项）。

---

## 4. 方向三：批量与状态

### 4.1 参考位置

| 文件 | 行数 | 作用 |
|---|---|---|
| `s'r'c/basketikun-infinite-canvas/web/src/components/image-generation-pending.tsx` | 46 | **生成中占位卡（最值得直接重写移植的一个）** |
| `s'r'c/basketikun-infinite-canvas/web/src/components/canvas/canvas-node.tsx` | 997 | `BatchFrame` / `ExpandedImageCard` / `BatchImageFailureActions` / `ImageSlotStatus` |
| `s'r'c/basketikun-infinite-canvas/web/src/components/canvas/canvas-node-generation.ts` | 229 | 生成上下文构建（沿连线回溯 + `@` token 解析） |

### 4.2 能借鉴什么

#### (1) `ImageGenerationPending`（46 行）—— 几乎可以逐行重写

```ts
ImageGenerationPending({ className, label, compact = false })
```

机制：

- `useState(tick)` + `setInterval` 每秒 +1；
- 文案轮播：`index = Math.floor(tick / 2) % pendingMessages.length`（**每 2 秒换一句**）；
- 进度条用**渐近曲线**而非线性：`progress = Math.min(98, 10 + (1 - Math.exp(-tick / 28)) * 88)`
  ——永远到不了 100%，但会先快后慢地逼近，符合「真实生图不知道还剩多久」的体感；
- 背景是 `radial-gradient` 点阵 + `maskImage: radial-gradient(ellipse at 38% 68%, ...)`
  做局部渐隐（**纯 CSS，无 canvas**）；
- 左上角 `<LoaderCircle className="animate-spin">` + 文案，底部「耗时 · 百分比」+ 进度条。

**imagora 的对应位置**：`CanvasNodes.tsx` 的 `PromptNode` 现在是 `running` 时按钮显示
`<ElapsedText>`、`queued` 显示「排队中...」，节点里**没有占位区**——用户看不出「图正在长出来」。
把 `ImageGenerationPending` 重写成 imagora 的 token 体系（`.surface-*` + `bg-swatch` 语义色），
放进 PromptNode 的结果区，是**性价比最高的一项**。

#### (2) `BatchFrame`：用纯 CSS 叠卡表达「这是一批」

```ts
BatchFrame({ batchCount, batchExpanded, children })
```

`isBatchRoot = batchCount > 1` 时，在内容背后叠 `Math.min(batchCount - 1, 3)` 张「卡片」：

```
translate(${10 + index * 6}px, ${4 + index * 3}px) rotate(${1.5 + index}deg)
zIndex: -index - 1
background: linear-gradient(135deg, panel, fill)
batchExpanded 时 opacity: 0
```

**零状态、零布局计算**——只是几张绝对定位的 div。这个技巧可以直接用于 imagora 的
`GroupNode`（现在只显示「N 张图 / MB」文字，加叠卡后一眼看出是组）。

#### (3) `ExpandedImageCard`：批次展开后的单张卡片

签名带 8 个回调：`onView / onSetPrimary / onDuplicate / onDownload / onRetry / onDelete`，
外加 `index` 与 `scale`。**每张图独立操作**——这是「批量生成」的关键：
失败一张不影响其它，可以单独重试/下载/删除。

#### (4) `ImageSlotStatus` / `BatchImageFailureActions`：状态下沉到单张

- `ImageSlotStatus({ image })`：`failed = image?.status === "error"` → 失败显示
  `image.errorDetails`，否则转圈 + 「生成中」文案。
- `BatchImageFailureActions({ placement, onRetry, onDelete })`：单张失败时角上浮出
  「重试 + 删除」两个按钮，`placement` 决定贴左还是贴右（避免压住主图）。

**状态粒度从「节点级」下沉到「图片级」**——这是 imagora 与它最本质的差距：
imagora 的 `StatusLight` 是节点级（`queued/running/done/failed`），一张图一个节点，所以够用；
一旦做多图批次，必须有图片级状态。

#### (5) `canvas-node-generation.ts` 的上下文构建

- `buildNodeGenerationContext(nodeId, nodes, connections, prompt)`：**沿连线回溯上游**，
  把上游文本拼进 prompt、上游图片/视频/音频变成参考数组。
- `buildComposerGenerationContext(inputs, prompt)`：解析 prompt 里的 `@[node:${id}]` token
  （正则 `/@\[node:([^\]]+)\]/g`），**按出现顺序分配标签**，未被引用的上游资源**不进入**参考数组。
  → 这就是「`@` 引用」在生成侧的落地。
- `flattenGenerationInputs(inputs)`：`[...new Map(resources.map(i => [i.nodeId, i])).values()]`
  **按 nodeId 去重**。
- `hydrateNodeGenerationContext`：动态 `import("@/services/image-storage")` 把 storageKey
  惰性转 dataUrl —— **避免一开始就把 base64 全载入内存**。

imagora 已有等价物且更成熟：`workflow.ts` 的 `collectIncomingImages`（沿边收集）
与 `snapshotIncomingAbsPaths`（提交时登记参考图）。**不移植**，但可以对照它的
「`@` token 优先、未引用不传」语义，作为方向五的设计输入。

### 4.3 不能借鉴什么

| 项 | 原因 |
|---|---|
| 多图批次的数据模型（`node.metadata.images: CanvasNodeImage[]`） | imagora 的数据模型是「一张图一个 image 节点 + 组节点聚合」，改模型会波及 `workflow.ts` 全部纯函数、`canvasEntriesToNodes`、工作流文件格式、后端 registry —— **成本极高** |
| `imageToDataUrl` / storageKey 体系 | imagora 的图片有 `absPath` + registry，不需要 base64 中转 |
| 视频 / 音频节点的批次逻辑 | imagora 只做生图 |

### 4.4 imagora 现状

- **一张图一个节点**：`ImageNode` 无 `images[]`，`data` 是 `CanvasImageNodeData`
  （`registryId` / `name` / `refCount` / `size` / `missing` 等）。
- **状态在节点级**：`StatusLight({data})` 读 `data.status`，映射
  `queued`→琥珀 / `running`→`bg-brand animate-pulse` / `done`→绿 + 「完成 · N 张」/
  `failed`→红 + 「失败：${message}」。
- **秒数刻意不进 `title`**（防 tooltip 每秒跳字闪烁）；`ElapsedText` 组件内部每秒
  `setInterval` **只重渲染自身文字**（注释明确：原逐秒写节点 data 导致悬停闪烁）——这条已经做对了。
- **任务轮询**在 `useGenerationTask.ts`（200 行）：`POLL_INTERVAL_MS = 2000`，
  每任务一个 timer + 竞态防护（`pollTimersRef.get(taskId) !== timer` 就丢弃过期结果），
  `elapsed` 本地每秒推进，`TERMINAL_STATUSES` 自动停轮询，409 超预算时 `window.confirm` 一次。
- **缺口**：无多图批次、无 `BatchFrame` 叠卡、无单张失败重试、无生成中占位卡、无图片级状态。

### 4.5 建议

- **P0**：`ImageGenerationPending` 重写移植 → 放进 `PromptNode` 的结果区。
  收益：画布上直接看到「图在长」；成本：一个组件 + 一个单测。
- **P1**：`GroupNode` 加 `BatchFrame` 式叠卡（`Math.min(n-1, 3)` 张背景卡）。
  纯 CSS，不改数据模型。
- **P2**：多图批次。**明确不建议近期做**——它会推翻「一张图一个节点」这个贯穿
  `workflow.ts` / `layout.ts` / 后端 registry 的假设。

---

## 5. 方向四：设置面板

### 5.1 参考位置

| 文件 | 行数 | 作用 |
|---|---|---|
| `s'r'c/basketikun-infinite-canvas/web/src/components/image-settings-panel.tsx` | 259 | 生图参数面板（质量 / 尺寸 / 张数） |
| `s'r'c/basketikun-infinite-canvas/web/src/components/model-picker.tsx` | 117 | 模型选择器（品牌图标 + 互斥打开） |
| `s'r'c/basketikun-infinite-canvas/web/src/components/canvas/canvas-size-picker.tsx` | 67 | 尺寸选择器（可搜索 + 可自由输入） |
| `s'r'c/basketikun-infinite-canvas/web/src/components/canvas/canvas-config-composer.tsx` | 380 | 配置节点的提示词编辑器（含 `@` 引用） |

### 5.2 能借鉴什么

#### (1) 尺寸是「倍率 × 比例」二元组，不是自由宽高

`image-settings-panel.tsx` 的核心设计：

```
inferMediaScale(activeSize)  → 从尺寸字符串反解倍率
inferMediaRatio(activeSize)  → 反解比例
readMediaDimensions(size, scale, ratio) → 当前宽高
computeMediaSize(scale, ratio)          → 拼回字符串
applySize(scale, ratio)                 → 唯一写入口
```

配套交互：

- `selectScale(scale)`：比例是 `auto` 时**强制回落 `1:1`**（否则 auto × 2 无意义）；
- `selectRatio(ratio)`：保留当前 scale；
- **16 对齐开关**：`snapDimensionToStep` 默认 `true`，
  `alignDimension(value, enabled) = enabled ? Math.ceil(value / 16) * 16 : value`
  ——很多上游对非 16 倍数尺寸会静默裁切，这个开关是**真实的兼容性需求**；
- `DimensionInput` 用 **`defaultValue` + `key={\`${prefix}-${value}\`}` 强制重挂**而不是受控，
  只在 `onBlur` / Enter 时 commit —— 受控输入在「用户正在打字」时会被外部 state 覆盖光标；
- `AspectIcon({ width, height, color })`：按 `ratio = width / height` 算
  `boxWidth / boxHeight`（≥1 时宽 24，否则宽 `max(10, 24 * ratio)`），画一个 `border-2` 的空心矩形
  —— **用图形而不是文字表达比例**，扫一眼就懂。

imagora 的尺寸选择是 `Select`（固定 options 列表），**没有比例预览图标，也没有 16 对齐**。

#### (2) `ModelPicker` 的两个小机制

- **跨 picker 互斥打开**：`window.dispatchEvent(new CustomEvent("model-picker-open", { detail: pickerId }))`，
  每个实例监听该事件，`detail !== pickerId` 就 `setOpen(false)` —— 页面里多个模型选择器同时只开一个。
  这是「同一类浮层互斥」的最省事实现（不用 context、不用全局 store）。
- **品牌图标映射**：`resolveModelIcon(model)` 按小写名 `includes` 匹配
  `claude|anthropic`、`gemini|google`、`gpt|openai`、`grok`、`deepseek`、`glm`，
  都无则回落 `<Cpu>`；`<img className="size-4 shrink-0 dark:invert">`。
  imagora 的 `Select` 目前只有文字，加图标能显著提升「一眼认出模型」的速度。

#### (3) 尺寸选择器：可搜索 + 可自由输入自定义比例

`canvas-size-picker.tsx`：antd `Select showSearch`，把 `[value, search.trim()]` 中
不在 `sizeOptions` 里的都塞进 `extraOptions`，`onBlur` / Enter 时把任意输入当自定义尺寸提交。
**这解决了「预设里没有我要的比例」的问题**。imagora 的 `Select` 是固定 options，
但可以在 `Select` 上加一个「允许自定义值」的可选 prop（输入框 + 回车提交），改动很小。

#### (4) `CanvasConfigComposer` 的容器事件隔离

```tsx
onMouseDown={stopCanvasInteraction}
onPointerDown={stopCanvasInteraction}
onWheel={(event) => event.stopPropagation()}
data-canvas-no-zoom
```

**画布内的可编辑浮层必须拦掉 mousedown / pointerdown / wheel**，否则点输入框会开始拖画布、
滚轮会缩放画布。imagora 的 `PromptNode` 已经用 `nodrag` 类名解决了拖拽，
但 **`onWheel` 冒泡到 React Flow 会导致「在提示词框里滚轮缩放画布」** —— 值得检查一下。

### 5.3 不能借鉴什么

| 项 | 原因 |
|---|---|
| `ImageSettingsTheme`（用 antd `ConfigProvider` 把 token 映射到自定义主题） | imagora 用 CSS 变量 + `@layer components`，不需要运行时主题注入 |
| antd `Slider` / `Segmented` / `OptionPill` | imagora 自研 `.btn-*` / `Select` / `field-control` |
| `selectableModelsByCapability` / `channelMode` 配置模型 | imagora 的模型清单来自 `/api/config`，结构不同 |
| i18n 的 `get label()` 惰性取词 | imagora 是中文硬编码 |

### 5.4 imagora 现状

- **`Select.tsx`（383 行）已经很强**：`createPortal` 到 body（避开滚动容器裁切）、
  `measure()` 上下翻转 + `maxHeight` 限制、`ResizeObserver` 补「布局挤窄但窗口没变」、
  `rankByName`（有序子序列 + 前缀优先，打 `flare` 或 `gi25` 都能命中 `gpt-image-2.5-flare`）、
  `groupOptions` 分组（组标题不参与键盘导航）、`popupLayer` push/pop（Esc 先收下拉再关弹窗）、
  完整 ARIA listbox 语义。**这套比 basketikun 的 antd Select 更可控，不要换。**
- **`ProviderModal.tsx`（380 行）**：`Field`（label + 控件 + 单行消息槽位，hint 与 error 不同时出现）、
  前端预判校验（`NAME_RE` / `urlIssue` / `pathIssue`，**注释明确「前端校验不是防线，服务端仍会再校验」**）、
  「探到模型清单 → 自动切下拉 + 预填第一个 + 保留手填切换」的双通道设计。
- **缺口**：无比例预览图标、无 16 对齐、无尺寸自定义输入、模型选择器无品牌图标、
  多个选择器可同时展开。

### 5.5 建议

- **P1**：给 `Select` 加可选 `renderOption`（渲染图标/比例图形），用于模型与尺寸；
  `AspectIcon` 的「按比例画空心矩形」逻辑重写成 `aspectIconSize(ratio)` 纯函数 + 单测。
- **P2**：`Select` 加 `allowCustom`（自由输入）；尺寸 16 对齐开关（需先确认 imagora 的上游
  是否真的需要——`core/api.py` 里有没有尺寸校验逻辑可查）。
- **不建议**：跨 picker 互斥（imagora 弹窗里的选择器本来就少，`popupLayer` 已解决 Esc 问题）。

---

## 6. 方向五：提示词输入

### 6.1 参考位置

| 文件 | 行数 | 作用 |
|---|---|---|
| `s'r'c/basketikun-infinite-canvas/web/src/components/canvas/canvas-resource-mention-textarea.tsx` | 352 | **textarea + 高亮覆盖层**（改动小、易接入） |
| `s'r'c/basketikun-infinite-canvas/web/src/components/canvas/canvas-prompt-chip-input.tsx` | 426 | **contentEditable + chip**（体验更好、实现更重） |
| `s'r'c/basketikun-infinite-canvas/web/src/lib/canvas/canvas-resource-references.ts` | 147 | 引用标签生成 + 资源节点解析 |

### 6.2 能借鉴什么

#### (1) 两种方案，先选轻的那种

| 方案 | 实现 | 优点 | 缺点 |
|---|---|---|---|
| **A. textarea + 覆盖层**（`canvas-resource-mention-textarea.tsx`） | 底层 `div.pointer-events-none.absolute` 渲染高亮文本，上层 `<textarea>` 在 `showOverlay` 时 `color: transparent`（保住原生光标） | **改动最小**：props 继承 `TextareaHTMLAttributes`，可以直接替换现有 `<textarea>`；原生输入法 / 撤销 / 选择全都在 | 高亮是「画上去的」，光标与高亮的对齐靠 mirror 测量，有累积误差风险 |
| **B. contentEditable + chip**（`canvas-prompt-chip-input.tsx`） | 自己维护 DOM 树，每个引用是一个 `contentEditable=false` 的 `span` | 引用是**原子节点**，视觉上就是一枚 chip；删除是整个 chip 一起删 | 要自己处理光标保持、IME、序列化、原子删除，**坑很多** |

**建议 imagora 选 A**：`PromptNode` 现在是普通 `<textarea className="nodrag field-control resize-y text-xs leading-relaxed" rows={5}>`，
方案 A 是「换一个组件、props 不变」，风险可控；方案 B 要重写整块输入区。

#### (2) 方案 A 的四个关键技术点

1. **`showOverlay = Boolean(activeLabels.length && !hasSelection)`**
   —— **有选区时关掉高亮层**，否则选中文本看不见（因为 textarea 文字是透明的）。
   这是方案 A 唯一的「体验悬崖」，必须实现。
2. **`syncOverlayScroll()`**：同步 `scrollTop` / `scrollLeft`，否则滚动后高亮错位。
3. **`getCaretPoint(textarea, index)`：mirror div 测量法** ——
   建 `position:absolute; left:-9999px; visibility:hidden; white-space:pre-wrap` 的 div，
   把 `MIRROR_STYLE_PROPS`（`boxSizing / width / padding* / border*Width / fontStyle / fontVariant /
   fontWeight / fontStretch / fontSize / lineHeight / fontFamily / textAlign / textIndent /
   letterSpacing / wordSpacing / tabSize / textTransform`）从 `getComputedStyle(textarea)` 逐一复制，
   填入 `value.slice(0, index)` + 一个 marker span，读 `marker.offsetLeft/offsetTop`。
   **这 17 个属性漏一个就错位**，是这段代码的全部难点。
4. **画布缩放补偿**：`const scale = textarea.offsetWidth ? rect.width / textarea.offsetWidth : 1`
   （`rect` 是缩放后的视觉尺寸，`offsetWidth` 是布局尺寸），
   `lineHeight = (parseFloat(computed.lineHeight) || parseFloat(computed.fontSize) * 1.4 || 20) * scale`。
   **在无限画布里，文本框会被 CSS transform 缩放，`offsetLeft` 拿到的是布局坐标，必须乘 scale。**

#### (3) `@` 触发的正则差异（两条都要注意）

| 方案 | 正则 | 语义 |
|---|---|---|
| A（textarea） | `/(^|\s)@([^\s@]*)$/` | **要求 `@` 前是行首或空白** |
| B（contentEditable） | `/@([^\s@]*)$/` | 不要求 |

A 更严格是对的：邮箱 `a@b.com` 不该触发菜单。

#### (4) 引用标签是**稳定字符串**，直接嵌进 prompt 文本

`canvas-resource-references.ts`：

- `CanvasResourceReference = { id, nodeId, kind, label, title, previewUrl?, text?, active }`
- `labelResourceNodes(nodes, active)`：**按 kind 分别计数编号**
  （`counts: Record<CanvasResourceKind, number>`），生成「图片 1 / 视频 2 / 音频 3 / 文本 4」；
- `previewUrl` 取 `node.metadata?.content || resource?.url`；
- `text` 取 `resourceText(node)`（Text 节点取 `metadata.content || metadata.prompt`）。

**关键设计：标签是稳定字符串，直接嵌进 prompt 文本里，所以序列化/持久化不需要额外结构。**
imagora 若做 `@` 引用，同样应该把标签写进 prompt 字符串（而不是维护一份 side-table），
这样工作流文件、后端请求体都不用改结构——**只在提交前解析一次**。

#### (5) 引用来源的三级回退链

```
getMentionResourceNodes(nodeId, nodes, connections) =
  ① getConnectedConfigInputNodes   // 本节点连到 Config 节点时，取 Config 的上游
  || ② getContextInputNodes          // 连到本节点的上游节点
  || ③ 自身若是资源节点
```

`getContextInputNodes`：`connections.filter(c => c.toNodeId === nodeId)` → 找 `fromNodeId` 的节点
→ `.filter(isCanvasReferenceNode)`。
`isCanvasReferenceNode(node, nodes) = isResourceNode(node) || hasGroupResources(node, nodes)`
—— **Group 节点只要含资源也算引用源**，并展开成成员（`expandGroupResourceNodes` + `Map` 去重）。

imagora 的对应逻辑在 `workflow.ts` 的 `collectIncomingImages`（递归展开组、`stack` 路径栈剪环）
——**已有等价物，且 imagora 的环处理更严谨**（basketikun 用 `visited`，imagora 用路径栈）。

#### (6) 方案 B 才需要的两个坑（若最终选 B 再读）

- **标签必须按长度降序**：`activeLabels.sort((a, b) => b.length - a.length)`
  —— 短标签不能劈开长标签（`图片 1` 与 `图片 10` 共存时，先匹配 `图片 1` 会劈开 `图片 10`）。
- **DOM 重建与光标保持**：`lastEmittedRef` 记录最后一次 emit 的 value，
  `useEffect` 里若 `document.activeElement === editor && value === lastEmittedRef.current`
  则**跳过重建**（这是自己 emit 的回声，重建会毁掉光标和 IME）。
- **chip 原子删除**：`deleteAdjacentReference(key)` → `findReferenceSibling`（跳过纯空白文本节点，
  找 `dataset.refLabel` 的兄弟）→ `target.replaceWith(document.createTextNode(""))` 并把光标放进新文本节点。
- **IME 保护**：`composingRef` + `onCompositionStart/End`，组合期间不 emit。

### 6.3 不能借鉴什么

| 项 | 原因 |
|---|---|
| antd `Image` 预览、`MentionMenu` 的 antd 风格 | imagora 自研浮层 + `popupLayer` |
| `@[node:id]` 的序列化格式 | 那是给 Config 节点内部用的；imagora 若要序列化，应直接用可读标签 |
| `canvas-resource-references.ts` 里视频/音频的部分 | imagora 只做生图 |

### 6.4 imagora 现状

- `PromptNode` 的提示词是**纯 textarea**，placeholder「英文提示词，例如：a red apple on white background」，
  `rows={5}`，`className="nodrag field-control resize-y text-xs leading-relaxed"`。
- **完全没有 `@` 引用 / chip / 高亮**。参考图的选取是**全自动**：
  `collectIncomingImages` 沿边收集（图片 / 组 → 提示词），提交时 `snapshotIncomingAbsPaths` 登记。
- 已有的引用基础设施：`computeCounts` 里的 `tracePromptRefs`（**引用溯源**：图片沿参考数据流
  正向 BFS 到提示词，`visited` 剪环，到提示词即停，不反向追溯产出边）、
  `expandGroup`（`stack` 路径栈剪环）、`aggregateGroups`（去重口径 + `groupDups`）。
- 尺寸/质量两栏 `grid-cols-[7fr_3fr]`，`qualityEffective === false` 时退化成单列
  （豆包 Seedream 不认质量档）—— **能力探测已经做了**。

### 6.5 建议

- **P1**：方案 A（textarea + 覆盖层）做 `@` 引用。但**它需要契约改动**：
  现在参考图是「沿边全收集」，加 `@` 引用后变成「只传被引用的」，
  要改 `collectIncomingImages` 的调用点、`snapshotIncomingAbsPaths` 的口径、
  以及可能的后端请求体。**应单独立项**，先写设计文档（照 `docs/config-editor-ui-design.md` 的体例）。
- **P1 的前置**：先只做「高亮已连接的参考图标签」不做 `@` 插入——
  这样不碰生成口径，纯视觉提示，风险极低，能先验证 mirror 测量的准确性。
- **P2**：方案 B（chip）。只有在「引用必须原子删除」成为硬需求时才做。

---

## 7. 方向六：tldraw 的设计思路（只读，不可移植）

> **license 提醒**：`s'r'c/tldraw/LICENSE.md` 明确禁止生产环境使用、禁止以取代本许可的方式再分发。
> 本节只记录**设计原则**（为什么这么做、解决什么问题），**不含任何可直接抄的实现**。
> 后续实现子代理若需要这些能力，必须从零推导，不得逐行翻译 tldraw 的源码。

### 7.1 参考位置

| 文件 | 行数 |
|---|---|
| `s'r'c/tldraw/packages/editor/src/lib/editor/managers/HistoryManager/HistoryManager.ts` | 432 |
| `s'r'c/tldraw/packages/editor/src/lib/editor/types/history-types.ts` | 27 |
| `s'r'c/tldraw/packages/editor/src/lib/editor/tools/StateNode.ts` | 293 |
| `s'r'c/tldraw/packages/tldraw/src/lib/tools/SelectTool/childStates/Brushing.ts` | 279 |
| `s'r'c/tldraw/packages/editor/src/lib/primitives/Box.ts` | 703 |
| `s'r'c/tldraw/packages/editor/src/lib/editor/managers/SnapManager/SnapManager.ts` | 111 |

### 7.2 六条设计原则（转述，非代码）

#### (1) 历史记录用 diff 三桶，不用全量快照

tldraw 的每条历史是一个 `RecordsDiff`：`added` / `updated` / `removed` 三个桶。
撤销时把 diff **反转**（`reverseRecordsDiff`）再一次性 apply；多个连续操作可以
**合并成一个 diff**（`squashRecordDiffsMutable`）再 apply 一次，避免逐条 apply 引起的中间态重渲染。
栈本身是**不可变单链表**（`push` 返回新实例），配合细粒度订阅实现「只有引用变了才通知」。

对照 imagora：`frontend/src/canvasHistory.ts`（43 行）是**全量快照**：

```ts
function copyState(state) { return { nodes: [...state.nodes], edges: [...state.edges] }; }
createCanvasHistory(limit = 50) → { record, undo, restore, canUndo, canRestore, clear }
```

浅拷贝数组、上限 50 条。**对 imagora 来说这其实是合理的选择**：
节点 data 里只有 `registryId` / `absPath` 这类小字段，没有 base64，所以一份快照就是
「N 个对象引用」，内存开销极小。改成 diff 三桶的收益主要是「撤销粒度更细」（可以撤销单个字段），
成本是要给每种操作写 diff 生成器。**结论：P2，暂不改。**

#### (2) 只有「用户来源」的变更进历史

tldraw 的 store 有 `addHistoryInterceptor((entry, source) => { if (source !== 'user') return; ... })`
——程序性变更（加载文档、协作同步、初始化）不进撤销栈。

对照 imagora：`canvasHistory.ts` 的注释已经写明「保存用户操作前的画布快照；**运行状态更新不应调用 record**」，
`CanvasPage.tsx` 里 `onNodeDragStart={recordHistory}` 等位置手动调 `recordHistory()`。
**语义一致，已经做对了。** 但 imagora 是「调用点约定」，tldraw 是「拦截器强制」——
imagora 漏调一处就丢一次撤销点。若要加固，可以给 `setNodes` 包一层带 `source` 参数的 wrapper，
但成本/收益比不高。

#### (3) 批处理可以声明历史策略

`batch(fn, opts?: { history?: 'record' | 'record-preserveRedoStack' | 'ignore' })`
——一次批处理可以声明「记一条 / 记一条但保留重做栈 / 不记」。嵌套时内层直接执行不重复切状态。

对照 imagora：`handleRunAll` / `handleAutoConnect` 这类批量操作，现在要么记一次要么不记，
没有「保留重做栈」的概念。**imagora 的 redo 栈在 `record()` 里被 `future.length = 0` 清空**
——这意味着「撤销后再做任何操作，恢复链就断了」。tldraw 的 `record-preserveRedoStack`
正是为「程序性批量更新不该清空用户的重做链」准备的。**这条对 imagora 有实际价值**：
自动整理 / 自动连线 / 运行全部这类操作不该清空用户的重做栈。

#### (4) mark 作为可命名检查点

`markHistoryStoppingPoint(id)` 插入一个 `{ type: 'stop', id }` 标记，
`bailToMark(id)` 回滚到标记处，`squashToMark(id)` 把标记之前的多个 diff 压成一个。
用途：拖拽开始时打 mark，拖拽结束时把整个拖拽过程压成**一次撤销**。

对照 imagora：`onNodeDragStart={recordHistory}` 已经实现了「拖拽开始记一次」，
等价于「整个拖拽 = 一次撤销」。**语义一致。**

#### (5) 框选的候选集剪枝

`Brushing` 状态的实现要点（转述）：

- 用**空间索引**先筛出与选框相交的候选 id 集合，**候选为空就直接早退**（避免昂贵的全量排序）；
- 只对候选做逐形状命中测试；
- 选框完全包含形状时直接命中（快路径）；否则把选框四条边变换到形状局部坐标系，
  逐边与形状几何做线段相交测试；
- **只在选区真的变化时才打历史标记**（注释：不打的框选会并进上一条历史，撤销会连带撤掉之前的编辑）；
- 框选过程中若视口变了，后续必须测全部形状而不是只测屏幕内的。

对照 imagora：右键框选的实现是 `screenToFlowPosition` 换算起终点 + 遍历全部节点判相交
（`CanvasPage.tsx` 的 `boxRect` 相关代码）。节点数在几百的量级时**遍历全部是可接受的**；
上千节点才需要空间索引。**P2，暂不做。**

#### (6) `Box.Resize` 的比例锁与翻转

`Box.Resize(box, handle, dx, dy, isAspectRatioLocked)` 的要点（转述）：

- 先按 handle 决定改哪两条边（`left/top_left/bottom_left` 改 `minX`，等等）；
- 算 `scaleX` / `scaleY`，`< 0` 即翻转；
- 锁比例时算原比例 `aspectRatio`，然后按「宽主导还是高主导」修正另一边；
- 有 `ContainsApproximately` 这类带精度参数的比较（浮点比较不能直接用 `===`）。

对照 imagora：imagora 用 React Flow 的 `NodeResizer`，`keepAspectRatio` 已内置。
**不需要手写**，但「浮点几何比较要带精度」这条值得记。

### 7.3 对 imagora 唯一有直接价值的结论

**`record()` 清空 redo 栈这件事**：imagora 的 `canvasHistory.ts` 里
`record()` 会 `future.length = 0`。这导致「撤销 → 做自动整理 → 无法恢复」。
可以给 `record` 加一个 `preserveRedo` 选项，批量程序性操作传 `true`。改动极小（一个参数 + 单测），
收益是「用户的重做链不会因为一次自动布局而断掉」。**这一条可以从 P2 提到 P1。**

---

## 8. 总表：收益 × 成本

排序规则：先按「收益 / 成本」比值，再按收益绝对值。

| 序 | 建议项 | 方向 | 参考来源（可移植性） | 收益 | 成本 | 比值 | 优先级 |
|---|---|---|---|---|---|---|---|
| 1 | 生成中占位卡（进度渐近曲线 + 文案轮播） | 3 | basketikun `image-generation-pending.tsx`（MIT） | 高 | 低（1 组件 + 1 单测） | **最高** | **P0** |
| 2 | 画布小地图（`<MiniMap>` 开关） | 2 | React Flow 内置；basketikun `canvas-mini-map.tsx` 给留白直觉（MIT） | 中高 | 极低（几十行） | **极高** | **P0** |
| 3 | 缩放滑杆进 `<Controls>` | 2 | basketikun `canvas-zoom-controls.tsx`（MIT） | 中 | 极低 | **极高** | **P0** |
| 4 | `GroupNode` 叠卡（`Math.min(n-1,3)` 张背景卡） | 3 | basketikun `BatchFrame`（MIT） | 中 | 低（纯 CSS） | 高 | P1 |
| 5 | 撤销栈 `record(state, {preserveRedo})` | 6 | tldraw 设计原则（**不可移植**） | 中 | 低（一个参数） | 高 | P1 |
| 6 | 图像本地编辑：裁剪 + 放大 | 1 | basketikun `canvas-image-data.ts` + `use-image-editor-viewport.ts`（MIT） | **最高** | 中（1 纯函数模块 + 1 hook + 2 对话框） | 高 | **P0** |
| 7 | `AspectIcon` 比例预览 + `Select` 加 `renderOption` | 4 | basketikun `image-settings-panel.tsx`（MIT） | 中 | 低 | 高 | P1 |
| 8 | 节点 hover 工具栏改「带 keep/leave 延时的定位浮层」 | 2 | basketikun `canvas-node-hover-toolbar.tsx`（MIT） | 中高（修真实缺陷） | 中 | 中 | P1 |
| 9 | `focusViewportForNode` 的「最多占视口 60%」规则 | 2 | basketikun `canvas-node-geometry.ts`（MIT） | 中 | 低（纯函数） | 中高 | P1 |
| 10 | 提示词 `@` 引用（textarea 覆盖层方案） | 5 | basketikun `canvas-resource-mention-textarea.tsx`（MIT） | 高 | 中高（**需动生成口径**） | 中 | P1 |
| 11 | 引用标签高亮（不含 `@` 插入，纯视觉） | 5 | 同上（MIT） | 中 | 低 | 中高 | P1 |
| 12 | 模型选择器品牌图标 | 4 | basketikun `model-picker.tsx`（MIT） | 低中 | 低 | 中 | P2 |
| 13 | 蒙版笔刷（局部重绘） | 1 | basketikun `canvas-node-mask-edit-dialog.tsx`（MIT） | 高 | 高（要接图生图链路） | 中低 | P1 |
| 14 | 节点右键菜单 | 2 | basketikun `canvas-context-menu.tsx`（MIT） | 中 | 中 | 中低 | P2 |
| 15 | 图像切分（网格 + 自定义切割线） | 1 | basketikun `canvas-node-split-dialog.tsx`（MIT） | 中 | 中 | 中低 | P2 |
| 16 | `Select` 允许自由输入（自定义比例） | 4 | basketikun `canvas-size-picker.tsx`（MIT） | 低中 | 低 | 中 | P2 |
| 17 | 撤销栈改 diff 三桶 | 6 | tldraw 设计（**不可移植**） | 中 | 高 | 低 | P2 |
| 18 | 拖拽吸附对齐 | 2 | tldraw `SnapManager`（**不可移植**） | 中 | 高 | 低 | P2 |
| 19 | 多图批次节点 | 3 | basketikun `BatchFrame` / `ExpandedImageCard`（MIT） | 高 | **很高**（推翻数据模型） | 低 | P2（不建议近期） |

---

## 9. 实施路线建议

### P0（可并行，互不冲突）

| 项 | 落点文件（预计） | 依赖 |
|---|---|---|
| 生成中占位卡 | 新建 `frontend/src/components/GenerationPending.tsx`；改 `CanvasNodes.tsx` 的 `PromptNode` | 无 |
| 小地图 | `CanvasPage.tsx`（`<MiniMap>` + 开关 state）；新建 `frontend/src/minimapVisible.ts` + `.test.ts` | 无 |
| 缩放滑杆 | `CanvasPage.tsx`（`<Controls>` 内插自定义子元素） | 无 |
| 裁剪 + 放大 | 新建 `frontend/src/imageOps.ts` + `imageOps.test.ts`；`frontend/src/useImageEditorViewport.ts`；两个对话框组件 | 无（纯前端） |

### P1（需要设计与确认）

- 撤销栈 `preserveRedo`：改 `canvasHistory.ts` + 单测，`CanvasPage.tsx` 的批量操作调用点传 `true`。
- `Select` 的 `renderOption` + `AspectIcon`：改 `Select.tsx`，注意现有 155 行单测不能红。
- 节点 hover 工具栏重做：改 `CanvasNodes.tsx` 的 `NodeActions`，需要新的浮层定位 hook。
- `@` 引用：**必须先写设计文档**（生成口径从「沿边全收集」改为「只传被引用的」），
  再动 `workflow.ts` 与后端契约。

### P2（暂缓）

- 多图批次（数据模型大改）、tldraw 的 diff 历史 / 吸附对齐、切分、转角度、右键菜单。

---

## 10. 落地时必须遵守的 imagora 硬规则

以下规则来自 `imagora/AGENTS.md` 与 `imagora/frontend/AGENTS.md`，任何从参考项目移植的代码都要过这一关：

1. **严格 TS 开关全开**：`noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`。
   判据是 `npx tsc --noEmit -p tsconfig.json` 零错（两开关单独开都可能 0 错，同时开才暴露交互位点）。
   参考代码里大量的 `array[i]` 直接访问都要先收窄。
2. **样式不许硬编码**：底色只能来自 `frontend/src/surface.ts`，TSX 挂 `.surface-*` 角色类；
   **不写 `bg-white`、不写硬编码 `blur()`**；`surfaceAudit.test.ts` 会红。
   参考代码里的 `bg-stone-100` / `bg-black/55` / `backdrop-blur` 全部要换成 token 或角色类。
3. **纯函数模块必须配同名单测**：`src` 根目录的 `*.ts` 都要有 `*.test.ts`。
   `imageOps.ts` / `minimapVisible.ts` / `geometry.ts` 都要配。
4. **弹窗内浮层开关必须配 `popupLayer` 的 push/pop**，否则 Esc 会连弹窗一起关。
   参考项目的「点外关闭」逻辑没有这层，移植时要补。
5. **动效只动 `transform` / `opacity`**；动画类收敛到 `index.css` 的 `@layer components`。
6. **行尾按文件不同**：`types.ts` / `workflow.test.ts` / `components/CanvasPage.tsx` 是 CRLF，
   其余多为 LF。**改 `CanvasPage.tsx` 时必须保留 CRLF**，否则整文件翻行尾、diff 爆炸。
7. **改 `frontend/src/**` 后必须 `npm run build`**；纯函数改动跑 `npm test`。
8. **契约双端同步**：若 `@` 引用改动了生成请求体，必须同步
   `frontend/src/types.ts` + `frontend/src/api.ts` + 后端 `server.py`。
9. **拆分 `CanvasPage.tsx` 先补行为基线测试**（根 AGENTS.md 待办明确写着「当前覆盖薄、裸拆风险高」）。
   P0 里的三项都会改这个文件，**改动应该控制在「加 state + 加子元素」的粒度，不做结构性拆分**。

---

## 附录 A：参考文件行数速查

### basketikun（MIT，可移植）

```
997  web/src/components/canvas/canvas-node.tsx
438  web/src/components/canvas/canvas-node-mask-edit-dialog.tsx
426  web/src/components/canvas/canvas-prompt-chip-input.tsx
385  web/src/components/canvas/canvas-toolbar.tsx
380  web/src/components/canvas/canvas-config-composer.tsx
352  web/src/components/canvas/canvas-resource-mention-textarea.tsx
312  web/src/components/canvas/canvas-node-hover-toolbar.tsx
299  web/src/components/canvas/canvas-node-split-dialog.tsx
271  web/src/components/canvas/canvas-node-crop-dialog.tsx
259  web/src/components/image-settings-panel.tsx
229  web/src/components/canvas/canvas-node-generation.ts
217  web/src/components/canvas/use-image-editor-viewport.ts
176  web/src/lib/canvas/canvas-node-geometry.ts
174  web/src/lib/canvas/canvas-image-data.ts
166  web/src/components/canvas/canvas-image-toolbar-tools.tsx
147  web/src/lib/canvas/canvas-resource-references.ts
137  web/src/components/canvas/canvas-mini-map.tsx
117  web/src/components/model-picker.tsx
110  web/src/components/canvas/canvas-node-upscale-dialog.tsx
 93  web/src/components/canvas/canvas-node-angle-dialog.tsx
 85  web/src/components/canvas/canvas-selection-toolbar.tsx
 85  web/src/components/canvas/canvas-zoom-controls.tsx
 78  web/src/components/canvas/canvas-connections.tsx
 67  web/src/components/canvas/canvas-size-picker.tsx
 56  web/src/components/canvas/canvas-context-menu.tsx
 61  web/src/lib/canvas/node-registry.ts
 46  web/src/components/image-generation-pending.tsx
```

### tldraw（自有商业许可，**只读**）

```
703  packages/editor/src/lib/primitives/Box.ts
432  packages/editor/src/lib/editor/managers/HistoryManager/HistoryManager.ts
293  packages/editor/src/lib/editor/tools/StateNode.ts
279  packages/tldraw/src/lib/tools/SelectTool/childStates/Brushing.ts
111  packages/editor/src/lib/editor/managers/SnapManager/SnapManager.ts
 27  packages/editor/src/lib/editor/types/history-types.ts
```

### imagora 现状对照

```
1620  frontend/src/components/CanvasPage.tsx
 614  frontend/src/workflow.ts
 511  frontend/src/api.ts
 415  frontend/src/components/CanvasNodes.tsx
 405  frontend/src/layout.ts
 383  frontend/src/components/Select.tsx
 380  frontend/src/components/ProviderModal.tsx
 342  frontend/src/types.ts
 200  frontend/src/useGenerationTask.ts
  61  frontend/src/optionGroups.ts
  56  frontend/src/useImageZoom.ts
  43  frontend/src/canvasHistory.ts
  32  frontend/src/canvasBounds.ts
```

> **行数口径**：本文所有行数都是**物理换行数**（`([regex]::Matches($raw, "`n")).Count`）。
> 与 `Measure-Object -Line` 得到的数字不同——后者**跳过空行**，所以 `CanvasPage.tsx` 在
> 根 `AGENTS.md` 与任务描述里写的是 1545，物理行数其实是 1620。两者都对，只是口径不同；
> 引用行号定位时请用本文的物理行数。

---

## 附录 B：本文引用路径的验证方法

本文所有参考项目路径都在反引号里，**不是** `check_docs.py` 会去解析的 markdown 链接
（因为它们位于 imagora 仓库之外，随时可能被删）。撰写时已用 `Test-Path` 逐一验证存在。

若日后需要复核，可在仓库根执行：

```powershell
$env:PYTHONIOENCODING = 'utf-8'
$base = "D:\Download games\刘志远的魔怔工作台\s'r'c"
@(
  "basketikun-infinite-canvas\web\src\components\canvas\canvas-node.tsx",
  "basketikun-infinite-canvas\web\src\components\canvas\use-image-editor-viewport.ts",
  "basketikun-infinite-canvas\web\src\lib\canvas\canvas-image-data.ts",
  "basketikun-infinite-canvas\web\src\lib\canvas\canvas-node-geometry.ts",
  "basketikun-infinite-canvas\web\src\lib\canvas\canvas-resource-references.ts",
  "basketikun-infinite-canvas\web\src\components\canvas\canvas-node-mask-edit-dialog.tsx",
  "basketikun-infinite-canvas\web\src\components\canvas\canvas-node-crop-dialog.tsx",
  "basketikun-infinite-canvas\web\src\components\canvas\canvas-node-split-dialog.tsx",
  "basketikun-infinite-canvas\web\src\components\canvas\canvas-node-upscale-dialog.tsx",
  "basketikun-infinite-canvas\web\src\components\canvas\canvas-node-angle-dialog.tsx",
  "basketikun-infinite-canvas\web\src\components\canvas\canvas-image-toolbar-tools.tsx",
  "basketikun-infinite-canvas\web\src\components\canvas\canvas-node-hover-toolbar.tsx",
  "basketikun-infinite-canvas\web\src\components\canvas\canvas-mini-map.tsx",
  "basketikun-infinite-canvas\web\src\components\canvas\canvas-selection-toolbar.tsx",
  "basketikun-infinite-canvas\web\src\components\canvas\canvas-context-menu.tsx",
  "basketikun-infinite-canvas\web\src\components\canvas\canvas-toolbar.tsx",
  "basketikun-infinite-canvas\web\src\components\canvas\canvas-zoom-controls.tsx",
  "basketikun-infinite-canvas\web\src\components\canvas\canvas-connections.tsx",
  "basketikun-infinite-canvas\web\src\components\canvas\canvas-node-generation.ts",
  "basketikun-infinite-canvas\web\src\components\canvas\canvas-prompt-chip-input.tsx",
  "basketikun-infinite-canvas\web\src\components\canvas\canvas-resource-mention-textarea.tsx",
  "basketikun-infinite-canvas\web\src\components\canvas\canvas-size-picker.tsx",
  "basketikun-infinite-canvas\web\src\components\canvas\canvas-config-composer.tsx",
  "basketikun-infinite-canvas\web\src\components\image-settings-panel.tsx",
  "basketikun-infinite-canvas\web\src\components\model-picker.tsx",
  "basketikun-infinite-canvas\web\src\components\image-generation-pending.tsx",
  "tldraw\packages\editor\src\lib\editor\managers\HistoryManager\HistoryManager.ts",
  "tldraw\packages\editor\src\lib\editor\tools\StateNode.ts",
  "tldraw\packages\tldraw\src\lib\tools\SelectTool\childStates\Brushing.ts",
  "tldraw\packages\editor\src\lib\primitives\Box.ts",
  "tldraw\packages\editor\src\lib\editor\managers\SnapManager\SnapManager.ts"
) | ForEach-Object {
  $p = Join-Path $base $_
  if (Test-Path -LiteralPath $p) { "OK      $_" } else { "MISSING $_" }
}
```

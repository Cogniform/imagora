# frontend/ — React SPA（画布工作台 UI）

React 19 + TypeScript + Vite + Tailwind v4 + React Flow（`@xyflow/react`）。栈细节与设计决策见 [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) 第 8 章。

## 本地常用命令（在本目录执行）

```powershell
npm install
npm run dev        # 开发模式（热更新；需后端已启动，见下）
npm run build      # tsc --noEmit + vite build → dist/（git 忽略，由后端服务托管）
npm test           # vitest run（930 用例）
npm run lint       # eslint
npx tsc --noEmit   # 类型检查
```

后端（任意终端，项目根目录）：

```powershell
.\.venv\Scripts\python.exe -m main ui --no-browser --port 7860
```

E2E（画布交互回归，真实浏览器；103 断言）：

```powershell
# 前置：7860 服务已在跑 + playwright 已装
#   .\.venv\Scripts\python.exe -m pip install playwright
#   .\.venv\Scripts\python.exe -m playwright install chromium
.\.venv\Scripts\python.exe ..\frontend\e2e\verify_canvas.py
```

E2E 报 `Executable doesn't exist` 但机器上其实装了别的修订版 Chromium（playwright 升级后旧版不会自动删）时，用垫片跑，不改脚本：

```powershell
# 自动挑 %LOCALAPPDATA%\ms-playwright 下修订号最大的那份
.\.venv\Scripts\python.exe ..\frontend\e2e\_run_with_local_chromium.py ..\frontend\e2e\verify_provider.py
# 或显式指定
$env:IMAGORA_CHROMIUM = 'C:\path\to\chrome.exe'
```

## 该目录特有坑

- **契约双端同步**：后端改接口 → 必须同步 `src/api.ts` + `src/types.ts`（细节见 ARCHITECTURE 7.2）
- **UI 生效需重建**：改完代码 `npm run build`，否则浏览器拿到旧 `dist/`（dist 被 git 忽略，CI 必须自建）
- 动效/样式类统一收敛 `src/index.css`（`@layer components`），组件只引用类名；动画只动 transform/opacity
- 组件不改样式细节（引用类）；样式不写进组件文件（除了 Tailwind utility 类）
- 纯函数模块（src 根 *.ts）必须配同名 `*.test.ts` 单测；新纯函数进纯函数模块，不进组件

## 样式体系（src/index.css）

一处定义、全站共用；改 UI 前先查这里，别在组件里另造一套。规则与约束见 [AGENTS.md](AGENTS.md)。

| 层 | token / 类 | 用途 |
| --- | --- | --- |
| 尺寸阶梯 | `--h-ctl` · `--h-field` · `--h-cta` | 顶栏控件 28 · 表单控件 38 · 主行动 46 |
| 圆角阶梯 | `--r-pill` · `--r-card` · `--r-control` | 胶囊 · 容器 16 · 控件 10 |
| 表面 | `--surface-base` · `--surface-card` · `--surface-panel` · `--surface-float` · `--surface-inset` · `--surface-plain` · `--surface-blur` · `--scrim-*` | **全部由 [surface.ts](src/surface.ts) 算好后注入**，它是容器底色的唯一产地。两个正交的轴：**掺色 `tint`**（这个面是什么色，按角色分配）与**不透明度 `alpha`**（用户的「通透度」滑杆）。老实现的坑：token 写 `hsl(hue 30% 98.4% / a)`，算出来离纯白只有 **2/255**，数学上不可见 —— 看到的「跟色」全来自 alpha 低、页面底色透上来，于是任何需要不透明的面（弹窗、列表行）颜色就消失（同屏出现「左卡是粉的、右台面是白的」）。现改为解出真实 RGB，`tint 0.10` ≈ 离白 **15/255**。两条硬约束（模糊绝不随通透度增长、CSS 里不写「函数内嵌 var()」）见 [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) 9.4 第 7、8 条 |
| 表面分层 | 六档角色（见 [surface.ts](src/surface.ts) 的 `ROLES` / `SURFACE_ROLE_DOC`）：`base` 骨架 → `card` 大面衬底 → `panel` 台面 → `float` 浮层 → `inset` 内嵌；`plain` **中性**（画布主体，看图台面，刻意不跟随主体色） | **新容器先按角色选档**：骨架（顶栏 / 工具栏）`base`，经典三张输入卡 `card`，输出区 / 弹窗外壳 / 生成历史外壳 `panel`，下拉 / 列表行 / 节点卡 / 缩略图 / 最近提示词 `float`，输入框 `inset`。TSX 里挂 `.surface-*` 角色类（**别写 Tailwind 的 `bg-white`** —— 它生成 `background-color`，接不了渐变 token，且写死就不再跟随）。**嵌套不变量：内层不许比外层更透**（否则壁纸从容器中间透出一个洞），默认通透度下 卡片 0.47 < 台面 0.85 < 浮层 0.94。判据与护栏：[surfaceAudit.test.ts](src/surfaceAudit.test.ts) 解析 `index.css` **与全部 `.tsx`**，任何未登记的写死底色 / 硬编码 `blur()` 直接红（豁免要写理由，白名单按「文件+类名」精确匹配，不做全局放行） |
| 通用滑杆 | `.range-field` | 外观弹窗的参数滑杆（通透度用它；与主体色滑杆同形，轨道保持中性） |
| 角落装饰 | `.corner-deco` · `.corner-rings` · `.corner-note` | 编号 / 弧环 / 镜像小字 |
| 最近提示词 | `.recent-prompt` | 结果区空态一键复用的提示词行：单行截断，完整内容走 title 悬停 |
| 行内角标 | `.chip`（`--sm` `--dot` `--brand` `--quiet` `--danger`） | 顶栏 28 · 小号 18 |
| 分段控件 | `.tabs`（模态页签） · `.mode-switch`（顶栏模式） | 同源视觉，尺寸走 `--h-ctl` |
| 模态内容区 | `.modal-body` | 面板是 `max-height` + `overflow:hidden` 的 **flex 列**，内容区靠 `flex: 1 1 auto` + `min-height: 0` 才能被压到内容高度以下并自滚；`scrollbar-gutter: stable` 预留滚动条位、不横向位移。**别改回块级布局**：块级下内容区高度不受约束，`scrollHeight === clientHeight` 永远不触发滚动，超出部分被面板静默裁掉（实测 1100×620：panelClientH 531 / panelScrollH 716 / canScroll false）。原文写的 `--panel-h` 与 `[data-growing]` 早已不存在，2026-10-03 更正 |
| 只读值表 | `.spec-list` + `__row` / `__key` / `__val` / `__src` | 「值 + 来源」两行式排版 |
| 背景材质 | `html[data-bg="…"]` + `.bg-swatches` / `.bg-swatch`（`--accent` `--plain`） | 整页背景材质预设；材质只在 `--bg-color` / `--bg-image` / `--bg-size` 三个变量里声明一次，`html[data-bg]` 与选择器色块**共用同一组声明**；铺法是 `repeat`（纹理通道），**大图不许走这里**（会平铺出接缝）；页面底色只能用 `--accent-hue`（`--color-brand` 在 `.imagora-app` 上，body 读不到） |
| 我的壁纸 | `.imagora-wallpaper` + `__image` | 整页背景层：固定铺满、置底不挡交互；cover 铺底，**不缩放、不重编码**。`filter` 不在 CSS 里写死，由 `wallpaperAdjust.ts` 的 `wallpaperFilter(模糊, 明暗)` 拼成整条内联注入（降噪 + 用户两条滑杆，默认 0/1 即原图）——CSS 嵌 `var()` 会被压缩器丢弃，见 ARCHITECTURE 9.4 第 8 条。**不许用半透明白纱**，白纱会把图提亮变灰，等于第二次「看不清」；有壁纸时 `html[data-wallpaper="on"] body` 让出页面底色、并给所有走表面 token 的容器（`.panel-card` / `.classic-result-panel` / `.studio-header` / `.studio-toolbar` / `.studio-canvas`）内的文字补极淡白色 text-shadow（该规则须排在预设之后才压得住）。**整页背景图只有这一条来源**（内置预设壁纸已移除，只支持用户自己上传） |
| 开关 | `.switch` | 布尔开关（原生 checkbox + 轨道圆钮，状态只走 `:checked`）；画布边界开关用它 |
| 画布边界 | `html[data-canvas-bounds="off"] .studio-canvas` | 关闭时收掉画布边框 / 底色 / 投影与渲染层底色晕，与页面背景融为一体 |
| 滚动条 | `--sb-size` · `--sb-thumb` · `--sb-track` | 全局统管；轨道 transparent = 跟随所在容器底色 |
| 主体色选择 | `.accent-hue` | 外观弹窗**只有一条色相滑杆**（九色预设方块已移除，2026-10-03）：`--r-pill` 轨道 + 自定义 thumb，轨道底色是色相彩虹——那只属于「选色」，其余参数用中性的「通用滑杆」`.range-field`；宽度交给容器（配 `flex-1`），与「卡片通透度」那行逐行对齐。取到的色相写到根元素 `--accent-hue`，背景底色与页面光晕都读它 |
| 画布控件 | `.zoom-slider` · `.studio-canvas .react-flow__minimap` | 缩放滑杆塞进左下角 `<Controls>` 的按钮栈（30px 宽一列）。**垂直 range 用 `writing-mode: vertical-lr` + `direction: rtl`**，不要用 `transform: rotate(90deg)`——旋转后命中区与视觉位置错位（拖动点偏移一个滑杆高度），键盘方向键语义也会反。小地图底色走 `--surface-float` 与浮层同 token，边框/圆角/投影与 Controls 保持一套语言 |
| 下拉浮层 | `.select-list` · `--search` · `--empty` · `--group__title` · `--group__rows` · `--trigger` | 通用下拉（[Select.tsx](src/components/Select.tsx)）：浮层 `createPortal` 到 body 后坐标由 TSX 现算内联给，这里只管外观。底色走 `--surface-float`，与弹窗同一档。搜索框在**列表内部顶部**、不替换触发器。组标题 `position: sticky; top: 0`，底色同样只能取 `--surface-float`（表面系统要求底色唯一产地是 [surface.ts](src/surface.ts)，不能为它单独写不透明色）——代价是粘顶时下方选项会按通透度透上来一点，属既有设计不是缺陷 |
| 生成中占位卡 | `.generation-pending` + `__label` / `__track` / `__bar` | 等待结果的细进度条（画布提示词节点）。**进度只由 `transform: scaleX()` 驱动，绝不给 `width` 加 transition**——width 运动会每帧重排布局，在缩放中的画布上尤其卡；`prefers-reduced-motion: reduce` 时去掉过渡。卡内两层中性色都从 `--color-brand` 掺出来（`color-mix` 加深），因为掺色 token 本身是浅底，直接拿它画细线 / 进度条会看不见 |
| 对齐线 | `.snap-guide` | 拖拽吸附时的辅助线（[CanvasPage.tsx](src/components/CanvasPage.tsx) 画在 React Flow 的 `ViewportPortal` 层里，位置由 TSX 用视口坐标算，随平移缩放自动跟随；这里只给视觉不给尺寸）。颜色取 `--color-brand` 不取中性灰（点阵背景上灰线看不清），`opacity: 0.55` 免得盖过节点。**`pointer-events: none` 必须写死**——它横跨整个视口，可点的话会挡住所有节点拖拽与点击 |
| 连线描边 | `--edge-stroke-idle` · `--edge-stroke-hovered` · `--edge-stroke-selected` | 连线的**唯一取色处**（[edgeStyle.ts](src/edgeStyle.ts) 以 `var(--edge-stroke-*)` 字符串内联到 `<path>`，TS 里不写死颜色，换主体色时连线跟着走）。四态 idle / hovered / selected / dimmed 由 `edgeVisualState()` 判优先级（`selected > hovered > dimmed > idle`），`edgeStyle()` 出宽度/透明度/动画。`index.css` 里 `.react-flow__edge-path` 只留**无内联样式时的兜底**（工作流加载首帧、JS 未接管）；**不要再写 `:hover` 的 stroke** —— 内联优先级更高，那条规则永远不生效，只会误导人去改它。过渡（stroke / stroke-width / opacity 各 120ms）写在这里，因为内联只设值不设 transition，颜色不进过渡就会硬切 |
| 组节点叠卡 | 无公共类（写在 [CanvasNodes.tsx](src/components/CanvasNodes.tsx) 的内联 `style` 里） | 图片组节点背后错位的几张卡，表达「这是一批、里面有 N 张」。纯 CSS（`translate` + `rotate` + 内联 `color-mix` 底色），零状态、零布局计算；层数夹到 `Math.min(n-1, 3)` 张（一个 40 张图的组会渲染 39 层，每层都是独立合成层，缩放时掉帧；夹到 3 张后「3 张以上」在视觉上是同一个意思，精度由数字补）。**z 序靠 DOM 顺序不靠 `z-index`**：叠卡写在 body 之前，后绘制的 body 自然压在上面；父元素没有 `z-index` 就没有层叠上下文，写负 `z-index` 反而会被父元素背景盖住 |

## 文件索引

### 契约与 API（改动需双端同步）

### [types.ts](src/types.ts)
- 职责：前后端契约类型全集（`AppConfig` / `GenerationTaskSnapshot` / `GenerateParams` / `ResultItem` / `AssetEntry` / `WorkflowNode` / `WorkflowEdge` …）
- 被谁依赖：全部 src 与 components
- 改后必测：`npx tsc --noEmit` + `npm test`；后端接口变更必须同步此处（ARCHITECTURE 7.2）

### [api.ts](src/api.ts)
- 职责：后端全部 API 封装（`getConfig` / `uploadRefs` / `submitGenerate` / `fetchTask` / `cancelTask` / `canvasUpload` / `workflowSave` / `generationHistory` / `importHistoryAsset` / `selectFolder` …）；非 2xx 统一抛 `HttpError`，`isHttpError` 供调用方按 `status` 分支（如 409 超预算）；`requestJson` 可选 `validate`：已接的端点（`config` / `history`）在 api 边界校验响应形状，不符即抛（见 [api-guards.ts](src/api-guards.ts)）
- 被谁依赖：`App.tsx`、`CanvasPage.tsx`、`UploadZone.tsx`、`Gallery.tsx`、`HistoryGallery.tsx`、`useGenerationTask.ts`（`isHttpError`）
- 改后必测：`npm test`（若改类型）+ 对应 E2E
- 注意：与 `server.py` 路由一一对应；url 构造走后端返回，不在前端拼路径

### 纯函数模块（零 UI 依赖，全部有单测；改后跑 `npm test`，无需同步文档）

### [workflow.ts](src/workflow.ts)
- 职责：节点构建（`buildImageNode`/`buildPromptNode`/`buildGroupNode`）、动画类（`withEnterAnim`/`stripAnimClasses`）、连线约束（`canConnect` 纯函数：图片→提示词/图片组、图片组→提示词/**图片组**中转聚合、提示词→产出）、`computeCounts`（分组计数**递归**展开组链，**去重后唯一口径** + 重复条目数，防环；**引用计数溯源**——图片数据最终流到的提示词数）、落点阶梯（`staggerCreatePosition`）、`isImageFile`、`canvasEntriesToNodes`
- 被谁依赖：CanvasPage、CanvasNodes、PromptImportModal
- 注意：`CREATE_STAGGER_STEP`/`CREATE_STAGGER_RADIUS` 是落点阶梯常量

### [layout.ts](src/layout.ts)
- 职责：自动整理布局管道——`autoLayout`（全图）、`layoutSelection`（选中局部）、`layoutPromptResults`（结果回流排布）、`nodeSize`
- 被谁依赖：CanvasPage（自动整理/回流）
- 注意：局部整理不得漂移未选中节点（单测锁定）

### [canvasDrop.ts](src/canvasDrop.ts)
- 职责：拖拽意图解析（`resolveDropIntent`）、文件识别（`countDraggedFiles`/`extractImageFiles`）、落点示意文案（`dropChipLabel`）、画布内落点判定（`isInsideRect`）、常量 `CANVAS_DRAG_MIME`
- 被谁依赖：useCanvasDrop.tsx
- 注意：工具栏拖出画布外 = 取消（防错条 ARCHITECTURE 9.2.8）

### [previewZoom.ts](src/previewZoom.ts)
- 职责：预览缩放/平移数学（`clampZoom` / `clampPreviewPan` / `ZOOM_MIN..MAX`）
- 被谁依赖：WorkflowModals.tsx（ZoomModal）
- 注意：数学进纯函数，UI 不重算（ARCHITECTURE 9.5）

### [canvasHistory.ts](src/canvasHistory.ts)
- 职责：撤销/恢复栈（`createCanvasHistory`，limit=50）
- 被谁依赖：CanvasPage（undo/restore）

### [promptImportFormat.ts](src/promptImportFormat.ts)
- 职责：粘贴导入解析（`parsePromptImportFormat` 容错解析）、尺寸映射（`resolveCardSize`）、批量建卡（`buildPromptNodes`）
- 被谁依赖：PromptImportModal、CanvasPage
- 注意：格式规范见 [../docs/README.md](../docs/README.md)；缺漏进 issues 标红，绝不静默猜测

### [recovery.ts](src/recovery.ts)
- 职责：恢复快照归一化（`buildRecoverySnapshot`，剥离动画类/运行期字段）
- 被谁依赖：useCanvasRecovery.ts

### [format.ts](src/format.ts)
- 职责：显示格式化（`formatBytes` / `generatingLabel` / `errMessage`）

### [generationPending.ts](src/generationPending.ts)
- 职责：生成中占位卡的**渐近进度曲线 + 文案轮播**（`pendingProgress` / `pendingProgressScale` / `pendingMessage` / `pendingLabel`；常量 `PENDING_PROGRESS_START = 10` / `PENDING_PROGRESS_CAP = 98` / `PENDING_PROGRESS_TAU = 28` / `PENDING_MESSAGE_SECONDS = 2` / `PENDING_MESSAGES`）
- 被谁依赖：`components/GenerationPending.tsx`（画布提示词卡 running 时的占位区）
- 注意：**是「假进度」不是真进度**——生图接口不回报百分比（排队/推理/回传三段只有头尾可观测），老实显示 `0% → 0% → 100%` 会让人以为卡死。曲线渐近逼近 98% 且永不越过（最后 2% 留给真实完成事件），首秒就从 10% 起步（从 0 起爬会让人怀疑「是不是没开始」）。纯函数：无 `Date.now`、无随机数，同一 tick 恒定同值，非法入参（NaN / ±Infinity / 负数）按 0s 处理绝不产出 `NaN%`。文案轮播间隔与参考实现 basketikun/infinite-canvas（MIT）的 `Math.floor(tick / 2)` 同口径

### [imageOps.ts](src/imageOps.ts)
- 职责：裁剪 / 放大的**几何纯函数 + canvas I/O**。A 层纯几何（`CropRect` 归一化 0~1、`clampCrop` / `moveCrop` / `resizeCrop` / `fitCropToRatio` / `centeredSquareCrop` / `resolveUpscaleSize` / `gcdRatio`，常量 `CROP_MIN_SIZE = 0.06` / `MAX_UPSCALE_LONG_EDGE = 4096`）；B 层 canvas I/O（`loadImage` / `readImageSize` / `cropDataUrl` / `upscaleDataUrl`）
- 注意：**比例换算必须乘框的宽高比**——`normalizedRatio = aspectRatio * boxAspect`（`boxAspect = boxHeight / boxWidth`），漏了这一步「1:1」会裁成长方形。B 层**不写单测**：jsdom 的 `canvas.getContext("2d")` 返回 `null`（不装 canvas npm 包也不许装），只由 A 层纯函数兜底。裁剪与放大全部在前端 canvas 完成，后端零参与（不新增接口、不改 `generate_image` 契约）

### [dataUrlFile.ts](src/dataUrlFile.ts)
- 职责：把前端 canvas 导出的 `data:image/png;base64,...` 转成可上传的 `File`（`dataUrlToFile`），并生成派生图文件名（`derivedImageName`，形如 `crop-红苹果-20261020-130405.png`）
- 被谁依赖：`components/CanvasPage.tsx`（裁剪 / 放大对话框的产出落库）
- 注意：**非法 dataUrl 必须抛错而不是返回空 File** —— 上传 0 字节会在画布上多出一个永远加载失败的红框节点，比直接报错难排查得多。转换独立成模块的理由：`canvasUpload(files: File[])` 只收 `File`，这层 `atob` / `Blob` 不该撒进 1800 行的 CanvasPage.tsx，独立后能单测。支持 base64 与百分号编码两种载荷

### [aspectIcon.ts](src/aspectIcon.ts)
- 职责：尺寸比例图标几何（`aspectIconSize(ratio, long?)` 算空矩形的像素宽高、`ratioFromSizeLabel(label)` 从尺寸标签反解比例）
- 被谁依赖：`components/AspectIcon.tsx` → `components/CanvasNodes.tsx` 的尺寸下拉（`Select` 的 `renderOption`）
- 注意：`ASPECT_ICON_LONG = 24` 是长边上限（再大会撑高下拉行）、`ASPECT_ICON_MIN_SHORT = 10` 是短边下限（再矮看不出是矩形）。**标签解析必须三层回退**：括号内 `a:b` → 裸 `a:b` → `WxH` 宽高比——真实尺寸里有 `1024x1792 (竖版长图)`、`1792x1024 (横版长图)` 两项括号内只有中文方位词，不退回宽高比这两项就没图标

### [canvasGeometry.ts](src/canvasGeometry.ts)
- 职责：视口聚焦 + 分组几何纯函数（移植自 basketikun/infinite-canvas，MIT）。`nodeBounds` / `containsCenter` / `findGroupDropTarget` / `snapNodesIntoGroup` / `collectGroupMemberNodes` / `getGroupWrapRect` / `focusViewportForNode`
- 被谁依赖：`components/CanvasPage.tsx`（「聚焦」控件）
- 注意：`focusViewportForNode` 让节点**最多占视口 60%**（`FOCUS_MAX_VIEWPORT_RATIO`），下方有浮层时按 3:1 把节点往上推；`containsCenter` 判的是**节点中心点**而不是整体包含（整体包含会让大节点永远拖不进小组）；`nodeBounds` 空数组必须返回退化盒 `{0,0,0,0}`，返回 `±Infinity` 会让调用方算出 NaN

### [imageSplit.ts](src/imageSplit.ts)
- 职责：图像切分几何 + canvas 导出。`clampGrid` / `splitCells`（网格）/ `splitCellsByLines`（自定义切割线）/ `splitCellCount` / `splitOutputName` / `splitDataUrl`
- 被谁依赖：`components/ImageSplitDialog.tsx`
- 注意：格子坐标**用 `col / cols` 直算不要累加**（累加会漂，最后几格对不上 1）；1×1 是合法输入（等于不切），不要强行抬到 2；`splitDataUrl` 必须**静态 import** `cropDataUrl`（动态 + 静态混合导入会让 vite 放弃分块并告警）

### [promptRefs.ts](src/promptRefs.ts)
- 职责：提示词里的 `@` 引用解析（`parsePromptRefs` 切 token、`resolvePromptRefs` 对照候选池解析成 `all` / `explicit` / `invalid`、`stripPromptRefs` 剥标记、`promptRefInsertion` 生成插入文本）
- 被谁依赖：`workflow.ts` 的 `collectPromptRefImages`、`components/CanvasPage.tsx` 的 `runNodeInternal`
- 注意：**候选池只含入边可达的图片**——引用一张没连线的图等于绕过画布连线直接传图，不允许。三条语义必须记住：零 token 判 `all`（保持旧的「沿入边全收集」行为）、全对上判 `explicit`（按出现顺序去重）、**有对不上判 `invalid` 且必须中止提交**（不能回退到全收集：用户明确点了三张，静默改成七张比报错更糟）。名字匹配**精确区分大小写**（图片名是文件名，`Cat.png` 与 `cat.png` 是两张图），两边 trim + 折叠空白。`@` 前必须是行首 / 空白 / 标点，否则 `user@example.com` 会被当成引用。**发给上游的 prompt 必须是 `stripPromptRefs()` 的结果**——模型不认识 `@{…}` 这种标记

### [maskBrush.ts](src/maskBrush.ts)
- 职责：蒙版笔刷的几何纯函数（`appendPoint` 节流加点、`interpolatePoints` 按像素距离补点、`hasPaint` / `isMaskEmpty` 判空、`maskBoundingBox` 算包围盒、`clampBrushSize` / `brushRadiusPx` 换算笔刷半径）
- 被谁依赖：`components/MaskBrushDialog.tsx`
- 注意：**坐标一律归一化 0..1**（canvas 显示尺寸随窗口变，存像素一缩放就错位）；**`size` 是占图片短边的比例而不是像素**（4K 图与 512 图视觉粗细才一致）；`appendPoint` 节流命中时**返回原数组引用**——`pointermove` 每秒上百次，不节流数组会涨到几十万点，每次 setState 都全量重渲染；`interpolatePoints` 的距离在**像素空间**量（归一化空间在 16:9 图上横向间距算大、竖向算小，笔画会变成虚线）；`hasPaint` 只认 paint 笔画（只擦不涂等于没涂——上游会收到「整图都要重绘」的空蒙版，又慢又花钱）

### [customValue.ts](src/customValue.ts)
- 职责：`Select` 自由输入的纯函数层（`normalizeCustomValue` 归一化、`isKnownValue` 判重、`mergeCustomOption` 把当前值合进选项清单、`validateCustomValue` 校验）
- 被谁依赖：`components/Select.tsx`（`allowCustom`）、`components/CanvasNodes.tsx`（尺寸下拉）
- 注意：归一化**只折空白不折大小写**（模型 ID 与尺寸是上游字面标识，替用户「纠正」大小写等于发错请求）；**不做格式校验**（不同上游格式差得远，前端一旦猜错格式就会拦掉合法值——那比放过错值更糟，错值上游会明确报错，被拦的值用户连试的机会都没有），只挡空与超长；`mergeCustomOption` 未变更时返回**入参数组本身**（引用相等），否则每次渲染都返回新数组会让 `Select` 内部的 `visible` / `groups` 连锁重算

### [contextMenu.ts](src/contextMenu.ts)
- 职责：节点右键菜单的**内容与定位纯函数**（`buildNodeMenu` 按节点类型出动作清单、`clampMenuPosition` 四边夹紧、`menuHeight` 按项数算高度、`isMenuDismissKey` 判关闭键）
- 被谁依赖：`components/NodeContextMenu.tsx`、`components/CanvasPage.tsx`
- 注意：图片节点给裁剪/放大/切分/替换，提示词节点给运行/复制提示词；`selectedCount > 1` 才置顶「删除选中」并加分隔线；图片没有 url 时动作**保留但置 disabled**（直接消失会让菜单高度跳动、用户找不到上次点过的位置）；`MENU_WIDTH = 200` / `MENU_ITEM_HEIGHT = 28` 是定位计算与 CSS 共用的口径，改一处必须改两处

### [edgeStyle.ts](src/edgeStyle.ts)
- 职责：连线四态样式纯函数（`edgeVisualState` 判状态、`edgeStyle` 出 `{stroke, strokeWidth, opacity, animated}`、`dimmedEdgeIds` 算要降权的连线）
- 被谁依赖：`components/CanvasPage.tsx` 的连线样式 effect
- 注意：优先级 **`selected > hovered > dimmed > idle`**（选中的线同时被鼠标悬停时不该掉回 hover 态）；`dimmedEdgeIds` 只在**两端都不在选中集**时降权，且选中集为空返回 `[]` 而不是「全部淡出」——否则一选中任何东西，满屏连线就集体变淡；`dimmed` 态把 `animated` 关掉（淡线还跑流动动画比不降权更吵）。描边色一律返回 `var(--edge-stroke-*)` 字符串，**不在 TS 里写死颜色**（换主体色时连线要跟着走）

### [snapGuide.ts](src/snapGuide.ts)
- 职责：拖拽吸附纯函数。`snapToNeighbors(moving, others, threshold?)` 按左/中/右与上/中/下三对齐线找最近目标；`snapToGrid(moving, step?)` 退化为 8px 栅格
- 被谁依赖：`snapDrag.ts`
- 注意：x 与 y **独立决策**（可能只吸一个轴）；阈值比较用严格 `<`；**没有可吸目标时原样返回，绝不偷偷退回网格**（否则「关掉吸附」和「没邻居」会变成两套行为）；非法入参（NaN / Infinity / step<=0）安全退化不抛错——这个函数每帧拖拽都跑，抛错会让整个画布白屏

### [snapDrag.ts](src/snapDrag.ts)
- 职责：吸附**接线层**——把 `snapGuide` 的纯函数结果翻译成 React Flow 的 `NodeChange[]`（`snapPositionChanges`），并算出要画的对齐线
- 被谁依赖：`components/CanvasPage.tsx` 的 `onNodesChange`
- 注意：吸附位移必须**同时写 `position` 与 `positionAbsolute`**（只写一个节点会瞬移回原位）；多选拖拽按主节点算位移再整体平移，不能各算各的；对齐线只在拖拽帧产出，松手帧返回空数组

### [modelIcon.ts](src/modelIcon.ts)
- 职责：从模型 ID 猜品牌（`modelBrand`）、品牌字形（`MODEL_BRAND_GLYPH`）、中文名（`modelBrandLabel`）
- 被谁依赖：`components/ModelIcon.tsx` → `components/ProviderModal.tsx` 的模型下拉
- 注意：**第一步必须调 `foldModelId()` 做全角连字符归一化**（中转站把 `gpt‑image‑2.5` 登记成 U+2011，不折叠就认不出 `gpt`）；匹配顺序有讲究（`claude` 先于 `openai`）；不支持 `mj` 两字母简写——裸 `includes("mj")` 会把 `mjpeg` 之类误判，成本高于收益，只保留 `midjourney`

### [cost.ts](src/cost.ts)
- 职责：成本展示纯函数（`formatMoney` / `formatRate` / `formatSeconds` / `budgetSummary` / `statRows`）
- 被谁依赖：CostBoard.tsx
- 注意：费用口径由后端给出（`/api/history/stats`、`/api/budget/check`），前端只做显示，不重算价格规则

- 被谁依赖：HistoryGallery.tsx
- 注意：图生图记录参考图找不回时**明确跳过并报因**（`RERUN_LOST_REFS`），绝不静默降级成文生图

### [logPath.ts](src/logPath.ts)
- 职责：日志文本路径词条解析（`splitLogPath`：本机绝对路径段 → 可点击复制词条；正反斜杠/单引号包裹/一行多路径）
- 被谁依赖：LogLine.tsx（经典表单日志区）
- 注意：后端生成消息的保存路径统一为绝对路径（server.py run_generation），前端解析展示，不再相对化

### [accent.ts](src/accent.ts)
- 职责：主体色（`accentFromHue` / `accentForWindow` / `hueForWindow`，黄金角或自定义色相 → 覆盖 `--color-brand`；`readAccentHue` / `saveAccentHue` 存自定义色相，`ACCENT_PRESETS` 是九色预设）
- 被谁依赖：`App.tsx`（顶栏入口 / 外观弹窗 / 根元素 `--accent-hue`）
- 注意：`accentForWindow` **不做色相归一**，越界编号（如 0）保留负色相——该行为由 `accent.test.ts` 钉住，改它会破坏既有契约

### [backgroundPreset.ts](src/backgroundPreset.ts)
- 职责：背景预设的纯数据与读写（`BACKGROUND_PRESETS` 两项 = 跟随主体色 / 纯白、`readBackgroundPreset` / `saveBackgroundPreset`、`isBackgroundPresetId`）；底色由 [index.css](src/index.css) 按 `html[data-bg]` 出。**不涉及图片**：整页背景图只走 `wallpaperStore` 的用户自选图（IndexedDB，不入库）
- 被谁依赖：`App.tsx`（外观弹窗的色块行 + 根元素 `html[data-bg]`）
- 注意：**只有浅色系**，且只有两项（跟随主体色 / 纯白）。深色的「暗房 / 蓝图」不在其中——它们要连顶栏、卡片、文字、按钮一起换深色，属独立工程；非法/空白存储值一律回落默认「跟随主体色」

### [configWrite 相关](src/api.ts)
- `getConfig()`：取配置并**同时取出写配置令牌**（令牌在 `GET /api/config` 的响应头里下发，存内存不写 localStorage）
- `writeConfig()`：写 `.env`（带 `X-Config-Token`）；409 = 文件被外部修改，不静默覆盖
- `clearConfigSecret()`：清空密钥（独立出口，必须 `confirm: true`）
- 契约见 [../docs/config-write-api-design.md](../docs/config-write-api-design.md)

### [rankByName.ts](src/rankByName.ts)
- 职责：下拉搜索的排序算法（`rankByName(items, rawQuery)`）——有序子序列匹配 + 边界加分（`boundaryBonus` 权重 8：匹配点落在 `-_. /` 或词首即加分）+ 对齐度 DP（相邻 +4、跳跃 `+1-index`、行首 `-index`），三级排序 = 前缀命中优先 → 分数降序 → 原序升序
- 被谁依赖：`components/Select.tsx`（`searchable` 时的过滤与排序）
- 注意：**不是 substring 过滤**。模型 ID 动辄 `gpt-image-2.5-flare`，用户打 `flare` 或 `gi25` 都要命中，substring 做不到。比对前先走 `foldModelId()` 再 `toLowerCase()`——中转站会把 `gpt‑image‑2.5` 登记成 U+2011 连字符，用户半角输入不折叠永远搜不到（`foldModelId` 取自 [apiCatalog.ts](src/apiCatalog.ts)，本模块不复制第二份）。空 query 直接返回**同一数组引用**（零开销，单测用 `toBe` 钉住）

### [optionGroups.ts](src/optionGroups.ts)
- 职责：把扁平选项按 `group: {id, label}` 归组（`groupOptions(items)` → `OptionGroup<T>[]`）；组间按 id 首次出现顺序、组内保持源顺序、行就是入参对象本身（不拷贝）
- 被谁依赖：`components/Select.tsx`
- 注意：无 `group` 的项归入 id `""` 的兜底组——**全部无分组时返回单个组且标题为空串**（渲染层据此不出标题）；混合分组时兜底组**排最后**。分组只影响渲染，不影响键盘导航（`activeIndex` 始终是扁平可见列表下标，上下键跨组连续、不会卡在标题上）

### [popupLayer.ts](src/popupLayer.ts)
- 职责：**浮层计数**——`pushPopup` / `popPopup` / `hasOpenPopup` / `resetPopupCount`
- 解决的问题：`.modal-shell` 的 Esc 监听挂在 document 的 **capture 阶段**，比浮层自己的 `onKeyDown` 先跑。不判浮层的话，展开下拉时按 Esc 会**连弹窗一起关掉** —— 用户的手感是「我只想收起下拉，结果正在填的窗口没了」。`Select` 展开时 push、收起时 pop，`ModalShell` 关窗前先问 `hasOpenPopup()`，因此需要两次 Esc（先收浮层、再关弹窗）
- 可计数：多余 `pop` 做了负数保护，否则 `hasOpenPopup()` 会永远为真、弹窗再也关不掉
- 改后跑 `npm test`

### [surface.ts](src/surface.ts)
- 职责：卡片表面材质——`surfaceTokens(色相, 通透度)` 产出 `--surface-card` / `--surface-panel` / `--field-bg` 三个字面量 CSS 值 + `--surface-blur`；`blurFor` 是模糊半径的唯一出处（**当前恒返回 `none`**：壁纸要原样清晰；函数保留只为「由 JS 注入整条字面量」这条路不破）；`WALLPAPER_IMAGE_FILTER` 是壁纸降噪滤镜常量（由 `wallpaperAdjust.ts` 的 `wallpaperFilter` 消费，CSS 侧不再重复写值）；`--surface-panel` 的消费方是 `.modal-panel`（弹窗与卡片共用一套材质 token，2026-10-03 起不再写死背景色）；`FIELD_ALPHA_FLOOR` 是输入框不透明度底线（0.25）；`readSurfaceTransparency` / `saveSurfaceTransparency` 存通透度（0 最实，1 最透）
- 被谁依赖：`App.tsx`（外观弹窗的通透度滑杆 + 根节点内联注入）
- 注意：**故意在 JS 里拼字符串而不是在 CSS 里用变量**——压缩器会丢弃「函数内嵌 var()」的声明；拉到最透仍留约 0.27 的白，保证文字压得住


### [wallpaperAdjust.ts](src/wallpaperAdjust.ts)
- 职责：壁纸自身的模糊（0~24px）与明暗（0.5~1.5）两条**显式**参数——钳制、默认值、`localStorage` 读写，以及 `wallpaperFilter()` 把「固定降噪 + 用户两项」拼成**整条** filter 字面量
- 与「卡片通透度」完全解耦：那档管卡片自己有多透，这两条管壁纸长什么样，可同时生效；两者都默认取原图/不模糊
- 判据：**可读性由谁决定**——系统自动改（随通透度糊）不做，用户手动拉才做，详见 ARCHITECTURE 9.4 第 7 条
### [wallpaperStore.ts](src/wallpaperStore.ts)
- 职责：我的壁纸存储层，**只存图**——`readWallpaperImage` / `saveWallpaperImage` / `clearWallpaperImage`，Blob 直存 IndexedDB（不把 base64 塞 localStorage）
- 被谁依赖：`App.tsx`（外观弹窗与整页铺底；启动时调一次 `purgeLegacyWallpaperSettings`）
- 注意：存储不可用一律安静降级（读 → `null`、写 → `false`），不抛错、不影响生图主流程。**不做任何图像处理**（按原图铺满）；曾有「模糊/压暗/缩放」三个参数、亮度取样与缩图档位（`wallpaper.ts` 纯函数模块），维护者要求「就正常的原图就行了」后已整套删除。那版留在浏览器里的 localStorage 键由 `purgeLegacyWallpaperSettings` 一次性收走（**只删该键、绝不 `clear()`**，现存设置一个不动）——这段是过渡代码，等老用户升级过一轮即可整体删除，改哪删哪写在函数注释里

### [canvasBounds.ts](src/canvasBounds.ts)
- 职责：画布边界开关偏好（`readCanvasBounds` / `saveCanvasBounds`，localStorage）
- 被谁依赖：`App.tsx`（外观弹窗），样式落点 `html[data-canvas-bounds]`
- 注意：默认 `true`（显示边框 + 底色，保持既有观感），只有用户显式关掉才进「融为一体」档

### [minimapVisible.ts](src/minimapVisible.ts)
- 职责：画布**小地图开关**与**缩放滑杆刻度**两件偏好（`readMinimapVisible` / `saveMinimapVisible`；`zoomToSliderPercent` / `sliderPercentToZoom` / `clampSliderPercent` / `readZoomSliderPercent` / `saveZoomSliderPercent`）
- 被谁依赖：`components/CanvasPage.tsx`（`<MiniMap>` 显隐 + `<Controls>` 里的缩放滑杆）
- 注意：小地图默认 **`false`**——它固定占画布右下角 160×110，卡片少时是纯负担，用户显式打开才落盘。滑杆**用直接百分比 `p = 100z` 而不是对数刻度**：滑杆行程 5%~200% 与缩放区间 0.05~2 的跨度都正好是 40 倍，端点对齐后对数映射在数学上精确退化为直线（`ln p = ln 100 + ln z` 系数恰为 1），写一套 log 运算只是把同一根直线算两遍还多出浮点误差；直接百分比另有两个好处——读数就是用户看到的缩放百分比、100% 天然落在行程 48.7% 处接近居中。`ZOOM_SLIDER_MIN_PERCENT = 5` / `ZOOM_SLIDER_MAX_PERCENT = 200` **刻意写成模块常量而不是函数参数**，与 `CanvasPage.tsx` 的 ReactFlow `minZoom={0.05}` / `maxZoom={2}` 对齐；做成参数两处数字必然漂移（滑杆拖到底但视口还在缩是最难查的一类 bug）。两个换算函数互为反函数（往返误差 < 1e-9，单测钉住）；非法输入（NaN / ±Infinity）一律夹到端点而不抛错——滑杆是受控组件，抛错会让整个画布白屏

### [recentPrompts.ts](src/recentPrompts.ts)
- 职责：最近提示词挑选（`pickRecentPrompts(items, limit = 5, prefixLen = 40)`）——从生成历史里挑可直接复用的条目：按前 `prefixLen` 字归并近似版本并保留最新那条、丢弃空白与缺失项、取满 `limit` 即停；只做挑选不截断长度（视觉截断归展示层）
- 被谁依赖：`App.tsx`（拉到历史后算出列表并存进 state）；再以 `recentPrompts` prop 经 `components/ResultPanel.tsx` 转给 `components/Gallery.tsx` 渲染成空态那一行（两个组件本身不 import 本模块）
- 注意：**入参已按时间倒序**（`/api/history` 的返回顺序），本函数不再排序；归并键先把连续空白归一，所以只差空格数量的两条算一条 —— 精确去重会让列表出现多条肉眼无法分辨的项。该口径由 `recentPrompts.test.ts` 钉住

### [windowInherit.ts](src/windowInherit.ts)
- 职责：新窗口继承（`saveInheritedState` / `readInheritedState` / `clearInheritedState`，sessionStorage）

### [api-guards.ts](src/api-guards.ts)
- 职责：`/api` 响应形状守卫（`isAppConfig` / `isHistoryResponse`）；只校验消费面读的字段、多出的键放行，由 `api.ts` 的 `requestJson(url, init, validate?)` 消费 —— 形状不符在 api 边界抛错（含端点路径），不让坏数据流到渲染层
- 注意：逐端点增量接入；未接的端点行为与以往逐字一致

### [brand/logo.ts](src/brand/logo.ts)
- 职责：品牌图形的**唯一取处**——形状只写在 [brand/logo.svg](src/brand/logo.svg) 一份里，本模块用 `?raw` 在构建期内联，导出 `BRAND_LOGO_PATH` / `BRAND_LOGO_VIEWBOX`（顶栏 `<svg>` 用）与 `brandLogoSvg(fill)`（动态 favicon 用：只换根元素 `fill`，颜色仍按窗口走）
- 被谁依赖：`App.tsx`（顶栏品牌区 + 标签页图标注入）；`scripts/desktop/make_icon.py` 也读同一份 svg 生成桌面图标
- 注意：`logo.svg` 必须**只有一处 `fill`** 且带 `<path d="…">` 与 `viewBox`（`brand/logo.test.ts` 钉着），取不到就在 import 期抛错，不静默渲染成空白图标。**别再抄第二份形状**：历史上手抄过三份（svg + 顶栏 + favicon 模板），改一次要动三处且没有任何校验

### Hooks（组件级逻辑）

### [useCanvasDrop.tsx](src/useCanvasDrop.tsx)
- 职责：拖放接线（落点示意显隐/定位/文案、window 兜底守卫、工作区四事件）；提示词卡片/图片组拖出画布外松手取消
- 改后必测：`npm test` + E2E（verify_canvas.py 第 8-13 段）

### [useGenerationTask.ts](src/useGenerationTask.ts)
- 职责：生成任务轮询/取消（`useGenerationTask`）；导出终态常量 `TERMINAL_STATUSES`（轮询停止口径，勿在别处内联重复列表）
- 注意：返回稳定成员引用（hook 单测锁定）

### [useCanvasRecovery.ts](src/useCanvasRecovery.ts)
- 职责：恢复快照自动保存/恢复接线

### [useImageEditorViewport.ts](src/useImageEditorViewport.ts)
- 职责：图片编辑器视口（`useImageEditorViewport(image, open)`）——缩放（1×~4×，步进 1.2）、以指针为锚点、空格/中键拖拽平移、`ResizeObserver` 跟随容器尺寸。返回 `viewportRef`（回调 ref）/ `stageRef` / `zoom` / `isPanning` / `spacePressed` / `scrollClassName` / `panHandlers` / `canZoomIn` / `canZoomOut` / `imageScale` / `zoomIn` / `zoomOut` / `resetZoom` / `contentStyle` / `stageStyle` / `mediaStyle`；纯函数部分（`fitImageToViewport` / `imageEditorContentSize` / `imageEditorAnchorAt` / `imageEditorAnchorScroll` / `isImageEditorPanGesture` 等）也全部导出可单测
- 被谁依赖：`components/ImageCropDialog.tsx`
- 注意：**两段式缩放**——`setZoomAround` 只记锚点再 setState，真正反算 `scrollLeft/scrollTop` 在 `useLayoutEffect` 里做（同步 setState 时拿不到新尺寸，会跳一格）；滚轮必须 `{ passive: false }` 且 `preventDefault + stopPropagation`，否则画布跟着一起缩放；空格拖拽监听挂 window capture 阶段且先 `document.activeElement.blur()`，否则输入框里打空格会触发平移。移植自 basketikun/infinite-canvas（MIT）的 `use-image-editor-viewport.ts`

### [useImageZoom.ts](src/useImageZoom.ts)
- 职责：图片「单击开原图 / 双击放大预览」时序区分（`useImageZoom`，250ms 延时）
- 被谁依赖：Gallery.tsx（经典表单结果图）、HistoryGallery.tsx（生产历史）
- 注意：双击第二击必须取消未决的单击开窗（防连开两个新标签，单测锁定）

### 组件（components/；改后跑 `npm test` + E2E）

- [`CanvasPage.tsx`](src/components/CanvasPage.tsx) — 无限画布主页面（React Flow 集成、选中操作栏、操作帮助弹窗、历史面板入口、**小地图显隐** + **缩放滑杆**（塞在左下角 `<Controls>` 按钮栈里，偏好见 [minimapVisible.ts](src/minimapVisible.ts)）+ **吸附开关** + **聚焦控件**（[canvasGeometry.ts](src/canvasGeometry.ts) 的 `focusViewportForNode`，让选中内容最多占视口 60%）；拖拽时经 [snapDrag.ts](src/snapDrag.ts) 吸到邻居边缘并画对齐线；**连线悬停高亮 / 选中降权**（[edgeStyle.ts](src/edgeStyle.ts)，选中一条线后其余连线淡出，避免满屏线里找不到刚点的那条）+ 选中连线后 `Delete` / `Backspace` 删除；**节点右键菜单**（[NodeContextMenu.tsx](src/components/NodeContextMenu.tsx)，动作与定位由 [contextMenu.ts](src/contextMenu.ts) 给出）；**蒙版局部重绘**入口）
- [`CanvasNodes.tsx`](src/components/CanvasNodes.tsx) — 三类节点（图片/图片组/提示词卡）+ `ActionButton`（nodrag 胶囊按钮）；`StatusLight` 状态灯 running 恒定「生成中」，`ElapsedText` 秒数文字以 `startedAtMs` 自计时（防逐秒重渲染，见 ARCHITECTURE 5.3）。图片节点的悬停操作栏七个按钮：预览大图 / **裁剪图片** / **放大图片** / **切分图片** / **蒙版重绘** / 替换图片 / 删除图片；图片带蒙版时左侧出现可点击的「清除蒙版」角标（蒙版会跟着图走、对后续每次生成都生效，用户会忘掉自己设过，角标本身就是撤销入口）。**操作栏是 `opacity-0 pointer-events-none`，不是 `invisible`** —— `visibility:hidden` 会把按钮从无障碍树摘掉（E2E 的 `get_by_role` 与读屏器都查不到）；用 `pointer-events` 拦命中测试才既不挡画布又能被查到。悬停区用 `pl-2` 内边距而不是 `ml-2` 外边距，否则鼠标从节点移向按钮途中会掉出 `.group` 而闪断。图片组节点用**叠卡**（`Math.min(n-1, 3)` 张错位背景卡）表达「这是一批」，纯 CSS 零状态。尺寸下拉经 `Select` 的 `renderOption` 挂 [AspectIcon.tsx](src/components/AspectIcon.tsx) 比例图标，并开 `searchable` + `allowCustom`（清单只有固定几档，而上游常认清单外的尺寸，如 `1280x720`；选项清单用 `mergeCustomOption` 把当前值合进去，否则选过自定义值后触发器会退化成「请选择」）
- [`AspectIcon.tsx`](src/components/AspectIcon.tsx) — 按比例画一个空心矩形（图形代替文字表达「1:1 / 16:9」），几何算 [aspectIcon.ts](src/aspectIcon.ts)。颜色只用 `currentColor`（写死 hex 会被 `surfaceAudit.test.ts` 拦下）
- [`ModelIcon.tsx`](src/components/ModelIcon.tsx) — 模型品牌小徽标（OpenAI / Gemini / 通义…），品牌识别在 [modelIcon.ts](src/modelIcon.ts)。**未知品牌也渲染**（显示 `·`）而不是返回 null —— 列表里突然少一个图标会显得错位。底色用 `color-mix(in srgb, currentColor 12%, transparent)`，不写死颜色
- [`ImageSplitDialog.tsx`](src/components/ImageSplitDialog.tsx) — 切分对话框：五个预设（2×2 / 2×3 / 3×2 / 3×3 / 4×4）+ 行列手填（即时夹到 1~8）、网格预览（在图片上铺 `grid` 格子而不是画 canvas）、文件名预览、1×1 时禁用确认（等于不切）。几何与导出在 [imageSplit.ts](src/imageSplit.ts)
- [`ImageCropDialog.tsx`](src/components/ImageCropDialog.tsx) — 裁剪对话框（`ModalShell` + [useImageEditorViewport.ts](src/useImageEditorViewport.ts) 做视口 + [imageOps.ts](src/imageOps.ts) 做几何）：八向手柄拖拽、比例预设（自由 / 1:1 / 4:3 / 3:4 / 16:9 / 9:16）、实时像素读数、确认后回传 dataUrl 给上层落库。**遮罩用 `boxShadow: 0 0 0 9999px` 而不是四块 div** —— 四块只能盖住 stage 层（图片宽度），盖不满视口留白，且 spread 型阴影不参与布局
- [`ImageUpscaleDialog.tsx`](src/components/ImageUpscaleDialog.tsx) — 放大对话框：目标长边预设（1024 / 2048 / 3072 / 4096，默认原长边 ×2 夹在区间内）+ 自定义、算法选择（high / bilinear / nearest）、换算文案（`原 1024×768 → 2048×1536（2.0×）· 显示比例 4:3`）。目标小于原图长边时只提示不禁用（缩小也是合法诉求）。**处理期间用户仍可取消**，卸载后用 `aliveRef` 拦住迟到的结果，避免窗都关了 `onConfirm` 还被调一次
- [`WorkflowModals.tsx`](src/components/WorkflowModals.tsx) — 保存/加载/导入弹窗 + **`ZoomModal` 全屏预览**（createPortal 到 body，画布 / 经典表单 / 生产历史共用；Portal 根截停 click 冒泡，防误关外层宿主遮罩）
- [`ResultPanel.tsx`](src/components/ResultPanel.tsx) — 经典表单结果区 5 态容器：主图形层 absolute 居中钉死 + 副信息层底部独立生长（行增减不挤动主图形）；切换交叉淡化（swap-in/swap-out，旧层保留 200ms）；排队/生成中/失败/已取消/透传 Gallery；生成中图标本体按自身颜色呼吸光（`icon-breathe`）
- [`Gallery.tsx`](src/components/Gallery.tsx) — 经典表单结果图（双击放大 / 单击新窗口开原图，250ms 区分，走 useImageZoom；被 ResultPanel 透传）
- [`LogLine.tsx`](src/components/LogLine.tsx) — 日志单行：文本里的本机绝对路径拆成可点击复制词条（CopyChip），其余保持文本；行动画 log-line
- [`CopyChip.tsx`](src/components/CopyChip.tsx) — 路径词条：点击复制完整路径（`navigator.clipboard`），复制后边框/底色高亮反馈 1.2s（不换文字，避免宽度跳动）
- [`UploadZone.tsx`](src/components/UploadZone.tsx) — 参考图上传区（缩略图单击不触发文件选择器、双击放大）
- [`HistoryGallery.tsx`](src/components/HistoryGallery.tsx) — 生成历史面板：**分页滚动加载**（首屏 60 条，滚动接近底部 600px 内自动追加、未占满视口自动续拉，按钮仅兜底，DOM 恒在单页数量级）两栏网格卡片（160px 结果图 | 提示词 2 行截断随容器宽 | 56px 参考图换行 | 按钮底部对齐横排）；提示词超 2 行时悬浮浮层补全（仅截断弹、宽固定 80vw 水平居中左/右各留 10vw、高随行数自动长、垂直跟随鼠标、无滚动条）；搜索/状态筛选重置到第 0 页；双击放大预览 / 单击新窗口开原图 / 导入当前画布；每行按钮与成败无关（复制提示词 / 打开目录 / 导入当前画布）；参考图已丢失的失败记录只给一条条数提示（无法还原，无重跑入口）
- [`CostBoard.tsx`](src/components/CostBoard.tsx) — 成本看板条（历史面板顶部）：今日/累计花费、成功率、失败数、成功平均耗时、按尺寸分布 + 本机预算（日预算 / 单次上限，0 = 不限）编辑保存；数据来自 `/api/history/stats`，保存走 `/api/budget`
- [`PromptImportModal.tsx`](src/components/PromptImportModal.tsx) — 粘贴导入弹窗（实时解析 + 问题标红）
- [`ProviderModal.tsx`](src/components/ProviderModal.tsx) — **添加第三方供应商**弹窗（顶栏插头图标入口）：Provider ID（前端先按 `^[a-z][a-z0-9_-]{0,31}$` 即时提示，服务端仍会再校验）/ 显示名称 / API 地址 / API 协议（`openai` 标准 `/v1` · `ark` 已含版本号 · `custom` 手填路径）/ API 密钥（只进 `.env`）/ 默认模型（「获取可用模型」探 `GET {base}/models`，**探到即从文本框切成下拉**并选第一个，点「手填」可切回自由输入 —— 两种都要留：下拉解决「探到 7 个却看不见」，手填解决「清单外的 ID」）/ 「创建后立即切换」（默认不勾：新建来源只是目录多一条，换 profile 属「改了要重启」）。全部字段统一走 [`Field.tsx`](src/components/Field.tsx)（label + 控件 + 单行消息槽位），模型下拉开 `searchable`（中转站常报出几十上百个 ID，不给搜索只能盲滚）。**别用 `<datalist>`**：它只提供输入建议、会按已输入内容过滤，原生渲染还随浏览器变，曾导致「上游 7 个模型只显示 2 个」
- [`MaskBrushDialog.tsx`](src/components/MaskBrushDialog.tsx) — 蒙版笔刷对话框（局部重绘）：原图上涂出要重绘的区域（画笔 / 橡皮 / 粗细滑杆 / 清除），确认后回传**与原图同尺寸**的 PNG data URL。几何在 [maskBrush.ts](src/maskBrush.ts)。**alpha 语义按 OpenAI images/edits 口径：透明像素 = 要重绘的区域，不透明 = 保持原样**——导出时先铺满不透明白再让涂过的笔画走 `destination-out` 抠洞，写反了就是「用户圈哪块、上游偏偏不重绘哪块」，而且错得很安静（图能出来，只是没按预期改）。**空蒙版时确认按钮禁用**：空蒙版等于整图重绘，又慢又白花钱。测试用 `vi.spyOn(HTMLCanvasElement.prototype, "toDataURL")`（jsdom 无 2D context）
- [`NodeContextMenu.tsx`](src/components/NodeContextMenu.tsx) — 节点右键菜单（`createPortal` 到 body、`position: fixed`、`z-index: 1000`）：位置由 [contextMenu.ts](src/contextMenu.ts) 现算，`useLayoutEffect` 量真实高度后再夹一次（贴底右键不出屏）。挂载时 `pushPopup()` 让 Esc 先收菜单而不穿透弹窗。**禁用项用 `aria-disabled` 而不是原生 `disabled`** —— 原生 disabled 会让键盘焦点跳过它，菜单里的项位置一变用户就找不到。外观复用 `.select-list` / `.select-option`（浮层同一档材质），不新增 CSS 类
- [`FolderPicker.tsx`](src/components/FolderPicker.tsx) — 目录选择
- [`Select.tsx`](src/components/Select.tsx) — 通用下拉框（`options` / `value` / `onChange`，可选 `searchable` + `emptyLabel` + `option.group` 分组）。**展开列表 createPortal 到 body**：此前就地 absolute 定位会被弹窗的 `overflow:hidden` / `overflow-y:auto` 裁掉，表现为「下拉展开后底部几项看不见」。坐标按触发器 `getBoundingClientRect` 现算，展开期间监听 scroll / resize / `ResizeObserver` 重算（后者覆盖「窗口没变但触发器被挤窄」），下方空间不足自动翻到上方并据此限高。搜索框在**列表内部**顶部（不替换触发器，避免「已选值」与「搜索词」抢同一块区域），过滤走 `rankByName`。完整键盘导航（↑↓ Home End Enter Esc Space）、`aria-activedescendant` / `aria-selected` / `aria-controls`，展开时 `pushPopup()` 让 Esc 先收下拉再关弹窗（见 [popupLayer.ts](src/popupLayer.ts)）。无障碍属性由 `Field` 经 `cloneElement` 注入后**转发到触发器按钮**——按钮才是 `label` 的控件。可选 `allowCustom` + `onCreateCustom` 允许输入清单外的值（**必须同时开 `searchable`**——没有搜索框就没有输入入口）；精确命中已有项时走正常 `onChange`，校验不过时 Enter **什么都不做**（不回落选中模糊命中的那一行，否则用户打的 ID 会被悄悄换掉）；自定义行放在 `<ul role="listbox">` **之外**（ARIA 要求 listbox 只含 option/group）
- [`Field.tsx`](src/components/Field.tsx) — 表单字段壳（`id` / `label` / `hint` / `error` / `action` / `children`）：`hint` 与 `error` **共用同一个消息槽位** `<p id="{id}-message">`，invalid 时 error 顶掉 hint，任何时刻至多一行提示；`aria-describedby` 只在有内容时拼 id（无内容传 `undefined` 而非空串）、`aria-invalid` 用条件展开（`exactOptionalPropertyTypes` 下不能写 `= {undefined}`）。控件本体由调用方渲染，`Field` 用 `cloneElement` 注入 aria（非单个元素时降级为原样渲染）。移植自 DeepSeek Harness（MIT）的 `SettingsValueField`
- [`GenerationPending.tsx`](src/components/GenerationPending.tsx) — 生成中占位卡（画布提示词卡 running 时占住结果位）：一行文案（`生成中 8s · 正在构图…`）+ 渐近进度条，曲线与文案由 [generationPending.ts](src/generationPending.ts) 给出。`elapsed` 不传则自己每秒走表、传了就以父组件为准（两套时钟会互相打架）；进度条只动 `transform: scaleX()`，不给 `width` 做动画（宽度动画会触发布局）。**父组件必须在开始生成时再挂载它**（`{running && <GenerationPending/>}`）——常驻挂载会让秒数从页面打开就跑。结构移植自 basketikun/infinite-canvas（MIT），但底色一律走 `var(--surface-*)` token

### 根文件

- [`App.tsx`](src/App.tsx) — 根组件：顶栏（品牌区 3D `brand-swing` 系、`chip` 角标、`corner-note` 镜像小字）、经典/画布模式切换、**外观弹窗**（主体色 / 我的壁纸 / 画布边界：壁纸图存 IndexedDB 后铺成整页背景，`html[data-wallpaper]` / `html[data-canvas-bounds]` 属性驱动「底色让位」与「画布边界开关」）、**生图 API 配置弹窗**（选择器：选来源 + 选模型两件事，值 + 来源由 `/api/config` 的 `profileView` 下发，改地址/密钥请改文件）与 **添加第三方供应商弹窗**（`ProviderModal`，顶栏插头图标；建新来源写 `providers.local.json`）。品牌区参数（`BRAND_LAYERS`/`TEXT_Z_STEP`/`LOGO_Z_STEP`/`LOGO_FACE*`）在 App.tsx 顶部——**标题与 logo 挤出深度分档**（logo 线条细，同深度会糊成红块）
- [`main.tsx`](src/main.tsx) — 入口（挂载 + accent 主题注入）
- [`index.css`](src/index.css) — **唯一样式层**（Tailwind v4）：`:root` 设计 token + `@layer components` 组件类 + 动效层；导出的 token 与公共类清单见本文「样式体系」节，组件只引用类名、不写死尺寸与颜色
- [`verify_canvas.py`](e2e/verify_canvas.py) — 画布交互 E2E（103 断言，Playwright headless）
- [`verify_provider.py`](e2e/verify_provider.py) — 「添加第三方供应商」E2E（38 断言）：真实点顶栏插头 → 填表 → 真实落盘 `providers.local.json` → 断言文件内容（8 档尺寸单价全 0 / 7 个比例 / 模型目录 / **不含密钥** / 地址带 `/v1` 时路径不重复）→ 新来源出现在配置弹窗下拉。探测那步打一个不存在的域名（预期 400，不花外部配额）；Provider ID 用随机值，跑完不留残留

## 上下游依赖

### 本目录用到了谁
- 后端：`server.py` 全部 `/api/*`（经 api.ts 封装）+ `core/registry.py` 的 `image_url` 约定（url 由后端返回）
- 第三方：`@xyflow/react`、`lucide-react`、`react` 19

### 谁用到了本目录
- `server.py`：托管 `dist/` 构建产物（静态文件）
- `tests/`：无（前端测试在本目录内）
- CI：Frontend Job（npm ci/test/build）、E2E Job（自建 dist）

## 变更影响路由（改前必看）

- 改后端接口（server.py）
  → 同步 `api.ts` + `types.ts`
  → 跑 `npm test` + `npm run build`
  → 同步 ARCHITECTURE 7.1 表

- 改纯函数（src 根 *.ts）
  → 跑 `npm test`（有单测即够，无需文档）

- 改组件（components/）
  → 跑 `npm test` + E2E（画布相关必跑 verify_canvas.py；来源/配置弹窗相关必跑 verify_provider.py）
  → 如改样式 → 进 `index.css` 组件类

- 改 `index.css`
  → `npm run build`（Tailwind v4 编译）
  → 相关组件 E2E 复验（按钮/品牌区/落点示意有专项断言）

- 改 `App.tsx` 品牌区/顶栏
  → 跑 build + E2E（品牌区断言）+ 本地目验摆动

- 改外观弹窗 / `wallpaperStore.ts` / `canvasBounds.ts`
  → 跑 `npm test` + build + 本地目验（壁纸铺底、刷新后仍在、画布边界开关）
  → 新增公共类 / 属性选择器同步本文「样式体系」节

## 参考

- 设计决策（动画约束/按钮体系/品牌区 3D/预览统一）：[../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) 8.4 / 9.4
- E2E 与测试命令：[../tests/README.md](../tests/README.md)
- 维护仪表盘（数字/待办/坑）：[../AGENTS.md](../AGENTS.md)
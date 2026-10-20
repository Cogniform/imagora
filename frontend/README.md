# frontend/ — React SPA（画布工作台 UI）

React 19 + TypeScript + Vite + Tailwind v4 + React Flow（`@xyflow/react`）。栈细节与设计决策见 [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) 第 8 章。

## 本地常用命令（在本目录执行）

```powershell
npm install
npm run dev        # 开发模式（热更新；需后端已启动，见下）
npm run build      # tsc --noEmit + vite build → dist/（git 忽略，由后端服务托管）
npm test           # vitest run（338 用例）
npm run lint       # eslint
npx tsc --noEmit   # 类型检查
```

后端（任意终端，项目根目录）：

```powershell
.\.venv\Scripts\python.exe -m main ui --no-browser --port 7860
```

E2E（画布交互回归，真实浏览器；36 断言）：

```powershell
# 前置：7860 服务已在跑 + playwright 已装
#   .\.venv\Scripts\python.exe -m pip install playwright
#   .\.venv\Scripts\python.exe -m playwright install chromium
.\.venv\Scripts\python.exe ..\frontend\e2e\verify_canvas.py
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
- 改后必测：`npm test` + E2E（verify_canvas.py 第 8-11 段）

### [useGenerationTask.ts](src/useGenerationTask.ts)
- 职责：生成任务轮询/取消（`useGenerationTask`）；导出终态常量 `TERMINAL_STATUSES`（轮询停止口径，勿在别处内联重复列表）
- 注意：返回稳定成员引用（hook 单测锁定）

### [useCanvasRecovery.ts](src/useCanvasRecovery.ts)
- 职责：恢复快照自动保存/恢复接线

### [useImageZoom.ts](src/useImageZoom.ts)
- 职责：图片「单击开原图 / 双击放大预览」时序区分（`useImageZoom`，250ms 延时）
- 被谁依赖：Gallery.tsx（经典表单结果图）、HistoryGallery.tsx（生产历史）
- 注意：双击第二击必须取消未决的单击开窗（防连开两个新标签，单测锁定）

### 组件（components/；改后跑 `npm test` + E2E）

- [`CanvasPage.tsx`](src/components/CanvasPage.tsx) — 无限画布主页面（React Flow 集成、选中操作栏、操作帮助弹窗、历史面板入口）
- [`CanvasNodes.tsx`](src/components/CanvasNodes.tsx) — 三类节点（图片/图片组/提示词卡）+ `ActionButton`（nodrag 胶囊按钮）；`StatusLight` 状态灯 running 恒定「生成中」，`ElapsedText` 秒数文字以 `startedAtMs` 自计时（防逐秒重渲染，见 ARCHITECTURE 5.3）
- [`WorkflowModals.tsx`](src/components/WorkflowModals.tsx) — 保存/加载/导入弹窗 + **`ZoomModal` 全屏预览**（createPortal 到 body，画布 / 经典表单 / 生产历史共用；Portal 根截停 click 冒泡，防误关外层宿主遮罩）
- [`ResultPanel.tsx`](src/components/ResultPanel.tsx) — 经典表单结果区 5 态容器：主图形层 absolute 居中钉死 + 副信息层底部独立生长（行增减不挤动主图形）；切换交叉淡化（swap-in/swap-out，旧层保留 200ms）；排队/生成中/失败/已取消/透传 Gallery；生成中图标本体按自身颜色呼吸光（`icon-breathe`）
- [`Gallery.tsx`](src/components/Gallery.tsx) — 经典表单结果图（双击放大 / 单击新窗口开原图，250ms 区分，走 useImageZoom；被 ResultPanel 透传）
- [`LogLine.tsx`](src/components/LogLine.tsx) — 日志单行：文本里的本机绝对路径拆成可点击复制词条（CopyChip），其余保持文本；行动画 log-line
- [`CopyChip.tsx`](src/components/CopyChip.tsx) — 路径词条：点击复制完整路径（`navigator.clipboard`），复制后边框/底色高亮反馈 1.2s（不换文字，避免宽度跳动）
- [`UploadZone.tsx`](src/components/UploadZone.tsx) — 参考图上传区（缩略图单击不触发文件选择器、双击放大）
- [`HistoryGallery.tsx`](src/components/HistoryGallery.tsx) — 生成历史面板：**分页滚动加载**（首屏 60 条，滚动接近底部 600px 内自动追加、未占满视口自动续拉，按钮仅兜底，DOM 恒在单页数量级）两栏网格卡片（160px 结果图 | 提示词 2 行截断随容器宽 | 56px 参考图换行 | 按钮底部对齐横排）；提示词超 2 行时悬浮浮层补全（仅截断弹、宽固定 80vw 水平居中左/右各留 10vw、高随行数自动长、垂直跟随鼠标、无滚动条）；搜索/状态筛选重置到第 0 页；双击放大预览 / 单击新窗口开原图 / 导入当前画布；每行按钮与成败无关（复制提示词 / 打开目录 / 导入当前画布）；参考图已丢失的失败记录只给一条条数提示（无法还原，无重跑入口）
- [`CostBoard.tsx`](src/components/CostBoard.tsx) — 成本看板条（历史面板顶部）：今日/累计花费、成功率、失败数、成功平均耗时、按尺寸分布 + 本机预算（日预算 / 单次上限，0 = 不限）编辑保存；数据来自 `/api/history/stats`，保存走 `/api/budget`
- [`PromptImportModal.tsx`](src/components/PromptImportModal.tsx) — 粘贴导入弹窗（实时解析 + 问题标红）
- [`FolderPicker.tsx`](src/components/FolderPicker.tsx) / [`Select.tsx`](src/components/Select.tsx) — 目录选择 / 尺寸质量下拉

### 根文件

- [`App.tsx`](src/App.tsx) — 根组件：顶栏（品牌区 3D `brand-swing` 系、`chip` 角标、`corner-note` 镜像小字）、经典/画布模式切换、**外观弹窗**（主体色 / 我的壁纸 / 画布边界：壁纸图存 IndexedDB 后铺成整页背景，`html[data-wallpaper]` / `html[data-canvas-bounds]` 属性驱动「底色让位」与「画布边界开关」）、**生图 API 设置弹窗**（三页签：使用中 —— 后端配置只读来源视图，值 + 来源由 `/api/config` 的 `profileView` 下发 / 个人配置 —— 覆盖值与默认值取自同一接口、前端不硬编码 / 预设 —— 存取删本地预设）。品牌区参数（`BRAND_LAYERS`/`TEXT_Z_STEP`/`LOGO_Z_STEP`/`LOGO_FACE*`）在 App.tsx 顶部——**标题与 logo 挤出深度分档**（logo 线条细，同深度会糊成红块）
- [`main.tsx`](src/main.tsx) — 入口（挂载 + accent 主题注入）
- [`index.css`](src/index.css) — **唯一样式层**（Tailwind v4）：`:root` 设计 token + `@layer components` 组件类 + 动效层；导出的 token 与公共类清单见本文「样式体系」节，组件只引用类名、不写死尺寸与颜色
- [`verify_canvas.py`](e2e/verify_canvas.py) — 画布交互 E2E（36 断言，Playwright headless）

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
  → 跑 `npm test` + E2E（画布相关必跑 verify_canvas.py）
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
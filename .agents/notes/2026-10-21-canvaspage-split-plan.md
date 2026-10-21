# CanvasPage 拆分方案（R1–R11）

状态：生效

事实基准：2026-10-21，`frontend/src/components/CanvasPage.tsx` 拆分前 2346 行；本轮完成 R1（-15）、C（-3）、A/B（+29）后 **2357 行**。**除特别注明外，本文行号均为「拆分前 2346 行版本」**；当前文件行号已与基线错位，定位以符号名为准。

## 问题

`CanvasPage.tsx` 是单文件 2346 行：约 29 个 `useState`、9 个 `useEffect`、11 个 `useCallback` 级联、30 余个内联渲染块。它同时承担 React Flow 集成、节点/边变更、任务编排、图片加工、历史、快捷键、框选、弹窗与工具栏，任何一处改动都要在 2300 行里做回归判断，且几乎没有可单测的中间层。

但当前不能大拆：行为基线测试只有 E2E 111 个 `check()` + 既有单测，内部契约（ref 身份、`nodeTypes` 稳定性、`modalOpen` 与 drop 的耦合）没有快照。根 `imagora/AGENTS.md` 待办第 4 条原话是「**先补行为基线测试**（当前覆盖薄、裸拆风险高），再分步拆、每步独立验证，CI + E2E 兜底；不急于一次拆完，也不混进严格开关批次」。本方案按这句话执行。

## 决策

### 1. 现状测绘

#### 1.1 八类分区（沿用 Lead 审计编号，不另起一套）

| # | 分区 | 行号区间 | 内容 |
| --- | --- | --- | --- |
| 1 | 状态声明 | 232-233, 235-239, 241-251, 286-300, 330-364, 365-379, 380-413, 415-422 | nodes/edges、canvasRef/rfInstanceRef、视口 LOD/小地图/缩放、吸附与 ref 镜像、日志/高亮/选中、生成任务、图片加工与弹窗开关、尺寸/质量选项 |
| 2 | 历史 | 363-364, 429-433, 453-462, 811, 1597-1617 | `historyRef`/`historyVersion`、`recordHistory`、`restoreCanvas`、替换图后的记录点、undo/restore |
| 3 | 布局几何 | 111-124, 126-140, 241-329, 1040-1060, 1137-1180, 1541-1577, 1698-1816, 2200-2214 | 常量、minimap 颜色、LOD/滑杆/吸附、`defaultQuality` 与落点、聚焦、自动布局/连线、框选状态机、ViewportPortal 框选矩形 |
| 4 | 生成 | 365-379, 1310-1539, 1619-1639 | `generationTask` 解构、`reflowResults`/`runNodeInternal`/`waitCanvasIdle`/订阅/`handleRun`/`handleRunAll`、`handleRunSelected` |
| 5 | 图片 | 380-391, 823-876, 878-927, 929-1135 | 预览与加工目标、替换图、淡出删除、裁剪/放大/拆分/蒙版、派生图提交 |
| 6 | 右键菜单 | 392-397, 1762-1769, 1818-1887, 2333-2343 | `nodeMenu`、菜单开点、`menuItems`/`handleMenuPick`、`NodeContextMenu` 渲染 |
| 7 | 渲染树 | 162-215, 1889-1966, 1968-2217, 2243 | `ToolbarButton`/`CanvasLog`、`nodeTypes`/`modalOpen`/`useCanvasDrop`、根 div→ReactFlow、`CanvasLog` 挂载 |
| 8 | 弹窗 | 398-413, 1947-1957, 2246-2332 | 文件 input/待替换/待删 ref、`modalOpen`、保存/加载/导入/历史/帮助/缩放/裁剪/放大/拆分/蒙版 |

#### 1.2 state 分组（按用途）

| 用途 | 行号 | 代表状态 |
| --- | --- | --- |
| 图与实例 | 232-239 | `nodes`、`edges`、`canvasRef`、`rfInstanceRef`（`setCanvasZoom` 已在 C 项删除） |
| 视口 | 241-285 | `lod`/`lodRef`、`minimapVisible`、`zoomPercent`、`draggingSliderRef`、`handleViewportMove`/`handleZoomSlider`/`commitZoomSlider`/`toggleMinimap` |
| 吸附与镜像 | 286-329 | `snapEnabled`、`snapGuides`、`nodesRef`/`edgesRef`、`onNodesChange`、`toggleSnap` |
| 选中与高亮 | 330-349 | `logs`、`highlightId`、`selectedCount`、`selectedPromptCount`、`pickingSelectedOutputDir`、`selectedIdsRef`、`hoveredEdgeId`、`selectedEdgeId`、`selectedNodeIds` |
| 框选 | 356-362 | `boxSelectRef`、`boxRect` |
| 历史 | 363-364 | `historyRef`、`historyVersion` |
| 任务 | 365-379 | `generationTask`、`nodeTaskRef`、`taskNodeRef`、`runningAll` |
| 图片加工 | 380-391 | `zoomImage`/`zoomName`、`cropTarget`/`upscaleTarget`/`splitTarget`、`maskTarget` |
| 右键菜单 | 392-397 | `nodeMenu` |
| 弹窗与偏好 | 398-413 | 保存/加载/导入/历史/帮助开关、`saveName`、`workflows`、`fileInputRef`、`replaceInputRef`、`pendingReplaceRef`、`pendingRemovalRef` |
| 选项推导 | 415-422 | `sizeOptions`、`qualityOptions` |

#### 1.3 effect 职责

| effect | 行号 | 职责 | 处置 |
| --- | --- | --- | --- |
| `useLayoutEffect` | 297-300 | `nodesRef`/`edgesRef` 镜像 | H1 绝不能动 |
| 恢复接线 | 464-469 | `useCanvasRecovery` | H10 绝不能动 |
| 导入恢复 | 472-496 | URL `importSubmissionId` → 拉取会话并落到画布 | 不动 |
| 待删清理 | 499-505 | `pendingRemovalRef` 清理链 | H9 绝不能动 |
| 动画清理 | 511-538 | `animationend` 清 `.enter-up` | DOM/类名依赖，禁止抽 |
| 计数派生 | 575-606 | 由 `nodes`+`edges` 派生 `refCount`/`imageCount`/`totalSize`（依赖只写 `[edges]`，是既有 bug） | 已完成：改为渲染期 `useMemo`，见 §7 A |
| 高亮 | 666-668 | `highlightId` → `applyHighlight` | 随 R6/R9 |
| 边样式 | 676-705 | `edgeStyle`/`dimmedEdgeIds` | 纯计算，随 R6 |
| 生成订阅 | 1481-1514 | 订阅 `generationTask` 更新节点 | 随 R11 |
| 快捷键 | 1644-1696 | 删除/全选/撤销/保存等 | H8 绝不能动 |
| 框选指针机 | 1708-1816 | pointerdown/move/up + 菜单开点 | H7 绝不能动 |

#### 1.4 渲染块边界

| 块 | 行号 | 备注 |
| --- | --- | --- |
| 根 div + `dragHandlers` | 1969-1972 | H6；事件边界是整页 |
| 工具栏 | 1974-2028 | R9 候选；根 div 的 dragHandlers 不搬 |
| 画布容器 | 2031-2244 | `studio-canvas panel-card enter-up enter-delay-2` |
| 选中操作栏 | 2036-2086 | R6；保留 `.studio-inspector`/`surface-float`/`absolute` |
| ReactFlow | 2088-2215 | H4/H5；内部顺序：Background 2127、MiniMap 2130-2140、Controls/ZoomControls 2142-2196（R5）、ViewportPortal 2200-2214 |
| 拖入提示 | 2217 | 类名 `drop-chip` |
| 框选矩形 | 2219-2241 | H7 的 DOM 出口 |
| `CanvasLog` | 2243 | R3 |
| 弹窗群 | 2246-2332 | R2/R8 |
| `NodeContextMenu` | 2333-2343 | 右键菜单 |

### 2. 候选抽取单元清单

耦合度记法：读（state/ref）→ 写（setter/回调）。行数收益指从 CanvasPage 净减少的行数（不含新模块自身）。

| 编号 | 单元 | 行号区间 | 耦合度 | 抽取后归属 | 行数收益 | 风险 |
| --- | --- | --- | --- | --- | --- | --- |
| R1 | `minimapNodeColor` | 126-140 | 只读 `node.type`，无写 | `src/minimapColor.ts` + 同名单测 | 15 | 极低（已完成） |
| R2 | `HelpModal` | 154-160 + 2278-2293 | 读 `showHelp`；写 `setShowHelp` | `components/HelpModal.tsx` | ~20 | 低 |
| R3 | `CanvasLog` | 198-215 | 只读 `logs` | `components/CanvasLog.tsx` | ~18 | 低 |
| R4 | `ToolbarButton` | 162-196 | 纯 props（含 `dragStart`） | `components/ToolbarButton.tsx` | ~35 | 低 |
| R5 | `ZoomControls` | 2142-2196 | 读 `zoomPercent`/`minimapVisible`/`lod`；写 `handleZoomSlider`/`commitZoomSlider`/`toggleMinimap` | `components/ZoomControls.tsx`，**必须留在 `<ReactFlow>` 内且不能加 memo** | ~55 | 中低 |
| R6 | `SelectionBar` | 2036-2086 | 读 `selectedCount`/`selectedPromptCount`/`pickingSelectedOutputDir`/`selectedNodeIds`；写删除/输出目录/聚焦/建组/自动连线/运行选中 | `components/SelectionBar.tsx`，保留 `.studio-inspector`/`surface-float`/`absolute` | ~50 | 中 |
| R7 | `useCanvasHistory` | 363-364, 429-433, 453-462, 811, 1597-1617 | 读 `nodesRef`/`edgesRef`；写 `setNodes`/`setEdges`/`historyRef`/`historyVersion` | `hooks/useCanvasHistory.ts` | ~40 | ★★★ `record` 身份不稳会经 `removeNodesWithFade`→`handleDeleteNode`→`nodeTypes` 连锁 |
| R8 | `useCanvasDialogs` | 398-413, 1947-1957, 2246-2332 | 读全部弹窗开关/`saveName`/`workflows`/加工目标；写各 setter | `hooks/useCanvasDialogs.ts` | ~90 | ★★★ `modalOpen` 是 `useCanvasDrop` 的输入 |
| R9 | `CanvasToolbar` | 162-196 + 1974-2028 | 读 30+ 状态与回调 | `components/CanvasToolbar.tsx` | ~60 | ★★★★ **别把根 div 的 dragHandlers（1971）搬走** |
| R10 | `useImageOps` | 380-391, 823-876, 878-927, 929-1135 | 读 `nodes`/`edges`/`generationTask`/`config`；写 `setNodes`/`commitDerivedImage` | `hooks/useImageOps.ts`，分两步：先 1062-1135，再 948-1037 | ~200 | ★★★★ 影响 7/14 个 `nodeTypes` deps |
| R11 | `useGenerationRunner` | 365-379, 1310-1539, 1619-1639 | 读 `nodes`/`edges`/`generationTask`/`config`；写任务状态、节点状态、日志 | `hooks/useGenerationRunner.ts` | ~230 | ★★★★★ 完全无测试裸奔 |

终局预期 **1400–1600 行**，不承诺 300 行；真实收益是 state 约 29 → 8、可测单元 0 → 4 个 hook + 6 个组件。

### 3. 绝不能动的 10 条（H1–H10）

| # | 位置 | 约束 |
| --- | --- | --- |
| H1 | 290-300 | `nodesRef` 镜像 + `useLayoutEffect`，删了框选/删除读到旧节点 |
| H2 | 301-323 | `onNodesChange` 吸附接管（`applySnapToChanges`） |
| H3 | 1889-1942 | `nodeTypes` 身份：每渲染新建对象会让 React Flow 全量重挂 |
| H4 | 2127-2214 | Background/MiniMap/Controls/ViewportPortal 必须在 `<ReactFlow>` 内 |
| H5 | 2108-2113 | `rfInstanceRef` + `onInit` |
| H6 | 1969-1972 | 根 div `dragHandlers`（框选从整页开始） |
| H7 | 1698-1816 + 1762 | 右键框选指针状态机 + 菜单开点 |
| H8 | 1641-1696 | 快捷键 effect |
| H9 | 412-413 → 499-505 → 1598/1609 → 878 | `pendingRemovalRef` 清理链 |
| H10 | 464-469, 1958-1966 | `useCanvasDrop`/`useCanvasRecovery` 接线 |

### 4. 执行序列（每次只做一步）

| 步骤 | 动作 | 验证 | 回滚 |
| --- | --- | --- | --- |
| R1 ✅ | `minimapNodeColor` → `src/minimapColor.ts` + test | `tsc` + `npm test` + 行数 | 删模块、还原 import/函数块 |
| R2 | `HelpModal` 抽为组件，`HELP_ROWS` 随迁 | `tsc` + `npm test` + `verify_canvas.py --only 帮助` | 单文件反向 patch |
| R3 | `CanvasLog` + `LOG_VISIBLE_COUNT` 抽为组件 | 同上 + `--only 日志` | 同上 |
| R4 | `ToolbarButton` 抽为组件（纯 props） | `tsc` + `npm test` + 工具栏相关 `--only` | 同上 |
| R5 | `ZoomControls` 抽为组件，**留在 ReactFlow 内** | `--only 缩放` + `--only 小地图` | 同上 |
| R6 | `SelectionBar` 抽为组件，类名与定位不动 | `--only 选中` + 截图比对 | 同上 |
| R7 | `useCanvasHistory`：先补 `record` 身份契约测试，再抽 | 契约测试 + 全量 E2E | 同上 |
| R8 | `useCanvasDialogs`：先固化 `modalOpen` 形状，再抽 | drop 相关 `--only` + 全量 E2E | 同上 |
| R9 | `CanvasToolbar`：根 div dragHandlers 留在页面 | 框选 `--only` + 全量 E2E | 同上 |
| R10a | `commitDerivedImage`/`commitSplitImages`（1062-1135） | 裁剪/拆分 `--only` | 同上 |
| R10b | 图片操作回调（948-1037） | 裁剪/放大/蒙版 `--only` + 全量 E2E | 同上 |
| R11 | `useGenerationRunner`：先补任务生命周期测试，再抽 | 生成/取消/恢复全量 E2E | 同上 |

节奏约束（对应 AGENTS.md 待办第 4 条）：

- 一次只落一个 R，单独验证、单独回滚；不把两个 R 混在同一批改动里。
- **不混进严格开关批次**：本方案不调整 `tsconfig` 严格项、lint 规则、依赖版本或样式体系，这些另开批次。
- 每步完成即跑 `npx tsc --noEmit -p tsconfig.json` + `npm test`；E2E 用 `--only` 做快速回归，每 3 步或每次 hook 抽取后跑一次全量 111 断言。
- 阶段 0（契约测试）由 `baseline-tests` 负责；`CanvasPage.baseline.test.tsx` 就位前不启动 R2。

### 5. 为什么是这个顺序

1. **依赖方向决定先后**：纯函数（R1）→ 无状态展示（R2–R4）→ 只读/轻交互控件（R5–R6）→ 有状态 hook（R7–R11）。反过来先动 hook，会把最不稳定的 ref 身份问题带到最前面。
2. **可验证性递增**：R1–R4 能用纯单测或 props 断言钉死；R5–R6 靠 E2E 选择器；R7 之后只能靠契约测试 + 全量 E2E。先用便宜的手段建立「拆一个、验一个」的节奏，再上贵的。
3. **风险传染链**：R7 的 `record` → `nodeTypes`、R8 的 `modalOpen` → `useCanvasDrop`、R9 的 dragHandlers → 框选、R10 的 7/14 `nodeTypes` deps、R11 的任务订阅，都是「一处身份变化、全画布重挂」的同一类问题。必须等基线测试与前面的低风险步骤把工具链跑顺。
4. **行数收益/验证成本比**：R2–R4 合计约 -73 行、几乎零行为风险；R11 约 -230 行但风险最高。先摘低垂果实，能尽早暴露「抽取模板」本身的问题（import 顺序、CRLF、类名），而不是在 R11 里边拆边学。

### 6. 本次没做的部分为什么不敢现在做

- **R2–R6（UI 大块）**：`CanvasPage.baseline.test.tsx` 还没就位（`baseline-tests` 正在写）。现在搬 JSX 没有可比对的行为快照，类名/DOM 结构一漂，E2E 111 个 `check()` 只能事后报警，定位成本高于收益。
- **R7（history hook）**：`record` 若每次渲染换新身份，会经 `removeNodesWithFade` → `handleDeleteNode` → `nodeTypes` 依赖数组连锁，导致 `nodeTypes` 重建、React Flow 全量重挂；表现为选择丢失/退场动画中断，E2E 只能偶发捕获。没有契约测试不敢动。
- **R8（dialogs hook）**：`modalOpen` 是 `useCanvasDrop` 的输入。抽 hook 时若返回新对象/新布尔组合，drop 的启用条件会变，属于「看起来只是搬状态」的隐性行为变化。
- **R9（toolbar 组件）**：根 div 的 `dragHandlers` 在 1971，是框选指针状态机的入口；把它随工具栏搬进组件，会把事件边界从整页缩到工具栏，框选直接失效。
- **R10（imageOps）**：影响 7/14 个 `nodeTypes` deps，且 `commitDerivedImage` 同时改 nodes/edges/历史；必须拆成 1062-1135、948-1037 两步，单步都不小。
- **R11（generationRunner）**：完全无测试裸奔，涉及任务快照、取消、订阅恢复；这是全文件风险最高的一块，必须最后做。
- 本轮任务明确限定「方案 + 零风险第一小步」，所以只动无 DOM 依赖的纯映射；任何 UI 结构/类名变化都可能破坏 E2E 契约。

### 7. 已完成的局部手术（A/B/C，2026-10-21）

这三项不是抽取步骤，是拆分前必须落地的正确性/性能修复；它们改变行号，但不改变组件边界。

| 项 | 基线位置 | 改动 | 与阶段 1 抽取的关系 |
| --- | --- | --- | --- |
| A | 575-606 | counts effect 依赖只有 `[edges]`、函数体却读 `nodes` → 新增/删除/替换图片后 `refCount`/`imageCount`/`totalSize` 不刷新。改为渲染期 `useMemo` 派生 `nodesWithCounts`（ReactFlow 直接消费），并按「源节点对象 + 计算值」缓存派生结果：拖动时只换被拖节点，其余节点引用稳定 | 抽 `useImageOps`/`useGenerationRunner` 时**不要**把它改回写 state 的 effect；`nodesWithCounts` 必须留在 `nodeTypes` 之前并直接喂 ReactFlow |
| B | 2117 | `defaultEdgeOptions={{ animated: !lod }}` 每次渲染新建对象，ReactFlow StoreUpdater 浅比较不等就写 store → 所有 `EdgeWrapper` memo 失效。改为 `useMemo([lod])`；`onEdgeDoubleClick`(2094)/`onPaneClick`(2100)/`onNodeDragStart`(2105)/`onInit`(2108) 四个内联回调提成稳定引用 | 抽 `CanvasToolbar`/`SelectionBar` 时不得把这些回调重新内联；`nodeTypes` 之外的边渲染已降为 0，抽取后复查 `nodeTypes` 依赖数组没有新增不稳定项 |
| C | 238-240 | 删除每帧写 `--canvas-zoom` 的 CSS 变量（全仓无消费者；`canvasStyles.test.ts` 反而断言它不存在） | 视口抽取（R5）不要再引入 DOM 直写，缩放读数统一走 `zoomPercent` |

验收：`tsc` 0 错；`npm test` 60 files / 944 tests 全绿；`CanvasPage.tsx` 保持 CRLF（2357 行、0 个裸 LF）。counts 的回归断言由 `baseline-tests` 负责，本方案只保证其变绿。

## 替代方案

- **一次性按 ARCHITECTURE 章节整体重写 CanvasPage**：否决。无法逐步验证，E2E 覆盖不到内部契约，出问题只能整文件回滚。
- **先抽 5 个 hook、测试后补**：否决。hooks 之间靠 ref 与渲染顺序耦合，事后补测试等于给已发生的重构做合理化。
- **把 `minimapNodeColor` 留在组件内只导出测试**：否决。组件文件带 JSX/React Flow 依赖，单测要 jsdom + 上下文；纯函数模块零依赖、测试快。
- **菜单尺寸再抽一份常量模块**：否决。`contextMenu.ts` 已有 `MENU_WIDTH=200`/`MENU_ITEM_HEIGHT=28`，第二份口径必然漂移。
- **用 codemod 批量搬 JSX**：否决。类名与 DOM 结构是 E2E 契约，批量搬无法逐步验证、无法单步回滚。

## 影响

- 本轮完成 R1（-15 行）+ C（-3 行）+ A/B（+29 行，稳定回调与注释）：`CanvasPage.tsx` 2346 → 2357 行；新增 `src/minimapColor.ts` + `minimapColor.test.ts`（6 个用例）。R1/C 为净减，A/B 是正确性与渲染性能修复，行数不是本轮的考核目标。
- 后续按 R2 → R11 推进，终局预计 1400–1600 行；state 约 29 → 8，可测单元 0 → 4 hook + 6 组件。
- 明确不在本方案内：`CanvasNodes.tsx`、`index.css`、`e2e/` 断言、根 `AGENTS.md` 仪表盘数字（Lead 统一更新）。

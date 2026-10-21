# 蒙版局部重绘（Inpainting）设计

> 状态：**已实现**（笔刷对话框 + 后端 mask 参数链路已接通，本文档随实现同步）
> 目标读者：维护者本人（单人使用，方案以「一处真相 + 出错要吵」为准绳）
> 上游契约：[ARCHITECTURE 7.1 接口契约](ARCHITECTURE.md) 的 `/api/generate` 行
> 文风与分节参照：[配置弹窗 UI · 交互设计](config-editor-ui-design.md)

---

## 0. 一句话设计原则

**蒙版是「这张图的哪块要改」的一份声明，不是一次请求。** 它挂在图片节点上跟着图走，
等到这张图作为参考图被提交时才随任务快照发出。由此推出三条贯穿全文的约束：

| 约束 | 含义 |
|---|---|
| 语义只有一处 | 「透明 = 重绘」写在后端 docstring 与前端常量里，两边必须同向 |
| 坐标只有一套 | 状态层只存归一化 0..1，像素只在渲染与导出的边界上出现一次 |
| 错了要吵 | 空蒙版、多张蒙版、无底图一律明确中止，不静默挑一张、不静默丢参数 |

## 1. 端到端链路与三层职责

```
图片节点「蒙版重绘」→ MaskBrushDialog（涂/擦 → exportMaskDataUrl）
  → CanvasImageNodeData.maskDataUrl（写回图片节点，不新建节点）
  → runNodeInternal 快照 → GenerateParams.maskDataUrl
  → POST /api/generate 的 mask 表单字段（data URL 文本）
  → GenerationTask.mask_data_url（随任务排队）
  → run_generation → generate_image(mask_data_url=...)
  → data_url_to_temp_png → multipart 的 mask 字段 → 上游 /images/edits
```

| 层 | 文件 | 职责 | 刻意不知道 |
|---|---|---|---|
| 几何层 | [maskBrush.ts](../frontend/src/maskBrush.ts) | 归一化坐标、节流、插值、空判定、包围盒 | React、canvas、网络 |
| 交互层 | [MaskBrushDialog.tsx](../frontend/src/components/MaskBrushDialog.tsx) | 预览、笔刷模式、导出 PNG data URL | 属于哪个节点、任务 |
| 提交层 | [CanvasPage.tsx](../frontend/src/components/CanvasPage.tsx) | 写回节点、快照、单蒙版守卫、提交 | PNG 里哪块透明 |

几何层是纯函数（配 [maskBrush.test.ts](../frontend/src/maskBrush.test.ts) 单测），「节流有没有生效」
「插值补几个点」不需要浏览器就能断言。分层不是为了好看：**「不知道」才是可测试性的来源。**

## 2. alpha 语义：透明像素 = 要重绘

后端约定（OpenAI images/edits 口径，见 [core/api.py](../core/api.py) 里 `generate_image()` 的 docstring）：
**透明像素 = 要重绘的区域，不透明像素 = 保持原样**。用户直觉正相反：在画布上「涂」，涂到的地方
就是「要改的地方」。若直接把笔迹当 alpha 发出去，涂过的地方是不透明 = 保留区，
**用户圈哪块、上游就偏偏不动哪块**。

**反转只发生在导出这一层。** `exportMaskDataUrl()` 的做法：① 画布先 `fillRect` 铺满不透明白
（默认「全图保留」）；② 每一笔 paint 用 `globalCompositeOperation = "destination-out"` 把圆抠成透明；
③ 每一笔 erase 用 `source-over` 把透明洞补回白色。产物因此是「涂过的地方透明」，与后端同向。
这个反转在整条链路上**只出现一次**，下游（节点、表单、任务、`core/api.py`）拿到的都是已符合约定的
PNG，谁都不需要再想这件事。`MASK_ALPHA_CONVENTION = "transparent-is-editable"` 这个常量的唯一目的，
是让「哪天有人想改语义」时有个显眼的落点，而不是靠读合成代码去猜。

**为什么不让用户「涂透明」。** 技术上可行（起手透明、涂白即重绘区），但界面无法表达：预览背景是
原图，透明区域在原图上看起来就是「什么都没有」，用户判断不出自己涂到哪；且「擦除」在透明起手的
世界里语义反了（擦掉 = 变成保留区），与所有画图软件相反。所以选「涂 = 要改」的用户模型 + 导出时
反转：代价是一段合成代码，收益是零学习成本。改错的后果也不是报错，而是**静默错图** —— 涂的区域
被上游当成保留区，请求照常计费、结果照常落盘，只有「我圈的地方没变」这一个症状，很容易被归因成
「模型不听提示词」。这正是给它起常量名并写进文档的原因。

**一个函数两种合成。** 预览与导出共用 `drawStrokeCircles(context, stroke, image, holeMode)`，合成
方式由 `paint === holeMode` 决定：预览（`holeMode = false`）里 paint 是 `source-over` 涂白，导出
（`holeMode = true`）里 paint 是 `destination-out` 抠洞，erase 两者相反。**为什么不各写一份循环**：
半径换算、点序、`save/restore` 纪律必须逐字一致；两份实现迟早漂移，而漂移的表现恰好是「预览看着
对、产物不对」——最贵的一种 bug。

## 3. 坐标与尺寸：一律归一化

| 空间 | 谁在用 | 出现时机 |
|---|---|---|
| 归一化 0..1 | `BrushPoint` / `MaskStroke.points` | 唯一的状态真相 |
| 预览 canvas 像素 | 屏幕上那层 canvas（长边 ≤ `PREVIEW_MAX_EDGE` = 1280） | 每帧重绘 |
| 原图像素 | `exportMaskDataUrl()` | 只在导出时乘一次 |

混用是这类功能最常见的 bug 源：把预览像素存进状态，窗口一缩放笔画就整体错位；把归一化坐标直接
喂给 `arc()`，笔迹会缩成左上角一个点。预览层压了 `VIEWPORT_HEIGHT = "min(56vh, 520px)"`，`<img>`
的 `max-h` 与它同值 —— **img 是决定 canvas 尺寸的那一层**，两处必须同值，否则 canvas 会盖住可能
带黑边的整个视口盒，归一化坐标会因为 letterbox 而错位。

**`size` 是「占短边的比例」，不是像素。** `brushRadiusPx(size, image)` 是
`size × min(width, height) / 2`。用短边而不是长边：短边决定「一眼看过去的粗细」，拿长边做基准，
16:9 图上的笔刷会比 1:1 图上粗一截；用像素做单位，4K 图上笔刷细如发丝、512 图上一下糊掉整张图，
同一套参数无法跨分辨率复用。范围 `MASK_BRUSH_MIN = 0.01` ~ `MASK_BRUSH_MAX = 0.4`，默认
`MASK_BRUSH_DEFAULT = 0.08`（短边 8%）。`clampBrushSize()` 对 NaN / ±Infinity 回落**默认值**而不是
下限：滑杆读回坏值时缩到 1% 会细得像发丝，用户会以为「画笔坏了」；退回默认粗细至少还能继续画。

**导出乘回真实尺寸，所以蒙版与原图同尺寸。** `exportMaskDataUrl()` 里 `canvas.width/height` 直接取
原图像素（`Math.max(1, Math.round(...))`）。上游要求 mask 与 image 尺寸一致；多一层缩放等于把对齐
责任推给上游，蒙版也无法单独打开与底图逐像素对照。预览层则缩小到 `PREVIEW_MAX_EDGE = 1280`：4K 图
按原尺寸每帧重绘要几十毫秒，压到 1280 足够看清笔迹，也省下几十 MB canvas 内存。几何全归一化，
预览分辨率与导出分辨率互不影响；两者共用 `brushRadiusPx`，屏幕上看到的粗细与产物里的粗细同构。
预览 canvas 另用 CSS `opacity`（`PREVIEW_OPACITY = 0.72`）：全不透明白会把底图完全盖死，用户看不见
自己在遮哪里；导出 canvas 不吃这个 opacity，产物仍是纯不透明。

## 4. 采样节流与插值

**节流命中时返回原数组引用。** `appendPoint(points, point, minGap = MASK_POINT_MIN_GAP)`：与最后
一个点的归一化距离 `≤ minGap`（0.004）时**返回原数组引用**，不是拷贝。`pointermove` 每秒能来上百次，
一次拖动轻松几千个事件；不节流的话 `strokes` 数组会涨到几十万点，撤销栈与导出（逐点画圆）全部卡死。
返回原引用让调用方用 `next === points` 判断「这一帧没变」并跳过 `setState` —— `handlePointerMove`
正是这么用的，React 因此不会被高频事件拖垮。比较用 `<=` 而不是 `<`：这样 `minGap = 0` 仍有意义，
它挡掉**完全重合**的点（插值补点时传 0，重合点会让同一处画两遍圆，白花时间），但不会挡任何真正
移动过的点。

**插值在像素空间量距离。** `interpolatePoints(from, to, radiusPx, image)` 按 `radiusPx / 4` 的步长
补点：这个密度下相邻圆重叠 75%，肉眼看是连续笔迹，又不会把点数组撑爆（步长再细只是白花内存）。
距离必须乘宽高再算（`Math.hypot((to.x - from.x) * width, (to.y - from.y) * height)`）：归一化空间的
欧氏距离在 16:9 图上会把横向间距算大、竖向算小，补出来的点横竖疏密不一，竖向笔画会明显更「断」。
两个退化保护：`radiusPx <= 0`（尺寸还没读到）时不插值（半径 0 会让步长退化成 0，补出无穷多个点）；
单次最多补 `MASK_INTERPOLATE_MAX_STEPS`（2048）个点，只防病态输入（指针跳到图外再跳回来）。

## 5. 空蒙版的守卫

`hasPaint(strokes)` 只认 `mode === "paint"` 且点不为空的笔画；`isMaskEmpty()` 的定义就是
`!hasPaint()`。**只擦不涂也算空** —— 这是最容易漏的一条：橡皮擦在预览里有可见反馈，用户会以为
自己「画了」。

| 位置 | 表现 | 为什么 |
|---|---|---|
| 确认按钮 | `disabled={busy \|\| !imageSize \|\| empty}` | 空蒙版交给上游等于「整图都要重绘」 |
| 提示文案 | 空时显示 `mask-empty-hint`「先在图上涂出要重绘的区域」 | 按钮灰着却不说原因，用户只会反复点 |
| 导出函数 | 取不到 2D 上下文时**抛错**而不是返回空串 | 静默降级成空蒙版 = 花钱重绘整图 |

为什么必须拦：全不透明蒙版在 images/edits 口径下意味着「一个像素都不用改」，上游可能回原图也可能
拒绝；全透明蒙版意味着「整图重绘」，等于把一次昂贵的文生图伪装成局部重绘。两种都不是用户想要的，
而**用户按下确认时的心智是「改我涂的那块」**。

稳定选择器：外壳 `mask-brush-dialog`、画布 `mask-canvas`、确认 `mask-confirm`、清除 `mask-clear`、
笔刷滑杆 `mask-brush-size`、空提示 `mask-empty-hint`。为什么要有这些：jsdom 里 `getContext("2d")`
恒返回 null，蒙版无法靠像素断言，测试只能走「状态层 + testid」；且 `getContext` 处处判空本身
就是被测试覆盖的真实路径。

## 6. 蒙版挂在图片节点上、随任务快照提交

**存在 `CanvasImageNodeData.maskDataUrl`**（见 [types.ts](../frontend/src/types.ts)）。挂在图片节点而
不是提示词节点：蒙版描述的是「这张图的哪块要改」，换提示词重画同一个区域是常态，蒙版该跟着图走；
一张图只保留一份蒙版，再次涂改就是覆盖。节点上给了角标（[CanvasNodes.tsx](../frontend/src/components/CanvasNodes.tsx)
的 `maskBadge`）：蒙版会一直跟着图走，后续每次以它为参考图都按蒙版重绘，没有可见提示的话用户会忘掉
自己设过，生成结果不对还找不到原因 —— 所以角标本身就是按钮，点一下清除（`onClearMask`）。放左上角，
因为右上角已被「文件缺失」占用。

**为什么不用临时文件、不用 UploadFile。** 任务可能排队很久。上传成文件意味着「提交那一刻」就要落盘，
而真正发请求可能在几分钟后：临时目录会被系统清掉，用户中途取消任务会留下孤儿文件。所以传的是
**data URL 文本**（`GenerateParams.maskDataUrl` → [api.ts](../frontend/src/api.ts) 里 `submitGenerate()`
的 `formData.append("mask", ...)` → [server.py](../server.py) 的 `mask: str = Form("")` →
[tasks.py](../core/tasks.py) 的 `GenerationTask.mask_data_url`），字符串随任务对象一起活着。落盘推迟到
`generate_image()` 里由 `data_url_to_temp_png()` 完成，且函数返回前（含异常路径）在 `finally` 里删掉。
为什么最后还是必须落一次盘：上游 multipart 只认**二进制文件**，把 data URL 文本直接当字段内容发过去，
服务端会按「不是图片」回 400。这层是纯技术妥协，所以被压到最靠近网络的那一个函数里，别处都看不见
临时文件。

**`img2img` 判定：`bool(bases) or bool(task.mask_data_url)`。** `run_generation()` 里这一行决定输出
文件名前缀（`img2img_` / `txt2img_`）与走哪个接口。加了 `or bool(task.mask_data_url)` 之后：**有蒙版
一定走 edits**，因为 generations 没有 mask 语义。`bases` 为空时这里**不提前跳过**，只把 `mask_data_url`
传下去，让 [core/api.py](../core/api.py) 抛「mask 需要至少一张底图（image_path / images）」：错误信息
集中在一处，且**绝不静默丢参数** —— 静默丢参数是最难排查的一类 bug（任务「成功」了，图就是没按蒙版
改）。前端也有一道同向的提前拦截（`runNodeInternal` 里 `maskDataUrl && snapshot.length === 0`），它只
省一次必然失败的往返，不替代后端那道守卫：前端管「别让用户白等」，后端管「别让参数静默消失」。
messages 文案因此分三支：「蒙版重绘 · 参考图 N 张」/「蒙版重绘 · 无参考图」/「图生图 · 参考图 N 张」。

## 7. 一个提示词节点只支持一张蒙版

后端 `generate_image()` 只接受一个 `mask_path` / `mask_data_url`（一次 multipart 只塞一个 `mask` 字段），
所以提示词节点的入边参考图里最多只能有一张带蒙版。`runNodeInternal()` 的守卫：`masked.length > 1` →
**明确报错中止**，日志写「参考图里有 N 张设置了蒙版，一次只能带一张蒙版」；`=== 1` → 取那张的 data URL
提交；`=== 0` → 不带 mask 字段（不是带空串）。

为什么不能「随便挑一张」：挑错就是**拿 A 图的蒙版去改 B 图**。上游不会报错 —— 它会老实按 A 的蒙版在 B
上重绘，产出一张几何上合理、内容上完全错位的图。这类错误没有自动检测手段（蒙版与底图尺寸一致时连
尺寸校验都能过），唯一的防线就是在提交前把选择权还给用户。守卫放在 `runNodeInternal()` 而不是运行按钮
的 `disabled` 上：能不能跑是「有没有 prompt / 有没有在跑」的问题，而蒙版冲突是**入边图**的属性 ——
改了入边连线不会重算按钮状态，只有提交那一刻的快照才是真相。

## 8. 设计取舍汇总

| 取舍 | 选了什么 | 为什么 | 代价 |
|---|---|---|---|
| 用户模型 vs 上游口径 | 界面「涂 = 要改」，导出时反转成「透明 = 重绘」 | 用户不必理解 alpha，反转只写一处 | 多一段合成代码，改错会静默错图 |
| 坐标单位 | 归一化 0..1 + 短边比例 | 窗口缩放不错位、跨分辨率粗细一致 | 每次渲染要乘宽高，多一个易混的坐标空间 |
| 采样点数量 | 节流（0.004）+ 按 `radiusPx / 4` 插值 | 高频事件不撑爆数组，笔迹仍连续 | 两种「补点」规则要分清（节流 vs 插值） |
| 蒙版存放位置 | 图片节点的 `data.maskDataUrl` | 蒙版属于图不属于提示词，换提示词可复用 | 节点 data 变大，工作流里塞了 base64 |
| 传输格式 | data URL 字符串，不落盘 | 任务可能排队很久，临时文件会被清掉 | 提交体积变大，后端要解码一次 |
| 多蒙版 | 报错中止 | 随便挑一张 = 拿 A 的蒙版改 B | 用户要手动清掉多余的蒙版 |
| 空蒙版 | 确认按钮禁用 + 提示 | 空蒙版 = 整图重绘，花钱白干 | 用户第一次用时要点一下才明白 |

## 9. 已知边界与不做的事

| 边界 | 现状 | 备注 |
|---|---|---|
| 蒙版形状 | 只有圆头笔刷，没有矩形 / 套索 / 魔棒 | 圆点序列已覆盖绝大多数「涂一块」的需求 |
| 撤销 | 只有「清除全部」，没有逐笔撤销 | 节点级有画布撤销（`recordHistory()`），够回退 |
| 工作流 JSON | 蒙版以 base64 内嵌 | 大图 + 蒙版会让工作流文件明显变大 |
| 服务端校验 | 不解析 PNG 像素，只校验 data URL 格式 | 语义靠约定，不靠运行时检测 |

## 10. 相关文件与测试

| 文件 | 作用 |
|---|---|
| [core/api.py](../core/api.py) | `data_url_to_temp_png()` / `generate_image()` 的 mask 参数与 alpha 约定 |
| [core/tasks.py](../core/tasks.py) | `GenerationTask.mask_data_url`（随任务排队的 data URL） |
| [server.py](../server.py) | `/api/generate` 的 `mask` 表单字段、`img2img` 判定、messages 文案 |
| [frontend/src/maskBrush.ts](../frontend/src/maskBrush.ts) | 纯几何层（归一化坐标、节流、插值、空判定、包围盒） |
| [frontend/src/components/MaskBrushDialog.tsx](../frontend/src/components/MaskBrushDialog.tsx) | 笔刷对话框与 `exportMaskDataUrl()` |
| [frontend/src/components/CanvasNodes.tsx](../frontend/src/components/CanvasNodes.tsx) | 「蒙版重绘」入口与蒙版角标 |
| [frontend/src/api.ts](../frontend/src/api.ts) | `submitGenerate()` 的 `mask` 字段 |
| [frontend/src/types.ts](../frontend/src/types.ts) | `GenerateParams.maskDataUrl` / `CanvasImageNodeData.maskDataUrl` |

测试分布（用例数不在此重复，口径见 [tests/README.md](../tests/README.md)）：后端
[test_core_api.py](../tests/test_core_api.py) 的 `test_mask_*` 系列（字段名、临时文件清理、无底图报错、
`mask_path` 优先于 data URL、非法 data URL、不传 mask 时行为不变）与
[test_server_generate_mask.py](../tests/test_server_generate_mask.py)（Form 透传与 strip、强制图生图、
无底图时错误冒泡到任务、messages 文案）；前端 [maskBrush.test.ts](../frontend/src/maskBrush.test.ts)
（几何、节流、插值、空判定）与 [MaskBrushDialog.test.tsx](../frontend/src/components/MaskBrushDialog.test.tsx)
（导出 alpha 语义、空蒙版禁用确认）。

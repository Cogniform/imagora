# tests/ — 测试层（pytest 后端 + vitest 前端）

FastAPI 路由级 + 纯逻辑测试，**不调真实上游 API、不花钱**。前端测试同前端仓库（`frontend/src/*.test.ts*`）。

## 本地常用命令（在项目根目录执行）

```powershell
# 后端全量（467 用例）
.\.venv\Scripts\python.exe -m pytest
# 按模块筛选
.\.venv\Scripts\python.exe -m pytest tests/test_core_config.py tests/test_server_helpers.py
# 前端（frontend/ 目录内）
cd frontend; npm test
```

## 该目录特有坑

- **默认临时目录即可**：历史上 `%TEMP%\pytest-of-speak` 的 ACL 被改坏（多为管理员权限进程遗留）导致 setup 报 WinError 5，需 `--basetemp` 绕开；该目录已清理重建，默认路径恢复正常。若再遇到 WinError 5：提权执行 `takeown /F "%LOCALAPPDATA%\Temp\pytest-of-speak" /R /D Y` 后删掉该目录即可（pytest 自动重建）
- **用户数据默认隔离（autouse `isolate_user_data`，见 conftest.py）**：输出目录 / 注册表 / 工作流 / 账本 / 预算一律指向 `tmp_path`。历史上 `asset_iso` 是 opt-in，漏用的用例会把测试图片写进真实 `output/.assets`（实测：跑一次 pytest 就多出 3 个假资产，反复复现）——新增用例无需再声明夹具，但**不得构造指向真实用户目录的路径**
- **5 个 Windows 专属测试**：netstat 端口探测 / powershell 父进程链 / C: 绝对路径 / 跨盘相对化——只在 Windows 通过；CI 相关 Job 必须 `windows-latest`
- 路由测试直接 `from server import ...`（import 即建 FastAPI app，属预期）
- **测试数字是 AGENTS 仪表盘数据源**：增/删测试用例必须同步 AGENTS「当前仪表盘」；数字意外变化（非新增导致）必须报告维护者
- **别按变量名读断言**：`test_core_api.py` 里的 `calls["n"] == 3` 是**重试次数**计数器，与生成张数无关。看名字以为"多张已覆盖"过一次误判（CLI `--n` 的真覆盖在 `test_main_cli.py`，见 issue #34）

## 文件索引（后端 pytest，共 467）——每个 test_*.py 测什么

| 文件 | 用例 | 覆盖 |
| --- | --- | --- |
| [`test_core_api.py`](test_core_api.py) | 24 | 尺寸解析 / 默认输出路径（并发唯一）/ 错误格式化 / 写文件瞬时锁重试 / **蒙版局部重绘（mask_data_url 落临时文件并进 multipart 的 `mask` 字段、临时文件必删、无底图时报清晰错误、mask_path 优先、data URL 非法报错）** |
| [`test_core_batch.py`](test_core_batch.py) | 10 | 配置读取 / 路径解析 / 模块过滤 / dry-run |
| [`test_core_config.py`](test_core_config.py) | 26 | API Key 跟随 profile / profile 解析优先级与缺失回退 / 白名单校验 / RATIOS 表结构 / **配置来源视图（值 + 来自哪一层、.env 与系统环境变量区分、密钥不回传值）** / **`normalize_model_id` 只在当前 profile 内折叠连字符、不跨 profile 借名** |
| [`test_core_config_override.py`](test_core_config_override.py) | 16 | `.env` 本机覆盖通道（`BASE_URL_` / `MODEL_` / `API_PATH_<PROFILE>`）：**未设环境变量时行为与没有覆盖时逐字相同**、覆盖只影响自己那一个键、只对当前 profile 生效、换 profile 后覆盖跟着换、空值视为未设置、来源标注区分 `.env` 与系统环境变量、删掉覆盖行后回到 config.json profile、非覆盖键没有环境变量名 |
| [`test_core_config_write.py`](test_core_config_write.py) | 21 | `.env` 行级原地更新：注释/空行/键顺序原样保留、引号风格与缩进保留、CRLF 不混用、**留空 = 不修改**、注释掉幂等（清空密钥可手工恢复）、`.bak` 备份与原子写、写失败清理临时文件且原文件不受损 |
| [`test_server_config_write.py`](test_server_config_write.py) | 30 | 写配置路由：三层防护纯函数（本机 / Origin 白名单 / 令牌比对 / profile 名挡路径穿越）、`GET /api/config` 不回传密钥值、写入保留注释、留空不修改、**写完当场生效不留 pending**、手工改文件仍如实报 pending、**mtime 不匹配 409 且磁盘不变**、清空密钥是注释而非删除、需要 confirm |
| [`test_server_config_profile.py`](test_server_config_profile.py) | 7 | 切 profile：写 `ACTIVE_PROFILE` 且注释与未改的键保留、未注册的 profile 被拒（400 且磁盘不变）、profile 非字符串被拒、切 profile 计入 pending、profile 与字段可同一次写入、`fileState` 下发注册名单、文件值与生效值不同时报 pending |
| [`test_core_provider_store.py`](test_core_provider_store.py) | 67 | 本机来源层（`providers.local.json`）：**profile 名收紧到全小写**（会进 `.env` 键名与 URL）、地址必须 http(s) 且末尾斜杠自动去掉、协议预设（openai 带 `/v1` / ark 已含版本号 / custom 手填路径）、**地址与路径的版本段去重**（`/v1` 地址 + `/v1` 路径不再拼成 `/v1/v1`，只剥完全相同的版本段）、表单→profile 形状（8 档尺寸单价全 0、7 个比例、模型目录嵌入）、**profile 里绝不出现密钥**、读取宽容（缺失/坏 JSON/单条坏掉不牵连）、合并（**本机优先且重名告警**、不改入参）、落盘（重名拒绝含出厂重名、保留既有条目、`.bak` 备份、校验失败不落盘、UTF-8 不转义） |
| [`test_server_config_providers.py`](test_server_config_providers.py) | 35 | 新增来源路由：写 `providers.local.json` + 密钥写 `.env`、**不动 config.json**、**密钥不进本机来源文件**、默认不切换（显式 `activate` 才写 `ACTIVE_PROFILE` 并计入 pending）、重名/坏名/坏地址 400、探测模型（传 url 与 key、无 key 时按 name 回落环境变量、坏地址 400、网络错误包成 `probe_failed`、**探测不写任何文件**）、两条路由继承 `/api/config` 三层防护 |
| [`test_core_cost.py`](test_core_cost.py) | 21 | 账本聚合（成功/失败计数、成功率、费用只算成功行、按天窗口与倒序、按尺寸/模式、坏行与脏类型容错、空账本）/ 今日花费 / 预估费用（已知/未知尺寸、非法张数）/ 预算规范化与读写（缺失/损坏/原子写无残留）/ 超预算判定（不限放行、单次上限、当日已花+预估、双限、remaining） |
| [`test_core_logging.py`](test_core_logging.py) | 8 | 日志写入 / 并发串行 / 路径相对化 |
| [`test_core_history.py`](test_core_history.py) | 16 | 历史读取 / 坏行容忍 / 筛选 / **搜索换行归一（CRLF 粘贴可命中）** / **同参数聚合（失败去重只留最新、成功吸收失败、时间不算参数、任一参数不同不合并、inputAssetIds 参与判定）** / **分页（聚合后切片与 total、offset 越界、与搜索/状态一致）** / backfill（报告·补齐·幂等·跳过无法反查·坏行保留） |
| [`test_core_canvas.py`](test_core_canvas.py) | 32 | 注册表（v2+v1 兼容）/ 内容去重 / import 边界 / kind 来源标签 / workflow 归一化与自愈 / recovery / submission / persist_submission_assets |
| [`test_core_imageinfo.py`](test_core_imageinfo.py) | 10 | PNG/JPEG/GIF/WebP/BMP 头解析 / 垃圾与截断返回 None |
| [`test_core_migrate.py`](test_core_migrate.py) | 19 | 注册表 detect/升级/重建/回填/迁目录 / 工作流升级 / CLI 端到端 |
| [`test_core_tasks.py`](test_core_tasks.py) | 11 | 任务状态机 / 并发上限 / 取消 / 快照 / TTL 清理 |
| [`test_core_pathtrust.py`](test_core_pathtrust.py) | 2 | 路径白名单（match_roots 双根/单根/跨盘） |
| [`test_server_helpers.py`](test_server_helpers.py) | 27 | 窗口分配 / 安全路径白名单 / upload-ref / delete-ref / generate 同步性 / history 注册表解析 + inputRefs/inputRefMissing / **/api/history 分页 hasMore** / _persist_submission 含 temp_bases / 导入与展示同源（注册表副本 + 账本 output 原路径双收，含画布回流回归）/ **静态产物 MIME 钉死（不受 Windows 注册表 `.js` 被写成 text/plain 影响）** |
| [`test_server_canvas.py`](test_server_canvas.py) | 18 | canvas 路由 / workflow 往返（v2）/ missing 收集 / ref_paths 放行 |
| [`test_server_tasks.py`](test_server_tasks.py) | 10 | generate 提交即返回 / multipart 临时文件清理 + temp 参考图注册账本 / **参考图提交时注册（源文件删后账本仍完整）** / 保存消息为绝对路径 / 路径校验 / 任务路由 |
| [`test_server_generate_mask.py`](test_server_generate_mask.py) | 7 | 蒙版重绘链路：`/api/generate` 收 `mask` Form（空白视为未传、去掉首尾空白）并进 `GenerationTask` / `run_generation` 把 mask 转交 `generate_image` 且**强制走图生图**（无参考图时 `images=[]` 交给 core 报错、不静默跳过、消息记「蒙版重绘 · 无参考图」）/ 无 mask 时行为逐字不变 |
| [`test_server_cost.py`](test_server_cost.py) | 15 | /api/history/stats 聚合与 days 窗口、空账本 / 预算读写（默认不限、落盘回读）/ /api/budget/check 预检（按张数、按 items、单次上限边界）/ /api/generate 预算闸门（超限 409 → 确认后放行、不限不拦）/ /api/generate/batch（合法提交 + 空提示词/坏参考图逐条跳过、空 items 400、全非法不提交、超预算未确认不提交、确认后提交） |
| [`test_main_process.py`](test_main_process.py) | 4 | 端口探测 / 祖先链回溯（Windows） |
| [`test_main_cli.py`](test_main_cli.py) | 31 | CLI gen 子命令全链路（校验/输出解析/文生图+图生图+多参考/失败/--no-asset/比例档位）/ **`--n` 逐张请求（每次 `n=1`、各存各的账、部分失败保留已成功、默认单张行为不变）** / config 输出 |

## 文件索引（前端 vitest，共 1040，位于 frontend/src/）

| 文件 | 用例 | 覆盖 |
| --- | --- | --- |
| [`layout.test.ts`](../frontend/src/layout.test.ts) | 29 | 分层布局 / 复杂连接 / 局部整理不漂移 / 多对多摊平 |
| [`workflow.test.ts`](../frontend/src/workflow.test.ts) | 58 | 自动连线 / 动画类 / 连线约束 / 落点阶梯 / 节点构建器 / **updatePromptNode 幂等（无变化不产生新引用，防 running 逐秒重渲染）** / **canConnect 连线规则（组连组中转）** / **computeCounts 组链递归聚合 + 去重口径（重复条目数）+ 防环** / **引用溯源（数据最终流到的提示词数）** / **collectIncomingImages 嵌套组链展开** |
| [`promptRefs.test.ts`](../frontend/src/promptRefs.test.ts) | 34 | 提示词 `@` 引用解析：`@name` / `@{my cat.png}` / `@@` 转义 / `@` 前必须是行首·空白·标点（挡 `user@example.com`）/ **最长匹配靠贪婪 tokenize**（`@cat.png.bak` 不退化到 `cat.png`）/ 零 token 判 `all`、全对上判 `explicit`、有对不上判 `invalid` 且仍返回能对上的 / 同名候选不丢弃 / `stripPromptRefs` 只剥标记不改正文 |
| [`maskBrush.test.ts`](../frontend/src/maskBrush.test.ts) | 30 | 蒙版笔刷几何：坐标归一化 0..1（存像素窗口一缩放就错位）、`size` 占**短边**比例（4K 与 512 视觉粗细一致）、`appendPoint` 节流命中返回**原数组引用**（pointermove 每秒上百次，不节流数组会涨到几十万点）、`interpolatePoints` 在**像素空间**量距离（归一化空间在 16:9 图上横竖疏密不一）、`hasPaint` 只认 paint 笔画（只擦不涂等于没涂）、`maskBoundingBox` 每点减半径并夹回 [0,1] |
| [`customValue.test.ts`](../frontend/src/customValue.test.ts) | 23 | 自由输入的纯函数层：归一化只折空白**不折大小写**（模型 ID 是上游字面标识）、**不做格式校验**（前端猜格式就会拦掉合法值）、只挡空与超长、清单里已有的值不造新选项、`mergeCustomOption` 未变更时返回**入参数组本身**（引用相等，否则 Select 内部 useMemo 全部失效） |
| [`contextMenu.test.ts`](../frontend/src/contextMenu.test.ts) | 29 | 右键菜单内容与定位：按节点类型给动作（图片给裁剪/放大/切分/替换、提示词给运行/复制）、`selectedCount > 1` 才置顶「删除选中」、图片无 url 时裁剪/放大/切分/蒙版 disabled 而**替换不禁用**（换图是丢图后的自救入口）、多选时给「仅删除此项」、**蒙版重绘项只在图片节点出现**、`clampMenuPosition` 四边夹紧、`menuHeight` 按项数算、`isMenuDismissKey` 只认 Escape/Tab |
| [`edgeStyle.test.ts`](../frontend/src/edgeStyle.test.ts) | 36 | 连线四态样式：优先级 `selected > hovered > dimmed > idle`、`dimmedEdgeIds` 两端都不在选中集才降权且选中集为空返回 `[]`（不是全部淡出）、宽度/透明度/描边查表、dimmed 关掉流动动画（淡线还跑动画比不降权更吵） |
| [`canvasDrop.test.ts`](../frontend/src/canvasDrop.test.ts) | 14 | 拖拽意图解析 / 文件识别 / 数量统计 / 示意文案 / isInsideRect |
| [`previewZoom.test.ts`](../frontend/src/previewZoom.test.ts) | 5 | 缩放范围 / 平移夹紧 |
| [`canvasHistory.test.ts`](../frontend/src/canvasHistory.test.ts) | 5 | 撤销 / 恢复 / 新分支清空 |
| [`canvasStyles.test.ts`](../frontend/src/canvasStyles.test.ts) | 4 | 动效 CSS 选择器约束 |
| [`recovery.test.ts`](../frontend/src/recovery.test.ts) | 4 | 快照剥离动画类 / 运行期字段清除 |
| [`useGenerationTask.test.ts`](../frontend/src/useGenerationTask.test.ts) | 8 | hook 稳定成员引用 + **超预算确认（409→确认→带 allowOverBudget 重提、取消则抛出、同实例只问一次、非 409 不触发确认）** |
| [`useImageZoom.test.ts`](../frontend/src/useImageZoom.test.ts) | 4 | 单击开原图 / 双击放大时序（fake timers）/ 卸载清理 |
| [`useImageEditorViewport.test.ts`](../frontend/src/useImageEditorViewport.test.ts) | 28 | 图片编辑器视口 hook：`fitImageToViewport` 缩放上限 1、`imageEditorContentSize` 保证居中可算、以指针为锚点的两段式缩放（先记锚点再 `useLayoutEffect` 反算 scrollLeft/scrollTop）、滚轮按 `passive:false` 注册且不冒泡、空格/中键拖拽判定、缩放边界（`canZoomIn`/`canZoomOut` 带 0.001 容差）、`ResizeObserver` 缺失守卫。**测试必须桩 `clientWidth`/`clientHeight`/`getBoundingClientRect`/`scrollLeft`**（jsdom 恒 0 且不可写），且 afterEach 先卸载实例再还原原型桩（否则多实例抢同一个 window 监听、假通过） |
| [`logPath.test.ts`](../frontend/src/logPath.test.ts) | 6 | 日志路径词条解析（绝对/相对、正反斜杠、多路径、扩展名大小写） |
| [`generationPending.test.ts`](../frontend/src/generationPending.test.ts) | 11 | 渐近进度曲线单调递增并逼近 98% 但永不越过（最后 2% 留给真实完成）、首秒即从 10% 起步、非法入参（NaN / ±Infinity / 负数）按 0s 处理绝不产出 `NaN%`、文案每 2s 轮播并循环 |
| [`imageOps.test.ts`](../frontend/src/imageOps.test.ts) | 49 | 裁剪/放大几何：`clampCrop` 最小尺寸与越界回收、`moveCrop` 与 `resizeCrop` 八向手柄、`fitCropToRatio` 保持中心收缩到能放下的最大尺寸（像素比与归一化比的换算必须乘框宽高比）、`resolveUpscaleSize` 长边上限与非法入参、`gcdRatio` 约分（含不可约分尺寸）、`centeredSquareCrop` 默认框。**B 层 canvas I/O 不测**（jsdom 的 `getContext("2d")` 返回 null） |
| [`dataUrlFile.test.ts`](../frontend/src/dataUrlFile.test.ts) | 16 | dataUrl → `File` 转换（base64 与百分号编码两种载荷；非法输入**抛错而不是返回空 File**，0 字节上传会在画布多出永远加载失败的红框节点）、派生文件名（前缀 + 原名清洗 + 时间戳 + 扩展名，长度精确断言） |
| [`aspectIcon.test.ts`](../frontend/src/aspectIcon.test.ts) | 12 | 比例图标几何：`aspectIconSize` 长边固定 24、短边按比例算且不低于 10（再矮就看不出是矩形）、横竖两个分支都只动短边、非法比例（NaN / 0 / 负数 / Infinity）回落正方形；`ratioFromSizeLabel` 三层解析（括号内 `a:b` → 裸 `a:b` → `WxH` 宽高比），**括号里只有中文方位词（如 `1024x1792 (竖版长图)`）必须退回宽高比**，否则这两项没有图标 |
| [`canvasGeometry.test.ts`](../frontend/src/canvasGeometry.test.ts) | 53 | 视口聚焦 / 带进视野与分组几何（移植 basketikun，MIT）：`nodeBounds` 空数组返回退化盒而不是 ±Infinity、`containsCenter` 用**中心点**判归属（整体包含会让大节点永远拖不进组）、`findGroupDropTarget` 倒序遍历让上层 group 优先且被拖集合含 group 时返回 null（禁止组嵌套组）、`snapNodesIntoGroup` 超宽贴左否则贴右、`getGroupWrapRect` 顶部多留 52 给工具栏、`focusViewportForNode` 的 60% 上限与下方有面板时的 3:1 上推、`revealViewport` **只平移不改 `k`**（已可见返回 null、目标大于可用区时左上对齐、留白大于视口时退化不留白、非法输入不产出 Infinity） |
| [`imageSplit.test.ts`](../frontend/src/imageSplit.test.ts) | 30 | 切分几何：`clampGrid` 的 NaN / 超上限 / 小数取整且 1×1 合法（等于不切，不强行抬到 2）、`splitCells` 行优先且**用 `col/cols` 直算不累加**（累加会漂）、格子边界不重叠且覆盖满 0~1、`splitCellsByLines` 排序去重 + 丢弃贴端点的线 + 空线返回单格、`splitOutputName` 命名格式与非法字符清洗。`splitDataUrl` 不测（jsdom 无 2D context） |
| [`modelIcon.test.ts`](../frontend/src/modelIcon.test.ts) | 22 | 模型品牌识别：9 类品牌各自的 `includes` 命中、匹配顺序（`claude` 先于 `openai`）、`dall-e-3` 归 openai、大小写不敏感、**全角连字符 U+2011 归一化后仍能认出 `gpt`**（中转站真实踩过的坑）、空串与未知模型回落 `unknown`、每个品牌都有非空字形与中文名 |
| [`snapGuide.test.ts`](../frontend/src/snapGuide.test.ts) | 38 | 拖拽吸附纯函数：左/中/右与上/中/下三对齐线取最近目标、x 与 y **独立决策**（可能只吸一轴）、阈值用严格 `<`（等于阈值不吸）、无邻居或全部超阈值时**原样返回不做任何位移也不偷偷退回网格**、`snapToGrid` 的 8px 对齐（含负坐标与小数）且 guides 恒空、NaN / Infinity / step<=0 安全退化不抛错（每帧拖拽都跑，抛错会让画布白屏） |
| [`snapDrag.test.ts`](../frontend/src/snapDrag.test.ts) | 22 | 吸附接线层（纯函数 → React Flow `NodeChange`）：只拦 position 变更、多选拖拽按主节点算位移后整体平移、吸附位移写回 `position` 与 `positionAbsolute` 两个字段（少写一个节点会瞬移回原位）、对齐线只在拖拽帧产出、松手帧返回空 guides |
| [`snapGuidesStore.test.ts`](../frontend/src/snapGuidesStore.test.ts) | 9 | 对齐线外置 store：拖拽每帧 `setSnapGuides` 时**按内容逐条比对**（同一组线重复写入不产生新快照），快照引用稳定 + `getSnapGuides` 返回同引用（否则 `useSyncExternalStore` 会死循环渲染）、订阅/退订、松手清空后通知一次 |
| [`SnapGuides.test.tsx`](../frontend/src/components/SnapGuides.test.tsx) | 7 | 对齐线渲染组件：`axis` 决定竖线/横线、空快照不渲染任何线、位置只走 `style`（不进 React state）、订阅 store 后随变化重绘、卸载即退订（避免拖拽残留线） |
| [`ImageSplitDialog.test.tsx`](../frontend/src/components/ImageSplitDialog.test.tsx) | 13 | 切分对话框：五个预设按钮与 `aria-pressed`、行列手填即时夹到 1~8、网格预览格子数（`split-cell` 数量）随行列变化、1×1 时确认禁用、文件名预览、确认后 `splitDataUrl` 收到 `{rows, cols}` 且 `onConfirm` 拿到数组、失败显示 `role="alert"` 且不回调。`vi.importActual` 部分替身只换 `splitDataUrl` / `readImageSize` |
| [`minimapVisible.test.ts`](../frontend/src/minimapVisible.test.ts) | 16 | 画布小地图显隐与缩放滑杆偏好：默认值（小地图默认关、滑杆默认 100%）、`zoomToSliderPercent`/`sliderPercentToZoom` 互为反函数往返、NaN/±Infinity 夹到端点而不抛错、localStorage 不可用时静默降级 |
| [`minimapColor.test.ts`](../frontend/src/minimapColor.test.ts) | 6 | 小地图节点取色（从 CanvasPage 抽出的模块级纯函数）：提示词用品牌色、图片/图片组两档中性灰、未知类型走更深的兜底色（旧工作流文件的 `node.type` 未必在当前三类里）、只做类型映射不读 DOM 与主题实值 |
| [`rankByName.test.ts`](../frontend/src/rankByName.test.ts) | 10 | 模糊排序：query 是 name 的大小写不敏感**有序子序列**（`gi25` 命中 `gpt-image-2.5`）、边界命中加分优先、相邻匹配加分、跳跃扣分、空 query 返回**同一数组引用**、全角 U+2011 折叠后比对 |
| [`optionGroups.test.ts`](../frontend/src/optionGroups.test.ts) | 6 | 分组归并：组间按首次出现顺序、组内保持源顺序、无分组的项归入空标题兜底组、全部无分组时返回单组、混合时兜底组排最后 |
| [`CanvasNodes.test.tsx`](../frontend/src/components/CanvasNodes.test.tsx) | 33 | 节点操作栏（含**蒙版重绘**入口）/ **提示词卡取消入口**（排队·生成中出现、`cancelRequested` 变「取消中…」并禁用、就绪/终态不出现）/ 双击行为 / 组卡去重提示渲染 / **蒙版角标只在带蒙版时出现，点一下即清除** / **`ImageNode` 与 `GroupNode` 的 memo 浅比较**（父组件重渲染但 props 全等时函数体不执行，用 getter 计数取证） |
| [`CanvasPage.baseline.test.tsx`](../frontend/src/components/CanvasPage.baseline.test.tsx) | 58 | **CanvasPage 拆分护栏**（唯一渲染整页的文件）：`@xyflow/react` 走自建桩、真实渲染 `nodeTypes[type]`，钉住「拆了就崩」的接线——`nodeTypes` 身份在节点坐标变化时不变（否则全节点重挂）、14 个 deps 的回调身份、`modalOpen` 十条来源全为 true（拖放互斥）、撤销/重做与 Ctrl+A/Ctrl+S、吸附接线（`applySnapToChanges` 只拦 position）、右键菜单四项、保存/加载、任务状态机的 status 流转、**取消入口（issue #33）**（单卡取消→不立刻复位 / 终态清标记 / 视图说没在取消就退回可点（本机意图由 hook 合成）/ 工具栏「取消全部 (n)」只取消在跑任务）、画布偏好读写、counts 统计随节点增删刷新 |
| [`Field.test.tsx`](../frontend/src/components/Field.test.tsx) | 8 | 字段壳：label 与控件经 id 关联、`hint` 与 `error` **共用同一个消息槽位**（invalid 时 error 顶掉 hint、任何时刻至多一行）、`aria-describedby` 无内容时不写空串、`aria-invalid` 条件展开、`action` 插槽渲染 |
| [`GenerationPending.test.tsx`](../frontend/src/components/GenerationPending.test.tsx) | 7 | 生成中占位卡：`role="status"` + `aria-live` 语义、受控 `elapsed` 优先于自走表、进度条只改 `transform: scaleX()`（不给 width 做动画）、文案随秒数轮播 |
| [`ImageCropDialog.test.tsx`](../frontend/src/components/ImageCropDialog.test.tsx) | 7 | 裁剪对话框：比例预设按钮（`aria-pressed`）、八向手柄拖拽的位移换算（先除 stage 宽高再交给 `resizeCrop`）、遮罩用 `boxShadow` spread 覆盖整块视口、确认回传 dataUrl、取消关闭。测试用 `vi.mock("../imageOps", …)` 部分替身（`vi.importActual` 展开真身、只换 `readImageSize` / `cropDataUrl` 两个 canvas I/O 函数），几何纯函数全走真实实现 |
| [`ImageUpscaleDialog.test.tsx`](../frontend/src/components/ImageUpscaleDialog.test.tsx) | 9 | 放大对话框：目标长边预设与自定义、默认值（原长边 ×2 且夹在 [1024, 4096]）、换算文案（`原 1024×768 → 2048×1536（2.0×）· 显示比例 4:3`）、busy 时按钮文案变化**必须按 `data-testid` 查不能按文本**（文案会变导致按名查丢）、卸载后迟到的放大结果不再回调 `onConfirm` |
| [`MaskBrushDialog.test.tsx`](../frontend/src/components/MaskBrushDialog.test.tsx) | 13 | 蒙版笔刷对话框：涂改笔画累积 / 橡皮擦 / 笔刷粗细滑杆 / 清除 / **空蒙版时确认按钮禁用并给提示**（空蒙版等于整图重绘，花钱白干）/ 确认回传与原图同尺寸的 PNG data URL。jsdom 的 `getContext("2d")` 返回 null、`toDataURL` 抛 not implemented，故桩 `toDataURL` |
| [`NodeContextMenu.test.tsx`](../frontend/src/components/NodeContextMenu.test.tsx) | 14 | 节点右键菜单：`role="menu"` 语义与每项 `role="menuitem"`、点外部 / Escape / Tab / resize / scroll 关闭、**disabled 项用 `aria-disabled` 而不是原生 disabled**（原生会让键盘焦点跳过）、挂载时 pushPopup 让 Esc 先收菜单、贴底右键不出屏（量真实高度再夹） |
| [`ProviderModal.test.tsx`](../frontend/src/components/ProviderModal.test.tsx) | 22 | 添加第三方供应商弹窗：Provider ID 正则与地址协议的即时校验、协议预设切换与路径联动、探测模型（成功切下拉并选第一个 / 失败留文本框 / 「手填」可切回自由输入）、提交与错误提示 |
| [`ModalShell.test.tsx`](../frontend/src/components/ModalShell.test.tsx) | 5 | 弹窗基座：dialog 语义 / 面板与遮罩点击分流 / Esc 关闭与焦点归还 / **下拉展开时 Esc 先收下拉、不关弹窗** |
| [`Select.test.tsx`](../frontend/src/components/Select.test.tsx) | 28 | 自定义下拉：listbox 语义 / 键盘导航 / 点外部关闭 / **展开列表挂到 body（不被滚动容器裁切）** / **自由输入（`allowCustom`：精确命中走正常选中、校验不过时 Enter 什么都不做、清单为空也能展开、自定义行放在 listbox 之外）** |
| [`popupLayer.test.ts`](../frontend/src/popupLayer.test.ts) | 5 | 浮层计数：push/pop 配对、嵌套多层、**多余 pop 不弄成负数**（否则弹窗再也关不掉）/ reset |
| [`ResultPanel.test.tsx`](../frontend/src/components/ResultPanel.test.tsx) | 7 | 结果区 5 态面板 / 切换交叉淡化（旧层保留至淡出移除） |
| [`WorkflowModals.test.tsx`](../frontend/src/components/WorkflowModals.test.tsx) | 2 | ZoomModal Portal 点击隔离（点图片/空白不误关外层宿主遮罩） |
| [`HistoryGallery.test.tsx`](../frontend/src/components/HistoryGallery.test.tsx) | 14 | 列表行渲染 / 参考图缺失琥珀提示 / 失败文案 / 提示词截断浮层（仅截断弹、跟随、离开消失） / **分页（首屏第 0 页、点加载更多按 offset 追加、搜索与状态筛选重置第 0 页、滚动接近底部自动追加、远离底部不触发）** / **成本看板指标、每行按钮与成败无关（复制 / 打开目录 / 导入画布）、参考图丢失只给条数提示且无重跑入口、保存预算回读** |
| [`promptImportFormat.test.ts`](../frontend/src/promptImportFormat.test.ts) | 23 | 导入格式解析容错 / 尺寸映射 / 建卡 / **`importCardPositions` 按卡片真实尺寸铺排**（旧实现用 30px 栅格而卡片宽 380，整批导入会完全叠住；现按 420×326 间距、每行 3 张） |
| [`cost.test.ts`](../frontend/src/cost.test.ts) | 6 | 金额/比例/耗时格式化（非法值回退 -）/ 预算摘要（不限与设限两种、兼容预检结果的 settings 形态）/ 看板主指标行顺序与文案 |
| [`api-guards.test.ts`](../frontend/src/api-guards.test.ts) | 10 | `/api` 响应形状守卫（必填字段类型、可选字段「在但类型错」、多出的键放行）/ **providers 来源目录（缺字段放行、类型错拦下）** |
| [`apiCatalog.test.ts`](../frontend/src/apiCatalog.test.ts) | 18 | 按接口地址命中来源 / 跨来源按 id 找模型（全角 U+2011 连字符折叠）/ 尺寸解析优先级（模型自带 > 来源级 > 后端兜底）/ 单价摘要与提示 / **qualityAppliesTo：豆包 Seedream 不认质量档（含中转站代理豆包的情形）** |
| [`apiErrors.test.ts`](../frontend/src/apiErrors.test.ts) | 2 | 405 翻成人话（提示服务端是旧版本、需重开）；非 405 保持原始信息不误伤真实上游报错 |
| [`format.test.ts`](../frontend/src/format.test.ts) | 6 | `formatBytes` 三档与 1024 边界 / `generatingLabel` 文案 / `errMessage`（Error 与非 Error、超长才截断、恰好等于上限不截、limit 可覆盖） |
| [`accent.test.ts`](../frontend/src/accent.test.ts) | 12 | 同一编号恒定取色、`null` 回落 1 号、黄金角色相分布（含越过 360 回绕与 0 号负色相的现行为）、`brand` 与 `brandDark` 只差明度 / 色相归一到 [0,360) / NaN·Infinity 回落 0 不产出坏值 / 自定义色相与自动取色共用同一公式 / 读写往返（未设置读 `null`、存后读回、存越界先归一、传 `null` 清除、空白或非法视为未设置） |
| [`brand/logo.test.ts`](../frontend/src/brand/logo.test.ts) | 4 | 形状与 viewBox 取自 `logo.svg` 单一源 / 源文件只有一处 fill 声明（否则换色会漏改）/ `brandLogoSvg` 只换根元素 fill / 换色不动 xmlns 与 viewBox（favicon 缺 xmlns 不显示） |
| [`windowInherit.test.ts`](../frontend/src/windowInherit.test.ts) | 10 | 写读往返且不清除、`notice` 省略即不写该键、空参考图 `filesIncluded: false`、`sessionStorage` 抛错时放弃继承不抛错、无键 / 非 JSON / 顶层形状不符 / `refs` 字段类型不符 / `notice` 非字符串一律判无继承、清除不误伤其他键 |
| [`wallpaperStore.test.ts`](../frontend/src/wallpaperStore.test.ts) | 10 | IndexedDB 不可用降级（读 null、写 false、删不抛错）/ 全局缺失 `indexedDB` / `open` 抛异常 / `open` 触发 `onerror` 或 `onblocked` 均安静返回。成功读写路径由真机验证（jsdom 无 IndexedDB，且该全局连声明都没有，造替身必须先 `vi.stubGlobal`） |
| [`canvasBounds.test.ts`](../frontend/src/canvasBounds.test.ts) | 9 | 画布边界开关（默认开、只有 0/false 才关、空白与非法值回落、localStorage 不可用降级） |
| [`backgroundPreset.test.ts`](../frontend/src/backgroundPreset.test.ts) | 13 | 背景底色预设：清单 id 唯一且默认项在最前、每项标签与提示非空、不含深色预设（暗房/蓝图属独立工程）、只有跟随主体色 + 纯白两项、清单里不再有 `wallpaper` 字段（内置壁纸已移除）、两张内置壁纸与四个纹理预设的旧 id 均判为非法、`isBackgroundPresetId` 拒绝非字符串与未知 id、读写往返（每项合法预设都能往返）、非法存储值与旧 id 一律回落默认「跟随主体色」（不需要迁移脚本）、非法 id 不写进存储（不污染已有值） |
| [`surface.test.ts`](../frontend/src/surface.test.ts) | 19 | 卡片通透度：入参钳到 [0,1] 且空值回落默认、通透度越高各档 alpha 单调变小、通透度 0 落到基准（卡片 0.9/0.68）、拉到最透仍留 >0.2 白（保证文字可读）、`blurFor` 在任何通透度下都返回 `none`（毛玻璃已彻底关闭，不许随通透度增长）、输入框有 `FIELD_ALPHA_FLOOR = 0.25` 底线而卡片不受此限、面板始终比卡片实一档、色相参与底色并被归一、NaN 色相回落 0、读写往返与坏值回落 |
| [`surfaceAudit.test.ts`](../frontend/src/surfaceAudit.test.ts) | 6 | **表面审计护栏**：解析 index.css 与全部 .tsx，未登记的写死底色 / 硬编码 blur() 直接红；豁免清单必须有理由；六个角色类与消费方齐备 |
| [`wallpaperAdjust.test.ts`](../frontend/src/wallpaperAdjust.test.ts) | 11 | 壁纸模糊/明暗：入参钳到合法区间且空值·NaN 回落默认（模糊→0、明暗→1）、默认参数下只产出降噪不写 no-op 指令、模糊与明暗各自出现且降噪永远排最前、只调一项时另一项不出现、越界值先钳再拼绝不写进 CSS、小数保留两位、自定义降噪走同一拼装路径、写入后读回同值、写入前先钳制（存储不落越界值）、未设置/空白/非法一律回落默认 |
| [`recentPrompts.test.ts`](../frontend/src/recentPrompts.test.ts) | 10 | 最近提示词挑选：按入参顺序取（越靠前越新）不重排、同一条反复重跑只算一次并保留最靠前那次、**按前 40 字归并近似版本**且保留最新、前 40 字不同视为两条、归并键先归一连续空白（只差空格数算同一条）、丢弃空白与缺失项、裁剪首尾空白后再去重、受 `limit` 限制且取满即停、去重后不足 limit 返回全部、空入参返回空数组 |

## 变更影响路由（改前必看）

- 改 `core/registry.py` / `graphstore.py` → `test_core_canvas.py` + `test_core_migrate.py` + 相关 server 测试
- 改 `core/config.py` → `test_core_config.py` + `test_core_config_override.py`（新增 profile 键必须同步白名单测试；改本机覆盖通道必跑回退测试）
- 改 `core/config_write.py` / `core/config_guard.py` / 配置写入路由 → `test_core_config_write.py` + `test_server_config_write.py`
- 改 `core/provider_store.py` / 新增来源路由 → `test_core_provider_store.py` + `test_server_config_providers.py`（**校验失败必须不落盘**，密钥分层不许破）
- 改 `core/cost.py` → `test_core_cost.py` + `test_server_cost.py`（统计口径变化必须同步 ARCHITECTURE 7.1 的 /api/history/stats 说明）
- 改前端 `cost.ts` / `rerun.ts` → 同名 `*.test.ts`；改历史面板交互 → `HistoryGallery.test.tsx`
- 改 `core/history.py` → `test_core_history.py` + `test_server_helpers.py`（展示/导入同源）
- 改 `core/api.py` → `test_core_api.py` + `test_main_cli.py`
- 改 `server.py` 路由 → 对应 `test_server_*.py` + 前端 `types.ts`/`api.ts`
- 改前端纯函数 → 对应 `*.test.ts`（同目录同名）
- 改前端组件 → 组件单测 + E2E（`../frontend/e2e/verify_canvas.py` 105 断言；改来源/配置相关再跑 `verify_provider.py` 38 断言）
- **增/删用例后更新 AGENTS「当前仪表盘」数字**

## CI 要求

- Backend Job：**windows-latest**（5 个 Windows 专属测试）
- 本地默认临时目录即可；CI 固定用 `${{ runner.temp }}`（见 ci.yml）
- 细节见 [../.github/workflows/ci.yml](../.github/workflows/ci.yml)（三 Job：Backend / Frontend / E2E）

## 参考

- 测试规范与数字口径：[../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) 10
- 被测模块手册：[../core/README.md](../core/README.md)、[../frontend/README.md](../frontend/README.md)
- 维护仪表盘（数字/待办/坑）：[../AGENTS.md](../AGENTS.md)
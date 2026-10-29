# Imagora 架构说明

> 本文档面向持续开发者，是**宏观索引**：系统结构、模块关系、关键决策与**防错规范**。
> 文档分层（双件制）：跨会话仪表盘在根 `AGENTS.md`；每个可维护目录是**规则层 `AGENTS.md`**（自动注入，只写"怎么工作"）+ **文档层 `README.md`**（按需读，文件索引/职责/改后必测）双件；本文档承担设计圣经（"为什么/防什么"）。
> 导航：根仪表盘 [AGENTS.md](../AGENTS.md) · 用户视图 [README.md](../README.md) · docs 索引 [README.md](README.md)
> 阅读建议：改后端先读第 4、6 章 + core/README；改画布先读第 5、9 章；新功能落地前通读第 11 章变更守则。

## 1. 系统概览

### 1.1 三层结构

Imagora 是本地单机工具，运行时分三层，方向单一：

1. **浏览器**（React SPA）：全部界面逻辑在 `frontend/`，通过相对路径 `fetch /api/*` 与后端通信，不写死主机名。
2. **服务端**（FastAPI，`server.py` + `core/`）：既提供 `/api/*` 路由，也在同一端口托管 `frontend/dist` 静态产物——单端口，浏览器访问 `http://127.0.0.1:7860` 即得全部。
3. **上游生图 API**（OpenAI 兼容接口）：服务端唯一的外部依赖，仅在 `core/api.py` 中调用；网络失败、超时、计费错误都在这层收敛为可读错误。

依赖方向只有一条链：浏览器只认识服务端，服务端只通过 `core/api.py` 认识上游。任何模块不得绕过这层直接发请求。

### 1.2 设计哲学

- **配置分离**：公开配置（中转站地址/模型/尺寸/质量）在 `config.json`（git 跟踪、多 profile）；密钥只在 `.env` / 环境变量（git 忽略）；`core/config.py` 是唯一加载层，代码中不出现明文密钥。
- **职责单一**：一个模块一个职责——config 管配置、api 管上游请求、tasks 管异步任务、registry 管资产注册表、graphstore 管工作流存储、logging 管日志、server 只做路由薄层、frontend 管界面（`canvas` 仅是兼容 shim，星号 re-export 前两者供旧引用过渡）。
- **产物与代码分离**：生成图片、参考图缓存、画布图片、工作流文件全部落在 `output/`（git 忽略），不进代码库。
- **按名管理**：每个产品一个目录，素材/批量配置/输出随产品走；工具代码跨产品共享。
- **类型安全**：前端 TypeScript 严格模式，前后端类型契约集中在 `frontend/src/types.ts`，与后端返回结构一一对应。
- **路径可迁移**：所有路径以 `WORK_ROOT`（进程启动时 `Path.cwd()` 固定）或配置文件所在目录为基准，不硬编码绝对路径；项目文件夹改名/移动后旧数据依然可恢复。

### 1.3 全局不变量

- 端口唯一真相源：服务是否在跑、进程是谁，一律以 `netstat` 探测端口监听者为准，不信任任何落盘状态文件。
- 任务管线唯一：经典表单与画布共用同一个 `TaskManager`，全局并发上限对所有窗口统一生效。
- 图片三源归一：本地上传 / 输出目录导入 / 生成结果回流，最终都复制进 `output/.assets/` 注册表管理。
- 单 worker 启动：uvicorn 不得传 `--workers`，否则任务并发上限翻倍、窗口计数器错乱。
- 前端静态资源 no-cache：中间件统一 `Cache-Control: no-cache`，本地迭代改完前端刷新即生效。

## 2. 目录与模块

### 2.1 仓库根

| 路径 | 职责 |
| --- | --- |
| `main.py` | CLI 入口：`ui` / `menu` / `batch` / `gen` / `config` 五个子命令（`gen` 与 web 表单完全对等：必填参数校验、多参考图、资产旁路、提交快照、全量账本） |
| `server.py` | FastAPI 应用：全部 `/api/*` 路由 + 托管 `frontend/dist` |
| `启动生图工作台.exe` | 开发环境双击入口：极简启动器（源码 [scripts/desktop/launcher.cs](../scripts/desktop/launcher.cs)，编译脚本 [scripts/desktop/make_launcher.ps1](../scripts/desktop/make_launcher.ps1)），内嵌图标并把执行转交 [scripts/desktop/启动生图工作台.cmd](../scripts/desktop/启动生图工作台.cmd)：构建检查 → 起服务 → 开窗 → 进入交互菜单 |
| `config.json` | 公开配置（git 跟踪）：多 profile（中转站/模型/尺寸/质量/ratios），`default_profile` 指定公共默认 |
| `core/` | 后端核心逻辑（见 2.2），全部无 HTTP 依赖的纯业务模块；**双件**：规则层 core/AGENTS.md + 文件索引 core/README.md |
| `frontend/` | React SPA（见 2.3）；**双件**：frontend/AGENTS.md（规则）+ frontend/README.md（索引） |
| `scripts/` | 独立运维脚本：`migrate.py`（存储一步到最新，默认只报告、`--apply` 才落盘备份校验）；**双件**：scripts/AGENTS.md + scripts/README.md |
| `tests/` | 后端 pytest（475 用例）+ 前端 vitest（1061 用例），全部不调上游；**双件**：tests/AGENTS.md + tests/README.md（逐文件覆盖） |
| `docs/` | 设计圣经 `ARCHITECTURE.md`（本文档）+ `prompt-import-format.md` / `ecom-prompt-import-format.md`（格式规范）；**双件**：docs/AGENTS.md + docs/README.md |
| `assets/` | **文档配图**（只服务 markdown 渲染，不是应用资源）：`screenshots/` 放 README「界面一览」的界面截图；**双件**：assets/AGENTS.md + assets/README.md |
| `_ui-audit/` | 开发期 UI 审计图（本机产物，git 忽略）：由 [scripts/capture.py](../scripts/capture.py) 生成，与门面配图 `assets/screenshots/` 不是一回事 |
| `logs/` | 生成日志 `generation.jsonl`（git 忽略） |
| `output/` | 全部运行产物（git 忽略）：`win{N}` 窗口分区、`.refs` 参考图缓存、`.assets` 资产库与注册表、`workflows` 工作流、`submissions/` 经典提交图快照 |

**四个都叫 `assets` 的东西，别混**（这组歧义曾在批量说明里让读者分不清图该放哪）：

| 名字 | 是什么 | 在不在仓库里 |
| --- | --- | --- |
| `assets/`（本目录） | 文档配图，给 README 用 | 在 |
| `output/.assets/` | 程序的资产库与注册表（图片三源归一后复制进来） | 不在（git 忽略） |
| 批量清单里的 `assets/` | 别人项目目录下的参考图子目录，相对 `batch_prompts.json` 解析 | 不在 |
| 代码术语「资产 / `ASSET_DIR` / `register_asset` 系」 | 指上面第二个，不是本目录 | — |

写作约定：指程序那个一律写「**资产库（`output/.assets/`）**」，指本目录写「文档配图」或带全路径；裸写 `assets/` 只允许出现在本目录自己的双件里。

### 2.2 后端 core/ 模块

后端业务全部在 `core/`（无 HTTP 纯逻辑层）。**文件级索引（每文件职责 / 关键导出 / 被谁依赖 / 改后必测 / 变更影响路由）见 [core/README.md](../core/README.md)**；本章只给宏观图谱：

- 配置 → 上游请求 → 任务：`config.py` → `api.py` → `tasks.py`（提交即返回的异步管线，`TaskManager`）
- 存储三件套：`registry.py`（资产注册表：内容 sha1 去重、kind 来源标签、原子写、迁移入口 `migrate()`）、`graphstore.py`（工作流/提交/恢复快照 + `persist_submission_assets` 资产旁路公共函数，图片节点只存 registryId）、`history.py`（账本 JSONL 读取 + 回填迁移）
- 支撑：`logging.py`（`generation.jsonl` 写入）、`console.py`（rich 终端）、`imageinfo.py`（图片头解析）、`pathtrust.py`（路径白名单 `match_roots`）、`batch.py`（CLI 批量编排）
- `canvas.py` —— 兼容 shim：星号 re-export registry + graphstore（旧引用 `from core import canvas` 过渡），**无业务逻辑，不加新逻辑**
- 命名语义：`asset/资产` = 被持久化的图（`.assets` 注册表）；`canvas` = 前端编排视图
- 迁移逻辑随各存储模块（`registry.migrate` / `graphstore.migrate_workflows` / `history.backfill_output_asset_ids`），`scripts/migrate.py` 仅协调与打印（默认只报告、`--apply` 才落盘备份校验）

### 2.3 前端 src/ 模块

**文件索引（职责 / 关键导出 / 变更影响路由）见 [frontend/README.md](../frontend/README.md)**；本章只给宏观图谱：

- 外壳：`main.tsx` / `App.tsx` —— 入口与双模式外壳（经典表单 / 无限画布切换，`?mode=canvas` 直达），多窗口编号与主体色、标题栏品牌区 3D（见 8.4）
- 契约：`api.ts`（`/api/*` 封装）+ `types.ts`（前后端类型契约，见 7.2）
- Hooks：`useGenerationTask`（提交-轮询任务）、`useCanvasDrop`（拖放接线）、`useCanvasRecovery`（快照自动恢复）、`useImageZoom`（预览开关状态，Gallery / HistoryGallery 共用；**单击不跳转**，双击才开预览）
- 纯函数模块（零 UI 依赖，全部有单测，用例分布见 tests/README.md）：`workflow` / `layout` / `canvasDrop` / `promptImportFormat` / `canvasHistory` / `recovery` / `previewZoom` / `format` / `accent` / `windowInherit` / `cost` / `logPath` / `api-guards`
- `components/`：`CanvasPage`（画布状态中枢 + 工具栏 + ReactFlow）、`CanvasNodes`（三类节点）、`WorkflowModals`（保存/加载/预览弹窗，ZoomModal 画布/经典表单/生产历史共用）、`PromptImportModal` / `HistoryGallery` / `UploadZone` / `Gallery` / `Select` / `FolderPicker`

### 2.4 依赖规则

后端：`main.py` / `server.py` / `core/batch.py` 调用 `core/api.py`；`core/api.py` 依赖 `core/config.py` 与 `core/console.py`；`core/registry.py` / `core/graphstore.py`（及兼容 shim `core/canvas.py`）与 `core/history.py` 是纯逻辑模块（无 HTTP），由 server 路由薄层与 `main.py` CLI 共同调用（资产旁路统一委托 `graphstore.persist_submission_assets`，杜绝两端分叉）；`core/tasks.py` 是任务管线，server 的 `/api/generate` 只做校验与登记；`main.py` 的 `menu` 子命令通过 HTTP 接口（`/api/status`、`/api/window/next`）感知服务状态。

前端：`CanvasPage.tsx` 编排一切画布行为；节点组件（`CanvasNodes.tsx`）只负责展示与上抛事件，不持有画布状态；纯函数模块零依赖、可独立单测。

**铁律：不存在反向/循环依赖。**新模块只允许依赖下层（纯函数层 → 组件层 → 页面层），出现反向引用即重构信号。

## 3. 启动与运行

### 3.1 CLI 子命令（`uv run python -m main <子命令>`）

| 子命令 | 用途 | 关键参数 |
| --- | --- | --- |
| `ui` | 启动网页界面（FastAPI + 托管前端） | `--port`（默认 7860）、`--no-browser`（外部脚本控制开窗时用） |
| `menu` | rich 交互菜单 | `--port`；N 开新窗口 / Q（或 Ctrl+C、点 X 关窗）退出并连根停止服务 |
| `batch` | 批量生图 | `--config`、`--only`、`--dry-run`（预览不花钱） |
| `gen` | 单张生图（与 web 表单完全对等） | 必填：`prompt`、`--size`/`--ratio`（二选一）、`--quality`、`-o`/`--output`；可选：`-i`（多张参考图）、`--tier`、`--model`、`--n`、`--format`、`--no-asset` |
| `config` | 显示当前 profile 支持的尺寸/比例/质量/默认值（实时读 `config.json`） | 无 |

### 3.2 启动脚本三段流程（`scripts/desktop/启动生图工作台.cmd`，由根目录 `启动生图工作台.exe` 唤起）

脚本是日常入口，按顺序完成三件事：

1. **前端构建状态检查**：比对 `frontend/src` 最新修改时间与 `frontend/dist/index.html`，输出 NOT_BUILT / STALE / OK；前两种情况询问是否现场构建（`npm install && npm run build`）。
2. **服务状态检查**：`netstat` 探测端口监听者——已在运行则跳过启动（直接进入第 3 步）；否则后台启动 `uv run python -m main ui --no-browser`（同控制台，关窗即停服），并轮询 `/api/config` 直到 200（最长 30 秒）。
3. **开窗并进入菜单**：`/api/window/next` 取窗口编号 → 打开首窗 → 进入 `menu` 子命令。

### 3.3 交互菜单与进程生命周期

菜单的服务状态**实时动态探测**：进程 PID 用 netstat 找端口监听者（端口是唯一真相源，兼容 IPv4/IPv6 双栈）；窗口编号读 `/api/status` 的服务端计数器（只读，不落盘）。

**关闭就关全部**：Q 退出（主循环 finally）、Ctrl+C（SIGINT）、点窗口 X（`SetConsoleCtrlHandler` 捕获 CTRL_CLOSE_EVENT）三条路径都收敛到 `stop_port_services(port)`。它先收集端口上全部监听 PID，再沿 ParentProcessId 逐级回溯到根（覆盖 uv → python shim → python 的多层包装），从根开始逐个 `taskkill /f /t`——既杀监听层也杀宿主进程，避免「端口释放了但进程残留」。这同时实现了「本次关闭时所有窗口一起失效」，且不依赖会被多开脚本互相覆盖的 PID 文件。

## 4. 后端架构

### 4.1 任务管线（TaskManager，`core/tasks.py`）

生成走异步管线，`/api/generate` **提交即返回**：请求线程只做校验与 multipart 兜底文件落盘（临时文件路径存入任务对象，执行线程只读路径，跨线程安全），真正生成在 `ThreadPoolExecutor`（MAX_CONCURRENCY=10）中执行。

状态机：`queued → running → done/failed`，任意状态可取消 → `cancelled`（排队中的直接出队、永不发上游请求；运行中无法中断上游请求，跑完当前张才作废，产物仍落盘并照常计费，只是不派回画布）。终态保留 10 分钟（TTL 惰性清理），超时查询返回 404，由前端兜底标失败。

约束：任务表纯内存（重启丢失，已提交任务仍会在后台完成但不再回流界面）；必须单 worker 启动。

### 4.2 server.py 路由薄层原则

路由只做三件事：解析请求 → 调用 core 模块 → 组装响应。业务逻辑不进路由；core 模块不依赖 HTTP。新增接口时：先在 `core/` 放纯逻辑 + 在 `tests/test_*` 补用例，再在 server 加薄路由。

### 4.3 路径与安全

参考图路径白名单：`/api/generate` 的 `ref_paths` 只接受 `output/.refs/` 与 `output/.assets/` 两个目录内的路径（逐根 commonpath 校验，跨盘 root 单独捕获不误伤），防路径穿越；与 `images` multipart 互斥、`ref_paths` 优先——图生图不二次上传大图。

**写配置接口的三层防护**（`core/config_guard.py`）：写配置等于改磁盘上的密钥与接口地址，能力等同于改服务器凭据，因此 `/api/config` 前缀单独设防。

- 服务只监听 `127.0.0.1`（`main.py` 的 `uvicorn.run(host="127.0.0.1")`），但「只监听本机」挡不住浏览器里别的网页对本机发请求（CSRF），故再加两层。
- 三层按**早失败、成本递增**排列：① 本机绑定（`request.client.host`）→ ② Origin 白名单 → ③ 进程内随机令牌。失败一律 403 + `error` 码，不带任何配置内容。
- **GET 不校验令牌**（页面首屏要能加载），令牌只保护「写」这个不可逆动作。
- 令牌经 `GET /api/config` 的响应头下发，前端存**内存**（不写 localStorage）。**不落盘**：落盘等于把钥匙挂在门上；进程内随机则重启即失效。
- 跨站页面为什么拿不到令牌：同源策略禁止跨源读取响应头内容——它能发 POST，但读不到 `GET /api/config` 的响应头。
- profile 名做字符白名单校验后拼 `.env` 路径，挡路径穿越。
- **作用域**：这套防护是为「单人本机工具」设计的。若要支持远程访问，安全层必须重新设计（TLS + 真实认证 + 速率限制），不能直接沿用。

### 4.4 配置加载层

配置分层（优先级从高到低）：环境变量（含 `.env` 自动加载，已存在的环境变量不被覆盖）→ `config.json` 的 `profiles[ACTIVE_PROFILE]` → `config.json` 的 `default_profile` → 内置默认值。

- `ACTIVE_PROFILE` 选择来源：`.env` / 环境变量（本机临时覆盖）> `config.json` 的 `default_profile`（git 跟踪的公共默认）。
- profile 解析是**纯函数**（`resolve_profile_config` / `unknown_profile_keys`，有单测）：profile 缺失 / JSON 格式错 / 未知键 → 控制台警告并回退，绝不静默。
- **密钥跟随 profile**：`get_api_key()` 按 `API_KEY_<PROFILE 大写>` → `API_KEY` → `AIWANWU_API_KEY`（旧写法兼容）逐级查找，切换中转站 key 自动跟随。
- **铁律**：密钥只允许在 `.env` / 环境变量；`config.json` 是公开配置（git 跟踪），绝不放密钥。

#### 配置只有一个真相源，界面是它的一个编辑入口

配置数据只有一份（在文件里），界面与文本编辑器是**同一份数据的两个入口**，不存在「前端配置 + 后端配置」两套。
分层与归属：

- `config.json` = **出厂目录**（git 跟踪）：地址 / 模型 / 尺寸价目表 / 能力清单。界面**只读**，永不写。
- `.env` = **本机覆盖 + 密钥**（git 忽略）：界面**只写这里**。
- `providers.local.json` = **本机来源层**（git 忽略，`core/provider_store.py`）：用户在界面上「添加第三方供应商」造出来的整条来源（地址 / 路径 / 模型目录 / 标准价目表）。加载时并进 `config.json` 的 `profiles`，**重名时本机优先并告警**。

为什么需要第三层：`config.json` 写不得（见下段），而 `.env` 的覆盖通道只有四个**扁平**键、且都挂在**已注册** profile 下——凭空造不出一个新来源。把整套来源结构塞进 `.env` 等于把 `.env` 变成第二个 config.json，还丢了 git 忽略之外的一切好处。所以单开一个文件：结构自由、git 忽略、坏掉也只是「本机来源丢失」而不会让服务起不来（读取宽容，见 `load_local_providers`）。

为什么界面不写 `config.json`：它是公开仓库里的出厂数据，别人 clone 下来跑。界面写它会让每次改本机偏好都污染 git 状态；
更严重的是冲突解决时一句 `git checkout config.json` 会**静默丢掉用户的选择**，而且要等到生成报错才发现。

因此有三个字段有 `.env` 覆盖通道（沿用既有的 `API_KEY_<PROFILE>` 命名约定，见 `.env.example`）：

| 字段 | 覆盖键 |
|---|---|
| 接口地址 | `BASE_URL_<PROFILE 大写>` |
| 默认模型 | `MODEL_<PROFILE 大写>` |
| 接口路径 | `API_PATH_<PROFILE 大写>`（同时用于 generations 与 edits） |
| 密钥 | `API_KEY_<PROFILE 大写>` |

**只开这四个键**：其余（`ratios` / `size_options` / `models`）是价目表与能力清单，属出厂目录，开放环境变量覆盖会把 `_get()` 变成解析器而收益为零。

**要改价目表 / 模型清单 / 新增整条来源，走 `providers.local.json`，不走环境变量**：覆盖通道只负责「把出厂来源的某一项临时换掉」，造新来源是另一件事（`POST /api/config/providers`）。新建来源的单价一律填 0 —— 真实单价只有用户知道，界面不编假数字，费用显示 0、预算看板不统计这家。

`ACTIVE_PROFILE` 也可在界面切换（写 `.env`，值是 `config.json` 已注册的 profile 名，服务端校验）。它是其余覆盖键的**父级**——`BASE_URL_<PROFILE>` / `MODEL_<PROFILE>` 都挂在选中的 profile 下，所以切换它会换掉整条解析链。
**未设置环境变量时回退路径与没有覆盖通道时逐字相同**（`tests/test_core_config_override.py` 锁死）。
空白值视为未设置（宁可回出厂值，也不要「配了个空地址」）。

写入侧（`core/config_write.py`）：行级原地更新 + 原子写。

- 只改目标行，用户注释 / 空行 / 键顺序 / 引号风格逐字保留——从解析后的 dict 重新 dump 正好会把它们全冲掉。
- 写前 `.bak`，之后临时文件 → `fsync` → `os.replace`，沿用原文件权限。这是密钥文件：写到一半崩溃留下的半截 `.env` 会让服务起来后完全无法生图。
- **值为空 = 不修改**；清空密钥是**注释掉那一行**而非删除，手工去掉 `#` 即可恢复（因此不需要「重置」按钮）。

冲突与生效：

- 写配置接口带 `expectedMtimes`，与磁盘 mtime 不符则 409，**绝不静默覆盖**。两个文件各自独立比对。
- **写入即生效**：两个写接口在落盘后都调 `config.reload_config()`，它重读 `config.json` + `providers.local.json` + `.env` 并重算全部模块级常量。以前「填了 API Key 却要重启」就是缺这一步 —— 文件改了，进程内的值没重算。
- `pending` 因此只在**绕过界面直接改文件**时非空（文件值 ≠ 生效值），机制本身没废。
- 取常量一律走 `config.xxx`，不用模块顶层 `from core.config import XXX` 的名字——后者是导入时绑定的快照，热加载改不到它。同理，**函数默认值不能写成常量**（`def f(size=DEFAULT_SIZE)` 在 def 时求值一次就固化了），要用 `None` 哨兵在函数体内解析。

### 4.5 错误处理与日志

统一 `core/api.py:format_error(e, limit)` 输出「类型: 消息」截断，UI 与命令行共用。每次生成（UI/批量/CLI）由 `core/logging.py` 写入 `logs/generation.jsonl`（线程锁串行），字段：时间/模式/参考图数/提示词/尺寸/质量/结果/费用/耗时/输出路径/窗口号。

## 5. 前端架构

### 5.1 双模式

`App.tsx` 持有经典表单的全部状态（提示词/参考图/尺寸/质量/输出路径/任务状态）；画布模式首次进入后**保持挂载**（切换模式只显隐，内容保留，退出窗口才清空）。两种模式共用同一任务管线。

### 5.2 画布核心模型

React Flow v12（`@xyflow/react`）受控模式：`nodes` / `edges` 状态由 `CanvasPage` 持有，`useNodesState` / `useEdgesState` 管理变更。

三类节点（`CanvasNodes.tsx`）：

- **图片节点**：缩略图 + 引用计数，顶部 target 接生成结果，底部 source 输出参考图。
- **图片组节点**：聚合多图统一连入提示词。
- **提示词节点**：提示词/尺寸/质量/输出路径/运行按钮 + 状态灯，固定宽 380px。

连线硬约束（`isValidConnection` → 纯函数 `workflow.canConnect`）：图片 → 提示词/图片组、图片组 → 提示词/**图片组**、提示词 → 图片（产出边）；提示词顶部仅允许一条入边，多图经图片组聚合。**图片组可作中转节点**：组连组 = 图片沿组链递归传递聚合（组卡计数 `computeCounts` 递归展开入边，如 2 张组 + 3 张组 → 同一组显示 5 张；提示词引用 `collectIncomingImages` 同样递归展开）。**去重口径**：`computeCounts` 的 `groupCounts` / `groupSizes` 是**去重后**的唯一口径（同一张图按 registryId 经多条路径到达只算一次——与交给提示词生成的实际图片一致）；`groupDups`（重复条目数）= 原始条目 - 唯一张数，>0 时组卡标「去重」标签（悬停 title 见重复张数），数字不动、不显示去重前口径。**引用计数溯源**：图片节点 refCount = 数据最终流到的**提示词数**——沿参考数据流方向（图片/组 → … → 提示词）正向溯源，经组链中转到达也算，同一提示词多路径去重、组环 visited 剪；只连到图片组、组链尚未接提示词的图片引用为 0；提示词→结果图片是产出方向，不反向计入。组链成环不阻止（自由画布），递归统一 visited 剪环（环上不重复计入、不死循环）。连线方向即参考关系：图片连到提示词 = 该图作为此任务的参考图。**连线分层**：`.react-flow__edges` z-index 提至节点悬停置顶（1001）之上的 1200、恒在节点之上——数据线条不被任何节点/操作栏遮挡；指针事件保持库默认穿透（容器/svg none、连线本体 visibleStroke），节点拖拽、双击删线、端点接线不受影响。

### 5.3 任务驱动模型

每个提示词节点是独立任务，无全局启动节点。提交时 `runNodeInternal` 先**锁定入边参考图快照**（`collectIncomingImages` 纯函数，图片组递归展开、visited 防环），随后 `submitGenerationTask` 提交，映射 nodeId → taskId 登记；订阅回调按 taskId → nodeId 反查驱动节点状态（queued/running/done/failed/cancelled）。

防重复生成：双层守卫——节点 `data.status` + `nodeTaskRef` 映射，提交前同步登记占位（防快速连点竞态），终态解除映射，删节点/加载工作流时同步清理。

运行态刷新策略：running 转换时节点只写一次 `startedAtMs` 锚点（epoch 毫秒），后续轮询 / 计时推送的 running 快照经 `updatePromptNode` **幂等跳过**（patch 与现状一致时不产生新引用）；秒数文字由组件内 `ElapsedText` 以锚点自计时刷新（1s interval，只重渲染自身文字）。曾逐秒把 `elapsed` 写进节点 data：状态灯 title 每秒跳字 + 整卡每秒重渲染 → 鼠标悬停一闪一闪；现状态灯 running 时 title 恒定「生成中」，秒数只在运行按钮文字上走（与经典表单「秒数只在视线位」同原则，见 8.6）。

### 5.4 画布交互层

- **拖拽添加（文件 / 工具栏按钮，共用同一落点示意）**：拖本地图片（可多张）到画布任意位置松开即添加，或把「新建提示词卡片 / 新建图片组」按钮拖出到画布松开即建（**拖到画布外松手则取消**；点击仍自动居中）。接线统一收敛在 `useCanvasDrop` hook（意图解析/落点换算/示意/守卫），纯逻辑在 `canvasDrop.ts`，节点构建在 `workflow.ts:buildPromptNode/buildGroupNode`（与点击新建同一构建）。落点 = **鼠标松开处**（`screenToFlowPosition` 换算），批次内沿用 `canvasEntriesToNodes` 横向排开；文件走 `isImageFile` 过滤 + `POST /api/canvas/upload`，工具栏拖走自定义 dataTransfer 类型（`application/x-imagora-canvas`，值 prompt/group）。
  - **落点示意**：跟随光标的小胶囊（portal 到 body + fixed 定位，工具栏拖出可全局跟随），图标/文案按意图区分（图片数量 / 「松开新建提示词卡片」等）；**图标双态 + 文案随位置实时切换**——画布内 = 新建类型图标（Type/Layers/Plus）+「松开新建…」，画布外 = 红色 X +「松开取消」（`is-outside` 类与 textContent 直接写 DOM）；位置由 JS 直接写外层 transform（高频 dragover 不触发 React 渲染）、数量从 `dataTransfer.items`（kind==="file"）统计——**dragover 阶段 `dataTransfer.files` 为空**（浏览器延迟到 drop 才填充）；拖入时画布切系统 `copy` 光标（`.canvas-drop-active`）。
  - **防护**：dragenter/leave 计数平衡防闪烁（仅文件拖拽）；拖放接管挂在**整个工作区**（含工具栏），UI 上不出现浏览器禁止标志——文件拖入落点在画布外夹紧到画布边缘（`dropPointFromEvent`），**工具栏拖出画布外松手即取消**（drop 前 `isInsideRect` 判定，不再夹紧放置）；意图判定带 `dropIntentRef` 回退（真实浏览器 dragover 阶段 getData 偶发为空）；窗口级只拦截携带 Files 的拖拽（防落画布外触发浏览器打开文件导航）；`dragend`/失焦复位拖拽状态；drop 前先判定意图，文本/其他拖拽**放行**（输入框原生行为不受影响）；弹窗打开时暂停接管。
- **右键拖拽框选**：右键按下→拖拽→松开，起点/终点用 `screenToFlowPosition` 换算，松开时按「节点完全包含于选框」落定选中；`mouseup` 挂 window（画布外松开也生效）。
- **右键菜单屏蔽**：window 捕获层**无状态**屏蔽非输入区 contextmenu（文本框/输入框保留原生菜单），不依赖任何时序标志。
- **选中操作栏**：任意选中 ≥1 个节点后右上角出现——运行所选（只跑提示词卡片）/ 自动整理（局部重排）/ 自动连线（只补选中节点之间的边，未选中节点不受影响）/ 设置输出路径 / 删除所选。样式为**半透明毛玻璃**（bg-white/20 + backdrop-blur-md），选中操作时基本不遮挡画布内容；按钮透明化细节见 8.4 按钮体系。
- **快捷键**：Ctrl+A 全选、Ctrl+Z/Y 撤销恢复、Ctrl+S 保存、Delete 删除（带退场动画）；输入框聚焦时不拦截。
- **撤销/恢复**：`canvasHistory.ts` 50 条上限的 past/future 栈，删除/连线/新建/导入前记录快照。
- **画布日志**：右下角浮层只露最新 5 条（`log-toast` 淡入上移），低饱和中性色弱化存在感，`pointer-events-none` 不挡画布操作。
- **视口辅助（小地图 / 缩放读数）**：都塞进左下角控制坞同一列，不往画布上另叠常驻 UI。**缩放只有读数，没有滑杆**——滚轮与「放大 / 缩小 / 适应」已经够用，滑杆只换来一条要维护的双向同步（拖动改视口 + 视口变化回灌读数 + 拖动期间挡互相拉扯），2026-10-29 移除。读数是纯派生显示：`handleViewportMove` 把视口 zoom 经 `zoomToPercent` 归一成 5%~200% 的整数（行程与 React Flow 的 `minZoom=0.05` / `maxZoom=2` 对齐，常量写死在 `minimapVisible.ts`、不做参数——参数化会让两处数字各自漂移），不落盘。小地图**默认关闭**（卡片少时是纯负担），位置在**左上角**（右下角留给日志轮播）；开关状态落 localStorage（`imagora.canvas-minimap.v1`，读写一律 try/catch 静默降级）。
- **生成中占位卡**：提示词节点 running 时在运行按钮上方长出一条细进度条（`.generation-pending`），文案按秒轮播（理解提示词 → 构图 → 铺设光影 → 细化细节 → 收尾），进度是**假进度**：`10 + (1 - e^(-s/28)) × 88`，渐近到 98% 永不越过（最后 2% 留给真实完成，不能让用户看到 100% 却还在等）。秒数锚定节点 `data.startedAtMs` 而不是卡片自走表——切后台、组件重挂载都不倒退；`GenerationPending` 的 `elapsed` 受控，不传才自建 interval，避免同一张卡上跑两套时钟。**进度只由 `transform: scaleX()` 驱动，绝不给 `width` 加 transition**：width 运动会每帧重排布局，在缩放中的画布上尤其卡。
- **图片派生加工（裁剪 / 放大）**：画布图片节点悬停栏的「裁剪」「放大」都走**派生新图**而不是原地替换——加工是可回溯的派生操作，同一张原图常要裁好几个比例，原地换会连原图一起丢掉且无法从画布回溯。链路：对话框产出 `data:image/png;base64,...` → `dataUrlToFile()` 转 `File`（`canvasUpload` 只收 File）→ 上传注册表 → 在源图右侧偏移 `DERIVED_NODE_OFFSET_X = 200` 处新建图片节点（源节点已删则退化为视口中心）→ `recordHistory()`。裁剪与放大的几何运算**全在前端 canvas 完成**，后端零参与（不新增接口、不改 `generate_image` 契约）。
- **`dataUrl` 转 `File` 失败必须抛错，不能返回空 File**：上传 0 字节会在画布上多出一个永远加载失败的红框节点，比当场报错难排查得多。
- **图片切分（`ImageSplitDialog`）**：同一套「派生新图」链路，一次产出多张。几何在 `imageSplit.ts`（纯函数）：`splitCells` 用 `x = col / cols` 直算而不是累加——累加会在最后几格漂出 1 之外的坐标；自定义切割线走 `splitCellsByLines`，先过滤到 `(0,1)` 开区间、排序、1e-6 去重、丢弃距端点 < 0.02 的线，再相邻成对。1×1 是合法输入（等于不切），界面在 `splitCellCount < 2` 时禁用确认并说明理由，而不是悄悄改成 2×2。
- **拖拽吸附（`snapGuide` + `snapDrag`）**：拆两层——`snapGuide.ts` 是纯几何（被拖盒的左/中/右与上/中/下三对齐线，与其它节点的同三条线比差取最近），`snapDrag.ts` 是接线层（把结果翻译成 React Flow 的 `NodeChange`，并算出要画的对齐线）。拆开的理由：几何能被单测穷举（38 个用例），接线层只做形状转换（22 个用例），混在一起就都得靠模拟拖拽才能测。**x 与 y 独立决策**（可能只吸一个轴）；阈值用严格 `<`；**没有可吸目标时原样返回，绝不偷偷退回网格**——否则「关掉吸附」与「没有邻居」会变成两套行为，用户无法预期。吸附位移必须**同时写 `position` 与 `positionAbsolute`**：React Flow 读后者渲染，只写前者节点会在下一帧瞬移回原位。开关默认开，偏好落 `imagora.canvas-snap.v1`。
- **聚焦控件（`focusViewportForNode`）**：取代 `fitView` 的「把所有东西塞进屏幕」——节点一多，fitView 会把缩放压到 5%，节点缩成看不见的色块。用户按「聚焦」要的是「看清楚它」。算法在 `canvasGeometry.ts`（纯函数）：可用高度扣掉底部日志条，节点最多占视口 60%（`FOCUS_MAX_VIEWPORT_RATIO`），下方有浮层时按 3:1 把节点往上推。有选中就聚焦选中的包围盒，没选中就聚焦全图。
- **系统自己落地的新节点必须带进视野（`revealViewport`）**：生成结果回流、裁剪 / 放大 / 切分产物都是**在源节点旁边落地**（结果图在提示词正下方 `resultGap = 60`，派生图在源图右侧 `DERIVED_NODE_OFFSET_X = 200`）。源节点一旦靠近视口边缘，新节点就落在视口外 —— 而画布开着 `onlyRenderVisibleElements`，**视口外的节点根本不挂载**：画布上空白一片，用户只看到日志条说「已回流画布」，会以为生成失败（真实事故见 `.agents/notes/2026-10-21-canvas-result-reveal.md`）。修法不是关掉可见性裁剪（那只会让节点进 DOM、屏幕上看不见的东西还是看不见），而是落地后**只平移**视口把新节点带进来：`revealViewport` 的 `k` 原样返回（用户没要求改缩放，抢缩放比看不见更烦人），已完整可见时返回 `null`、调用方完全不碰视口。底部日志条按聚焦同一口径扣掉（`FOCUS_BOTTOM_INSET = 96`）。
- **节点悬停操作栏必须用 `opacity` + `pointer-events` 控制，不能用 `visibility` / `display`**：`visibility: hidden` 会把按钮从无障碍树摘掉，E2E 的 `get_by_role` 与读屏器都查不到；`display: none` 则让按钮脱离布局，鼠标移过去时元素才出现，悬停区会闪。正确做法是常驻布局、`opacity-0 pointer-events-none`，`group-hover` 时两者一起翻转。另外悬停区要用**内边距（`pl-2`）而不是外边距（`ml-2`）**：外边距不参与命中测试，鼠标从节点移向按钮的 8px 途中会掉出 `.group`，操作栏闪断。

### 5.5 持久化

- **格式版本化（v1/v2 兼容）**：注册表与工作流都有明确 schema 版本。运行时时**只写当前版本（v2）**、可读 v1 与 v2——老数据零失效；未知版本明确拒绝（不按错误结构解析未来格式）。
- **存储迁移（v1 → 最新，职责各归其位）**——迁移不做成独立中间模块，三处各管各的存储，`scripts/migrate.py` 仅协调与打印：

  | 迁移段落 | 归属 | 做什么 |
  | --- | --- | --- |
  | 注册表 | `core.registry.migrate()` | 目录 `.canvas`→`.assets`（重写 relPath）+ v1 裸清单→v2 包装 + 损坏重建 + 回填 kind |
  | 工作流 | `core.graphstore.migrate_workflows()` | 逐文件 v1→v2（补 version+savedAt，备份+校验） |
  | 历史账本 | `core.history.backfill_output_asset_ids()` | 旧行缺 `outputAssetIds` 时按 output 文件内容 sha1 反查注册表补齐 |

  **执行顺序**（`--apply` 一步完成）：注册表 → 工作流 → 历史账本。
  **安全语义**（三段共用）：默认只报告、`--apply` 才落盘；先整文件/整目录备份 `.bak-<时间戳>`；原子写（tmp+os.replace）；写后读回校验；幂等（重复执行结果不变）；**只改能可靠判别的东西**——注册表只动 relPath/包装/kind、历史只补能按内容反查命中注册表的行，文件缺失或注册表无该内容一律跳过并计数（不伪造）。dry-run 若存量还在 `.canvas/` 且注册表为 v1 会报 `pending-relocate` 提示先迁目录，避免误报 missing/noop。

  **用法**：
  - 查看状态（只报告）：`python scripts/migrate.py`
  - 一步到最新（迁目录 + 升级 v1→v2 + 回填 kind + 升工作流 + 历史补 outputAssetIds）：`python scripts/migrate.py --apply`
  - 清单缺失/损坏按文件重建：`python scripts/migrate.py --apply --rebuild-registry`
  - 跳过 kind 回填：`python scripts/migrate.py --apply --skip-meta-backfill`（默认已含）
  - 指定 output 根：追加 `--output-root 路径`
- **重建原理**：`rebuild_registry` 扫描 `.assets/` 下 `canv_<sha1[:12]>.<ext>` 文件——id/relPath/name 由文件名还原，size 实测、宽高/格式用 `imageinfo` 探测、createdAt 取文件 mtime；canvas 工作流按"编号"引用图片，编号不丢则老存档全部可恢复。**限制**：重建后条目 name 为系统名（原始上传名未单独持久化，无法还原）。
- 资产注册表（代码层统称**资产 / ASSET_DIR / register_asset 系**，语义=全项目统一图库）：`output/.assets/registry.json`，v2 包装 `{ schemaVersion, images: { id: entry } }`（v1 裸 dict 兼容读取），id = 内容 sha1 前缀（同内容去重），v2 条目附可选宽高/格式与**可选来源标签** `kind`（canvas/result/ref）+`sourceKey`；均缺省可读、仅首次登记写入、同内容去重不覆盖来源；永不自动清理。**磁盘目录规范名 `.assets`（存量 `.canvas` 已由迁移一步迁入并备份 `.canvas-bak-<ts>`）**（工作流/提交快照只存 registryId、不存目录名，改名仅需搬文件 + 改注册表 relPath 前缀，迁移工具（`migrate.py --apply`）已内置该改名步骤）。解析入口单一收敛为 `resolve_asset(id)`。

#### 画布图片的注册入口（谁进 `.assets/`）

| 入口 | 是否进 `.assets/` 注册 | 说明 |
| --- | --- | --- |
| 画布拖拽本地图片 / 工具栏「上传图片」 | ✅ | `POST /api/canvas/upload`，复制 + 登记，同内容去重 |
| 画布「历史导入」/「导入目录」 | ✅ | `history/import` / `canvas/import`，同样复制 + 登记 |
| 生成结果回流 | ✅ | done 快照按 registryId 去重后复制 + 登记（见 6.5） |
| 图片节点「替换」 | ✅ | 新图登记；旧图文件保留（避免破坏其他引用/已存工作流） |
| 经典表单上传区参考图 | ✅ 提交时注册 | 添加时只落 `output/.refs/`（24h 临时中转，不进 `.assets/`）；**生成提交时**该次用到的参考图（`ref_bases` 与 multipart 兜底的 `temp_bases` 一并）`register_input_assets` 注册为 `kind='ref'` 复制进 `.assets/`（此刻文件必然存在，防排队期间被删漏记；原 `.refs` 文件不动、24h 清理照旧） |
| 经典表单生成结果 | ✅ | 生成成功后结果图 `kind='result'` 复制进 `.assets/` 并登记，同时落一份**提交图快照**（`output/submissions/`，kind='submission'，组→提示词→结果连线），账本带 submissionId/资产 id；经典结果区「导入画布」= 整图重建（见 6.5） |

> `.assets/` 与 `.refs/`：前者是画布长期图库（永不清理、工作流按编号引用、损坏可重建）；后者是参考图临时缓存（添加即落盘供继承/生成引用，启动清 24h 孤儿，无引用计数）。统一原则：**只要在系统里「出现且被保留」的图都进 `.assets/` 注册表**（画布拖入、生成结果、晋升的参考图），`.refs` 仅是不确定是否要保留时的 24h 暂存。
- 工作流文件：version 2 JSON（v1 兼容读取）存 `output/workflows/`，含 `savedAt` 元信息；图片节点**只持久化 registryId + 元数据**，url/absPath 由加载时按注册表实时重建——项目改名/移动后旧存档自愈；注册表缺失的 id 进 `missing`（前端标红「图片缺失」并阻止带缺图运行）。
- 提交图快照：`output/submissions/`，与工作流同 schema（kind='submission'），经典生成自动落盘，提供「整图导入画布」（图片组→提示词→结果连线一次还原）；解析统一走 `resolve_asset`。
- 恢复快照：独立于手动工作流，自动保存（防抖 1.5s）+ 挂载询问恢复。

### 5.6 新建节点定位

节点落点只有两个来源，任何入口不得自带偏移：

1. **视口中心（自动定位）**：所有创建入口（上传/历史导入/新建卡片/图片组/粘贴导入）统一以当前视口中心为落点：`getCreatePosition` 用 `screenToFlowPosition(容器中心)` 换算；连续创建由 `workflow.ts:staggerCreatePosition`（纯函数）阶梯错开（每次 +30px，视口移动后回到中心）。
2. **拖拽落点（用户指定）**：文件或工具栏按钮（新建卡片/图片组）拖到画布松开的位置就是用户指定的画布坐标，直接 `screenToFlowPosition(松开点)` 落点，**不经** `getCreatePosition`；文件批次内多图仍由 `canvasEntriesToNodes` 从落点横向排开，节点构建走 `buildPromptNode/buildGroupNode`（与点击新建同一构建）。

## 6. 关键数据流

### 6.1 UI 生图（经典表单与画布同管线）

1. 参考图**添加即上传**：`POST /api/upload-ref` 落盘 `output/.refs/`，返回 `{id, path, url, name, size, ext, mime}`，缩略图直接渲染。
2. 生成时传 `ref_paths`（JSON 数组引用已落盘文件，优先）或 `images`（multipart 兜底）。
3. `POST /api/generate` 提交即返回 `{taskId, status}`；前端 `useGenerationTask` 每 2s 轮询快照（竞态防护 + elapsed 本地计时，终态停止）。
4. 服务端线程池执行 `generate_image`（多参考图一次请求）→ 解码 b64 写入输出目录 → 写回 results/messages/total_cost。
5. 快照 `url=/api/image?path=` 回显（附带 fileSize/ext）；经典表单进画廊，画布按节点映射驱动状态灯并在 done 时**结果回流**（见 6.5）。
6. **经典结果落盘（旁路，失败不影响生成）**：参考图在**提交阶段**即注册（`/api/generate` 调 `graphstore.register_input_assets`，此刻文件刚校验/刚落盘必然存在，消除排队期间源文件被删导致 persist 静默漏记的窗口——曾实测 refs=5 全漏；id 随任务进账本）。done 时 `run_generation` 委托 `graphstore.persist_submission_assets`（与 CLI 共用的资产旁路公共函数）：参考图**按提交时注册的 id 解析**进提交快照（不重复注册），结果图 `kind='result'` 现场注册进 `.assets/`，并落一份提交图快照（`output/submissions/<submissionId>.json`）；账本该行带 `submissionId/inputAssetIds/outputAssetIds`（`inputAssetIds` 即参考图 id，历史按 `resolve_asset` 解析回显缩略图）。经典结果区「导入画布」= 整图重建到画布（图片组→提示词→结果连线）。

### 6.2 批量生成（命令行）

`batch` 子命令读产品目录的 `batch_prompts.json` → 过滤模块/解析底图路径（相对配置目录）→ rich 预览表格（不花钱）→ 进度条逐张生成 → 失败收集（退出码 1）。

### 6.3 单张生成（命令行）

`gen` 子命令与 web 表单对齐，链路：`_validate_gen_args`（必填/互斥/取值校验，缺则退出码 2）→ `_resolve_output_list`（按张数解析每轮一张的路径）→ `resolve_size_with_ratio` → **逐张** `generate_image`（每次请求 `n=1`，多参考图走 edits 接口）→ 每张各旁路一次 `graphstore.persist_submission_assets`（注册参考图 + 结果图，落该张自己的提交快照）→ 每张各写一行 `log_generation`（含 `submissionId`/`assetIds`，与 web 同源可互查）。

- 必填参数缺失立即报错并提示运行 `config` 查看可用值（退出码 2），不进入生成；
- `--no-asset` 跳过资产旁路与提交快照，账本无 `submissionId`/`assetIds` 字段；
- **张数由客户端循环兑现**：`--n 3` 发 3 次请求、每次向上游要 1 张。**不许**把 `n` 透传给上游——上游会按 3 张计费而 `core/api.py` 只取 `data[0]`，等于花 3 张的钱存 1 张（issue #34）；
- **输出命名**：传目录时每轮各取一个自动序号名（与 `server.run_generation` 同算法）；传具体文件时第 1 张用原名、第 2 张起加 `_2`、`_3` 后缀，保证 `--n 1`（默认）与历史行为逐字不变；
- 逐张同步等待（不进并发池）；某张失败不回滚已成功的，该张写 `status=error` 且不计数，只要有一张失败整体退出码 1；
- 多张并行仍可用"开多个终端各跑一条"，与 `--n` 的区别是后者由本工具串行跑完并逐张入账。

`config` 子命令实时读 `config.json` 当前 profile，打印支持的尺寸（含费用）/ 比例 + 档位 / 质量取值 / 默认值，避免传错值被 `_validate_gen_args` 拒绝。

### 6.4 提示词粘贴导入

多模态模型按 `docs/prompt-import-format.md` 导入格式回复（`=== 标题 ===` + 代码围栏 + `ratio: N:M`）→ 「粘贴导入」弹窗内 `parsePromptImportFormat` 实时解析（标题锚点切分 + 围栏配对 + 块内首行 ratio 校验，缺漏进 issues 标红，**绝不静默猜测**）→ 确认后 `buildPromptNodes` 批量建卡（尺寸按 label 匹配 `config.sizes`，找不到回退并标记）→ 视口中心平铺 + 入场动画。

### 6.5 结果回流

画布任务与本表单共用同一 `/api/generate`（server 无条件生成 `submission_id`），所以 done 时后端旁路已把结果注册为 `kind='result'` 并落提交快照（见 6.1 step 6）。前端回流只做**取回 + 建节点**：`importHistoryAsset`（`POST /api/history/import`）按内容 sha1 命中旁路已注册的条目（同内容去重，不重复登记）→ 按 `registryId` 去重（画布已有同图不重建）→ 建图片节点放在提示词**正下方居中横排**（`layoutPromptResults`）→ 自动连线 提示词 → 结果图。导入白名单同时接受任务结果 URL 反解的账本 output 原路径与注册表副本路径（见 9.7），回流不会因路径漂移失配。回流前检查提示词节点仍存在（删除后完成的结果不回流，避免幽灵节点）。

**经典统一**：经典表单生成走同一链路（见 6.1 step 6）——参考图提交阶段注册、结果图 done 时注册 + 提交图快照 + 账本联动；「导入画布」走 `POST /api/canvas/import-submission` 整图重建，前端 `mergeSubmissionGraph` 按 registryId 去重复用现有图片节点并接上提示词与连线（不产生重复节点）。

## 7. 前后端契约

### 7.1 API 一览

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/config` | `?win=`（沿用窗口号，缺省服务端分配） | sizes / qualities / defaultOutputDir / **defaultOutputDirSource**（`explicit`/`last`/`window`）/ **savedDefaultOutputDir**（没设过为 null）/ windowId / baseUrl / defaultModel / activeProfile / models / providers / profileView（值 + 来源）/ fileState（文件值 + mtime + pending）；**响应头带 `X-Config-Token`**（写配置用） |
| POST | `/api/config` | { profile, changes{baseUrl?,apiPath?,model?,apiKey?}, expectedMtimes{env?,config?} } | 写 `.env`（行级原地更新 + 原子写）：{ ok, written, mtimes, pending, fileState }。`changes` 里空字符串 = 不修改该字段；mtime 与磁盘不符 → 409 `stale_file`（绝不静默覆盖） |
| POST | `/api/config/secret` | { profile, confirm: true } | { ok, cleared, fileState }（清空密钥：把 `.env` 里那一行注释掉，手工去掉 `#` 即恢复；必须显式 confirm） |
| POST | `/api/config/providers` | { name, label?, baseUrl, protocol(`openai`/`ark`/`custom`), generationsPath?, editsPath?, model?, apiKey?, activate? } | { ok, name, profile, path, pending, fileState }（**新增第三方来源**：profile 写 `providers.local.json`、密钥写 `.env` 的 `API_KEY_<NAME>`；重名 / 名非法 / 地址非法 → 400 `invalid_value`；`activate` 才写 `ACTIVE_PROFILE` 并计入 pending；落盘后服务端 `reload_config()`，不用重启） |
| POST | `/api/config/providers/probe` | { baseUrl, apiKey?, name? } | { ok, models[{id,label}] }（**探测上游可用模型**：`GET {baseUrl}/models`；不带 apiKey 时按 `name` 回落到 `.env` 里已存的 `API_KEY_<NAME>`；失败 → 400 `probe_failed`；**只读，不写任何文件**） |
| DELETE | `/api/config/providers/{name}` | 路径参数 | { ok, removed, cleared, pending, fileState }（**删除本机来源**：只删 `providers.local.json` 里的条目，并把 `.env` 的 `API_KEY_<NAME>` 注释掉（不删行，可反悔）；出厂来源 → 400 `not_local`；**正在生效的来源 → 400 `profile_in_use`**（删了进程仍在用旧配置，下次启动静默回落，报错时联想不到是删了来源）；落盘后 `reload_config()`） |
| GET | `/api/window/next` | 无 | { windowId }（原子分配，与 config 共用计数器） |
| GET | `/api/status` | 无 | { windowCounter }（只读最大已分配编号） |
| POST | `/api/select-folder` | { current } | { path, canceled }（系统弹窗；取消返回原值且 `canceled: true` —— 调用方要区分「选了同一个目录」与「取消」） |
| POST | `/api/open-folder` | { path } | { ok }（不存在自动创建；explorer 打开置前） |
| POST | `/api/upload-ref` | multipart：images | { refs[ id, path, url, name, size, ext, mime ] }（落盘 `output/.refs/`） |
| POST | `/api/delete-ref` | { path } | { ok }（尽力删除，文件不存在也算 ok） |
| POST | `/api/output-dir` | { path } | { ok }（记「上次用过的路径」：**每次生成成功也会写它**，只当没设默认时的兜底与自检探测用） |
| POST | `/api/output-dir/default` | { path, win? } | { ok, savedDefaultOutputDir, defaultOutputDir, defaultOutputDirSource }（**设定新建卡片的默认输出路径**：`path` 空串 = 清除；相对路径 → 400 `invalid_value`；目录不可写 → 400 `not_writable`；**生成链路永不写它**，所以跑任何旧卡片都不会把它带走） |
| POST | `/api/generate` | multipart：prompt/size/quality/output_dir/win/allow_over_budget + images 或 ref_paths + `mask`（**data URL 字符串**，非文件字段；透明像素 = 要重绘区域，不透明 = 保持原样，有 mask 时强制走 edits 接口且必须有底图）（**不接收任何凭据**：配置在文件里，服务端自己读） | { taskId, status }（提交即返回；**预算闸门**：超出 `singleRunLimit`/`dailyLimit` 且 `allow_over_budget≠true` 时 409 + `detail{reason, estimate, spentToday, settings}`） |
| POST | `/api/generate/batch` | { items[{prompt,size,quality,refPaths[]}], outputDir, win, allowOverBudget } | { submitted[{taskId,prompt,size,cost}], skipped[{index,reason}], estimate, budget }（CLI 批量用：一次提交多条，单条非法只跳过该条；全部被跳过或超预算未确认则不提交任何任务） |
| GET | `/api/tasks/{task_id}` | 无 | 快照（queued → running → done/failed，可 cancelled；终态保留 10 分钟，超时 404） |
| POST | `/api/tasks/{task_id}/cancel` | 无 | { ok }（排队出队、不再发上游；运行中跑完当前张作废，产物仍落盘计费） |
| GET | `/api/history/stats` | ?days=（默认 14） | 成本看板：total/ok/error/successRate/cost/seconds/avgSeconds/todayCost + byDay[]/bySize[]/byMode[] + budget（**口径与 /api/history 不同**：这里取账本**原始行**，不去重不截断——每个成功行都真实花过钱，聚合会少算费用） |
| GET | `/api/budget` | 无 | { dailyLimit, singleRunLimit, spentToday, remaining }（本机预算，`output/.budget.json`，0 = 不限；git 忽略，不进公开仓库） |
| POST | `/api/budget` | { dailyLimit, singleRunLimit } | { ok, dailyLimit, singleRunLimit }（清洗后原子落盘；负数按 0） |
| POST | `/api/budget/check` | { items[{size}] } 或 { count, size } | { allowed, over, reason, estimate, spentToday, remaining, settings }（**无副作用预检**，前端据此决定是否弹超预算确认） |
| GET | `/api/image` | ?path= | 图片文件（FileResponse） |
| POST | `/api/canvas/upload` | multipart：images | { images[ entry ] }（复制进 `.assets/` 并登记，同内容去重） |
| POST | `/api/canvas/import` | { paths } | { imported, skipped[{path,reason}] }（目录递归，路径须在 output 根内） |
| GET | `/api/canvas/images` | 无 | { images[entry+absPath] } |
| POST | `/api/canvas/image/delete` | { id } | { ok }（注册表移除 + 尽力删文件） |
| GET | `/api/health/details` | 无 | { ok, checks, issues[] }（启动自检，不泄漏配置） |
| GET | `/api/history` | ?limit=&offset=&query=&status= | { items, hasMore }（**分页**：default limit 60，offset 为聚合后偏移、按已加载条数推进，hasMore=false 表示取完；存在性以资产注册表为准：带 outputAssetIds 走 resolve_asset，旧行回退 output 路径；参考图 inputAssetIds 解析成 inputRefs[{id,path,url}]，img2img 且 refs>0 但解析为空置 inputRefMissing；**聚合只压失败、不压成功**——mode/prompt/size/quality/refs/inputAssetIds 一致（时间不算）的失败行只留最新一条并让位给更新的成功行，**成功行一条都不合并**（同卡片同参数连跑两次 = 两张图 = 两行，产出与历史一一对应）） |
| POST | `/api/history/import` | { path } | { imported, skipped }（白名单与展示同源且双收账本行两个合法派生路径：注册表副本路径（`resolve_history_asset_path` 优先，历史面板导入传它）+ 账本 output 原路径（画布回流传任务结果 URL 反解，须文件仍存在）；拒绝任意未记录路径；函数 import_history_asset） |
| POST | `/api/canvas/workflow/save` | { name, nodes, edges } | { ok, path }（图片节点归一化：只存 registryId+元数据） |
| GET | `/api/canvas/workflow/list` | 无 | { workflows[ name, modified ] }（按修改时间倒序） |
| GET | `/api/canvas/workflow/load` | ?name= | { name, nodes, edges, missing }（按 registry 实时解析，缺失进 missing） |
| POST | `/api/canvas/import-submission` | { submissionId } | { name, nodes, edges, missing }（经典提交整图导入，解析资产路径，缺失进 missing） |
| POST | `/api/canvas/recovery/save` | { nodes, edges } | { ok, path, name, savedAt }（独立恢复快照，不覆盖手动工作流） |
| GET | `/api/canvas/recovery/latest` | 无 | { ok, empty? | name?, savedAt?, nodes?, edges?, missing? } |

### 7.2 类型契约

前端类型契约见 `frontend/src/types.ts`（`AppConfig` / `GenerationTaskSnapshot` / `GenerateParams` / `ResultItem` / `AssetEntry` / `WorkflowNode` / `WorkflowEdge`；`GenerationTaskSnapshot` 含可选 `submissionId`）+ `frontend/src/api.ts`（历史/成本：`GenerationHistoryItem` / `HistoryStats` / `BudgetInfo` / `BudgetCheck` / `BatchSubmitItem` / `BatchSubmitResult`），与后端返回结构一一对应（新增来源另有 `ProviderDraft` / `ProviderCreateResult` / `ProviderProbeResult`）。改接口必须同步改这里和对应测试。

### 7.3 路径与配置基准

| 基准 | 定义 | 使用处 |
| --- | --- | --- |
| `WORK_ROOT` | `Path.cwd()`，进程启动时固定 | 默认输出目录、`display_path` 相对显示 |
| 配置文件目录 | `batch_prompts.json` 所在目录 | 批量清单里写的相对路径（参考图、输出目录）在此解析 |
| `__file__` | 代码文件位置 | `.env`、`frontend/dist` 定位 |

- 默认输出目录 `WORK_ROOT/output`（config 的 DEFAULT_OUTPUT_DIR，api 与 server 共用）。
- `.env` 由 config 自动加载（不覆盖已存在的环境变量）：放密钥（`API_KEY_<PROFILE>` / 旧写法 `AIWANWU_API_KEY`）与本机覆盖（`ACTIVE_PROFILE`）；模板见 `.env.example`。
- 路径展示统一走 `server.display_path`：相对 WORK_ROOT + 正斜杠。

## 8. 关键设计决策

### 8.1 任务与并发

- **提交即返回**：`/api/generate` 请求线程只做校验与兜底文件落盘，生成在线程池，事件循环永不阻塞（新开窗口/加载页面不受影响）。
- **取消是逻辑取消**：排队中的出队后永不发上游请求（不花钱）；running 无法中断上游请求，跑完当前张才作废——**产物仍落盘、仍计费**，只是不派回画布（界面明说这一点，不假装已停）。
- **文件名并发唯一**：全局序号 + 时间戳防同秒碰撞；日志写 JSONL 用线程锁串行；tkinter 选择器与 explorer 置前用 `_UI_LOCK` 串行化；窗口计数器用锁保护自增。
- **生成超时**：请求 300 秒（图生图 + 2K 可能 1-2 分钟）。

### 8.2 画布数据模型

- **独立任务模型**：连线 = 参考图输入（非执行顺序），提示词节点间无依赖，「全部运行」= 全部提交到服务端并发队列。
- **取消入口**（画布侧，任务侧语义见 5.3 任务驱动模型与后端任务状态机）：单卡「取消」按钮（仅排队/生成中出现）+ 工具栏「取消全部 (n)」（仅在跑任务 > 0 时出现，替代原先无处可点的 `cancelAllTasks`）。点完不立刻复位——先置节点 `cancelRequested` 显示「取消中…」并禁用，等终态快照到达才清（后面排着长队时要等 worker 取到它，状态才翻成已取消）。判定口径是**本机意图 OR 服务端快照**：`useGenerationTask` 记下「本窗口点过取消」（`requestedCancelRef`），终态之前一直压住「点取消那一刻之前」的旧快照——否则每秒的秒数推送会把「取消中…」冲回可点，用户能重复点；而服务端始终没认下时（404/过期）查询失败会兜成 failed 并清掉意图，按钮不会永久禁用。「运行」按钮排队中/生成中本就禁用，所以「取消」在忙碌期是卡片上唯一可点的动作。取消落地后卡片回 `idle`（`CanvasPromptNodeData.status` 不新增 `cancelled`，避免动持久化语义），只在画布日志留一行（服务端不记取消日志）。
- **自动整理=布局管道**（`layout.ts`，纯函数、边不变）：① 裁剪（选中节点 + 未选中的「只读锚点」固定参与对齐、不移动）→ ② 最长路径分层（环回边不计层；孤立图/组 0、提示词 1）→ ③ pass A 浅→深按前驱质心排序（确定群顺序：左卡片组/右卡片组）→ ④ pass B **自底向上定位**（深→浅，按后继质心：图片组站到其卡片簇中央上方、图片站到组中央上方、共享图站到多组中央；叶子层保持不动）→ ⑤ 块化放置（同源提示词成块、块内标题序、块间标准间距）。**重复整理严格幂等**：无锚点选区以「输入选中块中心」为锚整体对齐，连续点击不漂移。直连卡与组连卡共用「参考锚点 = 直接前驱」抽象（一跳/两跳，无特例）。多层链（提示词→结果图→组→提示词…）由分层 + 自底向上自然延伸，结果图被复用时按多个后继质心对称分叉。
- **派生路径不落盘**：图片节点只持久化 registryId，url/absPath 加载时实时重建——项目目录改名/移动后旧存档自愈；URL 构建单一入口 `registry.image_url()`（canvas shim re-export 同名），注册表解析单一入口 `resolve_asset(id)`。
- **统一存储模型**：画布与经典表单走后端同一套存储——`kind`（canvas/result/ref）标记图片来源；一次生成即一份提交图快照（`output/submissions/`，图片组→提示词→结果）；账本（`generation.jsonl`）每行带 `submissionId/inputAssetIds/outputAssetIds` 联动。「导入画布」= 按 registryId 整图重建（前端 `mergeSubmissionGraph` 去重复用），不产生重复节点。
- **删除分层**：删节点仅断连线不删文件；删文件是图片节点显式操作。
- **缺图守卫**：参考图文件缺失时明确报错中止运行，不静默跳过导致不带参考图生成错误结果。

### 8.3 界面与交互

- **拖拽落点即用户指定坐标**：文件/工具栏按钮拖到哪节点就放在哪（首个图片左上角 = 鼠标松开处的画布坐标，多图从落点向右排开），不做重新居中——所见即所放；落点是唯一不经视口中心定位的创建来源（见 5.6）。
- **落点示意是纯 DOM 特效**：跟随光标的小胶囊（portal 到 body 的 fixed 元素），位置由 JS 直接写 transform——高频 dragover 移动不触发 React 渲染，只有拖拽起止等低频事件才改状态；文案/图标按意图区分（文件数量 / 新建类型），工具栏拖出画布外时**图标（红色 X）与文案（松开取消）同步切换**（`is-outside` 类直接写 DOM），与画布光标同款品牌色加号图形，风格统一。
- **一屏全览**：不用 ReactFlow 初始 `fitView` prop——空画布时它会被 React Flow 延迟到「第一个节点出现」才执行，导致新建/上传后视口突然放大跳动（已实测复现）。统一走 `fitCanvasToContent()`（自动整理/加载工作流/恢复存档后调用），`minZoom` 放宽到 0.05，fitView 显式允许缩到 0.02，节点再多也能全览。
- **自定义光标**：画布空白区域用高对比十字准星 SVG data-URI 光标（细十字 + 白描边 + 中心白底品牌色加号，与拖拽落点示意同款图形，风格统一），平移切抓手；文件拖拽悬停时切系统 `copy` 光标；可拖出按钮（新建卡片/图片组）悬浮时给 grab 光标 + 品牌色呼吸光晕 + 拖拽图标（`.btn-draggable`）——拖入时可放感明确、可拖出暗示明显。
- **预览弹窗（ZoomModal，画布/经典表单/生产历史共用）**：状态收敛为单一 `view{zoom,pan}`，缩放/夹紧数学在 `previewZoom.ts` 纯函数；**`zoom` 是叠在「已按窗口缩好的布局盒」上的倍率，不是相对原图的比例**——百分比读数与「实际大小」都要经 `layoutScale` 换算（`actualZoomPercent` / `zoomForActualPixels`），否则一张被缩到 68% 的图会显示 100%，「1:1」也只是回到刚打开时的大小（曾与「适应窗口」完全重合）；滚轮以指针为锚缩放，放大后拖拽平移（位移阈值区分点击与拖拽），双击复位，Esc/点击空白关闭。入口一致：画布图片节点双击或操作栏「预览大图」、经典表单参考图缩略图单击（UploadZone，不触发文件选择器）、结果图与生产历史图双击（Gallery / HistoryGallery）。**单击不再打开任何新页面**：早先是「单击延时 250ms 开原图、双击取消那次开窗」，代价是点一下就把浏览器切走（丢了当前上下文），且慢双击会连闪两个标签；现在单击无动作、双击直达预览，复制（图片本体 / 文件路径）与「新标签打开」都在弹窗控制条里做成显式按钮，`useImageZoom` 因此退化为纯开关、不再有任何延时或未决定时器。统一传注册表派生的完整 url，不传存储路径，组件内不再拼 `/api/image?path=`；可复制路径由 `imagePath.ts:imagePathFromUrl` 从 url 反解（外链 / blob / data URL 返回空串 → 该按钮不渲染）。全屏布局：`createPortal` 到 body（脱离含动画 transform 的祖先——如结果栏 `panel-card enter-up` fill both 后 transform 仍非 none，会把 fixed 后代捕获进自己的包含块），图片区占满窗口（contain 不裁切）。**控制层分工**：身份信息（文件名 + 关闭按钮）悬浮在**顶部一条**，操作在**底部单行控制坞**（缩放组 `缩小 · 读数 · 放大` → 细分隔线 → 视图组 `适应窗口/实际大小` → 细分隔线 → 动作组 `复制图片/复制路径/新标签打开`），两处都不占图片空间。旧版把这些全塞进底部同一个居中列（文件名居中一行、缩放一行、复制一行、10px 灰字说明一行），四行等权堆成一个灰方块，用户反馈「排版奇怪、很混乱」——判据是**一行只讲一件事、组间用分隔线**，长说明不再常驻，退到坞的 `title`；复制反馈做成坞上方的绝对定位浮标（**不进布局**，否则反馈一变宽窄就会让鼠标底下的按钮挪位置——改按钮文字也踩过同一坑）。
- **生成历史列表视图（HistoryGallery）**：两栏网格卡片——横排卡片：左侧 160px 结果图占满卡片高度（`self-stretch` + `min-h-36` 兜底卡片高度，object-contain 不裁切）| 右侧提示词随容器宽（2 行截断 `line-clamp-2` 超出省略）+ 元信息（时间·质量·尺寸）| 参考图（56px 小图、超出换行）| 全文字按钮横排、`mt-auto` 永远底部对齐（复制提示词/打开目录/导入当前画布）。提示词仅在 2 行真被截断时悬浮补全（`scrollHeight > clientHeight` 判定，短文案不弹多余浮层），浮层宽固定为屏幕 80%（`width: 80vw`）且**水平居中**（`left: 10vw`，左/右各留 10vw 永不出屏）、高随行数自动长；垂直跟随鼠标 y 并 clamp 进视口（下边防溢出靠挪位而非滚动条）、`pointer-events-none`。参考图按注册表解析（`inputRefs`），找不回时保留琥珀「参考图缺失」提示。**性能与聚合**：同参数记录由后端读取层聚合（7.1 /api/history，时间不算参数）——**只压失败、不压成功**（失败刷屏被折成一条，但每次成功都是一张真实产出的图，必须各占一行；早先连成功一起折叠，出现「画布两张图、历史一条」）。**分页滚动加载**——首屏 60 条、滚动接近底部 600px 内自动追加（`onScroll` 判定）+ 追加后未占满视口自动续拉，按钮仅兜底，DOM 恒在单页数量级，图片加 `decoding="async"`；注册表在路由内一次加载（`resolve_asset` 预载 entries）供全列表解析，避免逐行读盘。分页 offset 是聚合后偏移，与搜索/状态筛选天然一致（筛选在聚合前）。
- **选中操作栏**：选中 ≥1 个节点即出现「运行所选/自动整理/自动连线/设置输出路径/删除所选」，运行与设路径只作用于提示词卡片；自动连线只补选中节点之间的边（`workflow.ts:autoConnectSelection`，候选与新增边两端均限定在选中集合内），未选中节点不受影响；自动整理时未选中的参考图/组作为只读锚点参与对齐。
- **画布左下角控制坞（`.dock-row`）**：每行 = 图标 + 中文标签（放大/缩小/适应/聚焦/吸附/地图/锁定/帮助），React Flow 自带的「+ − ⛶ 🔒」全部关掉改走同一套 —— 纯图标竖列里除加减号外全靠猜（小地图两个方块状态肉眼无差别），用户反馈「完全糊里糊涂」。开关态用主体色 + 加粗表达，不靠换图标形状。行宽钉死 64px：四位数百分比（`200%`）与两字标签都放得下，且没有哪一行会按内容把整列撑宽。锁定只关「会改布局/视口」的东西（拖节点/框选/平移），滚轮缩放与「适应/聚焦」保持可用。
- **小地图放左上角**：右下角是日志轮播（最多 5 行、右对齐），放一起会压住刚出现的日志；右上角让给选中操作栏，左下角是控制坞。`Select` 下拉宽度取 `offsetWidth`（布局尺寸）而非 `getBoundingClientRect().width`：后者含祖先 `scale` 变换，画布缩到 30% 时浮层只有触发器可视宽度的 30%，每行被截成 `1536…`。
- **组节点叠卡**：`bg-brand/5` + `border-brand/10` 的若干层只向**左上**错开（≤12px，由根节点 `pt-3 pl-3` 预留，故永不越出节点边界），无旋转、各层同色。往右下叠会压到相邻节点、旋转会让每组朝向不一，混用两种掺色会出现「最底层发白、前两层发红」的割裂感。

### 8.4 视觉与动效

- **动画类统一收敛**在 `index.css`，组件只引用类名不写内联动画；只动 transform/opacity（GPU 合成），缓动统一 easeOutQuint；`prefers-reduced-motion` 时全部降级瞬时。
- **经典表单结果区 5 态面板（ResultPanel）**：任务空窗期由「死区」转为状态区——排队（琥珀圆环）/ 生成中（品牌色 `pulse-glow` 呼吸圆环 + 图标本体按自身颜色 `icon-breathe` 呼吸光晕 + 参数摘要：模式·尺寸·质量·参考图数）/ 失败（红环 + 错误摘要，完整错误留日志）/ 已取消（灰环）/ 完成与初始透传 Gallery。状态语义与画布 `StatusLight` 同族（琥珀=排队、品牌色呼吸=生成中、红=失败）放大为圆环，不直接搬圆点（密集画布与小面板的呈现尺度不同）；生成秒数只在右栏面板（视线位），左侧按钮只留忙碌语义（disabled + `btn-busy`），避免两处秒数重复跳动；日志区不再写排队/生成中的过程行，只收终态与操作反馈——过程状态与日志记录职责分离。**布局与切换**：主图形层 absolute 居中钉死、副信息层 absolute 底部独立生长——行增减（参数/预计/输出目录）不挤动主图形；状态切换保留旧面板一层交叉淡出（`swap-out` 0.18s / `swap-in` 0.28s，两层 absolute 叠放互不挤压），排队→生成中→失败/完成不再硬切（`prefers-reduced-motion` 全局降级兜底）。**保存消息用本机绝对路径**：server.py 生成消息/结果消息不再相对化（删除 display_path），前端日志区由 `logPath.ts` 解析路径段 → `CopyChip` 词条点击复制（等宽样式、复制后高亮反馈不换文字）。
- **LOD 抽象渲染（节点多不卡）**：`CanvasPage` 按缩放阈值切换（进入 0.1 / 恢复 0.2，迟滞防抖动）——抽象模式下图片节点保留缩略图与双击预览、去掉操作栏；提示词卡片只渲染大字标题 + 居中状态摘要（`CanvasNodes.tsx:promptStatusSummary`，不可编辑、无运行按钮）；分组节点去掉 hover 操作栏；`defaultEdgeOptions.animated` 关闭（连线动画静止）；React Flow 开启 `onlyRenderVisibleElements` 视口虚拟化。抽象只影响渲染，节点拖拽/选中/连线把手等基础交互不变。阈值常量 `LOD_IN_ZOOM` / `LOD_OUT_ZOOM`，后续可按体感微调。
- **transition 约束**：只作用于 border-color/box-shadow/opacity，**禁用 `transition-all`**——否则 textarea 拉伸等交互被尺寸插值拖慢（曾误判为性能问题，实为 CSS 插值）。唯一例外：连线路径的 `stroke/stroke-width` 过渡（hover 亮起延迟，见 9.4 第 2 条）。
- **画布节点动画**：作用在内层 `.node-pop`（外层 `.react-flow__node` 是定位 transform，不可位移）；动画类是运行时标记，保存/加载时剥离，不持久化。
- **动效与浮层堆叠**：transform 动画（fill both）让元素成为 stacking context，含浮层的卡片需 `relative` + 更高 z-index 才能盖过后续卡片。
- **窗口主体色**：accent.ts 按窗口编号黄金角取色，运行时覆盖 `--color-brand`；favicon 同算法动态生成——多开一眼可辨。两处图形（顶栏与 favicon）**共用同一份形状源** `src/brand/logo.svg`，经 `src/brand/logo.ts` 在构建期内联，桌面图标由 `scripts/desktop/make_icon.py` 读同一份生成，产物同步由 `check_docs.py` 比指纹；`--color-brand` 默认值是中性 slate 兜底（JS 加载前生效）。**终端提示同源换色**：rich 菜单「已打开窗口 #N」与启动脚本首窗提示均用该窗口的主体色（可按窗口号区分终端行）——算法三处同源：`frontend/src/accent.ts` / `main.py:accent_for_window`（rich 面板与菜单行）/ `scripts/desktop/window_accent.ps1`（供 `scripts/desktop/启动生图工作台.cmd` 首窗着色），改色相/饱和/明度必须三处同步，勿单独改一处。
- **行动按钮体系（两档 + 状态类）**：视觉语言统一为胶囊圆角（rounded-full，Tailwind 计算值为极大半径）+ 窗口主体色 + 涟漪反转动效。两档统一由 `::before` **按钮同形层**（`inset:0`、圆角 inherit、`scaleX(0)→1` 从中心向左右横向展开，`transform-origin:50% 50%`）实现 hover 填充——任意宽度（如 flex-1 撑满的「生成图片」）都完整覆盖，扩展方向是「中间往两边」而非四周放射；`--btn-fill` 固定填充底色（hover 文字变色不影响涟漪色）。`btn-primary` 常态实底白字，hover 白色涟漪反转 → 白底 + 主体色字（主行动，视觉重）；`btn-ghost` 与 primary 同源——无边框透明胶囊 + 常态主体色文字，hover 主体色涟漪填充 + 反白（次要行动，视觉轻）。状态类：`btn-busy`（生成中呼吸）、`btn-draggable`（可拖出）、`btn-danger`（红字红涟漪，配合 ghost）。透明按钮的典型场景即画布选中操作栏：毛玻璃面板（bg-white/20）上常态透明（主体色描边文字）、hover 涟漪填充反白，"删除所选"用 btn-danger；主行动仍放 btn-primary。涟漪扩散与文字变色同节奏 0.35s（横向展开、无 hover 缩放），主交互 0.3s（React Bits 类按钮范例）。非行动按钮（下拉触发/列表项/图标钮/分段控件/深色浮层条）不走本体系——语义是控件不是行动按钮。
- **顶栏品牌区 3D（logo + 标题整体）**：借 React Bits DepthText 手法——`App.tsx` 顶部常量 `BRAND_LAYERS`（10）/ `BRAND_DEPTH`（1.5）生成 translateZ 挤出层（总深 ≈15px 克制偏浅），`brandLayerColor` 用 `color-mix` 让各层从正面色向深度色渐变（logo 正面 `var(--color-brand)` 随窗口主体色、标题正面 `#262626` = body 文字色，均不硬编码）；**正面层（`z=0.6px`）比挤出层起点亮一档（基准色混白 12%：`LOGO_FACE_LIGHT`/`TEXT_FACE_LIGHT`），侧面渐变仍用原基准色不变**——深浅层次更分明；挤出层常驻 DOM 但被正面层盖住即平面态。指针跟踪（`pointerenter/move/leave` + rAF 平滑 0.14）只写 `--stage` 的 rotateX/rotateY：鼠标靠近才倾斜（±11°）显现立体并随光标摆动，离开回摆到平面。默认态无动画开销（停止 rAF 循环）；纯 JS 内联 transform 属直接操作型动效，不受全局 `prefers-reduced-motion` 降级影响；整体包 `<a target="_blank">` 点击打开远程仓库。

### 8.5 多开与继承

- **窗口编号**：服务端锁保护原子递增；前端沿用优先级 `?win= > window.name（跨刷新记忆，复制标签不继承）> 服务端分配`。
- **新窗口状态继承**：参考图已服务端落盘，继承只传元信息 + 尺寸/质量/输出路径（sessionStorage，几百字节）；提示词不保留。
- **参考图服务端化**：添加进上传区即上传落盘 `.refs/`；启动时清理 24h 孤儿文件（不引入引用计数）。
- **输出路径分两件事**（`output/.default_output_dir` + `output/.last_output_dir`）：
  - **显式默认** = 用户意图。只在点工具栏「默认输出路径」（弹系统选目录窗口）时改写，`/api/output-dir/default` 落盘；生成链路**永不写它**。
  - **上次使用** = 运行期事实。经典表单改路径即上报、生成成功也写（`/api/output-dir`）。
  - 新建卡片取 `显式默认 > 上次使用 > output/win{N}`（`server.resolve_default_output_dir`），`/api/config` 一并下发来源供界面区分。
  - 早先把两者当同一个值：任何一次跑图都会把用户设过的路径顶掉（跑一张旧卡片，新建卡片就跟着漂），且 `output/win{N}` 分区从此形同虚设。空 `output_dir`（批量/脚本）也只读默认、不回写。
  - **边界**：已存在卡片不追溯（批量改走选中栏「设置输出路径」，可撤销）；经典表单在用户手动改过之后不再跟随默认；默认目录离线（外接盘没挂）时本轮回退但不删记录。

## 9. 防错清单（历史 bug 模式 → 规范）

> 这一章是踩坑记录沉淀成的**开发规范**。每条：现象 → 根因 → 规范 → 测试保障。新代码触碰这些领域前先对照。

### 9.1 React Flow 陷阱

1. **初始 fitView 延迟放大**。现象：空画布新建/上传后视口突然放大跳动。根因：`fitView` prop 在空画布时被延迟到首个节点出现才执行。规范：不用初始 fitView，统一 `fitCanvasToContent()`。测试：E2E 断言「新建后视口不突变」。
2. **nodeTypes 引用不稳定导致全节点重挂载**。现象：新增节点闪烁、入场动画重播。根因：依赖了每次渲染重建的对象（如 hook 返回值）导致 nodeTypes 每次重建。规范：nodeTypes 用 useMemo 且依赖只放稳定回调；hook 的稳定成员（useCallback 缓存）单独进依赖数组。测试：`useGenerationTask.test.ts` 锁成员引用稳定。
3. **动画类残留重播**。现象：加载工作流后节点集体重播入场动画。根因：`node-enter` 类未剥离。规范：动画类不持久化——保存/加载/恢复时剥离；另加 `animationend` 事件委托自动清理。测试：recovery/workflow 单测断言剥离。
4. **外层定位 transform 被动画污染**。现象：节点动画播放时位置甩飞。根因：动画作用在 `.react-flow__node`（定位元素）上。规范：动画只加在内层 `.node-pop`。测试：`canvasStyles.test.ts` 锁定选择器。
5. **选中态选择器挂错层级**。现象：图片/提示词节点选中无描边。根因：选中标记加在节点根 div，CSS 却写在外层 `.react-flow__node.node-selected`。规范：标记加节点根 div，选择器写 `.react-flow__node .panel-card.node-selected`；高亮走 node-related 外层类，两套统一主体色 outline。

### 9.2 事件与时序

1. **contextmenu 时序标志漏网**。现象：右键拖出画布松开仍弹浏览器菜单。根因：Windows 上 contextmenu 在右键**松开后**才触发，mouseup 提前清除屏蔽标志。规范：**无状态屏蔽**——window 捕获层一律屏蔽非输入区 contextmenu，不做按下/松开标志。测试：E2E 断言拖出画布松开零泄漏。
2. **拖拽落点示意状态残留**。现象：文件拖出浏览器窗口或按 Esc 取消后，画布拖拽落点示意（跟随光标的小胶囊）卡住不消失。根因：没有 drop 事件触发复位，dragenter/leave 计数悬空。规范：window 层 `dragend`/`blur` 统一复位拖拽状态（计数归零 + 关示意）；文件拖拽 dragenter/leave 用计数平衡（子元素间移动成对触发）；工具栏拖出示意全局跟随，离开画布不隐藏、由 `dragend` 清理；示意位置走直接写 DOM 的 transform，**不经 React 状态**（高频 dragover 不渲染）。测试：E2E 断言拖入显示示意（含数量）、dragover 跟随光标、drop 后示意消失、拖起按钮即显示。
3. **dragover 阶段 `dataTransfer.files` 为空**。现象：拖入图片时落点示意一直显示「未检测到图片」。根因：浏览器延迟到 drop 才填充 `files`（dragover 中为空列表）。规范：拖拽中的文件**数量**用 `dataTransfer.items`（kind === "file"）统计，`files` 只在 drop 时读取并做 `isImageFile` 过滤。测试：E2E 断言拖入时示意显示正确数量。
4. **drop 前先判定拖拽意图**。现象：文本拖进提示词输入框被容器 drop 拦截（preventDefault 后文字丢不进）。规范：drop/dragover 先按 `dataTransfer` 类型判定（文件 / 画布自定义类型），**无关拖拽一律放行**，只接管「文件」与「工具栏按钮」两类。测试：E2E 拖入非图片文件不产生节点。
5. **pointer capture 重定向 click**。现象：预览弹窗点击关闭误判/失效。根因：放大态拖拽的 setPointerCapture 会把 click target 重定向到容器。规范：关闭判定用 pointerdown 的**真实按下元素**；放大态区分点击与拖拽用位移阈值（>5px 才算拖拽），未移动且按在空白 = 点击关闭。测试：E2E「放大后点图片边缘空白关闭」。
6. **拦截型交互吞掉点击**。现象：容器 stopPropagation 后点击无处可去。规范：任何拦截 pointerdown 的交互必须自证「点击 vs 拖拽」，并在两种缩放态下都可关闭。
7. **全局监听器残留**。现象：卸载后仍触发 setState。规范：effect 内注册的 window 监听必须成对 removeEventListener 清理。
8. **工具栏拖出画布外误建**。现象：把「新建提示词卡片/图片组」拖到画布外（工具栏/空白）松手仍新建（旧行为落点夹紧到画布边缘）。规范：工具栏拖出 drop 前判定落点是否在画布容器内（`isInsideRect`），画布外松手即取消、不夹紧放置；示意随位置切换「松开取消」文案 + 红色 X 图标（内层胶囊 `is-outside` 类 + textContent，高频 dragover 只写 DOM 不渲染）；文件拖入仍夹紧放置（上传语义不受影响）。测试：E2E 第 11 段（画布外松手取消 + 图标/文案切换 + 拖回画布仍新建）。

### 9.3 状态与引用

1. **提交竞态重复生成**。现象：快速连点同一节点提交两次。根因：映射登记在 await 之后。规范：submit 前同步登记占位（空 taskId），成功覆盖、失败清除；删除节点时兼容占位值。
2. **任务映射残留**。现象：删节点/加载工作流后状态卡死。规范：终态订阅回调解除映射，删节点/loadByName 同步清理两个映射表。
3. **级联偏移漂移**。现象：新建/上传节点越多越偏右下。根因：位置偏移按节点总数取模叠加（上传还双重偏移）。规范：位置策略只允许 `getCreatePosition` + `staggerCreatePosition`（纯函数，记忆最近落点阶梯 +30），任何入口不得自带偏移。测试：workflow 单测锁定阶梯行为。
4. **闭包捕获过期状态**。现象：回调里读到旧值。规范：需要最新值的地方一律走 ref（nodesRef/edgesRef/selectedIdsRef），回调依赖只放稳定成员。

### 9.4 CSS 与动效

1. **transition-all 拖慢拖拽类交互**。规范：transition 只含 border-color/box-shadow/opacity。
2. **连线 hover 亮起的延迟方向**。现象：想「悬停 0.1s 后才亮起」但用 base 规则的 transition-delay 导致**离开也延迟**（松手后还亮着）。规范：延迟只写在 `:hover` 规则里（`transition-delay: 0.1s`），base 规则只放属性与时长——进入延迟、离开立即回退；transition 只含 stroke/stroke-width（animated 边的 dasharray 动画不受影响）。该效果以人工验证为准，不做 E2E（合成悬停时序脆弱）。
3. **transform 动画锁死 hover**。现象：hover 效果失效。规范：入场动画只动 opacity 的场景不用 fill both 的 transform；overflow-hidden 会裁剪悬浮操作栏/下拉面板——提示词卡片用 min-w-0 + truncate 防撑宽，不用 overflow-hidden。
4. **浮层被后续卡片盖住**。规范：含浮层的卡片加 relative + 更高 z-index。
5. **全屏浮层被动画 transform 祖先捕获**。现象：`fixed inset-0` 的弹窗只覆盖容器大小（如放大预览只出现在结果卡片内，四周不是全屏）。原因：入场动画 `fill both` 结束后 computed transform 仍是非 none 的矩阵，把 fixed 后代的包含块改成该祖先。规范：全屏浮层（如 ZoomModal）用 `createPortal(..., document.body)` 渲染，脱离任何 transform/filter 祖先；不要依赖"恰好没有动画祖先"。测试保障：Playwright 断言预览容器 boundingBox == 视口。
6. **Portal 点击沿 React 组件树冒泡误关外层宿主**。现象：放大预览里点图片中间（非空白）却连带关掉外层遮罩（历史画廊退到画布）。原因：`createPortal` 内容挂到 body，但合成事件仍沿 **React 组件树**冒泡（非 DOM 树）——宿主遮罩的 `onClick=onClose` 收得到 Portal 内的点击，DOM 上的兄弟关系拦不住。规范：Portal 根（ZoomModal 的 `data-zoom-overlay` 层）必须 `onClick` stopPropagation 截停冒泡；关闭判定仍走 pointerdown（真实按下元素），两者职责分离。测试：WorkflowModals.test.tsx（组件单测锁定）。
7. **卡片表面的模糊不该随通透度自动增长**。现象：卡片文字压不住壁纸，用户反复报「看不清壁纸」。根因：`backdrop-filter: blur()` 跟着通透度往上加（曾到 80px），整卡糊成奶白雾、壁纸被洗成灰白，比不透明更挡视线。规范：**卡片表面恒不模糊**——`blurFor` 仍返回 `none`（函数保留只为「由 JS 注入整条字面量」这条路不破）；可读性靠壁纸降噪滤镜（`WALLPAPER_IMAGE_FILTER`）+ 卡片文字的极淡白描边兜底，输入框另有 `FIELD_ALPHA_FLOOR = 0.25` 底线（只抬输入框，不抬卡片/面板）。曾试过 8~12px 的中间档，同样被要求归零。测试：`surface.test.ts`（任何通透度都返回 `none`、底线只作用于输入框、alpha 单调）。
   **2026-10-03 修订**：这条原本写成「模糊绝不随通透度增长」，并据此把壁纸的模糊/压暗/缩放滑杆一并删除。维护者后来明确要求恢复**壁纸自身**的模糊与明暗调节（`wallpaperAdjust.ts`，两条独立滑杆，默认 0 / 1 即原图）。**两者不冲突**：被否掉的是「系统替用户决定、把背景弄走」，保留的是「用户显式选择的壁纸属性」，且与卡片通透度完全解耦（卡片仍恒不模糊）。判断口径：**可读性由谁决定**——系统自动改 = 不做；用户手动拉 = 做。
8. **CSS 里写「函数内嵌 var()」的声明被压缩器整条丢弃**。现象：本地 dev 看着对，构建后样式静默失效——`backdrop-filter: blur(var(--x))` 与 `hsl(… / calc(0.66 * var(--x)))` 都被证明确实会丢。规范：需要按 JS 状态算出的字面量，就在 JS 里拼成**整条值**再内联注入（`surface.ts` 的 `surfaceTokens`，与 `--color-brand` 同路）；CSS 侧只允许 `var()` 作为**整个值**（`backdrop-filter: var(--x, none)` 安全）。测试保障：`surface.test.ts` 只锁「三档都是合法 CSS 值」，压缩器丢弃这条**没有自动化断言**——改这类声明必须实跑 `npm run build` 后在 `dist/` 里确认声明还在。
9. **运行时 token 只写在 `.imagora-app` 上，Portal 弹窗拿不到**。现象：同一种按钮，弹窗外是主题色、弹窗内却是石板灰（`#475569`，即 `@theme` 兜底值）；弹窗里的卡片表面与通透度设置也一直不生效。根因：`ModalShell` 用 `createPortal(..., document.body)` 渲染，节点落在 `.imagora-app` **之外**，而 CSS 变量只向下继承——写在 App 容器内联样式上的 `--color-brand` / `--surface-*` / `--field-bg` 到不了弹窗。规范：**按运行状态计算、且要被 Portal 用到的 token，必须同时写到 `document.documentElement`**（`--accent-hue` 一直就是这么做的，其余 token 见 `App.tsx` 的同步 effect）；`.imagora-app` 的那份保留，用于首帧即生效、避免刷新闪一下兜底灰；两处取值同源，不会漂。判据：改任何 token 后，在弹窗打开态下比对 `getComputedStyle('.imagora-app')` 与 `getComputedStyle('.modal-panel')` 的同名变量是否相等。
10. **弹窗表面写死颜色 = 换色只换一半**。现象：换主体色 / 调通透度 / 选背景材质之后，页面变了而弹窗（生成历史 / 工作流 / API 配置）不变，像两套界面。根因：`.modal-panel` 的 `background` 是写死的 `rgba(251,251,248,.97) !important`，不读任何 token。规范：**弹窗表面必须读 `--surface-panel`**，与卡片共用同一套材质 token（`surface.ts` 的 `surfaceTokens` 算好后内联注入）；兜底值与 `BASE.panelTop` 对齐（hue 0 / 不透明档），JS 未注入时也不跑偏。判据：改材质后在弹窗打开态比对 `getComputedStyle('.modal-panel').getPropertyValue('--surface-panel')` 与卡片侧的 `--surface-card` 是否同色相同档位。
11. **滚动容器的水平内边距小于焦点环外扩量，左侧的环被裁掉**。现象：点开下拉框，聚焦特效左边被切平、右边正常（右边只是当时多写了一个 4px）。根因：`overflow-y: auto` 只裁到 padding box，而 `button:focus-visible` 的环是 `outline 2px + offset 3px = 5px`、`.field-control:focus` 的 `box-shadow` 是 4px；`.modal-body` 左侧内边距为 0 时元素左沿与容器左沿重合，向左的部分整条被裁。规范：**滚动容器的 `padding-inline` 不小于环的外扩量**，且两侧同值（`.modal-body` 取 6px）；不要靠在调用处写单边 `pr-*` 打补丁，那只会把「两边都裁」变成「左右不对称」。

12. **模块表面各自硬编码 = 换主体色只变一半**。现象：换成紫色主体色后，经典表单三张卡与输出区跟着变，顶栏、画布工具栏、画布主体纹丝不动 —— 同一屏里一半紫调、一半偏白，像是两套界面；更早一轮还出现过「左边卡片是粉的、右边结果区是白的」这种同屏反向。根因有三层：① 15 处容器写死 `rgba(255,255,255,…)`（生成历史整窗是 `#f4f1eb` 米色，另有加载工作流列表、下拉浮层、画布节点卡、结果缩略图、最近提示词行…），绕过 token 的次数比走它的还多；② 就算走了 token 也看不出来 —— token 写的是 `hsl(hue 30% 98.4% / a)`，98.4% 亮度 + 30% 饱和度算出来离纯白只有 **2/255**，**数学上不可见**，看到的「跟色」全来自 alpha 低、页面底色透上来，于是任何需要不透明的面（弹窗、列表行）颜色就消失，且「更强的一档」反而更白；③ 硬编码 `blur(12px)` / `blur(16px)` 让这两处单独把壁纸糊掉，与第 7 条直接冲突。规范：**容器底色只能来自 `src/surface.ts`**，它把表面拆成两个正交的轴 —— **掺色 `tint`**（这个面是什么色，按角色分配：外壳多、内容区少、画布为 0）与**不透明度 `alpha`**（用户的通透度滑杆），掺色由「对饱和基色 `hsl(hue 80% 62%)` 做线性混合」解出**真实 RGB**，`tint` 因此等于可见量本身（0.10 ≈ 离白 15/255）。六档角色：`base` 骨架 / `card` 大面衬底 / `panel` 台面 / `float` 浮层 / `inset` 内嵌 / `plain` 中性。**嵌套不变量：内层不许比外层更透**，否则壁纸从容器中间透出一个洞（默认通透度：卡片 0.47 < 台面 0.85 < 浮层 0.94）。**画布主体走 `plain`（掺色 0）是有意的** —— 它是看图的台面，带色会干扰对生成图本身颜色的判断，别「顺手统一」掉。**可读性优先的角色不再用硬 floor**（老写法把通透度滑杆压成死值：拉到一半以上毫无反应），改为各角色自己的两端插值，台面全程 ≥0.68、浮层 ≥0.86。护栏：[surfaceAudit.test.ts](../frontend/src/surfaceAudit.test.ts) **解析 `index.css` 与全部 `.tsx`**，未登记的写死底色、或任何硬编码 `backdrop-filter: blur()` 直接红；豁免清单必须写理由，且 TSX 侧按「文件 + 类名」精确匹配（不做全局放行，否则清单会变成后门）。判据（可复跑）：同一表面在 `--accent-hue` 取 0 与 285 两档下 `getComputedStyle().backgroundImage` 必须不同（画布主体除外）、采样像素离白 >6/255、`backdropFilter` 一律 `none`。
13. **弹窗内的浮层被 Esc 抢关**。现象：配置弹窗里展开下拉，按 Esc 想收起下拉，结果**整个弹窗被关掉**，正在填的内容全丢。根因：`ModalShell` 的 Esc 监听挂在 `document` 上且是 **capture 阶段**（`addEventListener("keydown", h, true)`），比浮层自己挂在触发元素上的 `onKeyDown` 先跑；`preventDefault()` 只能拦默认行为，拦不住已经排在前面的监听。规范：**关窗类全局快捷键要先问「有浮层吗」**——浮层打开时 `Select` 调 `pushPopup()`、关闭时 `popPopup()`，`ModalShell` 在关窗前 `hasOpenPopup()` 为真就让给浮层，因此需要两次 Esc（先收浮层、再关弹窗）。计数必须做负数保护，否则多余的 `pop` 会让 `hasOpenPopup()` 永远为真、弹窗**再也关不掉**（比原 bug 更糟）。测试：`popupLayer.test.ts`（含负数保护）+ `ModalShell.test.tsx` 的交互回归（已验证去掉守卫会失败）。

### 9.5 测试隔离

1. **提交类用例把任务丢进全局任务池 → 真打上游**。现象：`output/` 根目录反复出现 9 字节桩文件与 1~3MB 真图，账本里对应 prompt 是 `repaint the sky`（mask 用例的提示词），费用 0。根因：`generate()` 把任务交给**全局 `task_manager`** 后立刻返回；worker 线程可能在用例的 `monkeypatch` 撤销**之后**才真正执行，那一刻 `server.generate_image` 的函数级替身已失效 → 真实请求 + 真实落盘。规范：① 只读提交结果的用例把任务池换成「只登记不执行」替身；② `conftest.py` 的 `forbid_real_generation` 在 **session 作用域**兜底把 `server.generate_image` 换成抛错版（函数级撤销早，挡不住跨用例泄漏）；③ `isolate_user_data` 把 `config.DEFAULT_OUTPUT_DIR` 也指向 tmp ——它是「写哪」的唯一来源，漏了就写进用户目录。只挡 `server.generate_image`、不挡 `core.api.generate_image`：后者有成批「直调 + mock 网络」的合法用例。
2. **用例断言写死真实目录名**。现象：`build_default_output_path` 的用例断言 `parent.name == "output"`，隔离把默认目录改成 tmp 后立刻红。规范：断言对 `config.DEFAULT_OUTPUT_DIR` 本身，不对它的字面名字。

### 9.6 配置写入

1. **界面写配置文件会污染 git 状态，且可能在冲突时静默丢数据**。现象：改的是一个本机偏好（我用的哪家接口），动的却是 git 跟踪的 `config.json`。规范：`config.json` 是**出厂目录**（只读），本机偏好一律写 `.env` 的 `<KEY>_<PROFILE>` 覆盖键，见 4.4。
2. **从解析后的 dict 重新 dump 配置文件会冲掉用户内容**。现象：`.env` 里的注释、空行、键顺序、引号风格被重排，diff 爆炸。规范：**行级原地更新**——只改目标行，其余逐字保留（`core/config_write.py`）。
3. **写配置文件必须原子**。现象：写到一半崩溃留下截断的 `.env`（可能半个密钥），服务起来后完全无法生图。规范：`.bak` → 临时文件 → `fsync` → `os.replace`；失败时清理临时文件、原文件不受损。
4. **用模块顶层 `from core.config import XXX` 的值做运行时判断**。现象：`server.py` 里 `BASE_URL` / `DEFAULT_MODEL` / `ACTIVE_PROFILE` 是**导入时绑定**的快照，测试替换 `config.X` 不生效，将来做热加载也读不到新值（曾导致 pending 恒为空）。规范：运行时一律走 `config.xxx`。
5. **两个解析器各写一套**。现象：`config_write.split_key_value` 与 `config._load_env_file` 规则若不一致，改的键可能被加载器忽略，或更糟——漏改它实际会读的键。规范：两者按同一套规则（strip / 跳过注释 / 按第一个 `=` 切）。

### 9.7 坐标与几何

1. **screenToFlowPosition 基准**：它接受相对视口容器的屏幕坐标并内部修正（domNode = `.react-flow` wrapper），传 window 坐标给 `getBoundingClientRect` 中心即可，**不要再手动减 rect 偏移**（会双重偏移）。换算公式：flow = (screen - vx) / zoom，与库实现保持一致。
2. **预览缩放锚点**：transform-origin 为图片中心时，保持指针下内容不动的补偿公式 `pan_new = p - (p - pan_old) * k`（k = zoom_new/zoom_old）；数学进纯函数，UI 不重算。
3. **平移夹紧**：放大后图片主体不能丢出可视区，中心对称夹紧；未测量（box 为 0）时原样返回。测试：previewZoom.test.ts。

### 9.8 进程与并发

1. **taskkill /t 只杀子树不杀父**：单杀监听层会留 uv/python 宿主。规范：先回溯祖先链再连根杀。测试：test_main_process.py。
2. **PID 文件互相覆盖**：多开脚本同时写会误杀/漏杀。规范：端口是唯一真相源，动态探测，不落 PID 文件。
3. **多 worker 翻倍并发**：uvicorn 必须单 worker。
4. **配置 typo 静默失效**：config.json 拼错键名/选不存在的 profile → 控制台警告 + 回退默认。规范：profile 键有白名单校验（`unknown_profile_keys`），新增键必须同步加入 config 白名单和测试。
5. **写文件瞬时锁（Windows 杀软/云同步）**。现象：输出目录存在且可写、手动写入正常，但生成结果偶发 `PermissionError [Errno 13]`——杀软（Defender/火绒等）实时扫描刚落盘的文件、或 OneDrive 云同步托管目录时短暂持有句柄。规范：图片落盘统一走 `core/api.py:write_file_with_retry`（只捕获 PermissionError、退避 0.3s/0.8s/1.5s 重试 3 次、耗尽原样抛出、其余异常不重试）；若每次都失败则非瞬时问题，应排查目录权限/杀软排除目录，不依赖重试框住。测试：test_core_api.py「瞬时锁重试」。

### 9.9 数据一致性

1. **历史展示与导入判定漂移**。现象一：生成历史列表显示图片（`exists=true`）但导入报「不是可用的历史输出」；现象二（画布回流）：每张结果都弹软提示「节点 prompt-xxx：生成成功，但结果导入画布失败」，历史里却能看见图。根因（同一条坑的两个方向，任一侧漂移都会复现）：展示按资产注册表解析（账本带 outputAssetIds → `resolve_asset`，`.assets` 副本在、原 output 文件被移动/删除仍显示），导入白名单必须同时接受账本行的**两个合法派生路径**——注册表副本路径（历史面板「导入画布」传它）与账本 `output` 原路径（画布回流传任务结果 URL 反解的 run_generation 落盘路径）——只收其一必然另一侧失配：曾先只认原路径（原文件被清理后「列表有图、导入失败」，f4126fe 修至注册表副本优先），继而只认注册表副本（画布回流固定失败，本条修复）。规范：导入白名单 = 每个账本行的注册表副本路径 ∪ output 原路径（原路径须文件仍存在）；判定仍只来自账本记录，任意未记录路径拒绝（不能退化成任意路径读取接口）；展示与导入共用 `resolve_history_asset_path`。测试：test_server_helpers.py「只接受记录路径」+「注册表副本路径可导入」+「带 outputAssetIds 时原路径可导入（画布回流回归）」。

2. **「同参数聚合」把成功记录也折掉了 → 产出比历史多**。现象：同一张提示词卡片、同一提示词、同一参考图连跑两次，画布上踏实出现两张图，生成历史里却只有一条（两次的 output / outputAssetIds 只有最新的那行在列表里，被折掉那张连「导入画布」的白名单都进不去）。根因：聚合键（mode/prompt/size/quality/refs/inputAssetIds，**时间不算参数**）本来是为「同一卡片失败多次刷屏」设计的，实现却对所有状态一视同仁地「只留最新一条」——而**成功不是重复，是产出**：同参数再跑一次就是另一张图。规范：聚合只压失败——`status == "ok"` 的行**永远全留**；同组的失败行最多留最新一条，且仅当它比该组最新成功更晚（否则已被成功取代）。判据：账本里同参数 N 条 ok → 列表里就是 N 行；不变量「成功的 outputAssetIds 集合 ⊆ 历史列表可点到的集合」。测试：test_core_history.py「成功记录不去重（连跑两次 = 两行）」「成功之后的失败照实显示（更早的成功仍各占一行）」。

## 10. 测试与验证

### 10.1 单元测试

- 后端 pytest：**475 用例**（Windows 含 5 个专属测试，CI 必须 `windows-latest`；默认 tmp 路径的 WinError 5 历史坑已随目录重建恢复，见 AGENTS「活跃坑」）
- 前端 vitest：**1061 用例**；`tsc --noEmit` + `vite build` 成功；`npm run lint` / `uv run ruff check .` 均零告警
- 文档完整性：`python scripts/check_docs.py`（相对链接可解析 + AGENTS/tests-README/ARCHITECTURE/frontend-README 的测试计数与源码一致；改任何文档后必跑，见 [scripts/README.md](../scripts/README.md)）
- **逐文件用例 / 覆盖范围 / 变更影响路由（完整表）见 [tests/README.md](../tests/README.md) 文件索引**

### 10.2 端到端（E2E）

`frontend/e2e/verify_canvas.py`（Playwright，105 断言，自包含测试图，需服务已启动）：新建/上传居中（精确到像素）、视口不突变、右键菜单屏蔽、预览打开与点击空白关闭（含放大态）、文件拖拽添加（落点示意跟随光标与数量 / 落点精确 / 多图批次排开 / 非图片过滤）、工具栏按钮拖出新建 + **拖到画布外松开取消（示意切「松开取消」+ 红色 X 图标，拖回画布仍新建）**、缩放滑杆与视口双向同步（拖滑杆改视口 / 滚轮缩放回灌读数）、小地图开关（默认关 → 开 → 关，选择落 localStorage）、图片节点裁剪与放大（入口按钮 → 对话框 → 确认后派生新节点且原图保留，裁剪产物还能继续放大）、**切分 3×2 一次产 6 张**、**拖拽吸附**（对齐时出现 `.snap-guide`、关掉开关即消失）、**聚焦所选节点**（视口缩放变化且不失真）、**蒙版局部重绘**（涂一笔 → 确认 → 出现「蒙版」角标 → 点击清除）、**提示词 `@` 引用不存在的图会在运行前被拦下**（不发请求不花钱）、**节点右键菜单**、**连线三态**（idle 1.5px → hover 2.5px → 选中 → Delete 删除）、**尺寸下拉手填清单外尺寸**。改画布交互后必须跑通它再加 E2E 断言。运行前置条件与命令见 frontend/README.md。

### 10.3 未覆盖

`generate_image`（需真实网络与计费）、`run_batch_generation` 实际生成分支、`/api/status` 纯探测逻辑——靠 dry-run 与人工验证。

## 11. 变更守则

### 11.1 通用流程

1. 改接口：同步 `types.ts` + server 路由 + 对应测试 + 本文档 7.1 表。
2. 加后端能力：先在 `core/` 写纯逻辑和 pytest，再挂薄路由。
3. 加前端状态：先想清楚归谁持有（页面层/组件层/纯函数），纯逻辑进 `src/` 根下的纯函数模块并配单测。
4. 提交前必跑：`tsc --noEmit`、`npm run lint`、`npm test`、`npm run build`；画布改动再加 E2E。

### 11.2 改画布交互的检查清单

- 动没动「新建节点落点」？自动定位只允许走 `getCreatePosition`；拖拽落点是用户指定坐标，直接换算松开点，两处均不得自带偏移（见 5.6）。
- 动没动右键/点击/拖拽？对照 9.2 防错清单（拖拽类先对照 2/3/4 条），E2E 必须覆盖放大/未放大两种状态；文件拖拽与工具栏拖出加新交互须补 E2E（落点位置 + 多图批次排开 + 按钮拖起即显示示意）。
- 动没动节点动画/样式？对照 9.1、9.4，动画类记得保存/加载剥离。
- 动没动 fitView/缩放？对照 9.1 第 1 条，别用初始 fitView prop。
- 动没动任务状态？对照 9.3，双层守卫和映射清理不能丢。

### 11.3 文档同步

功能变更后同步四处（文档分层，职责不重叠）：

- [README.md](../README.md) — 用户视角，只写用途与用法
- [docs/ARCHITECTURE.md](ARCHITECTURE.md)（本文档）— 宏观索引 + 设计决策 + 数据流 + 契约（第 7 章）+ 防错清单（第 9 章）；模块级细节一律在子 README，不在此重复
- 子树 AGENTS.md（规则层，自动注入）— 每目录「怎么工作」约束：[core](../core/AGENTS.md) / [frontend](../frontend/AGENTS.md) / [tests](../tests/AGENTS.md) / [scripts](../scripts/AGENTS.md) / [docs](AGENTS.md)
- 子目录 README（文档层）— 模块手册（文件索引 + 变更影响路由 + 上下游依赖）：[core](../core/README.md) / [frontend](../frontend/README.md) / [tests](../tests/README.md) / [scripts](../scripts/README.md) / [docs](README.md)
- [AGENTS.md](../AGENTS.md) — 跨会话仪表盘（<80 行）：测试数字 / 待办 / 活跃坑 / 变更速查表；轮次记录进 git 不堆文档

**双件纪律**：同目录 `AGENTS.md`（规则）与 `README.md`（文档）职责分明——约束只写进 AGENTS，文件属性/变更路由只写进 README，同一事实不跨文件重复（README 中与 AGENTS 重复的纪律条文应删除或改为指向）。

文档彼此**双向引用、层层递进**：根索引（本文档 / [AGENTS.md](../AGENTS.md)）指向子 README，子 README「参考」节回引根，从任意一层都能回到索引；同一事实只在一层书写——用户层"怎么用" / 索引层"去哪查" / 手册层"是什么、改哪" / 圣经层"为什么、防什么"。改任何文档后复查：链接可解析（校验脚本）、本文档与 AGENTS 的数字/坑不过时。

文档滞后即技术债。

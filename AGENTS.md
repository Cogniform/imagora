# Imagora — 维护索引（仪表盘 + 变更路由）

> 全局索引：本项目只放仪表盘与变更路由。模块细节查子目录 README 手册，设计/决策/防错查 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，用户用法查 [README.md](README.md)。
> **放置约定**：固定放项目根目录，主流 AI 编程 agent 启动时自动发现并注入上下文——因此本文档必须保持"仪表盘含量"（几十行），细节一律外置子 README。
> **互改联动**：改任何子 README / ARCHITECTURE 后，复查本文档引用是否仍有效、数字/坑是否过时；本文档是其他文档的入口，双向引用缺一即断链。改文档后跑 `python scripts/check_docs.py`（链接可解析 + 仪表盘计数与源码一致，见 [scripts/README.md](scripts/README.md)）——**CI 的前端 job 也跑它**，漂了就红，不靠人记得。

## 文档体系（双向引用，层层递进）

- 分层不重叠：根 [README.md](README.md)（用户用法；英文版 [README_en.md](README_en.md)，**中英同改，改一必改二**）→ 本文档（维护索引）→ [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)（设计圣经）→ 子目录 README（模块手册）
- 双件分离：AGENTS.md 只写规则，README.md 只写是什么/怎么改（每可维护目录一对，两者不互相重复；如 [core/AGENTS.md](core/AGENTS.md) 自动注入、[core/README.md](core/README.md) 按需读）
- **双向引用**：根索引指向子手册（上文变更速查 / 文档地图），子手册「参考」节回引本文档与 ARCHITECTURE——从任何一层都能回到索引，缺一即断链
- **层层递进**：同一事实只在一层书写——用户层写"怎么用"，索引层写"去哪查"，手册层写"是什么/改哪"，圣经层写"为什么/防什么"
- 改任何文档后复查：链接可解析（可跑校验脚本）、仪表盘数字与坑不过时

## 子代理并发配额（派活前先看）

同一时刻**在跑**的子代理数量上限，按子代理所用的模型算：

| 模型（可读名） | 同时最多 |
| --- | --- |
| `workbuddy/deepseek-v4.1-flash` | 4 |
| `deepseek-flash` | 3 |
| `trae-glm-5.3-flashx` | 3 |
| `workbuddy-bridge/deepseek-v4.1-flash` | 2 |

- 实际 id 形如 `cliproxyapi/workbuddy-deepseek-v4.1-flash`，以 `list_subagent_models(provider="cliproxyapi")` 返回的为准。
- 表内按**并发**计（同时开着几个），不是累计；跑完一个再开一个不受限。
- 上表没列出的模型不设额外配额。

## 变更速查（改代码前先查这里）

- 改 core/ 任意文件 → 查 [core/README.md](core/README.md) 文件索引 → 跑 `pytest tests/test_core_*.py` → 如改设计同步 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 改 [server.py](server.py) 路由 → 查 [core/README.md](core/README.md)（registry/graphstore/history/cost 节）→ 跑 `pytest tests/test_server_*.py` → 同步 [frontend/src/types.ts](frontend/src/types.ts) + [frontend/src/api.ts](frontend/src/api.ts) + ARCHITECTURE 7.1 表
- 改成本统计 / 预算保护（[core/cost.py](core/cost.py)）→ 跑 `pytest tests/test_core_cost.py tests/test_server_cost.py` → 预算落在 `output/.budget.json`（git 忽略，勿改成进仓库的配置）
- 改 frontend/src/ 纯函数 → 查 [frontend/README.md](frontend/README.md) 文件索引 → 跑 `npm test`（有单测即够，无需文档）
- 改 frontend/components/ UI → 查 [frontend/README.md](frontend/README.md) 组件索引 → 跑 `npm test` + [E2E](frontend/e2e/verify_canvas.py) → 样式改 [index.css](frontend/src/index.css)（公共类先登记到 [frontend/README.md](frontend/README.md)「样式体系」节，不是根 README）
- 加/改**模块容器**（顶栏、卡片、工具栏、画布主体、弹窗这类带表面的块）→ 先按 [frontend/README.md](frontend/README.md)「样式体系」的**表面分层**归角色（`base` 骨架 / `card` 衬底 / `panel` 台面 / `float` 浮层 / `inset` 内嵌 / `plain` 中性），底色只能来自 [surface.ts](frontend/src/surface.ts)，**TSX 挂 `.surface-*` 角色类、别写 `bg-white`，也不写硬编码 `blur()`** → 跑 `npm test`（[surfaceAudit.test.ts](frontend/src/surfaceAudit.test.ts) 会红）→ 判据：改 `--accent-hue` 后该容器背景必须跟着变（画布主体除外）、采样像素离白 >6/255、`backdropFilter` 恒 `none` → 防错条见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 9.4 第 12 条
- 改**弹窗内的浮层 / Esc 行为**（下拉、日期选择、自绘浮层）→ 浮层开关必须配 `popupLayer` 的 push/pop，否则 Esc 会连弹窗一起关掉 → 跑 `pytest` 无关、跑 `npm test`（`popupLayer.test.ts` + `ModalShell.test.tsx`）→ 防错条见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 9.4 第 13 条
- 改配置加载 / 本机覆盖通道 / 配置写入接口 → 查 [core/README.md](core/README.md) 的 config.py、config_write.py、config_guard.py 三节 → 跑 `pytest tests/test_core_config.py tests/test_core_config_override.py tests/test_core_config_write.py tests/test_server_config_write.py tests/test_server_config_profile.py` → 契约同步 [docs/config-write-api-design.md](docs/config-write-api-design.md)
- 改**本机来源层**（`providers.local.json` / 「添加第三方供应商」）→ 查 [core/README.md](core/README.md) 的 provider_store.py 节 → 跑 `pytest tests/test_core_provider_store.py tests/test_server_config_providers.py` → 前端跑 `npm test`（`ProviderModal.test.tsx`）→ **三条不许破的边界**：密钥只进 `.env` 不进本机来源文件、新建来源默认不切换、校验失败必须不落盘
- 改 [scripts/migrate.py](scripts/migrate.py) 或存储格式 → 查 [scripts/README.md](scripts/README.md) → 跑 `pytest tests/test_core_migrate.py` → **必须先 Handoff 确认（硬边界）**
- 改测试文件 → 查 [tests/README.md](tests/README.md) → 按模块筛选跑 → 增/删用例后更新本文档「仪表盘」数字

## 仪表盘（最近验证快照，2026-09-29，main）

- 后端 pytest：**454 passed**（命令与逐文件覆盖见 [tests/README.md](tests/README.md)）
- 前端 vitest：**534 passed**；tsc + vite build 成功；lint / ruff 零告警（命令见 [frontend/README.md](frontend/README.md)、[tests/README.md](tests/README.md)）
- E2E [verify_canvas.py](frontend/e2e/verify_canvas.py)：**60/60 PASS**；[verify_provider.py](frontend/e2e/verify_provider.py)：**38/38 PASS**（前置：起 7860 服务，见 [frontend/README.md](frontend/README.md)）
- 迁移（v1→v2 / .canvas→.assets / 账本回填）已完成，日常无需执行（见 [scripts/README.md](scripts/README.md)）

## 构建时机（三套构建互不相干，别混着做）

- 改 `frontend/src/**` → 在 `frontend/` 跑 `npm run build`；不跑则浏览器仍拿旧 `dist/`（改动"看不见"）
- 改 `scripts/desktop/launcher.cs` 或 `scripts/desktop/启动生图工作台.ico` → `powershell -File scripts\desktop\make_launcher.ps1`（换图标要先跑 `scripts/desktop/make_icon.py` 再编译，图标是编译期内嵌的）；**编译前先关掉正在运行的启动器窗口**，Windows 不允许覆盖运行中的 exe
- **换品牌图形（logo）是一条链，漏一环就出现"顶栏新图、标签页旧图"**：改 [frontend/src/brand/logo.svg](frontend/src/brand/logo.svg)（全仓唯一形状源，顶栏 / 动态 favicon / 门面首屏都从它取）→ 跑 `scripts/desktop/make_icon.py`（同时刷新 `scripts/desktop/icon-source.sha256`）→ 关掉正在运行的启动器 → `powershell -File scripts\desktop\make_launcher.ps1`。前两环由 `check_docs.py` 兜（指纹不一致就红），后两环只能本机做，CI 不测双击
- 无需构建：后端代码（`main.py` / `core/` / `server.py`，清 `__pycache__` 重启即可）、`scripts/desktop/启动生图工作台.cmd`（exe 只转发不解析其内容）、文档与测试

## 提交前检查（本地 hook）

启用一次即可（每个 clone 执行一次）——`git config core.hooksPath .githooks`。

之后 `git commit` 会自动跑：改了 `.py` → `ruff check`；改了 `frontend/**` 源码 → `eslint`（仅暂存文件）。慢检查（tsc / 单测 / E2E）不放进 hook，避免拖慢提交；它们由 CI 兜底。

CI 在 push 后自动跑，红叉处理顺序：`gh run view <id>` 看哪个 job 挂了 → 代码问题就修了重推；网络 / flaky 用 `gh run rerun <id> --failed` 重跑（未提交的本地改动不会重跑）。

## 常用命令（后端）

- `uv run pytest`：默认临时目录即可（历史 WinError 5 坑与解法见「活跃坑」）；逐文件覆盖见 [tests/README.md](tests/README.md)
- `uv run ruff check .`：Lint（ruff 默认规则集，列宽默认 88）
- `uv run ruff format .`：格式化（`--check` 只看不改）
- 前端 npm 命令（dev / build / lint / test）→ [frontend/README.md](frontend/README.md)

## 待办

- [ ] 重新生成 [assets/screenshots/](assets/screenshots/) 下的 README 预览截图：现有图与当前 UI 不一致（顶栏控件高度、卡片编号水印、容器表面渐变、滚动条均已调整），且外观体系（主体色 / 背景材质 / 壁纸 / 通透度）新增后仍无对应图。门面「界面一览」已声明「图待重拍」并留了两处槽位与图注（外观弹窗打开态、铺壁纸的整页效果），要拍到哪些状态见 [assets/README.md](assets/README.md)
- [ ] 门面首屏图标：[frontend/src/brand/logo.svg](frontend/src/brand/logo.svg) 是单色 `#475569` 且无底板，GitHub 深色模式下对比约 2.4:1、偏暗（浅色模式正常，不是图裂）。要么给图标加底色、要么换一枚带底的图、要么首屏不放图——现状是"接受"，见 2026-09-29 README 重写那轮
- [ ] CLI 与网页端功能不对等（预算闸门 / 历史与花费回读 / 取消 / 提示词导入格式 / 切 profile，全清单在 [issue #35](https://github.com/zlZayn/imagora/issues/35)）：其中**预算闸门**最要紧——`gen` / `batch` 直连 `generate_image`，不看 `dailyLimit` 也不看 `singleRunLimit`，与门面宣传的「预算保护」不一致，补闸门会改变 CLI 成功/失败语义，**等拍板**；其余各项按该 issue 清单逐项定
- [ ] 拆分 [frontend/src/components/CanvasPage.tsx](frontend/src/components/CanvasPage.tsx)：**先补行为基线测试**（当前覆盖薄、裸拆风险高），再分步拆、每步独立验证，CI + E2E 兜底；不急于一次拆完，也不混进严格开关批次
- [ ] 链接检查两套并存：[scripts/check_docs.py](scripts/check_docs.py) 的链接项与 skill 工具 `check-markdown-links.py` 功能重叠；2026-09-30 决定先保留——check_docs.py 已接进 CI，skill 工具只在本地跑，整掉会让 CI 失去链接校验
- 无其他（8-23 备份清理；8-24 文档体系重构 + CI 完善；9-22 成本看板 + 预算保护；9-29 `check_docs.py` 接进 CI 前端 job；10-03 UI 统一批次：选中操作栏回归统一样式 / 帮助入口进左下角控件 / 窗口角标字体统一 / API Key 走顶栏状态角标 / 背景材质收敛为两项 / 内置预设壁纸移除——两条壁纸图转 `personal/`（git 忽略，个人自用））

## 活跃坑 / 注意

- `%TEMP%\pytest-of-speak` 的 ACL 若被改坏会报 WinError 5（多为管理员权限进程遗留）：提权删除该目录即恢复（pytest 自动重建），此前"必须 `--basetemp`"的绕法已不必要；CI 固定用 `${{ runner.temp }}`（见 [.github/workflows/ci.yml](.github/workflows/ci.yml)）
- 测试用户数据默认隔离（autouse `isolate_user_data`，见 [tests/conftest.py](tests/conftest.py)）：pytest **不得**读写真实 `output/`、`logs/`（历史坑：`asset_iso` 曾为 opt-in，漏用即往真实资产库写假图）
- [server.py](server.py) LSP 报「Argument missing for parameter id」是误报（GenerationTask.id 有 default_factory），勿修
- `dist/` git 忽略：改前端后 `npm run build` 才在浏览器生效；CI/E2E 须自建（见 [frontend/README.md](frontend/README.md)）
- 改后端（`server.py` / `core`）后行为没变：清 `__pycache__` 再重启服务（`Remove-Item -Recurse -Force __pycache__, core\__pycache__`）——曾出现旧字节码被复用、新接口字段不下发
- E2E 只测画布交互、不触发生成链路；未来覆盖「生成→回流」前必须先 mock [core/api.py](core/api.py) 的 `generate_image`（ci.yml 注释 TODO）
- 迁移脚本/存储格式改动属硬边界——必须维护者确认，不自行决断
- 早于「提交时登记参考图」机制的历史失败记录（本机 8-19 之前）没有参考图记录，历史面板只会显示原因、无法还原；别把它当数据修复手段，也别为此改判定去"凑齐"参考图
- **模型名「全角连字符」陷阱（2026-10-19 实测踩中，已于 2026-10-20 根治）**：上游把 `gpt‑image‑2.5` 登记成 **U+2011 全角连字符**——与键盘能打出的半角 `-` 肉眼完全一样，用户手打必然对不上。`normalize_model_id()` 折叠各类连字符后比对，命中就换回配置里的真实 ID，本意是救这种手误。**曾经的 bug**：它遍历 `all_known_models()`（当前 profile → 其它全部 profile），于是别的 profile 里一条全角历史条目，会把本 profile 下用户打的半角名**静默改写成那条全角 ID** 再发上游；上游回 `unsupported image model`（HTTP 400），而报错里列出的"支持的模型"看起来与输入一模一样，极具误导性。**现已改为只查当前 profile 的 `MODELS`**——模型 ID 是各家上游自己的标识，同名不代表同一个东西，纠正只在"本 profile 自己登记过"时才有依据。排查一行：`python -c "from core import config; print(repr(config.normalize_model_id('gpt-image-2.5')))"`，打印结果里带 U+2011 说明当前 profile 确实登记的是全角名（属正常，不是 bug）。
- **Windows 注册表可把 `.js` 的 MIME 写成 `text/plain`，导致 Web UI 整页白屏**：`StaticFiles` 判 Content-Type 走标准库 `mimetypes`，而 Windows 上它会读 `HKEY_CLASSES_ROOT\.js` 的 `Content Type`。本机实测被写成 `text/plain`，浏览器按 ES module 的严格 MIME 校验拒绝执行构建产物，`#root` 无子节点、控制台报 `Expected a JavaScript-or-Wasm module script`，而服务端日志一切正常。现已在 [server.py](server.py) 里用 `ensure_static_mimetypes()` 把 `.js/.mjs/.css/.json/.svg/.woff2` 显式钉死（无条件执行，未构建前端的环境也受保护），单测 `test_static_assets_use_javascript_mime` 兜底。本机若再遇白屏，先查注册表：`(Get-ItemProperty 'HKLM:\SOFTWARE\Classes\.js').'Content Type'`。
- **配置热加载的两个隐形陷阱（2026-10-20 修）**：① `_load_env_file()` 原先写「键已存在就不覆盖」——首次导入时它已把 `.env` 灌进 `os.environ`，`reload_config()` 再调时每个键都「已存在」→ 一个都不更新，表现就是「界面填了 API Key 却提示要重启」。判据必须是 `name in os.environ and name not in _ENV_FILE_KEYS`（只有用户自己 export 的系统变量才优先），且上一轮来自 `.env`、这一轮被删/注释掉的键要从 `os.environ` 撤掉，否则「清空密钥」等于没清。② 常量快照有两层：`from core.config import XXX` 是**导入时绑定**（热加载改不到），`def f(size=DEFAULT_SIZE)` 的默认值也是**def 时求值一次**。两者都必须改成运行期 `config.xxx` / `None` 哨兵，否则会出现「文件改了、一半生效一半不生效」。
- **中转站地址带 `/v1` 会与路径的 `/v1` 叠成 `/v1/v1`（必然 404，报错看不出原因）**：中转站标准写法是地址带 `/v1`（这样 `/models` 才通），而 OpenAI 兼容的图片端点路径本身也以 `/v1` 开头。`provider_store.dedupe_version_prefix()` 只在版本段**完全相同**时剥掉路径开头那段；`/v2` 地址配 `/v1` 路径属真实不一致，不擅自抹平。界面上的协议文案也踩过：曾写「地址不含版本号」而示例又给 `https://gateway.example/v1`，自相矛盾，用户按示例填必中招。

## 文档地图

| 想了解 | 去读 |
| --- | --- |
| 设计决策 / 数据流 / 契约 / 防错清单 | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| 决策记录（为什么/替代方案） | [.agents/notes/](.agents/notes/) |
| core/ 每文件职责 / 导出 / 依赖 / 改后必测 | [core/README.md](core/README.md) |
| frontend/ 纯函数 / hooks / 组件 / E2E 前置 | [frontend/README.md](frontend/README.md) |
| 测试文件 ↔ 被测代码映射 / 特殊坑 | [tests/README.md](tests/README.md) |
| 迁移脚本用法 / 危险级别 | [scripts/README.md](scripts/README.md) |
| 提示词导入格式规范 | [docs/README.md](docs/README.md) |
| 文档配图放哪 / 截图重拍判据 | [assets/README.md](assets/README.md) |
| 各目录工作约束（规则层，自动注入） | [core/AGENTS.md](core/AGENTS.md) · [frontend/AGENTS.md](frontend/AGENTS.md) · [tests/AGENTS.md](tests/AGENTS.md) · [scripts/AGENTS.md](scripts/AGENTS.md) · [docs/AGENTS.md](docs/AGENTS.md) · [assets/AGENTS.md](assets/AGENTS.md) |

历史轮次记 git log，不堆本文档。
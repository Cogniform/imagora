# scripts/ — 仓库级运维脚本

**危险等级：迁移脚本是破坏性操作，`--apply` 前必须 dry-run + 人工确认（Handoff 硬边界：改迁移逻辑/存储格式必须维护者确认）。**

本目录只放**跨领域运维脚本与本机工具**。Windows 桌面入口与图标链（启动脚本、配色脚本、做图标、编译 exe）在
[desktop/](desktop/README.md)，其文件索引、命令与改后验证都在那份里，本文件不重复。

## 文件索引

### [check_docs.py](check_docs.py)
- 职责：仓库完整性只读校验——相对 markdown 链接可解析 + 仪表盘测试计数与源码一致（后端数 `def test_`、前端数 `it()`，逐处比对 AGENTS / tests/README / ARCHITECTURE / frontend/README 的声明数字）+ 桌面图标产物与品牌源图同步（比 `desktop/icon-source.sha256`）；`desktop/launcher.cs` 里烘焙进 exe 的启动脚本路径确实存在（挪了 .cmd 没同步改就红）
- 危险级别：**低**（只读，不写任何文件）
- 命令：`python scripts/check_docs.py`（`--quiet` 只出问题）；退出码 0=通过 / 1=有断链或计数漂移
- 落点：已接进 CI —— [.github/workflows/ci.yml](../.github/workflows/ci.yml) 前端 job 的第一步（checkout 之后、`npm ci` 之前，不装依赖所以判红快），CI 上写作 `python3`（ubuntu runner），本地仍是 `python`
- 改后必测：`python scripts/check_docs.py` 自检（改文档后跑一次即可，无需单测——脚本本身即校验器）
- 注意它有两处**已知盲区**（2026-09-29 实测，别把"绿"当成"表格全对"）：
  - 前端**逐文件**用例数不校验（表格行只 `pass`），总数按 `frontend/src` 全量 `it()` 数——曾出现四处逐文件数字与源码不符而脚本仍绿
  - 只解析 markdown 链接 `[..](..)`，写在反引号里的路径（如 `` `docs/x.md` ``）照不到
- 背景：计数分散多处人工同步易漏（曾出现 221→222 漏改、frontend 145 过时数字），脚本把「数字与源码一致」从纪律变成可执行检查

### [check_provider.py](check_provider.py)
- 职责：打印「最终发给上游的请求体」——配置解析 + 三层叠加的唯一可观测点；给写配置的人与 agent 自检用
- 危险级别：**低**（只读：不发请求、不花钱、不需要密钥、不写任何文件）
- 命令：`python scripts/check_provider.py [--profile X] [--model Y] [--json]`；退出码 0=配置合法 / 1=有问题（问题逐条打印，并说明被忽略后的实际行为）
- 输出三块：写了什么（`transport.request` / `drop` / `models[].params`）→ 最终请求体 → 标注（`drop:` / `channel:` / `model:` / `passthrough:`）
- 改后必测：`tests/test_core_payload.py`（规则本身）+ 手工跑一次 `--json` 看形状
- 为什么要有：`transport` / `params` 是自由字段，写错**不会报错、只会不生效**；这个脚本是「配置到底有没有读进去」的唯一判据。语义见 [../docs/provider-config.md](../docs/provider-config.md)

### [migrate.py](migrate.py)
- 职责：存储迁移统一入口——注册表升级/重建/回填/迁目录（委托 `registry.migrate(apply, rebuild, backfill)`）、工作流升级（委托 `graphstore.migrate_workflows`）、历史账本回填（委托 `history.backfill_output_asset_ids`）
- 危险级别：**高**（写文件）
- 关键约定：**默认 dry-run 只报告，不写任何文件**；`--apply` 才落地（自带 `.bak-<ts>` 整文件备份 + tmp+os.replace 原子写 + 读回校验）
- 改后必测：`tests/test_core_migrate.py`（19 用例）+ `tests/test_core_history.py`（backfill 相关）
- **硬边界**：改 migrate.py / 任何存储格式逻辑（registry/workflow schema）→ 必须先 Handoff 确认，严禁自行决断

### [desktop/](desktop/README.md)
- 职责：Windows 桌面入口与图标链——`启动生图工作台.cmd`（实际启动脚本）、`window_accent.ps1`（首窗配色）、`launcher.cs` + `make_launcher.ps1`（编译根目录那个 exe）、`make_icon.py`（由品牌源图出 ICO 与指纹）
- 索引 / 命令 / 改后验证 → [desktop/README.md](desktop/README.md)；该目录特有约束 → [desktop/AGENTS.md](desktop/AGENTS.md)

### [capture.py](capture.py)
- 职责：本机 UI 审计截图——playwright 按写死的 12 个固定状态（经典表单 / 画布 / 各模态 / 矮视口）拍图，文件名 `NN-用途.png`；默认输出项目根 `_ui-audit/`（已 git 忽略，本机产物不入库）
- 危险级别：低（开工先清空**输出目录**的旧 png 再重拍；不碰 `assets/screenshots/` 与 `output/`）
- 前置：7860 服务已在跑（见根 [AGENTS.md](../AGENTS.md) 常用命令）；`--out` 可换输出目录，相对路径按项目根解析
- 改后验证：起服务后 `python scripts/capture.py --out %TEMP%\ui-audit` 跑一遍，核对打印的张数与文件名
- 与门面配图不是一回事：[assets/screenshots/](../assets/README.md) 的 3 张是**入库**的展示图，本脚本拍的只在本机给自己比对界面

## 本地常用命令（在项目根目录执行）

```powershell
.\.venv\Scripts\python.exe scripts/migrate.py           # 先看报告（dry-run）
.\.venv\Scripts\python.exe scripts/migrate.py --apply   # 确认后再落地
python scripts/check_docs.py                            # 改文档后校验链接 + 仪表盘计数 + 图标指纹
.\.venv\Scripts\python.exe scripts/capture.py           # 本机 UI 审计图 → _ui-audit/（需 7860 服务在跑）
```

桌面侧命令（重做图标、重编 exe、单验配色）见 [desktop/README.md](desktop/README.md)。

## 该目录特有坑

- **`--apply` 前必须看 dry-run 报告**；脚本自带备份与幂等（重复执行结果不变），但迁移仍属破坏性操作
- 日常无需执行（迁移已完成于 8-20）；`output/.assets` 是唯一真相（.canvas 旧目录已删备份）
- 迁移完成后应跑 `tests/test_core_migrate.py` + 健康检查（起服务看 /api/health/details）

## 变更影响路由（改前必看）

- 改 `migrate.py`
  → 查委托目标：`core/registry.py`（migrate 系）、`core/graphstore.py`（migrate_workflows）、`core/history.py`（backfill）
  → 跑 `tests/test_core_migrate.py` + 相关模块测试
  → **必须 Handoff 确认后再提交**
- 改 `check_docs.py` → 跑一次它自己；新增校验项时同步它的「已知盲区」一节
- 改 `desktop/` 里任何东西 → 看 [desktop/AGENTS.md](desktop/AGENTS.md)（exe 需重编、图标内嵌、`pushd` 层数）
- 改 `capture.py` → 起 7860 服务后跑一次（先 `--out` 指临时目录验证）；它只写输出目录，审计图不进库

## 参考

- 迁移设计：[../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) 5.5
- 被测模块：[../core/README.md](../core/README.md)（registry / graphstore / history 节）
- 维护仪表盘（数字/待办/坑）：[../AGENTS.md](../AGENTS.md)

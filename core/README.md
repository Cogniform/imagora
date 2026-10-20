# core/ — 后端核心模块（无 HTTP 纯逻辑层）

FastAPI 路由（`server.py`）与 CLI（`main.py`）共用的业务层。**不依赖 HTTP / FastAPI**。工作纪律（反向依赖铁律 / 测试 mock / 硬边界）见同目录 [AGENTS.md](AGENTS.md)。

## 本地常用命令

- 全部 core 测试：`.venv\Scripts\python.exe -m pytest tests/test_core_*.py`
- 单文件测试：`.venv\Scripts\python.exe -m pytest tests/test_core_config.py -v`
- Ruff 检查：`.venv\Scripts\python.exe -m ruff check core`

## 该目录特有坑

- `canvas.py` 只是兼容 shim（星号 re-export registry + graphstore），**不在这里加新逻辑**
- pytest 默认临时目录即可；WinError 5 属 `%TEMP%\pytest-of-speak` 的 ACL 被改坏（解法见 [../tests/README.md](../tests/README.md) 坑清单）
- 单测不真调上游：`api.py` 走 monkeypatch mock 保持接口可注入（纪律细则见 [AGENTS.md](AGENTS.md)）
- 展示与导入同源防错条（ARCHITECTURE 9.7）：`resolve_history_asset_path` 在 `server.py`，不在 core

## 文件索引（每个文件：职责 / 关键导出 / 被谁依赖 / 改后必测）

### [config.py](config.py)
- 职责：配置中心——profile 解析（优先级：环境变量 > config.json > 内置）、API Key、尺寸/质量选项、成本表、**配置来源视图**（每个值的来源层，供 `/api/config` 下发给前端呈现，前端不自行推断分层）
- 关键导出：`resolve_profile_config()`、`unknown_profile_keys()`、`get_api_key()`、`get_api_key_source()`、`build_profile_view()`（纯函数）/ `describe_config()`（薄包装）、`build_provider_catalog()` / `provider_catalog()`（**来源目录**：`config.json` 里全部 profile 归一化成 `{name,label,baseUrl,apiPath,defaultModel,sizes,models}`，供前端按地址换价目表、并在切换来源时列出该来源的模型）、`cost_for_size()` + 模块常量（`SIZE_OPTIONS` / `QUALITY_OPTIONS` / `RATIOS` / `WORK_ROOT` / `DEFAULT_OUTPUT_DIR` 等）
- 被谁依赖：`server.py`、`api.py`、`main.py`、`registry.py`、`history.py`、`config_write.py`
- 改后必测：`tests/test_core_config.py` + `tests/test_core_config_override.py`（本机覆盖通道）
- 注意：新增 config.json profile 键必须同步 `unknown_profile_keys` 白名单 + 测试
- 注意：**本机覆盖通道**只开这五个键：`ACTIVE_PROFILE`（全局，不带后缀）与 `BASE_URL_` / `MODEL_` / `API_PATH_` / `API_KEY_<PROFILE 大写>`；未设环境变量时回退路径必须与没有覆盖时逐字相同（有单测锁死）。运行时取常量用 `config.xxx`，不用模块顶层 `from core.config import XXX` 的名字（那是导入时快照）
- 注意：**`ACTIVE_PROFILE` 是其余覆盖键的父级** —— `BASE_URL_<P>` / `MODEL_<P>` 都挂在选中的来源下，所以同一次写请求里既切来源又改字段时，字段键必须按**选中**的来源拼（`MODEL_VOLC`），不能按当前生效的拼，否则切过去后覆盖对不上任何生效的键
- 注意：`config.json` 是**出厂目录**（git 跟踪），界面永不写；本机偏好写 `.env`。见 [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) 4.4

### [config_write.py](config_write.py)
- 职责：配置文件的**行级原地更新**（surgical write-back）—— 只改目标行，用户的注释 / 空行 / 键顺序 / 引号风格逐字保留
- 关键导出：`split_key_value()`（与 `config._load_env_file` 同一套解析规则）、`update_env_text()` / `comment_out_keys()`（纯函数）、`read_env_values()`、`update_env_file()` / `comment_out_env_file()` / `write_text_atomic()`（落盘）
- 被谁依赖：`server.py`（POST /api/config 与 /api/config/secret）。**界面只走 `/api/config` 写 `ACTIVE_PROFILE` 与 `MODEL_<PROFILE>`**；`comment_out_*` 那条路（清空密钥）当前无界面入口，留给脚本 / 手工恢复场景
- 改后必测：`tests/test_core_config_write.py`
- 注意：写盘必须原子（`.bak` → 临时文件 → `fsync` → `os.replace`）——这是密钥文件，截断的 `.env` 会让服务起来后完全无法生图
- 注意：**值为空 = 不修改**；清空密钥用注释掉而非删除（可手工恢复，因此不做「重置」按钮）

### [config_guard.py](config_guard.py)
- 职责：写配置的访问防护（本机绑定 / Origin 白名单 / 进程内令牌）+ 覆盖键命名 + profile 名白名单
- 关键导出：`CONFIG_TOKEN`、`guard_config_write()`、`token_response_header()`、`profile_env_names()`、`safe_profile_path()`
- 被谁依赖：`server.py`（`ConfigGuardMiddleware` + 两个写路由）
- 改后必测：`tests/test_server_config_write.py` + `tests/test_server_config_profile.py`（切来源 / 未注册来源被拒 / 覆盖键跟选中来源）
- 注意：令牌**不落盘**（进程内随机，重启即失效）；`GET /api/config` 不校验令牌，只有写操作校验
- 注意：作用域仅「单人本机」；支持远程访问前必须重新设计安全层（见 [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) 4.3）

### [api.py](api.py)
- 职责：上游生图 API 封装（全项目唯一外部网络调用点）
- 关键导出：`generate_image()`、`format_error()`、`resolve_size_with_ratio()`、`build_default_output_path()`、`write_file_with_retry()`
- 被谁依赖：`server.py`（/api/generate）、`main.py`（gen 子命令）
- 改后必测：`tests/test_core_api.py` + `tests/test_main_cli.py`
- 注意：单测已 mock 上游，不花钱；改接口签名要同步 `server.py` 与 `main.py` 两处调用；落盘统一走 `write_file_with_retry`（Windows 杀软/云同步瞬时锁，只重试 PermissionError，见 [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) 9.6）

### [tasks.py](tasks.py)
- 职责：生成任务状态机（纯内存 TaskManager：queued → running → done/failed/cancelled，终态 TTL 清理）
- 关键导出：`TaskManager`（`submit` / `snapshot` / `cancel`）、`GenerationTask`、`MAX_CONCURRENCY`
- 被谁依赖：`server.py`（/api/generate、/api/tasks/*）
- 改后必测：`tests/test_core_tasks.py` + `tests/test_server_tasks.py`
- 注意：任务表纯内存；uvicorn 必须单 worker（见 ARCHITECTURE 9.6）

### [registry.py](registry.py)
- 职责：资产注册表（`output/.assets`，v2 包装，内容 sha1 去重，kind=canvas/result/ref，永不自动清理）
- 关键导出：`register_asset()`、`resolve_asset()`（可选预载 entries：批量解析一次读盘）、`delete_asset()`、`list_assets()`、`import_assets()`、`image_url()`、`safe_ref_path_allowlist()`、`migrate(apply, rebuild, backfill)`（迁移入口）
- 被谁依赖：`graphstore.py`、`server.py`（/api/canvas/*、/api/history）、`main.py`（CLI 旁路）、`scripts/migrate.py`、`core/canvas.py`（shim）
- 改后必测：`tests/test_core_canvas.py` + `tests/test_core_migrate.py` + `tests/test_server_helpers.py`（history 注册表解析）
- 注意：**改存储格式（schema/目录/字段语义）必须先 Handoff 确认**（硬边界）

### [graphstore.py](graphstore.py)
- 职责：图/工作流存储——workflow（手动工作流）/ submission（提交快照）/ recovery（恢复快照），原子写
- 关键导出：`workflow_save()` / `workflow_list()` / `workflow_load()`、`submission_save()` / `submission_load()`、`recovery_save()` / `recovery_latest()`、`persist_submission_assets()`（server/CLI 共用资产旁路）、`register_input_assets()`（提交阶段注册参考图进 .assets，防排队期间源文件被删漏记）、`migrate_workflows()`、`next_submission_id()`、`sanitize_workflow_name()`
- 被谁依赖：`server.py`（/api/canvas/workflow/*、/api/canvas/import-submission、recovery、/api/generate 提交时注册）、`main.py`（CLI 旁路）、`scripts/migrate.py`、shim
- 改后必测：`tests/test_core_canvas.py` + `tests/test_server_canvas.py` + `tests/test_main_cli.py` + `tests/test_server_tasks.py`（提交时注册回归）
- 注意：`persist_submission_assets` 两端共用，改前查 server 与 main 两处调用；`input_asset_ids` 非空时按 id 解析参考图、不重复注册，为空时按 ref_paths 现场注册兜底；**改存储格式必须先 Handoff 确认**

### [history.py](history.py)
- 职责：生成历史 JSONL 读取（容错坏行、筛选、**同参数聚合**）+ 账本迁移（backfill）
- 关键导出：`read_generation_history()` / `read_generation_history_paged()`（分页 {items,total}，offset 为聚合后偏移，供滚动加载）、`read_raw_history()`（**原始行**口径：不去重、不截断 500 行，供成本统计/计费）、`dedupe_generation_history()`（同参数只留最新一条，时间不算参数，失败不刷屏）、`resolve_output_path()`、`backfill_output_asset_ids()`
- 被谁依赖：`server.py`（/api/history、/api/history/import，白名单同源判定——注册表副本 + 账本 output 原路径双收，见 ARCHITECTURE 9.7；/api/history/stats 走 `read_raw_history`）、`core/cost.py`（统计读原始行）
- 改后必测：`tests/test_core_history.py` + `tests/test_server_helpers.py`
- 注意：展示与导入同源（ARCHITECTURE 9.7）——改路径解析逻辑必须两端一致；**搜索对换行鲁棒**：query 与账本字段两侧都做空白折叠（账本 prompt 存 CRLF，用户粘进单行搜索框换行被浏览器归一/移除，折叠后才不整串错位）；**列表口径 vs 计费口径**：展示用聚合+500 行上限，统计/预算必须用 `read_raw_history`（聚合会少算费用）

### [cost.py](cost.py)
- 职责：成本统计与预算保护——账本原始行聚合（总量/成功率/费用/耗时/按天/按尺寸/按模式）+ 本机预算设置读写 + 超预算判定
- 关键导出：`summarize_records()`、`today_spent()`、`estimate_cost()`、`load_budget()` / `save_budget()`（`output/.budget.json`，原子写，git 忽略）、`normalize_budget()`、`check_budget()`（超限需 `confirmed=True` 才放行）
- 被谁依赖：`server.py`（/api/history/stats、/api/budget、/api/budget/check，以及 /api/generate 与 /api/generate/batch 的预算闸门）
- 改后必测：`tests/test_core_cost.py` + `tests/test_server_cost.py`
- 注意：费用唯一来源是 `core.config.cost_for_size`（config.json 的 size_options），此处不硬编码价格；预算语义是"超限需确认"而非硬拦（0 = 不限，默认不打扰）

### [logging.py](logging.py)
- 职责：`logs/generation.jsonl` 账本写入（线程安全、路径相对化）
- 关键导出：`log_generation()`
- 被谁依赖：`server.py`、`main.py`（gen/batch）
- 改后必测：`tests/test_core_logging.py`

### [console.py](console.py)
- 职责：终端输出（rich）——CLI 菜单/提示
- 关键导出：`console`、`print_success()`、`print_error()`、`print_info()`、`print_warn()`、`print_panel()`
- 被谁依赖：`main.py`
- 改后必测：无专项测试（纯展示，人工验证）

### [imageinfo.py](imageinfo.py)
- 职责：图片头解析（PNG/JPEG/GIF/WebP/BMP 宽高/格式）
- 关键导出：`image_dimensions()`
- 被谁依赖：`registry.py`（登记时探测元数据）
- 改后必测：`tests/test_core_imageinfo.py`

### [pathtrust.py](pathtrust.py)
- 职责：路径白名单校验（`match_roots`，双根/跨盘安全）
- 关键导出：`match_roots()`
- 被谁依赖：`server.py`（safe_ref_path_allowlist 委托）、`registry.py`
- 改后必测：`tests/test_core_pathtrust.py`

### [batch.py](batch.py)
- 职责：CLI 批量编排（config 读取、模块过滤、dry-run 预览、串行生成）
- 关键导出：`load_batch_config()`、`resolve_base_image_paths()`、`filter_jobs_by_module()`、`run_batch_generation()`
- 被谁依赖：`main.py`（batch 子命令）
- 改后必测：`tests/test_core_batch.py`

### [canvas.py](canvas.py)
- 职责：**兼容 shim**——星号 re-export `registry` + `graphstore`（旧导入 `from core import canvas` 兼容）
- 被谁依赖：`server.py`（`from core import canvas`）
- 警告：不加新逻辑；新增公开函数应落在 registry/graphstore 本体

## 上下游依赖

### 本目录用到了谁
- 标准库：`pathlib` / `json` / `hashlib` / `threading` / `tempfile` / `time`
- 第三方：`requests`（api.py）、`rich`（console.py）
- 无 `server.py` / `main.py` 反向依赖（约束见 [AGENTS.md](AGENTS.md)，grep 已验证）

### 谁用到了本目录
- `server.py`：canvas / config / cost / graphstore / history / api / logging / tasks
- `main.py`：api / config / batch / console / logging / graphstore
- `scripts/migrate.py`：registry / graphstore / history
- `tests/`：全部测试文件（见 tests/README.md）

## 变更影响路由（改前必看）

- 改 `registry.py`
  → 查 `graphstore.py`（persist_submission_assets）与 `scripts/migrate.py` 调用方式
  → 跑 `tests/test_core_canvas.py` + `tests/test_core_migrate.py` + `tests/test_server_helpers.py`
  → 如改存储格式/schema → **必须 Handoff 确认**

- 改 `graphstore.py`
  → 查 `server.py` 路由与 `main.py` CLI 旁路
  → 跑 `tests/test_core_canvas.py` + `tests/test_server_canvas.py` + `tests/test_main_cli.py`
  → `persist_submission_assets` 改后端到两端均验证

- 改 `api.py`
  → 查 `tasks.py` / `server.py` / `main.py` gen 子命令
  → 跑 `tests/test_core_api.py` + `tests/test_main_cli.py`（已 mock 上游，不花钱）

- 改 `config.py`
  → 新增 profile 键必须同步 `unknown_profile_keys` 白名单
  → 跑 `tests/test_core_config.py`

- 改 `history.py`
  → 查 `server.py` /api/history 两路由
  → 跑 `tests/test_core_history.py` + `tests/test_server_helpers.py`
  → 验证展示与导入同源（ARCHITECTURE 9.7）

- 改 `tasks.py`
  → 查 `server.py` 任务路由
  → 跑 `tests/test_core_tasks.py` + `tests/test_server_tasks.py`

- 改 `logging.py` / `console.py` / `imageinfo.py` / `pathtrust.py` / `batch.py`
  → 跑对应单测（见文件索引「改后必测」）；console 无测试改后人工目验

## 参考

- 设计背景（注册表/旁路/防错）：[../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) 2.2 / 5.5 / 6.1 / 7.1 / 9.7
- 测试命令细节：[../tests/README.md](../tests/README.md)
- 维护仪表盘（数字/待办/坑）：[../AGENTS.md](../AGENTS.md)
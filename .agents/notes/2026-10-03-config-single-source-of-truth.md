# 决策：配置归一 —— 文件是唯一真相源，界面是它的一个编辑入口（2026-10-03）

状态：被取代
指针：[配置弹窗是「选择器」，不是「编辑器」](2026-10-08-config-dialog-is-a-selector-not-an-editor.md)
（被取代的是「界面作为编辑入口」的范围；**单一真相源与两层归属本身仍生效**）

## 问题

前端曾同时存在两套配置：

- 后端：`.env` / `config.json`，服务端读
- 前端：浏览器 `localStorage`（「个人配置」+「我的接口」预设），提交时由 `submitGenerate()` 内部读取并拼进表单

两者并存导致三个真实缺陷：

- **保存按钮永久禁用**：`disabled={!form.baseUrl.trim() || !form.apiKey.trim()}` 要求表单里有 Key。
  而走服务端配置时，前端**拿不到也不该拿到** Key（`core/config.py` 铁律：密钥只报「是否配置 + 来源」，绝不回传值），
  于是该分支永远判为不可保存——改地址、改模型都按不动。
- **配置依赖不可见**：`submitGenerate` 属应用层却直接调基础设施层的 `readPersonalApiSettings()`，
  `CanvasPage` 里 grep 不到任何配置引用，但配置确实在生效。
- **解析散落**：`personalApi?.x ?? config?.x ?? ""` 之类的写法重复出现在五处，随时会漂。

## 决策

配置数据**只有一份**，在文件里。界面不持有配置，只是这份数据的一个编辑入口，与文本编辑器等价。

归属划分：

- `config.json` = **出厂目录**（git 跟踪）：地址 / 模型 / 尺寸价目表 / 能力清单。界面**只读**，永不写。
- `.env` = **本机覆盖 + 密钥**（git 忽略）。界面**只写这里**。

可编辑字段的写入目标：

| 字段 | 写入 | 键 |
|---|---|---|
| 接口地址 | `.env` | `BASE_URL_<PROFILE 大写>` |
| 默认模型 | `.env` | `MODEL_<PROFILE 大写>` |
| 接口路径 | `.env` | `API_PATH_<PROFILE 大写>`（同时用于 generations 与 edits） |
| API Key | `.env` | `API_KEY_<PROFILE 大写>` |

只开这四个键。`ratios` / `size_options` / `models` 是价目表与能力清单，属出厂目录，不开放环境变量覆盖。

配套机制：

- **行级原地更新**（`core/config_write.py`）：只改目标行，用户的注释 / 空行 / 键顺序 / 引号风格逐字保留。
- **原子写**：`.bak` → 临时文件 → `fsync` → `os.replace`。这是密钥文件，截断的 `.env` 会让服务完全无法生图。
- **密钥 write-only**：永不回显值；留空 = 不修改；清空走独立接口且是**注释掉那一行**（可手工恢复）。
- **三层防护**（`core/config_guard.py`）：本机绑定 → Origin 白名单 → 进程内随机令牌。令牌经 `GET /api/config` 响应头下发，存内存不落盘。
- **mtime 冲突检测**：写请求带 `expectedMtimes`，不符则 409，绝不静默覆盖。
- **待重启语义**：全部字段都是 import 时求值，没有可热加载的部分，写入后 `fileState.pending` 标记「文件值 ≠ 生效值」。

同时删除：`submitGenerate` 的 localStorage 偷读、`PersonalApiModal`、四个 localStorage 读写函数、
`PersonalApiSettings` / `PersonalApiPreset` 类型、`providerSwitch.ts`、`/api/generate` 的
`api_key` / `api_base_url` / `api_model` / `api_path` 参数。

## 替代方案

- **保留两套、只修保存按钮判定**：治好一个症状，但依赖方向仍是反的（应用层偷读基础设施），
  且「浏览器一份、文件一份」的双真相源还在。否决。
- **界面直接写 `config.json`**：`config.json` 是公开仓库里的出厂数据。界面写它会让每次改本机偏好都污染 git 状态，
  更严重的是冲突解决时一句 `git checkout config.json` 会**静默丢掉用户的选择**，要等到生成报错才发现。否决。
- **只让界面写 `.env` 的 Key（其余仍手改）**：覆盖不了实际需求（地址与模型才是最常改的）。
  且 `_get()` 当时只读 profile，`.env` 根本没有通道——需要先补覆盖通道。否决。
- **做热加载 `reload_config()`**：`BASE_URL` / `DEFAULT_MODEL` / `ACTIVE_PROFILE` 等是模块级常量，
  全量热加载要动十几处调用点，且 `_load_env_file` 只写不删（`os.environ` 里的旧值会盖住新值），有回归风险。
  先做「提示重启 + 待重启项可见」，等真嫌重启麻烦再单独评估。否决（暂缓）。
- **把界面做成配置管理器（支持增删 profile、编辑价目表）**：那是配置生成器，不是编辑器。
  一个人用、一个月碰不到两次、手改一行比点两下更快的字段，不做 UI。否决。

## 影响

收益：

- 三个缺陷一起消失（保存按钮、依赖不可见、解析散落）。
- 多窗口一致：不再有 per-browser 的配置副本。
- 换机行为明确：`.env` 是 git 忽略的本机文件，配置跟着文件走，不跟着浏览器走。
- 密钥路径收敛到一条，且不落 `localStorage` / 不进 multipart 表单。

代价：

- 改配置需要重启才生效（`fileState.pending` 明确提示哪几项）。
- 弹窗面板纳入通透度后会掉到 0.46（实测，原先是写死 `.97`），故补 `MODAL_ALPHA_FLOOR = 0.86`
  ——弹窗是密集表单的阅读面，不该与卡片同比透明。
- 若用户曾把覆盖键 export 到**系统环境变量**，删掉 `.env` 那一行不会让它消失（系统变量优先级更高）。
  来源标注会如实显示 `环境变量 XXX`，但这是需要知道的边界（不做 UI 提示，单人场景极罕见）。
- 安全层只为本机设计；支持远程访问前必须重新设计（TLS + 真实认证 + 速率限制）。

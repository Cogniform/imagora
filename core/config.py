#!/usr/bin/env python3
"""配置中心 —— 统一管理 API Key、接口地址、尺寸映射与默认参数

配置分层（优先级从高到低）:
  1. 环境变量（含 .env 自动加载，已存在的环境变量不被覆盖）
  2. config.json 的 profiles[ACTIVE_PROFILE]（用户可编辑，换中转站/模型/尺寸改这里）
  3. config.json 的 default_profile（未显式指定时的公共默认，git 跟踪）
  4. 内置默认值（config.json 缺失 / profile 缺失 / 字段缺失时 fallback）

API Key 读取优先级（跟随 ACTIVE_PROFILE 自动切换中转站）:
  1. API_KEY_<PROFILE 大写>（如 API_KEY_WANWU）—— 每套中转站配自己的 key
  2. API_KEY（通用回退）
  3. AIWANWU_API_KEY（旧写法兼容，老用户零改动）

铁律：密钥只允许出现在 .env / 环境变量；config.json 是公开配置（git 跟踪），绝不放密钥。
"""

import json
import os
import sys
import warnings
from pathlib import Path

from core import provider_store

# ---------- 工作根（启动时固定一次，后续路径统一以此为基准） ----------
WORK_ROOT = Path.cwd()

# 应用根目录：config.json / .env / providers.local.json 三者同级。
# 打包成 exe 后 cwd 可能是任意目录，此时以可执行文件所在目录为准。
_APP_ROOT = Path(os.environ.get("IMAGORA_APP_ROOT", Path.cwd()))
if getattr(sys, "frozen", False):
    _APP_ROOT = Path(sys.executable).resolve().parent

# ---------- 内置默认值（兜底，profile 未覆盖的字段回退到这里） ----------
_DEFAULTS = {
    "base_url": "https://2api.aiwanwu.cc",
    "api_paths": {
        "generations": "/v1/images/generations",
        "edits": "/v1/images/edits",
    },
    "ratios": {
        "1:1": {"1K": "1024x1024", "2K": "2048x2048"},
        "3:2": {"2K": "1536x1024"},
        "2:3": {"2K": "1024x1536"},
        "16:9": {"2K": "2048x1152", "4K": "3840x2160"},
        "9:16": {"2K": "1152x2048", "4K": "2160x3840"},
        "7:4": {"2K": "1792x1024"},
        "4:7": {"2K": "1024x1792"},
    },
    "size_options": [
        {"value": "1024x1024", "label": "1024x1024 (1:1 1K)", "cost": 0.05},
        {"value": "1024x1536", "label": "1024x1536 (2:3 竖版)", "cost": 0.10},
        {"value": "1536x1024", "label": "1536x1024 (3:2 横版)", "cost": 0.10},
        {"value": "1152x2048", "label": "1152x2048 (9:16 竖版长图)", "cost": 0.10},
        {"value": "2048x1152", "label": "2048x1152 (16:9 横版)", "cost": 0.10},
        {"value": "1024x1792", "label": "1024x1792 (竖版长图)", "cost": 0.10},
        {"value": "1792x1024", "label": "1792x1024 (横版长图)", "cost": 0.10},
    ],
    "quality_options": ["low", "medium", "high"],
    "default_model": "gpt‑image‑2",
    "default_quality": "high",
    "default_size": "1024x1024",
    "default_tier": "2K",
    # 多模型清单：每个模型自带 ratios / size_options / output_formats。
    # 空列表表示不启用多模型（回退 profile 级的 ratios / size_options 单模型模式）。
    "models": [],
    # 供应商展示名（如「火山方舟官方」/「aiwanwu 中转站」）
    "label": "",
}

# profile 允许的键（白名单：未知键打警告，防 typo 静默失效）
_PROFILE_KEYS = frozenset(_DEFAULTS.keys())

# ---------- config.json 加载 ----------
_CONFIG_FILE = WORK_ROOT / "config.json"


def _load_config_file() -> dict:
    """读取 config.json；文件不存在或格式错误返回空 dict"""
    if not _CONFIG_FILE.exists():
        return {}
    try:
        data = json.loads(_CONFIG_FILE.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return data
        warnings.warn(
            f"config.json 格式错误（期望 object，实际 {type(data).__name__}），使用默认值"
        )
    except (json.JSONDecodeError, OSError) as e:
        warnings.warn(f"config.json 读取失败：{e}，使用默认值")
    return {}


_cfg = _load_config_file()

# ---------- 本机自定义来源（providers.local.json）合并进出厂 profiles ----------
# 「添加第三方供应商」写不进 config.json（git 跟踪，界面永不写），也塞不进 .env
# （覆盖通道只有 4 个扁平键，且都挂在已注册 profile 下，造不出新 profile）。
# 因此本机新增的来源单独存 providers.local.json（git 忽略），在这里合并。
#
# 合并后 _cfg["profiles"] 就是**完整目录**：resolve_profile_config /
# provider_catalog / describe_config / registeredProfiles 全部零改动自动认新来源。
LOCAL_PROVIDERS_FILE = _APP_ROOT / provider_store.LOCAL_FILE_NAME


def _merge_local_providers(cfg: dict) -> dict:
    """把本机来源并进 cfg（返回新的 cfg，不改入参）。"""
    if not isinstance(cfg, dict):
        return cfg
    local = provider_store.load_local_providers(LOCAL_PROVIDERS_FILE)
    if not local["profiles"]:
        return cfg
    merged = dict(cfg)
    merged["profiles"] = provider_store.merge_profiles(
        cfg.get("profiles") or {}, local["profiles"]
    )
    return merged


_cfg = _merge_local_providers(_cfg)


def reload_config() -> None:
    """重新读盘并刷新全部模块级常量（新建来源后调用，免重启）。

    为什么要「免重启」：配置写入的既有语义是「一律标记待重启」（全是 import 时
    求值的模块级常量，没有可热加载的部分，见 docs/ARCHITECTURE.md 4.4）。但新增
    一个**来源**不同 —— 它不改变当前生效的 profile 与模型，只是让目录里多一条。
    不刷新的话用户刚加的来源在界面上看不见，得关掉重开才出现，体验断层。

    实现上就是把「导入时做过的那串求值」重跑一遍。顺序不能乱：
    profile 解析 → 环境覆盖 → 各常量。
    """
    global _cfg, ACTIVE_PROFILE, _profile
    global BASE_URL, API_PATHS, PROFILE_LABEL
    global MODELS, RATIOS, SIZE_OPTIONS, QUALITY_OPTIONS
    global DEFAULT_MODEL, DEFAULT_QUALITY, DEFAULT_SIZE, DEFAULT_TIER

    _cfg = _merge_local_providers(_load_config_file())
    _load_env_file()
    ACTIVE_PROFILE, _profile = resolve_profile_config(
        _cfg, os.environ.get("ACTIVE_PROFILE")
    )
    BASE_URL = _get("base_url")
    API_PATHS = _get("api_paths")
    PROFILE_LABEL = _get("label") if isinstance(_get("label"), str) else ""
    MODELS = normalize_models(_get("models"))
    RATIOS = _get("ratios")
    SIZE_OPTIONS = _get("size_options")
    QUALITY_OPTIONS = _get("quality_options")
    DEFAULT_MODEL = _get("default_model")
    DEFAULT_QUALITY = _get("default_quality")
    DEFAULT_SIZE = _get("default_size")
    DEFAULT_TIER = _get("default_tier")


def resolve_profile_config(
    cfg: dict, env_active: str | None
) -> tuple[str | None, dict]:
    """纯函数：解析当前生效的 profile。

    返回 (profile 名, profile 配置 dict)：
    - env_active（.env 的 ACTIVE_PROFILE 或环境变量）优先；
    - 否则取 cfg["default_profile"]（git 跟踪的公共默认）；
    - profile 不存在 / 结构错误 → 警告并返回 (名, {})，由调用方回退内置默认。
    """
    name = (env_active or "").strip() or (cfg.get("default_profile") or "")
    if not name:
        return None, {}
    profiles = cfg.get("profiles")
    if not isinstance(profiles, dict):
        warnings.warn("config.json 缺少 profiles 对象，使用内置默认值")
        return name, {}
    profile = profiles.get(name)
    if not isinstance(profile, dict):
        warnings.warn(f"config.json 中找不到 profile「{name}」，使用内置默认值")
        return name, {}
    return name, profile


def unknown_profile_keys(profile: dict) -> list[str]:
    """纯函数：返回 profile 中不在白名单内的键（防 typo 静默失效）"""
    return [k for k in profile if k not in _PROFILE_KEYS]


# ---------- .env 加载（密钥与本地覆盖；不覆盖已存在的环境变量） ----------
# _APP_ROOT 在文件顶部定义（providers.local.json 的合并也要用它，故提前）。
ENV_FILE_PATH = _APP_ROOT / ".env"


# 记录「值确实来自 .env 文件」的键：.env 加载后与系统环境变量同处 os.environ 无法区分，
# 要向前端报准来源（.env 还是系统环境变量）就得在装载时留痕（不影响任何取值优先级）。
_ENV_FILE_KEYS: set[str] = set()


def _load_env_file():
    """读取 .env（KEY=VALUE，# 注释），真正来自系统环境变量的键不覆盖。

    「已存在」必须区分来源，否则热加载永远不生效：首次导入时本函数已经把 .env
    的值灌进了 os.environ，reload_config() 再调本函数时每个键都「已存在」→ 一个
    都不更新，界面刚写进 .env 的地址/模型/密钥永远读不到（表现就是「填了 API Key
    却提示要重启」）。所以判据是 `name in os.environ and name not in _ENV_FILE_KEYS`
    —— 只有用户自己 export 的系统环境变量才享有优先权。

    反过来也要处理：上一轮来自 .env、这一轮文件里被删掉或被注释掉的键，必须从
    os.environ 撤掉。否则「清空密钥」（config_write 是注释掉而不是删除）之后热加载
    仍能读到旧值，等于没清。
    """
    previous = set(_ENV_FILE_KEYS)
    _ENV_FILE_KEYS.clear()
    seen: set[str] = set()
    if ENV_FILE_PATH.exists():
        for line in ENV_FILE_PATH.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            name = key.strip()
            if not name:
                continue
            # 用户自己 export 的变量优先，不被 .env 覆盖
            if name in os.environ and name not in previous:
                continue
            os.environ[name] = value.strip().strip('"').strip("'")
            _ENV_FILE_KEYS.add(name)
            seen.add(name)
    for name in previous - seen:
        os.environ.pop(name, None)


_load_env_file()
ACTIVE_PROFILE, _profile = resolve_profile_config(
    _cfg, os.environ.get("ACTIVE_PROFILE")
)
for _k in unknown_profile_keys(_profile):
    _available = ", ".join(sorted(_PROFILE_KEYS))
    warnings.warn(
        f"profile「{ACTIVE_PROFILE}」包含未知配置键「{_k}」，已忽略"
        f"（可用键：{_available}）"
    )


# ---------- 本机覆盖（.env）：可被界面写入的三个字段 ----------
# 沿用既有的 API_KEY_<PROFILE> 命名约定（见 .env.example）：
#   config.json = 出厂目录（git 跟踪，界面永不写）
#   .env        = 本机覆盖 + 密钥（git 忽略，界面只写这里）
#
# 为什么只有这三个：它们是「我这台机器用哪家接口/哪个模型」的本机偏好；
# ratios / size_options / quality_options / models 是目录数据（价目表与能力清单），
# 开放环境变量覆盖会把 _get 变成解析器，收益为零。
# 未设置环境变量时 _env_override_value 一律返回 None，_get 的回退路径与改动前逐字相同。
_ENV_OVERRIDE_KEYS = {
    "base_url": "BASE_URL",
    "default_model": "MODEL",
    "api_paths": "API_PATH",
}


def env_override_name(key: str) -> str | None:
    """当前 profile 下该键对应的环境变量名（不读取值）。"""
    prefix = _ENV_OVERRIDE_KEYS.get(key)
    if not prefix or not ACTIVE_PROFILE:
        return None
    return f"{prefix}_{ACTIVE_PROFILE.upper()}"


def _env_override_value(key: str) -> str | None:
    """本机 .env 覆盖的**实际值**；未设置（缺失或空白）返回 None。

    空白值视为未设置：宁可回落到出厂值，也不要"配了个空地址"。
    """
    name = env_override_name(key)
    if not name:
        return None
    return (os.environ.get(name) or "").strip() or None


def _get(key: str):
    """取当前 profile 的配置项：.env 本机覆盖 > profile > 内置默认。

    环境变量未设置时，下面两行回退路径与改动前完全一致。
    """
    override = _env_override_value(key)
    if override is None:
        return _profile.get(key, _DEFAULTS[key])
    if key == "api_paths":
        # 单路径覆盖同时用于 generations 与 edits（界面只暴露"接口路径"一项）
        return {"generations": override, "edits": override}
    return override


def source_of_value(key: str) -> str:
    """某个键当前生效值的来源标签（供 /api/config 的 profileView 使用）。"""
    if _env_override_value(key) is not None:
        name = env_override_name(key)
        assert name is not None
        return f".env {name}" if name in _ENV_FILE_KEYS else f"环境变量 {name}"
    return _SRC_PROFILE if key in _profile else _SRC_FALLBACK


# ---------- 接口 ----------
BASE_URL = _get("base_url")
API_PATHS = _get("api_paths")

# ---------- 默认输出目录（未指定时生成到 工作根/output；工作根与 profile 无关，不进配置） ----------
DEFAULT_OUTPUT_DIR = str(WORK_ROOT / "output")

# ---------- API Key（跟随 ACTIVE_PROFILE 自动切换中转站） ----------
ENV_KEY_NAME = "AIWANWU_API_KEY"


def get_api_key():
    """返回当前 profile 对应的 API Key；未配置时给出明确指引。

    优先级：API_KEY_<PROFILE 大写> > API_KEY > AIWANWU_API_KEY（旧写法兼容）。
    """
    _load_env_file()
    candidates = []
    if ACTIVE_PROFILE:
        candidates.append(f"API_KEY_{ACTIVE_PROFILE.upper()}")
    candidates += ["API_KEY", "AIWANWU_API_KEY"]
    for name in candidates:
        key = os.environ.get(name)
        if key:
            return key
    raise RuntimeError(
        "未设置 API Key。请配置（任选其一）：\n"
        + "\n".join(f"  {name}=sk-..." for name in candidates)
        + f"\n写入 {ENV_FILE_PATH} 或设置环境变量"
    )


# ---------- 多模型清单（可选） ----------
# 每个模型自带 ratios / size_options / output_formats；为空则回退 profile 级单模型模式。
# 归一化：给每个模型补 label（缺省用 id）、output_formats（缺省 ["png","jpeg"]）。
PROFILE_LABEL = _get("label") if isinstance(_get("label"), str) else ""


def normalize_models(raw) -> list[dict]:
    """纯函数：把 profile.models 归一化成统一结构（缺字段补默认值）。

    - label 缺省用 id
    - output_formats 缺省 ["png","jpeg"]
    - size_options / ratios 缺省用空（调用方回退 profile 级）
    """
    if not isinstance(raw, list):
        return []
    out = []
    for item in raw:
        if not isinstance(item, dict) or not item.get("id"):
            continue
        model_id = str(item["id"])
        out.append(
            {
                "id": model_id,
                "label": str(item.get("label") or model_id),
                "note": str(item.get("note") or ""),
                "output_formats": list(item.get("output_formats") or ["png", "jpeg"]),
                "size_options": list(item.get("size_options") or []),
                "ratios": dict(item.get("ratios") or {}),
            }
        )
    return out


MODELS = normalize_models(_get("models"))


# 各种「看起来像减号」的字符：中转站在同一条产品线上混用了半角与全角连字符，
# 肉眼完全分辨不出。比对模型 ID 前统一折叠，避免把用户挡在 model_not_found 外面。
_DASH_CODEPOINTS = frozenset(
    [0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212, 0xFE58, 0xFE63, 0xFF0D]
)


def fold_model_id(model_id: str | None) -> str:
    """把模型 ID 里各类连字符折叠成半角 `-`，仅用于**比对**，不改变语义。

    例：`gpt‑image‑2.5`（U+2011）与 `gpt-image-2.5`（U+002D）折叠后相同。
    """
    if not model_id:
        return ""
    return "".join("-" if ord(ch) in _DASH_CODEPOINTS else ch for ch in model_id)


def normalize_model_id(model_id: str | None) -> str | None:
    """把用户给的模型 ID 纠正为**当前 profile** 里的真实 ID，无法匹配则原样返回。

    背景：中转站的 `gpt‑image‑2.5` 用的是全角连字符 U+2011，与键盘能打出的
    半角 `gpt-image-2.5` 在界面上毫无区别。用户手打、或沿用历史记录时必然
    拿到半角版本，请求会被上游直接判为 model_not_found（404）。
    这里做一次折叠比对，命中已知模型就换回配置里的正确 ID。

    只查当前 profile 的 `MODELS`，**不跨 profile**：模型 ID 是各家上游自己的
    标识，同名不代表同一个东西。早先这里遍历 all_known_models()（含其它全部
    profile），于是别的 profile 里一条用全角连字符登记的历史条目，会把本
    profile 下用户打的半角名静默改写成那条全角 ID 再发给上游——上游只回
    `unsupported image model`，而报错里列出的"支持的模型"看起来与用户输入的
    一模一样，极难排查。纠正只在"本 profile 自己登记过"时才有依据。
    """
    if not model_id:
        return model_id
    folded = fold_model_id(model_id)
    for known in MODELS:
        if fold_model_id(known["id"]) == folded:
            return known["id"]
    return model_id


def get_model(model_id: str | None) -> dict | None:
    """按 id 取模型配置；找不到返回 None（调用方回退 profile 级默认）

    比对时会折叠连字符（见 fold_model_id）：模型 ID 里混用了半角 `-` 与
    全角 `‑`，肉眼完全一样，不做折叠会漏掉本该命中的模型。
    """
    if not model_id:
        return None
    folded = fold_model_id(model_id)
    for m in MODELS:
        if fold_model_id(m["id"]) == folded:
            return m
    return None


def find_model_anywhere(model_id: str | None) -> dict | None:
    """在 **全部 profile** 里查找模型，返回 {"profile": 名, "model": 模型定义}。

    与 get_model() 的区别：后者只看当前 ACTIVE_PROFILE。
    典型用途是「我的接口」的连通性测试 —— 用户可能在 wanwu profile 下
    去测试一条豆包配置，此时必须跨 profile 才能查到它的尺寸档位。

    优先返回当前 profile 的命中（同名模型在不同 profile 下配置可能不同）。
    连字符同样折叠后再比对。
    """
    if not model_id:
        return None
    folded = fold_model_id(model_id)
    # 当前 profile 优先
    for m in MODELS:
        if fold_model_id(m["id"]) == folded:
            return {"profile": ACTIVE_PROFILE, "model": m}
    for name, prof in (_cfg.get("profiles") or {}).items():
        if name == ACTIVE_PROFILE or not isinstance(prof, dict):
            continue
        for m in normalize_models(prof.get("models")):
            if fold_model_id(m["id"]) == folded:
                return {"profile": name, "model": m}
    return None


def all_known_models() -> list[str]:
    """全部 profile 里出现过的模型 id（去重、保持顺序）——用于「找不到模型」时的提示。"""
    seen: list[str] = []
    for m in MODELS:
        if m["id"] and m["id"] not in seen:
            seen.append(m["id"])
    for prof in (_cfg.get("profiles") or {}).values():
        if not isinstance(prof, dict):
            continue
        for m in normalize_models(prof.get("models")):
            if m["id"] and m["id"] not in seen:
                seen.append(m["id"])
    return seen


def _model_anywhere(model_id: str | None) -> dict | None:
    """跨 profile 取模型定义（找不到返回 None）。

    这些查询一律走 find_model_anywhere 而不是 get_model：
    「我的接口」可以在任意 profile 下测试/切换另一家的配置，
    只看当前 profile 会查不到模型、静默回退到**当前** profile 的
    尺寸与价格，把另一家的单价算错（曾把中转站的 0.05 显示成豆包的 0.2）。
    """
    found = find_model_anywhere(model_id)
    return found["model"] if found else None


def model_sizes(model_id: str | None) -> list[dict]:
    """该模型的尺寸选项；模型无自带尺寸时回退 profile 级 size_options。"""
    m = _model_anywhere(model_id)
    if m and m["size_options"]:
        return m["size_options"]
    return SIZE_OPTIONS


def model_ratios(model_id: str | None) -> dict:
    """该模型的 ratios；模型无自带时回退 profile 级 RATIOS。"""
    m = _model_anywhere(model_id)
    if m and m["ratios"]:
        return m["ratios"]
    return RATIOS


def model_output_formats(model_id: str | None) -> list[str]:
    """该模型支持的输出格式；未知模型回退 ["png","jpeg"]。"""
    m = _model_anywhere(model_id)
    return m["output_formats"] if m else ["png", "jpeg"]


def model_label(model_id: str | None) -> str:
    """模型展示名（下拉框用）；未知返回 id 本身。"""
    m = _model_anywhere(model_id)
    return m["label"] if m else (model_id or "")


# ---------- 尺寸映射 / UI 选项 / 默认参数（全部来自当前 profile） ----------
RATIOS = _get("ratios")
SIZE_OPTIONS = _get("size_options")


def cost_for_size(size: str, model_id: str | None = None) -> float:
    """按尺寸查单张费用。

    优先在该模型的 size_options 里查（不同模型单价可能不同）；
    查不到再回退 profile 级 size_options。未知尺寸返回 0.0——不硬编码兜底价，
    计费一律以配置文件为准。
    """
    for options in (model_sizes(model_id), SIZE_OPTIONS):
        for option in options:
            if option.get("value") == size:
                return float(option.get("cost", 0.0))
    return 0.0


QUALITY_OPTIONS = _get("quality_options")
DEFAULT_MODEL = _get("default_model")
DEFAULT_QUALITY = _get("default_quality")
DEFAULT_SIZE = _get("default_size")
DEFAULT_TIER = _get("default_tier")


# ---------- 配置来源视图（只读）：供 /api/config 下发前端呈现 ----------
# 分层优先级（高 → 低）：.env / 环境变量 > config.json profile > default_profile > 内置默认。
# 前端不自行推断来源——只渲染这里的 value + source，profile 增字段时前端不必「分开改多处」。
_SRC_PROFILE = "config.json profile"
_SRC_FALLBACK = "内置默认"


def get_api_key_source() -> str | None:
    """返回命中的 Key 环境变量名（只报告，不抛错、不返回值本身）。

    候选顺序必须与 get_api_key 一致——两处各写一份，早晚漂移。
    """
    candidates = []
    if ACTIVE_PROFILE:
        candidates.append(f"API_KEY_{ACTIVE_PROFILE.upper()}")
    candidates += ["API_KEY", "AIWANWU_API_KEY"]
    for name in candidates:
        if os.environ.get(name):
            return name
    return None


def build_profile_view(
    *,
    profile_name: str | None,
    profile: dict,
    cfg: dict,
    env_active: str,
    env_file_keys: set[str],
    api_key_name: str | None,
) -> dict:
    """纯函数：把「各层解析结果」拼成「值 + 来源」视图（/api/config 的 profileView）。

    只拼装、不读全局状态——单测把各层参数直接喂进来即可，不必碰真实环境变量。
    """

    def env_where(name: str) -> str:
        """环境变量的准确来源：.env 文件还是系统环境变量"""
        return f".env {name}" if name in env_file_keys else f"环境变量 {name}"

    def source_of(profile_key: str) -> str:
        """该键是 profile 里写死的，还是回退到内置兜底"""
        return _SRC_PROFILE if profile_key in profile else _SRC_FALLBACK

    def value_of(key: str):
        return profile.get(key, _DEFAULTS[key])

    profiles = cfg.get("profiles")
    registered = sorted(profiles) if isinstance(profiles, dict) else []
    api_paths = value_of("api_paths")

    return {
        "name": profile_name,
        "nameSource": (
            env_where("ACTIVE_PROFILE") if env_active else "config.json default_profile"
        ),
        "registeredProfiles": registered,
        "fields": [
            {
                "key": "baseUrl",
                "label": "接口地址",
                "value": value_of("base_url"),
                "source": source_of("base_url"),
                "mono": False,
            },
            {
                "key": "apiPath",
                "label": "接口路径",
                "value": (
                    api_paths.get("generations", "")
                    if isinstance(api_paths, dict)
                    else ""
                ),
                "source": source_of("api_paths"),
                "mono": True,
            },
            {
                "key": "model",
                "label": "模型",
                "value": value_of("default_model"),
                "source": source_of("default_model"),
                "mono": False,
            },
            {
                "key": "apiKey",
                "label": "API Key",
                "value": None,
                "configured": bool(api_key_name),
                "source": env_where(api_key_name) if api_key_name else "未配置",
                "mono": True,
            },
        ],
    }


def describe_config() -> dict:
    """薄包装：把当前进程实际解析出的各层喂给 build_profile_view。

    纯只读——不改加载顺序、不改环境变量；密钥只报「是否配置 + 来源」，绝不回传值。
    """
    return build_profile_view(
        profile_name=ACTIVE_PROFILE,
        profile=_profile,
        cfg=_cfg,
        env_active=(os.environ.get("ACTIVE_PROFILE") or "").strip(),
        env_file_keys=_ENV_FILE_KEYS,
        api_key_name=get_api_key_source(),
    )


# ---------- 服务来源目录（只读）：供前端按「当前实际使用的接口地址」解析尺寸/单价 ----------
def build_provider_catalog(cfg: dict) -> list[dict]:
    """纯函数：把 config.json 里**全部** profile 归一化成「来源目录」。

    为什么需要：价目表按 profile 分家（火山官方 0.2/0.3 元，中转站 0.05/0.1 元），
    而「个人配置」只覆盖接口地址 / 模型 / 路径。若前端仍按 default_profile 的
    size_options 渲染尺寸下拉，切到中转站后就会出现「用着 0.05 的接口、显示 0.2 的价」，
    甚至列出该模型根本不支持的档位（把 1728x2304 发给 gpt-image 系列）。
    把各 profile 的 base_url + sizes + models 一并下发，前端才能按地址自己换表；
    profile 增删来源时前端零改动。

    每项：{name, label, baseUrl, apiPath, defaultModel, defaultQuality, defaultSize, sizes, models, local}

    `local` 标记这条来源是否只存在于本机的 `providers.local.json`：界面据此决定
    能不能删（出厂来源写死在 config.json 里，删了下次 `git pull` 又回来，界面不提供）。
    """
    profiles = cfg.get("profiles")
    if not isinstance(profiles, dict):
        return []
    local_names = provider_store.load_local_providers(LOCAL_PROVIDERS_FILE)["profiles"]
    catalog: list[dict] = []
    for name, profile in profiles.items():
        if not isinstance(profile, dict):
            continue
        paths = profile.get("api_paths")
        if not isinstance(paths, dict):
            paths = _DEFAULTS["api_paths"]
        catalog.append(
            {
                "name": str(name),
                "label": str(profile.get("label") or name),
                "baseUrl": str(profile.get("base_url") or _DEFAULTS["base_url"]),
                # 供配置编辑器在切换 profile 时预览该来源的接口路径
                # （不带上它，前端切了 profile 只能沿用上一个来源的路径）
                "apiPath": str(
                    paths.get("generations") or _DEFAULTS["api_paths"]["generations"]
                ),
                "defaultModel": str(
                    profile.get("default_model") or _DEFAULTS["default_model"]
                ),
                "defaultQuality": str(
                    profile.get("default_quality") or _DEFAULTS["default_quality"]
                ),
                "defaultSize": str(
                    profile.get("default_size") or _DEFAULTS["default_size"]
                ),
                "sizes": list(profile.get("size_options") or _DEFAULTS["size_options"]),
                "models": normalize_models(profile.get("models")),
                "local": str(name) in local_names,
            }
        )
    return catalog


def provider_catalog() -> list[dict]:
    """薄包装：本机 config.json 的来源目录（只读；无 profiles 时返回空列表）。"""
    return build_provider_catalog(_cfg)

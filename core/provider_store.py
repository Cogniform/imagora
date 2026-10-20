#!/usr/bin/env python3
"""本机自定义来源（provider）的存取层 —— `providers.local.json`。

为什么需要这一层
----------------
配置的既有分层是「`config.json` = 出厂目录（git 跟踪，界面永不写）+
`.env` = 本机覆盖 + 密钥（git 忽略，界面只写这里）」。

「添加第三方供应商」要写的是**一整套结构化数据**（地址 / 路径 / 模型清单 /
价目表），它两处都落不下：

- 写 `config.json` 会污染 git 状态；更糟的是冲突解决时一句
  `git checkout config.json` 会**静默丢掉用户刚加的来源**，要等到生成报错才发现。
- 写 `.env` 装不下 —— `.env` 的覆盖通道只有 4 个扁平键（`BASE_URL_<P>` /
  `API_PATH_<P>` / `MODEL_<P>` / `API_KEY_<P>`），且它们都挂在**已注册**的
  profile 下，凭空造不出一个新 profile。

所以新增第三个文件 `providers.local.json`（git 忽略），只放本机新增的来源。
加载时把它的 `profiles` 合并进 `config.json` 的 `profiles`，下游
`resolve_profile_config` / `provider_catalog` / `describe_config` /
`registeredProfiles` 全部零改动自动生效。

合并规则：本机层优先（自己的机器自己说了算），但**重名会告警**——同名时
`config.json` 的那条被遮住，用户会以为改出厂配置没生效，必须让他看得见。
"""

from __future__ import annotations

import json
import re
import warnings
from pathlib import Path

# 本机来源文件名（与 config.json / .env 同级，均在应用根目录）
LOCAL_FILE_NAME = "providers.local.json"

# 文件格式版本：将来若改结构，靠它决定要不要迁移
SCHEMA_VERSION = 1

# profile 名白名单：小写字母开头，只含小写字母 / 数字 / 下划线 / 连字符。
# 与 core/config_guard.py 的 safe_profile_path 校验方向一致，但更严（那里允许大写）：
# 这里的名字会进 .env 键名（API_KEY_<大写>），也会出现在 URL 与文件名里，
# 收紧到全小写可以避免「acme 与 ACME 算两个 profile」这类难查的重复。
_NAME_RE = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")

# API 协议预设：真正决定请求形态的是**路径前缀**（base_url 是否已含 /v1）
PROTOCOL_PRESETS: dict[str, dict[str, str]] = {
    # OpenAI 兼容中转站：路径自带 /v1。地址若也带 /v1，由 _strip_duplicate_version 去重
    "openai": {"generations": "/v1/images/generations", "edits": "/v1/images/edits"},
    # 火山方舟：base_url 已含 /api/v3，路径不再带版本号
    "ark": {"generations": "/images/generations", "edits": "/images/generations"},
}

# base_url 结尾的版本段（/v1、/v1beta、/api/v3 里的 v3 那一段）
_VERSION_TAIL_RE = re.compile(r"/v\d+(?:alpha|beta)?$", re.IGNORECASE)
# 路径开头的版本段（/v1/images/... 里的 /v1）
_VERSION_HEAD_RE = re.compile(r"^/v\d+(?:alpha|beta)?(?=/)", re.IGNORECASE)

# 新建来源沿用的标准尺寸表：8 档常用尺寸，**单价一律 0**。
#
# 为什么是 0 而不是猜一个价：价目表属出厂目录（docs/config-editor-ui-design.md
# 第 9 节明确「界面不编辑价目表」），第三方来源的真实单价只有用户自己知道。
# 填 0 的后果是费用显示 0、预算看板不统计这家 —— 界面上会如实标注，不编假数字。
_STANDARD_SIZES: tuple[tuple[str, str], ...] = (
    ("1024x1024", "1024x1024 (1:1)"),
    ("1536x1024", "1536x1024 (3:2 横版)"),
    ("1024x1536", "1024x1536 (2:3 竖版)"),
    ("2048x2048", "2048x2048 (1:1 2K)"),
    ("1152x2048", "1152x2048 (9:16 竖版长图)"),
    ("2048x1152", "2048x1152 (16:9 横版)"),
    ("1024x1792", "1024x1792 (竖版长图)"),
    ("1792x1024", "1792x1024 (横版长图)"),
)

# 新建来源沿用的比例表（与 _DEFAULTS 一致：常用 7 个比例）
_STANDARD_RATIOS: dict[str, dict[str, str]] = {
    "1:1": {"1K": "1024x1024", "2K": "2048x2048"},
    "3:2": {"2K": "1536x1024"},
    "2:3": {"2K": "1024x1536"},
    "16:9": {"2K": "2048x1152", "4K": "3840x2160"},
    "9:16": {"2K": "1152x2048", "4K": "2160x3840"},
    "7:4": {"2K": "1792x1024"},
    "4:7": {"2K": "1024x1792"},
}


class ProviderError(ValueError):
    """来源定义的校验失败（消息即面向用户的原因，服务端直接转 400）。"""


def local_file(root: Path) -> Path:
    """本机来源文件路径（root 为应用根目录）。"""
    return root / LOCAL_FILE_NAME


def _empty_doc() -> dict:
    return {"version": SCHEMA_VERSION, "profiles": {}}


def load_local_providers(path: Path) -> dict:
    """读取 `providers.local.json`；缺失 / 格式错 / 结构错一律返回空文档。

    宽容读取是刻意的：这个文件由界面写，但用户也可能手改。手改出一个坏文件
    不该让服务起不来 —— 退化成「没有本机来源」，并在控制台告警。
    """
    if not path.exists():
        return _empty_doc()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        warnings.warn(f"{LOCAL_FILE_NAME} 读取失败：{e}，忽略本机来源")
        return _empty_doc()
    if not isinstance(data, dict):
        warnings.warn(f"{LOCAL_FILE_NAME} 格式错误（期望 object），忽略本机来源")
        return _empty_doc()
    profiles = data.get("profiles")
    if not isinstance(profiles, dict):
        return _empty_doc()
    # 只保留结构合法的条目：单条坏掉不牵连其它
    clean = {name: prof for name, prof in profiles.items() if isinstance(prof, dict)}
    return {"version": data.get("version", SCHEMA_VERSION), "profiles": clean}


def merge_profiles(factory: dict, local: dict) -> dict:
    """纯函数：把本机来源合并进出厂 profiles（本机优先，重名告警）。

    返回新的 profiles 字典，不改动入参。
    """
    merged = dict(factory) if isinstance(factory, dict) else {}
    for name, profile in (local or {}).items():
        if name in merged:
            warnings.warn(
                f"{LOCAL_FILE_NAME} 里的来源「{name}」与 config.json 重名，"
                "本机版本生效（config.json 的那条被遮住）"
            )
        merged[name] = profile
    return merged


def standard_sizes() -> list[dict]:
    """新建来源的尺寸表副本（单价 0，调用方拿到的是独立对象）。"""
    return [
        {"value": value, "label": label, "cost": 0.0}
        for value, label in _STANDARD_SIZES
    ]


def standard_ratios() -> dict[str, dict[str, str]]:
    """新建来源的比例表副本。"""
    return {ratio: dict(tiers) for ratio, tiers in _STANDARD_RATIOS.items()}


def _require_text(payload: dict, key: str, *, label: str, limit: int = 200) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ProviderError(f"{label}不能为空")
    text = value.strip()
    if len(text) > limit:
        raise ProviderError(f"{label}过长（上限 {limit} 字符）")
    return text


def validate_name(raw) -> str:
    """校验 profile 名（会进 .env 键名与 URL，规则必须收紧）。"""
    if not isinstance(raw, str) or not raw.strip():
        raise ProviderError("Provider ID 不能为空")
    name = raw.strip()
    if not _NAME_RE.match(name):
        raise ProviderError(
            "Provider ID 只能用小写字母开头，后接小写字母 / 数字 / 下划线 / 连字符，最长 32 位"
        )
    return name


def validate_base_url(raw) -> str:
    """校验接口地址：必须是 http(s) 且能解析出 host。"""
    from urllib.parse import urlparse

    text = _require_text({"v": raw}, "v", label="API 地址")
    parsed = urlparse(text)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ProviderError("API 地址必须是完整的 http(s):// 地址")
    return text.rstrip("/")


def dedupe_version_prefix(base_url: str, api_paths: dict[str, str]) -> dict[str, str]:
    """地址尾部已有版本段时，把路径开头重复的那一段去掉。

    为什么需要这一步：中转站的标准写法是「地址带 /v1」（`https://relay.example/v1`，
    这样 `/models` 之类的端点才通），而 OpenAI 兼容的图片端点路径本身也以 `/v1` 开头
    （`/v1/images/generations`）。两者直接拼起来就是
    `https://relay.example/v1/v1/images/generations` —— 必然 404，而且报错只会说
    「接口不存在」，很难看出是路径重复。用户按界面提示填了带 /v1 的地址就一定会撞上，
    所以去重必须由程序做，不能指望用户选对协议。

    只在**版本段完全相同**时才剥（`/v1` 对 `/v1`）：`/v2` 地址配 `/v1` 路径属于真实
    不一致，擅自改写会把用户配错的地址藏起来。
    """
    tail = _VERSION_TAIL_RE.search(base_url)
    if not tail:
        return dict(api_paths)
    version = tail.group(0).lower()
    fixed: dict[str, str] = {}
    for key, path in api_paths.items():
        head = _VERSION_HEAD_RE.search(path)
        if head and head.group(0).lower() == version:
            fixed[key] = path[len(head.group(0)) :]
        else:
            fixed[key] = path
    return fixed


def resolve_api_paths(payload: dict) -> dict[str, str]:
    """按协议预设或自定义路径得出 api_paths。

    - 预设名（openai / ark）→ 查表
    - `custom` → 取用户填的 generations 路径，edits 默认同一条（多数中转站两者一致）

    本函数只按协议出路径，**不看地址**；地址与路径的版本段去重由
    `dedupe_version_prefix` 在 `build_profile` 里统一做。
    """
    protocol = str(payload.get("protocol") or "openai").strip().lower()
    if protocol in PROTOCOL_PRESETS:
        return dict(PROTOCOL_PRESETS[protocol])
    if protocol != "custom":
        raise ProviderError(f"未知的 API 协议「{protocol}」")
    path = _require_text(payload, "generationsPath", label="接口路径")
    if not path.startswith("/"):
        raise ProviderError("接口路径必须以 / 开头")
    edits = str(payload.get("editsPath") or "").strip() or path
    if not edits.startswith("/"):
        raise ProviderError("图生图接口路径必须以 / 开头")
    return {"generations": path, "edits": edits}


def build_profile(payload: dict) -> tuple[str, dict]:
    """纯函数：把界面提交的表单转成一个 profile 配置。

    返回 (profile 名, profile 配置)。校验失败抛 ProviderError（消息即用户可读原因）。

    **不含密钥**：密钥走 `.env` 的 `API_KEY_<PROFILE 大写>`，由调用方单独写，
    不进这个 JSON 文件（该文件虽是本机层，但没必要把密钥和目录数据混在一起，
    分开才好各自备份 / 各自忽略）。
    """
    name = validate_name(payload.get("name"))
    base_url = validate_base_url(payload.get("baseUrl"))
    label = str(payload.get("label") or "").strip() or name
    api_paths = dedupe_version_prefix(base_url, resolve_api_paths(payload))

    model_id = str(payload.get("model") or "").strip()
    models: list[dict] = []
    if model_id:
        models.append(
            {
                "id": model_id,
                "label": str(payload.get("modelLabel") or "").strip() or model_id,
                "note": "",
                "output_formats": ["png", "jpeg"],
                "size_options": standard_sizes(),
                "ratios": standard_ratios(),
            }
        )

    profile = {
        "label": label,
        "base_url": base_url,
        "api_paths": api_paths,
        "default_model": model_id,
        "default_quality": "high",
        "default_size": "1024x1024",
        "default_tier": "2K",
        "size_options": standard_sizes(),
        "quality_options": ["low", "medium", "high"],
        "ratios": standard_ratios(),
        "models": models,
    }
    return name, profile


def _serialize(doc: dict) -> str:
    return json.dumps(doc, ensure_ascii=False, indent=2) + "\n"


def write_local_providers(path: Path, doc: dict) -> Path:
    """原子写回 `providers.local.json`（沿用 config_write 的写盘纪律）。

    走 `write_text_atomic`：先存 `.bak`，临时文件 → fsync → os.replace。
    这个文件里没有密钥，但半截 JSON 会让下次启动丢掉全部本机来源，
    原子写同样必要。
    """
    from core.config_write import write_text_atomic

    write_text_atomic(path, _serialize(doc), backup=True)
    return path


def add_provider(
    path: Path, payload: dict, *, registered: dict | None = None
) -> tuple[str, dict, Path]:
    """校验 + 落盘一条新来源。

    返回 (name, profile, 写到的路径)。重名 / 校验失败抛 ProviderError。

    `registered` 是当前已注册的 profile 名集合（出厂 + 本机）：重名直接拒绝，
    不覆盖 —— 覆盖会让用户以为自己改的是出厂配置，实际改的是本机副本。
    """
    name, profile = build_profile(payload)
    doc = load_local_providers(path)
    # 两处都要查：出厂目录（registered）与本机文件（doc["profiles"]）。只查一处会漏掉
    # 「本机已经加过、再点一次创建」这种最常见的情况 —— 那会静默覆盖掉原有条目。
    if name in (registered or {}) or name in doc["profiles"]:
        raise ProviderError(f"来源「{name}」已存在，请换一个 Provider ID")
    doc["profiles"][name] = profile
    doc["version"] = SCHEMA_VERSION
    write_local_providers(path, doc)
    return name, profile, path


def remove_provider(path: Path, name: str) -> Path:
    """删除一条本机来源（出厂来源删不掉，不在本文件里）。"""
    doc = load_local_providers(path)
    doc["profiles"].pop(name, None)
    return write_local_providers(path, doc)

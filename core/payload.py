"""请求体组装：产品基线 + 渠道字段 + 模型字段（纯函数，无 I/O，不发请求）。

## 为什么需要这一层

上游差异分两堆，出处不同，混在一起就会出现「换一个模型就用不了」：

- **服务器 / 渠道差异**：同一台服务器上换个模型也不变 —— 例如 `response_format`
  决定的是「图以什么形式回来」，同一模型的另一家网关可能就不认。
- **模型能力差异**：换服务器不变，换模型就变 —— 例如某模型需要显式
  `background: "transparent"` 才会出透明底，另一个只靠提示词就会。

判据（加新字段前先回答这两句）：

1. 换模型、不换服务器，这个字段还成立吗？成立 → 写 `transport.request`（本模块）。
2. 换服务器、不换模型，这个字段还成立吗？成立 → 写 `models[].params`（本模块）。

实证（2026-11-18，chatgpt2api + gpt-image-2.6，同一句提示词）：

| 请求体 | 耗时 | 拿到的字节 |
| --- | --- | --- |
| 现状（含 `output_format: png`） | ~47s | `url` → **JPEG/RGB，黑底** |
| 去掉 `output_format` / `watermark` | 49.0s | `url` → **JPEG/RGB** |
| 再加 `stream: true` | 45.3s | SSE 里仍是 `url` → **JPEG/RGB** |
| 只加 `response_format: b64_json` | **44.4s** | **PNG/RGBA，alpha 0–255** |

结论：`url` 通道回的是网关转码过的 JPEG（无 alpha），只有 `b64_json` 拿到模型原始
PNG。`b64_json` 不是性能负担，它省掉了「再发一个请求下载」这一步。

## 三条规则（顺序不可换）

1. 基线：调用方给的那份字典（model / prompt / size / quality / n / output_format …）
2. 摘除：`transport.drop` 里的键从**基线**里去掉（唯一能删基线的手段）
3. 覆盖：先渠道字段、后模型字段（同键后者胜）

`drop` 只作用于基线，所以「摘掉基线字段，再在 params 里给别的值」是合法写法
（例：`drop: ["output_format"]` + `params: {"output_format": "jpeg"}`）。

## 失败策略：坏配置只降级，不抛异常

`normalize_*` 返回 (干净块, 问题列表)。配置写错时调用方**丢弃该块并打警告**，
payload 回落到「今天的行为」——最坏结果是不生效，而不是程序打不开或每次请求都失败。

`build_payload` 假设输入已经过 `normalize_*`，只做拼装，便于单测。
"""

from __future__ import annotations

import re

# 产品语义字段：由应用决定，配置不许改写（否则用户能把 prompt/size 写坏，
# 而界面上还显示着他填的那份 —— 静默不一致比功能缺失更难查）
PROTECTED_KEYS = frozenset(
    {"model", "prompt", "size", "quality", "n", "images", "mask"}
)

# 会改变「发给谁、带什么凭证」的键：配置只能改请求体，不能改目标与授权。
# 允许它们等于把用户的 key 交给配置文件里的任意地址。
FORBIDDEN_KEYS = frozenset(
    {
        "url",
        "uri",
        "host",
        "base_url",
        "endpoint",
        "authorization",
        "auth",
        "headers",
        "header",
        "api_key",
        "apikey",
        "key",
        "token",
        "cookie",
    }
)

_KEY_RE = re.compile(r"^[A-Za-z0-9_.-]{1,40}$")

# 允许的值形态：标量，或标量数组（有些网关要 ["a","b"] 这种）
_SCALARS = (str, int, float, bool, type(None))


def _value_ok(value) -> bool:
    if isinstance(value, _SCALARS):
        return True
    return isinstance(value, list) and all(isinstance(v, _SCALARS) for v in value)


def check_block(raw, where: str) -> list[str]:
    """检查一个字段块，返回人话问题列表（空列表 = 合法）。"""
    if raw is None:
        return []
    if not isinstance(raw, dict):
        return [f"{where} 必须是对象，实际是 {type(raw).__name__}"]
    problems: list[str] = []
    for key, value in raw.items():
        if not isinstance(key, str) or not _KEY_RE.match(key):
            problems.append(
                f"{where} 的键名 {key!r} 非法（只允许字母数字与 _ . -，1~40 字符）"
            )
            continue
        if key.lower() in FORBIDDEN_KEYS:
            problems.append(
                f"{where}.{key} 不允许配置：配置只能改请求体字段，不能改目标地址或凭证"
            )
        if key in PROTECTED_KEYS:
            problems.append(
                f"{where}.{key} 是产品语义字段，不能由配置覆盖"
                f"（若该渠道不接受它，用 transport.drop 摘掉）"
            )
        if not _value_ok(value):
            problems.append(
                f"{where}.{key} 的值类型不受支持（只允许字符串/数字/布尔/null，或它们的数组）"
            )
    return problems


def normalize_transport(raw) -> tuple[dict, list[str]]:
    """把 profile 的 `transport` 归一成 {request, drop}；坏块整体丢弃（fail-open）。"""
    empty = {"request": {}, "drop": []}
    if raw is None:
        return dict(empty), []
    if not isinstance(raw, dict):
        return dict(empty), [
            f"transport 必须是对象，实际是 {type(raw).__name__}；已忽略"
        ]

    problems: list[str] = []
    extra = set(raw) - {"request", "drop"}
    for key in sorted(extra):
        problems.append(
            f"transport.{key} 不是已知字段（只认 request / drop）；已忽略该键"
        )

    request = raw.get("request") or {}
    problems.extend(check_block(request, "transport.request"))
    drop_raw = raw.get("drop") or []
    drop: list[str] = []
    if not isinstance(drop_raw, list):
        problems.append("transport.drop 必须是字符串数组；已忽略")
    else:
        for item in drop_raw:
            if isinstance(item, str) and _KEY_RE.match(item):
                drop.append(item)
            else:
                problems.append(f"transport.drop 里的 {item!r} 不是合法键名；已忽略")

    # 有任何问题就整体回落到空块：半截生效比不生效更难查
    if problems:
        return dict(empty), problems
    return {"request": dict(request), "drop": drop}, []


def normalize_model_params(raw) -> tuple[dict, list[str]]:
    """把单个模型的 `params` 归一成 dict；坏块整体丢弃（fail-open）。"""
    if raw is None:
        return {}, []
    problems = check_block(raw, "models[].params")
    if problems:
        return {}, problems
    return dict(raw), []


def build_payload(
    base: dict,
    transport: dict | None = None,
    model_params: dict | None = None,
) -> tuple[dict, list[str]]:
    """拼出最终请求体。

    返回 (payload, notes)。notes 是给预览/日志看的人话：哪些键被摘掉、哪些被覆盖、
    哪些是我们不认识的透传字段 —— 「自由」必须可见，否则出问题时无从判断。
    """
    transport = transport or {}
    request = transport.get("request") or {}
    drop = transport.get("drop") or []
    model_params = model_params or {}

    dropped = [key for key in drop if key in base]
    payload = {key: value for key, value in base.items() if key not in drop}
    payload.update(request)
    payload.update(model_params)

    notes: list[str] = []
    for key in dropped:
        notes.append(f"drop:{key}")
    for key in request:
        notes.append(f"channel:{key}")
    for key in model_params:
        notes.append(f"model:{key}")
    known = PROTECTED_KEYS | set(base) | set(request) | set(model_params)
    for key in payload:
        if key not in known:
            notes.append(f"passthrough:{key}")
    return payload, notes


def sends(transport: dict | None, key: str) -> bool:
    """这个字段最终会不会进请求体（基线里有、且没被 `drop` 摘掉）。

    界面拿它当**唯一判据**决定「这个控件该不该出现」：上游不认的字段，
    显示出来就是个骗人的选项 —— 用户调了没反应，还以为是自己没调对。

    为什么由这里答，而不是按模型名/域名猜：那是写死。同一台网关换个模型、
    同一个模型换台网关，结论就变了；而这里问的是「我们实际发了什么」，
    换谁都不会答错。渠道不认某个字段，就把它写进 `transport.drop`。
    """
    return key not in ((transport or {}).get("drop") or [])


def describe(payload: dict, notes: list[str]) -> str:
    """人话摘要（预览脚本与日志共用）。"""
    shape = ", ".join(sorted(payload))
    lines = [f"字段（{len(payload)}）: {shape}"]
    if notes:
        lines.append("标注: " + " ".join(notes))
    return "\n".join(lines)

#!/usr/bin/env python3
"""生图 API —— 请求封装与生成逻辑

核心函数:
  generate_image()            文生图 / 图生图（主入口）
  resolve_size_with_ratio()   尺寸解析（--size 与 --ratio 二选一）
  build_default_output_path() 默认输出路径（当前目录下 output/）
"""

import base64
import contextlib
import itertools
import os
import time
from pathlib import Path

import requests

from core import config
from core.config import get_api_key, normalize_model_id
from core.console import print_success

# 全局序号：保证默认文件名在并发/多窗口下唯一（时间戳只有秒级，同秒必撞）
_SEQ = itertools.count(1)


def format_error(error: Exception, limit: int = 150) -> str:
    """异常 -> 简短可读文本（类型 + 截断消息），供日志/界面统一展示"""
    return f"{type(error).__name__}: {str(error)[:limit]}"


def resolve_size_with_ratio(size, ratio, tier):
    """--size 与 --ratio 二选一，返回最终分辨率字符串。

    注意：这里经 `config.xxx` 取运行期值，不在模块顶层 `from core.config import RATIOS`
    —— 顶层导入是**导入时绑定**的快照，配置热加载后拿到的仍是旧表。
    """
    ratios = config.RATIOS
    if ratio and size:
        raise ValueError("--size 和 --ratio 不能同时使用，二选一")
    if ratio:
        if ratio not in ratios:
            raise ValueError(f"不支持比例 {ratio}，可用: {', '.join(ratios)}")
        tiers = ratios[ratio]
        if tier not in tiers:
            raise ValueError(
                f"比例 {ratio} 没有 {tier} 档，可用档位: {', '.join(tiers)}"
            )
        return tiers[tier]
    return size or config.DEFAULT_SIZE


def build_default_output_path(output_path, output_format):
    """输出路径：未指定时落到 默认输出目录/output 下 ai_时间戳_序号.后缀（序号保证并发唯一）"""
    if output_path:
        return output_path
    seq = next(_SEQ)
    return str(
        Path(config.DEFAULT_OUTPUT_DIR)
        / f"ai_{time.strftime('%Y%m%d_%H%M%S')}_{seq:03d}.{output_format}"
    )


def list_models(base_url: str, api_key: str, timeout: float = 15.0) -> list[str]:
    """探测上游的模型清单（GET {base_url}/models），返回模型 id 列表。

    这是「添加第三方供应商」弹窗里「获取可用模型」的落点。放在 core/api.py 是因为
    这里是全项目**唯一**的外部网络调用模块（见 core/README.md）——server.py 只做
    参数校验与响应整形，不直接碰 requests。

    上游兼容性：OpenAI 风格的 `{"data": [{"id": ...}]}` 最常见；也容忍
    `{"models": [...]}` / 裸数组。拿不到任何 id 时不报错，返回空列表 —— 界面据此
    提示「该来源没报模型，可手填」，这是合法路径而不是失败（模型清单本来就是可选的）。

    Raises:
        RuntimeError: 网络错误 / 非 200 / 响应不是 JSON。消息面向用户，可直接展示。
    """
    url = f"{base_url.rstrip('/')}/models"
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    try:
        response = requests.get(url, headers=headers, timeout=timeout)
    except requests.RequestException as e:
        raise RuntimeError(f"连接不上该地址：{format_error(e)}") from e
    if response.status_code != 200:
        detail = (response.text or "").strip()[:200]
        raise RuntimeError(f"该地址返回 HTTP {response.status_code}：{detail}")
    try:
        payload = response.json()
    except ValueError as e:
        raise RuntimeError(f"该地址返回的不是 JSON：{format_error(e)}") from e

    items = []
    if isinstance(payload, list):
        items = payload
    elif isinstance(payload, dict):
        for key in ("data", "models"):
            value = payload.get(key)
            if isinstance(value, list):
                items = value
                break

    ids: list[str] = []
    for item in items:
        if isinstance(item, str):
            ids.append(item)
        elif isinstance(item, dict):
            # 兼容 {"id": ...} / {"name": ...} / {"model": ...}
            for key in ("id", "name", "model"):
                value = item.get(key)
                if isinstance(value, str) and value:
                    ids.append(value)
                    break
    # 去重保序：上游常把同一模型重复列出
    seen: set[str] = set()
    return [mid for mid in ids if not (mid in seen or seen.add(mid))]


def write_file_with_retry(
    output_path: str,
    data: bytes,
    attempts: int = 3,
    backoff: tuple[float, ...] = (0.3, 0.8, 1.5),
) -> None:
    """写文件带瞬时锁重试（Windows 实况补丁）。

    背景：杀软（Defender/火绒等）或云同步（OneDrive 桌面备份）实时扫描刚落盘的
    新文件时短暂持有句柄，偶发 PermissionError [Errno 13]——目录本身可写、手动
    写入正常、随机复现。重试只针对这种瞬时锁：
    - 只捕获 PermissionError（磁盘满/ACL 拒绝等其余异常立即抛，不掩盖真相）；
    - 退避递增（默认 0.3s → 0.8s → 1.5s，超出退避表长度用最后一位）；
    - 重试用尽后最后一次异常原样抛出：若每次都失败则非瞬时问题，
      应排查目录权限/杀软排除目录，重试框不住。
    """
    attempts = max(1, attempts)
    backoff = backoff or (0.3, 0.8, 1.5)
    for attempt in range(attempts):
        try:
            with open(output_path, "wb") as f:
                f.write(data)
            return
        except PermissionError:
            if attempt == attempts - 1:
                raise
            time.sleep(backoff[min(attempt, len(backoff) - 1)])


def _extract_image_item(payload: dict) -> dict:
    """从响应体里稳健地取出「含图片数据」的那一项。

    兼容多种上游格式（不同中转站/官方口径不一）：
      - OpenAI 风格：{"data": [{"b64_json"|"url": ...}]}
      - 部分中转站：{"data": {"images": [...]}} / {"images": [...]}
      - 火山方舟：{"data": [{"url": ..., "output_format": ...}], "usage": {...}}
    找第一个含 b64_json / url 的条目；找不到时抛出带原始响应的错误，便于排查。
    """

    def _find_in(seq):
        for it in seq:
            if isinstance(it, dict) and ("b64_json" in it or "url" in it):
                return it
            # 嵌套形态：{"images": [{"url": ...}]}
            if isinstance(it, dict):
                for v in it.values():
                    if isinstance(v, list):
                        hit = _find_in(v)
                        if hit:
                            return hit
                    elif isinstance(v, str) and v.startswith("http"):
                        return {"url": v}
        return None

    data = payload.get("data")
    if isinstance(data, list):
        hit = _find_in(data)
        if hit:
            return hit
    if isinstance(data, dict):
        hit = _find_in([data])
        if hit:
            return hit
    for key in ("images", "output", "result"):
        val = payload.get(key)
        if isinstance(val, list):
            hit = _find_in(val)
            if hit:
                return hit
    # 兜底：整个响应里扫一遍 http url
    hit = _find_in([payload])
    if hit:
        return hit
    raise RuntimeError(f"接口响应没有图片数据：{str(payload)[:300]}")


def generate_image(
    prompt,
    image_path=None,
    images=None,
    size=None,
    quality=None,
    model=None,
    n=1,
    output_format="png",
    output_path=None,
    api_base_url=None,
    api_key=None,
    generations_path=None,
    edits_path=None,
    watermark=False,
    seed=None,
):
    """文生图 / 图生图。

    - 传 image_path（单张）或 images（多张参考图）：走 edits 接口
    - 都不传：走 generations 接口（文生图）
    成功保存图片到 output_path（默认自动生成）并打印；失败抛异常。

    Args:
        prompt: 提示词（英文优先，减少歧义）
        image_path: 单张底图路径（None 则看 images）
        images: 多张底图路径列表，一次请求全部作为参考（用途由提示词决定）
        size: 分辨率字符串，如 "1024x1024"（None 取当前配置的默认尺寸）
        quality: low / medium / high（火山 Seedream 会忽略，但不报错）
        model: 模型名（None 取当前配置的默认模型）
        n: 生成张数
        output_format: png / jpg / webp
        output_path: 保存路径（None 时自动生成）
        watermark: 是否带 AI 生成水印（火山 Seedream 支持，默认 False 关闭）
        seed: 随机种子（火山 Seedream 支持，同 seed 可复现；None 则不传）

    默认值刻意写成 None 而不是 `size=DEFAULT_SIZE`：Python 的函数默认值在 **def
    执行时**求值一次，写成常量等于把导入时的配置固化进签名，热加载后仍然用旧值。
    """
    # 模型 ID 里的连字符有半角(U+002D)与全角(U+2011)之分，肉眼完全一样 ——
    # 中转站同一条产品线上两种都在用，用户手打或沿用历史记录时必踩。
    # 发请求前统一纠正成配置里的真实 ID，否则上游只回一个 model_not_found。
    wanted_model = model or config.DEFAULT_MODEL
    model = normalize_model_id(wanted_model) or wanted_model
    size = size or config.DEFAULT_SIZE
    quality = quality or config.DEFAULT_QUALITY
    api_paths = config.API_PATHS
    base_url = (api_base_url or config.BASE_URL).rstrip("/")
    headers = {"Authorization": f"Bearer {api_key or get_api_key()}"}
    payload = {
        "model": model,
        "prompt": prompt,
        "size": size,
        "quality": quality,
        "n": n,
        "output_format": output_format,
    }
    # 火山方舟 Seedream 专属可选参数：水印开关 / 随机种子
    # （非火山上游若严格校验未知字段可能报错，故仅在显式需要时附加 seed）
    payload["watermark"] = bool(watermark)
    if seed is not None:
        payload["seed"] = seed
    output_path = build_default_output_path(output_path, output_format)

    image_paths = images if images else ([image_path] if image_path else [])
    if image_paths:
        # 图生图：一张或多张参考图，一次请求提交（ExitStack 保证任一打开失败时已开的也关闭）
        url = f"{base_url}{edits_path or api_paths['edits']}"
        with contextlib.ExitStack() as stack:
            opened = [stack.enter_context(open(p, "rb")) for p in image_paths]
            files = [
                ("image", (os.path.basename(p), f, "application/octet-stream"))
                for p, f in zip(image_paths, opened)
            ]
            response = requests.post(
                url, headers=headers, files=files, data=payload, timeout=300
            )
    else:
        # 文生图
        url = f"{base_url}{generations_path or api_paths['generations']}"
        response = requests.post(url, headers=headers, json=payload, timeout=300)

    if response.status_code != 200:
        raise RuntimeError(
            f"接口请求失败（HTTP {response.status_code}）：{response.text[:200]}"
        )

    item = _extract_image_item(response.json())
    if item.get("b64_json"):
        raw = base64.b64decode(item["b64_json"])
        write_file_with_retry(output_path, raw)
    elif item.get("url"):
        img_resp = requests.get(item["url"], timeout=300)
        if img_resp.status_code != 200:
            raise RuntimeError(
                f"下载结果图失败（HTTP {img_resp.status_code}）：{item['url'][:120]}"
            )
        write_file_with_retry(output_path, img_resp.content)
    else:
        raise RuntimeError(f"接口响应没有图片数据：{str(item)[:200]}")

    print_success(f"已保存: {output_path}")

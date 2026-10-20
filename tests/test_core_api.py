#!/usr/bin/env python3
"""core/api.py 纯函数单元测试

覆盖: resolve_size_with_ratio、build_default_output_path、write_file_with_retry。
纯函数测试（写文件走伪 open），不调用网络 / 不消耗 API 额度。
"""

import re
from pathlib import Path
from typing import Self

import pytest

import core.api as core_api
from core.api import (
    build_default_output_path,
    format_error,
    resolve_size_with_ratio,
    write_file_with_retry,
)

# ---------- format_error ----------


def test_format_error_prefix_and_message():
    """异常 -> 类型 + 消息"""
    assert format_error(ValueError("boom")) == "ValueError: boom"


def test_format_error_truncates_long_message():
    """超长消息 -> 按 limit 截断"""
    assert format_error(ValueError("x" * 500), limit=10) == "ValueError: xxxxxxxxxx"


def test_format_error_custom_limit():
    """limit 参数生效"""
    assert format_error(RuntimeError("hello"), limit=3) == "RuntimeError: hel"


# ---------- resolve_size_with_ratio ----------


def test_resolve_size_default_when_nothing_given():
    """size 与 ratio 都为空 -> 默认 1024x1024"""
    assert resolve_size_with_ratio(None, None, "2K") == "1024x1024"


def test_resolve_size_returns_given_size():
    """只给 size -> 原样返回"""
    assert resolve_size_with_ratio("1536x1024", None, "2K") == "1536x1024"


def test_resolve_size_rejects_size_and_ratio_together():
    """size 与 ratio 同传 -> ValueError"""
    with pytest.raises(ValueError, match="不能同时使用"):
        resolve_size_with_ratio("1024x1024", "1:1", "2K")


def test_resolve_size_from_ratio():
    """ratio + 档位 -> 对应分辨率。

    具体比例与档位随当前 profile 的 RATIOS 变化（供应商不同尺寸表不同），
    这里从 RATIOS 自身取值而非硬编码某一家的形状，避免切换 profile 后假失败
    （曾经写死 9:16/2K 与 1:1/1K，按 .env.example 推荐的 ACTIVE_PROFILE 换站即红）。
    """
    from core.config import RATIOS

    assert RATIOS, "当前 profile 的 RATIOS 不应为空"
    for ratio, tiers in RATIOS.items():
        for tier, expected in tiers.items():
            assert resolve_size_with_ratio(None, ratio, tier) == expected


def test_resolve_size_rejects_unknown_ratio():
    """不支持的 ratio -> ValueError"""
    from core.config import RATIOS

    unknown = next(r for r in ("5:4", "7:3", "99:1") if r not in RATIOS)
    with pytest.raises(ValueError, match="不支持比例"):
        resolve_size_with_ratio(None, unknown, "2K")


def test_resolve_size_rejects_unavailable_tier():
    """ratio 存在但该档位无此比例 -> ValueError

    档位取自当前 profile 的 RATIOS：挑一个该比例**没有**的档位，而不是写死
    「3:2 必须没有 1K」——那是 volc 的形状，换 profile 就会假失败。
    """
    from core.config import RATIOS

    all_tiers = ("1K", "2K", "4K")
    ratio, missing = next(
        (r, t) for r, tiers in RATIOS.items() for t in all_tiers if t not in tiers
    )
    with pytest.raises(ValueError, match=f"没有 {missing} 档"):
        resolve_size_with_ratio(None, ratio, missing)


# ---------- build_default_output_path ----------


def test_output_path_returns_given_path():
    """给了路径 -> 原样返回"""
    assert build_default_output_path("custom.png", "png") == "custom.png"


def test_output_path_generates_default_name():
    """未给路径 -> 生成 output/ai_时间戳_序号.png"""
    result = build_default_output_path(None, "png")
    path = Path(result)
    assert path.parent.name == "output"
    assert re.fullmatch(r"ai_\d{8}_\d{6}_\d+\.png", path.name), (
        f"文件名格式不符: {path.name}"
    )


def test_output_path_unique_under_concurrency():
    """并发调用 -> 文件名全部唯一（多窗口同秒不覆盖）"""
    import threading

    n = 50
    names = []
    lock = threading.Lock()

    def worker():
        for _ in range(n // 5):
            name = build_default_output_path(None, "png")
            with lock:
                names.append(name)

    threads = [threading.Thread(target=worker) for _ in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(names) == n
    assert len(set(names)) == n, f"出现重复文件名: {len(set(names))} != {n}"


def test_output_path_respects_format():
    """默认文件后缀跟随格式参数"""
    result = build_default_output_path(None, "jpg")
    assert result.endswith(".jpg")


# ---------- write_file_with_retry ----------


class _FakeFile:
    """伪文件（context manager）：只记录写入内容，不碰磁盘（规避中文路径 tmp 坑）"""

    def __init__(self) -> None:
        self.written = b""

    def write(self, data: bytes) -> int:
        self.written += data
        return len(data)

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *exc: object) -> bool:
        return False


def _install_fake_open(monkeypatch: pytest.MonkeyPatch, fail_times: int):
    """把 core.api.open 换成伪实现：前 fail_times 次抛 PermissionError，之后正常返回伪文件"""
    fake = _FakeFile()
    calls = {"n": 0}

    def fake_open(path, mode):
        calls["n"] += 1
        if calls["n"] <= fail_times:
            raise PermissionError(13, "Permission denied", path)
        return fake

    monkeypatch.setattr(core_api, "open", fake_open, raising=False)
    return fake, calls


def test_write_retry_succeeds_first_try(monkeypatch):
    """首写即成功 -> 只开一次、内容完整"""
    fake, calls = _install_fake_open(monkeypatch, fail_times=0)
    write_file_with_retry("out.png", b"raw-png")
    assert calls["n"] == 1
    assert fake.written == b"raw-png"


def test_write_retry_survives_transient_locks(monkeypatch):
    """瞬时锁（前两次 PermissionError）-> 自动重试成功，内容完整"""
    fake, calls = _install_fake_open(monkeypatch, fail_times=2)
    write_file_with_retry(
        "out.png", b"raw-png", attempts=3, backoff=(0.001, 0.001, 0.001)
    )
    assert calls["n"] == 3
    assert fake.written == b"raw-png"


def test_write_retry_exhausts_then_raises(monkeypatch):
    """重试耗尽仍失败 -> 最后一次 PermissionError 原样抛出"""
    _, calls = _install_fake_open(monkeypatch, fail_times=99)
    with pytest.raises(PermissionError):
        write_file_with_retry(
            "out.png", b"raw-png", attempts=3, backoff=(0.001, 0.001, 0.001)
        )
    assert calls["n"] == 3


def test_write_retry_non_permission_error_no_retry(monkeypatch):
    """非瞬时错误（如磁盘满 OSError）-> 不重试、立即抛出"""

    def fake_open(path, mode):
        raise OSError(28, "No space left on device", path)

    monkeypatch.setattr(core_api, "open", fake_open, raising=False)
    with pytest.raises(OSError, match="No space left"):
        write_file_with_retry("out.png", b"raw-png")


def test_write_retry_attempts_floor(monkeypatch):
    """attempts=0 -> 至少尝试一次（不进入零次静默返回）"""
    _, calls = _install_fake_open(monkeypatch, fail_times=99)
    with pytest.raises(PermissionError):
        write_file_with_retry("out.png", b"raw-png", attempts=0)
    assert calls["n"] == 1

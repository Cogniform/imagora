#!/usr/bin/env python3
"""server.py 剪贴板路由测试（不启动服务、不碰真实系统剪贴板）

`POST /api/clipboard/image`：文件不存在 → 404；后端拒绝（非 Windows / 被占用）→ 503
（前端据此静默退回浏览器路径）；成功 → { ok: true } 且只写一次。
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import server
from core import clipboard


@pytest.fixture
def png_path(tmp_path: Path) -> Path:
    """落一张真实 PNG（路由只做存在性检查，内容由 core 层负责）"""
    from PIL import Image

    target = tmp_path / "shot.png"
    Image.new("RGB", (4, 4), (1, 2, 3)).save(target)
    return target


def test_clipboard_image_writes_file(monkeypatch, png_path: Path) -> None:
    """正常路径：交给 core 写剪贴板，成功返回 ok"""
    calls: list[str] = []
    monkeypatch.setattr(clipboard, "put_image_on_clipboard", calls.append)

    assert server.clipboard_image({"path": str(png_path)}) == {"ok": True}
    assert calls == [str(png_path)]


def test_clipboard_image_rejects_missing_file() -> None:
    """文件不存在 → 404（别让前端把"路径过期"误判成"能力不可用"）"""
    with pytest.raises(server.HTTPException) as excinfo:
        server.clipboard_image({"path": "D:\\nowhere\\nope.png"})
    assert excinfo.value.status_code == 404


def test_clipboard_image_reports_unavailable(monkeypatch, png_path: Path) -> None:
    """写剪贴板失败（非 Windows / 被别的程序占着）→ 503 + 人话，前端据此退回浏览器路径"""

    def boom(_path: str) -> None:
        raise clipboard.ClipboardError("剪贴板正被其它程序占用，请稍后重试")

    monkeypatch.setattr(clipboard, "put_image_on_clipboard", boom)

    with pytest.raises(server.HTTPException) as excinfo:
        server.clipboard_image({"path": str(png_path)})
    assert excinfo.value.status_code == 503
    assert "剪贴板正被其它程序占用" in excinfo.value.detail

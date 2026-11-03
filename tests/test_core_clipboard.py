#!/usr/bin/env python3
"""core/clipboard.py 单元测试（不写真实剪贴板，不依赖 Windows）

覆盖: CF_DIB 字节布局（头部字段 / 24 位 BGR / 自下而上 / 4 字节行对齐 / **透明合成白底**）、
PNG 载荷（源是 PNG 用原字节、其它格式转 PNG、alpha 保留）、非 Windows 平台的拒绝语义。
"""

import io
import struct
import sys
from pathlib import Path

import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core import clipboard


def _image(pixels: list[list[tuple[int, int, int]]]) -> Image.Image:
    """按行给出 RGB 像素，构造一张真图（不做任何缩放/插值）"""
    height = len(pixels)
    width = len(pixels[0])
    image = Image.new("RGB", (width, height))
    for y, row in enumerate(pixels):
        for x, rgb in enumerate(row):
            image.putpixel((x, y), rgb)
    return image


def test_dib_bytes_header_describes_24bit_rgb() -> None:
    """头部就是 BITMAPINFOHEADER：40 字节、24 位、BI_RGB（不压缩、无调色板）"""
    data = clipboard.dib_bytes(Image.new("RGB", (2, 3), (0, 0, 0)))

    size, width, height, planes, bits, compression = struct.unpack("<IiiHHI", data[:20])
    assert (size, width, height) == (40, 2, 3)
    assert (planes, bits, compression) == (1, 24, 0)
    # 像素字节数 = 行对齐后的 stride × 高度
    assert struct.unpack("<I", data[20:24])[0] == len(data) - 40


def test_dib_bytes_rows_are_bottom_up_and_bgr() -> None:
    """自下而上 + BGR：写反了图会上下颠倒 / 红蓝互换（肉眼一看就废，但不报错）"""
    red, blue = (255, 0, 0), (0, 0, 255)
    image = _image([[red], [blue]])  # 上一行红、下一行蓝

    pixels = clipboard.dib_bytes(image)[40:]

    # 第一行存的是**最后一行**（蓝），且通道顺序是 BGR
    assert pixels[0:3] == bytes([255, 0, 0])  # blue -> B,G,R = 255,0,0
    assert pixels[4:7] == bytes([0, 0, 255])  # red -> B,G,R = 0,0,255


def test_dib_bytes_pads_rows_to_four_byte_boundary() -> None:
    """宽 1 的图每行 3 字节，必须补 1 个零字节成 4 —— 不补则每行错位、整张图花掉"""
    data = clipboard.dib_bytes(Image.new("RGB", (1, 2), (10, 20, 30)))

    stride = 4
    assert len(data) - 40 == stride * 2
    assert data[40:43] == bytes([30, 20, 10])
    assert data[43] == 0  # 行尾补位


def test_dib_bytes_flattens_transparency_onto_white() -> None:
    """透明像素合成到**白底**，不是把 alpha 扔掉（扔掉 = 透明区粘出来一片黑）"""
    image = Image.new(
        "RGBA", (2, 1), (0, 0, 0, 0)
    )  # 透明像素 RGB 全 0（生成器的典型写法）
    image.putpixel((1, 0), (255, 0, 0, 255))

    pixels = clipboard.dib_bytes(image)[40:]

    assert pixels[0:3] == bytes([255, 255, 255])  # 透明 -> 白
    assert pixels[3:6] == bytes([0, 0, 255])  # 不透明红保持原样（BGR）


def test_png_bytes_keeps_source_bytes_and_alpha(tmp_path: Path) -> None:
    """源是 PNG：原字节直传（不走重编码），alpha 完整保留 —— 认 PNG 的应用粘出来还是透明的"""
    source = tmp_path / "t.png"
    Image.new("RGBA", (8, 8), (0, 0, 0, 0)).save(source)

    with Image.open(source) as image:
        data = clipboard.png_bytes(str(source), image)

    assert data == source.read_bytes()
    assert Image.open(io.BytesIO(data)).getpixel((1, 1))[3] == 0  # alpha 还在


def test_png_bytes_converts_non_png_sources(tmp_path: Path) -> None:
    """jpg 没有 alpha，但没有 PNG 格式的源也要转出 PNG 载荷（剪贴板两种格式必须齐）"""
    source = tmp_path / "t.jpg"
    Image.new("RGB", (8, 8), (10, 20, 30)).save(source)

    with Image.open(source) as image:
        data = clipboard.png_bytes(str(source), image)

    converted = Image.open(io.BytesIO(data))
    assert converted.format == "PNG"
    assert converted.size == (8, 8)


def test_put_image_on_clipboard_rejects_non_windows(monkeypatch) -> None:
    """非 Windows 明确抛 ClipboardError：前端据此静默退回浏览器路径，而不是假装成功"""
    monkeypatch.setattr(sys, "platform", "linux")

    with pytest.raises(clipboard.ClipboardError, match="只有 Windows"):
        clipboard.put_image_on_clipboard("whatever.png")

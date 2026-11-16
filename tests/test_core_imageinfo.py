"""core/imageinfo.py 单元测试：图片头解析（宽高/格式），零依赖零网络"""

import struct

from core.imageinfo import detect_format, image_dimensions


def _png(w=100, h=200):
    return (
        b"\x89PNG\r\n\x1a\n"
        + b"\x00\x00\x00\x0dIHDR"
        + struct.pack(">II", w, h)
        + b"\x08\x06\x00\x00\x00"
        + b"\x00" * 4
    )


def _gif(w=100, h=200):
    return b"GIF89a" + struct.pack("<HH", w, h) + b"\x00" * 20


def _bmp(w=100, h=200):
    return (
        b"BM"
        + b"\x00" * 8
        + b"\x00\x00\x00\x00"
        + b"\x28\x00\x00\x00"
        + struct.pack("<ii", w, h)
        + b"\x00" * 32
    )


def _jpeg(w=100, h=200):
    return (
        b"\xff\xd8"
        + b"\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
        + b"\xff\xc0\x00\x11\x08"
        + struct.pack(">HH", h, w)
        + b"\x03\x01\x11\x00\x02\x11\x00\x03\x11\x00"
        + b"\xff\xd9"
    )


def _webp_vp8(w=100, h=200):
    return (
        b"RIFF\x00\x00\x00\x00WEBP"
        + b"VP8 \x00\x00\x00\x00"
        + b"\x00\x00\x00\x9d\x01\x2a"
        + struct.pack("<H", w)
        + struct.pack("<H", h)
        + b"\x00" * 8
    )


def _webp_vp8l(w=100, h=200):
    bits = (w - 1) | ((h - 1) << 14)
    return (
        b"RIFF\x00\x00\x00\x00WEBP"
        + b"VP8L\x00\x00\x00\x00"
        + b"\x2f"
        + struct.pack("<I", bits)
        + b"\x00" * 8
    )


def _webp_vp8x(w=100, h=200):
    return (
        b"RIFF\x00\x00\x00\x00WEBP"
        + b"VP8X\x00\x00\x00\x00"
        + b"\x00\x00\x00\x00"
        + (w - 1).to_bytes(3, "little")
        + (h - 1).to_bytes(3, "little")
        + b"\x00" * 8
    )


def _write(tmp_path, name, data):
    p = tmp_path / name
    p.write_bytes(data)
    return str(p)


def test_png(tmp_path):
    assert image_dimensions(_write(tmp_path, "a.png", _png())) == {
        "width": 100,
        "height": 200,
        "format": "png",
    }


def test_gif(tmp_path):
    assert image_dimensions(_write(tmp_path, "a.gif", _gif())) == {
        "width": 100,
        "height": 200,
        "format": "gif",
    }


def test_bmp(tmp_path):
    assert image_dimensions(_write(tmp_path, "a.bmp", _bmp())) == {
        "width": 100,
        "height": 200,
        "format": "bmp",
    }


def test_jpeg(tmp_path):
    assert image_dimensions(_write(tmp_path, "a.jpg", _jpeg())) == {
        "width": 100,
        "height": 200,
        "format": "jpeg",
    }


def test_webp_vp8(tmp_path):
    assert image_dimensions(_write(tmp_path, "a.webp", _webp_vp8())) == {
        "width": 100,
        "height": 200,
        "format": "webp",
    }


def test_webp_vp8l(tmp_path):
    assert image_dimensions(_write(tmp_path, "a.webp", _webp_vp8l())) == {
        "width": 100,
        "height": 200,
        "format": "webp",
    }


def test_webp_vp8x(tmp_path):
    assert image_dimensions(_write(tmp_path, "a.webp", _webp_vp8x())) == {
        "width": 100,
        "height": 200,
        "format": "webp",
    }


def test_garbage_returns_none(tmp_path):
    assert image_dimensions(_write(tmp_path, "g.bin", b"not an image at all")) is None


def test_truncated_png_returns_none(tmp_path):
    assert (
        image_dimensions(_write(tmp_path, "t.png", b"\x89PNG\r\n\x1a\n" + b"\x00"))
        is None
    )


def test_missing_file_returns_none(tmp_path):
    assert image_dimensions(str(tmp_path / "nope.png")) is None


# ---------- detect_format：只判格式，不吃 64 字节窗口 ----------


def test_detect_format_all_known(tmp_path):
    cases = [
        ("a.png", _png(), "png"),
        ("a.jpg", _jpeg(), "jpeg"),
        ("a.gif", _gif(), "gif"),
        ("a.webp", _webp_vp8(), "webp"),
        ("a.bmp", _bmp(), "bmp"),
    ]
    for name, data, want in cases:
        assert detect_format(_write(tmp_path, name, data)) == want


def test_detect_format_ignores_extension(tmp_path):
    """判据是字节不是后缀：`.png` 名字里装 JPEG 也要报 jpeg。"""
    assert detect_format(_write(tmp_path, "lying.png", _jpeg())) == "jpeg"


def test_detect_format_reads_jpeg_with_long_app_segment(tmp_path):
    """JPEG 的 APP0/EXIF 段长于 64 字节时 SOF 落在读窗之外。

    回归：`image_dimensions()` 此时返回 None（宽高未知），但这不影响「是不是 JPEG」——
    实测上游静态图正是这种带大段 EXIF 的 JPEG，落盘扩展名曾因此一直没被校正。
    """
    long_app = b"\xff\xe1\xff\xf0" + b"\x00" * 0xF0  # 一条 0xFFF0 字节的 EXIF 段
    data = b"\xff\xd8" + long_app + _jpeg()[2:]
    p = _write(tmp_path, "big.jpg", data)
    assert image_dimensions(p) is None  # 宽高读不到（既有 64 字节窗口的限制）
    assert detect_format(p) == "jpeg"  # 但格式判定不受影响


def test_detect_format_garbage_returns_empty(tmp_path):
    assert detect_format(_write(tmp_path, "g.bin", b"not an image at all")) == ""


def test_detect_format_short_file_returns_empty(tmp_path):
    assert detect_format(_write(tmp_path, "s.bin", b"\x89PN")) == ""


def test_detect_format_missing_file_returns_empty(tmp_path):
    assert detect_format(str(tmp_path / "nope.gif")) == ""

"""系统剪贴板写入（Windows，本机同步）。

**为什么需要它**（2026-11-01 实测，见 [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) 8.3）：
浏览器 `navigator.clipboard.write()` 写图片是**异步投递** —— Promise resolve 时系统
剪贴板里还没有位图，要 100~300ms 后才读得到（大图更久，偶发整次丢弃），页面失活时
还可能被挂起。于是前端一 resolve 就提示"已复制"，用户切到微信立刻 Ctrl+V 却什么都
粘不出来。本机服务端直接 `SetClipboardData(CF_DIB)` 是**同步**的：函数返回即剪贴板里
已有位图，不依赖窗口焦点。

调用约定：路由侧用 `_UI_LOCK` 串行化（剪贴板是全局 OS 资源，并发写会互相顶掉），
失败一律抛 `ClipboardError`（消息给人看，前端原样显示并自动退回浏览器路径）。

**同时写两种格式**（2026-11-03 补，之前只写 DIB 会把透明通道丢掉）：
- `CF_DIB` —— 24 位、无 alpha。透明像素**合成到白底**（不是原样丢 alpha：生成器的
  透明像素 RGB 通常是 0，丢 alpha 粘出来就是一片黑）。微信 / 画图 / 老软件读的是它。
- 注册格式 `PNG` —— 原图字节（源文件是 PNG 就直接用原字节，无损且保留 alpha；
  其它格式转 PNG）。Photoshop / Office / 浏览器这些认 alpha 的读它。
浏览器自己的 `clipboard.write()` 也是「PNG + DIB」这个组合，别只写一半。
"""

import ctypes
import io
import struct
import sys
import time
from ctypes import wintypes
from pathlib import Path

from PIL import Image

# 剪贴板格式：DIB = 去掉 14 字节文件头的 BMP（Windows 侧通用位图格式，微信 / Office /
# 画图都按它读；但它没有 alpha 通道，透明信息要靠下面那个注册格式带走）
CF_DIB = 8
# 注册格式名（RegisterClipboardFormatW）。Chrome / Firefox 写的也是这个名字，
# 认它的应用（Photoshop / Office / 浏览器）能拿到带 alpha 的原图。
CF_PNG_NAME = "PNG"
GMEM_MOVEABLE = 0x0002
# 一条 BITMAPINFOHEADER 是 40 字节：size/宽/高/平面/位深/压缩/图像字节/XY 分辨率/调色板
_HEADER = "<IiiHHIIiiII"


class ClipboardError(RuntimeError):
    """写系统剪贴板失败（消息面向用户，路由原样下发）"""


def supported() -> bool:
    """本机是否支持直接写系统剪贴板（只有 Windows 有 Win32 剪贴板 API）"""
    return sys.platform == "win32"


def flatten_on_white(image: Image.Image) -> Image.Image:
    """把带 alpha 的图合成到白底，得到 RGB（DIB 用）。

    24 位 DIB 没有 alpha，直接 `convert("RGB")` 只是把 alpha **扔掉**——生成器的透明
    像素 RGB 一般是 (0,0,0)，于是透明区粘出来是一片**黑**。合成到白底才符合"透明背景
    的图粘到白底上"这个直觉。本来就没有 alpha 的图走同一条路，像素逐字不变。
    """
    rgba = image.convert("RGBA")
    canvas = Image.new("RGB", rgba.size, (255, 255, 255))
    canvas.paste(rgba, mask=rgba.getchannel("A"))
    return canvas


def dib_bytes(image: Image.Image) -> bytes:
    """把 PIL 图编码成 CF_DIB 需要的字节（40 字节头 + 24 位 BGR 像素）。

    自拼而非「存 BMP 再切掉 14 字节文件头」：少一次整体拷贝，且行对齐 / 像素方向
    这些容易写错的细节能被单测直接锁住（见 `tests/test_core_clipboard.py`）。

    三个必须守住的格式约定：① 位深固定 24 位（`BI_RGB`，不加调色板）；
    ② **自下而上**存行（biHeight 为正数即代表这个方向，写反了图片会上下颠倒）；
    ③ 每行按 4 字节对齐补齐（宽不是 4 的倍数时行尾要补零，否则整张图错位）。
    """
    rgb = flatten_on_white(image)
    width, height = rgb.size
    row_len = width * 3
    stride = (row_len + 3) & ~3
    # 先整体翻转成自下而上，再一次性取 BGR 三通道交错字节（避免逐像素 Python 循环）
    rows = rgb.transpose(Image.Transpose.FLIP_TOP_BOTTOM).tobytes("raw", "BGR")
    if stride != row_len:
        padding = b"\x00" * (stride - row_len)
        rows = b"".join(
            rows[offset : offset + row_len] + padding
            for offset in range(0, len(rows), row_len)
        )
    header = struct.pack(
        _HEADER, 40, width, height, 1, 24, 0, len(rows), 2835, 2835, 0, 0
    )
    return header + rows


def png_bytes(path: str, image: Image.Image) -> bytes:
    """PNG 载荷：**保留 alpha**，认它的应用（Photoshop / Office / 浏览器）粘出来还是透明的。

    源文件本来就是 PNG 时直接用原字节：无损、不重编码、也不受 Pillow 的编码参数影响；
    其它格式（jpg / webp / bmp）才转成 PNG。
    """
    if image.format == "PNG":
        return Path(path).read_bytes()
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _open_clipboard(user32, retries: int, retry_delay: float) -> None:
    """打开剪贴板，被别的程序（剪贴板管理器 / IM / Office）占着时短暂重试。

    Win32 的剪贴板是**独占**的：别人开着 `OpenClipboard` 期间我们再开只会拿到 0
    （GetLastError=5）。这不是错误，等几十毫秒基本就能拿到。
    """
    for _ in range(retries):
        if user32.OpenClipboard(None):
            return
        time.sleep(retry_delay)
    raise ClipboardError("剪贴板正被其它程序占用，请稍后重试")


def _share_bytes(kernel32, data: bytes) -> int:
    """把字节复制进可移交系统的全局内存块，返回句柄（失败抛错）"""
    handle = kernel32.GlobalAlloc(GMEM_MOVEABLE, len(data))
    if not handle:
        raise ClipboardError("分配剪贴板内存失败")
    pointer = kernel32.GlobalLock(handle)
    if not pointer:
        kernel32.GlobalFree(handle)
        raise ClipboardError("锁定剪贴板内存失败")
    ctypes.memmove(pointer, data, len(data))
    kernel32.GlobalUnlock(handle)
    return handle


def put_image_on_clipboard(
    path: str, *, retries: int = 10, retry_delay: float = 0.05
) -> None:
    """把图片文件写进系统剪贴板（DIB + PNG 两种格式）；**返回即可粘贴**，失败抛 `ClipboardError`。"""
    if not supported():
        raise ClipboardError("只有 Windows 本机支持直接写系统剪贴板")
    try:
        with Image.open(path) as image:
            payloads = (
                (CF_DIB, dib_bytes(image)),
                (None, png_bytes(path, image)),  # None = 下面现场注册格式号
            )
    except OSError as exc:
        raise ClipboardError(f"图片读取失败：{exc}") from exc

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    user32.OpenClipboard.argtypes = [wintypes.HWND]
    user32.OpenClipboard.restype = wintypes.BOOL
    user32.EmptyClipboard.restype = wintypes.BOOL
    user32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
    user32.SetClipboardData.restype = wintypes.HANDLE
    user32.CloseClipboard.restype = wintypes.BOOL
    user32.RegisterClipboardFormatW.argtypes = [wintypes.LPCWSTR]
    user32.RegisterClipboardFormatW.restype = wintypes.UINT
    kernel32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
    kernel32.GlobalAlloc.restype = wintypes.HGLOBAL
    kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalLock.restype = ctypes.c_void_p
    kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalFree.argtypes = [wintypes.HGLOBAL]

    _open_clipboard(user32, retries, retry_delay)
    try:
        if not user32.EmptyClipboard():
            raise ClipboardError("清空剪贴板失败")
        for fmt, data in payloads:
            # 注册格式名要与 Chrome 一致（"PNG"），否则认它的应用拿不到
            actual = (
                fmt if fmt is not None else user32.RegisterClipboardFormatW(CF_PNG_NAME)
            )
            if not actual:
                raise ClipboardError("注册 PNG 剪贴板格式失败")
            handle = _share_bytes(kernel32, data)
            # 成功后句柄所有权归系统，**不能**再 GlobalFree（会用已移交的内存告警/崩溃）
            if not user32.SetClipboardData(actual, handle):
                kernel32.GlobalFree(handle)
                raise ClipboardError("写入剪贴板失败")
    finally:
        user32.CloseClipboard()

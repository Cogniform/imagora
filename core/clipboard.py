"""系统剪贴板写入（Windows，本机同步）。

**为什么需要它**（2026-11-01 实测，见 [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) 8.3）：
浏览器 `navigator.clipboard.write()` 写图片是**异步投递** —— Promise resolve 时系统
剪贴板里还没有位图，要 100~300ms 后才读得到（大图更久，偶发整次丢弃），页面失活时
还可能被挂起。于是前端一 resolve 就提示"已复制"，用户切到微信立刻 Ctrl+V 却什么都
粘不出来。本机服务端直接 `SetClipboardData(CF_DIB)` 是**同步**的：函数返回即剪贴板里
已有位图，不依赖窗口焦点。

调用约定：路由侧用 `_UI_LOCK` 串行化（剪贴板是全局 OS 资源，并发写会互相顶掉），
失败一律抛 `ClipboardError`（消息给人看，前端原样显示并自动退回浏览器路径）。
"""

import ctypes
import struct
import sys
import time
from ctypes import wintypes

from PIL import Image

# 剪贴板格式：DIB = 去掉 14 字节文件头的 BMP（Windows 侧通用图片格式，微信 / Office /
# 画图都按它读；浏览器那条路提供的 "PNG" 自定义格式它们大多不认）
CF_DIB = 8
GMEM_MOVEABLE = 0x0002
# 一条 BITMAPINFOHEADER 是 40 字节：size/宽/高/平面/位深/压缩/图像字节/XY 分辨率/调色板
_HEADER = "<IiiHHIIiiII"


class ClipboardError(RuntimeError):
    """写系统剪贴板失败（消息面向用户，路由原样下发）"""


def supported() -> bool:
    """本机是否支持直接写系统剪贴板（只有 Windows 有 Win32 剪贴板 API）"""
    return sys.platform == "win32"


def dib_bytes(image: Image.Image) -> bytes:
    """把 PIL 图编码成 CF_DIB 需要的字节（40 字节头 + 24 位 BGR 像素）。

    自拼而非「存 BMP 再切掉 14 字节文件头」：少一次整体拷贝，且行对齐 / 像素方向
    这些容易写错的细节能被单测直接锁住（见 `tests/test_core_clipboard.py`）。

    三个必须守住的格式约定：① 位深固定 24 位（`BI_RGB`，不加调色板）；
    ② **自下而上**存行（biHeight 为正数即代表这个方向，写反了图片会上下颠倒）；
    ③ 每行按 4 字节对齐补齐（宽不是 4 的倍数时行尾要补零，否则整张图错位）。
    """
    rgb = image.convert("RGB")
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


def put_image_on_clipboard(
    path: str, *, retries: int = 10, retry_delay: float = 0.05
) -> None:
    """把图片文件写进系统剪贴板；**返回即可粘贴**，失败抛 `ClipboardError`。"""
    if not supported():
        raise ClipboardError("只有 Windows 本机支持直接写系统剪贴板")
    try:
        with Image.open(path) as image:
            data = dib_bytes(image)
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
        handle = kernel32.GlobalAlloc(GMEM_MOVEABLE, len(data))
        if not handle:
            raise ClipboardError("分配剪贴板内存失败")
        pointer = kernel32.GlobalLock(handle)
        if not pointer:
            kernel32.GlobalFree(handle)
            raise ClipboardError("锁定剪贴板内存失败")
        ctypes.memmove(pointer, data, len(data))
        kernel32.GlobalUnlock(handle)
        # 成功后句柄所有权归系统，**不能**再 GlobalFree（会用已移交的内存告警/崩溃）
        if not user32.SetClipboardData(CF_DIB, handle):
            kernel32.GlobalFree(handle)
            raise ClipboardError("写入剪贴板失败")
    finally:
        user32.CloseClipboard()

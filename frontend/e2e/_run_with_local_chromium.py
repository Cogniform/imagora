"""E2E 运行垫片：给 Playwright 注入本机已存在的 Chromium 可执行文件。

为什么需要它：项目 .venv 里的 playwright 只认自己那一版 Chromium 修订号，
而机器上 `%LOCALAPPDATA%\\ms-playwright` 下可能只有别的修订版（版本升级时
旧版不会自动删除）。此时 `pw.chromium.launch()` 直接报 "Executable doesn't
exist"，但机器上其实有可用的浏览器。

本垫片只做一件事：patch `BrowserType.launch`，在调用方没指定
executable_path 时补一个能用的 chrome.exe，然后 exec 目标脚本。
不改仓库里任何 E2E 脚本。

用法：
    python e2e/_run_with_local_chromium.py e2e/verify_provider.py

查找顺序：
1. 环境变量 `IMAGORA_CHROMIUM`（显式指定，优先级最高）
2. `%LOCALAPPDATA%\\ms-playwright\\chromium-*\\**\\chrome.exe`（取修订号最大的）
3. Playwright 自带的那份（找不到上面两个时干脆不 patch，让原报错照常出现）
"""

from __future__ import annotations

import os
import runpy
import sys
from pathlib import Path

from playwright.sync_api import BrowserType


def _candidates() -> list[Path]:
    """按优先级列出可能的 Chromium 可执行文件。"""
    found: list[Path] = []

    explicit = os.environ.get("IMAGORA_CHROMIUM")
    if explicit:
        found.append(Path(explicit))

    root = Path(os.environ.get("LOCALAPPDATA", "")) / "ms-playwright"
    if not root.is_dir():
        return found

    # 目录名形如 chromium-1208 / chromium_headless_shell-1208，
    # 按名字里的修订号倒序：新版本优先。
    def rev(p: Path) -> int:
        tail = p.name.rsplit("-", 1)[-1]
        return int(tail) if tail.isdigit() else 0

    for entry in sorted(root.glob("chromium-*"), key=rev, reverse=True):
        # chrome.exe 在 chrome-win64/ 或 chrome-win/ 下，因版本而异
        found.extend(entry.glob("*/chrome.exe"))
    return found


CHROMIUM = next((p for p in _candidates() if p.is_file()), None)

if CHROMIUM is None:
    sys.exit(
        "找不到可用的 Chromium。请先跑 `playwright install chromium`，"
        "或用 IMAGORA_CHROMIUM=<chrome.exe 路径> 显式指定。"
    )

_original = BrowserType.launch


def _launch(self, *args, **kwargs):
    kwargs.setdefault("executable_path", str(CHROMIUM))
    return _original(self, *args, **kwargs)


if len(sys.argv) < 2:
    sys.exit("用法：python e2e/_run_with_local_chromium.py <e2e 脚本> [参数...]")

print(f"[垫片] 使用 Chromium: {CHROMIUM}", file=sys.stderr)
BrowserType.launch = _launch

target = sys.argv[1]
sys.argv = sys.argv[1:]
runpy.run_path(target, run_name="__main__")

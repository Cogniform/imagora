#!/usr/bin/env python3
"""Imagora 统一入口

用法（在 Imagora 目录运行）:
  python -m main ui                                                    # 启动网页界面
  python -m main menu --port 7860                                      # 交互菜单（启动脚本用）
  python -m main batch --config 项目/batch_prompts.json                # 批量生图
  python -m main batch --config 项目/batch_prompts.json --dry-run      # 预览不花钱
  python -m main config                                                # 显示当前 profile 支持的尺寸/比例/质量/默认值
  python -m main gen "提示词" --size 1024x1024 --quality high -o out.png            # 文生图
  python -m main gen "提示词" --ratio 9:16 --tier 2K --quality high -o out.png      # 按比例+档位
  python -m main gen "提示词" --size 1024x1024 --quality high -o out.png -i r1.png -i r2.png  # 多参考图图生图

CLI gen 子命令与 web 表单完全对等：尺寸/质量/参考图/输出路径无损透传到模型 API；
生成成功后旁路注册资产 + 落提交快照 + 写全量账本（submission_id + asset_ids + cost_for_size），
与 web 端产出的 logs/generation.jsonl 与 output/submissions/*.json 同源可互查。
"""

import argparse
import colorsys
import os
import sys
import time
from itertools import count
from pathlib import Path

from core import api, graphstore
from core import config as config_mod
from core.api import generate_image, resolve_size_with_ratio
from core.batch import run_batch_generation
from core.config import (
    DEFAULT_MODEL,
    DEFAULT_OUTPUT_DIR,
    DEFAULT_QUALITY,
    DEFAULT_SIZE,
    DEFAULT_TIER,
    QUALITY_OPTIONS,
    RATIOS,
    SIZE_OPTIONS,
)
from core.console import console, print_error, print_info, print_success
from core.logging import log_generation

_reconfigure = getattr(sys.stdout, "reconfigure", None)
if _reconfigure is not None:
    _reconfigure(encoding="utf-8")

# CLI gen 文件名序号（与 server._SEQ 同语义：秒级时间戳同秒并发必撞，加序号保证唯一）
_SEQ = count(1)


def accent_for_window(window_id: int | None) -> str:
    """窗口主体色（与 frontend/src/accent.ts 同算法）：
    hue = (windowId-1)*137.508 % 360，saturation 55%，lightness 42%。
    返回 #rrggbb，供菜单面板边框随窗口编号变色（多开一眼可辨）。
    """
    hue = ((window_id or 1) - 1) * 137.508 % 360
    r, g, b = colorsys.hls_to_rgb(hue / 360, 0.42, 0.55)
    return f"#{int(r * 255):02x}{int(g * 255):02x}{int(b * 255):02x}"


def handle_ui_command(args):
    """启动 Web 界面（FastAPI 托管前端构建产物）"""
    import threading
    import webbrowser

    import uvicorn

    from server import app

    url = f"http://127.0.0.1:{args.port}"
    print_success(f"服务已启动: {url}")
    if not getattr(args, "no_browser", False):
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    uvicorn.run(app, host="127.0.0.1", port=args.port)


def handle_batch_command(args):
    """执行批量生图"""
    config_path = (
        Path(args.config) if args.config else (Path.cwd() / "batch_prompts.json")
    )
    if not config_path.exists():
        print_error(f"未找到配置文件: {config_path}，请用 --config 指定项目配置路径")
        sys.exit(1)
    failed = run_batch_generation(
        config_path, module_filter=args.only, dry_run=args.dry_run
    )
    if failed:
        print_error(f"批量结束 · {len(failed)} 张失败")
        sys.exit(1)


def _validate_gen_args(args) -> None:
    """校验必填参数与互斥关系，缺失或冲突立即报错退出（与 web 表单等价的强约束）。

    - --size 与 --ratio 二选一必填（与 web 表单一致：尺寸由用户显式选定）
    - --quality 必填（与 web 表单一致：质量不能默认）
    - --output 必填（与 web 表单的 output_dir 一致：输出位置必须明确）
    - --ratio 必须在当前 profile 的 RATIOS 内
    - --tier 配合 --ratio，必须在所选比例的档位内
    - --quality 必须在当前 profile 的 QUALITY_OPTIONS 内
    - --size 必须在当前 profile 的 SIZE_OPTIONS 的 value 列表内
    """
    missing: list[str] = []
    if not args.size and not args.ratio:
        missing.append("--size 或 --ratio（二选一）")
    if not args.quality:
        missing.append("--quality")
    if not args.output:
        missing.append("--output / -o")
    if missing:
        print_error("缺少必填参数：" + " · ".join(missing))
        print_info("运行 `python -m main config` 查看当前 profile 支持的尺寸/比例/质量")
        print_info(
            '示例：python -m main gen "提示词" --size 1024x1024 --quality high -o out.png'
        )
        sys.exit(2)
    if args.size and args.ratio:
        print_error("--size 与 --ratio 不能同时使用，二选一")
        sys.exit(2)
    if args.ratio and args.ratio not in RATIOS:
        print_error(f"不支持的比例 {args.ratio}，可用: {', '.join(RATIOS.keys())}")
        sys.exit(2)
    if args.ratio and args.tier not in RATIOS[args.ratio]:
        print_error(
            f"比例 {args.ratio} 没有 {args.tier} 档，可用档位: {', '.join(RATIOS[args.ratio].keys())}"
        )
        sys.exit(2)
    quality_values = [
        q.get("value") if isinstance(q, dict) else str(q) for q in QUALITY_OPTIONS
    ]
    if args.quality not in quality_values:
        print_error(f"不支持的质量 {args.quality}，可用: {', '.join(quality_values)}")
        sys.exit(2)
    if args.size:
        size_values = [s.get("value") for s in SIZE_OPTIONS]
        if args.size not in size_values:
            print_error(f"不支持的尺寸 {args.size}，可用: {', '.join(size_values)}")
            sys.exit(2)


def _resolve_output(args) -> tuple[str, str, str]:
    """解析 --output 参数为 (output_path, output_dir, output_format)。

    与 web 表单的 output_dir 行为对齐：
      - 传目录（已存在目录 或 以路径分隔符结尾）→ 在该目录下自动生成文件名
        （ai_<时间戳>_<序号>.<后缀>，与 server.run_generation 同算法，序号保证并发唯一）
      - 传文件路径 → 直接使用该路径
    后缀决定 output_format，无后缀回退 --format。
    """
    output_format = os.path.splitext(args.output)[1].lstrip(".") or args.format
    if os.path.isdir(args.output) or args.output.endswith(("\\", "/")):
        output_dir = args.output.rstrip("\\/") or DEFAULT_OUTPUT_DIR
        os.makedirs(output_dir, exist_ok=True)
        seq = next(_SEQ)
        stamp = time.strftime("%Y%m%d_%H%M%S")
        output_path = os.path.join(output_dir, f"ai_{stamp}_{seq:03d}.{output_format}")
    else:
        output_path = args.output
        output_dir = os.path.dirname(os.path.abspath(args.output)) or "."
        os.makedirs(output_dir, exist_ok=True)
    return output_path, output_dir, output_format


def _resolve_output_list(args, count: int) -> tuple[list[str], str, str]:
    """按张数解析每轮一张的输出路径，返回 (paths, output_dir, output_format)。

    - 传目录：每轮各走一次 `_resolve_output`，自动序号保证互不相同
    - 传具体文件：第 1 张用原名（与 `--n 1` 完全一致），第 2 张起加 `_2`、`_3` 后缀
    """
    first, output_dir, output_format = _resolve_output(args)
    if count <= 1:
        return [first], output_dir, output_format
    if os.path.isdir(args.output) or args.output.endswith(("\\", "/")):
        paths = [first] + [_resolve_output(args)[0] for _ in range(count - 1)]
        return paths, output_dir, output_format
    stem, ext = os.path.splitext(first)
    return (
        [first] + [f"{stem}_{i}{ext}" for i in range(2, count + 1)],
        output_dir,
        output_format,
    )


def handle_gen_command(args):
    """生图（文生图 / 图生图），`--n` 由客户端循环兑现。

    与 web 端的差异仅在调度：CLI 逐张同步等待结果（不进入全局任务池），其余链路一致：
      - 尺寸/质量/参考图/格式对齐 web；每张一次请求、每次请求 `n=1`
      - 每张各自旁路 persist_submission_assets（与 server 共用同一资产旁路逻辑）
      - 每张各自写一行账本，计费走 config.cost_for_size（与 server.size_cost 同源）
    """
    _validate_gen_args(args)

    requested = max(1, args.n)
    paths, output_dir, output_format = _resolve_output_list(args, requested)
    size = resolve_size_with_ratio(args.size, args.ratio, args.tier)

    ref_paths: list[str] = []
    for p in args.image or []:
        abs_p = os.path.abspath(p)
        if not os.path.isfile(abs_p):
            print_error(f"参考图不存在: {p}")
            sys.exit(2)
        ref_paths.append(abs_p)

    unit_cost = config_mod.cost_for_size(size)
    mode = "img2img" if ref_paths else "txt2img"
    if mode == "img2img":
        print_info(f"图生图 · 参考图 {len(ref_paths)} 张")
    else:
        print_info("文生图")
    if len(paths) > 1:
        total = unit_cost * len(paths)
        print_info(f"共 {len(paths)} 张 · 逐张请求 · 预计费用 {total:.2f} 元")

    failures: list[str] = []
    spent = 0.0
    for index, dest in enumerate(paths, start=1):
        if len(paths) > 1:
            print_info(f"第 {index}/{len(paths)} 张")
        # --no-asset 模式不生成 submission_id（不写提交快照、不进资产旁路、账本无联动字段）
        submission_id = "" if args.no_asset else graphstore.next_submission_id()
        started_at = time.time()
        ok = False
        try:
            if ref_paths:
                # 多张参考图一次请求提交（与 web 表单 images 字段等价）
                dest = (
                    generate_image(
                        prompt=args.prompt,
                        images=ref_paths,
                        size=size,
                        quality=args.quality,
                        model=args.model,
                        n=1,
                        output_format=output_format,
                        output_path=dest,
                    )
                    or dest
                )
            else:
                dest = (
                    generate_image(
                        prompt=args.prompt,
                        image_path=None,
                        size=size,
                        quality=args.quality,
                        model=args.model,
                        n=1,
                        output_format=output_format,
                        output_path=dest,
                    )
                    or dest
                )
            ok = True
            spent += unit_cost
            print_success(f"已保存: {dest}（{size}）· 费用 {unit_cost:.2f} 元")
        except Exception as e:
            failures.append(f"第 {index} 张：{api.format_error(e)}")
            print_error(failures[-1])

        # 旁路：注册资产 + 落提交快照（委托 graphstore 公共函数，与 server 同源；
        # --no-asset 或该张失败时跳过；任何失败不抛，不影响已完成的张）
        submission_meta: dict | None = None
        if ok and submission_id:
            try:
                params = {
                    "size": size,
                    "quality": args.quality,
                    "outputDir": output_dir,
                }
                submission_meta = graphstore.persist_submission_assets(
                    submission_id,
                    args.prompt,
                    params,
                    ref_paths,
                    [dest],
                    0,
                )
            except Exception:
                submission_meta = None

        # 只在确实落了提交快照时才记 submissionId（失败 / --no-asset / persist 抛错 都不记），
        # 避免账本里出现「指向不存在 submission_*.json 的孤儿 id」
        log_submission_id = submission_id if submission_meta is not None else ""
        log_generation(
            prompt=args.prompt,
            mode=mode,
            refs=len(ref_paths),
            size=size,
            quality=args.quality,
            status="ok" if ok else "error",
            output=dest if ok else "",
            cost=unit_cost if ok else 0.0,
            seconds=time.time() - started_at,
            win=None,
            submission_id=log_submission_id,
            input_asset_ids=(submission_meta or {}).get("input_asset_ids"),
            output_asset_ids=(submission_meta or {}).get("output_asset_ids"),
        )

    if len(paths) > 1:
        done = len(paths) - len(failures)
        print_info(f"完成 {done}/{len(paths)} 张 · 实际费用 {spent:.2f} 元")
    if failures:
        sys.exit(1)


def handle_config_command(args):
    """显示当前 profile 支持的全部参数值（从 config.json 实时读取）。

    用户在写 gen 命令前可运行 `python -m main config` 看当前可用的尺寸/比例/质量/默认值，
    避免传错值被 _validate_gen_args 拒绝。
    """
    from core.config import ACTIVE_PROFILE, BASE_URL

    console.print(
        f"[bold]当前 profile[/bold]: {ACTIVE_PROFILE}  ·  模型: {DEFAULT_MODEL}  ·  端点: {BASE_URL}"
    )
    console.print(
        f"[bold]默认尺寸[/bold]: {DEFAULT_SIZE}  ·  默认质量: {DEFAULT_QUALITY}  ·  默认档位: {DEFAULT_TIER}"
    )
    console.print(f"[bold]默认输出目录[/bold]: {DEFAULT_OUTPUT_DIR}")

    # 尺寸表（含费用）
    console.print("\n[bold]尺寸 SIZE_OPTIONS[/bold]（--size 取 value）")
    for opt in SIZE_OPTIONS:
        val = opt.get("value", "")
        label = opt.get("label", "")
        cost = opt.get("cost", 0.0)
        console.print(f"  {val:<14}  {label:<10}  费用 {cost:.2f} 元")

    # 比例 + 档位
    console.print("\n[bold]比例 RATIOS[/bold]（--ratio 取键，--tier 取档位）")
    for ratio, tiers in RATIOS.items():
        tier_str = "  ".join(f"{t}={dim}" for t, dim in tiers.items())
        console.print(f"  {ratio:<6}  {tier_str}")

    # 质量
    console.print("\n[bold]质量 QUALITY_OPTIONS[/bold]（--quality 取以下值）")
    for q in QUALITY_OPTIONS:
        if isinstance(q, dict):
            val = q.get("value", "")
            label = q.get("label", "")
        else:
            val = str(q)
            label = ""
        console.print(f"  {val:<10}  {label}")

    console.print(
        "\n[#6b7280]提示：gen 子命令所有参数值必须取自上表，否则报错退出。[/#6b7280]"
    )
    console.print(
        '[#6b7280]示例：python -m main gen "提示词" --size 1024x1024 --quality high -o out.png[/#6b7280]'
    )


def find_port_pid(port: int) -> int | None:
    """探测监听指定端口的进程 PID（服务状态的唯一真相源）。

    netstat 动态探测：不依赖临时 PID 文件，多开脚本 / 谁先谁后都不会失效。
    兼容双栈监听：IPv4/IPv6 可能各占一行且 PID 相同，取第一个即可。
    """
    pids = find_port_pids(port)
    return pids[0] if pids else None


def find_port_pids(port: int) -> list[int]:
    """探测监听指定端口的全部进程 PID（去重）。

    与 find_port_pid 的区别：Q 退出要「一次关闭全部」——同一端口可能因
    双栈监听（IPv4 + IPv6 两行）、多层包装（uv → python）、或历史残留
    出现多个不同 PID，逐个 taskkill /t 才能确保端口彻底释放。
    """
    import subprocess

    pids: list[int] = []
    try:
        # netstat 输出按控制台代码页（中文 Windows 为 GBK），只解析其中的 ASCII 行；
        # errors="replace" 让本地化表头（"活动连接"等）不会把整次探测打断
        out = subprocess.run(
            ["netstat", "-ano"],
            capture_output=True,
            text=True,
            check=False,
            errors="replace",
        ).stdout
        for line in out.splitlines():
            if f":{port}" in line and "LISTENING" in line.upper():
                parts = line.split()
                if parts:
                    pid = int(parts[-1])
                    if pid not in pids:
                        pids.append(pid)
    except (OSError, ValueError):
        pass
    return pids


# 单次祖先查询超时（秒）：powershell.exe 冷启动在 CI/负载高时可达数秒（实测 GitHub
# windows-latest 上 5 秒会超时——那会让祖先链只剩自身，Q 退出就杀不掉 uv/python 宿主）
_ANCESTOR_QUERY_TIMEOUT = 15


def _process_ancestors(pid: int) -> list[int]:
    """向上收集指定进程的完整祖先链（含自身），用于连根拔掉多层包装进程。

    典型场景：uv run python -m main ui 会产生 uv → python(shim) → python(监听) 多层，
    只杀监听层（taskkill /t 杀的是子进程树）会留下 uv/python 宿主残留。
    这里沿 ParentProcessId 逐级回溯到根，返回 [自身, 父, 祖父, ...]。
    逐级查询而非整表解析：使用 Windows 自带 PowerShell CIM，兼容已移除 WMIC 的新系统。

    超时留足余量（见 _ANCESTOR_QUERY_TIMEOUT）：查询失败即停止回溯，宁可少杀也不误杀。
    输出统一按 UTF-8 + errors="replace" 解码，避免非中文 locale 下解码异常吞掉结果。
    """
    import subprocess

    chain: list[int] = []
    seen: set[int] = set()
    cur = pid
    while cur and cur not in seen:
        seen.add(cur)
        chain.append(cur)
        try:
            command = (
                f"$p = Get-CimInstance Win32_Process -Filter 'ProcessId={cur}'; "
                "if ($p) { $p.ParentProcessId }"
            )
            out = subprocess.run(
                [
                    "powershell.exe",
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    command,
                ],
                capture_output=True,
                text=True,
                check=False,
                timeout=_ANCESTOR_QUERY_TIMEOUT,
                encoding="utf-8",
                errors="replace",
            ).stdout
        except (OSError, subprocess.TimeoutExpired):
            break
        parent = 0
        for line in out.splitlines():
            stripped = line.strip()
            if stripped.isdigit():
                parent = int(stripped)
                break
        cur = parent
    return chain


def stop_port_services(port: int) -> None:
    """停止监听指定端口的全部服务进程（一次关闭全部，连根拔）。

    找出端口上所有监听进程，并从每个监听 PID 向上收集完整祖先链
    （uv → python shim → python 监听），全部 taskkill /t——既杀监听层，
    也杀掉它的 uv/python 宿主，避免「端口释放了但进程残留」。
    """
    import subprocess

    pids = find_port_pids(port)
    if not pids:
        print_info("服务未在运行，无需停止")
        return
    # 收集所有监听 PID 的完整祖先链（去重），从根开始杀，保证整棵进程树覆灭
    kill_set: list[int] = []
    seen: set[int] = set()
    for pid in pids:
        for ancestor in _process_ancestors(pid):
            if ancestor not in seen:
                seen.add(ancestor)
                kill_set.append(ancestor)
    # 先杀最顶层祖先（uv），其 taskkill /t 会连带杀掉整棵子树
    for pid in kill_set:
        subprocess.run(
            ["taskkill", "/pid", str(pid), "/f", "/t"], capture_output=True, check=False
        )
    print_success(f"服务已全部停止（PID {', '.join(str(p) for p in pids)}）")


def handle_menu_command(args):
    """交互菜单（rich 渲染）：N 开新窗口 / Q 退出并停止服务。

    由「启动生图工作台.cmd」调用：服务后台启动后就进入本菜单。
    - 服务状态实时探测：PID 用 netstat 找端口监听者，窗口数用 /api/status，
      不再依赖会被多开脚本互相覆盖的 PID 文件；
    - 关闭就关全部：无论按 Q 退出、Ctrl+C、还是直接点窗口右上角 X 关闭，
      都会停掉端口上的全部服务进程（双栈 / 多层 / 残留），所有窗口同时失效。
    """
    import time
    import webbrowser

    import requests
    from rich.panel import Panel
    from rich.prompt import Prompt
    from rich.table import Table

    url = f"http://127.0.0.1:{args.port}"

    # 兜底：Ctrl+C / 点 X 关窗口（控制台关闭事件）时也停掉全部服务。
    # Q 分支走主循环退出；这里的处理器覆盖「没走主循环就被终止」的路径，
    # 保证两种关闭方式都做到「一起关」。
    closed_by_handler = {"flag": False}
    handler_ref: dict[str, object] = {"fn": None}

    def _on_console_event(event_type: int) -> bool:
        # Windows 控制台事件：2=Ctrl+C / 5=CTRL_CLOSE_EVENT（点 X）/ 6=CTRL_LOGOFF_EVENT / 7=CTRL_SHUTDOWN_EVENT
        if event_type in (0, 2, 5, 6, 7) and not closed_by_handler["flag"]:
            closed_by_handler["flag"] = True
            try:
                stop_port_services(args.port)
            finally:
                if handler_ref["fn"] is not None:
                    try:
                        import ctypes

                        ctypes.windll.kernel32.SetConsoleCtrlHandler(
                            handler_ref["fn"], False
                        )
                    except Exception:
                        pass  # 进程即将退出，卸载 handler 失败无害
        return False

    if sys.platform == "win32":
        try:
            import ctypes
            from ctypes import WINFUNCTYPE, c_bool, c_uint

            _HandlerRoutine = WINFUNCTYPE(c_bool, c_uint)
            fn = _HandlerRoutine(_on_console_event)
            handler_ref["fn"] = fn
            # 注册控制台事件处理器：返回非零表示「已处理」；这里返回 False 交给默认处理
            ctypes.windll.kernel32.SetConsoleCtrlHandler(fn, True)
        except Exception:
            handler_ref["fn"] = None

    def fetch_window_count() -> int:
        try:
            resp = requests.get(f"{url}/api/status", timeout=5)
            return int(resp.json().get("windowCounter", 0))
        except Exception:
            return 0

    def render_status_panel() -> Panel:
        pid = find_port_pid(args.port)
        win_count = fetch_window_count()
        running = pid is not None
        # 边框颜色随窗口主体色（accent.ts 同算法）：不同窗口号不同色相
        accent = accent_for_window(win_count)
        table = Table(show_header=False, box=None, padding=(0, 2))
        table.add_column(style="bold", justify="right", width=10)
        table.add_column(style="white")
        table.add_row("服务地址", f"[bold {accent}]{url}[/bold {accent}]")
        table.add_row(
            "服务进程", f"PID {pid}" if running else "[#d97706]未运行[/#d97706]"
        )
        table.add_row("已开窗口", f"编号已分配至 #{win_count}" if win_count else "暂无")
        return Panel(
            table,
            title=f"[bold {accent}]Imagora · AI 生图工作台[/bold {accent}]",
            border_style=accent if running else "#d97706",
            subtitle="[#6b7280]操作：[/#6b7280][bold]N[/bold] 打开新窗口   [bold]Q[/bold] 退出并停止服务",
            padding=(1, 2),
        )

    try:
        while True:
            console.print(render_status_panel())
            choice = Prompt.ask(
                "[bold]选择操作[/bold]（[bold]N[/bold] 打开新窗口 / [bold]Q[/bold] 退出并停止服务）",
                choices=["N", "Q"],
                default="N",
            )
            if choice == "Q":
                break
            try:
                resp = requests.get(f"{url}/api/window/next", timeout=5)
                win = resp.json()["windowId"]
                webbrowser.open(f"{url}/?win={win}")
                # "已打开窗口 #N" 用该窗口主体色（与 accent.ts / cmd 首窗同算法），[OK] 标签保持绿色
                win_accent = accent_for_window(win)
                console.print(
                    f"[bold green][OK][/bold green] [bold {win_accent}]已打开窗口 #{win}[/bold {win_accent}]"
                )
            except Exception as e:
                print_error(f"开新窗口失败: {e}")
                time.sleep(2)
    finally:
        # 无论按 Q 退出、Ctrl+C、点 X 关窗口（控制台关闭事件）、还是异常终止，
        # 都统一停掉端口上的全部服务进程（一次关闭全部）。
        if not closed_by_handler["flag"]:
            closed_by_handler["flag"] = True
            try:
                stop_port_services(args.port)
            finally:
                # 释放控制台事件处理器，避免重复注册
                if handler_ref["fn"] is not None:
                    try:
                        import ctypes

                        ctypes.windll.kernel32.SetConsoleCtrlHandler(
                            handler_ref["fn"], False
                        )
                    except Exception:
                        pass  # 进程即将退出，卸载 handler 失败无害


def build_argument_parser():
    """构建命令行参数解析器"""
    parser = argparse.ArgumentParser(description="Imagora · AI 生图工作台")
    subparsers = parser.add_subparsers(dest="command", required=True)

    sub_ui = subparsers.add_parser("ui", help="启动网页界面")
    sub_ui.add_argument("--port", type=int, default=7860, help="监听端口（默认 7860）")
    sub_ui.add_argument(
        "--no-browser",
        action="store_true",
        help="不自动打开浏览器（由外部脚本控制开窗）",
    )
    sub_ui.set_defaults(handler=handle_ui_command)

    sub_menu = subparsers.add_parser(
        "menu", help="交互菜单（启动脚本用）：N 开新窗口 / Q 退出"
    )
    sub_menu.add_argument(
        "--port", type=int, default=7860, help="监听端口（默认 7860）"
    )
    sub_menu.set_defaults(handler=handle_menu_command)

    sub_batch = subparsers.add_parser("batch", help="批量生图")
    sub_batch.add_argument(
        "--config", help="项目配置文件 batch_prompts.json 路径（默认找当前目录）"
    )
    sub_batch.add_argument("--only", help="只跑指定模块号，逗号分隔，如 2,4")
    sub_batch.add_argument(
        "--dry-run", action="store_true", help="只预览配置与成本，不调用 API"
    )
    sub_batch.set_defaults(handler=handle_batch_command)

    sub_gen = subparsers.add_parser(
        "gen",
        help="单张生图（与 web 表单完全对等：尺寸/质量/参考图/输出路径无损透传，"
        "成功后注册资产 + 落提交快照 + 写全量账本）",
    )
    sub_gen.add_argument("prompt", help="提示词（英文优先）")
    sub_gen.add_argument(
        "-i",
        "--image",
        action="append",
        default=None,
        help="参考图路径，可多次传 -i 实现多张参考图（传了=图生图）",
    )
    sub_gen.add_argument(
        "-o",
        "--output",
        default=None,
        help="输出路径（必填）：文件路径直接用，目录则自动生成文件名",
    )
    sub_gen.add_argument(
        "--size",
        default=None,
        help="分辨率（与 --ratio 二选一必填，取值见 `python -m main config`）",
    )
    sub_gen.add_argument(
        "--ratio",
        default=None,
        help="宽高比（与 --size 二选一必填，取值见 `python -m main config`）",
    )
    sub_gen.add_argument(
        "--tier",
        default=DEFAULT_TIER,
        choices=["1K", "2K", "4K"],
        help="配合 --ratio 的档位，默认 2K",
    )
    sub_gen.add_argument(
        "--quality", default=None, help="质量（必填，取值见 `python -m main config`）"
    )
    sub_gen.add_argument(
        "--model", default=DEFAULT_MODEL, help="模型名，默认取当前 profile"
    )
    sub_gen.add_argument(
        "--n",
        type=int,
        default=1,
        help="生成张数（逐张请求，每张独立落盘与记账），默认 1",
    )
    sub_gen.add_argument(
        "--format",
        default="png",
        choices=["png", "jpg", "webp"],
        help="输出格式，默认 png",
    )
    sub_gen.add_argument(
        "--no-asset",
        action="store_true",
        help="跳过资产注册 + 提交快照（纯生成模式，不进画布/账本无 asset_ids）",
    )
    sub_gen.set_defaults(handler=handle_gen_command)

    sub_config = subparsers.add_parser(
        "config", help="显示当前 profile 支持的尺寸/比例/质量/默认值"
    )
    sub_config.set_defaults(handler=handle_config_command)

    return parser


def main():
    parser = build_argument_parser()
    args = parser.parse_args()
    args.handler(args)


if __name__ == "__main__":
    main()

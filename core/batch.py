#!/usr/bin/env python3
"""批量生图编排 —— 读项目目录下的 batch_prompts.json 逐张调用

路径基准 = 配置文件所在目录（清单里的相对路径——参考图、输出目录——都从这里解析）。
CLI 入口在 main.py（python main.py batch --config <项目>/batch_prompts.json）。
输出用 rich 统一美化：任务预览表格、逐张进度条、完成总结面板。
"""

import json
import os
import time
from pathlib import Path

from rich.progress import (
    BarColumn,
    Progress,
    SpinnerColumn,
    TextColumn,
    TimeElapsedColumn,
)
from rich.table import Table

import core.config as global_config
from core.api import format_error, generate_image
from core.config import DEFAULT_QUALITY
from core.console import console, print_dim, print_panel
from core.logging import log_generation


def load_batch_config(config_path):
    """读取批量配置文件（JSON）"""
    with open(config_path, encoding="utf-8") as f:
        return json.load(f)


def resolve_base_image_paths(config_dir, base_images):
    """把配置里的相对路径解析为绝对路径，基准 = 配置文件所在目录"""
    resolved = {}
    for key, path in (base_images or {}).items():
        resolved[key] = str(config_dir / path) if not os.path.isabs(path) else path
    return resolved


def filter_jobs_by_module(jobs, module_filter):
    """按模块号过滤任务（如 "2,5" -> 模块 2 和 5）"""
    if not module_filter:
        return jobs
    wanted = set(module_filter.split(","))
    return [j for j in jobs if j["module"].split("_")[0] in wanted]


def _print_job_preview(jobs, base_images, size, tier_cost):
    """任务预览：表格列出每张任务 + 底部汇总成本"""
    table = Table(title=f"批量任务 · {len(jobs)} 张", show_lines=False)
    table.add_column("ID", style="dim")
    table.add_column("任务", style="cyan")
    table.add_column("底图", style="dim")
    for job in jobs:
        img = job["image"]
        image_desc = base_images.get(img, img) if img else "文生图"
        table.add_row(job["id"], f"{job['module']}/{job['name']}", image_desc)
    console.print(table)
    print_dim(
        f"档位 {size} · 单张 {tier_cost} 元 · 预估总成本 {len(jobs) * tier_cost:.2f} 元"
    )


def run_batch_generation(config_path, module_filter=None, dry_run=False):
    """执行批量生图。dry_run 只预览配置与成本，不调用 API。返回失败 id 列表。

    Args:
        config_path: 项目目录下的 batch_prompts.json 路径
        module_filter: 只跑指定模块号（逗号分隔），None = 全部
        dry_run: True 时只预览，不调用 API
    """
    config_path = Path(config_path)
    config_dir = config_path.parent
    config = load_batch_config(config_path)
    jobs = filter_jobs_by_module(config["jobs"], module_filter)
    base_images = resolve_base_image_paths(config_dir, config.get("base_images", {}))

    tier_cost = config.get("tier_cost") or global_config.cost_for_size(config["size"])
    _print_job_preview(jobs, base_images, config["size"], tier_cost)

    if dry_run:
        console.print("[yellow][DRY-RUN] 未调用 API[/yellow]")
        return []

    output_root = str(config_dir / config["out_dir"])
    failed = []
    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TextColumn("[progress.percentage]{task.percentage:>3.0f}%"),
        TimeElapsedColumn(),
    ) as progress:
        task = progress.add_task("批量生成", total=len(jobs))
        for job in jobs:
            image_path = base_images.get(job["image"]) if job["image"] else None
            module_dir = os.path.join(output_root, job["module"])
            os.makedirs(module_dir, exist_ok=True)
            output_path = os.path.join(module_dir, f"{job['id']}_{job['name']}.png")

            progress.update(task, description=f"生成中 [{job['id']}] {job['name']}")
            job_started_at = time.time()
            try:
                output_path = (
                    generate_image(
                        prompt=job["prompt"],
                        image_path=image_path,
                        size=config["size"],
                        quality=DEFAULT_QUALITY,
                        output_format="png",
                        output_path=output_path,
                    )
                    or output_path
                )
                job_ok = True
                progress.console.print(
                    f"[green]完成 [{job['id']}] {job['name']}[/green]"
                )
            except Exception as e:
                job_ok = False
                failed.append(job["id"])
                progress.console.print(
                    f"[red]失败 [{job['id']}] {job['name']}: {format_error(e, 120)}[/red]"
                )
            log_generation(
                prompt=job["prompt"],
                mode="img2img" if image_path else "txt2img",
                refs=1 if image_path else 0,
                size=config["size"],
                quality=DEFAULT_QUALITY,
                status="ok" if job_ok else "error",
                output=output_path if job_ok else "",
                cost=(
                    config.get("tier_cost")
                    or global_config.cost_for_size(config["size"])
                )
                if job_ok
                else 0.0,
                seconds=time.time() - job_started_at,
            )
            progress.advance(task)
            time.sleep(5)  # 防限流

    # 完成总结：失败红色 + 可重跑清单，全部成功绿色 + 输出目录
    ok_count = len(jobs) - len(failed)
    if failed:
        print_panel(
            f"完成 · 成功 {ok_count}/{len(jobs)} 张 · 失败 {len(failed)} 张\n"
            f"失败清单（可重跑）: {', '.join(failed)}",
            title="批量结束",
            style="red",
        )
    else:
        print_panel(
            f"完成 · {len(jobs)} 张全部成功\n输出目录: {output_root}",
            title="批量完成",
            style="green",
        )
    return failed

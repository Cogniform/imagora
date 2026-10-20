#!/usr/bin/env python3
"""FastAPI 后端 —— API 路由 + 托管前端构建产物

启动: uv run python -m main ui（http://127.0.0.1:7860）

API:
  GET  /api/config                    初始化配置（尺寸/质量/默认输出路径/窗口号）
  GET  /api/health/details            启动自检（Key / 前端构建 / 输出可写）
  GET  /api/window/next               分配下一个窗口编号
  GET  /api/history                   生成历史（limit/query/status 筛选）
  POST /api/history/import            历史结果导入画布
  POST /api/upload-ref                参考图落盘 output/.refs/
  POST /api/delete-ref                删除已落盘参考图
  POST /api/output-dir                记住输出路径（重启沿用）
  POST /api/generate                  文生图 / 图生图（multipart）
  POST /api/select-folder             弹出系统文件夹选择器
  POST /api/open-folder               资源管理器打开文件夹（置前）
  GET  /api/image?path=               读取图片文件
  POST /api/canvas/upload             画布图片上传（复制进 output/.assets/）
  POST /api/canvas/import             输出目录导入画布（目录递归/单文件）
  GET  /api/canvas/images             画布图片全量
  POST /api/canvas/image/delete       删除画布图片
  POST /api/canvas/workflow/save      保存工作流 JSON（output/workflows/）
  GET  /api/canvas/workflow/list      列出所有工作流
  GET  /api/canvas/workflow/load      按名加载工作流
  POST /api/canvas/recovery/save      创建恢复快照
  GET  /api/canvas/recovery/latest    读取最近恢复快照
"""

import ctypes
import itertools
import json
import mimetypes
import os
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware

from core import canvas, config, cost, graphstore, history
from core.api import format_error, generate_image
from core.canvas import safe_ref_path_allowlist
from core.config import (
    ACTIVE_PROFILE,
    API_PATHS,
    BASE_URL,
    DEFAULT_MODEL,
    DEFAULT_OUTPUT_DIR,
    DEFAULT_QUALITY,
    DEFAULT_SIZE,
    MODELS,
    PROFILE_LABEL,
    QUALITY_OPTIONS,
    SIZE_OPTIONS,
    get_api_key,
)
from core.history import (
    read_generation_history,
    read_generation_history_paged,
    read_raw_history,
)
from core.logging import log_generation
from core.tasks import MAX_CONCURRENCY, GenerationTask, TaskManager

# 多开窗口：服务端原子分配递增编号（GIL 保证并发安全）
_WIN_LOCK = threading.Lock()
_WIN_VALUE = 0
# 生成文件名全局序号：秒级时间戳同秒并发必撞，加序号保证唯一
_SEQ = itertools.count(1)
# 参考图缓存：前端「添加即上传」落盘于此，跨窗口只传路径引用（不占浏览器存储配额）
REF_DIR = os.path.join(DEFAULT_OUTPUT_DIR, ".refs")


def _next_window_id() -> int:
    """分配下一个窗口编号（全局唯一，线程安全）"""
    global _WIN_VALUE
    with _WIN_LOCK:
        _WIN_VALUE += 1
        return _WIN_VALUE


def current_window_id() -> int:
    """当前已分配的最大窗口编号（只读，供状态展示）"""
    return _WIN_VALUE


# 参考图文件名全局序号
_REF_SEQ = itertools.count(1)
# 参考图孤儿文件最长保留时长（前端删除失败 / 上传未用的情况兜底清理）
REF_MAX_AGE_SECONDS = 24 * 3600
# 上次输出路径记录：服务重启后默认沿用（无记录才按窗口分区）
LAST_OUTPUT_DIR_FILE = os.path.join(DEFAULT_OUTPUT_DIR, ".last_output_dir")
# 串行化有界面副作用的系统调用（tkinter 选择器、explorer 置前）
_UI_LOCK = threading.Lock()


def load_last_output_dir() -> str | None:
    """读取上次使用的输出路径（跨服务重启记住）；无记录 / 读取失败返回 None。

    自愈：路径存在但目录已不存在（被删除 / 测试临时目录残留 / 移动磁盘）时
    视为无效记录返回 None，让调用方回退默认目录，避免生成写到死路径直接失败。
    """
    try:
        with open(LAST_OUTPUT_DIR_FILE, encoding="utf-8") as f:
            path = f.read().strip()
            if not path:
                return None
            # 目录不存在 → 记录已失效，不沿用（否则生成必然 404/写文件失败）
            if not os.path.isdir(path):
                return None
            return path
    except OSError:
        return None


def save_last_output_dir(path: str) -> None:
    """记录上次使用的输出路径（下次启动默认沿用）；记录失败不影响生成"""
    try:
        os.makedirs(os.path.dirname(LAST_OUTPUT_DIR_FILE), exist_ok=True)
        with open(LAST_OUTPUT_DIR_FILE, "w", encoding="utf-8") as f:
            f.write(path)
    except OSError:
        pass


def safe_ref_path(path: str) -> str | None:
    """仅接受 REF_DIR 内的绝对路径（防路径穿越）；非法返回 None（委托 pathtrust 统一实现）"""
    from core.pathtrust import match_roots

    return match_roots(path, [REF_DIR])


def cleanup_stale_refs(max_age_seconds: int = REF_MAX_AGE_SECONDS) -> None:
    """清理 REF_DIR 中超时的孤儿参考图（服务启动时调用一次）"""
    if not os.path.isdir(REF_DIR):
        return
    now = time.time()
    for name in os.listdir(REF_DIR):
        p = os.path.join(REF_DIR, name)
        try:
            if now - os.path.getmtime(p) > max_age_seconds:
                os.unlink(p)
        except OSError:
            pass


class NoCacheMiddleware(BaseHTTPMiddleware):
    """静态资源禁用缓存：本地迭代频繁，保证页面总是最新"""

    async def dispatch(self, request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-cache"
        return response


BASE_DIR = (
    Path(sys.executable).resolve().parent.parent
    if getattr(sys, "frozen", False)
    else Path(__file__).resolve().parent
)
FRONTEND_DIR = BASE_DIR / "frontend"
DIST_DIR = FRONTEND_DIR / "dist"

# 尺寸/质量选项来自配置中心（core/config.py），/api/config 原样下发前端

app = FastAPI(title="Imagora")
app.add_middleware(NoCacheMiddleware)

# 启动时清理超时的孤儿参考图（前端删除失败 / 上传未用的情况兜底）
cleanup_stale_refs()


def has_api_key() -> bool:
    """API Key 是否已配置（用于界面提示）"""
    try:
        get_api_key()
        return True
    except RuntimeError:
        return False


def _form_string(value: object, fallback: str = "") -> str:
    """Normalize FastAPI Form defaults when the endpoint is called directly in tests."""
    return value if isinstance(value, str) else fallback


def _directory_writable(path: str) -> bool:
    probe = ""
    try:
        os.makedirs(path, exist_ok=True)
        fd, probe = tempfile.mkstemp(prefix=".imagora_probe_", dir=path)
        os.close(fd)
        return True
    except OSError:
        return False
    finally:
        # 清理探测文件失败不应让整个探测失败：某些托管/沙箱环境会拦截 unlink
        # （抛 SystemExit 等 BaseException），此处一律吞掉，只影响哨兵文件残留。
        if probe:
            try:
                os.unlink(probe)
            except BaseException:
                pass


def resolve_history_output_path(output: str) -> str:
    """把日志里的输出路径解析为绝对路径（委托 core.history 统一实现，避免逻辑分叉）。"""
    return history.resolve_output_path(output)


def resolve_history_asset_path(record: dict, entries: dict | None = None) -> str:
    """历史行的真实图片路径（展示与导入共用同一判定，防两端漂移）。

    优先资产注册表：账本带 outputAssetIds 时按 resolve_asset 解析（.assets 注册表副本，
    原 output 文件被移动/删除不丢）；无注册表副本才回退 output 路径（须真实存在）。
    entries 为已预载的注册表（批量解析一次读盘，见 /api/history）。
    """
    asset_ids = record.get("outputAssetIds")
    if isinstance(asset_ids, list) and asset_ids:
        resolved = canvas.resolve_asset(str(asset_ids[0]), entries=entries)
        if resolved:
            return resolved["absPath"]
    out_path = resolve_history_output_path(str(record.get("output", "")))
    if out_path and os.path.isfile(out_path):
        return out_path
    return ""


@app.get("/api/health/details")
def health_details():
    """启动自检：只返回布尔状态和处理建议，不泄漏配置值。"""
    checks = {
        "apiKey": has_api_key(),
        "frontendBuilt": (DIST_DIR / "index.html").is_file(),
        "outputWritable": _directory_writable(
            load_last_output_dir() or DEFAULT_OUTPUT_DIR
        ),
    }
    issues = []
    if not checks["apiKey"]:
        issues.append("未配置 API Key，生图任务暂不可用")
    if not checks["frontendBuilt"]:
        issues.append("前端尚未构建，请运行 npm run build")
    if not checks["outputWritable"]:
        issues.append("输出目录不可写，请检查目录权限")
    return {"ok": all(checks.values()), "checks": checks, "issues": issues}


@app.get("/api/config")
def get_config(win: int | None = None):
    """前端初始化配置。

    多开页面：前端传已有窗口号（URL ?win= 或 window.name 记忆）则沿用，
    否则服务端原子分配下一个编号；默认输出目录按窗口分区 output/win{N}。
    """
    window_id = win if win and win > 0 else _next_window_id()
    # 默认输出路径：优先记住的上次路径（服务重启沿用），无记录才按窗口分区
    last_dir = load_last_output_dir()
    default_dir = last_dir or os.path.join(DEFAULT_OUTPUT_DIR, f"win{window_id}")
    return {
        "sizes": SIZE_OPTIONS,
        "qualities": QUALITY_OPTIONS,
        "defaultOutputDir": default_dir,
        "windowId": window_id,
        "baseUrl": BASE_URL,
        "apiPath": API_PATHS.get("generations", ""),
        "defaultModel": DEFAULT_MODEL,
        "activeProfile": ACTIVE_PROFILE,
        # 当前 profile 的可选模型清单（每个带自己的尺寸/价格）；空则前端回退单模型。
        "models": MODELS,
        "profileLabel": PROFILE_LABEL,
        # 全部来源（profile）目录：前端按「使用中的接口地址」换尺寸/单价表 ——
        # 个人配置切了中转站，尺寸下拉不能继续沿用 default_profile 那张价目表。
        "providers": config.provider_catalog(),
        # 配置来源视图：前端据此呈现「该值来自 config.json / .env / 内置默认」。
        # profile 增字段时前端自动多一行，无需逐处适配（唯一真相源 = core/config.py）。
        "profileView": config.describe_config(),
    }


@app.get("/api/window/next")
def next_window():
    """分配下一个窗口编号（多开脚本 / 界面按钮用，与 /api/config 共用计数器，全局唯一）"""
    return {"windowId": _next_window_id()}


@app.get("/api/status")
def server_status():
    """只读服务状态：已分配的最大窗口编号（供启动脚本 / 控制台菜单展示）"""
    return {"windowCounter": current_window_id()}


@app.get("/api/history")
def generation_history(
    limit: int = 60, offset: int = 0, query: str = "", status: str = ""
):
    """读取本地生成历史（分页，滚动加载）。

    分页语义：offset 是**聚合后**记录的偏移（同参数只算一条），前端按已加载条数推进
    offset 即可；hasMore = 当前页没取完聚合结果。搜索/状态筛选在聚合前过滤，分页与
    筛选天然一致。
    图片存在性以**资产注册表为准**：账本行带 outputAssetIds 时，按 registry.resolve_asset
    解析（注册表副本在 .assets，移动原文件不丢），仅作参考的 output 路径不再参与判定；
    无 outputAssetIds 的旧行回退按 output 路径 isfile 判定。
    参考图同源：inputAssetIds 按 resolve_asset 解析成 inputRefs（{id,path,url}）；
    img2img 且 refs>0 但解析为空时置 inputRefMissing（参考图记录存在但图片找不回）。
    同参数记录已在读取层聚合（时间不算参数）：同一提示词卡片多次失败只显示最新一条。
    """
    page = read_generation_history_paged(
        offset=offset, limit=limit, query=query, status=status
    )
    records = page["items"]
    # 注册表一次读入复用：历史逐行 resolve_asset 每条都读盘会是卡顿主要来源
    entries = canvas.load_registry()
    items = []
    for record in records:
        abs_path = resolve_history_asset_path(record, entries=entries)
        exists = bool(abs_path and os.path.isfile(abs_path))
        # 参考图按注册表解析：inputAssetIds -> resolve_asset（.assets 永久副本），
        # 解析失败 / 文件缺失的 id 跳过；前端据此区分「有参考图但找不回」与「纯文生图」。
        input_refs: list[dict] = []
        raw_ids = record.get("inputAssetIds")
        if isinstance(raw_ids, list):
            for aid in raw_ids:
                resolved = canvas.resolve_asset(str(aid), entries=entries)
                if resolved and os.path.isfile(resolved["absPath"]):
                    input_refs.append(
                        {
                            "id": str(aid),
                            "path": resolved["absPath"],
                            "url": resolved["url"],
                        }
                    )
        input_ref_missing = (
            record.get("mode") == "img2img"
            and int(record.get("refs") or 0) > 0
            and not input_refs
        )
        items.append(
            {
                **record,
                "exists": exists,
                "path": abs_path if exists else "",
                "url": canvas.image_url(abs_path) if exists else "",
                "inputRefs": input_refs,
                "inputRefMissing": input_ref_missing,
            }
        )
    return {"items": items, "hasMore": offset + len(page["items"]) < page["total"]}


@app.get("/api/history/stats")
def history_stats(days: int = cost.DEFAULT_DAYS):
    """成本看板数据：账本**原始行**聚合（不去重、不截断）+ 今日预算占用。

    与 /api/history 口径不同：那边面向列表展示（同参数聚合、最多 500 原始行），
    这里面向计费——每个成功行都真实花过钱，聚合会少算费用。
    """
    stats = cost.summarize_records(read_raw_history(), days=days)
    budget = cost.load_budget()
    spent_today = stats["todayCost"]
    return {
        **stats,
        "budget": {
            **budget,
            "spentToday": spent_today,
            "remaining": (
                round(max(0.0, budget["dailyLimit"] - spent_today), 2)
                if budget["dailyLimit"] > 0
                else 0.0
            ),
        },
    }


@app.get("/api/budget")
def get_budget():
    """读取本机预算设置（output/.budget.json，git 忽略；0 = 不限）"""
    budget = cost.load_budget()
    spent_today = cost.today_spent(read_raw_history())
    return {
        **budget,
        "spentToday": spent_today,
        "remaining": (
            round(max(0.0, budget["dailyLimit"] - spent_today), 2)
            if budget["dailyLimit"] > 0
            else 0.0
        ),
    }


@app.post("/api/budget")
def set_budget(body: dict):
    """保存本机预算设置：dailyLimit（当日累计上限）/ singleRunLimit（单次上限），0 = 不限"""
    return {"ok": True, **cost.save_budget(body)}


def _budget_guard(estimate: float, confirmed: bool) -> dict:
    """提交前的预算闸门：超限且未确认 → 抛 409（结构化 detail 供前端弹确认）。

    先算「今日已花」（读账本原始行）再校验：日预算比较的是「已花 + 本次预估」。
    """
    spent_today = cost.today_spent(read_raw_history())
    result = cost.check_budget(
        estimate, cost.load_budget(), spent_today, confirmed=confirmed
    )
    if not result["allowed"]:
        raise HTTPException(
            status_code=409,
            detail={
                "reason": result["reason"],
                "estimate": result["estimate"],
                "spentToday": result["spentToday"],
                "settings": result["settings"],
            },
        )
    return result


@app.post("/api/budget/check")
def check_budget_route(body: dict):
    """提交前预检（无副作用）：按本次张数与尺寸估算费用，判断是否超预算。

    body: {items: [{size}]} 或 {count: int, size: str}；返回 estimate / over / reason，
    前端据此决定是否弹「超预算确认」。
    """
    items = body.get("items")
    if isinstance(items, list):
        estimate = round(
            sum(
                cost.estimate_cost(1, str(i.get("size") or ""))
                for i in items
                if isinstance(i, dict)
            ),
            2,
        )
    else:
        estimate = cost.estimate_cost(
            int(body.get("count") or 0), str(body.get("size") or "")
        )
    spent_today = cost.today_spent(read_raw_history())
    return {
        **cost.check_budget(estimate, cost.load_budget(), spent_today, confirmed=False),
        "todayCost": spent_today,
    }


@app.post("/api/history/import")
def import_history_asset(body: dict):
    """把日志中真实存在的历史结果导入画布，拒绝任意未记录路径。

    可导入白名单与 /api/history 展示同源，并覆盖账本行的两个合法派生路径：
      - 注册表副本路径：`resolve_history_asset_path` 优先（原 output 文件被移动/删除仍可导入，
        历史面板「导入画布」传的就是它）；
      - 账本 output 原路径：画布结果回流传的是任务结果 URL 的 path（run_generation 落盘路径，
        见 6.5），仅当文件仍存在才放行。
    白名单仍只来自账本记录，任意未记录路径拒绝（不能退化成任意路径读取接口）。
    """
    requested = os.path.normcase(resolve_history_output_path(str(body.get("path", ""))))
    recorded_paths: set[str] = set()
    for record in read_generation_history(limit=500):
        resolved = resolve_history_asset_path(record)
        if resolved:
            recorded_paths.add(os.path.normcase(resolved))
        raw = resolve_history_output_path(str(record.get("output", "")))
        if raw and os.path.isfile(raw):
            recorded_paths.add(os.path.normcase(raw))
    if requested not in recorded_paths or not os.path.isfile(requested):
        return {
            "imported": [],
            "skipped": [{"path": requested, "reason": "不是可用的历史输出"}],
        }
    entry = canvas.register_asset(requested, os.path.basename(requested))
    return {
        "imported": [entry] if entry else [],
        "skipped": [] if entry else [{"path": requested, "reason": "导入失败"}],
    }


@app.post("/api/upload-ref")
def upload_ref(images: list[UploadFile] = File(default=[])):
    """参考图落盘 output/.refs/，返回元信息供前端渲染与跨窗口继承。

    前端「添加进上传区时」即调用：大图不走 sessionStorage（5MB 配额），
    继承/生成只引用返回的 path，一次上传多处复用。
    """
    os.makedirs(REF_DIR, exist_ok=True)
    refs = []
    for image in images:
        data = image.file.read()
        ext = (Path(image.filename or "img").suffix or ".png").lower()
        name = f"ref_{int(time.time())}_{next(_REF_SEQ):04d}{ext}"
        dest = os.path.join(REF_DIR, name)
        with open(dest, "wb") as f:
            f.write(data)
        refs.append(
            {
                "id": name,
                "path": dest,
                "url": canvas.image_url(dest),
                "name": image.filename or name,
                "size": len(data),
                "ext": ext.lstrip("."),
                "mime": image.content_type or "application/octet-stream",
            }
        )
    return {"refs": refs}


@app.post("/api/delete-ref")
def delete_ref(path: str = Body(..., embed=True)):
    """删除已落盘参考图（尽力而为，文件不存在也算成功）"""
    abs_path = safe_ref_path(path)
    if abs_path:
        try:
            os.unlink(abs_path)
        except OSError:
            pass
    return {"ok": True}


@app.post("/api/output-dir")
def remember_output_dir(path: str = Body(..., embed=True)):
    """记住输出路径：用户一改路径前端即上报，服务重启后 /api/config 默认返回它"""
    save_last_output_dir(str(path))
    return {"ok": True}


@app.post("/api/canvas/upload")
def canvas_upload(images: list[UploadFile] = File(default=[])):
    """画布图片上传：复制进 output/.assets/ 并登记 registry（同内容去重）"""
    entries = []
    for image in images:
        ext = (Path(image.filename or "img").suffix or ".png").lower()
        with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
            tmp.write(image.file.read())
            tmp_path = tmp.name
        try:
            entry = canvas.register_asset(tmp_path, image.filename or "image")
            if entry:
                entries.append(entry)
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
    return {"images": entries}


@app.post("/api/canvas/import")
def canvas_import(body: dict):
    """从输出目录导入图片（目录递归 / 单文件）到画布：复制进 .assets 并登记

    路径必须落在 output 根内（realpath 前缀校验防穿越）；校验失败逐条进 skipped。
    """
    paths = [str(p) for p in body.get("paths", [])]
    return canvas.import_assets(paths)


@app.get("/api/canvas/images")
def canvas_images():
    """画布图片全量（每条含 absPath，生成时 ref_paths 引用）"""
    return {"images": canvas.list_assets()}


@app.post("/api/canvas/image/delete")
def canvas_image_delete(body: dict):
    """删除画布图片（注册表移除 + 尽力删文件；文件不存在容忍）"""
    img_id = str(body.get("id", ""))
    return {"ok": canvas.delete_asset(img_id)}


@app.post("/api/canvas/workflow/save")
def canvas_workflow_save(body: dict):
    """保存工作流为 JSON 文件（固定目录 output/workflows/<name>.json，仅需名字）

    图片节点落盘前归一化：只存 registryId + 元数据，不存派生路径 url/absPath
    （加载时按 registry 实时解析，项目目录改名后旧存档依然可恢复）。"""
    result = canvas.workflow_save(
        str(body.get("name", "")),
        body.get("nodes", []),
        body.get("edges", []),
    )
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("error", "保存失败"))
    return {"ok": True, "path": result["path"]}


@app.get("/api/canvas/workflow/list")
def canvas_workflow_list():
    """列出 output/workflows/ 下所有工作流（按修改时间倒序）"""
    return {"workflows": canvas.workflow_list()}


@app.get("/api/canvas/workflow/load")
def canvas_workflow_load(name: str):
    """加载工作流 JSON（固定目录按名加载）：按 registryId 实时解析图片节点路径
    （不信任存档中的旧绝对路径，项目目录改名后自愈）；缺失 registryId 进 missing"""
    result = canvas.workflow_load(name)
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("error", "加载失败"))
    return {
        "name": result["name"],
        "nodes": result["nodes"],
        "edges": result["edges"],
        "missing": result["missing"],
    }


@app.post("/api/canvas/recovery/save")
def canvas_recovery_save(body: dict):
    """创建一份独立恢复快照，不覆盖手动命名工作流（图片节点同样归一化落盘）。"""
    result = canvas.recovery_save(body.get("nodes", []), body.get("edges", []))
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("error", "自动保存失败"))
    return result


@app.get("/api/canvas/recovery/latest")
def canvas_recovery_latest():
    """返回最近一份可读恢复快照；没有快照时返回 empty。"""
    return canvas.recovery_latest()


@app.post("/api/canvas/import-submission")
def canvas_import_submission(body: dict):
    """经典提交整图导入画布：按 submissionId 读取提交图快照，实时解析资产路径。

    返回 {name, nodes, edges, missing}（图片节点已解析 absPath/url，缺失进 missing）。
    """
    submission_id = str(body.get("submissionId", ""))
    result = canvas.submission_load(submission_id)
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("error", "导入提交失败"))
    return {
        "name": result["name"],
        "nodes": result["nodes"],
        "edges": result["edges"],
        "missing": result["missing"],
    }


@app.post("/api/select-folder")
def select_folder(body: dict):
    """弹出系统文件夹选择器；取消则返回原路径

    多窗口并发调用 tkinter 会触发 Tcl 线程错误，用 _UI_LOCK 串行化
    （对话框是模态的，用户同一时刻只会操作一个，锁不会阻塞正常使用）。
    """
    current = str(body.get("current", ""))
    try:
        with _UI_LOCK:
            import tkinter as tk
            from tkinter import filedialog

            root = tk.Tk()
            root.withdraw()
            root.attributes("-topmost", True)
            folder = filedialog.askdirectory(title="选择输出文件夹")
            root.destroy()
            return {"path": folder if folder else current}
    except Exception:
        return {"path": current}


def size_cost(size: str, model_id: str | None = None) -> float:
    """按尺寸查单张费用（唯一来源 config.cost_for_size，即 config.json 的 size_options）。

    传了 model_id 就按**该模型**所属 profile 的价目表算 —— 跨供应商时
    这一步不能省：否则测中转站的图会按豆包的单价显示（曾把 0.05 显示成 0.2）。
    """
    return config.cost_for_size(size, model_id)


# 上游报错关键字 → 一句中文「该怎么办」。
# 上游只给英文原文，而「Your account ... has not activated the model」并不能直接告诉用户去哪开通。
_ERROR_ACTIONS: tuple[tuple[tuple[str, ...], str], ...] = (
    (
        ("modelnotopen", "has not activated the model"),
        "→ 火山账号还没开通该模型：到方舟控制台「开通管理」里开通后再试。",
    ),
    (
        (
            "model_not_found",
            "is not supported by any configured account",
            "model not exist",
        ),
        "→ 这个来源不认识该模型名：中转站与豆包的模型 ID 互不通用，按来源选对应模型。",
    ),
    (
        ("invalid api key", "authenticationerror", "api key format is incorrect"),
        "→ Key 无效或与来源不匹配：火山方舟是 ark- 开头，中转站是 sk- 开头。",
    ),
    (
        ("insufficient", "quota", "overdue", "balance"),
        "→ 账号额度不足：充值后再试。",
    ),
    (
        ("too many requests", "rate limit"),
        "→ 请求太频繁：稍等一会儿再试。",
    ),
)


def _action_hint(message: str) -> str:
    """按上游错误关键字给一句中文行动建议；认不出则返回空串。"""
    low = message.lower()
    for keys, hint in _ERROR_ACTIONS:
        if any(k in low for k in keys):
            return hint
    return ""


def _humanize_error(message: str) -> str:
    """把异常整理成用户看得懂的话（可能含换行）。

    1. 去掉「RuntimeError: 」这类 Python 类名前缀 —— 界面上是纯噪音；
    2. 能识别出上游常见错误时，补一行中文「该怎么办」。
    """
    text = message
    for prefix in (
        "RuntimeError: ",
        "ValueError: ",
        "KeyError: ",
        "TypeError: ",
        "OSError: ",
        "Exception: ",
        "HTTPError: ",
        "TimeoutError: ",
        "ConnectionError: ",
        "RequestException: ",
    ):
        if text.startswith(prefix):
            text = text[len(prefix) :]
            break
    hint = _action_hint(text)
    return f"{text}\n{hint}" if hint else text


def run_generation(task: GenerationTask) -> None:
    """在全局任务池的线程中执行一次生成，把结果写回任务。

    成功写 task.results / task.messages / task.total_cost；
    失败写 task.error（TaskManager 据此置 failed）。临时兜底文件由 TaskManager 统一清理。
    保存路径统一以绝对路径进消息（前端动态显示本机路径 + 点击复制词条），不再相对化。
    """
    out_dir = os.path.abspath(
        (task.output_dir.strip() or DEFAULT_OUTPUT_DIR).rstrip("\\/")
    )
    os.makedirs(out_dir, exist_ok=True)
    stamp = time.strftime("%Y%m%d_%H%M%S")
    started_at = time.time()
    cost = size_cost(task.size, task.api_model or None)
    results: list[dict] = []
    messages: list[str] = []
    dest = ""
    ok = False
    try:
        # 参考图二选一：ref_bases 为提交阶段已校验/落盘的路径（优先）；
        # temp_bases 为 multipart 兜底（UploadFile 不可跨线程，提交线程先落临时文件）。
        bases = task.ref_bases or task.temp_bases
        img2img = bool(bases)
        prefix = "img2img" if img2img else "txt2img"
        dest = os.path.join(out_dir, f"{prefix}_{stamp}_{next(_SEQ):03d}.png")
        messages.append(f"图生图 · 参考图 {len(bases)} 张" if img2img else "文生图")
        if img2img:
            generate_image(
                prompt=task.prompt,
                images=bases,
                size=task.size,
                quality=task.quality,
                model=task.api_model or DEFAULT_MODEL,
                output_format="png",
                output_path=dest,
                api_base_url=task.api_base_url or None,
                api_key=task.api_key or None,
                generations_path=task.api_generations_path,
                edits_path=task.api_edits_path,
            )
        else:
            generate_image(
                prompt=task.prompt,
                image_path=None,
                size=task.size,
                quality=task.quality,
                model=task.api_model or DEFAULT_MODEL,
                output_format="png",
                output_path=dest,
                api_base_url=task.api_base_url or None,
                api_key=task.api_key or None,
                generations_path=task.api_generations_path,
                edits_path=task.api_edits_path,
            )
        results.append(
            {
                "status": "ok",
                "message": f"已保存: {dest}",
                "url": canvas.image_url(dest),
                "size": task.size,
                "cost": cost,
                "fileSize": os.path.getsize(dest),
                "ext": Path(dest).suffix.lstrip("."),
            }
        )
        messages.append(f"已保存 · {dest}（{task.size}）")
        ok = True
    except Exception as e:
        msg = format_error(e)
        task.error = msg  # 日志保留原始异常（便于排查）
        human = _humanize_error(msg)  # 给用户看的 message 附上中文「该怎么办」
        results.append({"status": "error", "message": human})
        messages.append(f"失败 · {human}")

    total_cost = sum(r.get("cost", 0) for r in results if r.get("status") == "ok")
    ok_count = sum(1 for r in results if r.get("status") == "ok")
    messages.append(f"本次成功 {ok_count} 张 · 费用 {total_cost:.2f} 元")

    # 记住本次输出路径：下次服务启动默认沿用（生成失败不算"用过"）
    if ok_count > 0:
        save_last_output_dir(out_dir)

    task.results = results
    task.messages = messages
    task.total_cost = total_cost
    # 旁路：生成成功后注册结果图并落提交图快照（失败不影响生成结果）；
    # 参考图已在提交阶段注册进 .assets（task.input_asset_ids），此处只按 id 解析。
    submission_meta: dict | None = None
    if ok_count > 0 and task.submission_id:
        try:
            submission_meta = _persist_submission(task)
        except Exception:
            submission_meta = None
    log_generation(
        prompt=task.prompt,
        mode="img2img" if (task.temp_bases or task.ref_bases) else "txt2img",
        refs=len(task.temp_bases) + len(task.ref_bases),
        size=task.size,
        quality=task.quality,
        status="ok" if ok else "error",
        output=dest if ok else "",
        cost=total_cost,
        seconds=time.time() - started_at,
        win=task.win or None,
        submission_id=task.submission_id or "",
        # 参考图提交时已注册，成功/失败都记进账本（不再依赖 persist 结果）
        input_asset_ids=task.input_asset_ids or None,
        output_asset_ids=(submission_meta or {}).get("output_asset_ids"),
    )


def _persist_submission(task: GenerationTask) -> dict | None:
    """旁路：把本次成功结果注册进 .assets 并落提交图快照。

    委托 graphstore.persist_submission_assets 公共函数（与 CLI 共用同一资产旁路逻辑）：
      - 参考图已在提交阶段注册（task.input_asset_ids，见 /api/generate 的 register_input_assets），
        本函数按 id 解析进提交快照，不重复注册；
      - 结果图这里现场注册为 kind='result'；persist_submission_assets 内部对已缺失文件跳过，不报错。
      - 任何失败不抛（由调用方 try/except 兜底），成功与否不影响生成结果。
    返回 {"input_asset_ids": [...], "output_asset_ids": [...]} 供账本联动；无结果返回 None。
    """

    def _path_from_url(url: str) -> str:
        try:
            from urllib.parse import parse_qs, urlparse

            return parse_qs(urlparse(url).query).get("path", [""])[0] or ""
        except Exception:
            return ""

    # 把 task.results 的 url 反解成绝对路径（与 generation 阶段 dest 一致）
    result_paths: list[str] = []
    for res in task.results:
        if res.get("status") != "ok" or not res.get("url"):
            continue
        dest = _path_from_url(res["url"])
        if dest:
            result_paths.append(dest)

    params = {"size": task.size, "quality": task.quality, "outputDir": task.output_dir}
    return graphstore.persist_submission_assets(
        task.submission_id,
        task.prompt,
        params,
        [*task.ref_bases, *task.temp_bases],
        result_paths,
        task.win,
        input_asset_ids=task.input_asset_ids,
    )


# 全局生成任务池：执行池大小即全局并发上限，所有窗口 / 模式共享（详见 core/tasks.py）
task_manager = TaskManager(concurrency=MAX_CONCURRENCY, run_task=run_generation)


@app.post("/api/generate")
def generate(
    prompt: str = Form(...),
    size: str = Form(DEFAULT_SIZE),
    quality: str = Form(DEFAULT_QUALITY),
    output_dir: str = Form(""),
    images: list[UploadFile] = File(default=[]),
    ref_paths: str = Form(""),
    win: int = Form(0),
    allow_over_budget: bool = Form(False),
    api_base_url: str = Form(""),
    api_key: str = Form(""),
    api_model: str = Form(""),
    api_generations_path: str = Form("/v1/images/generations"),
    api_edits_path: str = Form("/v1/images/edits"),
    api_path: str = Form(""),
):
    """提交生成任务（文生图 / 图生图），立即返回 taskId 与初始状态。

    实际生成进入全局任务池排队执行（并发上限 10，经典表单与无限画布共用），
    前端轮询 GET /api/tasks/{taskId} 获取状态与最终结果。
    同步提交：仅在提交阶段做参数校验与文件落盘，不阻塞生成。
    allow_over_budget：预算预检已确认时由前端置 true，超限才放行（见 /api/budget/check）。
    """
    ref_bases: list[str] = []
    if ref_paths:
        try:
            ref_list = json.loads(ref_paths)
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="参考图参数非法")
        # 只接受 REF_DIR / ASSET_DIR 内路径，防路径穿越（校验失败不占执行槽）
        for p in ref_list:
            safe = safe_ref_path_allowlist(p, [REF_DIR, canvas.ASSET_DIR])
            if not safe or not os.path.isfile(safe):
                raise HTTPException(status_code=400, detail=f"非法参考图路径: {p}")
            ref_bases.append(safe)

    # 预算闸门：超限且未确认（allow_over_budget）时 409，前端弹确认后带标记重提
    _budget_guard(size_cost(size), allow_over_budget)

    # multipart 兜底文件：UploadFile 不能跨线程读取，必须在请求线程落临时文件
    temp_bases: list[str] = []
    for image in images:
        with tempfile.NamedTemporaryFile(
            suffix=Path(image.filename or "img").suffix or ".png", delete=False
        ) as tmp:
            tmp.write(image.file.read())
            temp_bases.append(tmp.name)

    submission_id = graphstore.next_submission_id()
    # 提交时即注册参考图进 .assets（此刻文件刚校验 / 刚落盘，必然存在），消除排队期间
    # 文件被删导致 persist 时参考图静默漏记的窗口（曾实测 refs=5 全漏）；id 随任务进账本。
    input_asset_ids = graphstore.register_input_assets(
        submission_id, [*ref_bases, *temp_bases]
    )

    personal_base_url = _form_string(api_base_url).strip()
    personal_api_key = _form_string(api_key).strip()
    personal_model = _form_string(api_model).strip()
    personal_api_path = _form_string(api_path).strip()
    if personal_api_path:
        personal_generations_path = personal_api_path
        personal_edits_path = personal_api_path
    else:
        personal_generations_path = (
            _form_string(api_generations_path, "/v1/images/generations").strip()
            or "/v1/images/generations"
        )
        personal_edits_path = (
            _form_string(api_edits_path, "/v1/images/edits").strip()
            or "/v1/images/edits"
        )

    task = GenerationTask(
        prompt=prompt,
        size=size,
        quality=quality,
        output_dir=output_dir,
        win=win,
        ref_bases=ref_bases,
        temp_bases=temp_bases,
        submission_id=submission_id,
        input_asset_ids=input_asset_ids,
        api_base_url=personal_base_url,
        api_key=personal_api_key,
        api_model=personal_model,
        api_generations_path=personal_generations_path,
        api_edits_path=personal_edits_path,
    )
    task_id = task_manager.submit(task)
    return {"taskId": task_id, "status": task.status}


@app.post("/api/generate/batch")
def generate_batch(body: dict):
    """批量提交生成（生成历史「重跑失败项」用）：一次请求提交多条，不阻塞生成。

    body:
      items: [{prompt, size, quality, refPaths: [str]}]  —— refPaths 只接受 .refs/.assets 内路径
      outputDir / win / allowOverBudget: 与单条提交同义

    返回 {submitted: [{taskId, prompt, size, cost}], skipped: [{index, reason}], estimate, budget}：
      - 单条非法（空提示词 / 参考图不可用）只跳过该条，不整体失败（批量重跑要能部分成功）；
      - 全部被跳过 / 超预算未确认 → 不提交任何任务（避免「提交一半再被拦」）。
    """
    raw_items = body.get("items")
    if not isinstance(raw_items, list) or not raw_items:
        raise HTTPException(status_code=400, detail="items 不能为空")
    output_dir = str(body.get("outputDir") or "")
    win = int(body.get("win") or 0)

    prepared: list[dict] = []
    skipped: list[dict] = []
    for index, item in enumerate(raw_items):
        if not isinstance(item, dict):
            skipped.append({"index": index, "reason": "条目结构非法"})
            continue
        prompt = str(item.get("prompt") or "").strip()
        if not prompt:
            skipped.append({"index": index, "reason": "提示词为空"})
            continue
        size = str(item.get("size") or DEFAULT_SIZE)
        quality = str(item.get("quality") or DEFAULT_QUALITY)
        ref_bases: list[str] = []
        bad_ref = ""
        for raw_path in item.get("refPaths") or []:
            safe = safe_ref_path_allowlist(str(raw_path), [REF_DIR, canvas.ASSET_DIR])
            if not safe or not os.path.isfile(safe):
                bad_ref = f"参考图不可用：{raw_path}"
                break
            ref_bases.append(safe)
        if bad_ref:
            skipped.append({"index": index, "reason": bad_ref})
            continue
        prepared.append(
            {"prompt": prompt, "size": size, "quality": quality, "ref_bases": ref_bases}
        )

    estimate = round(sum(size_cost(item["size"]) for item in prepared), 2)
    if not prepared:
        return {
            "submitted": [],
            "skipped": skipped,
            "estimate": 0.0,
            "budget": cost.check_budget(
                0.0, cost.load_budget(), cost.today_spent(read_raw_history())
            ),
        }

    budget = _budget_guard(estimate, bool(body.get("allowOverBudget")))

    submitted = []
    for item in prepared:
        submission_id = graphstore.next_submission_id()
        # 与单条提交同源：提交阶段即注册参考图，排队期间源文件被删也不漏记
        input_asset_ids = graphstore.register_input_assets(
            submission_id, item["ref_bases"]
        )
        task = GenerationTask(
            prompt=item["prompt"],
            size=item["size"],
            quality=item["quality"],
            output_dir=output_dir,
            win=win,
            ref_bases=item["ref_bases"],
            temp_bases=[],
            submission_id=submission_id,
            input_asset_ids=input_asset_ids,
        )
        submitted.append(
            {
                "taskId": task_manager.submit(task),
                "prompt": item["prompt"],
                "size": item["size"],
                "cost": size_cost(item["size"]),
            }
        )
    return {
        "submitted": submitted,
        "skipped": skipped,
        "estimate": estimate,
        "budget": budget,
    }


@app.get("/api/tasks/{task_id}")
def task_status(task_id: str):
    """查询生成任务状态（前端轮询）。终态保留 10 分钟，超时或不存在返回 404。"""
    snap = task_manager.snapshot(task_id)
    if snap is None:
        raise HTTPException(status_code=404, detail="任务不存在或已过期")
    return snap


@app.post("/api/tasks/{task_id}/cancel")
def cancel_task(task_id: str):
    """请求取消任务：排队中不再执行；生成中无法中断上游请求，跑完后丢弃结果。"""
    return {"ok": task_manager.cancel(task_id)}


@app.post("/api/open-folder")
def open_folder(body: dict):
    """在系统资源管理器中打开指定文件夹，并尝试激活到前台

    后台进程启动的 explorer 窗口默认不抢前台（Windows 前台锁定），
    这里用 Win32 API 在打开后主动把窗口置前。
    """
    path = str(body.get("path", "")).rstrip("\\/")
    try:
        # 串行化：多窗口并发打开文件夹时避免 explorer 置前互相抢前台
        with _UI_LOCK:
            os.makedirs(path, exist_ok=True)
            subprocess.Popen(["explorer.exe", path])
            time.sleep(1.0)
            _activate_explorer_window(os.path.basename(path) or path)
        return {"ok": True}
    except Exception:
        return {"ok": False}


def _activate_explorer_window(title_part: str) -> bool:
    """把标题包含 title_part 的资源管理器窗口恢复并置前（绕过前台锁定）"""
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def callback(hwnd, _lparam):
        cls = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, cls, 256)
        if cls.value in ("CabinetWClass", "ExplorerWClass"):
            title = ctypes.create_unicode_buffer(512)
            user32.GetWindowTextW(hwnd, title, 512)
            if title_part in title.value:
                found.append(hwnd)
        return True

    user32.EnumWindows(callback, 0)
    if not found:
        return False

    hwnd = found[0]
    user32.ShowWindow(hwnd, 9)  # SW_RESTORE
    # 绕过前台锁定：模拟一次 Alt 键按下/抬起，再置前
    user32.keybd_event(0x12, 0, 0, 0)  # ALT down
    user32.SetForegroundWindow(hwnd)
    user32.keybd_event(0x12, 0, 2, 0)  # ALT up
    user32.BringWindowToTop(hwnd)
    return True


def image_url(path: str) -> str:
    """生成可访问图片文件的相对 URL（单一实现收敛在 core/canvas.py）"""
    return canvas.image_url(path)


@app.get("/api/image")
def get_image(path: str):
    """读取生成的图片文件"""
    abs_path = os.path.abspath(path)
    if not os.path.isfile(abs_path):
        return JSONResponse({"error": "文件不存在"}, status_code=404)
    return FileResponse(abs_path)


# StaticFiles 判定 Content-Type 走标准库 mimetypes，而 Windows 上 mimetypes 会读
# 注册表 HKEY_CLASSES_ROOT\.js 的 "Content Type"。只要本机被别的软件写成
# text/plain，浏览器就按 ES module 的严格 MIME 校验拒绝执行构建产物，页面整页
# 空白（#root 无子节点，控制台报 "Expected a JavaScript-or-Wasm module script"）。
# 显式登记优先于注册表查询，跨平台行为一致；顺带补齐其余易被注册表带偏的类型。
# 无条件执行（而非只在 dist 存在时），这样未构建前端的环境也能被单测覆盖。
_STATIC_MIME_TYPES = (
    (".js", "text/javascript"),
    (".mjs", "text/javascript"),
    (".css", "text/css"),
    (".json", "application/json"),
    (".svg", "image/svg+xml"),
    (".woff2", "font/woff2"),
)


def ensure_static_mimetypes() -> None:
    """把前端构建产物用到的扩展名钉死 Content-Type，不受本机注册表影响。"""
    for ext, content_type in _STATIC_MIME_TYPES:
        mimetypes.add_type(content_type, ext)


ensure_static_mimetypes()

# 静态托管前端构建产物（挂在最后，仅当 dist 已构建）
if (DIST_DIR / "index.html").exists():
    app.mount("/", StaticFiles(directory=str(DIST_DIR), html=True), name="frontend")
else:

    @app.get("/", include_in_schema=False)
    def frontend_not_built():
        """前端未构建时的提示页（错误放 UI，不静默空白）"""
        return HTMLResponse(
            "<h3>前端未构建</h3>"
            "<p>请先在 Imagora 目录执行：</p>"
            "<pre>cd frontend &amp;&amp; npm install &amp;&amp; npm run build</pre>"
            "<p>构建完成后刷新本页。详见 README「快速开始」。</p>",
            status_code=503,
        )

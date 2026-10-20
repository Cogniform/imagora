#!/usr/bin/env python3
"""server.py 纯函数单元测试

覆盖: 尺寸费用查询、参考图服务端化（路径校验/上传/删除）。
不启动服务、不调 API。
"""

import os
from io import BytesIO

from fastapi import UploadFile
from starlette.datastructures import Headers

from core import config
from server import ensure_static_mimetypes, size_cost


def test_static_assets_use_javascript_mime():
    """前端构建产物的 Content-Type 不受本机注册表影响。

    回归：Windows 上 `mimetypes.guess_type("x.js")` 会读注册表
    HKEY_CLASSES_ROOT\\.js 的 "Content Type"，被别的软件写成 text/plain 时，
    StaticFiles 就会以 text/plain 下发 .js；浏览器按 ES module 的严格 MIME
    校验直接拒绝执行，页面整页空白（控制台报 "Expected a JavaScript-or-Wasm
    module script"），而服务端日志一切正常，极难排查。
    """
    import mimetypes

    # 模拟被注册表带偏的状态：先按错误类型登记，再看 ensure 是否纠正
    mimetypes.add_type("text/plain", ".js")
    assert mimetypes.guess_type("index.js")[0] == "text/plain"

    ensure_static_mimetypes()

    assert mimetypes.guess_type("index.js")[0] == "text/javascript"
    assert mimetypes.guess_type("index.mjs")[0] == "text/javascript"
    assert mimetypes.guess_type("index.css")[0] == "text/css"


def test_size_cost_known_sizes():
    """已知尺寸 -> 对应费用（从当前 profile 的 size_options 推导，不硬编码价格，
    否则切换 profile/供应商就会误报失败）。

    这里必须用 `config.SIZE_OPTIONS` 而非模块级 `from core.config import SIZE_OPTIONS`：
    后者是导入时快照，而用例执行时 conftest 已把配置拨回出厂目录，两边会不一致。
    """
    for opt in config.SIZE_OPTIONS:
        assert size_cost(opt["value"]) == float(opt.get("cost", 0.0))


def test_size_cost_unknown_returns_zero():
    """未知尺寸 -> 0.0（计费唯一由 config.json size_options 决定，不硬编码兜底价）"""
    assert size_cost("9999x9999") == 0.0


def test_safe_ref_path_accepts_inside_ref_dir():
    """REF_DIR 内的路径 -> 放行（返回绝对路径）"""
    from server import REF_DIR, safe_ref_path

    p = os.path.join(REF_DIR, "ref_test.png")
    assert safe_ref_path(p) == os.path.abspath(p)


def test_safe_ref_path_rejects_outside():
    """REF_DIR 外的路径（含 ../ 穿越）-> 返回 None"""
    from server import safe_ref_path

    assert safe_ref_path(r"D:\outside\evil.png") is None
    assert safe_ref_path(os.path.join("..", "..", "evil.png")) is None


def test_safe_ref_path_rejects_cross_drive_without_raising():
    """不同盘符的路径必须直接拒绝，不能把 commonpath 的 ValueError 泄漏到路由层。"""
    from server import safe_ref_path

    assert safe_ref_path(r"Z:\foreign\image.png") is None


def test_resolve_history_output_path_uses_work_root_for_relative_logs(
    tmp_path, monkeypatch
):
    """历史日志里的相对输出路径必须以项目工作根解析，而不是进程当前目录。"""
    from server import resolve_history_output_path

    monkeypatch.setattr("core.history.WORK_ROOT", tmp_path)
    assert resolve_history_output_path("output/result.png") == os.path.normpath(
        str(tmp_path / "output" / "result.png")
    )


def test_upload_ref_returns_metadata_and_persists():
    """上传参考图 -> 返回 id/path/url/name/size/ext/mime，文件落盘 REF_DIR"""
    from server import REF_DIR, upload_ref

    upload = UploadFile(
        filename="a.png",
        file=BytesIO(b"fake-png-bytes"),
        headers=Headers({"content-type": "image/png"}),
    )
    try:
        refs = upload_ref(images=[upload])["refs"]
        assert len(refs) == 1
        ref = refs[0]
        assert ref["name"] == "a.png"
        assert ref["size"] == len(b"fake-png-bytes")
        assert ref["ext"] == "png"
        assert ref["mime"] == "image/png"
        assert ref["path"].startswith(REF_DIR)
        assert os.path.isfile(ref["path"])
        assert ref["url"].startswith("/api/image?path=")
    finally:
        upload.file.close()
        ref_path = refs[0]["path"] if refs else None
        if ref_path and os.path.isfile(ref_path):
            os.unlink(ref_path)


def test_delete_ref_removes_file_and_tolerates_missing():
    """删除已落盘参考图 -> ok 且文件消失；文件不存在 / 非法路径也不抛错"""
    from server import REF_DIR, delete_ref, upload_ref

    upload = UploadFile(filename="b.jpg", file=BytesIO(b"jpeg-bytes"))
    try:
        dest = upload_ref(images=[upload])["refs"][0]["path"]
        assert os.path.isfile(dest)
        assert delete_ref(dest)["ok"] is True
        assert not os.path.isfile(dest)
        # 不存在也算成功
        assert delete_ref(os.path.join(REF_DIR, "ghost.png"))["ok"] is True
        # 非法路径不炸
        assert delete_ref(r"D:\outside.png")["ok"] is True
    finally:
        upload.file.close()


def test_get_config_window_id_increments(monkeypatch):
    """连续无参调用 -> 窗口编号递增，无路径记录时默认输出目录按窗口分区"""
    from server import get_config

    monkeypatch.setattr("server.load_last_output_dir", lambda: None)
    first = get_config(None)
    second = get_config(None)
    assert second["windowId"] == first["windowId"] + 1
    assert first["defaultOutputDir"].endswith(f"win{first['windowId']}")
    assert second["defaultOutputDir"].endswith(f"win{second['windowId']}")


def test_get_config_keeps_existing_window_id(monkeypatch):
    """传已有窗口号 -> 沿用该编号与对应分区（刷新页面编号不变）"""
    from server import get_config

    monkeypatch.setattr("server.load_last_output_dir", lambda: None)
    cfg = get_config(win=7)
    assert cfg["windowId"] == 7
    assert cfg["defaultOutputDir"].endswith("win7")


def test_get_config_ignores_invalid_window_id(monkeypatch):
    """传 0 / 负数 -> 视为无效，重新分配新编号"""
    from server import get_config

    monkeypatch.setattr("server.load_last_output_dir", lambda: None)
    cfg = get_config(win=0)
    assert cfg["windowId"] >= 1


def test_get_config_remembers_last_output_dir(monkeypatch, tmp_path):
    """存在上次输出路径记录 -> 默认输出沿用该路径（服务重启后记住）"""
    from server import get_config

    last_dir = str(tmp_path / "my_output")
    monkeypatch.setattr("server.load_last_output_dir", lambda: last_dir)
    cfg = get_config(None)
    assert cfg["defaultOutputDir"] == last_dir


def test_load_last_output_dir_ignores_dead_path(tmp_path):
    """自愈：记录的目录已被删除（如测试临时目录残留）-> 不沿用，返回 None。

    回归背景：跑 pytest 时若隔离失效，tmp_path 死目录会被写进真实记录文件，
    下次启动生图直接失败；load_last_output_dir 必须校验目录仍存在。
    """
    import server

    dead = tmp_path / "gone" / "out"  # 只构造路径，不创建目录
    server.LAST_OUTPUT_DIR_FILE = str(tmp_path / ".last_output_dir")
    with open(server.LAST_OUTPUT_DIR_FILE, "w", encoding="utf-8") as f:
        f.write(str(dead))
    assert server.load_last_output_dir() is None

    # 目录真实存在 -> 正常返回
    alive = tmp_path / "real_out"
    alive.mkdir()
    with open(server.LAST_OUTPUT_DIR_FILE, "w", encoding="utf-8") as f:
        f.write(str(alive))
    assert server.load_last_output_dir() == str(alive)


def test_get_config_falls_back_when_record_dead(monkeypatch, tmp_path):
    """记录目录已失效 -> 默认输出回退到窗口分区目录，不再指向死路径"""
    from server import get_config

    dead = str(tmp_path / "gone" / "out")
    # load_last_output_dir 内部会校验目录存在，此处直接喂真实实现 + 死路径记录
    import server

    server.LAST_OUTPUT_DIR_FILE = str(tmp_path / ".last_output_dir")
    with open(server.LAST_OUTPUT_DIR_FILE, "w", encoding="utf-8") as f:
        f.write(dead)
    cfg = get_config(None)
    assert cfg["defaultOutputDir"] != dead
    assert "win" in cfg["defaultOutputDir"]


def test_generation_history_route_adds_existing_image_url(monkeypatch, tmp_path):
    """历史路由只给仍存在的输出文件添加可访问 URL。"""
    from server import generation_history

    image = tmp_path / "result.png"
    image.write_bytes(b"png")
    monkeypatch.setattr(
        "server.read_generation_history_paged",
        lambda **_kwargs: {
            "items": [
                {"prompt": "ok", "status": "ok", "output": str(image)},
                {
                    "prompt": "missing",
                    "status": "ok",
                    "output": str(tmp_path / "missing.png"),
                },
            ],
            "total": 2,
        },
    )

    result = generation_history(limit=20, query="", status="")

    assert result["items"][0]["url"].startswith("/api/image?path=")
    assert result["items"][0]["exists"] is True
    assert result["items"][1]["url"] == ""
    assert result["items"][1]["exists"] is False


def test_generation_history_paginates_with_has_more(monkeypatch, tmp_path):
    """分页语义：hasMore = 当前页后仍有聚合结果；offset 按已加载条数推进。"""
    from server import generation_history

    records = [
        {"prompt": f"p{i}", "status": "ok", "output": str(tmp_path / f"{i}.png")}
        for i in range(5)
    ]
    monkeypatch.setattr(
        "server.read_generation_history_paged",
        lambda offset=0, limit=60, **_kwargs: {
            "items": records[offset : offset + limit],
            "total": len(records),
        },
    )

    first = generation_history(limit=3, offset=0, query="", status="")
    assert len(first["items"]) == 3
    assert first["hasMore"] is True

    rest = generation_history(limit=3, offset=3, query="", status="")
    assert len(rest["items"]) == 2
    assert rest["hasMore"] is False


def test_history_import_only_accepts_recorded_existing_output(monkeypatch, tmp_path):
    """历史导入只允许日志中存在的输出文件，不能变成任意路径读取接口。"""
    from server import import_history_asset

    recorded = tmp_path / "recorded.png"
    recorded.write_bytes(b"png")
    outside = tmp_path / "outside.png"
    outside.write_bytes(b"png")
    monkeypatch.setattr(
        "server.read_generation_history",
        lambda **_kwargs: [
            {"output": str(recorded)},
        ],
    )
    monkeypatch.setattr(
        "server.canvas.register_asset",
        lambda path, name: {
            "id": "abc",
            "absPath": path,
            "name": name,
        },
    )

    accepted = import_history_asset({"path": str(recorded)})
    rejected = import_history_asset({"path": str(outside)})

    assert accepted["imported"][0]["id"] == "abc"
    assert rejected["imported"] == []
    assert rejected["skipped"]


def test_history_import_accepts_registry_copy_path(monkeypatch, tmp_path):
    """导入与展示同源：账本带 outputAssetIds 时，注册表副本路径可导入（原 output 文件已删仍可）。"""
    from server import import_history_asset

    src = tmp_path / "original.png"
    src.write_bytes(b"png")
    copy = tmp_path / "registry_copy.png"
    copy.write_bytes(b"png")
    monkeypatch.setattr(
        "server.read_generation_history",
        lambda **_kwargs: [
            {"output": str(src), "outputAssetIds": ["abc123"]},
        ],
    )
    monkeypatch.setattr(
        "server.canvas.resolve_asset", lambda *_a, **_k: {"absPath": str(copy)}
    )
    monkeypatch.setattr(
        "server.canvas.register_asset",
        lambda path, name: {
            "id": "xyz",
            "absPath": path,
            "name": name,
        },
    )

    accepted = import_history_asset({"path": str(copy)})
    assert accepted["imported"][0]["id"] == "xyz"

    # 安全语义保留：未记录路径仍拒绝
    rejected = import_history_asset({"path": str(tmp_path / "outside.png")})
    assert rejected["imported"] == []
    assert rejected["skipped"]


def test_history_import_accepts_raw_output_path_with_asset_ids(monkeypatch, tmp_path):
    """画布回流回归：账本带 outputAssetIds 时，账本 output 原路径（任务结果 URL 反解）仍可导入。

    曾回归：白名单只收注册表副本路径（f4126fe），回流传原始输出路径 →
    白名单失配 → 「节点 prompt-xxx：生成成功，但结果导入画布失败」。
    """
    from server import import_history_asset

    src = tmp_path / "original.png"
    src.write_bytes(b"png")
    copy = tmp_path / "registry_copy.png"
    copy.write_bytes(b"png")
    monkeypatch.setattr(
        "server.read_generation_history",
        lambda **_kwargs: [
            {"output": str(src), "outputAssetIds": ["abc123"]},
        ],
    )
    monkeypatch.setattr(
        "server.canvas.resolve_asset", lambda *_a, **_k: {"absPath": str(copy)}
    )
    monkeypatch.setattr(
        "server.canvas.register_asset",
        lambda path, name: {
            "id": "raw-ok",
            "absPath": path,
            "name": name,
        },
    )

    accepted = import_history_asset({"path": str(src)})
    assert accepted["imported"][0]["id"] == "raw-ok"

    # 安全语义保留：未记录路径仍拒绝
    rejected = import_history_asset({"path": str(tmp_path / "unlisted.png")})
    assert rejected["imported"] == []
    assert rejected["skipped"]


def test_generation_history_resolves_via_registry_when_output_moved(
    monkeypatch, tmp_path
):
    """历史以注册表为准：账本带 outputAssetIds 时，原 output 文件被移动/删除仍显示（注册表副本在）。"""
    from core import registry
    from server import generation_history

    # 注册表副本（在 .assets 隔离区）：原 output 路径的文件已被删除
    src = tmp_path / "moved_away.png"
    src.write_bytes(b"png")
    entry = registry.register_asset(str(src), "moved_away.png")
    os.unlink(src)  # 模拟用户把原文件挪走/删掉

    monkeypatch.setattr(
        "server.read_generation_history_paged",
        lambda **_kwargs: {
            "items": [
                {
                    "prompt": "registry-backed",
                    "status": "ok",
                    "output": str(src),
                    "outputAssetIds": [entry["id"]],
                },
            ],
            "total": 1,
        },
    )
    result = generation_history(limit=20, query="", status="")
    item = result["items"][0]
    assert item["exists"] is True  # 注册表副本仍在
    assert item["url"].startswith("/api/image?path=")
    assert os.path.isfile(item["path"])  # path 指向注册表副本


def test_health_details_reports_actionable_checks(monkeypatch, tmp_path):
    """启动自检只返回状态和可读问题，不返回密钥。"""
    from server import health_details

    dist = tmp_path / "dist"
    output = tmp_path / "output"
    monkeypatch.setattr("server.DIST_DIR", dist)
    # server.py 已改为运行期读 config.DEFAULT_OUTPUT_DIR（配置热加载后要跟上新值），
    # 模块里不再有同名副本 —— 补丁要打在 config 上。
    monkeypatch.setattr("core.config.DEFAULT_OUTPUT_DIR", str(output))
    monkeypatch.setattr("server.load_last_output_dir", lambda: None)
    monkeypatch.setattr("server.has_api_key", lambda: False)

    result = health_details()

    assert result["ok"] is False
    assert result["checks"]["apiKey"] is False
    assert result["checks"]["frontendBuilt"] is False
    assert result["checks"]["outputWritable"] is True
    assert any("API Key" in issue for issue in result["issues"])
    assert "secret" not in str(result).lower()


def test_remember_output_dir_saves(monkeypatch, tmp_path):
    """POST /api/output-dir -> 调用 save_last_output_dir 落盘记录"""
    from server import remember_output_dir

    saved = {}
    monkeypatch.setattr("server.save_last_output_dir", lambda p: saved.update(path=p))
    target = str(tmp_path / "my_output")
    assert remember_output_dir(target)["ok"] is True
    assert saved["path"] == target


def test_next_window_increments_and_shares_counter():
    """连续调用 -> 编号递增；与 config 无参调用共用同一计数器（脚本开窗不撞号）"""
    from server import get_config, next_window

    a = next_window()["windowId"]
    b = next_window()["windowId"]
    assert b == a + 1
    c = get_config(None)["windowId"]
    assert c == b + 1


def test_generate_is_sync_not_coroutine():
    """generate 必须是同步函数：生成请求走 FastAPI 线程池，阻塞不卡事件循环
    （若为 async 且内部同步调 API，生成 1-2 分钟期间所有其他请求全部挂起，
     表现为：命令行按 N 开新窗口超时、页面右上角新窗口白屏）"""
    import inspect

    from server import generate

    assert not inspect.iscoroutinefunction(generate)


def test_persist_submission_includes_temp_bases(monkeypatch, tmp_path):
    """_persist_submission 把 multipart 兜底的 temp_bases 一并传给 persist_submission_assets
    （temp 参考图也要注册进 .assets / 账本，不能只记 ref_bases）。"""
    from core.tasks import GenerationTask
    from server import _persist_submission

    task = GenerationTask(
        prompt="p",
        size="1024x1024",
        quality="low",
        output_dir=str(tmp_path / "out"),
        submission_id="sub-temp-bases",
        ref_bases=[str(tmp_path / "a.png")],
        temp_bases=[str(tmp_path / "t1.png"), str(tmp_path / "t2.png")],
    )
    task.results = [{"status": "ok", "url": f"/api/image?path={tmp_path / 'r.png'}"}]

    captured: dict = {}
    monkeypatch.setattr(
        "server.graphstore.persist_submission_assets",
        lambda _sid, _prompt, _params, ref_paths, _result_paths, _win, input_asset_ids: (
            captured.update(ref_paths=ref_paths, input_asset_ids=input_asset_ids)
            or {"input_asset_ids": ["x"], "output_asset_ids": ["y"]}
        ),
    )

    meta = _persist_submission(task)
    assert meta["input_asset_ids"] == ["x"]
    assert set(captured["ref_paths"]) == {
        str(tmp_path / "a.png"),
        str(tmp_path / "t1.png"),
        str(tmp_path / "t2.png"),
    }


def test_generation_history_resolves_input_refs_and_missing(monkeypatch, tmp_path):
    """历史路由把 inputAssetIds 解析成 inputRefs；图生图参考图缺失置 inputRefMissing；
    纯文生图既无 inputRefs 也无 missing（三态可区分）。"""
    from server import generation_history

    ref_copy = tmp_path / "ref_copy.png"
    ref_copy.write_bytes(b"png")
    monkeypatch.setattr(
        "server.read_generation_history_paged",
        lambda **_kwargs: {
            "items": [
                {
                    "prompt": "ref ok",
                    "status": "ok",
                    "mode": "img2img",
                    "refs": 1,
                    "output": str(tmp_path / "r1.png"),
                    "inputAssetIds": ["ref-abc"],
                },
                {
                    "prompt": "ref lost",
                    "status": "ok",
                    "mode": "img2img",
                    "refs": 2,
                    "output": str(tmp_path / "r2.png"),
                    "inputAssetIds": ["ghost"],
                },
                {
                    "prompt": "txt",
                    "status": "ok",
                    "mode": "txt2img",
                    "refs": 0,
                    "output": str(tmp_path / "r3.png"),
                },
            ],
            "total": 3,
        },
    )
    monkeypatch.setattr(
        "server.canvas.resolve_asset",
        lambda img_id, **_k: (
            {"absPath": str(ref_copy), "url": "/api/image?path=ref_copy"}
            if img_id == "ref-abc"
            else None
        ),
    )
    monkeypatch.setattr(
        "server.resolve_history_asset_path",
        lambda record, **_k: record.get("output", ""),
    )
    monkeypatch.setattr("server.canvas.image_url", lambda p: f"/api/image?path={p}")

    items = generation_history(limit=20, query="", status="")["items"]
    assert items[0]["inputRefs"] == [
        {"id": "ref-abc", "path": str(ref_copy), "url": "/api/image?path=ref_copy"}
    ]
    assert items[0]["inputRefMissing"] is False
    assert items[1]["inputRefs"] == []
    assert items[1]["inputRefMissing"] is True
    assert items[2]["inputRefs"] == []
    assert items[2]["inputRefMissing"] is False

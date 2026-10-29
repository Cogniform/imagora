import json
import os

from core import history


def _write_history(tmp_path, records):
    path = tmp_path / "generation.jsonl"
    lines = [
        json.dumps(record, ensure_ascii=False) if isinstance(record, dict) else record
        for record in records
    ]
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


def test_read_history_skips_corrupt_lines_and_returns_newest_first(
    tmp_path, monkeypatch
):
    path = _write_history(
        tmp_path,
        [
            {
                "time": "2026-08-09 10:00:00",
                "prompt": "first",
                "status": "ok",
                "output": "a.png",
            },
            "{broken",
            {
                "time": "2026-08-09 11:00:00",
                "prompt": "second",
                "status": "error",
                "output": "",
            },
        ],
    )
    monkeypatch.setattr(history, "HISTORY_FILE", path)

    result = history.read_generation_history()

    assert [item["prompt"] for item in result] == ["second", "first"]


def test_read_history_filters_query_status_and_limit(tmp_path, monkeypatch):
    path = _write_history(
        tmp_path,
        [
            {"time": "1", "prompt": "red shoes", "quality": "high", "status": "ok"},
            {"time": "2", "prompt": "blue bag", "quality": "low", "status": "error"},
            {"time": "3", "prompt": "red bag", "quality": "high", "status": "ok"},
        ],
    )
    monkeypatch.setattr(history, "HISTORY_FILE", path)

    result = history.read_generation_history(limit=1, query="RED", status="ok")

    assert len(result) == 1
    assert result[0]["prompt"] == "red bag"


def test_read_history_search_normalizes_newlines(tmp_path, monkeypatch):
    """搜索对换行鲁棒：账本 prompt 存 CRLF（表单提交 %0D%0A），用户把完整提示词粘进单行
    搜索框时浏览器把换行归一为 LF / 移除——两侧空白折叠后仍能命中，不再整串错位搜不到。"""
    path = _write_history(
        tmp_path,
        [
            {"time": "1", "prompt": "第一行\r\n第二行", "status": "ok"},
        ],
    )
    monkeypatch.setattr(history, "HISTORY_FILE", path)

    # 原样 CRLF（复制按钮复制的完整 prompt）
    assert history.read_generation_history(query="第一行\r\n第二行")
    # 浏览器粘贴归一为 LF
    assert history.read_generation_history(query="第一行\n第二行")
    # 单行 input 粘贴换行被移除（浏览器行为）
    assert history.read_generation_history(query="第一行 第二行")
    # 只搜片段、含连续空格也折叠命中
    assert history.read_generation_history(query="第二行")


def test_read_history_roundtrips_submission_fields(tmp_path, monkeypatch):
    """账本新字段（submissionId/inputAssetIds/outputAssetIds）随记录透传（读端容错缺字段）"""
    path = _write_history(
        tmp_path,
        [
            {
                "time": "1",
                "prompt": "p",
                "status": "ok",
                "submissionId": "sub-9",
                "inputAssetIds": ["a"],
                "outputAssetIds": ["b", "c"],
            },
            {"time": "0", "prompt": "old", "status": "ok"},  # 无新字段的旧行
        ],
    )
    monkeypatch.setattr(history, "HISTORY_FILE", path)
    items = history.read_generation_history()
    first = next(i for i in items if i.get("submissionId"))
    assert first["submissionId"] == "sub-9"
    assert first["inputAssetIds"] == ["a"]
    assert first["outputAssetIds"] == ["b", "c"]
    old = next(i for i in items if i.get("prompt") == "old")
    assert "submissionId" not in old  # 旧行无字段，读端不炸


# ================= 同参数记录聚合（时间不算参数：失败不刷屏） =================


def test_dedupe_collapses_same_params_to_newest(tmp_path, monkeypatch):
    """同一提示词卡片多次失败 → 只显示最新一条。"""
    path = _write_history(
        tmp_path,
        [
            {
                "time": "1",
                "prompt": "p",
                "size": "1024x1024",
                "quality": "high",
                "mode": "txt2img",
                "refs": 0,
                "status": "error",
            },
            {
                "time": "2",
                "prompt": "p",
                "size": "1024x1024",
                "quality": "high",
                "mode": "txt2img",
                "refs": 0,
                "status": "error",
            },
            {
                "time": "3",
                "prompt": "p",
                "size": "1024x1024",
                "quality": "high",
                "mode": "txt2img",
                "refs": 0,
                "status": "error",
            },
        ],
    )
    monkeypatch.setattr(history, "HISTORY_FILE", path)
    result = history.read_generation_history()
    assert len(result) == 1
    assert result[0]["time"] == "3"


def test_dedupe_success_absorbs_older_failures():
    """同参数失败后又成功 → 最新一条即成功记录（失败记录被取代）。"""
    items = [
        {"time": "4", "prompt": "p", "status": "ok"},
        {"time": "3", "prompt": "p", "status": "error"},
        {"time": "2", "prompt": "p", "status": "error"},
    ]
    out = history.dedupe_generation_history(items)
    assert len(out) == 1 and out[0]["status"] == "ok"


def test_dedupe_time_is_not_a_param():
    """时间不算参数：其余参数一致即认为同一条。"""
    items = [
        {"time": "2026-08-25 11:11:11", "prompt": "p", "status": "error"},
        {"time": "2026-08-25 10:00:00", "prompt": "p", "status": "error"},
    ]
    assert len(history.dedupe_generation_history(items)) == 1


def test_dedupe_any_param_difference_keeps_separate():
    """任一参数（mode/prompt/size/quality/refs）不一致 → 不合并。"""
    items = [
        {"prompt": "p", "size": "1024x1024", "quality": "high", "status": "ok"},
        {"prompt": "p", "size": "1024x1024", "quality": "low", "status": "error"},
        {"prompt": "q", "size": "1024x1024", "quality": "high", "status": "error"},
        {"prompt": "p", "size": "512x512", "quality": "high", "status": "error"},
        {
            "prompt": "p",
            "size": "1024x1024",
            "quality": "high",
            "mode": "img2img",
            "refs": 1,
            "status": "error",
        },
        {
            "prompt": "p",
            "size": "1024x1024",
            "quality": "high",
            "mode": "img2img",
            "refs": 2,
            "status": "error",
        },
    ]
    assert len(history.dedupe_generation_history(items)) == 6


def test_dedupe_input_asset_ids_participate():
    """参考图（inputAssetIds）是参数：不同参考图不合并，相同参考图成功吸收失败。"""
    items = [
        {
            "prompt": "p",
            "mode": "img2img",
            "refs": 1,
            "inputAssetIds": ["a"],
            "status": "ok",
        },
        {
            "prompt": "p",
            "mode": "img2img",
            "refs": 1,
            "inputAssetIds": ["a"],
            "status": "error",
        },
        {
            "prompt": "p",
            "mode": "img2img",
            "refs": 1,
            "inputAssetIds": ["b"],
            "status": "error",
        },
    ]
    out = history.dedupe_generation_history(items)
    assert len(out) == 2
    ok_one = next(i for i in out if i["status"] == "ok")
    assert ok_one["inputAssetIds"] == ["a"]


def test_dedupe_keeps_every_successful_generation():
    """成功记录不去重：同卡片同提示词同参考图连跑两次 → 两张图，历史就该有两行。

    回归（用户实测）：重复生成两次画布上出现两张图，历史面板却只有一条 —— 因为旧实现把
    同参数行（含成功）一并折叠成最新一条。产出与历史必须一一对应。
    """
    items = [
        {
            "time": "2026-10-29 23:22:14",
            "prompt": "p",
            "mode": "img2img",
            "refs": 1,
            "inputAssetIds": ["a"],
            "status": "ok",
            "output": "img2img_231943_009.png",
            "outputAssetIds": ["dd9c"],
        },
        {
            "time": "2026-10-29 23:18:01",
            "prompt": "p",
            "mode": "img2img",
            "refs": 1,
            "inputAssetIds": ["a"],
            "status": "ok",
            "output": "img2img_231548_008.png",
            "outputAssetIds": ["d79e"],
        },
    ]
    out = history.dedupe_generation_history(items)
    assert [i["output"] for i in out] == [
        "img2img_231943_009.png",
        "img2img_231548_008.png",
    ]


def test_dedupe_keeps_older_successes_around_a_later_failure():
    """成功之后的失败照实显示（最新一次没成），但更早的成功仍然各占一行。"""
    items = [
        {"time": "4", "prompt": "p", "status": "error"},
        {"time": "3", "prompt": "p", "status": "ok", "output": "b.png"},
        {"time": "2", "prompt": "p", "status": "error"},  # 更早的失败被最新那条失败吸收
        {"time": "1", "prompt": "p", "status": "ok", "output": "a.png"},
    ]
    out = history.dedupe_generation_history(items)
    assert [i["time"] for i in out] == ["4", "3", "1"]


def test_dedupe_missing_fields_tolerated():
    """旧行缺字段不炸：缺失字段按空值参与判定，同参聚合、异参保留。"""
    items = [
        {
            "time": "2",
            "prompt": "p",
            "status": "error",
        },  # 无 size/quality/mode/refs/inputAssetIds
        {"time": "1", "prompt": "p", "status": "error"},
        {"time": "0", "prompt": "q", "status": "ok"},
    ]
    out = history.dedupe_generation_history(items)
    assert [i["prompt"] for i in out] == ["p", "q"]


def test_read_history_paged_slices_after_dedupe(tmp_path, monkeypatch):
    """分页在聚合后切片：同参数多次失败先合并，offset 推进展示不同参数记录。"""
    path = _write_history(
        tmp_path,
        [
            {"time": "1", "prompt": "a", "status": "error"},
            {"time": "2", "prompt": "a", "status": "error"},  # 与上一条参数相同 → 合并
            {"time": "3", "prompt": "b", "status": "ok"},
            {"time": "4", "prompt": "c", "status": "ok"},
            {"time": "5", "prompt": "d", "status": "ok"},
            {"time": "6", "prompt": "e", "status": "ok"},
        ],
    )
    monkeypatch.setattr(history, "HISTORY_FILE", path)

    page1 = history.read_generation_history_paged(offset=0, limit=2)
    assert page1["total"] == 5  # 6 原始行聚合 → 5（a 只算最新一条）
    assert [p["prompt"] for p in page1["items"]] == ["e", "d"]

    page2 = history.read_generation_history_paged(offset=2, limit=2)
    assert [p["prompt"] for p in page2["items"]] == ["c", "b"]

    tail = history.read_generation_history_paged(offset=4, limit=2)
    assert [p["prompt"] for p in tail["items"]] == ["a"]
    assert tail["total"] == 5


def test_read_history_paged_respects_query_status_and_offset_overflow(
    tmp_path, monkeypatch
):
    """分页与搜索/状态筛选一致（筛选在聚合前）；offset 越界返回空页且 total 不变。"""
    path = _write_history(
        tmp_path,
        [
            {"time": "1", "prompt": "red shoes", "quality": "high", "status": "ok"},
            {"time": "2", "prompt": "blue bag", "quality": "low", "status": "error"},
            {"time": "3", "prompt": "red bag", "quality": "high", "status": "ok"},
        ],
    )
    monkeypatch.setattr(history, "HISTORY_FILE", path)

    page = history.read_generation_history_paged(
        offset=0, limit=10, query="red", status="ok"
    )
    assert page["total"] == 2
    assert [p["prompt"] for p in page["items"]] == ["red bag", "red shoes"]

    empty = history.read_generation_history_paged(offset=99, limit=10)
    assert empty["items"] == [] and empty["total"] == 3


def _write_hist(tmp_path, records):
    p = tmp_path / "generation.jsonl"
    p.write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in records) + "\n",
        encoding="utf-8",
    )
    return p


def test_backfill_output_asset_ids_report_only_does_not_write(
    asset_iso, tmp_path, monkeypatch
):
    """历史旧行补齐：默认只报告，不写文件。"""
    from core import registry

    src = asset_iso / "probe.png"
    src.write_bytes(b"asset-content")
    registry.register_asset(str(src), "probe.png")
    hist = _write_hist(tmp_path, [{"prompt": "p", "output": str(src)}])
    monkeypatch.setattr(history, "HISTORY_FILE", hist)
    before = hist.read_bytes()
    report = history.backfill_output_asset_ids()
    assert report["action"] == "report" and report["backfill"] == 1
    assert hist.read_bytes() == before


def test_backfill_output_asset_ids_apply_backs_up_and_idempotent(
    asset_iso, tmp_path, monkeypatch
):
    """apply：补齐 + 备份 + 行数不变 + 幂等（二次跑 backfill=0）。"""
    from core import registry

    src = asset_iso / "probe.png"
    src.write_bytes(b"asset-content-2")
    entry = registry.register_asset(str(src), "probe.png")
    hist = _write_hist(tmp_path, [{"prompt": "p", "output": str(src)}])
    monkeypatch.setattr(history, "HISTORY_FILE", hist)
    report = history.backfill_output_asset_ids(apply=True)
    assert report["action"] == "backfilled" and report["backfill"] == 1
    assert report["backup"] and os.path.isfile(report["backup"])
    lines = hist.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1
    rec = json.loads(lines[0])
    assert rec["outputAssetIds"] == [entry["id"]]
    assert rec["prompt"] == "p"
    second = history.backfill_output_asset_ids(apply=True)
    assert second["backfill"] == 0 and second["already"] == 1


def test_backfill_output_asset_ids_skips_missing_file_and_unregistered(
    asset_iso, tmp_path, monkeypatch
):
    """无法反查的行（文件缺失 / 注册表无该内容）跳过且计数，不被伪造。"""
    from core import registry

    src = asset_iso / "probe.png"
    src.write_bytes(b"content-missing")
    registry.register_asset(str(src), "probe.png")
    missing = tmp_path / "gone.png"
    missing.write_bytes(b"never-registered")
    hist = _write_hist(
        tmp_path,
        [
            {"prompt": "gone", "output": str(missing)},
            {"prompt": "deleted", "output": str(tmp_path / "nonexistent.png")},
        ],
    )
    monkeypatch.setattr(history, "HISTORY_FILE", hist)
    report = history.backfill_output_asset_ids(apply=True)
    assert report["action"] == "backfilled" and report["backfill"] == 0
    assert report["unable"] == 2
    for line in hist.read_text(encoding="utf-8").splitlines():
        assert "outputAssetIds" not in json.loads(line)


def test_backfill_output_asset_ids_keeps_corrupt_lines(
    asset_iso, tmp_path, monkeypatch
):
    """坏行原样保留、行数不变；好行照常补。"""
    from core import registry

    src = asset_iso / "probe.png"
    src.write_bytes(b"badline-content")
    registry.register_asset(str(src), "probe.png")
    hist = tmp_path / "generation.jsonl"
    hist.write_text(
        "{broken\n" + json.dumps({"prompt": "ok", "output": str(src)}) + "\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(history, "HISTORY_FILE", hist)
    before_lines = len(hist.read_text(encoding="utf-8").splitlines())
    history.backfill_output_asset_ids(apply=True)
    after_lines = hist.read_text(encoding="utf-8").splitlines()
    assert len(after_lines) == before_lines
    assert after_lines[0] == "{broken"

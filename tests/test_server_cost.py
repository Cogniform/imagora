#!/usr/bin/env python3
"""server.py 成本看板 + 预算保护 + 批量提交路由测试（不启动服务、不调真实上游）。

覆盖: /api/history/stats 聚合口径、/api/budget 读写、
/api/budget/check 预检、/api/generate 预算闸门（409 → 确认后放行）、
/api/generate/batch 批量提交（逐条跳过非法项、超预算未确认不提交、空 items 400）。
"""

import json
import sys
import time
from pathlib import Path

import pytest
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import server
from server import (
    check_budget_route,
    generate,
    generate_batch,
    get_budget,
    history_stats,
    set_budget,
)

TODAY = time.strftime("%Y-%m-%d")


# 1024x1024 单价从当前 profile 的 size_options 推导——不硬编码 0.05，
# 否则切换供应商 profile（价格不同）时这些预算断言会假失败。
#
# 必须写成函数而不是模块级常量：模块导入时 conftest 的隔离夹具还没跑，此时读到的是
# 开发机真实 .env 指向的 profile（可能是单价全 0 的自建来源），而用例执行时配置已被
# 拨回出厂目录 —— 两边不一致就会出现「本地红、CI 绿」。
def _unit() -> float:
    return server.size_cost("1024x1024")


def _ledger_row(status="ok", cost_value=0.05, size="1024x1024", prompt="p", day=None):
    return json.dumps(
        {
            "time": f"{day or TODAY} 09:00:00",
            "mode": "txt2img",
            "refs": 0,
            "prompt": prompt,
            "size": size,
            "quality": "high",
            "status": status,
            "cost": cost_value,
            "seconds": 12.0,
            "output": "",
        },
        ensure_ascii=False,
    )


@pytest.fixture
def ledger(cost_iso):
    """写一份受控账本（今日 2 成功 1 失败 + 昨天 1 成功）"""
    rows = [
        _ledger_row(),
        _ledger_row(cost_value=0.10, size="1152x2048"),
        _ledger_row(status="error", cost_value=0.0),
        _ledger_row(cost_value=0.20, day="2026-01-01"),
    ]
    Path(cost_iso / "generation.jsonl").write_text(
        "\n".join(rows) + "\n", encoding="utf-8"
    )
    return cost_iso


@pytest.fixture
def no_api(monkeypatch, tmp_path):
    """挡掉真实 API 与副作用：generate_image 伪成功（落 dest 文件）、日志/记忆空"""

    def fake_generate_image(**kwargs):
        Path(kwargs["output_path"]).write_bytes(b"generated")

    monkeypatch.setattr("server.generate_image", fake_generate_image)
    monkeypatch.setattr("server.log_generation", lambda **kw: None)
    monkeypatch.setattr("server.save_last_output_dir", lambda p: None)
    return tmp_path


def _wait_terminal(task_id, timeout=5):
    deadline = time.time() + timeout
    while time.time() < deadline:
        snap = server.task_manager.snapshot(task_id)
        if snap and snap["status"] in ("done", "failed", "cancelled"):
            return snap
        time.sleep(0.01)
    raise AssertionError(f"task {task_id} did not finish in time")


# ---------------- /api/history/stats ----------------


def test_history_stats_aggregates_raw_ledger(ledger):
    stats = history_stats()
    assert stats["total"] == 4
    assert stats["ok"] == 3 and stats["error"] == 1
    assert stats["cost"] == 0.35  # 0.05 + 0.10 + 0.20（失败行 0）
    assert stats["todayCost"] == 0.15
    assert stats["budget"]["spentToday"] == 0.15
    assert stats["budget"]["dailyLimit"] == 0.0


def test_history_stats_days_window(ledger):
    stats = history_stats(days=1)
    assert [row["date"] for row in stats["byDay"]] == [TODAY]


def test_history_stats_empty_ledger(cost_iso):
    stats = history_stats()
    assert stats["total"] == 0 and stats["cost"] == 0.0
    assert stats["budget"]["spentToday"] == 0.0


# ---------------- /api/budget ----------------


def test_budget_default_unlimited(ledger):
    assert get_budget() == {
        "dailyLimit": 0.0,
        "singleRunLimit": 0.0,
        "spentToday": 0.15,
        "remaining": 0.0,
    }


def test_budget_set_then_read(ledger):
    assert set_budget({"dailyLimit": 10, "singleRunLimit": 2})["ok"] is True
    got = get_budget()
    assert got["dailyLimit"] == 10.0 and got["singleRunLimit"] == 2.0
    assert got["spentToday"] == 0.15 and got["remaining"] == 9.85


# ---------------- /api/budget/check ----------------


def test_budget_check_by_count(ledger):
    # 预算按当前单价缩放：3 张预估 = 3*unit，日限设为略低于「预估+已花」以触发超限
    unit = _unit()
    set_budget({"dailyLimit": unit})  # 已花 unit（ledger）+ 预估 3*unit > unit
    result = check_budget_route({"count": 3, "size": "1024x1024"})
    assert result["estimate"] == pytest.approx(3 * unit)
    assert result["over"] is True and result["allowed"] is False
    assert "当日预算" in result["reason"]


def test_budget_check_by_items_allows_within_limit(ledger):
    set_budget({"dailyLimit": 100.0})
    result = check_budget_route(
        {"items": [{"size": "1024x1024"}, {"size": "1024x1024"}]}
    )
    assert (
        result["estimate"] == pytest.approx(2 * _unit())
        and result["over"] is False
        and result["allowed"] is True
    )


def test_budget_check_single_limit(ledger):
    set_budget({"singleRunLimit": _unit()})  # 单次上限 = 1 张单价
    assert check_budget_route({"count": 3, "size": "1024x1024"})["over"] is True
    assert check_budget_route({"count": 2, "size": "1024x1024"})["over"] is True
    assert check_budget_route({"count": 1, "size": "1024x1024"})["over"] is False


# ---------------- /api/generate 预算闸门 ----------------


def _submit(**overrides):
    """按 HTTP 语义调用 generate()（FastAPI 的 Form 默认值只在框架内解析，直调必须显式传）"""
    params = {
        "prompt": "hello",
        "size": "1024x1024",
        "quality": "high",
        "output_dir": "",
        "ref_paths": "",
        "images": [],
        "win": 0,
        "allow_over_budget": False,
    }
    params.update(overrides)
    return generate(**params)


def test_generate_blocked_over_budget_then_allowed_when_confirmed(
    no_api, asset_iso, ledger
):
    set_budget({"singleRunLimit": 0.01})
    with pytest.raises(HTTPException) as exc:
        _submit(output_dir=str(no_api / "out"))
    assert exc.value.status_code == 409
    assert "单次上限" in exc.value.detail["reason"]

    # 确认后放行：正常提交并跑完
    result = _submit(output_dir=str(no_api / "out"), allow_over_budget=True)
    snap = _wait_terminal(result["taskId"])
    assert snap["status"] == "done"


def test_generate_unlimited_budget_not_blocked(no_api, asset_iso, ledger):
    result = _submit(quality="low", output_dir=str(no_api / "out"))
    assert server.task_manager.snapshot(result["taskId"])["status"] in (
        "queued",
        "running",
        "done",
    )
    _wait_terminal(result["taskId"])


# ---------------- /api/generate/batch ----------------


def test_generate_batch_submits_valid_and_skips_invalid(
    no_api, asset_iso, ledger, monkeypatch, tmp_path
):
    refs = tmp_path / "refs"
    refs.mkdir()
    ref_file = refs / "ref_1.png"
    ref_file.write_bytes(b"ref")
    monkeypatch.setattr("server.REF_DIR", str(refs))

    body = {
        "items": [
            {
                "prompt": "a",
                "size": "1024x1024",
                "quality": "high",
                "refPaths": [str(ref_file)],
            },
            {"prompt": "   ", "size": "1024x1024", "quality": "high"},
            {
                "prompt": "b",
                "size": "1024x1024",
                "quality": "high",
                "refPaths": [str(tmp_path / "missing.png")],
            },
        ],
        "outputDir": str(no_api / "out"),
        "win": 3,
    }
    result = generate_batch(body)
    assert len(result["submitted"]) == 1
    assert result["submitted"][0]["size"] == "1024x1024"
    assert result["estimate"] == pytest.approx(_unit())
    reasons = [row["reason"] for row in result["skipped"]]
    assert any("提示词为空" in r for r in reasons)
    assert any("参考图不可用" in r for r in reasons)
    assert _wait_terminal(result["submitted"][0]["taskId"])["status"] == "done"


def test_generate_batch_empty_items_400():
    with pytest.raises(HTTPException) as exc:
        generate_batch({"items": []})
    assert exc.value.status_code == 400


def test_generate_batch_all_invalid_submits_nothing(no_api, asset_iso, ledger):
    result = generate_batch(
        {"items": [{"prompt": ""}], "outputDir": str(no_api / "out")}
    )
    assert result["submitted"] == [] and result["estimate"] == 0.0
    assert result["skipped"] and result["budget"]["over"] is False


def test_generate_batch_budget_block_submits_nothing(no_api, asset_iso, ledger):
    set_budget({"singleRunLimit": 0.01})
    with pytest.raises(HTTPException) as exc:
        generate_batch(
            {
                "items": [{"prompt": "a", "size": "1024x1024", "quality": "high"}],
                "outputDir": str(no_api / "out"),
            }
        )
    assert exc.value.status_code == 409
    assert "单次上限" in exc.value.detail["reason"]


def test_generate_batch_budget_confirmed_submits(no_api, asset_iso, ledger):
    set_budget({"singleRunLimit": 0.01})
    result = generate_batch(
        {
            "items": [{"prompt": "a", "size": "1024x1024", "quality": "high"}],
            "outputDir": str(no_api / "out"),
            "allowOverBudget": True,
        }
    )
    assert len(result["submitted"]) == 1
    assert result["budget"]["allowed"] is True
    _wait_terminal(result["submitted"][0]["taskId"])

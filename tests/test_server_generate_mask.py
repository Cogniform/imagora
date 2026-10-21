#!/usr/bin/env python3
"""server.py 的蒙版局部重绘（mask）参数链路测试（不启动服务、不调 API）

覆盖: /api/generate 接收 mask Form 并写进 GenerationTask、mask 不落盘（data URL 直传）、
run_generation 把 mask 传给 core/api.generate_image 并强制走图生图分支、
无参考图时 messages 记「蒙版重绘 · 无参考图」且不静默跳过。
"""

import base64
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import server
from server import generate

# 1x1 PNG；测试只关心「字符串原样透传」，不解析像素
_PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk"
    "+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)
_MASK_DATA_URL = "data:image/png;base64," + base64.b64encode(_PNG_BYTES).decode("ascii")


class _Recorded:
    """记录 generate_image 的调用 kwargs（并落一个假的输出文件）"""

    def __init__(self):
        self.calls: list[dict] = []

    def __call__(self, **kwargs):
        self.calls.append(kwargs)
        Path(kwargs["output_path"]).write_bytes(b"generated")

    @property
    def last(self) -> dict:
        assert self.calls, "generate_image 未被调用"
        return self.calls[-1]


@pytest.fixture
def recorded(monkeypatch):
    """挡掉真实 API：generate_image 记录 kwargs 伪成功，日志/记忆空"""
    rec = _Recorded()
    monkeypatch.setattr("server.generate_image", rec)
    monkeypatch.setattr("server.log_generation", lambda **kw: None)
    monkeypatch.setattr("server.save_last_output_dir", lambda p: None)
    return rec


def _submit(**overrides):
    """提交一个任务（默认文生图参数），overrides 覆盖 / 追加字段"""
    params = {
        "prompt": "repaint the sky",
        "size": "1024x1024",
        "quality": "low",
        "output_dir": "",
        "ref_paths": "",
        "images": [],
        "win": 0,
    }
    params.update(overrides)
    return generate(**params)


def test_generate_stores_mask_data_url_in_task(recorded):
    """mask Form -> 原样进 GenerationTask.mask_data_url（不落盘、不转 UploadFile）"""
    submitted = _submit(mask=_MASK_DATA_URL)
    task = server.task_manager._tasks[submitted["taskId"]]
    assert task.mask_data_url == _MASK_DATA_URL


def test_generate_mask_is_stripped(recorded):
    """mask 前后空白被 strip（multipart 传输偶尔带换行）"""
    submitted = _submit(mask=f"  {_MASK_DATA_URL}\n")
    task = server.task_manager._tasks[submitted["taskId"]]
    assert task.mask_data_url == _MASK_DATA_URL


def test_generate_without_mask_keeps_empty(recorded):
    """不传 mask -> 空串（默认值不影响既有文生图链路）"""
    submitted = _submit()
    task = server.task_manager._tasks[submitted["taskId"]]
    assert task.mask_data_url == ""


def test_run_generation_passes_mask_kwarg(recorded):
    """run_generation 把 mask 透传给 generate_image，并强制走图生图分支"""
    task = server.GenerationTask(
        prompt="repaint",
        size="1024x1024",
        quality="low",
        mask_data_url=_MASK_DATA_URL,
    )
    server.run_generation(task)

    kwargs = recorded.last
    assert kwargs["mask_data_url"] == _MASK_DATA_URL
    # 强制图生图：即使没有底图也不能落到文生图分支（否则 mask 静默丢失）
    assert kwargs.get("images") is None
    assert task.results and task.results[0]["status"] == "ok"
    assert task.messages[0] == "蒙版重绘 · 无参考图"
    assert Path(task.results[0]["message"].removeprefix("已保存: ")).name.startswith(
        "img2img_"
    ), task.results[0]["message"]


def test_run_generation_mask_with_base_mentions_ref_count(recorded, tmp_path):
    """有底图 + mask -> 消息记「蒙版重绘 · 参考图 N 张」，底图作为 images 传下去"""
    base = tmp_path / "base.png"
    base.write_bytes(_PNG_BYTES)
    task = server.GenerationTask(
        prompt="repaint",
        size="1024x1024",
        quality="low",
        ref_bases=[str(base)],
        mask_data_url=_MASK_DATA_URL,
    )
    server.run_generation(task)

    kwargs = recorded.last
    assert kwargs["images"] == [str(base)]
    assert kwargs["mask_data_url"] == _MASK_DATA_URL
    assert task.messages[0] == "蒙版重绘 · 参考图 1 张"


def test_run_generation_without_mask_unchanged(recorded):
    """无 mask -> 仍走文生图分支，且不传 mask_data_url（不引入空参数）"""
    task = server.GenerationTask(prompt="plain", size="1024x1024", quality="low")
    server.run_generation(task)

    kwargs = recorded.last
    assert "mask_data_url" not in kwargs or not kwargs["mask_data_url"]
    assert kwargs.get("image_path") is None
    assert task.messages[0] == "文生图"


def test_run_generation_mask_without_base_surfaces_clear_error(monkeypatch):
    """无底图 + mask -> 不静默跳过：错误从 core/api.py 冒出来并进 messages

    这里刻意用**真实的** core.api.generate_image（只挡掉网络），断言它抛的那句中文
    错误能一路走到任务的 error / messages —— 这正是「不在这里静默跳过」的验收点。
    """
    import core.api as core_api

    def no_network(*args, **kwargs):  # pragma: no cover - 触达即失败
        raise AssertionError("mask 缺底图时不应发出任何请求")

    monkeypatch.setattr(core_api.requests, "post", no_network)
    monkeypatch.setattr(core_api, "get_api_key", lambda: "sk-test-placeholder")
    monkeypatch.setattr("server.log_generation", lambda **kw: None)
    monkeypatch.setattr("server.save_last_output_dir", lambda p: None)

    task = server.GenerationTask(
        prompt="repaint",
        size="1024x1024",
        quality="low",
        mask_data_url=_MASK_DATA_URL,
    )
    server.run_generation(task)

    assert task.error and "mask 需要至少一张底图" in task.error
    assert task.results[0]["status"] == "error"
    assert any("蒙版重绘 · 无参考图" in m for m in task.messages)

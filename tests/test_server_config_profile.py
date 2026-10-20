"""Profile 切换：写 ACTIVE_PROFILE + 校验已注册 + 计入 pending。

补在既有配置写入测试之后（同一路由，同一条 .env 写入路径）。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import HTTPException

import core.config as config
from server import get_config, write_config

SAMPLE_ENV = "# 我的注释\nAPI_KEY_WANWU=sk-old\n"
PROFILE = {
    "base_url": "https://factory.example",
    "default_model": "factory-m",
    "api_paths": {"generations": "/g", "edits": "/e"},
}


@pytest.fixture
def env(tmp_path: Path, monkeypatch):
    env_file = tmp_path / ".env"
    env_file.write_text(SAMPLE_ENV, encoding="utf-8")
    monkeypatch.setattr(config, "ENV_FILE_PATH", env_file)
    monkeypatch.setattr(config, "WORK_ROOT", tmp_path)
    monkeypatch.setattr(config, "_CONFIG_FILE", tmp_path / "config.json")
    monkeypatch.setattr(config, "ACTIVE_PROFILE", "wanwu")
    monkeypatch.setattr(config, "_profile", PROFILE)
    monkeypatch.setattr(config, "_ENV_FILE_KEYS", set())
    # 替换 describe_config 的注册名单来源：build_profile_view 读 cfg 的 profiles
    monkeypatch.setattr(
        config, "_cfg", {"profiles": {"wanwu": PROFILE, "volc": {}, "other": {}}}
    )
    for key in (
        "BASE_URL_WANWU",
        "MODEL_WANWU",
        "API_PATH_WANWU",
        "API_KEY_WANWU",
        "ACTIVE_PROFILE",
    ):
        monkeypatch.delenv(key, raising=False)
    return env_file


def test_切profile写入ACTIVE_PROFILE(env):
    body = write_config({"profile": "wanwu", "changes": {"profile": "volc"}})
    assert body["ok"] is True
    assert "profile" in body["written"]
    text = env.read_text(encoding="utf-8")
    assert "ACTIVE_PROFILE=volc" in text
    assert "# 我的注释" in text  # 注释保留
    assert "API_KEY_WANWU=sk-old" in text  # 未改的键保留


def test_未注册的profile被拒(env):
    before = env.read_text(encoding="utf-8")
    with pytest.raises(HTTPException) as ei:
        write_config({"profile": "wanwu", "changes": {"profile": "nope"}})
    assert ei.value.status_code == 400
    assert ei.value.detail["error"] == "invalid_profile"
    assert env.read_text(encoding="utf-8") == before  # 未写入


def test_profile非字符串被拒(env):
    with pytest.raises(HTTPException) as ei:
        write_config({"profile": "wanwu", "changes": {"profile": 123}})
    assert ei.value.status_code == 400
    assert ei.value.detail["error"] == "invalid_value"


def test_切profile计入pending(env):
    body = write_config({"profile": "wanwu", "changes": {"profile": "volc"}})
    # 文件里已改、进程还跑在 wanwu 上 → 待重启
    assert "profile" in body["pending"]
    assert body["fileState"]["profile"] == "wanwu"  # 生效值
    assert body["fileState"]["fileProfile"] == "volc"  # 文件值


def test_切换profile与字段可同一次写入(env):
    """同一次请求既切 profile 又改字段时，字段必须写**新** profile 的键。

    踩过的坑：用当前生效的 profile 拼键，会得到「ACTIVE_PROFILE 指向 volc，
    但模型覆盖落在 MODEL_WANWU」—— 切过去之后那个覆盖对不上任何生效的键，
    表现为「切换成功但模型没变」。
    """
    body = write_config(
        {"profile": "wanwu", "changes": {"profile": "volc", "model": "some-model"}}
    )
    assert sorted(body["written"]) == ["model", "profile"]
    text = env.read_text(encoding="utf-8")
    assert "ACTIVE_PROFILE=volc" in text
    assert "MODEL_VOLC=some-model" in text  # 跟**选中**的 profile
    assert "MODEL_WANWU" not in text  # 不能落到即将失效的那一套上


def test_fileState_下发注册名单(env):
    fs = get_config(None)["fileState"]
    assert fs["registeredProfiles"] == ["other", "volc", "wanwu"]  # 排序后
    assert fs["profile"] == "wanwu"
    assert fs["fileProfile"] == "wanwu"  # .env 没写 ACTIVE_PROFILE → 等于生效值


def test_fileState_文件里的profile与生效值不同时也报出来(env, monkeypatch):
    env.write_text("ACTIVE_PROFILE=volc\n", encoding="utf-8")
    fs = get_config(None)["fileState"]
    assert fs["profile"] == "wanwu"  # 进程仍在 wanwu
    assert fs["fileProfile"] == "volc"  # 文件已改
    assert "profile" in fs["pending"]

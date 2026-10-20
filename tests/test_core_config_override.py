#!/usr/bin/env python3
"""本机覆盖通道（.env → base_url / default_model / api_paths）的单测。

最重要的不变量：**环境变量一个都没设时，行为与改动前逐字相同**。
这是配置界面敢把"出厂目录"和"本机覆盖"分开的前提。
"""

import pytest

import core.config as config

PROFILE = {
    "base_url": "https://factory.example.com",
    "default_model": "factory-model",
    "api_paths": {"generations": "/g", "edits": "/e"},
    "size_options": [{"value": "1024x1024", "label": "1K", "cost": 0.1}],
    "quality_options": ["low", "high"],
    "ratios": {"1:1": {"1K": "1024x1024"}},
}

ALL_ENV_KEYS = ("BASE_URL_WANWU", "MODEL_WANWU", "API_PATH_WANWU")


@pytest.fixture
def isolated(monkeypatch, tmp_path):
    """干净起点：固定 profile，四个覆盖键全部未设，且都不在 .env 键集合里。"""
    monkeypatch.setattr(config, "ACTIVE_PROFILE", "wanwu")
    monkeypatch.setattr(config, "_profile", PROFILE)
    monkeypatch.setattr(config, "_ENV_FILE_KEYS", set())
    for key in ALL_ENV_KEYS:
        monkeypatch.delenv(key, raising=False)
    return tmp_path


# ------------------------------------------------------------ 未设覆盖时行为不变


def test_未设环境变量时回落到profile(isolated):
    assert config._get("base_url") == PROFILE["base_url"]
    assert config._get("default_model") == PROFILE["default_model"]
    assert config._get("api_paths") == {"generations": "/g", "edits": "/e"}


def test_profile缺键时回落到内置默认(isolated, monkeypatch):
    monkeypatch.setattr(config, "_profile", {})
    assert config._get("base_url") == config._DEFAULTS["base_url"]
    assert config._get("default_model") == config._DEFAULTS["default_model"]


def test_未设覆盖时来源标注是profile(isolated):
    assert config.source_of_value("base_url") == "config.json profile"
    assert config.source_of_value("default_model") == "config.json profile"
    assert config.source_of_value("api_paths") == "config.json profile"


def test_profile也没有该键时来源标注是内置默认(isolated, monkeypatch):
    monkeypatch.setattr(config, "_profile", {})
    assert config.source_of_value("base_url") == "内置默认"


# ------------------------------------------------------------ 覆盖生效


def test_覆盖只影响自己那一个键(isolated, monkeypatch):
    monkeypatch.setenv("BASE_URL_WANWU", "https://mine.example.com")
    assert config._get("base_url") == "https://mine.example.com"
    # 其余键必须原样不动
    assert config._get("default_model") == PROFILE["default_model"]
    assert config._get("api_paths") == {"generations": "/g", "edits": "/e"}


def test_覆盖只对当前profile生效(isolated, monkeypatch):
    monkeypatch.setenv("BASE_URL_OTHER", "https://other.example.com")
    assert config._get("base_url") == PROFILE["base_url"]


def test_换profile后覆盖跟着换(isolated, monkeypatch):
    monkeypatch.setenv("BASE_URL_WANWU", "https://wanwu.example.com")
    monkeypatch.setenv("BASE_URL_VOLC", "https://volc.example.com")
    assert config._get("base_url") == "https://wanwu.example.com"
    monkeypatch.setattr(config, "ACTIVE_PROFILE", "volc")
    assert config._get("base_url") == "https://volc.example.com"


def test_空值视为未设置_回落到profile(isolated, monkeypatch):
    """空白不是"配了个空地址"——宁可回出厂值。"""
    for blank in ("", "   ", "\t"):
        monkeypatch.setenv("BASE_URL_WANWU", blank)
        assert config._get("base_url") == PROFILE["base_url"]
    assert config.source_of_value("base_url") == "config.json profile"


def test_值里的首尾空白被去掉(isolated, monkeypatch):
    monkeypatch.setenv("MODEL_WANWU", "  spaced-model  ")
    assert config._get("default_model") == "spaced-model"


def test_路径覆盖同时用于generations与edits(isolated, monkeypatch):
    """界面只暴露「接口路径」一项，所以两处一起改（否则会出现用户看不见的差异）。"""
    monkeypatch.setenv("API_PATH_WANWU", "/v1/unified")
    assert config._get("api_paths") == {
        "generations": "/v1/unified",
        "edits": "/v1/unified",
    }


# ------------------------------------------------------------ 来源标注


def test_来自env文件的覆盖标注带文件名(isolated, monkeypatch):
    monkeypatch.setenv("BASE_URL_WANWU", "https://mine.example.com")
    monkeypatch.setattr(config, "_ENV_FILE_KEYS", {"BASE_URL_WANWU"})
    assert config.source_of_value("base_url") == ".env BASE_URL_WANWU"


def test_来自系统环境变量的覆盖标注不谎称env(isolated, monkeypatch):
    """系统环境变量优先于 .env，删掉 .env 那行它也不会消失——标注必须如实反映。"""
    monkeypatch.setenv("BASE_URL_WANWU", "https://from-system.example.com")
    monkeypatch.setattr(config, "_ENV_FILE_KEYS", set())
    assert config.source_of_value("base_url") == "环境变量 BASE_URL_WANWU"


def test_删掉env那行后回到profile(isolated, monkeypatch):
    """你关心的场景：把 .env 里的覆盖行删掉，来源与取值都回到 config.json profile。"""
    monkeypatch.setenv("BASE_URL_WANWU", "https://mine.example.com")
    monkeypatch.setattr(config, "_ENV_FILE_KEYS", {"BASE_URL_WANWU"})
    assert config.source_of_value("base_url") == ".env BASE_URL_WANWU"

    monkeypatch.delenv("BASE_URL_WANWU")  # 删行后的重启效果
    monkeypatch.setattr(config, "_ENV_FILE_KEYS", set())
    assert config._get("base_url") == PROFILE["base_url"]
    assert config.source_of_value("base_url") == "config.json profile"


def test_覆盖键名按profile大写(isolated, monkeypatch):
    assert config.env_override_name("base_url") == "BASE_URL_WANWU"
    assert config.env_override_name("default_model") == "MODEL_WANWU"
    assert config.env_override_name("api_paths") == "API_PATH_WANWU"


def test_非覆盖键没有环境变量名(isolated):
    for key in ("size_options", "ratios", "quality_options", "models"):
        assert config.env_override_name(key) is None


def test_无active_profile时没有覆盖(isolated, monkeypatch):
    monkeypatch.setattr(config, "ACTIVE_PROFILE", None)
    monkeypatch.setenv("BASE_URL_WANWU", "https://mine.example.com")
    assert config._get("base_url") == PROFILE["base_url"]

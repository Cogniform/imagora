#!/usr/bin/env python3
"""配置写入路由的测试：三层防护、mtime 冲突、写入正确性、密钥 write-only。

调用方式与既有 server 测试一致：**直接调路由函数**（本项目不装 httpx，没有 TestClient）。
这意味着 request.client 那一层由 core/config_guard.py 的纯函数单独测；
本文件测的是"过了防护之后"的业务逻辑，以及防护纯函数本身。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import HTTPException

import core.config as config
import core.config_guard as guard
from server import clear_config_secret, get_config, write_config

SAMPLE_ENV = "# 我的注释\n\nAPI_KEY_WANWU=sk-old\n# 保留我\n"

PROFILE = {
    "base_url": "https://factory.example",
    "default_model": "factory-m",
    "api_paths": {"generations": "/g", "edits": "/e"},
}


@pytest.fixture
def env(tmp_path: Path, monkeypatch):
    """隔离到临时目录：不碰真实 .env / config.json。"""
    env_file = tmp_path / ".env"
    env_file.write_text(SAMPLE_ENV, encoding="utf-8")
    monkeypatch.setattr(config, "ENV_FILE_PATH", env_file)
    monkeypatch.setattr(config, "WORK_ROOT", tmp_path)
    monkeypatch.setattr(config, "_CONFIG_FILE", tmp_path / "config.json")
    monkeypatch.setattr(config, "ACTIVE_PROFILE", "wanwu")
    monkeypatch.setattr(config, "_profile", PROFILE)
    monkeypatch.setattr(config, "_ENV_FILE_KEYS", set())
    for key in ("BASE_URL_WANWU", "MODEL_WANWU", "API_PATH_WANWU", "API_KEY_WANWU"):
        monkeypatch.delenv(key, raising=False)
    return env_file


def _detail(exc_info) -> dict:
    return exc_info.value.detail


# ------------------------------------------------------------ 防护层纯函数


def test_is_loopback_只认本机():
    assert guard.is_loopback("127.0.0.1")
    assert guard.is_loopback("::1")
    assert not guard.is_loopback("192.168.1.10")
    assert not guard.is_loopback("8.8.8.8")


class _Req:
    """最小请求替身：只在防护函数用到 headers / method / client 三个属性。"""

    def __init__(self, *, origin=None, token=None, host="127.0.0.1", method="POST"):
        self.headers = {}
        if origin:
            self.headers["origin"] = origin
        if token:
            self.headers[guard.TOKEN_HEADER.lower()] = token
        self.method = method
        self.client = type("C", (), {"host": host})()
        self.url = type("U", (), {"path": "/api/config"})()


def test_origin_白名单():
    assert guard.origin_allowed(_Req(origin=None))  # 非浏览器客户端
    assert guard.origin_allowed(_Req(origin="http://127.0.0.1:7860"))
    assert guard.origin_allowed(_Req(origin="http://localhost:7860"))
    assert not guard.origin_allowed(_Req(origin="http://evil.example.com"))
    assert not guard.origin_allowed(_Req(origin="https://attacker.test"))


def test_令牌比对():
    assert guard.token_valid(_Req(token=guard.CONFIG_TOKEN))
    assert not guard.token_valid(_Req(token="wrong"))
    assert not guard.token_valid(_Req())


def test_令牌足够长且不落盘():
    assert len(guard.CONFIG_TOKEN) >= 32
    # 令牌只存在于进程内：模块不该把它写进任何文件
    import core.config_guard as mod

    src = Path(mod.__file__).read_text(encoding="utf-8")
    assert "CONFIG_TOKEN = secrets.token_urlsafe" in src
    assert 'CONFIG_TOKEN = "' not in src


def test_非本机来源直接403():
    denied = guard.guard_config_write(_Req(host="192.168.1.10"))
    assert denied is not None and denied.status_code == 403
    assert b"forbidden_host" in denied.body


def test_恶意origin被挡():
    denied = guard.guard_config_write(
        _Req(origin="http://evil.example.com", token=guard.CONFIG_TOKEN)
    )
    assert denied is not None and denied.status_code == 403
    assert b"forbidden_origin" in denied.body


def test_缺令牌被挡():
    denied = guard.guard_config_write(_Req(origin="http://127.0.0.1:7860"))
    assert denied is not None and denied.status_code == 403
    assert b"forbidden_token" in denied.body


def test_三层全过则放行():
    assert (
        guard.guard_config_write(
            _Req(origin="http://127.0.0.1:7860", token=guard.CONFIG_TOKEN)
        )
        is None
    )


def test_GET不校验令牌():
    """首屏必须能加载：GET 只校验本机绑定。"""
    assert guard.guard_config_write(_Req(method="GET", host="127.0.0.1")) is None


def test_profile_名挡住路径穿越():
    root = Path("/tmp/app")
    for bad in ("../evil", "a/b", "", "a b", "a.b"):
        with pytest.raises(ValueError):
            guard.safe_profile_path(root, bad)
    assert guard.safe_profile_path(root, "my-profile_1").name == ".env"


def test_覆盖键名沿用既有约定():
    assert guard.profile_env_names("wanwu") == {
        "baseUrl": "BASE_URL_WANWU",
        "apiPath": "API_PATH_WANWU",
        "model": "MODEL_WANWU",
        "apiKey": "API_KEY_WANWU",
    }


# ------------------------------------------------------------ GET /api/config


def test_get_config_不回传密钥值(env):
    body = get_config(None)
    fs = body["fileState"]
    assert fs["fields"]["apiKey"]["configured"] is True
    assert "value" not in fs["fields"]["apiKey"]  # 只报 configured，绝不回传值
    assert "sk-old" not in str(body)
    assert fs["mtimes"]["env"] is not None


def test_令牌响应头由中间件挂载(env):
    """令牌下发在中间件里（不改变 get_config 签名——它被既有测试直调）。"""
    import inspect

    import server

    src = inspect.getsource(server.ConfigGuardMiddleware.dispatch)
    assert "token_response_header" in src
    assert "GET" in src
    # 路由签名保持只有一个可选参数
    params = list(inspect.signature(get_config).parameters)
    assert params == ["win"], params


# ------------------------------------------------------------ 写：正常路径


def test_写地址_行级更新且注释保留(env):
    body = write_config(
        {"profile": "wanwu", "changes": {"baseUrl": "https://mine.example"}}
    )
    assert body["ok"] is True
    assert "baseUrl" in body["written"]

    text = env.read_text(encoding="utf-8")
    assert "BASE_URL_WANWU=https://mine.example" in text
    assert "# 我的注释" in text  # 注释保留
    assert "# 保留我" in text
    assert "API_KEY_WANWU=sk-old" in text  # 未改的键保留


def test_留空等于不修改(env):
    before = env.read_text(encoding="utf-8")
    body = write_config({"profile": "wanwu", "changes": {"apiKey": "", "model": "   "}})
    assert body["written"] == []
    assert env.read_text(encoding="utf-8") == before


def test_写值会留备份(env):
    write_config({"profile": "wanwu", "changes": {"model": "gpt-image"}})
    assert (env.parent / ".env.bak").exists()
    assert "sk-old" in (env.parent / ".env.bak").read_text(encoding="utf-8")


def test_pending_在写入后报出该字段(env):
    body = write_config(
        {"profile": "wanwu", "changes": {"baseUrl": "https://mine.example"}}
    )
    assert "baseUrl" in body["pending"]
    assert body["fileState"]["fields"]["baseUrl"]["fileValue"] == "https://mine.example"


def test_多个键一次写完(env):
    body = write_config(
        {"profile": "wanwu", "changes": {"baseUrl": "https://a.example", "model": "m2"}}
    )
    assert sorted(body["written"]) == ["baseUrl", "model"]
    text = env.read_text(encoding="utf-8")
    assert "BASE_URL_WANWU=https://a.example" in text
    assert "MODEL_WANWU=m2" in text


# ------------------------------------------------------------ 写：校验


def test_非法地址被拒且不落盘(env):
    before = env.read_text(encoding="utf-8")
    with pytest.raises(HTTPException) as ei:
        write_config({"profile": "wanwu", "changes": {"baseUrl": "ftp://x"}})
    assert ei.value.status_code == 400
    assert _detail(ei)["error"] == "invalid_value"
    assert env.read_text(encoding="utf-8") == before


def test_非法路径被拒(env):
    with pytest.raises(HTTPException) as ei:
        write_config({"profile": "wanwu", "changes": {"apiPath": "v1/x"}})
    assert ei.value.status_code == 400
    assert _detail(ei)["error"] == "invalid_value"


def test_非法profile被拒(env):
    with pytest.raises(HTTPException) as ei:
        write_config({"profile": "../evil", "changes": {"model": "m"}})
    assert ei.value.status_code == 400
    assert _detail(ei)["error"] == "invalid_profile"


def test_changes_非对象被拒(env):
    with pytest.raises(HTTPException) as ei:
        write_config({"profile": "wanwu", "changes": "nope"})
    assert ei.value.status_code == 400


def test_值非字符串被拒(env):
    with pytest.raises(HTTPException) as ei:
        write_config({"profile": "wanwu", "changes": {"model": 123}})
    assert ei.value.status_code == 400


# ------------------------------------------------------------ 写：mtime 冲突


def test_mtime_不匹配时409且磁盘不变(env):
    before = env.read_text(encoding="utf-8")
    with pytest.raises(HTTPException) as ei:
        write_config(
            {
                "profile": "wanwu",
                "changes": {"baseUrl": "https://mine.example"},
                "expectedMtimes": {"env": 1234567.0},  # 陈旧
            }
        )
    assert ei.value.status_code == 409
    assert _detail(ei)["error"] == "stale_file"
    assert env.read_text(encoding="utf-8") == before  # 绝不写入


def test_mtime_匹配时正常写入(env):
    mtime = env.stat().st_mtime
    body = write_config(
        {
            "profile": "wanwu",
            "changes": {"model": "gpt-image"},
            "expectedMtimes": {"env": mtime},
        }
    )
    assert body["ok"] is True
    assert "MODEL_WANWU=gpt-image" in env.read_text(encoding="utf-8")


def test_不带expectedMtimes时视为首次写入(env):
    write_config({"profile": "wanwu", "changes": {"model": "m1"}})
    assert "MODEL_WANWU=m1" in env.read_text(encoding="utf-8")


# ------------------------------------------------------------ 清空密钥


def test_清空密钥需要confirm(env):
    with pytest.raises(HTTPException) as ei:
        clear_config_secret({"profile": "wanwu"})
    assert ei.value.status_code == 400


def test_清空密钥是注释掉而不是删除(env):
    body = clear_config_secret({"profile": "wanwu", "confirm": True})
    assert body["ok"] is True
    assert body["cleared"] == "apiKey"
    text = env.read_text(encoding="utf-8")
    assert "# API_KEY_WANWU=sk-old" in text  # 值还在，只是被注释
    assert "\nAPI_KEY_WANWU=" not in text
    assert "sk-old" not in str(body)  # 响应不回传原值


def test_清空后fileState报未配置(env):
    clear_config_secret({"profile": "wanwu", "confirm": True})
    fs = get_config(None)["fileState"]
    assert fs["fields"]["apiKey"]["configured"] is False

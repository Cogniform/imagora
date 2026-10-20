"""第三方来源路由：新增来源 / 探测模型 / 守卫继承。

这一层只测「路由把参数交给 provider_store 与 core.api 之后怎么整形响应」，
校验细节在 tests/test_core_provider_store.py。分开放是为了失败时一眼看出
是「校验错了」还是「路由接线错了」。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import HTTPException

import core.config as config
import server
from server import (
    add_config_provider,
    delete_config_provider,
    probe_config_provider,
)

PROFILE = {
    "base_url": "https://factory.example",
    "default_model": "factory-m",
    "api_paths": {"generations": "/g", "edits": "/e"},
    "size_options": [{"value": "1024x1024", "label": "1:1", "cost": 0.05}],
    "ratios": {"1:1": {"1K": "1024x1024"}},
}


@pytest.fixture
def env(tmp_path: Path, monkeypatch):
    """把三处落盘位置全部指向 tmp，并抹掉真实环境变量。"""
    env_file = tmp_path / ".env"
    env_file.write_text("# 我的注释\nAPI_KEY_WANWU=sk-old\n", encoding="utf-8")
    local_file = tmp_path / "providers.local.json"
    monkeypatch.setattr(config, "ENV_FILE_PATH", env_file)
    monkeypatch.setattr(config, "WORK_ROOT", tmp_path)
    monkeypatch.setattr(config, "_CONFIG_FILE", tmp_path / "config.json")
    monkeypatch.setattr(config, "LOCAL_PROVIDERS_FILE", local_file)
    monkeypatch.setattr(config, "ACTIVE_PROFILE", "wanwu")
    monkeypatch.setattr(config, "_profile", PROFILE)
    monkeypatch.setattr(config, "_ENV_FILE_KEYS", set())
    monkeypatch.setattr(config, "_cfg", {"profiles": {"wanwu": PROFILE}})
    # reload_config 会重读盘：桩掉，避免测试里真去读 tmp 下的空 config.json
    monkeypatch.setattr(config, "reload_config", lambda: None)
    for key in ("ACTIVE_PROFILE", "API_KEY_WANWU", "API_KEY_ACME"):
        monkeypatch.delenv(key, raising=False)
    return tmp_path


def _payload(**overrides) -> dict:
    base = {
        "name": "acme",
        "label": "Acme 中转",
        "baseUrl": "https://gateway.example/v1",
        "protocol": "openai",
        "model": "gpt-image-2.5",
    }
    base.update(overrides)
    return base


# ---------- 新增来源 ----------


def test_add_writes_local_file(env):
    body = add_config_provider(_payload())
    assert body["ok"] is True
    assert body["name"] == "acme"
    path = env / "providers.local.json"
    doc = json.loads(path.read_text(encoding="utf-8"))
    assert doc["profiles"]["acme"]["base_url"] == "https://gateway.example/v1"


def test_add_does_not_touch_config_json(env):
    """出厂目录必须保持只读：界面永不写 config.json。"""
    add_config_provider(_payload())
    assert not (env / "config.json").exists()


def test_add_writes_key_to_env(env):
    add_config_provider(_payload(apiKey="sk-acme-secret"))
    text = (env / ".env").read_text(encoding="utf-8")
    assert "API_KEY_ACME=sk-acme-secret" in text
    assert "# 我的注释" in text  # 既有注释保留
    assert "API_KEY_WANWU=sk-old" in text  # 既有键保留


def test_add_key_never_lands_in_local_file(env):
    """密钥只进 .env：providers.local.json 里出现 sk- 就是分层被破坏。"""
    add_config_provider(_payload(apiKey="sk-acme-secret"))
    text = (env / "providers.local.json").read_text(encoding="utf-8")
    assert "sk-acme-secret" not in text


def test_add_without_key_leaves_env_alone(env):
    before = (env / ".env").read_text(encoding="utf-8")
    add_config_provider(_payload())
    assert (env / ".env").read_text(encoding="utf-8") == before


def test_add_does_not_activate_by_default(env):
    """默认不切换：新建来源只是让目录多一条，换 profile 是另一件事。"""
    add_config_provider(_payload(apiKey="sk-x"))
    text = (env / ".env").read_text(encoding="utf-8")
    assert "ACTIVE_PROFILE=acme" not in text


def test_add_can_activate_explicitly(env):
    add_config_provider(_payload(activate=True))
    text = (env / ".env").read_text(encoding="utf-8")
    assert "ACTIVE_PROFILE=acme" in text


def test_add_rejects_bad_name(env):
    with pytest.raises(HTTPException) as exc:
        add_config_provider(_payload(name="Acme Gateway"))
    assert exc.value.status_code == 400
    assert exc.value.detail["error"] == "invalid_value"


def test_add_rejects_bad_url(env):
    with pytest.raises(HTTPException) as exc:
        add_config_provider(_payload(baseUrl="gateway.example"))
    assert exc.value.status_code == 400


def test_add_rejects_duplicate(env):
    add_config_provider(_payload())
    with pytest.raises(HTTPException) as exc:
        add_config_provider(_payload())
    assert exc.value.status_code == 400
    assert "已存在" in exc.value.detail["reason"]


def test_add_rejects_clash_with_factory_profile(env):
    """与 config.json 的出厂来源重名 → 拒绝，不能静默遮住出厂配置。"""
    with pytest.raises(HTTPException) as exc:
        add_config_provider(_payload(name="wanwu"))
    assert exc.value.status_code == 400


def test_add_response_carries_file_state(env):
    body = add_config_provider(_payload(apiKey="sk-x"))
    state = body["fileState"]
    assert state["profile"] == "wanwu"
    assert "envNames" in state
    assert body["pending"] == state["pending"]


def test_add_activate_marks_pending(env):
    """切换 profile 属「改了要重启」，pending 必须带 profile —— 界面据此提示。"""
    body = add_config_provider(_payload(activate=True))
    assert "profile" in body["pending"]


def test_add_tolerates_empty_body(env):
    with pytest.raises(HTTPException):
        add_config_provider({})


def test_add_tolerates_non_dict_body(env):
    with pytest.raises(HTTPException):
        add_config_provider(["not", "a", "dict"])


# ---------- 探测模型 ----------


def test_probe_returns_models(env, monkeypatch):
    monkeypatch.setattr(
        server, "list_models", lambda url, key: ["gpt-image-2", "dall-e-3"]
    )
    body = probe_config_provider({"baseUrl": "https://gateway.example/v1"})
    assert body["ok"] is True
    assert [m["id"] for m in body["models"]] == ["gpt-image-2", "dall-e-3"]


def test_probe_passes_url_and_key(env, monkeypatch):
    seen = {}

    def fake(url, key):
        seen["url"] = url
        seen["key"] = key
        return []

    monkeypatch.setattr(server, "list_models", fake)
    probe_config_provider(
        {"baseUrl": "https://gateway.example/v1/", "apiKey": "sk-probe"}
    )
    assert seen["url"] == "https://gateway.example/v1"  # 末尾斜杠已去掉
    assert seen["key"] == "sk-probe"


def test_probe_falls_back_to_saved_key(env, monkeypatch):
    """没填密钥时按 name 去环境变量里找已有的 API_KEY_<NAME>。"""
    monkeypatch.setenv("API_KEY_ACME", "sk-saved")
    seen = {}
    monkeypatch.setattr(
        server, "list_models", lambda url, key: seen.update(key=key) or []
    )
    probe_config_provider({"baseUrl": "https://gateway.example/v1", "name": "acme"})
    assert seen["key"] == "sk-saved"


def test_probe_without_key_still_tries(env, monkeypatch):
    """没有密钥也要发（本地服务常无需鉴权），不能提前拦。"""
    seen = {}
    monkeypatch.setattr(
        server, "list_models", lambda url, key: seen.update(key=key) or []
    )
    probe_config_provider({"baseUrl": "https://gateway.example/v1"})
    assert seen["key"] == ""


def test_probe_rejects_bad_url(env):
    with pytest.raises(HTTPException) as exc:
        probe_config_provider({"baseUrl": "not-a-url"})
    assert exc.value.status_code == 400
    assert exc.value.detail["error"] == "invalid_value"


def test_probe_wraps_network_error(env, monkeypatch):
    def boom(url, key):
        raise RuntimeError("连接不上该地址：ConnectionError: refused")

    monkeypatch.setattr(server, "list_models", boom)
    with pytest.raises(HTTPException) as exc:
        probe_config_provider({"baseUrl": "https://gateway.example/v1"})
    assert exc.value.status_code == 400
    assert exc.value.detail["error"] == "probe_failed"
    assert "连接不上" in exc.value.detail["reason"]


def test_probe_writes_nothing(env, monkeypatch):
    """探测是只读操作：不落盘、不改 .env。"""
    monkeypatch.setattr(server, "list_models", lambda url, key: ["m"])
    before = (env / ".env").read_text(encoding="utf-8")
    probe_config_provider({"baseUrl": "https://gateway.example/v1"})
    assert (env / ".env").read_text(encoding="utf-8") == before
    assert not (env / "providers.local.json").exists()


# ---------- 守卫继承 ----------


def test_new_routes_are_guarded():
    """新路由挂在 /api/config 前缀下 → 自动继承三层防护（本机绑定/Origin/令牌）。"""
    from core import config_guard

    for path in (
        "/api/config/providers",
        "/api/config/providers/probe",
        "/api/config/providers/{name}",
    ):
        assert path.startswith(config_guard.GUARDED_PREFIX)


def test_routes_registered():
    paths = {getattr(route, "path", "") for route in server.app.routes}
    assert "/api/config/providers" in paths
    assert "/api/config/providers/probe" in paths
    assert "/api/config/providers/{name}" in paths


def test_provider_store_uses_atomic_write(env):
    """落盘必须走 write_text_atomic（先 .bak 再 os.replace），不裸写。"""
    add_config_provider(_payload(name="first"))
    add_config_provider(_payload(name="second"))
    assert (env / "providers.local.json.bak").exists()


# ---------- 删除本机来源 ----------


def test_delete_removes_local_entry(env):
    add_config_provider(_payload(name="acme"))
    body = delete_config_provider("acme")
    assert body["ok"] is True
    assert body["removed"] == "acme"
    doc = json.loads((env / "providers.local.json").read_text(encoding="utf-8"))
    assert "acme" not in doc["profiles"]


def test_delete_keeps_other_entries(env):
    add_config_provider(_payload(name="keep"))
    add_config_provider(_payload(name="drop"))
    delete_config_provider("drop")
    doc = json.loads((env / "providers.local.json").read_text(encoding="utf-8"))
    assert set(doc["profiles"]) == {"keep"}


def test_delete_does_not_touch_config_json(env):
    """出厂目录永远只读：删本机来源不许碰 config.json。"""
    (env / "config.json").write_text('{"default_profile": "wanwu"}', encoding="utf-8")
    before = (env / "config.json").read_text(encoding="utf-8")
    add_config_provider(_payload(name="acme"))
    delete_config_provider("acme")
    assert (env / "config.json").read_text(encoding="utf-8") == before


def test_delete_comments_out_secret(env):
    """密钥是注释掉而不是删除：留一行痕迹，去掉 # 即可恢复。"""
    add_config_provider(_payload(name="acme", apiKey="sk-secret"))
    env_text = (env / ".env").read_text(encoding="utf-8")
    assert "API_KEY_ACME=sk-secret" in env_text
    body = delete_config_provider("acme")
    assert body["cleared"] == ["API_KEY_ACME"]
    after = (env / ".env").read_text(encoding="utf-8")
    # 判定按「整行是否还是活键」：注释后那行仍含 "API_KEY_ACME=sk-secret" 子串，
    # 所以不能做子串判断，要看行首有没有被 # 挡住。
    live = [ln for ln in after.splitlines() if ln.strip().startswith("API_KEY_ACME=")]
    assert live == []
    assert "# API_KEY_ACME=sk-secret" in after


def test_delete_without_secret_clears_nothing(env):
    add_config_provider(_payload(name="acme"))
    body = delete_config_provider("acme")
    assert body["cleared"] == []


def test_delete_rejects_factory_profile(env):
    """出厂来源删不掉：config.json 是 git 跟踪的，删了下次 pull 又回来。"""
    with pytest.raises(HTTPException) as exc:
        delete_config_provider("wanwu")
    assert exc.value.status_code == 400
    assert exc.value.detail["error"] == "not_local"


def test_delete_rejects_unknown_name(env):
    with pytest.raises(HTTPException) as exc:
        delete_config_provider("never-existed")
    assert exc.value.status_code == 400
    assert exc.value.detail["error"] == "not_local"


def test_delete_rejects_active_profile(env, monkeypatch):
    """正在生效的来源删不掉：删了进程仍在用旧配置，下次启动静默回落，报错时联想不到。"""
    add_config_provider(_payload(name="acme"))
    monkeypatch.setattr(config, "ACTIVE_PROFILE", "acme")
    with pytest.raises(HTTPException) as exc:
        delete_config_provider("acme")
    assert exc.value.status_code == 400
    assert exc.value.detail["error"] == "profile_in_use"
    # 拒绝之后文件里那条必须还在（不能删一半）
    doc = json.loads((env / "providers.local.json").read_text(encoding="utf-8"))
    assert "acme" in doc["profiles"]


def test_delete_rejects_blank_name(env):
    with pytest.raises(HTTPException) as exc:
        delete_config_provider("  ")
    assert exc.value.status_code == 400
    assert exc.value.detail["error"] == "invalid_value"


def test_delete_returns_file_state(env):
    add_config_provider(_payload(name="acme"))
    body = delete_config_provider("acme")
    assert body["fileState"]["profile"] == "wanwu"
    assert "pending" in body

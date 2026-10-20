"""本机来源层（providers.local.json）：校验、合并、落盘。

覆盖三块：
1. 校验 —— profile 名 / 地址 / 协议预设 / 表单 → profile 的转换
2. 合并 —— 本机来源并进出厂 profiles（本机优先、重名告警、不污染 config.json）
3. 落盘 —— 原子写 + 坏文件宽容读取 + 重名拒绝

为什么不测 HTTP 层：路由只是「校验 → 调这里 → 整形响应」，校验逻辑全在这一层，
把边界值压在这里测比走 TestClient 快一个数量级，也让错误消息有唯一产地。
"""

from __future__ import annotations

import json
import warnings

import pytest

from core import provider_store

# ---------- profile 名校验 ----------


@pytest.mark.parametrize("name", ["acme", "acme-gateway", "my_relay", "a1", "x" * 32])
def test_valid_names_accepted(name):
    assert provider_store.validate_name(name) == name


@pytest.mark.parametrize(
    "name",
    [
        "",  # 空
        "   ",  # 空白
        "Acme",  # 大写（会与 acme 撞成两个 profile）
        "1acme",  # 数字开头
        "acme gateway",  # 空格
        "acme.gateway",  # 点号（会进 .env 键名与 URL）
        "-acme",  # 连字符开头
        "x" * 33,  # 超长
        "中转站",  # 非 ASCII
    ],
)
def test_invalid_names_rejected(name):
    with pytest.raises(provider_store.ProviderError):
        provider_store.validate_name(name)


def test_name_rejects_non_string():
    with pytest.raises(provider_store.ProviderError):
        provider_store.validate_name(None)
    with pytest.raises(provider_store.ProviderError):
        provider_store.validate_name(123)


# ---------- 地址校验 ----------


@pytest.mark.parametrize(
    "url",
    [
        "https://gateway.example/v1",
        "http://127.0.0.1:8080",
        "https://relay.example.net/v1",
    ],
)
def test_valid_base_url_accepted(url):
    assert provider_store.validate_base_url(url) == url.rstrip("/")


def test_base_url_strips_trailing_slash():
    """末尾斜杠会拼成 //v1/images/generations，必须在入口就去掉。"""
    assert (
        provider_store.validate_base_url("https://gateway.example/v1/")
        == "https://gateway.example/v1"
    )


@pytest.mark.parametrize(
    "url",
    [
        "",
        "   ",
        "gateway.example/v1",
        "ftp://x.example",
        "https://",
        "//gateway.example",
    ],
)
def test_invalid_base_url_rejected(url):
    with pytest.raises(provider_store.ProviderError):
        provider_store.validate_base_url(url)


# ---------- 协议预设 ----------


def test_protocol_openai_preset_keeps_version_prefix():
    """OpenAI 兼容中转站：base_url 不带版本号，路径自带 /v1。"""
    paths = provider_store.resolve_api_paths({"protocol": "openai"})
    assert paths == {
        "generations": "/v1/images/generations",
        "edits": "/v1/images/edits",
    }


def test_protocol_ark_preset_omits_version_prefix():
    """火山方舟：base_url 已含 /api/v3，路径不再带版本号。"""
    paths = provider_store.resolve_api_paths({"protocol": "ark"})
    assert paths == {
        "generations": "/images/generations",
        "edits": "/images/generations",
    }


def test_protocol_defaults_to_openai():
    assert (
        provider_store.resolve_api_paths({})
        == provider_store.PROTOCOL_PRESETS["openai"]
    )


def test_protocol_custom_uses_given_path():
    paths = provider_store.resolve_api_paths(
        {"protocol": "custom", "generationsPath": "/v2/paint"}
    )
    assert paths == {"generations": "/v2/paint", "edits": "/v2/paint"}


def test_protocol_custom_supports_separate_edits_path():
    paths = provider_store.resolve_api_paths(
        {"protocol": "custom", "generationsPath": "/g", "editsPath": "/e"}
    )
    assert paths == {"generations": "/g", "edits": "/e"}


@pytest.mark.parametrize(
    "payload",
    [
        {"protocol": "custom"},  # 缺路径
        {"protocol": "custom", "generationsPath": "no-slash"},
        {"protocol": "custom", "generationsPath": "/g", "editsPath": "no-slash"},
        {"protocol": "anthropic"},  # 未知协议
    ],
)
def test_bad_protocol_payload_rejected(payload):
    with pytest.raises(provider_store.ProviderError):
        provider_store.resolve_api_paths(payload)


# ---------- 表单 → profile ----------


def _payload(**overrides) -> dict:
    base = {
        "name": "acme-gateway",
        "label": "Acme 中转",
        "baseUrl": "https://gateway.example/v1",
        "protocol": "openai",
        "model": "gpt-image-2.5",
    }
    base.update(overrides)
    return base


def test_build_profile_shape():
    name, profile = provider_store.build_profile(_payload())
    assert name == "acme-gateway"
    assert profile["label"] == "Acme 中转"
    assert profile["base_url"] == "https://gateway.example/v1"
    assert profile["api_paths"]["generations"] == "/v1/images/generations"
    assert profile["default_model"] == "gpt-image-2.5"
    assert profile["default_quality"] == "high"
    assert profile["default_size"] == "1024x1024"
    assert profile["default_tier"] == "2K"
    assert len(profile["size_options"]) == 8
    assert len(profile["ratios"]) == 7
    assert profile["quality_options"] == ["low", "medium", "high"]


def test_build_profile_never_contains_secret():
    """密钥只进 .env：profile 里出现 api_key 就说明分层被破坏了。"""
    _, profile = provider_store.build_profile(_payload(apiKey="sk-should-not-land"))
    assert not any("key" in key.lower() for key in profile)
    assert "sk-should-not-land" not in json.dumps(profile, ensure_ascii=False)


def test_build_profile_embeds_model_with_sizes():
    _, profile = provider_store.build_profile(_payload())
    assert len(profile["models"]) == 1
    model = profile["models"][0]
    assert model["id"] == "gpt-image-2.5"
    assert model["label"] == "gpt-image-2.5"
    assert model["output_formats"] == ["png", "jpeg"]
    assert len(model["size_options"]) == 8
    assert len(model["ratios"]) == 7


def test_build_profile_without_model_keeps_empty_catalog():
    """不填模型 → models 为空。这是合法路径（界面退化成文本框，见设计文档 §0）。"""
    _, profile = provider_store.build_profile(_payload(model=""))
    assert profile["models"] == []
    assert profile["default_model"] == ""


def test_build_profile_label_defaults_to_name():
    _, profile = provider_store.build_profile(_payload(label=""))
    assert profile["label"] == "acme-gateway"


def test_build_profile_sizes_are_zero_cost():
    """单价一律 0，不猜数字（价目表属出厂目录，界面不编辑）。"""
    _, profile = provider_store.build_profile(_payload())
    assert all(opt["cost"] == 0.0 for opt in profile["size_options"])


def test_build_profile_copies_are_independent():
    """两次构建不能共享同一个 list 对象，否则改一个来源会串到另一个。"""
    _, first = provider_store.build_profile(_payload(name="one"))
    _, second = provider_store.build_profile(_payload(name="two"))
    first["size_options"].append({"value": "x", "label": "x", "cost": 0.0})
    assert len(second["size_options"]) == 8


# ---------- 读取宽容度 ----------


def test_load_missing_file_returns_empty(tmp_path):
    doc = provider_store.load_local_providers(tmp_path / "providers.local.json")
    assert doc["profiles"] == {}


def test_load_broken_json_returns_empty(tmp_path, recwarn):
    path = tmp_path / "providers.local.json"
    path.write_text("{ 不是合法 JSON", encoding="utf-8")
    doc = provider_store.load_local_providers(path)
    assert doc["profiles"] == {}
    assert any("读取失败" in str(w.message) for w in recwarn)


def test_load_non_object_json_returns_empty(tmp_path, recwarn):
    path = tmp_path / "providers.local.json"
    path.write_text('["not", "an", "object"]', encoding="utf-8")
    doc = provider_store.load_local_providers(path)
    assert doc["profiles"] == {}
    assert any("格式错误" in str(w.message) for w in recwarn)


def test_load_drops_non_object_entries(tmp_path):
    """单条坏掉不牵连其它：字符串 / 数字条目被跳过，dict 条目留下。"""
    path = tmp_path / "providers.local.json"
    path.write_text(
        json.dumps({"profiles": {"good": {"base_url": "https://x"}, "bad": "oops"}}),
        encoding="utf-8",
    )
    doc = provider_store.load_local_providers(path)
    assert set(doc["profiles"]) == {"good"}


def test_load_missing_profiles_key_returns_empty(tmp_path):
    path = tmp_path / "providers.local.json"
    path.write_text(json.dumps({"version": 1}), encoding="utf-8")
    assert provider_store.load_local_providers(path)["profiles"] == {}


# ---------- 合并 ----------


def test_merge_adds_local_without_touching_factory():
    factory = {"volc": {"base_url": "https://ark"}}
    merged = provider_store.merge_profiles(factory, {"acme": {"base_url": "https://a"}})
    assert set(merged) == {"volc", "acme"}
    assert set(factory) == {"volc"}, "不能改动入参（调用方可能还在用）"


def test_merge_local_wins_on_name_clash(recwarn):
    """重名时本机版本生效，但必须告警 —— 否则用户会以为改出厂配置没生效。"""
    merged = provider_store.merge_profiles(
        {"acme": {"base_url": "https://factory"}},
        {"acme": {"base_url": "https://mine"}},
    )
    assert merged["acme"]["base_url"] == "https://mine"
    assert any("重名" in str(w.message) for w in recwarn)


def test_merge_empty_local_is_identity():
    factory = {"volc": {}}
    assert provider_store.merge_profiles(factory, {}) == factory


def test_merge_tolerates_non_dict_factory():
    assert provider_store.merge_profiles(None, {"a": {}}) == {"a": {}}


# ---------- 落盘 ----------


def test_add_provider_writes_file(tmp_path):
    path = tmp_path / "providers.local.json"
    name, _profile, written = provider_store.add_provider(path, _payload())
    assert name == "acme-gateway"
    assert written == path
    doc = json.loads(path.read_text(encoding="utf-8"))
    assert doc["version"] == provider_store.SCHEMA_VERSION
    assert doc["profiles"]["acme-gateway"]["base_url"] == "https://gateway.example/v1"


def test_add_provider_rejects_duplicate(tmp_path):
    path = tmp_path / "providers.local.json"
    provider_store.add_provider(path, _payload())
    with pytest.raises(provider_store.ProviderError, match="已存在"):
        provider_store.add_provider(path, _payload())


def test_add_provider_rejects_clash_with_factory(tmp_path):
    """与 config.json 的出厂来源重名也要拒绝 —— 否则本机会静默遮住出厂配置。"""
    path = tmp_path / "providers.local.json"
    with pytest.raises(provider_store.ProviderError, match="已存在"):
        provider_store.add_provider(
            path, _payload(name="volc"), registered={"volc": {}}
        )


def test_add_provider_keeps_existing_entries(tmp_path):
    path = tmp_path / "providers.local.json"
    provider_store.add_provider(path, _payload(name="first"))
    provider_store.add_provider(path, _payload(name="second"))
    doc = json.loads(path.read_text(encoding="utf-8"))
    assert set(doc["profiles"]) == {"first", "second"}


def test_add_provider_creates_backup(tmp_path):
    """改文件前先存 .bak（沿用 config_write 的写盘纪律）。"""
    path = tmp_path / "providers.local.json"
    provider_store.add_provider(path, _payload(name="first"))
    provider_store.add_provider(path, _payload(name="second"))
    assert (tmp_path / "providers.local.json.bak").exists()


def test_add_provider_does_not_write_on_invalid_payload(tmp_path):
    """校验失败必须在落盘之前拦下，不留半截文件。"""
    path = tmp_path / "providers.local.json"
    with pytest.raises(provider_store.ProviderError):
        provider_store.add_provider(path, _payload(baseUrl="not-a-url"))
    assert not path.exists()


def test_add_provider_file_is_utf8_without_escapes(tmp_path):
    """中文 label 必须以原字符写入（ensure_ascii=False），否则手改文件看不懂。"""
    path = tmp_path / "providers.local.json"
    provider_store.add_provider(path, _payload(label="中转站"))
    assert "中转站" in path.read_text(encoding="utf-8")


def test_remove_provider_drops_only_target(tmp_path):
    path = tmp_path / "providers.local.json"
    provider_store.add_provider(path, _payload(name="first"))
    provider_store.add_provider(path, _payload(name="second"))
    provider_store.remove_provider(path, "first")
    doc = json.loads(path.read_text(encoding="utf-8"))
    assert set(doc["profiles"]) == {"second"}


def test_remove_provider_missing_is_noop(tmp_path):
    path = tmp_path / "providers.local.json"
    provider_store.remove_provider(path, "nobody")
    assert provider_store.load_local_providers(path)["profiles"] == {}


# ---------- 告警不吞 ----------


def test_merge_warning_is_visible(recwarn):
    """重名告警必须真的发出来：它靠 warnings 通道进控制台，不能只写注释。"""
    warnings.simplefilter("always")
    provider_store.merge_profiles({"a": {}}, {"a": {}})
    assert len(recwarn) == 1

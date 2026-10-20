#!/usr/bin/env python3
"""core/config.py 单元测试

覆盖: get_api_key（环境变量 / 跟随 profile / 缺失报错）、profile 解析（纯函数）、RATIOS 表结构合法性、
配置来源视图 build_profile_view（值 + 来自哪一层，供 /api/config 下发前端呈现）。
"""

import re

import pytest

import core.config as config


def test_get_api_key_from_env(monkeypatch, tmp_path):
    """环境变量已设置 -> 直接返回"""
    monkeypatch.setattr(config, "ENV_FILE_PATH", tmp_path / "no.env")
    monkeypatch.setattr(config, "ACTIVE_PROFILE", "wanwu")
    monkeypatch.delenv("API_KEY_WANWU", raising=False)
    monkeypatch.delenv("API_KEY", raising=False)
    monkeypatch.setenv(config.ENV_KEY_NAME, "sk-test")
    assert config.get_api_key() == "sk-test"


def test_get_api_key_missing_raises(monkeypatch, tmp_path):
    """未设置任何来源 -> 抛清晰错误"""
    monkeypatch.setattr(config, "ENV_FILE_PATH", tmp_path / "no.env")
    monkeypatch.setattr(config, "ACTIVE_PROFILE", "wanwu")
    monkeypatch.delenv("API_KEY_WANWU", raising=False)
    monkeypatch.delenv("API_KEY", raising=False)
    monkeypatch.delenv(config.ENV_KEY_NAME, raising=False)
    with pytest.raises(RuntimeError, match="AIWANWU_API_KEY"):
        config.get_api_key()


def test_ratios_all_values_are_valid_size_format():
    """RATIOS 表里所有分辨率都是合法的 宽x高 格式"""
    size_pattern = re.compile(r"^\d+x\d+$")
    for ratio, tiers in config.RATIOS.items():
        assert re.fullmatch(r"^\d+:\d+$", ratio), f"比例格式非法: {ratio}"
        for tier, size in tiers.items():
            assert size_pattern.match(size), f"{ratio}/{tier} 分辨率非法: {size}"
            assert tier in {"1K", "2K", "4K"}, f"档位非法: {tier}"


def test_default_quality_is_high():
    """所有未显式指定质量的入口统一使用 high。"""
    assert config.DEFAULT_QUALITY == "high"


def test_resolve_profile_prefers_env_active():
    """env 的 ACTIVE_PROFILE 优先于 config.json 的 default_profile"""
    cfg = {
        "default_profile": "wanwu",
        "profiles": {"wanwu": {"base_url": "a"}, "other": {"base_url": "b"}},
    }
    name, profile = config.resolve_profile_config(cfg, "other")
    assert name == "other"
    assert profile["base_url"] == "b"


def test_resolve_profile_falls_back_to_default():
    """未指定 env 时使用 config.json 的 default_profile"""
    cfg = {"default_profile": "wanwu", "profiles": {"wanwu": {"base_url": "a"}}}
    name, profile = config.resolve_profile_config(cfg, None)
    assert name == "wanwu"
    assert profile["base_url"] == "a"


def test_resolve_profile_missing_profile_returns_empty():
    """指定的 profile 不存在 -> 返回 (名, {})，由调用方回退内置默认"""
    cfg = {"default_profile": "wanwu", "profiles": {"wanwu": {}}}
    name, profile = config.resolve_profile_config(cfg, "nope")
    assert name == "nope"
    assert profile == {}


def test_resolve_profile_empty_config_returns_none():
    """config.json 缺失/为空 -> (None, {})，全部走内置默认"""
    assert config.resolve_profile_config({}, None) == (None, {})


def test_resolve_profile_no_profiles_key_warns():
    """有 default_profile 但没有 profiles 对象 -> 警告并回退"""
    with pytest.warns(UserWarning):
        _, profile = config.resolve_profile_config({"default_profile": "wanwu"}, None)
    assert profile == {}


def test_unknown_profile_keys_detects_typos():
    """白名单校验：拼错的键会被识别，防止静默失效"""
    profile = {"base_url": "https://x", "base_ur": "https://typo"}
    assert config.unknown_profile_keys(profile) == ["base_ur"]
    assert config.unknown_profile_keys({"base_url": "https://x"}) == []


# ---------- normalize_model_id：只在当前 profile 内纠正 ----------


def test_normalize_model_id_folds_hyphen_within_active_profile(monkeypatch):
    """本 profile 自己登记过全角 ID 时，半角输入被纠正成它（原有能力不退化）。"""
    monkeypatch.setattr(
        config, "MODELS", [{"id": "gpt\u2011image\u20112.5", "label": "x"}]
    )
    assert config.normalize_model_id("gpt-image-2.5") == "gpt\u2011image\u20112.5"


def test_normalize_model_id_does_not_borrow_from_other_profiles(monkeypatch):
    """本 profile 没登记该 ID 时原样返回，不被别的 profile 的同名条目劫持。

    回归：早先遍历 all_known_models()（含全部 profile），`wanwu` 里用 U+2011
    登记的历史条目会把本 profile 下用户打的半角名静默改写成全角 ID 再发上游，
    上游只回 `unsupported image model`（HTTP 400），而报错里列出的支持模型
    看起来与输入一模一样，极难排查。
    """
    monkeypatch.setattr(
        config, "MODELS", [{"id": "doubao-seedream-5-0-pro", "label": "x"}]
    )
    # 模拟"别的 profile 里有全角条目"：all_known_models() 仍能看见它
    monkeypatch.setattr(
        config, "all_known_models", lambda: ["gpt\u2011image\u20112.5", "other-model"]
    )
    assert config.normalize_model_id("gpt-image-2.5") == "gpt-image-2.5"


def test_normalize_model_id_passthrough_when_no_models(monkeypatch):
    """profile 没配 models（单模型模式）时不做任何改写，避免无依据的纠正。"""
    monkeypatch.setattr(config, "MODELS", [])
    monkeypatch.setattr(config, "all_known_models", lambda: ["gpt\u2011image\u20112.5"])
    assert config.normalize_model_id("gpt-image-2.5") == "gpt-image-2.5"
    assert config.normalize_model_id(None) is None


def test_get_api_key_follows_active_profile(monkeypatch, tmp_path):
    """ACTIVE_PROFILE=other 时优先读 API_KEY_OTHER"""
    monkeypatch.setattr(config, "ENV_FILE_PATH", tmp_path / "no.env")
    monkeypatch.setattr(config, "ACTIVE_PROFILE", "other")
    monkeypatch.delenv("API_KEY", raising=False)
    monkeypatch.delenv(config.ENV_KEY_NAME, raising=False)
    monkeypatch.setenv("API_KEY_OTHER", "sk-other")
    assert config.get_api_key() == "sk-other"


def test_get_api_key_generic_fallback(monkeypatch, tmp_path):
    """profile 专属 key 缺失时回退通用 API_KEY"""
    monkeypatch.setattr(config, "ENV_FILE_PATH", tmp_path / "no.env")
    monkeypatch.setattr(config, "ACTIVE_PROFILE", "wanwu")
    monkeypatch.delenv("API_KEY_WANWU", raising=False)
    monkeypatch.delenv(config.ENV_KEY_NAME, raising=False)
    monkeypatch.setenv("API_KEY", "sk-generic")
    assert config.get_api_key() == "sk-generic"


def test_get_api_key_legacy_name_still_works(monkeypatch, tmp_path):
    """旧写法 AIWANWU_API_KEY 仍生效（老用户零改动）"""
    monkeypatch.setattr(config, "ENV_FILE_PATH", tmp_path / "no.env")
    monkeypatch.setattr(config, "ACTIVE_PROFILE", "wanwu")
    monkeypatch.delenv("API_KEY_WANWU", raising=False)
    monkeypatch.delenv("API_KEY", raising=False)
    monkeypatch.setenv(config.ENV_KEY_NAME, "sk-legacy")
    assert config.get_api_key() == "sk-legacy"


def test_missing_key_message_lists_candidates(monkeypatch, tmp_path):
    """缺失报错信息列出全部候选键名（含 profile 专属键），指引清晰"""
    monkeypatch.setattr(config, "ENV_FILE_PATH", tmp_path / "no.env")
    monkeypatch.setattr(config, "ACTIVE_PROFILE", "wanwu")
    monkeypatch.delenv("API_KEY_WANWU", raising=False)
    monkeypatch.delenv("API_KEY", raising=False)
    monkeypatch.delenv(config.ENV_KEY_NAME, raising=False)
    with pytest.raises(RuntimeError) as exc:
        config.get_api_key()
    msg = str(exc.value)
    assert "API_KEY_WANWU" in msg and "AIWANWU_API_KEY" in msg


def test_cost_for_size_from_size_options():
    """计费唯一来自 size_options：已知档命中，未知档 0.0（不硬编码兜底价）"""
    known = config.SIZE_OPTIONS[0]
    assert config.cost_for_size(known["value"]) == float(known["cost"])
    assert config.cost_for_size("9999x9999") == 0.0


def test_build_profile_view_reports_layer_sources():
    """配置视图：每个值都带「来自哪一层」——profile 写死的标 config.json，回退的标内置默认；
    本机注册的 profile 名一并列出（前端据此展示，不必自己读 config.json）。"""
    cfg = {
        "default_profile": "wanwu",
        "profiles": {"wanwu": {"base_url": "https://a.example"}, "other": {}},
    }
    view = config.build_profile_view(
        profile_name="wanwu",
        profile={"base_url": "https://a.example"},
        cfg=cfg,
        env_active="",
        env_file_keys=set(),
        api_key_name=None,
    )
    assert view["name"] == "wanwu"
    assert view["nameSource"] == "config.json default_profile"
    assert view["registeredProfiles"] == ["other", "wanwu"]

    by_key = {field["key"]: field for field in view["fields"]}
    assert by_key["baseUrl"]["value"] == "https://a.example"
    assert by_key["baseUrl"]["source"] == "config.json profile"
    # profile 没写的字段回退内置兜底，来源要如实标注（前端由此提示「你没配，这是默认值」）
    assert by_key["model"]["source"] == "内置默认"
    assert by_key["model"]["value"]


def test_build_profile_view_marks_env_and_key_source():
    """来源标注要区分 .env 与系统环境变量；密钥只报「已配置 + 来源」，绝不回传值本身。"""
    view = config.build_profile_view(
        profile_name="wanwu",
        profile={},
        cfg={},
        env_active="other",
        env_file_keys={"ACTIVE_PROFILE", "API_KEY_OTHER"},
        api_key_name="API_KEY_OTHER",
    )
    assert view["nameSource"] == ".env ACTIVE_PROFILE"
    assert view["registeredProfiles"] == []
    key_field = {field["key"]: field for field in view["fields"]}["apiKey"]
    assert key_field["configured"] is True
    assert key_field["source"] == ".env API_KEY_OTHER"
    assert key_field["value"] is None

    # 系统环境变量（非 .env 文件）用另一种措辞，两种来源不该混为一谈
    view2 = config.build_profile_view(
        profile_name="wanwu",
        profile={},
        cfg={},
        env_active="",
        env_file_keys=set(),
        api_key_name="API_KEY",
    )
    assert {field["key"]: field for field in view2["fields"]}["apiKey"]["source"] == (
        "环境变量 API_KEY"
    )


# ---------- 来源目录 build_provider_catalog（/api/config 的 providers） ----------
# 价目表按 profile 分家，前端必须能按「使用中的接口地址」挑到对应那张表 ——
# 否则切了中转站还会显示官方单价（曾把中转站的 0.05 显示成豆包的 0.2）。


def test_build_provider_catalog_exposes_per_profile_sizes_and_models():
    """每个来源自带 baseUrl / sizes / models，缺 label 时回退 profile 名。"""
    cfg = {
        "default_profile": "volc",
        "profiles": {
            "volc": {
                "label": "火山方舟官方",
                "base_url": "https://ark.example/api/v3",
                "size_options": [{"value": "1024x1024", "label": "1:1", "cost": 0.2}],
                "models": [
                    {
                        "id": "m-volc",
                        "size_options": [
                            {"value": "1024x1024", "label": "1:1", "cost": 0.2}
                        ],
                    }
                ],
            },
            "wanwu": {
                "base_url": "https://2api.aiwanwu.cc",
                "size_options": [
                    {"value": "1024x1024", "label": "1:1 1K", "cost": 0.05}
                ],
            },
        },
    }
    by_name = {item["name"]: item for item in config.build_provider_catalog(cfg)}
    assert set(by_name) == {"volc", "wanwu"}
    assert by_name["volc"]["sizes"][0]["cost"] == 0.2
    assert by_name["wanwu"]["sizes"][0]["cost"] == 0.05
    assert by_name["volc"]["models"][0]["id"] == "m-volc"
    assert by_name["volc"]["label"] == "火山方舟官方"
    assert by_name["wanwu"]["label"] == "wanwu"  # 未写 label → 用 profile 名
    assert by_name["volc"]["baseUrl"] == "https://ark.example/api/v3"


def test_build_provider_catalog_falls_back_to_builtin_defaults():
    """profile 缺字段 → 回退内置默认，不下发半截数据给前端。"""
    (item,) = config.build_provider_catalog({"profiles": {"bare": {}}})
    assert item["baseUrl"] == config._DEFAULTS["base_url"]
    assert item["sizes"] == config._DEFAULTS["size_options"]
    assert item["defaultModel"] == config._DEFAULTS["default_model"]
    assert item["models"] == []


def test_build_provider_catalog_tolerates_broken_profiles():
    """缺 profiles / profiles 结构错 / 单个 profile 非对象 → 跳过，不抛错。"""
    assert config.build_provider_catalog({}) == []
    assert config.build_provider_catalog({"profiles": ["x"]}) == []
    assert config.build_provider_catalog({"profiles": {"bad": "x"}}) == []


def test_build_provider_catalog_marks_local_sources(monkeypatch, tmp_path):
    """`local` 标记：只有 providers.local.json 里的来源为 True，出厂来源为 False。

    界面据此决定「删除这个来源」按钮出不出现 —— 出厂来源写死在 config.json 里，
    删了下次 git pull 又回来，所以不给删。这个标记错了会让用户对着删不掉的按钮点。
    """
    import json

    local_file = tmp_path / "providers.local.json"
    local_file.write_text(
        json.dumps(
            {"version": 1, "profiles": {"mine": {"base_url": "https://m.example"}}}
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(config, "LOCAL_PROVIDERS_FILE", local_file)
    cfg = {
        "profiles": {
            "factory": {"base_url": "https://f.example"},
            "mine": {"base_url": "https://m.example"},
        }
    }
    by_name = {item["name"]: item for item in config.build_provider_catalog(cfg)}
    assert by_name["factory"]["local"] is False
    assert by_name["mine"]["local"] is True


def test_build_provider_catalog_without_local_file(monkeypatch, tmp_path):
    """没有 providers.local.json 时一律标 False（不能因为读不到文件就全变可删）。"""
    monkeypatch.setattr(config, "LOCAL_PROVIDERS_FILE", tmp_path / "absent.json")
    (item,) = config.build_provider_catalog({"profiles": {"only": {}}})
    assert item["local"] is False


def test_provider_catalog_matches_local_config_json():
    """本机 config.json：注册过的 profile 一个都不少，且每个都带可用地址与尺寸表。"""
    profiles = config._cfg.get("profiles")
    assert isinstance(profiles, dict) and profiles, "本机 config.json 应有 profiles"
    catalog = config.provider_catalog()
    assert {item["name"] for item in catalog} == set(profiles)
    for item in catalog:
        assert item["baseUrl"].startswith("http"), item
        assert item["sizes"], f"{item['name']} 缺少尺寸表"

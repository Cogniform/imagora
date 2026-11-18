"""core/payload.py 的规则测试：叠加顺序、drop 语义、护栏、失败降级。

这些用例全是纯函数，不触网、不读配置文件。
"""

import pytest

from core import payload as payload_rules

# 与 core/api.py 里那份基线逐字对应（改动基线时这里必须同步）
_BASE = {
    "model": "gpt-image-2.6",
    "prompt": "透明底卡通绘画风",
    "size": "1024x1024",
    "quality": "high",
    "n": 1,
    "output_format": "png",
    "watermark": False,
}


def test_default_blocks_keep_payload_identical():
    """两条都不配 = 与改动前逐字相同（这是「不加能力就不改行为」的钉子）。"""
    built, notes = payload_rules.build_payload(_BASE, {"request": {}, "drop": []}, {})
    assert built == _BASE
    assert notes == []


def test_none_blocks_are_tolerated():
    built, notes = payload_rules.build_payload(_BASE, None, None)
    assert built == _BASE
    assert notes == []


def test_channel_request_adds_and_overrides():
    built, notes = payload_rules.build_payload(
        _BASE,
        {"request": {"response_format": "b64_json", "quality": "low"}, "drop": []},
        {},
    )
    assert built["response_format"] == "b64_json"
    # 渠道字段可以覆盖基线的非产品字段（quality 不在 PROTECTED 里）
    assert built["quality"] == "low"
    assert "channel:response_format" in notes


def test_model_params_win_over_channel_request():
    built, _ = payload_rules.build_payload(
        _BASE,
        {"request": {"background": "opaque"}, "drop": []},
        {"background": "transparent"},
    )
    assert built["background"] == "transparent"


def test_drop_removes_baseline_keys_only():
    built, notes = payload_rules.build_payload(
        _BASE, {"request": {}, "drop": ["output_format", "watermark"]}, {}
    )
    assert "output_format" not in built
    assert "watermark" not in built
    assert "drop:output_format" in notes
    # 基线之外、又不存在的键：静默跳过，但不算错误
    built2, _ = payload_rules.build_payload(
        _BASE, {"request": {}, "drop": ["nope"]}, {}
    )
    assert built2 == _BASE


def test_drop_then_reprovide_is_legal():
    """「摘掉基线字段，再给另一个值」是合法写法（某渠道要 jpeg 时就这么写）。"""
    built, _ = payload_rules.build_payload(
        _BASE,
        {"request": {}, "drop": ["output_format"]},
        {"output_format": "jpeg"},
    )
    assert built["output_format"] == "jpeg"


def test_passthrough_key_is_visible_in_notes():
    built, notes = payload_rules.build_payload(
        _BASE, {"request": {"some_new_gateway_flag": True}, "drop": []}, {}
    )
    assert built["some_new_gateway_flag"] is True
    assert "channel:some_new_gateway_flag" in notes


@pytest.mark.parametrize("key", ["prompt", "size", "n", "model", "images", "mask"])
def test_protected_keys_cannot_be_configured(key):
    problems = payload_rules.check_block({key: "x"}, "transport.request")
    assert problems and "产品语义字段" in problems[0]


@pytest.mark.parametrize(
    "key", ["authorization", "headers", "url", "host", "api_key", "token", "Cookie"]
)
def test_forbidden_keys_cannot_be_configured(key):
    problems = payload_rules.check_block({key: "x"}, "transport.request")
    assert problems and "不允许配置" in problems[0]


def test_bad_value_types_rejected():
    assert payload_rules.check_block({"x": {"nested": 1}}, "t")
    assert payload_rules.check_block({"x": [{"nested": 1}]}, "t")
    # 标量数组合法（有些网关要 ["a","b"]）
    assert payload_rules.check_block({"x": ["a", 1, True, None]}, "t") == []


def test_bad_key_names_rejected():
    assert payload_rules.check_block({"bad key": 1}, "t")
    assert payload_rules.check_block({"k" * 41: 1}, "t")


def test_normalize_transport_fails_open_on_any_problem():
    """坏块整体丢弃：半截生效比不生效更难查。"""
    clean, problems = payload_rules.normalize_transport(
        {"request": {"response_format": "b64_json", "prompt": "hack"}}
    )
    assert clean == {"request": {}, "drop": []}
    assert problems
    # 全丢之后 payload 必须回到默认
    built, _ = payload_rules.build_payload(_BASE, clean, {})
    assert built == _BASE


def test_normalize_transport_accepts_unknown_block_keys_with_problem():
    clean, problems = payload_rules.normalize_transport({"requests": {"a": 1}})
    assert clean == {"request": {}, "drop": []}
    assert any("不是已知字段" in p for p in problems)


def test_normalize_transport_accepts_good_block():
    clean, problems = payload_rules.normalize_transport(
        {"request": {"response_format": "b64_json"}, "drop": ["output_format"]}
    )
    assert problems == []
    assert clean == {
        "request": {"response_format": "b64_json"},
        "drop": ["output_format"],
    }


def test_normalize_model_params_fails_open():
    clean, problems = payload_rules.normalize_model_params(
        {"background": "transparent"}
    )
    assert clean == {"background": "transparent"}
    assert problems == []

    clean, problems = payload_rules.normalize_model_params({"size": "2048x2048"})
    assert clean == {}
    assert problems


def test_describe_lists_fields_and_notes():
    text = payload_rules.describe({"a": 1, "b": 2}, ["channel:a"])
    assert "字段（2）" in text
    assert "a, b" in text
    assert "channel:a" in text

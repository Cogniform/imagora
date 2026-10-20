"""config_write：.env 行级原地更新的单测。

核心不变量：**用户的注释、空行、键顺序、引号风格一字不动**——
配置文件是用户手写的，界面只是另一个编辑入口，不该把它重排一遍。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from core.config_write import (
    comment_out_env_file,
    comment_out_keys,
    split_key_value,
    update_env_file,
    update_env_text,
)

SAMPLE = (
    "# ==================== Imagora 环境配置 ====================\n"
    "# 复制本文件为 .env 后填写\n"
    "\n"
    "# ---------------- API Key ----------------\n"
    "# 推荐：按 profile 命名\n"
    "API_KEY_WANWU=sk-old-key\n"
    "\n"
    "# ---------------- 切换中转站 ----------------\n"
    "# 不填 = 使用 config.json 的 default_profile\n"
    "#ACTIVE_PROFILE=other\n"
)


# ---------------------------------------------------------------- 解析


def test_split_key_value_识别赋值行():
    assert split_key_value("A=1") == ("A", "1")
    assert split_key_value("  A=1  ") == ("A", "1")
    assert split_key_value('A="1"') == ("A", '"1"')
    assert split_key_value("A=b=c") == ("A", "b=c")  # 只按第一个 = 切


def test_split_key_value_跳过注释与空行():
    assert split_key_value("# A=1") is None
    assert split_key_value("") is None
    assert split_key_value("   ") is None
    assert split_key_value("A=1 # 尾部注释不是值的一部分") == (
        "A",
        "1 # 尾部注释不是值的一部分",
    )
    assert split_key_value("=1") is None  # 空键名


# ---------------------------------------------------------------- 行级更新


def test_改已有键_其他行一字不动():
    out = update_env_text(SAMPLE, {"API_KEY_WANWU": "sk-new-key"})
    assert "API_KEY_WANWU=sk-new-key" in out
    # 注释 / 空行 / 注释掉的示例行全部原样保留
    assert "# ==================== Imagora 环境配置 ====================" in out
    assert "# 复制本文件为 .env 后填写" in out
    assert "#ACTIVE_PROFILE=other" in out
    assert out.count("\n") == SAMPLE.count("\n")  # 行数不变


def test_新增键_追加到末尾并带说明():
    out = update_env_text(SAMPLE, {"MODEL_WANWU": "gpt-image"})
    lines = out.splitlines()
    assert "MODEL_WANWU=gpt-image" in lines
    assert lines[-2].startswith("# 由配置界面写入")
    # 原有内容仍在前面，且未被改写
    assert "#ACTIVE_PROFILE=other" in out
    assert "API_KEY_WANWU=sk-old-key" in out


def test_留空等于不修改_绝不抹掉磁盘上的值():
    """UI 的「留空 = 不修改」：空值不能变成删除。"""
    out = update_env_text(SAMPLE, {"API_KEY_WANWU": ""})
    assert "API_KEY_WANWU=sk-old-key" in out
    assert out == SAMPLE


def test_留空的新键不会被追加():
    out = update_env_text(SAMPLE, {"MODEL_WANWU": ""})
    assert "MODEL_WANWU" not in out
    assert out == SAMPLE


def test_保留原有引号风格():
    quoted = 'A="old"\nB=old2\n'
    out = update_env_text(quoted, {"A": "new"})
    assert 'A="new"' in out  # 双引号保留
    assert "B=old2" in out

    out2 = update_env_text("A='old'\n", {"A": "new"})
    assert "A='new'" in out2  # 单引号保留


def test_保留行首缩进():
    out = update_env_text("  A=old\n", {"A": "new"})
    assert out == "  A=new\n"


def test_保留_crlf_不混用行尾():
    crlf = "# 注释\r\nA=old\r\n"
    out = update_env_text(crlf, {"A": "new"})
    assert out == "# 注释\r\nA=new\r\n"
    assert "\n" not in out.replace("\r\n", "")


def test_新增键时_原文件无末尾换行也能正确处理():
    out = update_env_text("A=old", {"B": "new"})
    assert out.splitlines()[-1] == "B=new"
    assert out.splitlines()[0] == "A=old"


def test_空updates_原样返回():
    assert update_env_text(SAMPLE, {}) == SAMPLE


def test_多键一次更新():
    out = update_env_text(
        "A=1\nB=2\n",
        {"A": "x", "B": "y", "C": "z"},
    )
    assert "A=x" in out and "B=y" in out and "C=z" in out
    assert out.splitlines()[-1] == "C=z"


def test_值里的等号与井号原样保留():
    out = update_env_text("A=old\n", {"A": "https://h/p?x=1#frag"})
    assert "A=https://h/p?x=1#frag" in out


# ---------------------------------------------------------------- 注释掉（清空密钥）


def test_注释掉键_保留原文便于手工恢复():
    out = comment_out_keys(SAMPLE, ["API_KEY_WANWU"])
    assert "# API_KEY_WANWU=sk-old-key" in out
    assert "\nAPI_KEY_WANWU=" not in out
    assert "API_KEY_WANWU=sk-old-key" in out  # 值还在，只是被注释


def test_注释掉_不影响其他行与重复调用幂等():
    once = comment_out_keys(SAMPLE, ["API_KEY_WANWU"])
    twice = comment_out_keys(once, ["API_KEY_WANWU"])
    assert once == twice


def test_注释掉空列表_原样返回():
    assert comment_out_keys(SAMPLE, []) == SAMPLE


# ---------------------------------------------------------------- 落盘


def test_update_env_file_写盘并留备份(tmp_path: Path):
    env_file = tmp_path / ".env"
    env_file.write_text(SAMPLE, encoding="utf-8")

    update_env_file(env_file, {"API_KEY_WANWU": "sk-new"})

    assert "API_KEY_WANWU=sk-new" in env_file.read_text(encoding="utf-8")
    assert (
        "# ==================== Imagora 环境配置 ===================="
        in env_file.read_text(encoding="utf-8")
    )
    # 备份保留改动前的内容
    assert (tmp_path / ".env.bak").exists()
    assert "sk-old-key" in (tmp_path / ".env.bak").read_text(encoding="utf-8")


def test_文件不存在时新建(tmp_path: Path):
    env_file = tmp_path / ".env"
    update_env_file(env_file, {"API_KEY_WANWU": "sk-brand-new"})
    text = env_file.read_text(encoding="utf-8")
    assert "API_KEY_WANWU=sk-brand-new" in text


def test_落盘后不留临时文件(tmp_path: Path):
    env_file = tmp_path / ".env"
    env_file.write_text(SAMPLE, encoding="utf-8")
    update_env_file(env_file, {"API_KEY_WANWU": "sk-new"})
    assert sorted(p.name for p in tmp_path.iterdir()) == [".env", ".env.bak"]


def test_comment_out_env_file(tmp_path: Path):
    env_file = tmp_path / ".env"
    env_file.write_text(SAMPLE, encoding="utf-8")
    comment_out_env_file(env_file, ["API_KEY_WANWU"])
    text = env_file.read_text(encoding="utf-8")
    assert "# API_KEY_WANWU=sk-old-key" in text
    assert (tmp_path / ".env.bak").exists()


def test_写入失败时清理临时文件(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """写盘中途抛错不能留下 .tmp 垃圾（且原文件不能被破坏）。"""
    env_file = tmp_path / ".env"
    env_file.write_text(SAMPLE, encoding="utf-8")

    import core.config_write as cw

    def boom(*args, **kwargs):
        raise OSError("磁盘满了")

    monkeypatch.setattr(cw.os, "fsync", boom)
    with pytest.raises(OSError):
        cw.write_text_atomic(env_file, "garbage", backup=False)

    # 原文件完好
    assert "sk-old-key" in env_file.read_text(encoding="utf-8")
    # 没有残留 .tmp
    assert not list(tmp_path.glob("*.tmp"))

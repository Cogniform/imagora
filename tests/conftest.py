"""共享测试夹具：统一隔离用户数据目录（输出目录 / 注册表 / 工作流 / 账本 / 预算）。

**默认隔离（autouse）**：`isolate_user_data` 对所有用例生效——历史上 `asset_iso` 是 opt-in，
漏用的用例会把测试图片写进真实 `output/.assets`、把预算写进真实 `output/.budget.json`
（已实测复现：跑一次 pytest 就多出 `canv_*` 假资产）。测试绝不允许碰用户真实数据。
"""

import os
import sys

import pytest

import core.config as config
from core import canvas, cost, graphstore, history, registry

# config 模块里「由 reload_config() 重新求值」的全局量。它们不全是模块属性补丁能覆盖的：
# 只要某个用例触发了热加载（write_config / clear_config_secret 都会），这些名字就被
# 整体改写，而 monkeypatch 只还原它自己补过的属性 —— 于是状态漏到后续用例里
# （实测：跑完配置写入测试后，后面的成本测试全部按另一张价目表算）。
_CONFIG_GLOBALS = (
    "_cfg",
    "ACTIVE_PROFILE",
    "_profile",
    "BASE_URL",
    "API_PATHS",
    "PROFILE_LABEL",
    "MODELS",
    "RATIOS",
    "SIZE_OPTIONS",
    "QUALITY_OPTIONS",
    "DEFAULT_MODEL",
    "DEFAULT_QUALITY",
    "DEFAULT_SIZE",
    "DEFAULT_TIER",
    "_ENV_FILE_KEYS",
)


@pytest.fixture(autouse=True)
def isolate_config_globals(tmp_path):
    """把进程配置拨回「刚 clone 下来」的样子再跑用例。

    开发机可能真的有 `.env` / `providers.local.json`：导入 `core.config` 时它们已经
    被灌进 `os.environ` 与模块全局量。CI 上没有这两个文件，用例必须跑在同样的初始
    状态里，否则本地红、CI 绿（已实测：本机 `ACTIVE_PROFILE=api` 指向一个单价全 0 的
    自建来源，`test_server_cost.py` 四条预算断言全部失效；`config.reload_config()`
    又会把本机 `.env` 重新读进来，把 `ACTIVE_PROFILE` 盖回去）。

    做法：把两个本机文件路径指向不存在的临时文件后重跑一次 `reload_config()`，
    让常量回到出厂目录（config.json + 内置默认）的值。
    """
    # 必须逐个拷贝可变值：`_ENV_FILE_KEYS` 是 set，而 `_load_env_file()` 会原地
    # `clear()` 它 —— 直接存引用等于存了个「跟着被清空的快照」，还原后集合是空的，
    # 下个用例里 os.environ 中来自真实 .env 的键就被当成「用户 export 的系统变量」
    # 而拒绝覆盖，`ACTIVE_PROFILE=api` 一路漏到别的用例（已实测复现）。
    saved = {
        name: (
            set(getattr(config, name))
            if isinstance(getattr(config, name), set)
            else getattr(config, name)
        )
        for name in _CONFIG_GLOBALS
    }
    saved_env = dict(os.environ)
    saved_paths = (config.ENV_FILE_PATH, config.LOCAL_PROVIDERS_FILE)
    config.ENV_FILE_PATH = tmp_path / "no.env"
    config.LOCAL_PROVIDERS_FILE = tmp_path / "no-providers.local.json"
    config.reload_config()
    yield
    config.ENV_FILE_PATH, config.LOCAL_PROVIDERS_FILE = saved_paths
    for name, value in saved.items():
        setattr(config, name, value)
    # .env 装载会往 os.environ 里灌键，一并回滚
    os.environ.clear()
    os.environ.update(saved_env)


def _patch_user_data_paths(tmp_path, monkeypatch) -> None:
    """把"用户数据"相关模块常量整体指向 tmp_path（单点实现，autouse 与显式夹具共用）。"""
    t = str(tmp_path)
    for mod in (registry, graphstore, canvas):
        monkeypatch.setattr(mod, "DEFAULT_OUTPUT_DIR", t, raising=False)
    for mod in (registry, canvas):
        monkeypatch.setattr(mod, "ASSET_DIR", str(tmp_path / ".canvas"))
        monkeypatch.setattr(
            mod, "REGISTRY_FILE", str(tmp_path / ".canvas" / "registry.json")
        )
        monkeypatch.setattr(
            mod, "LEGACY_ASSET_DIR", str(tmp_path / ".canvas"), raising=False
        )
    for mod in (graphstore, canvas):
        monkeypatch.setattr(mod, "WORKFLOWS_DIR", str(tmp_path / "workflows"))
        monkeypatch.setattr(
            mod,
            "RECOVERY_DIR",
            str(tmp_path / "workflows" / ".recovery"),
            raising=False,
        )
        monkeypatch.setattr(
            mod, "SUBMISSIONS_DIR", str(tmp_path / "submissions"), raising=False
        )
    # 账本（生成历史 JSONL）与预算设置：读要走 tmp，写更不能落到用户目录
    monkeypatch.setattr(history, "HISTORY_FILE", tmp_path / "generation.jsonl")
    monkeypatch.setattr(cost, "BUDGET_FILE", str(tmp_path / ".budget.json"))
    # 本机来源层（界面上「添加第三方供应商」建出来的 profile）：config.reload_config()
    # 会重新读这个文件，不隔离的话测试会读到开发机上真实接入的中转站清单。
    monkeypatch.setattr(
        config, "LOCAL_PROVIDERS_FILE", tmp_path / "providers.local.json", raising=False
    )
    # server 的派生常量（import 时由 DEFAULT_OUTPUT_DIR 算出）：仅在已导入时补丁
    srv = sys.modules.get("server")
    if srv is not None:
        monkeypatch.setattr(srv, "REF_DIR", str(tmp_path / ".refs"), raising=False)
        monkeypatch.setattr(
            srv,
            "LAST_OUTPUT_DIR_FILE",
            str(tmp_path / ".last_output_dir"),
            raising=False,
        )


@pytest.fixture(autouse=True)
def isolate_user_data(tmp_path, monkeypatch):
    """自动隔离（无需声明）：输出目录 / 注册表 / 工作流 / 账本 / 预算全部落 tmp_path。"""
    _patch_user_data_paths(tmp_path, monkeypatch)
    return tmp_path


@pytest.fixture
def asset_iso(isolate_user_data):
    """显式声明版（既有用例沿用）：与 autouse 的 isolate_user_data 同一实现。"""
    return isolate_user_data


@pytest.fixture
def cost_iso(isolate_user_data):
    """成本/账本隔离（语义化命名，供成本与预算用例显式声明；实现同 autouse）。"""
    return isolate_user_data

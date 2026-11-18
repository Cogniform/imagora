#!/usr/bin/env python3
"""打印「最终发给上游的请求体」，不发请求、不花钱、不需要密钥。

用途有两个，缺一不可：

1. **给写配置的人（或 agent）自检**。`transport.request` / `models[].params` 都是
   自由字段，写错了不会报错——只会「没生效」。这个脚本把合并结果摊开，
   并且把 `drop:` / `channel:` / `model:` / `passthrough:` 的来源标出来。
2. **排查「配置到底有没有读进去」**。改完配置行为没变时，先跑这个：
   它是配置解析 + 合并的唯一可观测点。

用法:
  python scripts/check_provider.py                      # 当前 profile / 当前默认模型
  python scripts/check_provider.py --model gpt-image-2.6
  python scripts/check_provider.py --profile volc
  python scripts/check_provider.py --json               # 只输出请求体 JSON（给脚本/agent 消费）

退出码：0 = 配置合法；1 = 有问题（问题已打印，且会被忽略的那部分已标明）。
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core import config
from core import payload as payload_rules


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="打印最终请求体（不发请求）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--profile", default="", help="检查哪个 profile；缺省用当前生效的"
    )
    parser.add_argument(
        "--model", default="", help="检查哪个模型；缺省用该 profile 的默认模型"
    )
    parser.add_argument(
        "--size", default="", help="预览用尺寸；缺省用该模型/profile 的第一档"
    )
    parser.add_argument(
        "--prompt", default="<这里填提示词>", help="预览用提示词（仅占位）"
    )
    parser.add_argument("--json", action="store_true", help="只输出请求体 JSON")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if args.profile:
        # 换 profile 要重跑整条解析链（与 reload_config 同一条路）。
        #
        # 细节：.env 里的 ACTIVE_PROFILE 会盖掉这里传的值 —— `_load_env_file()`
        # 只让「用户自己 export 的系统变量」优先，判据是 `name not in
        # _ENV_FILE_KEYS`。首轮加载已把 ACTIVE_PROFILE 登记进那个集合，所以
        # 直接改 os.environ 会被 .env 悄悄覆盖，`--profile` 形同不存在。
        # 先把它从集合里摘掉，这笔赋值才被当作「外部来源」看待。
        import os

        config._ENV_FILE_KEYS.discard("ACTIVE_PROFILE")
        os.environ["ACTIVE_PROFILE"] = args.profile
        config.reload_config()

    problems: list[str] = []

    # 原始块与归一化后的块都看一眼：用户写的东西 vs 实际生效的东西
    raw_transport = config._get("transport")
    clean_transport, transport_problems = payload_rules.normalize_transport(
        raw_transport
    )
    problems.extend(transport_problems)

    model_id = args.model or config.DEFAULT_MODEL
    raw_model = config._model_anywhere(model_id) or {}
    clean_params, param_problems = payload_rules.normalize_model_params(
        raw_model.get("params")
    )
    problems.extend(param_problems)

    size = args.size or config.DEFAULT_SIZE
    base = {
        "model": model_id,
        "prompt": args.prompt,
        "size": size,
        "quality": config.DEFAULT_QUALITY,
        "n": 1,
        "output_format": "png",
        "watermark": False,
    }
    built, notes = payload_rules.build_payload(base, clean_transport, clean_params)

    if args.json:
        print(json.dumps(built, ensure_ascii=False, indent=2))
        return 1 if problems else 0

    print(
        f"profile      : {config.ACTIVE_PROFILE or '(未设置)'}  {config.PROFILE_LABEL or ''}"
    )
    print(f"base_url     : {config.BASE_URL}")
    print(f"model        : {model_id}")
    print(f"size         : {size}")
    print()
    print(
        "transport.request :",
        json.dumps(raw_transport.get("request", {}), ensure_ascii=False),
    )
    print(
        "transport.drop    :",
        json.dumps(raw_transport.get("drop", []), ensure_ascii=False),
    )
    print(
        "models[].params   :",
        json.dumps(raw_model.get("params") or {}, ensure_ascii=False),
    )
    print()
    print("最终请求体:")
    print(json.dumps(built, ensure_ascii=False, indent=2))
    print()
    print(payload_rules.describe(built, notes))

    if problems:
        print()
        print("配置有问题（这部分已被忽略，实际行为 = 默认）:")
        for problem in problems:
            print(f"  ✗ {problem}")
        return 1

    print()
    print("配置合法。")
    return 0


if __name__ == "__main__":
    sys.exit(main())

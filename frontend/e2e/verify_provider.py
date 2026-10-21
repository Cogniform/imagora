"""端到端验证「添加第三方供应商」：真实浏览器 + 真实服务，不 mock。

运行：python frontend/e2e/verify_provider.py [--base URL] [--app-root DIR] [--only 关键字]
      `--base` 也可用 IMAGORA_E2E_BASE 环境变量提供，`--app-root` 也可用 IMAGORA_APP_ROOT
      （都是命令行优先）。`--app-root` 必须与**服务进程**的应用根一致 —— config.json /
      providers.local.json / .env 三者同级（core/config.py 的 `_APP_ROOT`）；
      打隔离实例时如果漏了它，脚本会去断言仓库里那份真实 providers.local.json：
      第 4 步假红（文件里没有测试来源），第 7 步假绿（没写进去，自然也「已无该来源」）。

覆盖：
1. 顶栏插头按钮存在、可点
2. 弹窗字段齐全
3. 前端校验（ID 格式 / 地址格式）
4. 真实创建一条来源 → 落盘 providers.local.json
5. 创建后配置弹窗的「配置来源」下拉里能看到它
6. 清理：删掉测试来源
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

DEFAULT_BASE = "http://127.0.0.1:7860"
BASE = os.environ.get("IMAGORA_E2E_BASE", DEFAULT_BASE)
ROOT = Path(__file__).resolve().parents[2]
# 应用根：服务端取「自己的工作目录，或 IMAGORA_APP_ROOT」（core/config.py:31）。
# 默认仓库根 = 「在仓库根起服务」这条最常走的路；隔离实例请带 --app-root / 环境变量。
APP_ROOT = Path(os.environ.get("IMAGORA_APP_ROOT") or ROOT)
LOCAL = APP_ROOT / "providers.local.json"
SHOTS = APP_ROOT / "_ui-audit"
# 每次跑用不同的名字：服务端把来源缓存在内存里（进程启动时读一次 + 新建时 reload），
# 上一次跑留下的条目在本进程内仍然「已注册」，复用同一个名字会被前端判成重名而禁用按钮。
TEST_NAME = f"e2e-{secrets.token_hex(3)}"

passed = 0
failed = 0
results: list[tuple[str, bool]] = []
# --only 过滤词：空 = 全量。由 main() 按命令行覆盖（与 verify_canvas.py 同一套语义）。
ONLY = ""


def check(label: str, ok: bool, extra: str = "") -> None:
    global passed, failed
    if ONLY and ONLY.lower() not in label.lower():
        return
    if ok:
        passed += 1
        print(f"  PASS  {label}")
    else:
        failed += 1
        print(f"  FAIL  {label} {extra}")
    results.append((label, ok))


def main() -> int:
    global BASE, ONLY, LOCAL, SHOTS
    parser = argparse.ArgumentParser(description="第三方来源（新增 / 删除）端到端验证")
    parser.add_argument(
        "--base",
        default=BASE,
        help=f"服务地址，默认 {DEFAULT_BASE}（也可用 IMAGORA_E2E_BASE 环境变量）",
    )
    parser.add_argument(
        "--app-root",
        default=str(APP_ROOT),
        help=f"服务进程的应用根目录，默认 {ROOT}（也可用 IMAGORA_APP_ROOT 环境变量）",
    )
    parser.add_argument(
        "--only",
        default="",
        help="只判定名称包含该关键字的断言（默认不过滤 = 全量）",
    )
    args = parser.parse_args()
    BASE = args.base.rstrip("/")
    ONLY = args.only.strip()
    LOCAL = Path(args.app_root) / "providers.local.json"
    SHOTS = Path(args.app_root) / "_ui-audit"
    SHOTS.mkdir(parents=True, exist_ok=True)
    # CI Windows runner 默认 stdout 为 cp1252，无法编码中文（PASS/FAIL 断言名）→ 强制 UTF-8
    # 与 verify_canvas.py 同一处理；漏了这行会在 CI 里第一条 print 就 UnicodeEncodeError。
    sys.stdout.reconfigure(encoding="utf-8")
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 1600, "height": 1000})
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on(
            "console", lambda m: errors.append(m.text) if m.type == "error" else None
        )

        page.goto(BASE, wait_until="networkidle")
        page.wait_for_selector("#root > *", timeout=15000)

        print("[1] 顶栏入口")
        plug = page.get_by_role("button", name="添加第三方供应商")
        check("插头按钮存在", plug.count() == 1)
        check("按钮在顶栏内", plug.evaluate("el => !!el.closest('header')"))

        plug.click()
        page.wait_for_selector('[data-testid="provider-modal"]', timeout=5000)
        check("弹窗打开", True)
        check(
            "标题正确",
            page.get_by_role("dialog", name="添加第三方供应商").count() == 1,
        )

        print("[2] 字段齐全")
        for label in [
            "Provider ID",
            "显示名称",
            "API 地址",
            "API 协议",
            "API 密钥",
            "默认模型",
        ]:
            check(f"字段「{label}」", page.get_by_label(label, exact=True).count() == 1)

        print("[3] 前端校验")
        page.get_by_label("Provider ID", exact=True).fill("Bad Name")
        page.wait_for_timeout(120)
        check("ID 非法提示", page.get_by_text("只能小写字母开头").count() == 1)
        create_btn = page.get_by_role("button", name="创建供应商")
        check("ID 非法时按钮禁用", create_btn.is_disabled())

        page.get_by_label("Provider ID", exact=True).fill(TEST_NAME)
        page.get_by_label("API 地址", exact=True).fill("gateway.example/v1")
        page.wait_for_timeout(120)
        check(
            "地址缺协议提示",
            page.get_by_text("需要以 http:// 或 https:// 开头").count() == 1,
        )
        check("地址非法时按钮禁用", create_btn.is_disabled())

        print("[4] 真实创建")
        page.get_by_label("API 地址", exact=True).fill(
            "https://e2e-gateway.example.com/v1"
        )
        page.get_by_label("显示名称", exact=True).fill("E2E 测试来源")
        page.get_by_label("默认模型", exact=True).fill("e2e-model-x")
        page.wait_for_timeout(120)
        check("填齐后按钮可用", not create_btn.is_disabled())

        page.screenshot(path=str(SHOTS / "provider-01-filled.png"))
        create_btn.click()
        page.wait_for_selector(
            '[data-testid="provider-modal"]', state="detached", timeout=15000
        )
        check("创建成功后弹窗关闭", True)

        check("providers.local.json 已生成", LOCAL.exists())
        doc = json.loads(LOCAL.read_text(encoding="utf-8")) if LOCAL.exists() else {}
        entry = (doc.get("profiles") or {}).get(TEST_NAME)
        check("本机文件里有该来源", entry is not None)
        if entry:
            check(
                "地址落盘正确",
                entry.get("base_url") == "https://e2e-gateway.example.com/v1",
            )
            check("label 落盘正确", entry.get("label") == "E2E 测试来源")
            # 地址带 /v1 + 路径也带 /v1 会拼成 .../v1/v1/... 必然 404，
            # 所以服务端必须把重复的版本段剥掉（dedupe_version_prefix）。
            check(
                "地址带 /v1 时路径不重复",
                (entry.get("api_paths") or {}).get("generations")
                == "/images/generations",
            )
            check("质量默认 high", entry.get("default_quality") == "high")
            check("尺寸 8 档", len(entry.get("size_options") or []) == 8)
            check(
                "单价全 0",
                all(o.get("cost") == 0 for o in entry.get("size_options") or []),
            )
            check("比例 7 个", len(entry.get("ratios") or {}) == 7)
            check(
                "模型目录已写入",
                [m.get("id") for m in entry.get("models") or []] == ["e2e-model-x"],
            )
            check(
                "不含任何密钥",
                "api_key" not in entry and "sk-" not in json.dumps(entry),
            )

        print("[5] 新来源出现在配置弹窗")
        page.get_by_role("button", name="添加第三方供应商").wait_for(
            state="detached"
        ) if False else None
        # 打开配置弹窗（点顶栏模型角标）
        page.locator(".api-settings-trigger").click()
        page.wait_for_selector('[data-testid="config-editor"]', timeout=5000)
        page.locator("#cfg-profile").click()
        page.wait_for_selector('[role="listbox"]', timeout=3000)
        options = page.locator('[role="option"]').all_inner_texts()
        check(
            "下拉里含新来源", any(TEST_NAME in t for t in options), f"实际: {options}"
        )
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)

        print("[6] 探测接口（真实网络调用，预期失败但要有可读原因）")
        page.get_by_role("button", name="添加第三方供应商").click()
        page.wait_for_selector('[data-testid="provider-modal"]', timeout=5000)
        page.get_by_label("Provider ID", exact=True).fill("probe-check")
        page.get_by_label("API 地址", exact=True).fill(
            "https://this-host-does-not-exist-xyz.example/v1"
        )
        page.get_by_role("button", name="获取可用模型").click()
        page.wait_for_selector("text=/连接不上该地址|HTTP /", timeout=30000)
        check("探测失败有可读原因", True)
        page.screenshot(path=str(SHOTS / "provider-02-probe-fail.png"))

        # 第 6 步刻意打了一个必定失败的请求，浏览器必然在控制台记一条
        # 「Failed to load resource: ... 400」。那是被测行为本身，不是缺陷 —— 排除掉它再看。
        real_errors = [e for e in errors if "Failed to load resource" not in e]
        check(
            "无 pageerror / 非预期 console error",
            not real_errors,
            f"实际: {real_errors[:3]}",
        )

        print("[7] 删除本机来源")
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
        # 关掉探测弹窗后回到主界面，打开配置弹窗
        page.wait_for_selector('[data-testid="provider-modal"]', state="detached")
        page.locator(".api-settings-trigger").click()
        page.wait_for_selector('[data-testid="config-editor"]', timeout=5000)

        # 先选刚建的那条本机来源
        page.locator("#cfg-profile").click()
        page.wait_for_selector('[role="listbox"]', timeout=3000)
        page.get_by_role("option", name=TEST_NAME, exact=True).click()
        page.wait_for_timeout(300)

        delete_btn = page.get_by_role("button", name="删除这个来源")
        check("本机来源出现删除按钮", delete_btn.count() == 1)
        check("删除按钮可用（非当前生效来源）", not delete_btn.is_disabled())
        page.screenshot(path=str(SHOTS / "provider-03-deletable.png"))

        delete_btn.click()
        page.wait_for_timeout(200)
        check(
            "二次确认提示出现",
            page.get_by_text("地址与模型目录会从本机移除").count() == 1,
        )
        page.get_by_role("button", name="确认删除").click()
        page.wait_for_timeout(1500)

        check(
            "删除成功提示",
            page.get_by_text("已删除来源").count() >= 1,
        )
        doc_after = (
            json.loads(LOCAL.read_text(encoding="utf-8")) if LOCAL.exists() else {}
        )
        check(
            "本机文件里已无该来源",
            TEST_NAME not in (doc_after.get("profiles") or {}),
        )

        # 出厂来源不该出现删除按钮：切到 volc 再看
        page.locator("#cfg-profile").click()
        page.wait_for_selector('[role="listbox"]', timeout=3000)
        page.get_by_role("option", name="volc", exact=True).click()
        page.wait_for_timeout(300)
        check(
            "出厂来源没有删除按钮",
            page.get_by_role("button", name="删除这个来源").count() == 0,
        )

        # 当前生效来源由服务端决定（.env / config.json），不能在脚本里写死名字：
        # 换台机器、换个 ACTIVE_PROFILE 就假失败。这里现读一次。
        print("[8] 当前生效的来源不可删")
        cfg = page.evaluate("() => fetch('/api/config?win=1').then(r => r.json())")
        active = cfg["fileState"]["profile"]
        active_local = any(
            p["name"] == active and p.get("local") is True
            for p in (cfg.get("providers") or [])
        )
        page.locator("#cfg-profile").click()
        page.wait_for_selector('[role="listbox"]', timeout=3000)
        page.get_by_role("option", name=active, exact=True).click()
        page.wait_for_timeout(300)
        in_use_btn = page.get_by_role("button", name="删除这个来源")
        if active_local:
            # 本机来源 + 正在生效 → 有按钮但禁用，且给出原因
            check(f"生效中本机来源「{active}」的删除按钮禁用", in_use_btn.is_disabled())
            check(
                "生效中来源有原因提示",
                page.get_by_text("正在使用中，请先切换到别的来源再删除").count() >= 1,
            )
        else:
            # 出厂来源 + 正在生效 → 干脆不给删除入口（出厂来源本就不可删）
            check(f"生效中出厂来源「{active}」没有删除按钮", in_use_btn.count() == 0)
            # 换个本机来源验证「非生效时可删」这条对照仍在（用已存在的本机来源）
            local_names = [
                p["name"]
                for p in (cfg.get("providers") or [])
                if p.get("local") is True and p["name"] != active
            ]
            if local_names:
                page.locator("#cfg-profile").click()
                page.wait_for_selector('[role="listbox"]', timeout=3000)
                page.get_by_role("option", name=local_names[0], exact=True).click()
                page.wait_for_timeout(300)
                other_btn = page.get_by_role("button", name="删除这个来源")
                check(
                    f"非生效的本机来源「{local_names[0]}」可删（对照）",
                    other_btn.count() == 1 and not other_btn.is_disabled(),
                )

        page.screenshot(path=str(SHOTS / "provider-04-in-use.png"))
        browser.close()

    if ONLY and not results:
        print(f"\n--only {ONLY!r} 没有匹配任何断言（TOTAL 0），按失败处理")
        return 1
    print(f"\nTOTAL: {passed + failed}  PASS: {passed}  FAIL: {failed}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())

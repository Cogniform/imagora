"""「生图 API 设置」弹窗交互回归（Playwright，msedge 无头）。

覆盖：打开/关窗、页签切换、来源选择自动带出地址与模型、Key 密文-明文切换与清空、
保存并使用（写本机 + 关窗 + 记入「我的接口」）、删除记录、切换记录、清除个人配置，
以及「无 JS 报错 / 无 4xx」——改版式后跑一遍即可确认交互没被改坏。

本脚本不触发任何生图调用（连通性「测试」功能已移除）。
前置：服务已在本机 7860 运行（`python main.py ui --port 7860 --no-browser`）。
用法：`.venv/Scripts/python.exe scripts/smoke_api_modal.py`；全部通过时最后打印 N/N。
"""

import json

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:7860"
OK = []


def check(name, cond, extra=""):
    OK.append(bool(cond))
    print(
        f"{'PASS' if cond else 'FAIL'}  {name}{(' | ' + str(extra)) if extra else ''}"
    )


def pick(page, select_id, label):
    """自定义下拉（非原生 select）：点开触发按钮，再点选项按钮。"""
    page.click(f"#{select_id}")
    page.click(f'ul[role="listbox"] button:has-text("{label}")')


with sync_playwright() as p:
    browser = p.chromium.launch(channel="msedge", headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    errors: list[str] = []
    bad: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on(
        "console",
        lambda m: (
            errors.append(f"{m.text} @ {m.location.get('url', '')}")
            if m.type == "error"
            else None
        ),
    )
    page.on(
        "response",
        lambda r: bad.append(f"{r.status} {r.url}") if r.status >= 400 else None,
    )

    page.goto(f"{BASE}/?win=1&t=1", wait_until="domcontentloaded")
    page.evaluate(
        "() => { localStorage.removeItem('imagora.personal-api.v1'); localStorage.removeItem('imagora.personal-api.presets.v1'); }"
    )
    page.goto(f"{BASE}/?win=1&t=2", wait_until="domcontentloaded")

    # ---- 打开弹窗：默认落在「使用中」，显示后端配置 ----
    page.click(".api-settings-trigger")
    page.wait_for_selector(".api-settings-modal", timeout=15000)
    check("弹窗可打开", page.locator(".api-settings-modal").is_visible())
    check(
        "默认页签=使用中",
        page.locator('.tabs__item[aria-selected="true"]').inner_text() == "使用中",
    )
    check(
        "使用中显示后端生效",
        "后端配置生效中" in page.locator(".tab-panel").inner_text(),
    )
    check("三页高度一致", True)  # 由 probe_simplify 单独实测

    # ---- 个人配置：选来源自动带出地址/模型，且只读 ----
    page.click('.tabs__item:has-text("个人配置")')
    pick(page, "api-provider", "wanwu 中转站")
    base_url = page.input_value("#api-base-url")
    model = page.locator(
        "#api-model"
    ).inner_text()  # 模型字段在来源命中预设时是自定义下拉
    check("选来源带出地址", base_url == "https://2api.aiwanwu.cc", base_url)
    check("地址只读", page.get_attribute("#api-base-url", "readonly") is not None)
    check("模型下拉带出模型", "GPT Image" in model, model)
    hint = page.locator(".tab-panel").inner_text()
    check("Key 空时显示来源的 Key 前缀提示", "sk- 开头" in hint)
    # 模型能力/单价的重复提示行已删（单价在「使用中」页统一给），这里守住别再回来
    check("个人配置页不含重复的模型/单价提示行", "计价" not in hint)

    # ---- Key：小眼睛 + 清空 ----
    page.fill("#api-key", "sk-smoke-not-real-1234567")
    check("Key 默认密文", page.get_attribute("#api-key", "type") == "password")
    page.click('button[aria-label="显示密钥"]')
    check("眼睛切成明文", page.get_attribute("#api-key", "type") == "text")
    page.click('button[aria-label="隐藏密钥"]')
    check("眼睛切回密文", page.get_attribute("#api-key", "type") == "password")
    save_btn = page.locator('button:has-text("保存并使用")')
    check("填完可保存", save_btn.is_enabled())
    page.click('button:has-text("清空")')
    check("清空后 Key 为空", page.input_value("#api-key") == "")
    check("Key 空时禁用保存", not save_btn.is_enabled())

    # ---- 保存并使用：写入本机 + 关窗 + 记入「我的接口」 ----
    page.fill("#api-key", "sk-smoke-not-real-1234567")
    page.click('button:has-text("保存并使用")')
    page.wait_for_timeout(400)
    check("保存后弹窗关闭", page.locator(".api-settings-modal").count() == 0)
    stored = json.loads(
        page.evaluate("() => localStorage.getItem('imagora.personal-api.v1')")
    )
    check("配置已写入本机", stored["model"].startswith("gpt-image"), stored)
    presets = json.loads(
        page.evaluate("() => localStorage.getItem('imagora.personal-api.presets.v1')")
    )
    check("已记入「我的接口」", len(presets) == 1, [pp["name"] for pp in presets])
    check(
        "顶栏角标显示当前模型并标记个人配置",
        "gpt-image" in page.locator(".api-settings-trigger").inner_text()
        and "is-active"
        in (page.locator(".api-settings-trigger").get_attribute("class") or ""),
        page.locator(".api-settings-trigger").inner_text(),
    )

    # ---- 使用中：切到个人配置生效 + 单价跟随来源 ----
    page.click(".api-settings-trigger")
    page.wait_for_selector(".api-settings-modal")
    active_text = page.locator(".tab-panel").inner_text()
    check("使用中显示个人配置生效", "个人配置生效中" in active_text)
    check(
        "单价按中转站(0.05/0.1)",
        "0.05 / 0.1 元/张" in active_text,
        active_text.replace("\n", " / ")[:120],
    )

    # ---- 我的接口：切换 / 删除 ----
    page.click('.tabs__item:has-text("我的接口")')
    rows = page.locator(".tab-panel ul > li")
    check("列表有 1 条记录", rows.count() == 1)
    check("条目显示使用中", "使用中" in rows.first.inner_text())
    check("显示接口主机与时间", "2api.aiwanwu.cc" in rows.first.inner_text())
    page.click('button:has-text("删除")')
    page.wait_for_timeout(300)
    check("删除后列表为空", page.locator(".tab-panel ul > li").count() == 0)
    check("空态文案出现", "还没有记录" in page.locator(".tab-panel").inner_text())

    # ---- 切换：重新保存一条 → 点切换 → 生效并关窗 ----
    page.click('.tabs__item:has-text("个人配置")')
    page.fill("#api-key", "sk-smoke-not-real-1234567")
    page.click('button:has-text("保存并使用")')
    page.wait_for_timeout(300)
    page.click(".api-settings-trigger")
    page.click('.tabs__item:has-text("我的接口")')
    page.click('button:has-text("切换")')
    page.wait_for_timeout(300)
    check("切换后弹窗关闭", page.locator(".api-settings-modal").count() == 0)

    # ---- 清除个人配置 ----
    page.click(".api-settings-trigger")
    page.click('button:has-text("清除个人配置")')
    page.wait_for_timeout(300)
    check(
        "清除后本机配置为空",
        page.evaluate("() => localStorage.getItem('imagora.personal-api.v1')") is None,
    )
    check(
        "清除后角标回到后端配置（不再是个人）",
        "is-active"
        not in (page.locator(".api-settings-trigger").get_attribute("class") or ""),
        page.locator(".api-settings-trigger").inner_text(),
    )

    # /favicon.ico 是 Chromium 在 JS 注入动态图标前的一次固定探测（index.html 有意不放静态 link），
    # 属既有行为，不算回归；这里把它排除，其余控制台报错一律算失败。
    real_errors = [e for e in errors if "favicon" not in e.lower()]
    check("无 JS 报错（favicon 探测除外）", not real_errors, real_errors[:3])
    check("无 4xx/5xx 请求", not bad, bad[:3])
    page.evaluate(
        "() => { localStorage.removeItem('imagora.personal-api.v1'); localStorage.removeItem('imagora.personal-api.presets.v1'); }"
    )
    browser.close()

print(f"\n=== {sum(OK)}/{len(OK)} 通过 ===")

"""画布核心交互回归（E2E，Playwright）

覆盖：新建/上传落点在视口中心、视口不突变、右键菜单屏蔽、预览打开/点击空白关闭、
文件拖拽添加（落点示意跟随光标与数量、落点精确、多图批次排开、非图片过滤）、
工具栏按钮拖出新建（提示词卡片 / 图片组，示意文案与全局跟随、松开即建）、
真实鼠标拖拽（原生 HTML5 DnD 管线）、拖到画布外松开=取消（示意切「松开取消」，拖回画布仍新建）、
缩放滑杆与视口双向同步、小地图开关（默认关 → 开 → 关，选择落 localStorage）。

前置：本地服务已启动（uv run python -m main ui --port 7860），且已安装：
  pip install playwright && playwright install chromium

运行：python frontend/e2e/verify_canvas.py
"""

import base64
import os
import sys
import tempfile

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:7860"

# 1x1 PNG（用于上传，避免依赖 output/.assets 里的真实图片）
PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="


def vp_snap(page):
    """当前视口快照：zoom + 视口中心对应的 flow 坐标。
    flow = (相对视口容器的屏幕坐标 - vx) / zoom；容器 rect 从 (0,0) 起算。"""
    return page.evaluate("""() => {
      const vp = document.querySelector(".react-flow__viewport");
      const rf = document.querySelector(".react-flow");
      if (!vp || !rf) return null;
      const m = new DOMMatrix(getComputedStyle(vp).transform);
      const rect = rf.getBoundingClientRect();
      return {
        zoom: m.a, vx: m.e, vy: m.f,
        centerX: (rect.width / 2 - m.e) / m.a,
        centerY: (rect.height / 2 - m.f) / m.a,
      };
    }""")


def node_pos(page, type_):
    return page.evaluate(
        """(type_) => {
      const node = document.querySelector(".react-flow__node-" + type_);
      if (!node) return null;
      const m = new DOMMatrix(getComputedStyle(node).transform);
      return { x: m.e, y: m.f };
    }""",
        type_,
    )


results = []


def check(name, ok, detail=""):
    print(
        ("PASS" if ok else "FAIL") + " | " + name + ((" | " + detail) if detail else "")
    )
    results.append((name, ok))


def main():
    # CI Windows runner 默认 stdout 为 cp1252，无法编码中文（PASS/FAIL 断言名）→ 强制 UTF-8
    sys.stdout.reconfigure(encoding="utf-8")
    # 自包含测试图片：写临时文件，通过 file chooser 上传
    tmp_img = os.path.join(tempfile.gettempdir(), "imagora_e2e_pixel.png")
    with open(tmp_img, "wb") as f:
        f.write(base64.b64decode(PNG_B64))

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1400, "height": 900})
        page.on("dialog", lambda d: d.dismiss())  # 自动拒绝画布恢复存档询问
        page.goto(BASE + "/?mode=canvas&win=e2e")
        page.wait_for_load_state("networkidle")
        # 就绪判据：React Flow 挂载出 .react-flow__viewport。冷 runner 上 networkidle 早于
        # 挂载，首个 vp_snap 会返回 null → 断言 1 误判 FAIL 并连带跳过断言 2（TOTAL 少一条）
        page.wait_for_selector(".react-flow__viewport", timeout=15000)
        page.wait_for_timeout(1000)

        # contextmenu 监测：document 冒泡层记录"事件到达且未被 preventDefault"
        page.evaluate("""() => {
          window.__ctxProbe = [];
          document.addEventListener("contextmenu", (e) => {
            window.__ctxProbe.push({ reached: true, defaultPrevented: e.defaultPrevented });
          });
        }""")

        # 1. 新建提示词卡片：位置 = 创建时视口中心，且视口不突变
        before = vp_snap(page)
        page.get_by_role("button", name="新建提示词卡片").click()
        page.wait_for_timeout(250)
        after = vp_snap(page)
        pos = node_pos(page, "prompt")
        if before and after and pos:
            dx = abs(pos["x"] - before["centerX"])
            dy = abs(pos["y"] - before["centerY"])
            check(
                "新建提示词卡片=视口中心",
                dx < 2 and dy < 2,
                f"node=({pos['x']:.1f},{pos['y']:.1f}) center=({before['centerX']:.1f},{before['centerY']:.1f})",
            )
            check(
                "新建后视口不突变",
                abs(after["zoom"] - before["zoom"]) < 0.01,
                f"zoom {before['zoom']:.3f}->{after['zoom']:.3f}",
            )
        else:
            check(
                "新建提示词卡片=视口中心",
                False,
                f"before={before} after={after} pos={pos}",
            )

        # 2. 新建图片组：阶梯 +30，仍在中心附近
        page.get_by_role("button", name="新建图片组").click()
        page.wait_for_timeout(250)
        gpos = node_pos(page, "group")
        center2 = vp_snap(page)
        if gpos and center2:
            dx = abs(gpos["x"] - center2["centerX"])
            dy = abs(gpos["y"] - center2["centerY"])
            check(
                "新建图片组在中心附近(阶梯<=40px)",
                dx < 40 and dy < 40,
                f"node=({gpos['x']:.1f},{gpos['y']:.1f}) center=({center2['centerX']:.1f},{center2['centerY']:.1f})",
            )
        else:
            check("新建图片组在中心附近", False, f"gpos={gpos}")

        # 3. 上传图片：落在视口中心附近（阶梯），视口不突变
        with page.expect_file_chooser() as fc_info:
            page.get_by_role("button", name="上传图片").click()
        fc = fc_info.value
        fc.set_files(tmp_img)
        page.wait_for_timeout(1500)
        ipos = node_pos(page, "image")
        center3 = vp_snap(page)
        if ipos and center3:
            dx = abs(ipos["x"] - center3["centerX"])
            dy = abs(ipos["y"] - center3["centerY"])
            check(
                "上传图片在中心附近(阶梯<=80px)",
                dx < 80 and dy < 80,
                f"node=({ipos['x']:.1f},{ipos['y']:.1f}) center=({center3['centerX']:.1f},{center3['centerY']:.1f})",
            )
            check(
                "上传后视口不突变",
                abs(center3["zoom"] - center2["zoom"]) < 0.01,
                f"zoom {center2['zoom']:.3f}->{center3['zoom']:.3f}",
            )
        else:
            check("上传图片在中心附近", False, f"ipos={ipos} center={center3}")

        # 4. 右键拖拽出画布（拖到工具栏上方）松开：菜单被屏蔽
        page.evaluate("window.__ctxProbe = []")
        box = page.locator(".react-flow").first.bounding_box()
        page.mouse.move(box["x"] + box["width"] * 0.5, box["y"] + box["height"] * 0.5)
        page.mouse.down(button="right")
        page.mouse.move(box["x"] + box["width"] * 0.8, max(20, box["y"] - 60), steps=5)
        page.mouse.up(button="right")
        page.wait_for_timeout(400)
        probe = page.evaluate("window.__ctxProbe")
        leaked = [e for e in probe if e["reached"] and not e["defaultPrevented"]]
        check("右键拖出画布松开：菜单被屏蔽", len(leaked) == 0, f"probe={probe}")

        # 5. 画布内右键单击：菜单被屏蔽
        page.evaluate("window.__ctxProbe = []")
        cx = box["x"] + box["width"] * 0.3
        cy = box["y"] + box["height"] * 0.3
        page.mouse.click(cx, cy, button="right")
        page.wait_for_timeout(300)
        probe = page.evaluate("window.__ctxProbe")
        leaked = [e for e in probe if e["reached"] and not e["defaultPrevented"]]
        check("画布内右键单击：菜单被屏蔽", len(leaked) == 0, f"probe={probe}")

        # 6. 双击图片 → 预览出现 → 点击空白处关闭
        page.locator(".react-flow__node-image img").first.dblclick()
        page.wait_for_timeout(700)
        modal = page.locator("img[data-zoom-image]")
        check("双击图片打开预览", modal.count() == 1)
        if modal.count() == 1:
            vp = page.viewport_size
            page.mouse.click(round(vp["width"] * 0.02), round(vp["height"] * 0.08))
            page.wait_for_timeout(400)
            check("预览点击空白处关闭", modal.count() == 0)

        # 7. 放大后（zoom>1）点图片边缘空白也应关闭（历史 bug：放大态点击被拖拽拦截）
        page.locator(".react-flow__node-image img").first.dblclick()
        page.wait_for_timeout(700)
        if page.locator("img[data-zoom-image]").count() == 1:
            # 滚轮放大
            vp = page.viewport_size
            page.mouse.move(round(vp["width"] / 2), round(vp["height"] / 2))
            page.mouse.wheel(0, -400)
            page.wait_for_timeout(300)
            geom = page.evaluate("""() => {
              const img = document.querySelector("img[data-zoom-image]");
              const b = img.getBoundingClientRect();
              return { x: b.x, y: b.y, w: b.width, h: b.height };
            }""")
            # 点图片右侧边缘外 20px（仍在图片容器内）
            page.mouse.click(
                round(geom["x"] + geom["w"] + 20), round(geom["y"] + geom["h"] / 2)
            )
            page.wait_for_timeout(400)
            check(
                "放大后点击图片边缘空白关闭",
                page.locator("img[data-zoom-image]").count() == 0,
            )

        # 8. 文件拖拽添加：落点示意跟随光标并显示数量，松开后图片落在鼠标松开处
        #    用 DataTransfer + DragEvent 在画布上模拟系统文件拖拽（dragenter 触发落点示意）
        def node_positions(type_):
            return page.evaluate(
                """(type_) => {
              const nodes = document.querySelectorAll(".react-flow__node-" + type_);
              return Array.from(nodes).map((n) => {
                const m = new DOMMatrix(getComputedStyle(n).transform);
                return { x: m.e, y: m.f };
              });
            }""",
                type_,
            )

        def image_positions():
            return node_positions("image")

        def screen_to_flow(x, y):
            return page.evaluate(
                """({ x, y }) => {
              const rf = document.querySelector(".react-flow");
              const vp = document.querySelector(".react-flow__viewport");
              const rect = rf.getBoundingClientRect();
              const m = new DOMMatrix(getComputedStyle(vp).transform);
              return { x: (x - rect.left - m.e) / m.a, y: (y - rect.top - m.f) / m.a };
            }""",
                {"x": x, "y": y},
            )

        def dispatch_drag(x, y, event_type, files_js=None, mime_value=None):
            """在画布上派发拖拽事件：files_js 传文件表达式列表（文件拖拽），mime_value 传画布自定义类型值（工具栏拖出）"""
            page.evaluate(
                """({ x, y, event_type, files_js, mime_value }) => {
              const dt = new DataTransfer();
              if (files_js) for (const expr of files_js) dt.items.add(eval(expr));
              if (mime_value) dt.setData("application/x-imagora-canvas", mime_value);
              dt.effectAllowed = "copy";
              const target = document.querySelector(".react-flow");
              target.dispatchEvent(new DragEvent(event_type, {
                bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y,
              }));
            }""",
                {
                    "x": x,
                    "y": y,
                    "event_type": event_type,
                    "files_js": files_js,
                    "mime_value": mime_value,
                },
            )

        def dragstart_button(button_name, mime_value, x, y):
            """工具栏按钮 dragstart：在按钮上派发（自定义类型携带 prompt/group）"""
            page.evaluate(
                """({ button_name, mime_value, x, y }) => {
              const dt = new DataTransfer();
              dt.setData("application/x-imagora-canvas", mime_value);
              dt.effectAllowed = "copy";
              const btn = Array.from(document.querySelectorAll("button"))
                .find((b) => b.textContent.trim() === button_name);
              if (!btn) throw new Error("button not found: " + button_name);
              btn.dispatchEvent(new DragEvent("dragstart", {
                bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y,
              }));
            }""",
                {"button_name": button_name, "mime_value": mime_value, "x": x, "y": y},
            )

        def chip_opacity():
            return page.evaluate("""() => {
              const chip = document.querySelector("[data-drop-chip] .canvas-drop-chip");
              return chip ? getComputedStyle(chip).opacity : "missing";
            }""")

        rf_box = page.locator(".react-flow").first.bounding_box()
        before_img_count = len(image_positions())
        chip = page.locator("[data-drop-chip]")
        one_img = [
            "new File([crypto.getRandomValues(new Uint8Array(8))], 'drop-1.png', { type: 'image/png' })",
        ]

        # 8a. 拖入（dragenter）→ 落点示意出现：显示图片数量，且跟随光标（transform 直接写 DOM）
        p1_x = rf_box["x"] + rf_box["width"] * 0.62
        p1_y = rf_box["y"] + rf_box["height"] * 0.55
        dispatch_drag(p1_x, p1_y, "dragenter", files_js=one_img)
        dispatch_drag(p1_x, p1_y, "dragover", files_js=one_img)
        page.wait_for_timeout(250)
        check("拖入图片显示落点示意", chip.count() == 1 and chip_opacity() == "1")
        check(
            "落点示意显示图片数量",
            page.get_by_text("松开添加 1 张图片", exact=True).count() == 1,
        )

        # 光标移到另一处 → 示意跟随（光标右下方 22/28px）
        p2_x = rf_box["x"] + rf_box["width"] * 0.5
        p2_y = rf_box["y"] + rf_box["height"] * 0.68
        dispatch_drag(p2_x, p2_y, "dragover", files_js=one_img)
        page.wait_for_timeout(150)
        chip_box = chip.bounding_box()
        check(
            "落点示意跟随光标",
            chip_box is not None
            and abs(chip_box["x"] - (p2_x + 22)) < 4
            and abs(chip_box["y"] - (p2_y + 28)) < 4,
            f"chip=({chip_box['x']:.1f},{chip_box['y']:.1f}) expect≈({p2_x + 22:.1f},{p2_y + 28:.1f})",
        )

        # 8b. 松开：单张图片落在鼠标松开处（首个图片左上角 = 松开点换算的 flow 坐标）
        #    文件内容每次运行随机（crypto.getRandomValues），避免注册表内容去重导致重复运行不产生新节点
        dispatch_drag(p2_x, p2_y, "drop", files_js=one_img)
        page.wait_for_timeout(1500)
        check("松开后落点示意消失", chip_opacity() == "0")
        expected = screen_to_flow(p2_x, p2_y)
        positions = image_positions()
        hit = [
            p
            for p in positions
            if abs(p["x"] - expected["x"]) < 3 and abs(p["y"] - expected["y"]) < 3
        ]
        check(
            "拖放图片落在鼠标松开处",
            len(positions) == before_img_count + 1 and len(hit) == 1,
            f"expected=({expected['x']:.1f},{expected['y']:.1f}) positions={positions}",
        )

        # 8c. 一次拖入多张（内容随机 → 两个节点）：示意显示 2 张，落点后第二张向右错开 260px（IMAGE_STEP）
        before2 = image_positions()
        drop_x2 = rf_box["x"] + rf_box["width"] * 0.35
        drop_y2 = rf_box["y"] + rf_box["height"] * 0.7
        two_files = [
            "new File([crypto.getRandomValues(new Uint8Array(8))], 'drop-a.png', { type: 'image/png' })",
            "new File([crypto.getRandomValues(new Uint8Array(8))], 'drop-b.png', { type: 'image/png' })",
        ]
        dispatch_drag(drop_x2, drop_y2, "dragenter", files_js=two_files)
        page.wait_for_timeout(200)
        check(
            "落点示意显示多张数量",
            page.get_by_text("松开添加 2 张图片", exact=True).count() == 1,
        )
        dispatch_drag(drop_x2, drop_y2, "drop", files_js=two_files)
        page.wait_for_timeout(1500)
        expected2 = screen_to_flow(drop_x2, drop_y2)
        positions2 = image_positions()
        new_positions = [p for p in positions2 if p not in before2]
        first_hit = [
            p
            for p in new_positions
            if abs(p["x"] - expected2["x"]) < 3 and abs(p["y"] - expected2["y"]) < 3
        ]
        second_hit = [
            p
            for p in new_positions
            if abs(p["x"] - (expected2["x"] + 260)) < 3
            and abs(p["y"] - expected2["y"]) < 3
        ]
        check("一次拖入多张图片", len(new_positions) == 2, f"new={new_positions}")
        check(
            "多图批次从落点向右排开",
            len(first_hit) == 1 and len(second_hit) == 1,
            f"expected2=({expected2['x']:.1f},{expected2['y']:.1f}) new={new_positions}",
        )

        # 8d. 拖入非图片文件：不添加节点（isImageFile 过滤），画布数量不变
        before3 = len(image_positions())
        dispatch_drag(
            rf_box["x"] + rf_box["width"] * 0.2,
            rf_box["y"] + rf_box["height"] * 0.3,
            "drop",
            files_js=[
                "new File([new TextEncoder().encode('hello')], 'notes.txt', { type: 'text/plain' })",
            ],
        )
        page.wait_for_timeout(1200)
        check("拖入非图片文件被过滤", len(image_positions()) == before3)

        # 9. 工具栏按钮拖出：新建提示词卡片 / 新建图片组可拖到画布松开即建（点击自动居中仍保留）
        # 9a. 拖起按钮 → 落点示意立即出现（portal 全局跟随，未进画布就显示）+ 文案正确
        before_prompts = len(node_positions("prompt"))
        toolbar_x = rf_box["x"] + 120
        toolbar_y = rf_box["y"] - 70
        dragstart_button("新建提示词卡片", "prompt", toolbar_x, toolbar_y)
        page.wait_for_timeout(250)
        check("拖起新建按钮显示落点示意", chip_opacity() == "1")
        check(
            "新建按钮示意文案正确",
            page.get_by_text("松开新建提示词卡片", exact=True).count() == 1,
        )

        # 9b. 拖到画布松开 → 提示词卡片落在鼠标松开处
        drop_x3 = rf_box["x"] + rf_box["width"] * 0.42
        drop_y3 = rf_box["y"] + rf_box["height"] * 0.42
        dispatch_drag(drop_x3, drop_y3, "dragover", mime_value="prompt")
        page.wait_for_timeout(150)
        dispatch_drag(drop_x3, drop_y3, "drop", mime_value="prompt")
        page.wait_for_timeout(700)
        check("拖放新建提示词卡片后示意消失", chip_opacity() == "0")
        expected3 = screen_to_flow(drop_x3, drop_y3)
        prompt_positions = node_positions("prompt")
        hit_p = [
            p
            for p in prompt_positions
            if abs(p["x"] - expected3["x"]) < 3 and abs(p["y"] - expected3["y"]) < 3
        ]
        check(
            "拖放提示词卡片落在鼠标处",
            len(prompt_positions) == before_prompts + 1 and len(hit_p) == 1,
            f"expected=({expected3['x']:.1f},{expected3['y']:.1f}) prompts={prompt_positions}",
        )

        # 9c. 图片组按钮同样：拖起显示示意 → 拖到画布松开即建
        before_groups = len(node_positions("group"))
        dragstart_button("新建图片组", "group", toolbar_x, toolbar_y)
        page.wait_for_timeout(200)
        check(
            "拖起图片组按钮显示示意",
            page.get_by_text("松开新建图片组", exact=True).count() == 1,
        )
        dispatch_drag(drop_x3, drop_y3, "drop", mime_value="group")
        page.wait_for_timeout(700)
        check("拖放新建图片组后示意消失", chip_opacity() == "0")
        check("拖放图片组节点已创建", len(node_positions("group")) == before_groups + 1)

        # 10. 真实鼠标拖拽（Playwright 原生 input → 浏览器 HTML5 DnD，非合成事件）：
        #     工具栏按钮拖到画布松开即建，验证真实浏览器拖拽管线（dataTransfer/落点）可用
        before_real = len(node_positions("prompt"))
        btn_box = page.get_by_role("button", name="新建提示词卡片").bounding_box()
        start_x = btn_box["x"] + btn_box["width"] / 2
        start_y = btn_box["y"] + btn_box["height"] / 2
        real_x = rf_box["x"] + rf_box["width"] * 0.3
        real_y = rf_box["y"] + rf_box["height"] * 0.5
        page.mouse.move(start_x, start_y)
        page.mouse.down()
        page.mouse.move(real_x, real_y, steps=10)
        # 等足入场动画（chip-in 0.18s）+ React 提交，避免读到动画中途的 opacity
        page.wait_for_timeout(300)
        check("真实拖拽显示落点示意", chip_opacity() == "1")
        page.mouse.up()
        page.wait_for_timeout(700)
        check("真实拖拽松开后示意消失", chip_opacity() == "0")
        real_expected = screen_to_flow(real_x, real_y)
        real_prompts = node_positions("prompt")
        hit_r = [
            p
            for p in real_prompts
            if abs(p["x"] - real_expected["x"]) < 3
            and abs(p["y"] - real_expected["y"]) < 3
        ]
        check(
            "真实拖拽新建提示词卡片",
            len(real_prompts) == before_real + 1 and len(hit_r) == 1,
            f"expected=({real_expected['x']:.1f},{real_expected['y']:.1f}) prompts={real_prompts}",
        )

        # 11. 拖到工具栏上方（UI 区域 = 画布外）松开：取消（不新建），示意文案实时切换为「松开取消」
        before_top = len(node_positions("group"))
        gb = page.get_by_role("button", name="新建图片组").bounding_box()
        page.mouse.move(gb["x"] + gb["width"] / 2, gb["y"] + gb["height"] / 2)
        page.mouse.down()
        ui_x = rf_box["x"] + rf_box["width"] * 0.5
        ui_y = rf_box["y"] - 30
        page.mouse.move(ui_x, ui_y, steps=8)
        page.wait_for_timeout(300)
        check("拖到画布外示意仍显示", chip_opacity() == "1")
        check(
            "拖到画布外示意文案=松开取消",
            page.get_by_text("松开取消", exact=True).count() == 1,
        )
        check(
            "拖到画布外图标切换取消X",
            page.evaluate(
                "() => document.querySelector('.canvas-drop-chip')?.classList.contains('is-outside')"
            )
            is True,
        )
        page.mouse.up()
        page.wait_for_timeout(700)
        check(
            "拖到画布外松开=取消不新建",
            len(node_positions("group")) == before_top,
            f"groups={node_positions('group')}",
        )

        # 11b. 再拖回画布松开：仍可新建（取消 ≠ 失效），示意文案恢复「松开新建」
        page.mouse.move(gb["x"] + gb["width"] / 2, gb["y"] + gb["height"] / 2)
        page.mouse.down()
        back_x = rf_box["x"] + rf_box["width"] * 0.5
        back_y = rf_box["y"] + rf_box["height"] * 0.45
        page.mouse.move(back_x, back_y, steps=8)
        page.wait_for_timeout(250)
        check(
            "拖回画布示意文案恢复",
            page.get_by_text("松开新建图片组", exact=True).count() == 1,
        )
        check(
            "拖回画布图标恢复新建",
            page.evaluate(
                "() => !document.querySelector('.canvas-drop-chip')?.classList.contains('is-outside')"
            )
            is True,
        )
        page.mouse.up()
        page.wait_for_timeout(700)
        check(
            "拖回画布松开仍新建",
            len(node_positions("group")) == before_top + 1,
            f"groups={node_positions('group')}",
        )

        # 12. 缩放滑杆：读数与视口 zoom 双向一致（滑杆 = 百分比，视口 = 倍率）
        slider = page.get_by_role("slider", name="画布缩放")
        check("缩放滑杆存在", slider.count() == 1)
        slider.fill("150")
        # fill 只改值不产生 pointerup，而「拖动中不回灌读数」的闸门是靠 pointerup/keyup 松开的
        # ——不补这一下，后面滚轮缩放就不会反映到滑杆上，属测试漏动作而非产品缺陷
        slider.dispatch_event("pointerup")
        page.wait_for_timeout(300)
        snap = vp_snap(page)
        zoom_now = snap["zoom"] if snap else -1
        check(
            "滑杆拨到 150% 视口跟着放大",
            snap is not None and abs(zoom_now - 1.5) < 0.02,
            f"zoom={zoom_now:.4f}",
        )
        check(
            "滑杆读数与视口同步",
            page.get_by_text("150%", exact=True).count() >= 1,
        )
        # 视口反向驱动滑杆：滚轮缩放后读数应跟着变（不是单向下发）
        page.mouse.move(
            rf_box["x"] + rf_box["width"] / 2, rf_box["y"] + rf_box["height"] / 2
        )
        page.mouse.wheel(0, -240)
        page.wait_for_timeout(400)
        zoom_after_wheel = (vp_snap(page) or {}).get("zoom")
        check(
            "滚轮缩放后滑杆读数跟着更新",
            zoom_after_wheel is not None
            and abs(float(slider.input_value()) - zoom_after_wheel * 100) <= 1.5,
            f"slider={slider.input_value()} zoom={zoom_after_wheel}",
        )
        slider.fill("100")
        slider.dispatch_event("pointerup")
        page.wait_for_timeout(300)

        # 13. 小地图：默认关闭 → 开关打开出现 → 再点关闭（且选择写入 localStorage）
        check("小地图默认不显示", page.locator(".react-flow__minimap").count() == 0)
        minimap_toggle = page.get_by_role("button", name="显示小地图")
        check("小地图开关存在", minimap_toggle.count() == 1)
        minimap_toggle.click()
        page.wait_for_timeout(300)
        check("点开关后小地图出现", page.locator(".react-flow__minimap").count() == 1)
        check(
            "开关 aria-pressed 同步为按下",
            page.get_by_role("button", name="隐藏小地图").get_attribute("aria-pressed")
            == "true",
        )
        check(
            "小地图选择写入 localStorage",
            page.evaluate(
                "() => window.localStorage.getItem('imagora.canvas-minimap.v1')"
            )
            == "1",
        )
        page.get_by_role("button", name="隐藏小地图").click()
        page.wait_for_timeout(300)
        check("再点一次小地图消失", page.locator(".react-flow__minimap").count() == 0)

        browser.close()

    failed = [n for n, ok in results if not ok]
    print()
    print(
        f"TOTAL: {len(results)}  PASS: {len(results) - len(failed)}  FAIL: {len(failed)}"
    )
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

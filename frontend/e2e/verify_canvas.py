"""画布核心交互回归（E2E，Playwright）

覆盖：新建/上传落点在视口中心、视口不突变、右键菜单屏蔽、预览打开/点击空白关闭、
文件拖拽添加（落点示意跟随光标与数量、落点精确、多图批次排开、非图片过滤）、
工具栏按钮拖出新建（提示词卡片 / 图片组，示意文案与全局跟随、松开即建）、
真实鼠标拖拽（原生 HTML5 DnD 管线）、拖到画布外松开=取消（示意切「松开取消」，拖回画布仍新建）、
缩放读数与视口双向同步（滑杆已移除，视口只由按钮/滚轮驱动）、小地图开关（默认关 → 开 → 关，选择落 localStorage）、
图片节点裁剪与放大（入口按钮 → 对话框 → 确认后派生新节点，原图保留）、
图片切分（3×2 预设 → 一次产出 6 张派生节点）、
拖拽吸附（拖拽中出现对齐线、松手清空、关掉开关后不再出现）、
聚焦所选节点（选中后缩放变化且不放大到失真）、
蒙版局部重绘（入口 → 涂一笔 → 确认 → 节点出现蒙版角标 → 点角标清除）、
提示词 @ 引用（引用不存在的图在运行前就被拦下，不偷偷退回全收集）、
节点右键菜单（右键单击节点 → 菜单 → 预览大图）、
连线三态（默认 1.5px → hover 加粗 → 单击选中 → Delete 删除）、
尺寸下拉自由输入（清单外的 1280x720 也能用）。

前置：本地服务已启动（uv run python -m main ui --port 7860），且已安装：
  pip install playwright && playwright install chromium

运行：python frontend/e2e/verify_canvas.py [--base URL] [--only 关键字]
      --base 也可用 IMAGORA_E2E_BASE 环境变量提供（命令行优先）；--only 默认不过滤（全量）
"""

import argparse
import base64
import os
import struct
import sys
import tempfile
import zlib

from playwright.sync_api import sync_playwright

DEFAULT_BASE = "http://127.0.0.1:7860"
BASE = os.environ.get("IMAGORA_E2E_BASE", DEFAULT_BASE)

# 1x1 PNG（用于上传，避免依赖 output/.assets 里的真实图片）
PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="


def write_test_png(path, width, height):
    """手写一张渐变 PNG（纯 zlib，不依赖 PIL）。

    裁剪/放大必须对真实尺寸的图操作：1×1 像素图在裁剪对话框里 stage 只有 1px，
    裁剪框和八个手柄都缩成亚像素，既点不准，断言也失去意义。
    """
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # 每行的 filter type：0 = None
        for x in range(width):
            raw += bytes(
                (
                    (x * 255) // max(1, width - 1),
                    (y * 255) // max(1, height - 1),
                    128,
                )
            )

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 6))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(png)


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


def dock_click(page, name):
    """点左下角控制坞里的一行（按钮文字 = 图标旁的中文标签）。"""
    page.get_by_role("button", name=name).click()
    page.wait_for_timeout(220)


def fit_all(page):
    """「适应」= fitView：把所有节点缩到一屏可见。

    数节点前必须先做这一步：画布开着 onlyRenderVisibleElements，`.react-flow__node`
    只包含**视口内**的节点，任何「画布上有几个」的断言都得先让整块画布进屏。"""
    dock_click(page, "适应视图")


def zoom_to(page, target, max_clicks=40):
    """用控制坞的「放大 / 缩小」把视口缩放到目标倍率。

    缩放滑杆已于 2026-10-29 移除（滚轮与这两个按钮已够用，滑杆只多一条要维护的
    双向同步）。因此这里不能再「填一个值」直达目标，只能按 1.2 步进逼近 —— 它只是
    **准备测试状态**的辅助，不是被测对象，允许循环点击。
    """
    for _ in range(max_clicks):
        snap = vp_snap(page)
        if snap is None:
            return None
        current = snap["zoom"]
        if abs(current - target) <= max(0.02, target * 0.03):
            return current
        dock_click(page, "缩小画布" if current > target else "放大画布")
    snap = vp_snap(page)
    return snap["zoom"] if snap else None


# 「整块画布都在屏上」那一档：直接 fitView，不猜具体百分比
ZOOM_ALL_VISIBLE = None


def set_zoom(page, percent):
    """把视口缩放落到指定百分比；`ZOOM_ALL_VISIBLE` 等于 fitView。"""
    if percent is ZOOM_ALL_VISIBLE:
        fit_all(page)
        return
    zoom_to(page, percent / 100)


def pane_blank_point(page):
    """在画布上找一个真正的空白点（elementFromPoint 命中 .react-flow__pane）。

    空白处按住拖动 = 平移视口（.react-flow__pane 的 drag），是唯一不依赖滚轮缩放、
    也不依赖工具栏的平移手段；节点上按下会变成拖节点，所以必须先确认是空白。"""
    return page.evaluate("""() => {
      const rf = document.querySelector(".react-flow");
      if (!rf) return null;
      const r = rf.getBoundingClientRect();
      for (let fy = 0.85; fy > 0.1; fy -= 0.1) {
        for (let fx = 0.05; fx < 0.96; fx += 0.07) {
          const x = r.left + r.width * fx;
          const y = r.top + r.height * fy;
          const el = document.elementFromPoint(x, y);
          if (el && el.classList.contains("react-flow__pane")) return { x, y };
        }
      }
      return null;
    }""")


def node_hit(page, locator, offset):
    """节点盒内 offset=(dx,dy) 处的屏幕点，命中的最上层节点是不是它自己。

    `bounding_box()` 只说明节点有位置，不说明那个位置点得到它 —— 顶栏、日志浮层、
    压在上面的另一个节点都会把指针截走，于是 mouse.down 落在别处、断言假失败
    （「拖了但 moved=0」就是这么来的）。真按鼠标前先问一句 elementFromPoint。"""
    box = locator.bounding_box()
    node_id = locator.get_attribute("data-id")
    if box is None or node_id is None:
        return False
    return page.evaluate(
        """([x, y, id]) => {
      const el = document.elementFromPoint(x, y);
      const node = el && el.closest ? el.closest(".react-flow__node") : null;
      return !!node && node.getAttribute("data-id") === id;
    }""",
        [box["x"] + offset[0], box["y"] + offset[1], node_id],
    )


def center_node(page, locator, tries=6, probe_offset=None):
    """拖空白处平移视口，把目标节点挪到画布正中（只平移，不改缩放）。

    用途：节点在视口里的位置是**视口状态**，不该由测试的隐含前提决定。节点贴着画布
    上沿、或落在视口外时，按 `bounding_box()` 算出的抓取点会打不到它，拖拽断言就假
    失败。传 probe_offset（节点盒内偏移，如抓取点）时，还要求该点真的点到这个节点
    本身，否则继续微调，直到命中或次数用尽。"""
    for _ in range(tries):
        box = locator.bounding_box()
        pane = page.locator(".react-flow").bounding_box()
        if box is None or pane is None:
            return False
        if probe_offset is not None and node_hit(page, locator, probe_offset(box)):
            return True
        dx = (pane["x"] + pane["width"] / 2) - (box["x"] + box["width"] / 2)
        dy = (pane["y"] + pane["height"] / 2) - (box["y"] + box["height"] / 2)
        if probe_offset is None and abs(dx) < 4 and abs(dy) < 4:
            return True
        blank = pane_blank_point(page)
        if blank is None:
            return False
        page.mouse.move(blank["x"], blank["y"])
        page.mouse.down()
        page.mouse.move(blank["x"] + dx, blank["y"] + dy, steps=10)
        page.mouse.up()
        page.wait_for_timeout(300)
    # 次数用尽：如实回报「抓取点到底点不点得到」，别把失败谎报成成功
    if probe_offset is None:
        return True
    box = locator.bounding_box()
    return box is not None and node_hit(page, locator, probe_offset(box))


def frame_node(page, locator, zoom=100, probe_offset=None):
    """把目标节点摆到画布正中，并把缩放落到 zoom 档（默认 100%）。

    视口是被测状态的一部分，不是测试可以默默依赖的前提：画布开着
    onlyRenderVisibleElements，节点不在视口里就**根本不进 DOM**；而任何真按鼠标的
    用例（拖节点、点节点内的按钮）还要求节点在屏幕上真的可按到。切分/放大这类
    「产物落地会带视野过去」的路径会顺手把视野挪走，所以碰具体节点之前先自己摆正。
    缩放围绕视口中心，因此先在 fitView 档把节点摆到中心，再落到 100%，它仍在中心。"""
    if locator.count() == 0:
        fit_all(page)
    center_node(page, locator)
    if zoom != ZOOM_ALL_VISIBLE:
        set_zoom(page, zoom)
        center_node(page, locator, probe_offset=probe_offset)
    return locator.count() > 0


results = []
# --only 过滤词：空 = 全量。由 main() 按命令行覆盖。
ONLY = ""


def check(name, ok, detail=""):
    if ONLY and ONLY.lower() not in name.lower():
        return
    print(
        ("PASS" if ok else "FAIL") + " | " + name + ((" | " + detail) if detail else "")
    )
    results.append((name, ok))


def click_hover_action(node_locator, name):
    """点节点悬停操作栏里的按钮。

    操作栏常驻布局但默认 `opacity-0 pointer-events-none` —— 一排隐形按钮不能挡住
    画布点击（见 ARCHITECTURE 5.4）。真实用户 hover 时 `group-hover` 会把它翻成
    `pointer-events-auto`；但 E2E 里画布节点在视口中心互相叠住，React Flow 还会把
    选中节点抬 z-index，真实 hover 会落到别的节点上，`group-hover` 不触发。
    所以直接向按钮派发 click（跳过命中测试），等价于「用户已经 hover 在上面了」。
    注意不能用 `click(force=True)`：force 只是跳过可操作性等待，鼠标事件照样走
    命中测试，会被 `pointer-events: none` 拦掉。
    """
    node_locator.get_by_role("button", name=name).dispatch_event("click")


def main():
    global BASE, ONLY
    parser = argparse.ArgumentParser(description="画布核心交互回归（E2E）")
    parser.add_argument(
        "--base",
        default=BASE,
        help=f"服务地址，默认 {DEFAULT_BASE}（也可用 IMAGORA_E2E_BASE 环境变量）",
    )
    parser.add_argument(
        "--only",
        default="",
        help="只判定名称包含该关键字的断言（默认不过滤 = 全量）",
    )
    args = parser.parse_args()
    BASE = args.base.rstrip("/")
    ONLY = args.only.strip()
    # CI Windows runner 默认 stdout 为 cp1252，无法编码中文（PASS/FAIL 断言名）→ 强制 UTF-8
    sys.stdout.reconfigure(encoding="utf-8")
    # 自包含测试图片：写临时文件，通过 file chooser 上传
    tmp_img = os.path.join(tempfile.gettempdir(), "imagora_e2e_pixel.png")
    with open(tmp_img, "wb") as f:
        f.write(base64.b64decode(PNG_B64))
    # 裁剪/放大段专用：240×160 的真实尺寸图（1×1 会让裁剪框与手柄缩成亚像素）
    tmp_big = os.path.join(tempfile.gettempdir(), "imagora_e2e_240x160.png")
    write_test_png(tmp_big, 240, 160)

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

        # 1b. 取消入口按需出现（issue #33）：没有任务在跑时，就绪卡片上没有「取消」、工具栏也没有「取消全部」。
        #     「排队/生成中出现 + 取消中禁用 + 终态清标记」由前端单测钉住——E2E 不触发生成链路
        #     （见 AGENTS.md 活跃坑：要覆盖「生成→回流」必须先 mock core/api.py 的 generate_image）。
        idle_prompt = page.locator(".react-flow__node-prompt").first
        check(
            "就绪卡片没有「取消」按钮",
            idle_prompt.get_by_role("button", name="取消", exact=True).count() == 0,
        )
        check(
            "没有任务在跑时工具栏不出现「取消全部」",
            page.locator(".studio-toolbar").get_by_text("取消全部", exact=False).count()
            == 0,
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

        # 12. 缩放读数：只显示、与视口双向一致（滑杆已移除，改由按钮/滚轮驱动视口）
        readout = page.locator(".dock-row__value")
        check("缩放读数存在（不可拖的纯显示）", readout.count() == 1)
        zoom_before = (vp_snap(page) or {}).get("zoom") or 1
        dock_click(page, "放大画布")
        snap = vp_snap(page)
        zoom_now = snap["zoom"] if snap else -1
        check(
            "点「放大」视口跟着放大",
            snap is not None and zoom_now > zoom_before + 0.01,
            f"zoom {zoom_before:.3f}->{zoom_now:.3f}",
        )
        check(
            "读数与视口缩放一致",
            abs(float(readout.inner_text().rstrip("%")) - zoom_now * 100) <= 1.5,
            f"readout={readout.inner_text()} zoom={zoom_now:.4f}",
        )
        # 视口反向驱动读数：滚轮缩放后读数应跟着变（不是单向下发）
        page.mouse.move(
            rf_box["x"] + rf_box["width"] / 2, rf_box["y"] + rf_box["height"] / 2
        )
        page.mouse.wheel(0, -240)
        page.wait_for_timeout(400)
        zoom_after_wheel = (vp_snap(page) or {}).get("zoom")
        check(
            "滚轮缩放后读数跟着更新",
            zoom_after_wheel is not None
            and abs(float(readout.inner_text().rstrip("%")) - zoom_after_wheel * 100)
            <= 1.5,
            f"readout={readout.inner_text()} zoom={zoom_after_wheel}",
        )
        set_zoom(page, 100)
        page.wait_for_timeout(200)

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

        # 14. 图片裁剪：入口 → 对话框 → 选 1:1 → 确认产出新节点（原图保留）
        #     用 240×160 而不是 1×1：1px 图上 stage 只有 1px，裁剪框与八个手柄都缩成亚像素
        before_upload = len(image_positions())
        with page.expect_file_chooser() as fc_big:
            page.get_by_role("button", name="上传图片").click()
        fc_big.value.set_files(tmp_big)
        page.wait_for_timeout(1500)
        before_crop = len(image_positions())
        check(
            "上传 240×160 测试图",
            before_crop == before_upload + 1,
            f"{before_upload}->{before_crop}",
        )

        src_node = (
            page.locator(".react-flow__node-image")
            .filter(has=page.locator('img[alt="imagora_e2e_240x160.png"]'))
            .last
        )
        # 不用 hover：画布上多个节点会在视口中心叠住，React Flow 还会把选中节点抬 z-index，
        # 真实 hover 会落到别的节点上。操作栏常驻布局但默认 pointer-events-none（隐形按钮
        # 不能挡住画布），故用 dispatch_event 直接派发，见 click_hover_action 的说明。
        crop_btn = src_node.get_by_role("button", name="裁剪图片")
        check("裁剪入口按钮存在", crop_btn.count() == 1)
        click_hover_action(src_node, "裁剪图片")
        page.wait_for_timeout(700)
        crop_dialog = page.locator('[data-testid="image-crop-dialog"]')
        check("裁剪对话框打开", crop_dialog.count() == 1)
        check("裁剪框已渲染", page.locator('[data-testid="crop-box"]').count() == 1)
        handle_count = page.evaluate(
            "() => document.querySelectorAll('[data-testid=\"image-crop-dialog\"] [data-handle]').length"
        )
        check("裁剪框八个手柄齐全", handle_count == 8, f"handles={handle_count}")

        def parse_px(text):
            body = text.replace("px", "").strip()
            left, _, right = body.partition("×")
            return int(left.strip()), int(right.strip())

        crop_dialog.get_by_role("button", name="1:1", exact=True).click()
        page.wait_for_timeout(300)
        size_text = page.locator('[data-testid="crop-size"]').inner_text()
        crop_w, crop_h = parse_px(size_text)
        check(
            "选 1:1 后裁剪框变成正方形",
            crop_w > 0 and abs(crop_w - crop_h) <= 1,
            f"size={size_text}",
        )

        crop_dialog.get_by_role("button", name="确认裁剪").click()
        page.wait_for_timeout(2500)
        after_crop = len(image_positions())
        check(
            "确认裁剪后派生新节点",
            after_crop == before_crop + 1,
            f"{before_crop}->{after_crop}",
        )
        check(
            "裁剪后对话框关闭",
            page.locator('[data-testid="image-crop-dialog"]').count() == 0,
        )

        # 15. 图片放大：入口 → 对话框 → 目标长边 1024 → 确认产出新节点
        #     对裁剪产物（alt 以 crop- 开头）再放大，顺带验证派生图能被继续加工
        crop_node = (
            page.locator(".react-flow__node-image")
            .filter(has=page.locator('img[alt^="crop-"]'))
            .last
        )
        check("裁剪产物已出现在画布上", crop_node.count() == 1)
        click_hover_action(crop_node, "放大图片")
        page.wait_for_timeout(700)
        up_dialog = page.locator('[data-testid="image-upscale-dialog"]')
        check("放大对话框打开", up_dialog.count() == 1)
        check("原图预览已渲染", up_dialog.locator('img[alt="原图预览"]').count() == 1)
        up_dialog.get_by_role("button", name="1024", exact=True).click()
        page.wait_for_timeout(400)
        up_text = up_dialog.inner_text()
        check("放大换算文案给出目标尺寸", "1024" in up_text, f"text={up_text[:80]}")
        before_up = len(image_positions())
        page.locator('[data-testid="image-upscale-confirm"]').click()
        page.wait_for_timeout(3000)
        after_up = len(image_positions())
        check(
            "确认放大后派生新节点",
            after_up == before_up + 1,
            f"{before_up}->{after_up}",
        )
        check(
            "放大后对话框关闭",
            page.locator('[data-testid="image-upscale-dialog"]').count() == 0,
        )

        # 16. 图片切分：入口 → 对话框 → 3×2 预设 → 确认一次产出 6 张派生节点
        #     切的是第 14 段上传的原图（240×160），不切裁剪/放大产物，
        #     因为那些产物的字节内容由 canvas 决定，尺寸断言不好写死。
        split_src = (
            page.locator(".react-flow__node-image")
            .filter(has=page.locator('img[alt="imagora_e2e_240x160.png"]'))
            .last
        )
        split_btn = split_src.get_by_role("button", name="切分图片")
        check("切分入口按钮存在", split_btn.count() == 1)
        click_hover_action(split_src, "切分图片")
        page.wait_for_timeout(700)
        split_dialog = page.locator('[data-testid="image-split-dialog"]')
        check("切分对话框打开", split_dialog.count() == 1)
        check(
            "切分预览网格已渲染",
            split_dialog.locator('[data-testid="split-preview"]').count() == 1,
        )
        # 默认 2×2（4 块）已可切；换成 3×2 验证预设按钮真的改了行列
        split_dialog.locator('[data-testid="split-preset-3x2"]').click()
        page.wait_for_timeout(300)
        split_count_text = split_dialog.locator(
            '[data-testid="split-count"]'
        ).inner_text()
        check(
            "3×2 预设把块数改为 6",
            "6" in split_count_text,
            f"count={split_count_text}",
        )
        check(
            "预览网格画出 6 个格子",
            split_dialog.locator('[data-testid="split-cell"]').count() == 6,
        )
        # 文件名预览只列前 NAME_PREVIEW_LIMIT（3）条，其余折叠成「…等 N 个」——
        # 6 个文件名全铺出来会把弹窗撑长，而用户只需要确认命名规律对不对。
        name_li_count = split_dialog.locator('[data-testid="split-names"] li').count()
        check(
            "文件名预览列出前 3 条",
            name_li_count == 3,
            f"li={name_li_count}",
        )
        check(
            "文件名预览折叠其余并标出总数",
            "等 6 个"
            in split_dialog.locator('[data-testid="split-names"]').inner_text(),
        )
        before_split = len(image_positions())
        split_dialog.locator('[data-testid="image-split-confirm"]').click()
        page.wait_for_timeout(5000)
        # 不能用「节点数 +6」当判据：画布开了 onlyRenderVisibleElements，切分产物排在
        # 原图右侧，多数落在视口外、根本不进 DOM。产物张数以画布日志为准（一次上传一次
        # 落库，日志里明确写了张数），节点数只断言「确实新增了」。
        split_logs = " | ".join(page.locator(".log-toast").all_inner_texts())
        check(
            "切分日志报出 6 张",
            "→ 6 张" in split_logs,
            f"logs={split_logs[-120:]}",
        )
        # 数之前先把缩放拉到「整块画布都在屏上」那一档：
        # 切分产物落地后系统会把视野带过去（revealViewport），视口一变、可见集就变，
        # 拿「平移后的可见节点数」跟「平移前的可见节点数」比，会把平移误读成没新增。
        # 前后两次都在同一档缩放下数，断言才真的在说「产物进了画布」。
        set_zoom(page, ZOOM_ALL_VISIBLE)
        after_split = len(image_positions())
        set_zoom(page, 100)
        check(
            "确认切分后画布新增节点",
            after_split > before_split,
            f"{before_split}->{after_split}",
        )
        check(
            "切分后对话框关闭",
            page.locator('[data-testid="image-split-dialog"]').count() == 0,
        )

        # 17. 拖拽吸附：开着吸附拖动节点，对齐时出现 .snap-guide；关掉开关后不再出现
        #     对齐线只在拖拽的那几帧存在，所以用 mouse.down → move → 读 → up 的时序抓。
        snap_toggle = page.get_by_role("button", name="关闭拖拽吸附")
        check("吸附默认开启", snap_toggle.count() == 1)
        check(
            "吸附偏好默认未写 localStorage（默认即开）",
            page.evaluate("() => window.localStorage.getItem('imagora.canvas-snap.v1')")
            in (None, "1"),
        )
        # 先把两个节点摆成同一列：拖第一个到第二个的正下方附近，应吸住竖直对齐线。
        drag_target = page.locator(".react-flow__node-prompt").first

        # 拖拽要真的按到节点本体，而切分那一步把视野带到了产物那边 —— 先自己摆正，
        # 并要求抓取点（节点上沿往下 14px）确实点得到这个节点。
        def grab_probe(b):
            return (b["width"] / 2, 14)

        if not frame_node(page, drag_target, probe_offset=grab_probe):
            check("找到可拖拽的提示词节点", False)
        tbox = drag_target.bounding_box()
        if tbox is None:
            check("找到可拖拽的提示词节点", False)
        else:
            grab_x = tbox["x"] + tbox["width"] / 2
            grab_y = tbox["y"] + 14
            page.mouse.move(grab_x, grab_y)
            page.mouse.down()
            page.mouse.move(grab_x + 40, grab_y + 60, steps=8)
            page.wait_for_timeout(200)
            guides_during = page.locator(".snap-guide").count()
            page.mouse.move(grab_x + 42, grab_y + 62, steps=4)
            page.wait_for_timeout(200)
            guides_moved = page.locator(".snap-guide").count()
            page.mouse.up()
            page.wait_for_timeout(400)
            check(
                "拖拽过程中出现过对齐线",
                guides_during > 0 or guides_moved > 0,
                f"during={guides_during} moved={guides_moved}",
            )
            check("松手后对齐线清空", page.locator(".snap-guide").count() == 0)
        # 关掉吸附后再拖，不应再出现对齐线
        page.get_by_role("button", name="关闭拖拽吸附").click()
        page.wait_for_timeout(200)
        check(
            "关闭吸附后开关态翻转",
            page.get_by_role("button", name="开启拖拽吸附").count() == 1,
        )
        check(
            "吸附偏好写入 localStorage",
            page.evaluate("() => window.localStorage.getItem('imagora.canvas-snap.v1')")
            == "0",
        )
        # 第二次拖拽同样先摆正：上一次拖动把节点挪了几十像素，抓取点可能已经贴边。
        frame_node(
            page,
            page.locator(".react-flow__node-prompt").first,
            probe_offset=grab_probe,
        )
        tbox2 = page.locator(".react-flow__node-prompt").first.bounding_box()
        if tbox2 is not None:
            gx = tbox2["x"] + tbox2["width"] / 2
            gy = tbox2["y"] + 14
            page.mouse.move(gx, gy)
            page.mouse.down()
            page.mouse.move(gx + 40, gy + 60, steps=8)
            page.wait_for_timeout(200)
            check(
                "关闭吸附后拖拽不再出现对齐线", page.locator(".snap-guide").count() == 0
            )
            page.mouse.up()
            page.wait_for_timeout(300)
        # 恢复默认，避免影响后续（与其它段的偏好写入保持一致的做法）
        page.get_by_role("button", name="开启拖拽吸附").click()
        page.wait_for_timeout(200)

        # 18. 聚焦所选节点：选中一个节点 → 点「聚焦所选节点」→ 视口缩放变化且不放大到失真
        #     不能用 locator.click()：画布节点在视口中心互相叠住，Playwright 的可操作性
        #     检查会因为「另一个节点的 textarea 拦截了指针事件」而超时。改用裸 mouse.click
        #     打坐标 —— 谁在最上层就选中谁，对「聚焦选中内容」这个断言完全等价。
        img_box = page.locator(".react-flow__node-image").first.bounding_box()
        if img_box is None:
            check("找到可点击的图片节点", False)
        else:
            page.mouse.click(
                img_box["x"] + img_box["width"] / 2,
                img_box["y"] + img_box["height"] / 2,
            )
            page.wait_for_timeout(400)
            selected_count = page.evaluate(
                "() => document.querySelectorAll('.react-flow__node.selected').length"
            )
            check(
                "点击后确有节点被选中",
                selected_count >= 1,
                f"selected={selected_count}",
            )
            # 先把画布缩小到 30%：聚焦的缩放上限是 1（不放大小图到失真），
            # 当前视口若本来就是 100%，聚焦后 zoom 不变 —— 那是正确行为，不是缺陷。
            # 缩小后再聚焦，才能看出「它确实按节点尺寸重算了视口」。
            zoom_to(page, 0.3)
            page.wait_for_timeout(300)
            zoom_before_focus = vp_snap(page)["zoom"]
            check(
                "先缩小到 30% 作为聚焦前状态",
                zoom_before_focus < 0.45,
                f"zoom={zoom_before_focus:.3f}",
            )
            page.get_by_role("button", name="聚焦所选节点").click()
            page.wait_for_timeout(900)
            zoom_after_focus = vp_snap(page)["zoom"]
            check(
                "聚焦后视口缩放变大",
                zoom_after_focus > zoom_before_focus + 0.001,
                f"{zoom_before_focus:.3f}->{zoom_after_focus:.3f}",
            )
            check(
                "聚焦后缩放不超过 1（不放大到失真）",
                zoom_after_focus <= 1.001,
                f"zoom={zoom_after_focus:.3f}",
            )

        # 19. 蒙版局部重绘：入口 → 涂一笔 → 确认 → 图片节点出现「蒙版」角标 → 点击清除
        #     用 240×160 那张图：蒙版对话框的 stage 按图片实际尺寸等比，
        #     1×1 的图上画布只有 1px，笔迹落点全是同一个像素，断言失去意义。
        mask_src = (
            page.locator(".react-flow__node-image")
            .filter(has=page.locator('img[alt="imagora_e2e_240x160.png"]'))
            .last
        )
        check(
            "蒙版入口按钮存在",
            mask_src.get_by_role("button", name="蒙版重绘").count() == 1,
        )
        click_hover_action(mask_src, "蒙版重绘")
        page.wait_for_timeout(900)
        check(
            "蒙版对话框打开",
            page.locator('[data-testid="mask-brush-dialog"]').count() == 1,
        )
        mask_canvas = page.locator('[data-testid="mask-canvas"]')
        check("蒙版画布已渲染", mask_canvas.count() == 1)
        # 空蒙版时确认按钮必须禁用：空蒙版 = 「整图都要重绘」，发上去既慢又白花钱
        check(
            "空蒙版时确认按钮禁用",
            page.locator('[data-testid="mask-confirm"]').is_disabled(),
        )
        cbox = mask_canvas.bounding_box()
        if cbox is None:
            check("蒙版画布有可绘制区域", False)
        else:
            # 真实指针拖一笔：pointerdown → 多次 pointermove（内部按 radiusPx/4 插值补点）→ pointerup
            mx = cbox["x"] + cbox["width"] * 0.35
            my = cbox["y"] + cbox["height"] * 0.5
            page.mouse.move(mx, my)
            page.mouse.down()
            page.mouse.move(
                mx + cbox["width"] * 0.3, my + cbox["height"] * 0.1, steps=6
            )
            page.mouse.up()
            page.wait_for_timeout(400)
            check(
                "涂一笔后确认按钮可用",
                page.locator('[data-testid="mask-confirm"]').is_enabled(),
            )
            page.locator('[data-testid="mask-confirm"]').click()
            page.wait_for_timeout(1500)
        check(
            "确认后蒙版对话框关闭",
            page.locator('[data-testid="mask-brush-dialog"]').count() == 0,
        )
        mask_badge = page.locator('[aria-label="清除蒙版"]')
        check(
            "图片节点出现蒙版角标",
            mask_badge.count() == 1,
            f"badge={mask_badge.count()}",
        )
        if mask_badge.count() == 1:
            mask_badge.first.dispatch_event("click")
            page.wait_for_timeout(500)
            check(
                "点角标可清除蒙版",
                page.locator('[aria-label="清除蒙版"]').count() == 0,
            )

        # 20. 提示词 @ 引用：引用一张不存在的图 → 运行前就被拦下（不发请求、不花钱）
        #     这条守卫的意义正是「宁可报错也不偷偷退回全收集」：退回全收集等于拿别的图
        #     去改，用户看不出来，只有账单能看出来。
        prompt_node = page.locator(".react-flow__node-prompt").first
        # 先把这个节点摆到画布正中：它得在 DOM 里（fill 要求可见），点击也别被别的节点压住。
        prompt_box = (
            prompt_node.bounding_box() if frame_node(page, prompt_node) else None
        )
        if prompt_box is None:
            check("找到提示词节点", False)
        else:
            page.locator(".react-flow__node-prompt textarea").first.fill(
                "@nonexistent.png a red apple"
            )
            page.wait_for_timeout(300)
            # 派发 DOM click 而不是 locator.click()：画布节点在 100% 缩放下会互相压住，
            # 上面的图片节点会把指针事件截走（同第 18 节的说明）。这条用例验的是
            # @ 引用的前端校验，不是按钮的指针可达性，可达性由第 18/21 节覆盖。
            prompt_node.get_by_role("button", name="运行").dispatch_event("click")
            page.wait_for_timeout(900)
            run_logs = " | ".join(page.locator(".log-toast").all_inner_texts())
            check(
                "@ 引用不存在时运行被拦下",
                "引用的图片不存在" in run_logs,
                f"logs={run_logs[-160:]}",
            )

        # 21. 节点右键菜单：右键单击图片节点 → 菜单出现 → 点「预览大图」打开预览
        #     右键与框选共用右键按键，靠「松开时移动距离 < 2px」区分（Windows 上
        #     contextmenu 在松开后才触发，靠它分派来不及）。
        page.mouse.click(
            box["x"] + box["width"] * 0.15, box["y"] + box["height"] * 0.15
        )
        page.wait_for_timeout(300)
        menu_src = page.locator(".react-flow__node-image").first
        mbox = menu_src.bounding_box()
        if mbox is None:
            check("找到可右键的图片节点", False)
        else:
            page.mouse.click(
                mbox["x"] + mbox["width"] / 2,
                mbox["y"] + mbox["height"] / 2,
                button="right",
            )
            page.wait_for_timeout(600)
            menu = page.locator('[data-testid="node-context-menu"]')
            check("右键单击节点弹出菜单", menu.count() == 1)
            check(
                "菜单含图片操作项",
                page.locator('[data-testid="node-menu-crop"]').count() == 1,
            )
            if menu.count() == 1:
                page.locator('[data-testid="node-menu-preview"]').click()
                page.wait_for_timeout(800)
                check(
                    "菜单「预览大图」打开预览",
                    page.locator("img[data-zoom-image]").count() == 1,
                )
                check(
                    "点菜单项后菜单关闭",
                    page.locator('[data-testid="node-context-menu"]').count() == 0,
                )
                if page.locator("img[data-zoom-image]").count() == 1:
                    vp = page.viewport_size
                    page.mouse.click(
                        round(vp["width"] * 0.02), round(vp["height"] * 0.08)
                    )
                    page.wait_for_timeout(400)

        # 22. 连线三态：默认 1.5px → hover 加粗 → 单击选中 → Delete 删除
        #     线宽/透明度由 edgeStyle.ts 以**内联样式**写到 <path> 上，
        #     所以判据读 computedStyle 而不是查 CSS 类名。
        # 作用域锁死工具栏：有选中节点时检查器里还有一颗「自动连线」（只补选区），
        # 它现在单选时不带计数（(1) 是噪音），两颗按钮的可访问名完全一样，
        # 全局 get_by_role 会命中 2 个、Playwright strict 模式当场报错。
        page.locator(".studio-toolbar").get_by_role("button", name="自动连线").click()
        page.wait_for_timeout(700)
        edge_total = page.locator(".react-flow__edge").count()
        check("自动连线后画布出现连线", edge_total >= 1, f"edges={edge_total}")
        if edge_total >= 1:

            def edge_probe():
                """第一条连线的**可命中点**屏幕坐标 + 当前线宽/透明度。

                曲线用 getPointAtLength 取（两个端点的中点不在曲线上）；但不能拿中点
                直接用：两节点挨着时曲线会从节点身下穿过，而节点层在连线层之上，鼠标
                移过去命中的是节点，hover / 单击都不会落到连线上（假失败）。所以沿曲线
                找一个 elementFromPoint 真的命中这条连线自己的采样点。"""
                return page.evaluate("""() => {
                  const edge = document.querySelector(".react-flow__edge");
                  if (!edge) return null;
                  const path = edge.querySelector(".react-flow__edge-path");
                  if (!path) return null;
                  const len = path.getTotalLength();
                  const ctm = path.getScreenCTM();
                  let at = null;
                  for (let d = 0; d <= 0.5 && !at; d += 0.05) {
                    const fracs = d === 0 ? [0.5] : [0.5 - d, 0.5 + d];
                    for (const f of fracs) {
                      const p = path.getPointAtLength(len * f).matrixTransform(ctm);
                      const el = document.elementFromPoint(p.x, p.y);
                      if (el && el.closest && el.closest(".react-flow__edge") === edge) {
                        at = { x: p.x, y: p.y };
                        break;
                      }
                    }
                  }
                  const cs = getComputedStyle(path);
                  return {
                    x: at ? at.x : null, y: at ? at.y : null,
                    strokeWidth: parseFloat(cs.strokeWidth),
                    opacity: parseFloat(cs.opacity),
                  };
                }""")

            idle = edge_probe()
            check(
                "连线默认态线宽 1.5px",
                idle is not None and abs(idle["strokeWidth"] - 1.5) < 0.01,
                f"idle={idle}",
            )
            if idle is not None and idle["x"] is not None:
                page.mouse.move(idle["x"], idle["y"])
                page.wait_for_timeout(500)
                hovered = edge_probe()
                check(
                    "hover 连线后线宽变粗",
                    hovered is not None
                    and hovered["strokeWidth"] > idle["strokeWidth"] + 0.1,
                    f"at={idle['x']:.0f},{idle['y']:.0f} "
                    f"{idle['strokeWidth']}->{hovered['strokeWidth'] if hovered else None}",
                )
                # 移开再单击：验证的是「点击选中」而不是「鼠标还停在上面」
                page.mouse.move(12, 12)
                page.wait_for_timeout(400)
                page.mouse.click(idle["x"], idle["y"])
                page.wait_for_timeout(600)
                picked = edge_probe()
                check(
                    "单击连线后保持加粗（选中态）",
                    picked is not None
                    and picked["strokeWidth"] > idle["strokeWidth"] + 0.1,
                    f"picked={picked}",
                )
                page.keyboard.press("Delete")
                page.wait_for_timeout(700)
                after_delete = page.locator(".react-flow__edge").count()
                check(
                    "Delete 删除选中的连线",
                    after_delete == edge_total - 1,
                    f"{edge_total}->{after_delete}",
                )

        # 23. 尺寸下拉自由输入：清单外的尺寸也能用（上游常认 1280x720 这类非标尺寸）
        size_trigger = page.locator(".react-flow__node-prompt .select-trigger").first
        check("提示词卡片有尺寸下拉", size_trigger.count() == 1)
        if size_trigger.count() == 1:
            # 用 dispatch_event 而不是 click：连线的命中层是一条 20px 宽的透明
            # `.react-flow__edge-interaction` 路径，而连线按设计恒在节点之上
            # （ARCHITECTURE 5.4 连线分层），交叉处的节点控件点不到。这是既有取舍，
            # 不是本次改动引入的；同一处理方式见 click_hover_action 的说明。
            size_trigger.dispatch_event("click")
            page.wait_for_timeout(400)
            size_search = page.locator(".select-list input").first
            check("尺寸下拉展开后有搜索框", size_search.count() == 1)
            if size_search.count() == 1:
                size_search.fill("1280x720")
                page.wait_for_timeout(400)
                custom_row = page.locator('[data-testid="select-custom-option"]')
                check("清单外尺寸给出「使用」行", custom_row.count() == 1)
                if custom_row.count() == 1:
                    custom_row.dispatch_event("click")
                    page.wait_for_timeout(600)
                    trigger_text = size_trigger.inner_text()
                    check(
                        "选中后触发器显示自定义尺寸",
                        "1280x720" in trigger_text,
                        f"text={trigger_text}",
                    )

        browser.close()

    if ONLY and not results:
        print(f"\n--only {ONLY!r} 没有匹配任何断言（TOTAL 0），按失败处理")
        return 1

    failed = [n for n, ok in results if not ok]
    print()
    print(
        f"TOTAL: {len(results)}  PASS: {len(results) - len(failed)}  FAIL: {len(failed)}"
    )
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

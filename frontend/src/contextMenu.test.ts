import { describe, expect, it } from "vitest";

import {
  MENU_ITEM_HEIGHT,
  MENU_MARGIN,
  MENU_WIDTH,
  buildNodeMenu,
  clampMenuPosition,
  isMenuDismissKey,
  menuHeight,
  type ContextMenuItem,
} from "./contextMenu";

/** 取出菜单里所有 action 的 id（分隔线跳过），方便逐字比对顺序 */
function ids(items: ContextMenuItem[]): string[] {
  return items.flatMap((item) => (item.kind === "action" ? [item.action.id] : []));
}

/** 取出菜单里所有 action 的文案 */
function labels(items: ContextMenuItem[]): string[] {
  return items.flatMap((item) => (item.kind === "action" ? [item.action.label] : []));
}

/** 按 id 找 action；找不到直接抛，避免断言在 undefined 上静默通过 */
function actionOf(items: ContextMenuItem[], id: string) {
  for (const item of items) {
    if (item.kind === "action" && item.action.id === id) return item.action;
  }
  throw new Error(`菜单里没有 id=${id} 的项，实际有：${ids(items).join(", ")}`);
}

const single = { hasUrl: true, selectedCount: 1 };

describe("buildNodeMenu", () => {
  it("图片节点（有图）给出完整的七项 + 分隔线 + 删除，顺序固定", () => {
    const items = buildNodeMenu("image", single);
    expect(ids(items)).toEqual([
      "preview",
      "crop",
      "upscale",
      "split",
      "mask",
      "replace",
      "delete",
    ]);
    expect(labels(items)).toEqual([
      "预览大图",
      "裁剪",
      "放大",
      "切分",
      "蒙版重绘",
      "替换图片",
      "删除",
    ]);
    // 七个动作之后是一条分隔线，然后才是删除
    expect(items[6]).toEqual({ kind: "separator" });
    expect(items.length).toBe(8);
  });

  it("图片节点（有图）没有任何禁用项", () => {
    const items = buildNodeMenu("image", single);
    for (const item of items) {
      if (item.kind !== "action") continue;
      expect(item.action.disabled, `${item.action.id} 不该禁用`).not.toBe(true);
    }
  });

  it("图片节点没有图时保留操作项，除「替换图片」外全部禁用（让人看见「这里能做什么」）", () => {
    const items = buildNodeMenu("image", { hasUrl: false, selectedCount: 1 });
    // 关键：不是「消失」，而是「留着且置灰」
    expect(ids(items)).toEqual([
      "preview",
      "crop",
      "upscale",
      "split",
      "mask",
      "replace",
      "delete",
    ]);
    for (const id of ["preview", "crop", "upscale", "split", "mask"]) {
      expect(actionOf(items, id).disabled, `${id} 应禁用`).toBe(true);
    }
    // 替换是 missing 态的恢复入口，不能跟着一起灰
    expect(actionOf(items, "replace").disabled).not.toBe(true);
  });

  it("没有图时「替换图片」仍可用（B6：文件缺失时这是唯一恢复入口）", () => {
    const replace = actionOf(buildNodeMenu("image", { hasUrl: false, selectedCount: 1 }), "replace");
    expect(replace.label).toBe("替换图片");
    expect(replace.disabled).not.toBe(true);
  });

  it("「蒙版重绘」排在「替换图片」之前，有图时可用", () => {
    const items = buildNodeMenu("image", single);
    const maskIndex = ids(items).indexOf("mask");
    const replaceIndex = ids(items).indexOf("replace");
    expect(maskIndex).toBeGreaterThan(0);
    expect(maskIndex).toBe(replaceIndex - 1);
    expect(actionOf(items, "mask").label).toBe("蒙版重绘");
    expect(actionOf(items, "mask").disabled).not.toBe(true);
  });

  it("图片节点没有图时「删除」仍可用（否则这个节点就没法清理了）", () => {
    const items = buildNodeMenu("image", { hasUrl: false, selectedCount: 1 });
    const del = actionOf(items, "delete");
    expect(del.disabled).not.toBe(true);
    expect(del.danger).toBe(true);
  });

  it("提示词节点：运行 / 复制提示词 / 分隔线 / 删除", () => {
    const items = buildNodeMenu("prompt", single);
    expect(ids(items)).toEqual(["run", "copy-prompt", "delete"]);
    expect(labels(items)).toEqual(["运行", "复制提示词", "删除"]);
    expect(items[2]).toEqual({ kind: "separator" });
    expect(items.length).toBe(4);
  });

  it("提示词节点不受 hasUrl 影响（它没有图）", () => {
    expect(buildNodeMenu("prompt", { hasUrl: false, selectedCount: 1 })).toEqual(
      buildNodeMenu("prompt", { hasUrl: true, selectedCount: 1 }),
    );
  });

  it("分组节点只有删除", () => {
    const items = buildNodeMenu("group", single);
    expect(items.length).toBe(1);
    expect(actionOf(items, "delete").label).toBe("删除");
    expect(actionOf(items, "delete").danger).toBe(true);
  });

  it("未知节点类型也只给删除（不抛错、不返回空菜单）", () => {
    for (const type of ["", "unknown", "note", "IMAGE"]) {
      const items = buildNodeMenu(type, single);
      expect(ids(items), `${type} 的菜单`).toEqual(["delete"]);
    }
  });

  it("多选时最前面插入「删除所选 N 项」并跟一条分隔线", () => {
    const items = buildNodeMenu("image", { hasUrl: true, selectedCount: 3 });
    expect(ids(items)).toEqual([
      "delete-selection",
      "preview",
      "crop",
      "upscale",
      "split",
      "mask",
      "replace",
      "delete",
    ]);
    expect(labels(items)[0]).toBe("删除所选 3 项");
    expect(items[0]).toEqual({
      kind: "action",
      action: { id: "delete-selection", label: "删除所选 3 项", danger: true },
    });
    expect(items[1]).toEqual({ kind: "separator" });
  });

  it("多选时底部单节点删除改叫「仅删除此项」，单选仍是「删除」", () => {
    const multi = buildNodeMenu("image", { hasUrl: true, selectedCount: 2 });
    expect(actionOf(multi, "delete").label).toBe("仅删除此项");
    expect(actionOf(multi, "delete").danger).toBe(true);
    const one = buildNodeMenu("image", { hasUrl: true, selectedCount: 1 });
    expect(actionOf(one, "delete").label).toBe("删除");
    // 提示词 / 分组节点同样适用：范围不同的两个删除不能同名
    expect(actionOf(buildNodeMenu("prompt", { hasUrl: true, selectedCount: 3 }), "delete").label).toBe(
      "仅删除此项",
    );
    expect(actionOf(buildNodeMenu("group", { hasUrl: true, selectedCount: 3 }), "delete").label).toBe(
      "仅删除此项",
    );
  });

  it("只选中 1 个（或 0 个）时不出现「删除所选」", () => {
    expect(ids(buildNodeMenu("image", { hasUrl: true, selectedCount: 1 }))).not.toContain(
      "delete-selection",
    );
    expect(ids(buildNodeMenu("image", { hasUrl: true, selectedCount: 0 }))).not.toContain(
      "delete-selection",
    );
  });

  it("批量删除也作用在提示词 / 分组节点上（它们同样可多选）", () => {
    const prompt = buildNodeMenu("prompt", { hasUrl: true, selectedCount: 2 });
    expect(labels(prompt)[0]).toBe("删除所选 2 项");
    const group = buildNodeMenu("group", { hasUrl: true, selectedCount: 5 });
    expect(ids(group)).toEqual(["delete-selection", "delete"]);
    // 分组节点的多选菜单：批量项 + 分隔线 + 单项删除
    expect(group.length).toBe(3);
  });
});

describe("clampMenuPosition", () => {
  const viewport = { width: 1000, height: 800 };
  const size = { width: MENU_WIDTH, height: 200 };

  it("空间够时原样返回（不做无意义的位移）", () => {
    expect(clampMenuPosition({ x: 300, y: 200 }, size, viewport)).toEqual({ x: 300, y: 200 });
  });

  it("超出右边缘时往左推，并留出 margin", () => {
    const point = clampMenuPosition({ x: 990, y: 200 }, size, viewport);
    expect(point.x).toBe(viewport.width - MENU_WIDTH - MENU_MARGIN);
    expect(point.x).toBe(792);
  });

  it("超出下边缘时往上推（贴底右键时菜单整体上翻，而不是被裁掉）", () => {
    const point = clampMenuPosition({ x: 100, y: 780 }, size, viewport);
    expect(point.y).toBe(viewport.height - size.height - MENU_MARGIN);
    expect(point.y).toBe(592);
  });

  it("负坐标被夹到 0（左 / 上边缘同样要夹，只夹右下会露出半个菜单）", () => {
    expect(clampMenuPosition({ x: -40, y: -40 }, size, viewport)).toEqual({ x: 0, y: 0 });
  });

  it("四角同时越界时两个轴各自夹紧", () => {
    expect(clampMenuPosition({ x: 5000, y: 5000 }, size, viewport)).toEqual({
      x: 792,
      y: 592,
    });
  });

  it("margin 可覆盖（默认 8，传 0 时贴边）", () => {
    expect(clampMenuPosition({ x: 990, y: 780 }, size, viewport, 0)).toEqual({ x: 800, y: 600 });
    expect(clampMenuPosition({ x: 990, y: 780 }, size, viewport, 24)).toEqual({
      x: viewport.width - MENU_WIDTH - 24,
      y: viewport.height - size.height - 24,
    });
  });

  it("菜单比视口还大时退化为 0（贴左上角，至少让第一项可见）", () => {
    const huge = { width: 1200, height: 900 };
    expect(clampMenuPosition({ x: 500, y: 500 }, huge, viewport)).toEqual({ x: 0, y: 0 });
  });

  it("刚好卡在边界上时不抖动（等于上限就保持）", () => {
    const exact = { x: viewport.width - MENU_WIDTH - MENU_MARGIN, y: 10 };
    expect(clampMenuPosition(exact, size, viewport)).toEqual(exact);
  });
});

describe("menuHeight", () => {
  it("空菜单高度为 0", () => {
    expect(menuHeight([])).toBe(0);
  });

  it("每个 action 计一个 MENU_ITEM_HEIGHT", () => {
    expect(menuHeight(buildNodeMenu("group", single))).toBe(MENU_ITEM_HEIGHT);
    expect(menuHeight(buildNodeMenu("prompt", single))).toBe(MENU_ITEM_HEIGHT * 3 + 9);
    expect(menuHeight(buildNodeMenu("image", single))).toBe(MENU_ITEM_HEIGHT * 7 + 9);
  });

  it("分隔线算 1px 线 + 上下各 4px 间距 = 9", () => {
    const onlySeparator: ContextMenuItem[] = [{ kind: "separator" }];
    expect(menuHeight(onlySeparator)).toBe(9);
  });

  it("高度随项数线性增长（不是写死值 —— 它决定 y 要不要上翻）", () => {
    const few = buildNodeMenu("image", single);
    const many = buildNodeMenu("image", { hasUrl: true, selectedCount: 4 });
    expect(menuHeight(many)).toBeGreaterThan(menuHeight(few));
    expect(menuHeight(many) - menuHeight(few)).toBe(MENU_ITEM_HEIGHT + 9);
  });

  it("与 clampMenuPosition 联动：高菜单在同样的 y 上会被推得更高", () => {
    const viewport = { width: 1000, height: 400 };
    const short = buildNodeMenu("group", single);
    const tall = buildNodeMenu("image", { hasUrl: true, selectedCount: 4 });
    const anchor = { x: 100, y: 380 };
    const shortPoint = clampMenuPosition(
      anchor,
      { width: MENU_WIDTH, height: menuHeight(short) },
      viewport,
    );
    const tallPoint = clampMenuPosition(
      anchor,
      { width: MENU_WIDTH, height: menuHeight(tall) },
      viewport,
    );
    expect(shortPoint.y).toBeGreaterThan(tallPoint.y);
    // 两者都必须完整落在视口内
    expect(shortPoint.y + menuHeight(short)).toBeLessThanOrEqual(viewport.height);
    expect(tallPoint.y + menuHeight(tall)).toBeLessThanOrEqual(viewport.height);
  });
});

describe("isMenuDismissKey", () => {
  it("Escape 与 Tab 关闭菜单", () => {
    expect(isMenuDismissKey("Escape")).toBe(true);
    expect(isMenuDismissKey("Tab")).toBe(true);
  });

  it("其它键不关闭（方向键留给菜单内部导航）", () => {
    for (const key of ["Enter", " ", "ArrowDown", "ArrowUp", "a", "esc", ""]) {
      expect(isMenuDismissKey(key), key).toBe(false);
    }
  });
});

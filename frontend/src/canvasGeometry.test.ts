import { describe, expect, it } from "vitest";

import {
  FOCUS_MAX_VIEWPORT_RATIO,
  FOCUS_MAX_ZOOM,
  FOCUS_MIN_ZOOM,
  GROUP_WRAP_PADDING,
  GROUP_WRAP_TOP_PADDING,
  collectGroupMemberNodes,
  containsCenter,
  findGroupDropTarget,
  focusViewportForNode,
  getGroupWrapRect,
  nodeBounds,
  snapNodesIntoGroup,
  type FrameInsets,
  type NodeBox,
} from "./canvasGeometry";

// 纯几何数学，不碰 DOM / localStorage，因此不加 `@vitest-environment jsdom`。

/** 造一个带尺寸的节点；`width` / `height` 显式给，避免踩 eOPT 的「可选键 vs undefined」 */
function box(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  type?: string,
): NodeBox {
  return type === undefined
    ? { id, position: { x, y }, width, height }
    : { id, type, position: { x, y }, width, height };
}

const NO_FRAME: FrameInsets = { above: 0, below: 0, bottomInset: 0 };

describe("nodeBounds", () => {
  it("空数组返回全 0 退化盒，不把 ±Infinity 漏出去", () => {
    expect(nodeBounds([])).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
  });

  it("单节点返回它自己的左上角与右下角", () => {
    expect(nodeBounds([box("a", 10, 20, 30, 40)])).toEqual({
      left: 10,
      top: 20,
      right: 40,
      bottom: 60,
    });
  });

  it("多节点取并集，含负坐标", () => {
    const bounds = nodeBounds([box("a", -50, -30, 20, 20), box("b", 100, 200, 40, 60)]);
    expect(bounds).toEqual({ left: -50, top: -30, right: 140, bottom: 260 });
  });

  it("宽高缺省按 0 计（退化成一个点，不产生 NaN）", () => {
    const bounds = nodeBounds([{ id: "a", position: { x: 5, y: 7 } }]);
    expect(bounds).toEqual({ left: 5, top: 7, right: 5, bottom: 7 });
    expect(Number.isNaN(bounds.right)).toBe(false);
  });

  it("不修改入参数组", () => {
    const nodes = [box("a", 0, 0, 10, 10), box("b", 20, 20, 10, 10)];
    const snapshot = JSON.parse(JSON.stringify(nodes));
    nodeBounds(nodes);
    expect(nodes).toEqual(snapshot);
  });
});

describe("containsCenter", () => {
  const group = box("g", 0, 0, 100, 100, "group");

  it("中心点在 group 内判 true", () => {
    expect(containsCenter(group, box("a", 10, 10, 20, 20))).toBe(true);
  });

  it("中心点落在边界上也算（闭区间）", () => {
    expect(containsCenter(group, box("a", 90, 90, 20, 20))).toBe(true);
  });

  it("中心点在 group 外判 false", () => {
    expect(containsCenter(group, box("a", 120, 120, 20, 20))).toBe(false);
  });

  it("比 group 还大的节点：只要中心点在内就算命中（这就是不用整体包含的理由）", () => {
    // 节点盒 (-100,-100)-(200,200) 完全吞掉 group，整体包含必然为假，但中心点 (50,50) 在组内
    expect(containsCenter(group, box("big", -100, -100, 300, 300))).toBe(true);
  });

  it("节点大部分在组外、中心点仍在组内时算命中", () => {
    // 节点 (70,70)-(130,130) 一半伸出组外，中心点 (100,100) 恰在边界上
    expect(containsCenter(group, box("a", 70, 70, 60, 60))).toBe(true);
  });
});

describe("findGroupDropTarget", () => {
  const groupA = box("ga", 0, 0, 500, 500, "group");

  it("被拖节点中心落在组内时返回该组", () => {
    const nodes = [groupA, box("n1", 100, 100, 50, 50)];
    expect(findGroupDropTarget(new Set(["n1"]), nodes)?.id).toBe("ga");
  });

  it("被拖集合里含 group 时直接返回 null（禁止组嵌套组）", () => {
    const nodes = [groupA, box("ga2", 10, 10, 100, 100, "group")];
    expect(findGroupDropTarget(new Set(["ga2"]), nodes)).toBeNull();
  });

  it("空被拖集合返回 null", () => {
    expect(findGroupDropTarget(new Set(), [groupA])).toBeNull();
  });

  it("被拖节点中心都在组外时返回 null", () => {
    const nodes = [groupA, box("n1", 900, 900, 50, 50)];
    expect(findGroupDropTarget(new Set(["n1"]), nodes)).toBeNull();
  });

  it("没有 group 节点时返回 null", () => {
    const nodes = [box("n1", 0, 0, 50, 50), box("n2", 10, 10, 50, 50)];
    expect(findGroupDropTarget(new Set(["n1"]), nodes)).toBeNull();
  });

  it("多个 group 重叠时命中后面的那个（倒序遍历，视觉上层优先）", () => {
    const first = box("g-first", 0, 0, 500, 500, "group");
    const second = box("g-second", 0, 0, 500, 500, "group");
    const nodes = [first, second, box("n1", 100, 100, 50, 50)];
    expect(findGroupDropTarget(new Set(["n1"]), nodes)?.id).toBe("g-second");
  });

  it("group 自身在被拖集合里时跳过它", () => {
    const nodes = [box("n1", 100, 100, 50, 50), groupA];
    expect(findGroupDropTarget(new Set(["n1", "ga"]), nodes)).toBeNull();
  });

  it("只被拖一个节点，同组的其它节点不参与命中判定", () => {
    const nodes = [groupA, box("n1", 100, 100, 50, 50), box("n2", 900, 900, 50, 50)];
    expect(findGroupDropTarget(new Set(["n2"]), nodes)).toBeNull();
  });
});

describe("snapNodesIntoGroup", () => {
  const group = box("g", 0, 0, 500, 500, "group");

  it("节点已在组内安全区时位移为 0", () => {
    const nodes = [group, box("n1", 200, 200, 100, 100)];
    expect(snapNodesIntoGroup(new Set(["n1"]), nodes, group)).toEqual({ dx: 0, dy: 0 });
  });

  it("右侧越界时往左拉，让右边界贴到 pad 内缩线", () => {
    const nodes = [group, box("n1", 400, 400, 100, 100)];
    const { dx, dy } = snapNodesIntoGroup(new Set(["n1"]), nodes, group);
    expect(dx).toBe(476 - 500);
    expect(dy).toBe(476 - 500);
  });

  it("左侧越界时往右推，让左边界贴到 pad 内缩线", () => {
    const nodes = [group, box("n1", 0, 0, 100, 100)];
    expect(snapNodesIntoGroup(new Set(["n1"]), nodes, group)).toEqual({
      dx: GROUP_WRAP_PADDING,
      dy: GROUP_WRAP_PADDING,
    });
  });

  it("整体比内缩区还宽时贴左（右边溢出由组宽本身承载）", () => {
    const nodes = [group, box("n1", 0, 0, 600, 100)];
    expect(snapNodesIntoGroup(new Set(["n1"]), nodes, group).dx).toBe(GROUP_WRAP_PADDING);
  });

  it("多节点按整体包围盒平移，相对位置不变", () => {
    const nodes = [group, box("n1", 0, 200, 50, 50), box("n2", 60, 200, 50, 50)];
    const { dx, dy } = snapNodesIntoGroup(new Set(["n1", "n2"]), nodes, group);
    expect(dx).toBe(GROUP_WRAP_PADDING);
    expect(dy).toBe(0);
  });

  it("没有可移动节点时返回 0 位移", () => {
    expect(snapNodesIntoGroup(new Set(), [group], group)).toEqual({ dx: 0, dy: 0 });
  });
});

describe("collectGroupMemberNodes", () => {
  const groupIdOf = (node: NodeBox): string | undefined => {
    if (node.id === "a" || node.id === "b") return "g1";
    if (node.id === "c") return "g2";
    return undefined;
  };
  const nodes = [
    box("g1", 0, 0, 300, 300, "group"),
    box("a", 10, 10, 50, 50),
    box("b", 80, 10, 50, 50),
    box("c", 200, 200, 50, 50),
    box("d", 400, 400, 50, 50),
  ];

  it("选中 group 时展开成它的全部成员", () => {
    expect(collectGroupMemberNodes(["g1"], nodes, groupIdOf).map((n) => n.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("选中散节点时原样返回该节点", () => {
    expect(collectGroupMemberNodes(["d"], nodes, groupIdOf).map((n) => n.id)).toEqual(["d"]);
  });

  it("group 与它的成员同时被选中时不重复", () => {
    expect(collectGroupMemberNodes(["g1", "a"], nodes, groupIdOf).map((n) => n.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("结果按 nodes 原序，不按选中顺序", () => {
    expect(collectGroupMemberNodes(["c", "d"], nodes, groupIdOf).map((n) => n.id)).toEqual([
      "c",
      "d",
    ]);
  });

  it("group 节点自身不出现在结果里（它只是容器）", () => {
    const ids = collectGroupMemberNodes(["g1", "c"], nodes, groupIdOf).map((n) => n.id);
    expect(ids).not.toContain("g1");
  });

  it("空选中返回空数组", () => {
    expect(collectGroupMemberNodes([], nodes, groupIdOf)).toEqual([]);
  });
});

describe("getGroupWrapRect", () => {
  it("四周外扩 pad，顶部多留 top pad 给工具栏", () => {
    const rect = getGroupWrapRect([box("a", 100, 100, 200, 100)]);
    expect(rect).toEqual({
      left: 100 - GROUP_WRAP_PADDING,
      top: 100 - GROUP_WRAP_TOP_PADDING,
      right: 300 + GROUP_WRAP_PADDING,
      bottom: 200 + GROUP_WRAP_PADDING,
    });
  });

  it("顶部与底部留白故意不等（顶部更大）", () => {
    const rect = getGroupWrapRect([box("a", 0, 0, 100, 100)]);
    expect(rect.top).toBe(-GROUP_WRAP_TOP_PADDING);
    expect(rect.bottom).toBe(100 + GROUP_WRAP_PADDING);
    expect(GROUP_WRAP_TOP_PADDING).toBeGreaterThan(GROUP_WRAP_PADDING);
  });

  it("空成员退回以原点为中心的退化矩形，不产生 NaN", () => {
    const rect = getGroupWrapRect([]);
    expect(rect).toEqual({
      left: -GROUP_WRAP_PADDING,
      top: -GROUP_WRAP_TOP_PADDING,
      right: GROUP_WRAP_PADDING,
      bottom: GROUP_WRAP_PADDING,
    });
  });
});

describe("focusViewportForNode", () => {
  const size = { width: 1000, height: 800 };

  it("无浮层时节点竖向居中、横向居中", () => {
    const v = focusViewportForNode(box("n", 0, 0, 100, 100), size, NO_FRAME);
    expect(v.k).toBe(1);
    expect(v.x).toBe(450);
    expect(v.y).toBe(350);
  });

  it("节点不超过视口高的 60%", () => {
    const v = focusViewportForNode(box("n", 0, 0, 1000, 1000), size, NO_FRAME);
    expect(v.k).toBeCloseTo(0.48, 10);
    expect(1000 * v.k).toBeCloseTo(size.height * FOCUS_MAX_VIEWPORT_RATIO, 10);
  });

  it("节点不超过视口宽的 60%（窄高视口下由宽约束）", () => {
    const narrow = { width: 500, height: 2000 };
    const v = focusViewportForNode(box("n", 0, 0, 1000, 1000), narrow, NO_FRAME);
    expect(v.k).toBeCloseTo(0.3, 10);
    expect(1000 * v.k).toBeCloseTo(narrow.width * FOCUS_MAX_VIEWPORT_RATIO, 10);
  });

  it("极小节点不会放大超过 1", () => {
    expect(focusViewportForNode(box("n", 0, 0, 1, 1), size, NO_FRAME).k).toBe(FOCUS_MAX_ZOOM);
  });

  it("极大节点缩放下限夹到 0.05", () => {
    const v = focusViewportForNode(box("n", 0, 0, 1e6, 1e6), size, NO_FRAME);
    expect(v.k).toBe(FOCUS_MIN_ZOOM);
  });

  it("下方有浮层时上下按 3:1 分配，块整体下移贴近底部 dock", () => {
    const frame: FrameInsets = { above: 50, below: 100, bottomInset: 0 };
    const node = box("n", 0, 0, 200, 200);
    const v = focusViewportForNode(node, { width: 1000, height: 1000 }, frame);
    const nodeTop = v.y + node.position.y * v.k;
    const blockBottom = nodeTop + 200 * v.k + frame.below;
    const gapAbove = nodeTop - frame.above;
    const gapBelow = 1000 - blockBottom;
    expect(gapAbove / gapBelow).toBeCloseTo(3, 10);
  });

  it("上浮层预留带不会被节点侵入（blockHeight 必须含 above/below）", () => {
    const frame: FrameInsets = { above: 120, below: 0, bottomInset: 0 };
    const node = box("n", 0, 0, 200, 200);
    const v = focusViewportForNode(node, { width: 1000, height: 1000 }, frame);
    const nodeTop = v.y + node.position.y * v.k;
    // 无下浮层时 slack 上下均分，节点顶边应恰好落在「slack 的一半 + above」处
    const slack = 1000 - (frame.above + 200 * v.k);
    expect(nodeTop).toBeCloseTo(slack / 2 + frame.above, 10);
  });

  it("bottomInset 从可用高度里扣掉，节点在扣掉后的区域内居中", () => {
    const frame: FrameInsets = { above: 0, below: 0, bottomInset: 200 };
    const node = box("n", 0, 0, 100, 100);
    const v = focusViewportForNode(node, { width: 1000, height: 1000 }, frame);
    const nodeCenterY = v.y + (node.position.y + 50) * v.k;
    expect(nodeCenterY).toBeCloseTo((1000 - 200) / 2, 10);
  });

  it("视口变换把节点世界中心映射到屏幕中心附近（横向严格居中）", () => {
    const node = box("n", 1234, -567, 300, 200);
    const v = focusViewportForNode(node, size, NO_FRAME);
    expect(v.x + (node.position.x + 150) * v.k).toBeCloseTo(size.width / 2, 10);
  });

  it("宽为 0 时兜底返回 {0,0,1}，不产出 Infinity / NaN", () => {
    expect(focusViewportForNode(box("n", 0, 0, 0, 100), size, NO_FRAME)).toEqual({
      x: 0,
      y: 0,
      k: 1,
    });
  });

  it("高为负数或 NaN 时同样兜底", () => {
    expect(focusViewportForNode(box("n", 0, 0, 100, -5), size, NO_FRAME)).toEqual({
      x: 0,
      y: 0,
      k: 1,
    });
    expect(focusViewportForNode(box("n", 0, 0, 100, Number.NaN), size, NO_FRAME)).toEqual({
      x: 0,
      y: 0,
      k: 1,
    });
  });

  it("宽高缺省的节点按 0 处理，走兜底分支", () => {
    expect(
      focusViewportForNode({ id: "n", position: { x: 10, y: 10 } }, size, NO_FRAME),
    ).toEqual({ x: 0, y: 0, k: 1 });
  });
});

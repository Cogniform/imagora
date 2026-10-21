import { describe, expect, it } from "vitest";

import {
  EDGE_OPACITY_DIMMED,
  EDGE_STROKE_HOVERED,
  EDGE_STROKE_IDLE,
  EDGE_STROKE_SELECTED,
  EDGE_WIDTH_ACTIVE,
  EDGE_WIDTH_IDLE,
  dimmedEdgeIds,
  edgeStyle,
  edgeVisualState,
  type EdgeStyle,
  type EdgeVisualState,
  type EdgeVisualStateInput,
} from "./edgeStyle";

// 纯字符串 + 纯数值判定，不碰 DOM / React Flow / canvas，因此不加 `@vitest-environment jsdom`。

/** 造一个入参；默认未悬停、未选中、无降权 */
function input(overrides: Partial<EdgeVisualStateInput> = {}): EdgeVisualStateInput {
  return { hovered: false, selected: false, hasSelection: false, ...overrides };
}

/** 四态全集，供「逐态检查」类用例复用 */
const ALL_STATES: readonly EdgeVisualState[] = ["idle", "hovered", "selected", "dimmed"];

/** 造一条连线；id 与 source/target 都可覆盖 */
function edge(id: string, source: string, target: string): { id: string; source: string; target: string } {
  return { id, source, target };
}

describe("常量", () => {
  it("EDGE_WIDTH_ACTIVE 比 EDGE_WIDTH_IDLE 粗，但差距不超过 1.5px（够看见又不跳）", () => {
    expect(EDGE_WIDTH_ACTIVE).toBeGreaterThan(EDGE_WIDTH_IDLE);
    expect(EDGE_WIDTH_ACTIVE - EDGE_WIDTH_IDLE).toBeLessThanOrEqual(1.5);
  });

  it("线宽常量是正数（0 或负值会让连线在 SVG 里直接消失）", () => {
    expect(EDGE_WIDTH_IDLE).toBeGreaterThan(0);
    expect(EDGE_WIDTH_ACTIVE).toBeGreaterThan(0);
  });

  it("EDGE_OPACITY_DIMMED 在 (0, 1) 之间：淡到退居背景，但仍看得见", () => {
    expect(EDGE_OPACITY_DIMMED).toBeGreaterThan(0);
    expect(EDGE_OPACITY_DIMMED).toBeLessThan(1);
  });
});

describe("edgeVisualState · 优先级 selected > hovered > hasSelection > idle", () => {
  it("三个都是 false → idle", () => {
    expect(edgeVisualState(input())).toBe("idle");
  });

  it("只 hovered → hovered", () => {
    expect(edgeVisualState(input({ hovered: true }))).toBe("hovered");
  });

  it("只 selected → selected", () => {
    expect(edgeVisualState(input({ selected: true }))).toBe("selected");
  });

  it("只 hasSelection → dimmed", () => {
    expect(edgeVisualState(input({ hasSelection: true }))).toBe("dimmed");
  });

  it("selected + hovered → selected（选中态更持久，hover 不能把它降级）", () => {
    expect(edgeVisualState(input({ selected: true, hovered: true }))).toBe("selected");
  });

  it("selected + hasSelection → selected（选中的线不会因为节点选中而淡出）", () => {
    expect(edgeVisualState(input({ selected: true, hasSelection: true }))).toBe("selected");
  });

  it("selected + hovered + hasSelection 全真 → selected（最高优先级）", () => {
    expect(edgeVisualState(input({ selected: true, hovered: true, hasSelection: true }))).toBe("selected");
  });

  it("hovered + hasSelection → hovered（鼠标指着的线必须亮起来，否则是能点却永远是灰的死角）", () => {
    expect(edgeVisualState(input({ hovered: true, hasSelection: true }))).toBe("hovered");
  });

  it("八种布尔组合逐一验证，结果与优先级表完全一致", () => {
    const expected: Record<string, EdgeVisualState> = {
      "000": "idle",
      "001": "dimmed",
      "010": "hovered",
      "011": "hovered",
      "100": "selected",
      "101": "selected",
      "110": "selected",
      "111": "selected",
    };
    for (const selected of [false, true]) {
      for (const hovered of [false, true]) {
        for (const hasSelection of [false, true]) {
          const key = `${selected ? 1 : 0}${hovered ? 1 : 0}${hasSelection ? 1 : 0}`;
          expect(edgeVisualState({ selected, hovered, hasSelection })).toBe(expected[key]);
        }
      }
    }
  });
});

describe("edgeStyle · 四态外观", () => {
  it("idle：细线、不透明、描边色取 idle token", () => {
    expect(edgeStyle("idle")).toEqual({
      stroke: EDGE_STROKE_IDLE,
      strokeWidth: EDGE_WIDTH_IDLE,
      opacity: 1,
      animated: true,
    });
  });

  it("hovered：加粗、不透明、描边色取 hovered token", () => {
    expect(edgeStyle("hovered")).toEqual({
      stroke: EDGE_STROKE_HOVERED,
      strokeWidth: EDGE_WIDTH_ACTIVE,
      opacity: 1,
      animated: true,
    });
  });

  it("selected：加粗、不透明、描边色取 selected token", () => {
    expect(edgeStyle("selected")).toEqual({
      stroke: EDGE_STROKE_SELECTED,
      strokeWidth: EDGE_WIDTH_ACTIVE,
      opacity: 1,
      animated: true,
    });
  });

  it("dimmed：细线、EDGE_OPACITY_DIMMED、且停止流动动画（满屏淡线一起流动比不降权更吵）", () => {
    expect(edgeStyle("dimmed")).toEqual({
      stroke: EDGE_STROKE_IDLE,
      strokeWidth: EDGE_WIDTH_IDLE,
      opacity: EDGE_OPACITY_DIMMED,
      animated: false,
    });
  });

  it("hovered 与 selected 线宽相等且都比 idle 粗", () => {
    const idle = edgeStyle("idle").strokeWidth;
    const hovered = edgeStyle("hovered").strokeWidth;
    const selected = edgeStyle("selected").strokeWidth;
    expect(hovered).toBe(selected);
    expect(hovered).toBeGreaterThan(idle);
  });

  it("四态描边色都是 var(--edge-stroke-*) 变量，不写死十六进制", () => {
    for (const state of ALL_STATES) {
      const { stroke } = edgeStyle(state);
      expect(stroke.startsWith("var(--edge-stroke-")).toBe(true);
      expect(stroke).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    }
  });

  it("三个激活态 token 互不相同（否则 hover 与 selected 在视觉上无法区分）", () => {
    expect(new Set([EDGE_STROKE_IDLE, EDGE_STROKE_HOVERED, EDGE_STROKE_SELECTED]).size).toBe(3);
  });

  it("只有 dimmed 的透明度小于 1，其余三态完全不透明", () => {
    for (const state of ALL_STATES) {
      const { opacity } = edgeStyle(state);
      if (state === "dimmed") expect(opacity).toBeLessThan(1);
      else expect(opacity).toBe(1);
    }
  });

  it("返回的四个字段类型正确", () => {
    for (const state of ALL_STATES) {
      const style: EdgeStyle = edgeStyle(state);
      expect(typeof style.stroke).toBe("string");
      expect(typeof style.strokeWidth).toBe("number");
      expect(typeof style.opacity).toBe("number");
      expect(typeof style.animated).toBe("boolean");
    }
  });

  it("每次调用返回新对象（调用方改写返回值不会污染内部查表）", () => {
    const first = edgeStyle("idle");
    first.strokeWidth = 99;
    first.stroke = "mutated";
    expect(edgeStyle("idle").strokeWidth).toBe(EDGE_WIDTH_IDLE);
    expect(edgeStyle("idle").stroke).toBe(EDGE_STROKE_IDLE);
  });

  it("同样输入返回同样结果（纯函数，不依赖外部可变状态）", () => {
    expect(edgeStyle("hovered")).toEqual(edgeStyle("hovered"));
    expect(edgeVisualState(input({ hovered: true }))).toBe(edgeVisualState(input({ hovered: true })));
  });

  it("不修改传入的入参对象", () => {
    const arg: EdgeVisualStateInput = { hovered: true, selected: false, hasSelection: true };
    const snapshot = JSON.stringify(arg);
    edgeVisualState(arg);
    edgeStyle(edgeVisualState(arg));
    expect(JSON.stringify(arg)).toBe(snapshot);
  });
});

describe("dimmedEdgeIds · 两端都不在选中集合里才降权", () => {
  const edges = [
    edge("e1", "a", "b"), // 与选中节点 a 相连
    edge("e2", "b", "c"), // 与任何选中节点都无关
    edge("e3", "c", "d"), // 与任何选中节点都无关
    edge("e4", "d", "a"), // 与选中节点 a 相连（target 端）
  ];

  it("没有选中任何节点 → 空数组（没有任何理由降权）", () => {
    expect(dimmedEdgeIds(edges, [])).toEqual([]);
  });

  it("选中 a：只有两端都与 a 无关的 e2 / e3 降权", () => {
    expect(dimmedEdgeIds(edges, ["a"])).toEqual(["e2", "e3"]);
  });

  it("一端连着选中节点就不降权：e1(source=a) 与 e4(target=a) 都保留", () => {
    const dimmed = dimmedEdgeIds(edges, ["a"]);
    expect(dimmed).not.toContain("e1");
    expect(dimmed).not.toContain("e4");
  });

  it("选中两端（a 与 b）→ e1 两端都在集合里，不降权", () => {
    expect(dimmedEdgeIds(edges, ["a", "b"])).toEqual(["e3"]);
  });

  it("选中全部相关节点 → 空数组（每条线都至少一端被选中）", () => {
    expect(dimmedEdgeIds(edges, ["a", "b", "c", "d"])).toEqual([]);
  });

  it("选中一个不存在的节点 id → 全部连线降权", () => {
    expect(dimmedEdgeIds(edges, ["ghost"])).toEqual(["e1", "e2", "e3", "e4"]);
  });

  it("空连线列表 → 空数组", () => {
    expect(dimmedEdgeIds([], ["a"])).toEqual([]);
  });

  it("结果顺序与输入顺序一致（不排序、不去重）", () => {
    const ordered = [edge("z", "x1", "y1"), edge("a", "x2", "y2"), edge("m", "x3", "y3")];
    expect(dimmedEdgeIds(ordered, ["sel"])).toEqual(["z", "a", "m"]);
  });

  it("自环连线（source === target）落在选中集合里时不降权", () => {
    expect(dimmedEdgeIds([edge("loop", "a", "a"), edge("other", "b", "c")], ["a"])).toEqual(["other"]);
  });

  it("不修改入参数组（edges 与 selectedNodeIds 都只读）", () => {
    const list = [edge("e1", "a", "b")];
    const selected = ["a"];
    const edgesSnapshot = JSON.stringify(list);
    const selectedSnapshot = JSON.stringify(selected);
    dimmedEdgeIds(list, selected);
    expect(JSON.stringify(list)).toBe(edgesSnapshot);
    expect(JSON.stringify(selected)).toBe(selectedSnapshot);
  });

  it("返回值是全新数组，调用方 push 不会影响下次调用的结果", () => {
    const first = dimmedEdgeIds(edges, ["a"]);
    first.push("injected");
    expect(dimmedEdgeIds(edges, ["a"])).toEqual(["e2", "e3"]);
  });

  it("与 edgeVisualState 组合：降权集合内的线在无 hover/选中时得到 dimmed 外观", () => {
    const dimmed = dimmedEdgeIds(edges, ["a"]);
    for (const item of edges) {
      const state = edgeVisualState({ hovered: false, selected: false, hasSelection: dimmed.includes(item.id) });
      const style = edgeStyle(state);
      if (dimmed.includes(item.id)) {
        expect(style.opacity).toBe(EDGE_OPACITY_DIMMED);
        expect(style.animated).toBe(false);
      } else {
        expect(style.opacity).toBe(1);
        expect(style.strokeWidth).toBe(EDGE_WIDTH_IDLE);
      }
    }
  });
});

import { describe, expect, it } from "vitest";

import {
  SPLIT_MAX_COLS,
  SPLIT_MAX_ROWS,
  SPLIT_MIN_CELLS,
  SPLIT_PRESETS,
  clampGrid,
  splitCellCount,
  splitCells,
  splitCellsByLines,
  splitOutputName,
  type SplitGrid,
} from "./imageSplit";
import type { CropRect } from "./imageOps";

// A 层纯几何数学的单测；B 层 canvas I/O（splitDataUrl）依赖 2D context，
// jsdom 没有，不测。

/** 取第 index 格（`noUncheckedIndexedAccess` 下下标访问是 `T | undefined`，这里统一收窄） */
function cellAt(cells: readonly CropRect[], index: number): CropRect {
  const cell = cells[index];
  if (!cell) throw new Error(`缺少第 ${index} 格（共 ${cells.length} 格）`);
  return cell;
}

/** 收集各格的左边界 / 上边界，用于判"不重叠、首尾相接、铺满 0~1" */
function axisEdges(cells: readonly CropRect[], axis: "x" | "y"): number[] {
  const size = axis === "x" ? "width" : "height";
  const edges = cells.flatMap((cell) => [cell[axis], cell[axis] + cell[size]]);
  return [...new Set(edges)].sort((a, b) => a - b);
}

/** 判定：所有格子都落在 [0,1]² 内 */
function expectInsideUnitSquare(cells: readonly CropRect[]): void {
  for (const cell of cells) {
    expect(cell.x).toBeGreaterThanOrEqual(0);
    expect(cell.y).toBeGreaterThanOrEqual(0);
    expect(cell.width).toBeGreaterThan(0);
    expect(cell.height).toBeGreaterThan(0);
    expect(cell.x + cell.width).toBeLessThanOrEqual(1 + 1e-12);
    expect(cell.y + cell.height).toBeLessThanOrEqual(1 + 1e-12);
  }
}

describe("clampGrid", () => {
  it("NaN / Infinity 各自回落 1", () => {
    expect(clampGrid(Number.NaN, Number.NaN)).toEqual({ rows: 1, cols: 1 });
    expect(clampGrid(Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY)).toEqual({ rows: 1, cols: 1 });
  });

  it("0 与负数夹到 1", () => {
    expect(clampGrid(0, -3)).toEqual({ rows: 1, cols: 1 });
  });

  it("超上限夹到 8（行列各自独立）", () => {
    expect(clampGrid(99, 3)).toEqual({ rows: SPLIT_MAX_ROWS, cols: 3 });
    expect(clampGrid(2, 100)).toEqual({ rows: 2, cols: SPLIT_MAX_COLS });
  });

  it("小数四舍五入（2.4 → 2，2.6 → 3）", () => {
    expect(clampGrid(2.4, 2.6)).toEqual({ rows: 2, cols: 3 });
    expect(clampGrid(0.4, 1.5)).toEqual({ rows: 1, cols: 2 });
  });

  it("1×1 是合法输入，不被抬到 2", () => {
    expect(clampGrid(1, 1)).toEqual({ rows: 1, cols: 1 });
  });
});

describe("splitCells", () => {
  it("2×2 四格坐标精确（行优先）", () => {
    const cells = splitCells({ rows: 2, cols: 2 });
    expect(cells).toHaveLength(4);
    expect(cellAt(cells, 0).x).toBeCloseTo(0, 12);
    expect(cellAt(cells, 0).y).toBeCloseTo(0, 12);
    expect(cellAt(cells, 0).width).toBeCloseTo(0.5, 12);
    expect(cellAt(cells, 0).height).toBeCloseTo(0.5, 12);
    expect(cellAt(cells, 1).x).toBeCloseTo(0.5, 12);
    expect(cellAt(cells, 1).y).toBeCloseTo(0, 12);
    expect(cellAt(cells, 2).x).toBeCloseTo(0, 12);
    expect(cellAt(cells, 2).y).toBeCloseTo(0.5, 12);
    expect(cellAt(cells, 3).x).toBeCloseTo(0.5, 12);
    expect(cellAt(cells, 3).y).toBeCloseTo(0.5, 12);
  });

  it("3×2 六格坐标精确（三行两列）", () => {
    const cells = splitCells({ rows: 3, cols: 2 });
    expect(cells).toHaveLength(6);
    expect(cellAt(cells, 0).y).toBeCloseTo(0, 12);
    expect(cellAt(cells, 2).y).toBeCloseTo(1 / 3, 12);
    expect(cellAt(cells, 4).y).toBeCloseTo(2 / 3, 12);
    expect(cellAt(cells, 0).height).toBeCloseTo(1 / 3, 12);
    expect(cellAt(cells, 4).height).toBeCloseTo(1 / 3, 12);
    expect(cellAt(cells, 1).x).toBeCloseTo(0.5, 12);
    expect(cellAt(cells, 1).width).toBeCloseTo(0.5, 12);
  });

  it("最后一格的右边界 / 下边界恰好收到 1（不越界）", () => {
    const cells = splitCells({ rows: 3, cols: 7 });
    const last = cellAt(cells, cells.length - 1);
    expect(last.x + last.width).toBeCloseTo(1, 12);
    expect(last.y + last.height).toBeCloseTo(1, 12);
    expectInsideUnitSquare(cells);
  });

  it("格子不重叠且相邻边界严格相接（3×3 → 每轴 4 条边界）", () => {
    const cells = splitCells({ rows: 3, cols: 3 });
    expect(axisEdges(cells, "x")).toHaveLength(4);
    expect(axisEdges(cells, "y")).toHaveLength(4);
    for (const [index, edge] of axisEdges(cells, "x").entries()) {
      expect(edge).toBeCloseTo(index / 3, 12);
    }
  });

  it("格子数等于 rows * cols，且 1×1 只给一整格", () => {
    expect(splitCells({ rows: 4, cols: 5 })).toHaveLength(20);
    const single = splitCells({ rows: 1, cols: 1 });
    expect(single).toHaveLength(1);
    expect(cellAt(single, 0)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it("越界 / 非法网格先经 clampGrid 收拢", () => {
    expect(splitCells({ rows: 99, cols: 99 })).toHaveLength(SPLIT_MAX_ROWS * SPLIT_MAX_COLS);
    expect(splitCells({ rows: Number.NaN, cols: -2 })).toHaveLength(1);
  });
});

describe("splitCellsByLines", () => {
  it("无切割线时返回单个全图格子", () => {
    expect(splitCellsByLines([], [])).toEqual([{ x: 0, y: 0, width: 1, height: 1 }]);
  });

  it("输入乱序也会先排序（0.7 / 0.3 → 三段递增）", () => {
    const cells = splitCellsByLines([0.7, 0.3], []);
    expect(cells).toHaveLength(3);
    expect(cellAt(cells, 0)).toEqual({ x: 0, y: 0, width: 1, height: 0.3 });
    expect(cellAt(cells, 1).y).toBeCloseTo(0.3, 12);
    expect(cellAt(cells, 1).height).toBeCloseTo(0.4, 12);
    expect(cellAt(cells, 2).y).toBeCloseTo(0.7, 12);
    expect(cellAt(cells, 2).height).toBeCloseTo(0.3, 12);
  });

  it("近似重复的线按容差 1e-6 去重（只切一刀）", () => {
    const cells = splitCellsByLines([0.5, 0.5 + 1e-9], []);
    expect(cells).toHaveLength(2);
    expect(cellAt(cells, 0).height).toBeCloseTo(0.5, 12);
  });

  it("0 与 1 端点被忽略（传了也不会切出零宽格）", () => {
    const cells = splitCellsByLines([0, 1, 0.5], [0, 1]);
    expect(cells).toHaveLength(2);
    expectInsideUnitSquare(cells);
  });

  it("贴边线（距端点 < 0.02）被夹掉，0.02 恰好保留", () => {
    expect(splitCellsByLines([0.01, 0.99, 0.5], [])).toHaveLength(2);
    expect(splitCellsByLines([0.02, 0.98], [])).toHaveLength(3);
  });

  it("非有限数被丢弃（NaN / Infinity 不参与切割）", () => {
    const cells = splitCellsByLines([Number.NaN, Number.POSITIVE_INFINITY, 0.5], []);
    expect(cells).toHaveLength(2);
  });

  it("行列各自成区间后按行优先组合", () => {
    const cells = splitCellsByLines([0.25, 0.75], [0.5]);
    expect(cells).toHaveLength(6);
    expect(cellAt(cells, 0)).toEqual({ x: 0, y: 0, width: 0.5, height: 0.25 });
    expect(cellAt(cells, 1)).toEqual({ x: 0.5, y: 0, width: 0.5, height: 0.25 });
    expect(cellAt(cells, 2)).toEqual({ x: 0, y: 0.25, width: 0.5, height: 0.5 });
    expect(cellAt(cells, 5).y).toBeCloseTo(0.75, 12);
    expect(cellAt(cells, 5).height).toBeCloseTo(0.25, 12);
  });

  it("与等分网格等价：单线 0.5 / 0.5 等于 2×2 网格", () => {
    const byLines = splitCellsByLines([0.5], [0.5]);
    const byGrid = splitCells({ rows: 2, cols: 2 });
    expect(byLines).toHaveLength(byGrid.length);
    for (const [index, cell] of byLines.entries()) {
      const reference = cellAt(byGrid, index);
      expect(cell.x).toBeCloseTo(reference.x, 12);
      expect(cell.y).toBeCloseTo(reference.y, 12);
      expect(cell.width).toBeCloseTo(reference.width, 12);
      expect(cell.height).toBeCloseTo(reference.height, 12);
    }
  });

  it("格子铺满 0~1 且互不重叠（4 条行线 → 6 条边界；2 条列线 → 4 条边界）", () => {
    const cells = splitCellsByLines([0.2, 0.4, 0.6, 0.8], [0.1, 0.9]);
    expect(cells).toHaveLength(15);
    expect(axisEdges(cells, "y")).toHaveLength(6);
    expect(axisEdges(cells, "x")).toHaveLength(4);
    const yEdges = axisEdges(cells, "y");
    expect(yEdges[0]).toBe(0);
    expect(yEdges[yEdges.length - 1]).toBe(1);
    expectInsideUnitSquare(cells);
  });
});

describe("splitCellCount", () => {
  it("等于 clampGrid 后的 rows * cols", () => {
    expect(splitCellCount({ rows: 2, cols: 3 })).toBe(6);
    expect(splitCellCount({ rows: 1, cols: 1 })).toBe(1);
    expect(splitCellCount({ rows: 99, cols: 99 })).toBe(SPLIT_MAX_ROWS * SPLIT_MAX_COLS);
    expect(splitCellCount({ rows: Number.NaN, cols: 0 })).toBe(1);
  });

  it("与 splitCells 的实际长度一致", () => {
    for (const grid of [
      { rows: 1, cols: 1 },
      { rows: 2, cols: 2 },
      { rows: 3, cols: 5 },
      { rows: 8, cols: 8 },
    ] satisfies SplitGrid[]) {
      expect(splitCellCount(grid)).toBe(splitCells(grid).length);
    }
  });

  it("SPLIT_PRESETS 全部落在合法范围内，且格子数 ≥ SPLIT_MIN_CELLS", () => {
    expect(SPLIT_PRESETS.length).toBeGreaterThan(0);
    for (const preset of SPLIT_PRESETS) {
      expect(preset.rows).toBeGreaterThanOrEqual(1);
      expect(preset.rows).toBeLessThanOrEqual(SPLIT_MAX_ROWS);
      expect(preset.cols).toBeGreaterThanOrEqual(1);
      expect(preset.cols).toBeLessThanOrEqual(SPLIT_MAX_COLS);
      expect(splitCellCount(preset)).toBeGreaterThanOrEqual(SPLIT_MIN_CELLS);
    }
  });
});

describe("splitOutputName", () => {
  it("命名格式：<stem>-<rows>x<cols>-<index>.png", () => {
    expect(splitOutputName("红苹果.png", 3, 4, 2, 2)).toBe("红苹果-2x2-3.png");
    expect(splitOutputName("photo", 1, 6, 2, 3)).toBe("photo-2x3-1.png");
  });

  it("去掉扩展名只认最后一个点（a.b.png → a.b）", () => {
    expect(splitOutputName("a.b.png", 1, 4, 2, 2)).toBe("a.b-2x2-1.png");
    expect(splitOutputName("noext", 2, 4, 2, 2)).toBe("noext-2x2-2.png");
  });

  it("非法字符换成下划线", () => {
    expect(splitOutputName('a<b>c:d*e?f"g|h\\i/j.png', 1, 4, 2, 2)).toBe("a_b_c_d_e_f_g_h_i_j-2x2-1.png");
  });

  it("空名 / 纯空白回落 image", () => {
    expect(splitOutputName("", 1, 4, 2, 2)).toBe("image-2x2-1.png");
    expect(splitOutputName("   ", 1, 4, 2, 2)).toBe("image-2x2-1.png");
  });

  it("超长名截到 40 字符", () => {
    const long = "字".repeat(50);
    const name = splitOutputName(long, 1, 4, 2, 2);
    expect(name).toBe(`${"字".repeat(40)}-2x2-1.png`);
    expect(name.startsWith("字".repeat(41))).toBe(false);
  });

  it("index 至少为 1（0 / 负数 / NaN 都归 1）", () => {
    expect(splitOutputName("x", 0, 4, 2, 2)).toBe("x-2x2-1.png");
    expect(splitOutputName("x", -5, 4, 2, 2)).toBe("x-2x2-1.png");
    expect(splitOutputName("x", Number.NaN, 4, 2, 2)).toBe("x-2x2-1.png");
  });

  it("total 与 rows*cols 不一致时仍按传入 rows/cols 命名，不抛错", () => {
    expect(splitOutputName("x", 1, 99, 2, 2)).toBe("x-2x2-1.png");
  });
});

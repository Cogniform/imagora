import { describe, expect, it } from "vitest";

import {
  MASK_BRUSH_DEFAULT,
  MASK_BRUSH_MAX,
  MASK_BRUSH_MIN,
  MASK_POINT_MIN_GAP,
  appendPoint,
  brushRadiusPx,
  clampBrushSize,
  hasPaint,
  interpolatePoints,
  isMaskEmpty,
  maskBoundingBox,
  type BrushPoint,
  type MaskStroke,
} from "./maskBrush";

const SQUARE = { width: 1000, height: 1000 };
const WIDE = { width: 1920, height: 1080 };

function paint(points: BrushPoint[], size = MASK_BRUSH_DEFAULT): MaskStroke {
  return { mode: "paint", size, points };
}

function erase(points: BrushPoint[], size = MASK_BRUSH_DEFAULT): MaskStroke {
  return { mode: "erase", size, points };
}

describe("clampBrushSize", () => {
  it("把过小 / 过大的值夹进 [MIN, MAX]", () => {
    expect(clampBrushSize(-1)).toBe(MASK_BRUSH_MIN);
    expect(clampBrushSize(0)).toBe(MASK_BRUSH_MIN);
    expect(clampBrushSize(1)).toBe(MASK_BRUSH_MAX);
    expect(clampBrushSize(99)).toBe(MASK_BRUSH_MAX);
  });

  it("区间内的值原样返回（含两个端点）", () => {
    expect(clampBrushSize(0.2)).toBe(0.2);
    expect(clampBrushSize(MASK_BRUSH_MIN)).toBe(MASK_BRUSH_MIN);
    expect(clampBrushSize(MASK_BRUSH_MAX)).toBe(MASK_BRUSH_MAX);
  });

  it("NaN / Infinity 回落默认值而不是下限", () => {
    expect(clampBrushSize(Number.NaN)).toBe(MASK_BRUSH_DEFAULT);
    expect(clampBrushSize(Number.POSITIVE_INFINITY)).toBe(MASK_BRUSH_DEFAULT);
    expect(clampBrushSize(Number.NEGATIVE_INFINITY)).toBe(MASK_BRUSH_DEFAULT);
  });
});

describe("brushRadiusPx", () => {
  it("半径 = size × 短边 / 2（方形图）", () => {
    // 0.08 × 1000 / 2 = 40
    expect(brushRadiusPx(0.08, SQUARE)).toBeCloseTo(40, 6);
  });

  it("以短边为基准，横图不会被长边放大", () => {
    // 短边 1080：0.1 × 1080 / 2 = 54
    expect(brushRadiusPx(0.1, WIDE)).toBeCloseTo(54, 6);
    // 竖图同理，短边是宽度
    expect(brushRadiusPx(0.1, { width: 800, height: 2000 })).toBeCloseTo(40, 6);
  });

  it("同一 size 在 4K 图上的半径按比例放大（不是固定像素）", () => {
    const small = brushRadiusPx(0.1, { width: 512, height: 512 });
    const large = brushRadiusPx(0.1, { width: 4096, height: 4096 });
    expect(large / small).toBeCloseTo(8, 6);
  });

  it("尺寸退化返回 0，不抛错", () => {
    expect(brushRadiusPx(0.1, { width: 0, height: 0 })).toBe(0);
    expect(brushRadiusPx(0.1, { width: -10, height: 100 })).toBe(0);
    expect(brushRadiusPx(0.1, { width: Number.NaN, height: 100 })).toBe(0);
  });
});

describe("appendPoint", () => {
  it("空数组返回含该点的新数组", () => {
    const points: BrushPoint[] = [];
    const next = appendPoint(points, { x: 0.5, y: 0.5 });
    expect(next).toEqual([{ x: 0.5, y: 0.5 }]);
    expect(points).toEqual([]);
  });

  it("距离小于 minGap 时返回原数组引用（不是拷贝）", () => {
    const first = appendPoint([], { x: 0.5, y: 0.5 });
    const next = appendPoint(first, { x: 0.5, y: 0.5001 });
    expect(next).toBe(first);
    expect(next).toHaveLength(1);
  });

  it("距离等于 / 超过 minGap 时追加", () => {
    const first = appendPoint([], { x: 0.5, y: 0.5 });
    const atGap = appendPoint(first, { x: 0.5 + MASK_POINT_MIN_GAP, y: 0.5 });
    expect(atGap).toHaveLength(2);
    const beyond = appendPoint(atGap, { x: 0.5 + MASK_POINT_MIN_GAP * 3, y: 0.5 });
    expect(beyond).toHaveLength(3);
  });

  it("minGap 传 0 表示不节流（完全重合的点仍然被丢弃）", () => {
    const first = appendPoint([], { x: 0.2, y: 0.2 }, 0);
    expect(appendPoint(first, { x: 0.2001, y: 0.2 }, 0)).toHaveLength(2);
    expect(appendPoint(first, { x: 0.2, y: 0.2 }, 0)).toBe(first);
  });

  it("不修改入参数组，返回新引用", () => {
    const points = [{ x: 0.1, y: 0.1 }];
    const next = appendPoint(points, { x: 0.9, y: 0.9 });
    expect(next).not.toBe(points);
    expect(points).toHaveLength(1);
    expect(next).toHaveLength(2);
  });

  it("坐标非有限时丢弃并返回原引用", () => {
    const points = [{ x: 0.5, y: 0.5 }];
    expect(appendPoint(points, { x: Number.NaN, y: 0.5 })).toBe(points);
    expect(appendPoint(points, { x: 0.5, y: Number.POSITIVE_INFINITY })).toBe(points);
  });
});

describe("interpolatePoints", () => {
  it("按 radiusPx / 4 的步长补点（不含两端）", () => {
    // 从 (0.1,0.5) 到 (0.5,0.5)：横向距离 0.4 × 1000 = 400px
    // 半径 40px → 步长 10px → 40 步 → 39 个中间点
    const mid = interpolatePoints({ x: 0.1, y: 0.5 }, { x: 0.5, y: 0.5 }, 40, SQUARE);
    expect(mid).toHaveLength(39);
    expect(mid[0]?.x).toBeCloseTo(0.1 + 0.4 / 40, 6);
    expect(mid[mid.length - 1]?.x).toBeCloseTo(0.5 - 0.4 / 40, 6);
  });

  it("距离小于一个步长时不补点", () => {
    expect(interpolatePoints({ x: 0.5, y: 0.5 }, { x: 0.501, y: 0.5 }, 40, SQUARE)).toEqual([]);
  });

  it("半径越大步长越粗、补点越少", () => {
    const from = { x: 0, y: 0.5 };
    const to = { x: 0.5, y: 0.5 };
    const thin = interpolatePoints(from, to, 5, SQUARE);
    const thick = interpolatePoints(from, to, 50, SQUARE);
    expect(thin.length).toBeGreaterThan(thick.length);
  });

  it("在像素空间量距离，横图不会补出疏密不均的点", () => {
    // 归一化 dx=0.1 在 1920 宽上是 192px；dy=0.1 在 1080 高上是 108px
    // 半径 40 → 步长 10 → 距离 hypot(192,108)=220.3 → 23 步 → 22 个点
    const mid = interpolatePoints({ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }, 40, WIDE);
    expect(mid).toHaveLength(22);
  });

  it("radiusPx 为 0（尺寸未知）时不插值，避免无穷补点", () => {
    expect(interpolatePoints({ x: 0, y: 0 }, { x: 1, y: 1 }, 0, SQUARE)).toEqual([]);
    expect(interpolatePoints({ x: 0, y: 0 }, { x: 1, y: 1 }, Number.NaN, SQUARE)).toEqual([]);
  });

  it("尺寸 / 坐标非法时返回空数组", () => {
    expect(interpolatePoints({ x: 0, y: 0 }, { x: 1, y: 1 }, 40, { width: 0, height: 0 })).toEqual(
      [],
    );
    expect(
      interpolatePoints({ x: Number.NaN, y: 0 }, { x: 1, y: 1 }, 40, SQUARE),
    ).toEqual([]);
    expect(interpolatePoints({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, 40, SQUARE)).toEqual([]);
  });
});

describe("hasPaint / isMaskEmpty", () => {
  it("空数组既没有 paint 也算空蒙版", () => {
    expect(hasPaint([])).toBe(false);
    expect(isMaskEmpty([])).toBe(true);
  });

  it("只有橡皮擦笔画算空蒙版（只擦不涂 = 没涂）", () => {
    const strokes = [erase([{ x: 0.5, y: 0.5 }, { x: 0.6, y: 0.6 }])];
    expect(hasPaint(strokes)).toBe(false);
    expect(isMaskEmpty(strokes)).toBe(true);
  });

  it("橡皮擦之后再涂：算涂过", () => {
    const strokes = [erase([{ x: 0.2, y: 0.2 }]), paint([{ x: 0.5, y: 0.5 }])];
    expect(hasPaint(strokes)).toBe(true);
    expect(isMaskEmpty(strokes)).toBe(false);
  });

  it("paint 笔画但点为空（刚按下没移动）仍算空", () => {
    expect(hasPaint([paint([])])).toBe(false);
    expect(isMaskEmpty([paint([]), erase([{ x: 0.3, y: 0.3 }])])).toBe(true);
  });
});

describe("maskBoundingBox", () => {
  it("空蒙版 / 只有橡皮擦返回 null", () => {
    expect(maskBoundingBox([], SQUARE)).toBeNull();
    expect(maskBoundingBox([erase([{ x: 0.5, y: 0.5 }])], SQUARE)).toBeNull();
  });

  it("单点包围盒 = 点 ± 半径（像素半径换算成归一化）", () => {
    // size 0.08 × 短边 1000 / 2 = 40px 半径 → 归一化 0.04
    const box = maskBoundingBox([paint([{ x: 0.5, y: 0.5 }])], SQUARE);
    expect(box?.left).toBeCloseTo(0.46, 6);
    expect(box?.top).toBeCloseTo(0.46, 6);
    expect(box?.right).toBeCloseTo(0.54, 6);
    expect(box?.bottom).toBeCloseTo(0.54, 6);
  });

  it("横图上横竖半径不相等（像素半径是各向同性的）", () => {
    // 半径 54px：x 方向 54/1920 = 0.028125，y 方向 54/1080 = 0.05
    const box = maskBoundingBox([paint([{ x: 0.5, y: 0.5 }], 0.1)], WIDE);
    expect(box?.left).toBeCloseTo(0.5 - 54 / 1920, 6);
    expect(box?.top).toBeCloseTo(0.5 - 54 / 1080, 6);
  });

  it("多笔多点的包围盒取并集", () => {
    const box = maskBoundingBox(
      [paint([{ x: 0.2, y: 0.3 }, { x: 0.4, y: 0.5 }]), paint([{ x: 0.8, y: 0.1 }])],
      SQUARE,
    );
    expect(box?.left).toBeCloseTo(0.16, 6);
    expect(box?.top).toBeCloseTo(0.06, 6);
    expect(box?.right).toBeCloseTo(0.84, 6);
    expect(box?.bottom).toBeCloseTo(0.54, 6);
  });

  it("橡皮擦笔画不进包围盒", () => {
    const withErase = maskBoundingBox(
      [paint([{ x: 0.5, y: 0.5 }]), erase([{ x: 0.99, y: 0.99 }])],
      SQUARE,
    );
    expect(withErase?.right).toBeCloseTo(0.54, 6);
    expect(withErase?.bottom).toBeCloseTo(0.54, 6);
  });

  it("笔刷压边缘时包围盒夹回 [0,1]", () => {
    const box = maskBoundingBox([paint([{ x: 0.01, y: 0.99 }])], SQUARE);
    expect(box?.left).toBe(0);
    expect(box?.bottom).toBe(1);
  });

  it("尺寸非法返回 null", () => {
    expect(maskBoundingBox([paint([{ x: 0.5, y: 0.5 }])], { width: 0, height: 0 })).toBeNull();
    expect(
      maskBoundingBox([paint([{ x: 0.5, y: 0.5 }])], { width: Number.NaN, height: 100 }),
    ).toBeNull();
  });
});

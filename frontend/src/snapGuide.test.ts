import { describe, expect, it } from "vitest";

import {
  SNAP_STEP_GRID,
  SNAP_THRESHOLD,
  snapToGrid,
  snapToNeighbors,
  type SnapBox,
} from "./snapGuide";

// 纯几何 + 纯数值，不碰 DOM / localStorage / canvas，因此不加 `@vitest-environment jsdom`。

/** 造一个吸附盒；四个数值显式给，避免踩 eOPT 的「可选键 vs undefined」 */
function box(id: string, x: number, y: number, width: number, height: number): SnapBox {
  return { id, x, y, width, height };
}

/** 断言两数严格相等（浮点用例统一走这里，顺便把 -0 的坑挡在用例外面） */
function expectCoord(actual: number, expected: number): void {
  expect(Object.is(actual, expected)).toBe(true);
}

describe("常量", () => {
  it("默认阈值 6px、网格步长 8px", () => {
    expect(SNAP_THRESHOLD).toBe(6);
    expect(SNAP_STEP_GRID).toBe(8);
  });
});

describe("snapToNeighbors · x 轴三条对齐线", () => {
  it("左边缘吸到对方左边缘", () => {
    const result = snapToNeighbors(box("m", 203, 400, 40, 40), [box("a", 200, 0, 100, 100)]);
    expectCoord(result.x, 200);
    expectCoord(result.y, 400);
    expect(result.guides).toEqual([{ axis: "x", position: 200, targetId: "a" }]);
  });

  it("右边缘吸到对方右边缘（位移为正，往右推）", () => {
    // moving 右边缘 157 + 40 = 197，对方右边缘 200，差 3
    const result = snapToNeighbors(box("m", 157, 400, 40, 40), [box("a", 200, 0, 100, 100)]);
    expectCoord(result.x, 160);
    expect(result.guides).toEqual([{ axis: "x", position: 200, targetId: "a" }]);
  });

  it("水平中心吸到对方水平中心", () => {
    // moving 中心 128 + 20 = 148，对方中心 100 + 50 = 150，差 2
    const result = snapToNeighbors(box("m", 128, 400, 40, 40), [box("a", 100, 0, 100, 100)]);
    expectCoord(result.x, 130);
    expect(result.guides).toEqual([{ axis: "x", position: 150, targetId: "a" }]);
  });
});

describe("snapToNeighbors · y 轴三条对齐线", () => {
  it("上边缘吸到对方上边缘", () => {
    const result = snapToNeighbors(box("m", 400, 203, 40, 40), [box("a", 0, 200, 100, 100)]);
    expectCoord(result.y, 200);
    expectCoord(result.x, 400);
    expect(result.guides).toEqual([{ axis: "y", position: 200, targetId: "a" }]);
  });

  it("竖直中心吸到对方竖直中心", () => {
    // moving 中心 128 + 20 = 148，对方中心 100 + 50 = 150，差 2
    const result = snapToNeighbors(box("m", 400, 128, 40, 40), [box("a", 0, 100, 100, 100)]);
    expectCoord(result.y, 130);
    expect(result.guides).toEqual([{ axis: "y", position: 150, targetId: "a" }]);
  });

  it("下边缘吸到对方下边缘（位移为正，往下推）", () => {
    // moving 下边缘 157 + 40 = 197，对方下边缘 200，差 3
    const result = snapToNeighbors(box("m", 400, 157, 40, 40), [box("a", 0, 200, 100, 100)]);
    expectCoord(result.y, 160);
    expect(result.guides).toEqual([{ axis: "y", position: 200, targetId: "a" }]);
  });
});

describe("snapToNeighbors · 两轴独立决策", () => {
  it("x 与 y 同时命中时两条 guide 都出，顺序固定 x 在前", () => {
    const result = snapToNeighbors(box("m", 203, 203, 40, 40), [box("a", 200, 200, 100, 100)]);
    expectCoord(result.x, 200);
    expectCoord(result.y, 200);
    expect(result.guides).toEqual([
      { axis: "x", position: 200, targetId: "a" },
      { axis: "y", position: 200, targetId: "a" },
    ]);
  });

  it("只吸到 x 时 y 原样返回，且不出 y 的 guide", () => {
    const result = snapToNeighbors(box("m", 203, 500, 40, 40), [box("a", 200, 0, 100, 100)]);
    expectCoord(result.x, 200);
    expectCoord(result.y, 500);
    expect(result.guides.map((guide) => guide.axis)).toEqual(["x"]);
  });

  it("只吸到 y 时 x 原样返回，且不出 x 的 guide", () => {
    const result = snapToNeighbors(box("m", 900, 203, 40, 40), [box("a", 200, 200, 100, 100)]);
    expectCoord(result.x, 900);
    expectCoord(result.y, 200);
    expect(result.guides.map((guide) => guide.axis)).toEqual(["y"]);
  });

  it("两轴各自吸到不同节点时 targetId 分别正确", () => {
    // ax 只提供 x 对齐线（y 远在天边），ay 只提供 y 对齐线（x 远在天边）
    const result = snapToNeighbors(box("m", 203, 303, 40, 40), [
      box("ax", 200, 0, 200, 10),
      box("ay", 1000, 300, 10, 200),
    ]);
    expectCoord(result.x, 200);
    expectCoord(result.y, 300);
    expect(result.guides).toEqual([
      { axis: "x", position: 200, targetId: "ax" },
      { axis: "y", position: 300, targetId: "ay" },
    ]);
  });
});

describe("snapToNeighbors · 最近目标优先", () => {
  it("两个邻居都在阈值内时取差值更小的那个", () => {
    // n1 左边缘差 2，n2 左边缘差 4 —— 必须选 n1
    const result = snapToNeighbors(box("m", 200, 400, 40, 40), [
      box("n1", 202, 0, 10, 10),
      box("n2", 204, 0, 10, 10),
    ]);
    expectCoord(result.x, 202);
    expect(result.guides).toEqual([{ axis: "x", position: 202, targetId: "n1" }]);
  });

  it("同一个邻居的多条线之间也取差值更小的那条", () => {
    // moving 左边缘差 4，moving 右边缘 268 与对方中心 270 差 2 —— 后者更近
    const result = snapToNeighbors(box("m", 224, 400, 44, 40), [box("a", 220, 0, 100, 100)]);
    expectCoord(result.x, 226);
    expect(result.guides).toEqual([{ axis: "x", position: 270, targetId: "a" }]);
  });
});

describe("snapToNeighbors · 阈值边界", () => {
  it("距离正好等于阈值时不吸附（严格小于）", () => {
    // 左边缘差 6 = SNAP_THRESHOLD，其余候选都更远
    const result = snapToNeighbors(box("m", 206, 400, 40, 40), [box("a", 200, 0, 200, 100)]);
    expectCoord(result.x, 206);
    expect(result.guides).toEqual([]);
  });

  it("距离比阈值小一点点就吸附（边界另一侧）", () => {
    const result = snapToNeighbors(box("m", 205.9, 400, 40, 40), [box("a", 200, 0, 200, 100)]);
    expectCoord(result.x, 200);
    expect(result.guides).toEqual([{ axis: "x", position: 200, targetId: "a" }]);
  });

  it("自定义 threshold 生效：放宽到 20 才吸的 15px 距离", () => {
    const moving = box("m", 215, 400, 40, 40);
    const others = [box("a", 200, 0, 200, 100)];
    expect(snapToNeighbors(moving, others).guides).toEqual([]);
    const loose = snapToNeighbors(moving, others, 20);
    expectCoord(loose.x, 200);
    expect(loose.guides).toEqual([{ axis: "x", position: 200, targetId: "a" }]);
  });

  it("自定义 threshold 收窄到 1 时，2px 的距离不吸", () => {
    const result = snapToNeighbors(box("m", 202, 400, 40, 40), [box("a", 200, 0, 200, 100)], 1);
    expectCoord(result.x, 202);
    expect(result.guides).toEqual([]);
  });
});

describe("snapToNeighbors · 无目标", () => {
  it("others 为空时原样返回、guides 为空", () => {
    const result = snapToNeighbors(box("m", 13, 27, 40, 40), []);
    expectCoord(result.x, 13);
    expectCoord(result.y, 27);
    expect(result.guides).toEqual([]);
  });

  it("全部超出阈值时原样返回，且**不**偷偷退回网格吸附", () => {
    // 13 / 27 都不是 8 的倍数：一旦退化网格，坐标会被改成 16 / 24
    const result = snapToNeighbors(box("m", 13, 27, 40, 40), [box("a", 500, 500, 100, 100)]);
    expectCoord(result.x, 13);
    expectCoord(result.y, 27);
    expect(result.guides).toEqual([]);
  });

  it("自己 id 出现在 others 里时跳过，不产生指向自己的假 guide", () => {
    const moving = box("m", 13, 27, 40, 40);
    const result = snapToNeighbors(moving, [moving]);
    expectCoord(result.x, 13);
    expectCoord(result.y, 27);
    expect(result.guides).toEqual([]);
  });

  it("坏邻居只跳过那一个，好邻居仍然能吸", () => {
    const result = snapToNeighbors(box("m", 203, 400, 40, 40), [
      box("bad", Number.NaN, 0, 100, 100),
      box("a", 200, 0, 100, 100),
    ]);
    expectCoord(result.x, 200);
    expect(result.guides).toEqual([{ axis: "x", position: 200, targetId: "a" }]);
  });
});

describe("snapToNeighbors · 浮点与零位移", () => {
  it("返回的坐标允许是浮点，不做 round", () => {
    // moving 中心 227.5 + 20.5 = 248，对方中心 200 + 50.5 = 250.5，差 2.5
    const result = snapToNeighbors(box("m", 227.5, 400, 41, 40), [box("a", 200, 0, 101, 100)]);
    expectCoord(result.x, 230);
    expect(result.guides).toEqual([{ axis: "x", position: 250.5, targetId: "a" }]);
  });

  it("本来就已经对齐（差 0）时位移为 0，但仍出一条 guide（对齐线要画）", () => {
    const result = snapToNeighbors(box("m", 220, 400, 61, 40), [box("a", 200, 0, 101, 100)]);
    expectCoord(result.x, 220);
    expect(result.guides).toEqual([{ axis: "x", position: 250.5, targetId: "a" }]);
  });
});

describe("snapToNeighbors · 非法输入安全退化", () => {
  it("moving.x 是 NaN 时返回原始坐标 + 空 guides，不抛错", () => {
    const result = snapToNeighbors(box("m", Number.NaN, 400, 40, 40), [box("a", 200, 0, 100, 100)]);
    expect(Number.isNaN(result.x)).toBe(true);
    expectCoord(result.y, 400);
    expect(result.guides).toEqual([]);
  });

  it("moving 的 Infinity / 宽高非法同样退化", () => {
    for (const moving of [
      box("m", Number.POSITIVE_INFINITY, 400, 40, 40),
      box("m", 0, Number.NEGATIVE_INFINITY, 40, 40),
      box("m", 0, 0, Number.NaN, 40),
      box("m", 0, 0, 40, Number.POSITIVE_INFINITY),
    ]) {
      const result = snapToNeighbors(moving, [box("a", 200, 0, 100, 100)]);
      expect(result.guides).toEqual([]);
      expectCoord(result.x, moving.x);
      expectCoord(result.y, moving.y);
    }
  });

  it("threshold 为 0 / 负数 / NaN 时退化（不当成「无限严格」去吸）", () => {
    const moving = box("m", 200, 400, 40, 40);
    const others = [box("a", 200, 0, 100, 100)];
    for (const threshold of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = snapToNeighbors(moving, others, threshold);
      expect(result.guides).toEqual([]);
      expectCoord(result.x, 200);
      expectCoord(result.y, 400);
    }
  });

  it("空数组 + 非法 threshold 同时出现也不抛错", () => {
    expect(() => snapToNeighbors(box("m", 1, 2, 3, 4), [], Number.NaN)).not.toThrow();
  });
});

describe("snapToGrid · 8px 栅格", () => {
  it("默认步长 8：13 / 20 分别对齐到 16 / 24", () => {
    const result = snapToGrid(box("m", 13, 20, 40, 40));
    expectCoord(result.x, 16);
    expectCoord(result.y, 24);
    expect(result.guides).toEqual([]);
  });

  it("负坐标按最近的栅格点对齐，且不返回 -0", () => {
    const result = snapToGrid(box("m", -13, -4, 40, 40));
    expectCoord(result.x, -16);
    expectCoord(result.y, 0);
    expect(Object.is(result.y, -0)).toBe(false);
  });

  it("小数坐标四舍五入到栅格", () => {
    const result = snapToGrid(box("m", 12.6, 3.2, 40, 40));
    expectCoord(result.x, 16);
    expectCoord(result.y, 0);
  });

  it("自定义步长 10：14 / 16 对齐到 10 / 20", () => {
    const result = snapToGrid(box("m", 14, 16, 40, 40), 10);
    expectCoord(result.x, 10);
    expectCoord(result.y, 20);
  });

  it("已经落在栅格上时坐标不变（幂等）", () => {
    const first = snapToGrid(box("m", 16, -8, 40, 40));
    expectCoord(first.x, 16);
    expectCoord(first.y, -8);
    const second = snapToGrid(box("m", first.x, first.y, 40, 40));
    expectCoord(second.x, first.x);
    expectCoord(second.y, first.y);
  });

  it("宽高不参与网格对齐（只动左上角）", () => {
    const result = snapToGrid(box("m", 13, 13, 41, 43));
    expectCoord(result.x, 16);
    expectCoord(result.y, 16);
    expect(result.guides).toEqual([]);
  });
});

describe("snapToGrid · 非法输入安全退化", () => {
  it("step 为 0 / 负数 / NaN / Infinity 时返回原始坐标，不抛错", () => {
    const moving = box("m", 13, 27, 40, 40);
    for (const step of [0, -8, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = snapToGrid(moving, step);
      expectCoord(result.x, 13);
      expectCoord(result.y, 27);
      expect(result.guides).toEqual([]);
    }
  });

  it("坐标是 NaN / Infinity 时原样返回，不产出更多 NaN", () => {
    for (const moving of [
      box("m", Number.NaN, 27, 40, 40),
      box("m", 13, Number.POSITIVE_INFINITY, 40, 40),
      box("m", Number.NEGATIVE_INFINITY, Number.NaN, 40, 40),
    ]) {
      const result = snapToGrid(moving);
      expect(result.guides).toEqual([]);
      expectCoord(result.x, moving.x);
      expectCoord(result.y, moving.y);
    }
  });

  it("有限输入绝不产出 Infinity 坐标（除法溢出时退回原值）", () => {
    const result = snapToGrid(box("m", 1e308, 1e308, 40, 40), 1e-10);
    expectCoord(result.x, 1e308);
    expectCoord(result.y, 1e308);
    expect(Number.isFinite(result.x)).toBe(true);
  });
});

describe("纯函数性", () => {
  it("不修改 moving / others，且每次返回全新的 guides 数组", () => {
    const moving = box("m", 203, 203, 40, 40);
    const others = [box("a", 200, 200, 100, 100)];
    const snapshot = JSON.parse(JSON.stringify({ moving, others })) as {
      moving: SnapBox;
      others: SnapBox[];
    };
    const first = snapToNeighbors(moving, others);
    snapToGrid(moving);
    expect({ moving, others }).toEqual(snapshot);
    expect(snapToNeighbors(moving, others).guides).not.toBe(first.guides);
  });

  it("同样输入永远给同样结果（可重复调用，无隐藏状态）", () => {
    const moving = box("m", 203, 203, 40, 40);
    const others = [box("a", 200, 200, 100, 100)];
    expect(snapToNeighbors(moving, others)).toEqual(snapToNeighbors(moving, others));
    expect(snapToGrid(moving)).toEqual(snapToGrid(moving));
  });
});

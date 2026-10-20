// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import {
  applySnapToChanges,
  readSnapEnabled,
  saveSnapEnabled,
  snapBoxOf,
  SNAP_STORAGE_KEY,
} from "./snapDrag";
import type { WorkflowNode } from "./types";

afterEach(() => {
  window.localStorage.clear();
});

/** 造一个最小可用的提示词节点（尺寸走 layout.ts 的估算 300×320） */
function promptNode(id: string, x: number, y: number): WorkflowNode {
  return {
    id,
    type: "prompt",
    position: { x, y },
    data: {
      prompt: "a red apple",
      size: "1024x1024",
      quality: "high",
      outputDir: "output",
      status: "idle",
    },
  } as WorkflowNode;
}

/** 造一个图片节点（估算 144×220，但 measured 优先） */
function imageNode(id: string, x: number, y: number): WorkflowNode {
  return {
    id,
    type: "image",
    position: { x, y },
    data: {
      registryId: id,
      name: `${id}.png`,
      url: `/api/image/${id}`,
      size: 1024,
      ext: "png",
      refCount: 0,
    },
  } as WorkflowNode;
}

function positionChange(id: string, x: number, y: number, dragging = true) {
  return { id, type: "position" as const, position: { x, y }, dragging };
}

describe("snapDrag / 吸附开关偏好", () => {
  it("默认是开（没写过 localStorage 时）", () => {
    expect(readSnapEnabled()).toBe(true);
  });

  it("存过 0 之后读出来是关", () => {
    saveSnapEnabled(false);
    expect(readSnapEnabled()).toBe(false);
  });

  it("存过 1 之后读出来是开", () => {
    saveSnapEnabled(true);
    expect(readSnapEnabled()).toBe(true);
  });

  it("值写坏了按默认开处理，不抛错", () => {
    window.localStorage.setItem(SNAP_STORAGE_KEY, "yes-please");
    expect(readSnapEnabled()).toBe(true);
  });

  it("localStorage 抛错时读开关退回默认开", () => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error("blocked");
    };
    try {
      expect(readSnapEnabled()).toBe(true);
    } finally {
      Storage.prototype.getItem = original;
    }
  });

  it("localStorage 抛错时存开关不抛错（拖拽不能因此崩）", () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("quota");
    };
    try {
      expect(() => saveSnapEnabled(false)).not.toThrow();
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});

describe("snapDrag / snapBoxOf", () => {
  it("尺寸优先取 measured", () => {
    const node = {
      ...imageNode("img-1", 0, 0),
      measured: { width: 200, height: 260 },
    } as unknown as WorkflowNode;
    const box = snapBoxOf(node);
    expect(box.width).toBe(200);
    expect(box.height).toBe(260);
  });

  it("没有 measured 时回落到类型估算（图片 144×220）", () => {
    const box = snapBoxOf(imageNode("img-1", 10, 20));
    expect(box).toEqual({ id: "img-1", x: 10, y: 20, width: 144, height: 220 });
  });
});

describe("snapDrag / applySnapToChanges", () => {
  it("关掉吸附时原样返回，连 changes 引用都不换", () => {
    const changes = [positionChange("a", 103, 200)];
    const nodes = [promptNode("a", 100, 200), promptNode("b", 400, 200)];
    const outcome = applySnapToChanges(changes, nodes, false);
    expect(outcome.changes).toBe(changes);
    expect(outcome.guides).toEqual([]);
  });

  it("单节点拖到邻居对齐线附近时被吸住，并给出对齐线", () => {
    // b 在 x=400；a 拖到 397（差 3 < 阈值 6）→ 左边缘吸到 400。
    // 两节点 y 刻意错开 300px，把断言收窄到「只有 x 轴吸」，否则同排时 y 轴本来
    // 就是零偏移、也会顺带吸一条（那是正确行为，但会让这条用例看不出想测的东西）。
    const changes = [positionChange("a", 397, 200)];
    const nodes = [promptNode("a", 100, 200), promptNode("b", 400, 500)];
    const outcome = applySnapToChanges(changes, nodes, true);

    const moved = outcome.changes[0];
    expect(moved).toMatchObject({ type: "position", position: { x: 400, y: 200 } });
    expect(outcome.guides).toHaveLength(1);
    expect(outcome.guides[0]).toMatchObject({ axis: "x", position: 400, targetId: "b" });
  });

  it("同排拖动时两轴同时吸住（y 本来对齐，不该被当成「没吸」）", () => {
    const changes = [positionChange("a", 397, 200)];
    const nodes = [promptNode("a", 100, 200), promptNode("b", 400, 200)];
    const outcome = applySnapToChanges(changes, nodes, true);

    expect(outcome.guides.map((g) => g.axis).sort()).toEqual(["x", "y"]);
    expect(outcome.changes[0]).toMatchObject({ position: { x: 400, y: 200 } });
  });

  it("没有邻居在阈值内时坐标原样不动，也不退回网格", () => {
    // 差 40px，远超阈值；若退回 8px 网格会变成 144。
    // y 同样错开，否则 y 轴会因零偏移而吸住，掩盖「x 没吸」这件事。
    const changes = [positionChange("a", 140, 200)];
    const nodes = [promptNode("a", 100, 200), promptNode("b", 400, 500)];
    const outcome = applySnapToChanges(changes, nodes, true);

    expect(outcome.changes[0]).toMatchObject({ position: { x: 140, y: 200 } });
    expect(outcome.guides).toEqual([]);
  });

  it("拖拽结束那条（dragging=false）不再二次吸附", () => {
    // 松手后 React Flow 补发的最终位置必须原样保留，否则鼠标与节点脱节
    const changes = [positionChange("a", 397, 200, false)];
    const nodes = [promptNode("a", 100, 200), promptNode("b", 400, 200)];
    const outcome = applySnapToChanges(changes, nodes, true);

    expect(outcome.changes[0]).toMatchObject({ position: { x: 397, y: 200 } });
    expect(outcome.guides).toEqual([]);
  });

  it("多选拖动（两条 position change）整批不吸，避免相对布局被拆散", () => {
    const changes = [positionChange("a", 397, 200), positionChange("b", 397, 500)];
    const nodes = [promptNode("a", 100, 200), promptNode("b", 100, 500), promptNode("c", 400, 200)];
    const outcome = applySnapToChanges(changes, nodes, true);

    expect(outcome.guides).toEqual([]);
    expect(outcome.changes[0]).toMatchObject({ position: { x: 397, y: 200 } });
    expect(outcome.changes[1]).toMatchObject({ position: { x: 397, y: 500 } });
  });

  it("非 position 类型的 change 原样透传", () => {
    const changes = [
      { id: "a", type: "select" as const, selected: true },
      positionChange("a", 397, 200),
    ];
    const nodes = [promptNode("a", 100, 200), promptNode("b", 400, 200)];
    const outcome = applySnapToChanges(changes, nodes, true);

    expect(outcome.changes[0]).toEqual({ id: "a", type: "select", selected: true });
    expect(outcome.changes[1]).toMatchObject({ position: { x: 400, y: 200 } });
  });

  it("找不到被拖节点（不在 nodes 里）时安全退化", () => {
    const changes = [positionChange("ghost", 397, 200)];
    const nodes = [promptNode("b", 400, 200)];
    const outcome = applySnapToChanges(changes, nodes, true);

    expect(outcome.changes[0]).toMatchObject({ position: { x: 397, y: 200 } });
    expect(outcome.guides).toEqual([]);
  });

  it("垂直方向也能吸（上边缘对齐邻居上边缘）", () => {
    // a 拖到 y=397，b 在 y=400 → 上边缘差 3 吸住。
    // x 刻意错开 500px（a=900 / b=400），否则 x 轴零偏移会先吸上，看不出测的是 y。
    const changes = [positionChange("a", 900, 397)];
    const nodes = [promptNode("a", 900, 100), promptNode("b", 400, 400)];
    const outcome = applySnapToChanges(changes, nodes, true);

    expect(outcome.changes[0]).toMatchObject({ position: { x: 900, y: 400 } });
    expect(outcome.guides).toHaveLength(1);
    expect(outcome.guides[0]).toMatchObject({ axis: "y", position: 400, targetId: "b" });
  });

  it("垂直吸附：上边缘差 4px 时吸到邻居上边缘", () => {
    const changes = [positionChange("a", 900, 396)];
    const nodes = [promptNode("a", 900, 100), promptNode("b", 400, 400)];
    const outcome = applySnapToChanges(changes, nodes, true);

    expect(outcome.changes[0]).toMatchObject({ position: { x: 900, y: 400 } });
    expect(outcome.guides[0]).toMatchObject({ axis: "y", position: 400, targetId: "b" });
  });

  it("远离所有邻居时两轴都不动（阈值没被放宽）", () => {
    // a 在 (900,197)，唯一邻居 b 在 (900,400)：x 完全对齐所以 x 会吸（零偏移），
    // 但 y 差 203 远超阈值 → 只该有一条 x 轴 guide，y 保持 197
    const changes = [positionChange("a", 900, 197)];
    const nodes = [promptNode("a", 900, 100), promptNode("b", 900, 400)];
    const outcome = applySnapToChanges(changes, nodes, true);

    expect(outcome.changes[0]).toMatchObject({ position: { x: 900, y: 197 } });
    expect(outcome.guides.map((g) => g.axis)).toEqual(["x"]);
  });

  it("用这一帧的新位置算吸附，而不是 nodes 里的旧位置", () => {
    // nodes 里 a 在 100，但这一帧拖到 397 —— 必须按 397 判定才能吸到 400
    const changes = [positionChange("a", 397, 200)];
    const nodes = [promptNode("a", 100, 200), promptNode("b", 400, 200)];
    const outcome = applySnapToChanges(changes, nodes, true);

    expect(outcome.changes[0]).toMatchObject({ position: { x: 400, y: 200 } });
  });

  it("不修改传入的 changes 数组（历史快照可能复用同一份）", () => {
    const changes = [positionChange("a", 397, 200)];
    const before = JSON.parse(JSON.stringify(changes)) as unknown;
    const nodes = [promptNode("a", 100, 200), promptNode("b", 400, 200)];
    applySnapToChanges(changes, nodes, true);

    expect(changes).toEqual(before);
  });

  it("空 changes 不抛错", () => {
    const outcome = applySnapToChanges([], [promptNode("a", 0, 0)], true);
    expect(outcome.changes).toEqual([]);
    expect(outcome.guides).toEqual([]);
  });
});

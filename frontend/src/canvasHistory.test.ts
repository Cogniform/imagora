import { describe, expect, it } from "vitest";

import { createCanvasHistory } from "./canvasHistory";
import type { WorkflowNode } from "./types";

/** noUncheckedIndexedAccess 守卫：越界即失败，不把断言弱化为可选链 */
function indexed<T>(items: ArrayLike<T>, at: number): T {
  const item = items[at];
  if (item === undefined) throw new Error(`indexed: 长度 ${items.length} 越界下标 ${at}`);
  return item;
}

const state = (id: string) => ({
  nodes: [{ id, type: "group", position: { x: 0, y: 0 }, data: { name: id, imageCount: 0, totalSize: 0 } } as WorkflowNode],
  edges: [],
});

describe("canvas history", () => {
  it("undoes and restores recorded canvas states", () => {
    const history = createCanvasHistory(5);
    history.record(state("a"));
    history.record(state("b"));

    const undone = history.undo(state("c"));
    expect(undone && indexed(undone.nodes, 0).id).toBe("b");
    const restored = history.restore(undone!);
    expect(restored && indexed(restored.nodes, 0).id).toBe("c");
  });

  it("clears restore after recording a new branch and respects the limit", () => {
    const history = createCanvasHistory(2);
    history.record(state("a"));
    history.record(state("b"));
    history.record(state("c"));
    const afterD = history.undo(state("d"));
    expect(afterD && indexed(afterD.nodes, 0).id).toBe("c");
    history.record(state("new"));
    expect(history.canRestore()).toBe(false);
    const afterLatest = history.undo(state("latest"));
    expect(afterLatest && indexed(afterLatest.nodes, 0).id).toBe("new");
    const afterNew = history.undo(state("new"));
    expect(afterNew && indexed(afterNew.nodes, 0).id).toBe("b");
    expect(history.undo(state("b"))).toBeNull();
  });

  it("keeps the redo stack when recording with preserveRedo", () => {
    const history = createCanvasHistory(5);
    history.record(state("a"));
    const undone = history.undo(state("b"));
    expect(undone && indexed(undone.nodes, 0).id).toBe("a");
    history.record(state("auto"), { preserveRedo: true });
    expect(history.canRestore()).toBe(true);
    const restored = history.restore(state("auto"));
    expect(restored && indexed(restored.nodes, 0).id).toBe("b");
  });

  it("treats an explicit preserveRedo false the same as omitting options", () => {
    const history = createCanvasHistory(5);
    history.record(state("a"));
    history.undo(state("b"));
    history.record(state("auto"), { preserveRedo: false });
    expect(history.canRestore()).toBe(false);
  });

  it("keeps undo intact after preserveRedo and clears redo on the next plain record", () => {
    const history = createCanvasHistory(5);
    history.record(state("a"));
    history.record(state("b"));
    history.undo(state("c"));
    history.record(state("auto"), { preserveRedo: true });
    // past 栈未被破坏：继续 undo 仍正常——先弹出 preserveRedo 记录，再回更早状态
    const afterSecondUndo = history.undo(state("auto"));
    expect(afterSecondUndo && indexed(afterSecondUndo.nodes, 0).id).toBe("auto");
    const afterThirdUndo = history.undo(state("a"));
    expect(afterThirdUndo && indexed(afterThirdUndo.nodes, 0).id).toBe("a");
    // 派生重算不清 redo；下一次不带选项的 record 才清空
    expect(history.canRestore()).toBe(true);
    history.record(state("user"));
    expect(history.canRestore()).toBe(false);
  });
});

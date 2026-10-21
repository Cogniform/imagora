import { describe, expect, it } from "vitest";

import type { WorkflowNode } from "./types";
import { buildRecoverySnapshot } from "./recovery";

/** noUncheckedIndexedAccess 守卫：越界即失败，不把断言弱化为可选链 */
function indexed<T>(items: ArrayLike<T>, at: number): T {
  const item = items[at];
  if (item === undefined) throw new Error(`indexed: 长度 ${items.length} 越界下标 ${at}`);
  return item;
}

function runningPrompt(startedAtMs: number): WorkflowNode {
  return {
    id: "p1",
    type: "prompt",
    position: { x: 20, y: 30 },
    data: {
      prompt: "product photo",
      size: "1024x1024",
      quality: "high",
      outputDir: "output",
      status: "running",
      startedAtMs,
      resultCount: 2,
      message: "temporary",
      // 恢复时也必须剥掉：留 true 会让恢复出来的 idle 卡片先显示一次「取消中…」
      cancelRequested: true,
    },
  } as WorkflowNode;
}

describe("recovery snapshots", () => {
  it("removes runtime-only prompt state without mutating canvas nodes", () => {
    const source = runningPrompt(1_700_000_000_000);
    const snapshot = buildRecoverySnapshot([source], []);
    const saved = indexed(snapshot.nodes, 0);

    expect(saved.type === "prompt" && saved.data).toMatchObject({ status: "idle", quality: "high" });
    expect(saved.type === "prompt" && saved.data.startedAtMs).toBeUndefined();
    expect(saved.type === "prompt" && saved.data.resultCount).toBeUndefined();
    expect(saved.type === "prompt" && saved.data.message).toBeUndefined();
    expect(saved.type === "prompt" && saved.data.cancelRequested).toBeUndefined();
    expect(source.type === "prompt" && source.data.status).toBe("running");
  });

  it("produces the same snapshot while only the ticking anchor changes", () => {
    const first = buildRecoverySnapshot([runningPrompt(1_700_000_000_000)], []);
    const second = buildRecoverySnapshot([runningPrompt(1_700_000_000_009)], []);

    expect(second).toEqual(first);
  });
});

describe("recovery snapshot strips animation classes", () => {
  it("strips node animation classes from prompt nodes", () => {
    const source = { ...runningPrompt(1), className: "node-enter enter-delay-2" } as WorkflowNode;
    const snapshot = buildRecoverySnapshot([source], []);
    expect(indexed(snapshot.nodes, 0).className).toBeUndefined();
  });

  it("strips animation classes from image nodes but keeps unrelated classes", () => {
    const image = {
      id: "img1",
      type: "image",
      position: { x: 0, y: 0 },
      className: "node-related node-exiting",
      data: {
        registryId: "r1",
        name: "a.png",
        url: "/api/image?path=a",
        size: 1,
        ext: "png",
        refCount: 0,
        absPath: "C:\\output\\a.png",
      },
    } as WorkflowNode;
    const snapshot = buildRecoverySnapshot([image], []);
    expect(indexed(snapshot.nodes, 0).className).toBe("node-related");
  });
});

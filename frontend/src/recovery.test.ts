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

  it("keeps taskId: it is reattach evidence, not runtime state", () => {
    // 任务活在服务端进程里；画布重挂载后内存映射清空，只有节点 data 里的 taskId
    // 能让我们把还活着的任务重新接上（以及捞回切走期间跑完的结果）。
    const source = {
      ...runningPrompt(1_700_000_000_000),
      data: {
        prompt: "p",
        size: "1024x1024",
        quality: "high",
        outputDir: "",
        status: "running",
        startedAtMs: 1_700_000_000_000,
        taskId: "t_abc123",
      },
    } as WorkflowNode;

    const saved = indexed(buildRecoverySnapshot([source], []).nodes, 0);
    expect(saved.type === "prompt" && saved.data.taskId).toBe("t_abc123");
    // 运行态本身仍然被剥掉（恢复出来的卡片从 idle 起步，随后由认领改成 queued/running）
    expect(saved.type === "prompt" && saved.data.status).toBe("idle");
    expect(saved.type === "prompt" && saved.data.startedAtMs).toBeUndefined();
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

describe("recovery snapshot drops the mask", () => {
  const masked = (): WorkflowNode =>
    ({
      id: "img1",
      type: "image",
      position: { x: 0, y: 0 },
      data: {
        registryId: "r1",
        name: "a.png",
        url: "/api/image?path=a",
        size: 1,
        ext: "png",
        refCount: 0,
        absPath: "C:\\output\\a.png",
        // 原图尺寸的 PNG data URL：几 MB 量级，绝不该进快照
        maskDataUrl: "data:image/png;base64,iVBORw0KGgo=",
      },
    }) as WorkflowNode;

  it("drops maskDataUrl from image nodes", () => {
    const source = masked();
    const saved = indexed(buildRecoverySnapshot([source], []).nodes, 0);

    expect(saved.type === "image" && saved.data.maskDataUrl).toBeUndefined();
    // 其他字段一个不少：蒙版只是「要不要重绘哪一块」的附加信息
    expect(saved.type === "image" && saved.data.registryId).toBe("r1");
    expect(saved.type === "image" && saved.data.url).toBe("/api/image?path=a");
    expect(saved.position).toEqual({ x: 0, y: 0 });
    // 原节点不被改动：画布上那张图的蒙版还得继续生效
    expect(source.type === "image" && source.data.maskDataUrl).toBe("data:image/png;base64,iVBORw0KGgo=");
  });

  it("同一张图放大成十份蒙版也不会撑大快照", () => {
    const nodes = Array.from({ length: 10 }, (_, i) => {
      const node = masked();
      return { ...node, id: `img${i}` } as WorkflowNode;
    });
    const snapshot = buildRecoverySnapshot(nodes, []);
    const text = JSON.stringify(snapshot);
    expect(text).not.toContain("maskDataUrl");
    expect(text.length).toBeLessThan(2_000);
  });
});

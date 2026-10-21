// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cancelTask, checkBudget, fetchTask, submitGenerate, type HttpError } from "./api";
import { useGenerationTask } from "./useGenerationTask";

/** noUncheckedIndexedAccess 守卫：越界即失败，不把断言弱化为可选链 */
function indexed<T>(items: ArrayLike<T>, at: number): T {
  const item = items[at];
  if (item === undefined) throw new Error(`indexed: 长度 ${items.length} 越界下标 ${at}`);
  return item;
}

// 提交走真实 API 会因 jsdom 无 baseURL 失败，这里 mock 掉 submit 的网络层
// isHttpError 用真实实现（纯判别函数，无网络），让 409 分支走生产同款判定
vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    submitGenerate: vi.fn(async () => ({ taskId: "task-1", status: "queued" })),
    cancelTask: vi.fn(async () => undefined),
    fetchTask: vi.fn(async () => ({ taskId: "task-1", status: "queued" })),
    isHttpError: actual.isHttpError,
    checkBudget: vi.fn(async () => ({
      allowed: false, over: true, confirmed: false, reason: "本次预估 0.15 元，超过单次上限 0.10 元",
      estimate: 0.15, spentToday: 0, remaining: 0, settings: { dailyLimit: 0, singleRunLimit: 0.1 },
    })),
  };
});

const PARAMS = {
  prompt: "p", refPaths: [], files: [], size: "1024x1024", quality: "high", outputDir: "out", win: 0,
};

/**
 * 回归测试：useGenerationTask 的稳定成员（submit/cancel/get/subscribe）
 * 在多次渲染间必须保持同一引用。
 *
 * 背景：CanvasPage 的 nodeTypes 依赖链包含 handleRun / handleDeleteNode，
 * 它们依赖 generationTask 的这些成员。若成员每次渲染重建，useCallback
 * 每次重建 → nodeTypes 每次重建 → React Flow 把节点组件当新类型 →
 * 全节点重挂载 → 入场动画反复重播（闪烁）。
 */
describe("useGenerationTask 稳定成员引用（防画布闪烁回归）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("submit/cancel/get/subscribe 多次渲染引用稳定（tasks 无变化）", () => {
    const { result, rerender } = renderHook(() => useGenerationTask());

    const first = result.current;
    act(() => rerender());

    expect(result.current.submit).toBe(first.submit);
    expect(result.current.cancel).toBe(first.cancel);
    expect(result.current.get).toBe(first.get);
    expect(result.current.subscribe).toBe(first.subscribe);
  });

  it("任务状态刷新后（emit）稳定成员仍不重建", async () => {
    const { result, rerender } = renderHook(() => useGenerationTask());

    const before = result.current;
    // submit 触发 emit → setVersion → 重渲染
    await act(async () => {
      await result.current.submit({
        prompt: "p",
        refPaths: [],
        files: [],
        size: "1024x1024",
        quality: "high",
        outputDir: "out",
        win: 0,
      });
    });
    act(() => rerender());

    expect(result.current.tasks).not.toBe(before.tasks); // tasks 数组必然新建（对照）
    expect(result.current.submit).toBe(before.submit);
    expect(result.current.cancel).toBe(before.cancel);
    expect(result.current.get).toBe(before.get);
    expect(result.current.subscribe).toBe(before.subscribe);
  });
});

/**
 * 预算闸门兜底确认：单张提交（经典表单 / 画布节点 / 全部运行）命中服务端 409 时，
 * 用 /api/budget/check 的原因问一次；确认后带 allowOverBudget 重提，
 * 同一窗口会话内只问一次（「全部运行」不连问 N 次）。
 */
describe("useGenerationTask 超预算确认（409 → 确认 → 重提）", () => {
  /** 未确认（未带 allowOverBudget）即抛 409，确认后放行 */
  function budgetGate() {
    return vi.fn(async (params: { allowOverBudget?: boolean; taskId?: string }) => {
      if (!params.allowOverBudget) {
        const error: HttpError = Object.assign(
          new Error("HTTP 409: 本次预估 0.15 元，超过单次上限 0.10 元"),
          { status: 409 },
        );
        throw error;
      }
      return { taskId: "task-after-confirm", status: "queued" as const };
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("确认超预算：带 allowOverBudget 重提并返回新 taskId", async () => {
    vi.mocked(submitGenerate).mockImplementation(budgetGate() as never);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    const { result } = renderHook(() => useGenerationTask());
    let taskId = "";
    await act(async () => {
      taskId = await result.current.submit(PARAMS);
    });

    expect(taskId).toBe("task-after-confirm");
    expect(checkBudget).toHaveBeenCalledWith({ count: 1, size: "1024x1024" });
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(indexed(confirmSpy.mock.calls, 0)[0]).toContain("超过单次上限");
    expect(submitGenerate).toHaveBeenCalledTimes(2);
    expect(indexed(vi.mocked(submitGenerate).mock.calls, 1)[0]).toMatchObject({ allowOverBudget: true });
  });

  it("取消确认：抛出 409 错误且不重提", async () => {
    vi.mocked(submitGenerate).mockImplementation(budgetGate() as never);
    vi.spyOn(window, "confirm").mockReturnValue(false);

    const { result } = renderHook(() => useGenerationTask());
    await act(async () => {
      await expect(result.current.submit(PARAMS)).rejects.toThrow("超过单次上限");
    });

    expect(submitGenerate).toHaveBeenCalledTimes(1);
  });

  it("同一 hook 实例内已确认过：后续 409 直接重提，不再询问", async () => {
    vi.mocked(submitGenerate).mockImplementation(budgetGate() as never);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    const { result } = renderHook(() => useGenerationTask());
    await act(async () => {
      await result.current.submit(PARAMS);
    });
    await act(async () => {
      await result.current.submit({ ...PARAMS, prompt: "第二条" });
    });

    expect(confirmSpy).toHaveBeenCalledTimes(1); // 只问一次
    expect(submitGenerate).toHaveBeenCalledTimes(4); // 两条各"409 + 重提"
  });

  it("非 409 错误直接抛出，不触发确认", async () => {
    vi.mocked(submitGenerate).mockRejectedValue(new Error("HTTP 500: 上游炸了"));
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    const { result } = renderHook(() => useGenerationTask());
    await act(async () => {
      await expect(result.current.submit(PARAMS)).rejects.toThrow("上游炸了");
    });

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(checkBudget).not.toHaveBeenCalled();
  });
});

/**
 * 回归测试（复核 D1）：点过取消之后，「取消中…」不能被旧快照冲掉。
 *
 * 背景：秒数推送（每秒）与起飞中的轮询拿的都是「点取消之前」那一份快照，
 * 它们把 cancelRequested 写成 false 时，卡片会从「取消中…」退回可点的「取消」，
 * 与「取消期间禁用防重复点」的约定相反。本机意图必须在终态之前一直压得住旧快照。
 */
describe("useGenerationTask 取消意图不被旧快照冲掉", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 前面的用例用 mockRejectedValue 改过提交实现，clearAllMocks 不会还原它，这里显式复位
    vi.mocked(submitGenerate).mockResolvedValue({ taskId: "task-1", status: "queued" } as never);
    vi.mocked(cancelTask).mockResolvedValue({ ok: true });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("running 期间点取消：计时推送与后续轮询都保持 cancelRequested，终态才清", async () => {
    // 服务端快照永远不带 cancelRequested（模拟「取件前 / 尚未认下取消」的旧状态）
    vi.mocked(fetchTask).mockResolvedValue({
      taskId: "task-1",
      status: "running",
      startedAt: Date.now(),
    } as never);

    const { result } = renderHook(() => useGenerationTask());
    const seen: Array<{ status: string; cancelRequested: boolean | undefined }> = [];
    act(() => {
      result.current.subscribe((_taskId, view) =>
        seen.push({ status: view.status, cancelRequested: view.cancelRequested }),
      );
    });

    await act(async () => {
      await result.current.submit(PARAMS);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000); // 第一轮轮询 → running
    });
    await act(async () => {
      await result.current.cancel("task-1");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000); // 计时推送 ×3 + 一轮轮询，全是旧快照
    });

    const firstCancel = seen.findIndex((view) => view.cancelRequested === true);
    expect(firstCancel).toBeGreaterThanOrEqual(0);
    // 从点取消那一刻起，所有 running 视图都必须带取消意图（一次回退都不许有）
    expect(seen.slice(firstCancel).filter((v) => v.status === "running" && v.cancelRequested !== true))
      .toEqual([]);

    // 走到终态才清：清早了 = 永久禁用，清不掉 = 「取消中…」永不退出
    vi.mocked(fetchTask).mockResolvedValue({ taskId: "task-1", status: "cancelled" } as never);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    const last = indexed(seen, seen.length - 1);
    expect(last.status).toBe("cancelled");
    expect(last.cancelRequested).not.toBe(true);
  });

  it("任务已终态时点取消：不改写视图，也不留残留意图", async () => {
    vi.mocked(fetchTask).mockResolvedValue({ taskId: "task-1", status: "done" } as never);
    const { result } = renderHook(() => useGenerationTask());
    await act(async () => {
      await result.current.submit(PARAMS);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000); // → done（轮询停止）
    });

    await act(async () => {
      await result.current.cancel("task-1");
    });

    expect(result.current.get("task-1")?.cancelRequested).not.toBe(true);
  });
});

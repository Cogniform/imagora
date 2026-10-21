/**
 * `snapGuidesStore` 的订阅语义。
 *
 * 钉的是「通知时机」而不是实现细节：多通知一次，拖拽时就多一帧渲染；少通知一次，
 * 对齐线就停在上一帧的位置。四个必测点：同值不通知、变化只通知一次、多订阅者都收到、
 * 退订后不再收到。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getSnapGuides, setSnapGuides, subscribe } from "./snapGuidesStore";
import type { SnapGuide } from "./snapGuide";

/** noUncheckedIndexedAccess 下取数组元素：越界直接失败，不把断言弱化成可选链 */
function guide(axis: "x" | "y", position: number, targetId = "node-a"): SnapGuide {
  return { axis, position, targetId };
}

const offs: Array<() => void> = [];

/** 订阅一个 spy；退订函数同时登记，afterEach 兜底（模块级 store 的监听器跨用例存活） */
function listen() {
  const listener = vi.fn();
  const off = subscribe(listener);
  offs.push(off);
  return { listener, off };
}

beforeEach(() => {
  setSnapGuides([]);
});

afterEach(() => {
  while (offs.length > 0) offs.pop()?.();
  setSnapGuides([]);
});

describe("snapGuidesStore", () => {
  it("初始为空数组", () => {
    expect(getSnapGuides()).toEqual([]);
  });

  it("写入后能读回，且内容是同一引用（snapshot 必须稳定）", () => {
    const guides = [guide("x", 120)];
    setSnapGuides(guides);
    expect(getSnapGuides()).toBe(guides);
  });

  it("同一个数组重复写入不通知", () => {
    const { listener } = listen();
    const guides = [guide("x", 120)];
    setSnapGuides(guides);
    setSnapGuides(guides);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("内容相同但每次新建数组也不通知（拖拽时每帧都是新数组）", () => {
    const { listener } = listen();
    setSnapGuides([guide("x", 120, "node-b"), guide("y", 40, "node-c")]);
    setSnapGuides([guide("x", 120, "node-b"), guide("y", 40, "node-c")]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("轴、坐标、targetId 任一变化都要通知", () => {
    const { listener } = listen();
    setSnapGuides([guide("x", 120, "node-b")]);
    setSnapGuides([guide("y", 120, "node-b")]);
    setSnapGuides([guide("y", 121, "node-b")]);
    setSnapGuides([guide("y", 121, "node-c")]);
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it("内容变化只通知一次", () => {
    const { listener } = listen();
    setSnapGuides([guide("x", 200)]);
    setSnapGuides([guide("x", 320)]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("多订阅者都收到，且回调里读到的已是新值", () => {
    const first = listen();
    const second = listen();
    setSnapGuides([guide("y", 88, "node-z")]);
    expect(first.listener).toHaveBeenCalledTimes(1);
    expect(second.listener).toHaveBeenCalledTimes(1);
    expect(getSnapGuides()).toEqual([guide("y", 88, "node-z")]);
  });

  it("退订后不再收到，其他订阅者不受影响", () => {
    const first = listen();
    const second = listen();
    first.off();
    setSnapGuides([guide("x", 10)]);
    expect(first.listener).toHaveBeenCalledTimes(0);
    expect(second.listener).toHaveBeenCalledTimes(1);
  });

  it("从非空清空会通知；空到空不通知", () => {
    const { listener } = listen();
    setSnapGuides([guide("x", 10)]);
    setSnapGuides([]);
    setSnapGuides([]);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(getSnapGuides()).toEqual([]);
  });
});

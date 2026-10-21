// @vitest-environment jsdom

/**
 * `SnapGuides` 的 DOM 契约与订阅隔离。
 *
 * DOM 部分逐值对齐改动前 CanvasPage 里的内联写法（class / data-axis / data-testid /
 * 四条 style）：E2E 依赖「拖拽过程中出现过对齐线、松手后清空」，这里不能再换一套结构。
 *
 * 隔离部分是本轮性能改动的核心断言：store 变化只让订阅的组件重渲染，渲染它的父组件
 * 一次都不重渲染 —— CanvasPage 就是那个父组件。
 */

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const h = vi.hoisted(() => ({ portal: vi.fn() }));

vi.mock("@xyflow/react", async () => {
  const React = await import("react");
  function ViewportPortal({ children }: { children?: ReactNode }) {
    h.portal(children);
    return React.createElement(React.Fragment, null, children);
  }
  return { ViewportPortal };
});

import { SnapGuides } from "./SnapGuides";
import { setSnapGuides } from "../snapGuidesStore";
import type { SnapGuide } from "../snapGuide";

function guide(axis: "x" | "y", position: number, targetId = "node-a"): SnapGuide {
  return { axis, position, targetId };
}

beforeEach(() => {
  h.portal.mockClear();
  setSnapGuides([]);
});

afterEach(() => {
  cleanup();
  setSnapGuides([]);
});

describe("SnapGuides DOM 契约", () => {
  it("没有对齐线时什么都不画", () => {
    render(<SnapGuides />);
    expect(screen.queryAllByTestId("snap-guide")).toHaveLength(0);
  });

  it("axis=x 画竖线，class / data 属性 / style 与旧实现逐值一致", () => {
    setSnapGuides([guide("x", 320, "node-b")]);
    render(<SnapGuides />);
    const lines = screen.getAllByTestId("snap-guide");
    expect(lines).toHaveLength(1);
    const line = lines[0];
    if (!line) throw new Error("没有渲染出对齐线");
    expect(line.className).toBe("snap-guide");
    expect(line.getAttribute("data-axis")).toBe("x");
    expect(line.style.left).toBe("320px");
    expect(line.style.top).toBe("-10000px");
    expect(line.style.width).toBe("1px");
    expect(line.style.height).toBe("20000px");
  });

  it("axis=y 画横线，style 与旧实现逐值一致", () => {
    setSnapGuides([guide("y", 44, "node-c")]);
    render(<SnapGuides />);
    const line = screen.getByTestId("snap-guide");
    expect(line.getAttribute("data-axis")).toBe("y");
    expect(line.style.left).toBe("-10000px");
    expect(line.style.top).toBe("44px");
    expect(line.style.width).toBe("20000px");
    expect(line.style.height).toBe("1px");
  });

  it("每个轴各一条时可同时画出两条", () => {
    setSnapGuides([guide("x", 320, "node-b"), guide("y", 44, "node-c")]);
    render(<SnapGuides />);
    const axes = screen.getAllByTestId("snap-guide").map((line) => line.getAttribute("data-axis"));
    expect(axes).toEqual(["x", "y"]);
  });

  it("store 清空后对齐线消失（松手清线的 DOM 出口）", () => {
    setSnapGuides([guide("x", 320)]);
    render(<SnapGuides />);
    expect(screen.getAllByTestId("snap-guide")).toHaveLength(1);
    act(() => setSnapGuides([]));
    expect(screen.queryAllByTestId("snap-guide")).toHaveLength(0);
  });
});

describe("订阅隔离", () => {
  it("store 变化只重渲染订阅组件，父组件不重渲染", () => {
    const parentRender = vi.fn();
    function Parent({ onRender }: { onRender: () => void }) {
      onRender();
      return <SnapGuides />;
    }

    render(<Parent onRender={parentRender} />);
    expect(parentRender).toHaveBeenCalledTimes(1);

    act(() => setSnapGuides([guide("x", 500)]));
    expect(parentRender).toHaveBeenCalledTimes(1);
    expect(screen.getAllByTestId("snap-guide")).toHaveLength(1);

    act(() => setSnapGuides([]));
    expect(parentRender).toHaveBeenCalledTimes(1);
    expect(screen.queryAllByTestId("snap-guide")).toHaveLength(0);
  });

  it("内容没变的重复写入不触发重渲染（按值去重）", () => {
    render(<SnapGuides />);
    act(() => setSnapGuides([guide("x", 500)]));
    const renders = h.portal.mock.calls.length;
    act(() => setSnapGuides([guide("x", 500)]));
    expect(h.portal.mock.calls.length).toBe(renders);
  });
});

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CanvasBoundary, ErrorBoundary, NodeBoundary } from "./ErrorBoundary";

/** 每个用例后卸载：否则前一个用例的替代界面还挂在 DOM 里，
 *  `getByText("重试")` 会撞上多个元素（实测直接红四条）。 */
afterEach(cleanup);

/** 一个 render 里必定抛错的子树：边界只在这种时候才换成替代界面。
 *  返回类型必须显式写成 `ReactElement`：只抛错的函数会被推断成 `never`，
 *  而 `never` 不是合法的 JSX 元素类型（TS2786）。 */
function Boom({ message = "炸了" }: { message?: string }): ReactElement {
  throw new Error(message);
}

/** 可开关的子树：用来验「重试」确实能重新渲染出正常内容 */
let shouldThrow = true;
function MaybeBoom() {
  if (shouldThrow) throw new Error("炸了");
  return <div>恢复正常了</div>;
}

describe("ErrorBoundary", () => {
  it("正常时原样渲染子树，不额外包一层 DOM", () => {
    const { container } = render(
      <ErrorBoundary fallback={() => <div>不该出现</div>}>
        <div>正常内容</div>
      </ErrorBoundary>,
    );

    // 多包一层 DOM 会让 React Flow 的节点定位与选择框算歪，所以这条要钉住
    expect(container.firstElementChild?.tagName).toBe("DIV");
    expect(container.firstElementChild?.textContent).toBe("正常内容");
  });

  it("子树抛错时渲染替代界面，并回调 onError", () => {
    const onError = vi.fn();
    // React 会把边界捕获的错误再打一遍到 console.error，测试里静音掉
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <ErrorBoundary onError={onError} fallback={(error) => <div>出错：{error.message}</div>}>
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByText("出错：炸了")).toBeTruthy();
    expect(onError).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe("NodeBoundary", () => {
  it("单张卡抛错时只换成「这张卡出错了」，并给出重试", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <NodeBoundary nodeId="p1">
        <Boom message="卡片数据异常" />
      </NodeBoundary>,
    );

    expect(screen.getByText("这张卡出错了")).toBeTruthy();
    expect(screen.getByText(/卡片数据异常/)).toBeTruthy();
    expect(screen.getByText("重试")).toBeTruthy();
    spy.mockRestore();
  });

  it("长错误消息被截断成一行（不把卡片撑爆）", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const long = `${"很长".repeat(200)}结尾`;

    render(
      <NodeBoundary>
        <Boom message={long} />
      </NodeBoundary>,
    );

    const shown = screen.getByText(/很长/).textContent ?? "";
    expect(shown.length).toBeLessThanOrEqual(141);
    expect(shown.endsWith("…")).toBe(true);
    spy.mockRestore();
  });

  it("点重试会重新渲染：错误消失后恢复正常内容", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    shouldThrow = true;

    render(
      <NodeBoundary>
        <MaybeBoom />
      </NodeBoundary>,
    );
    expect(screen.getByText("这张卡出错了")).toBeTruthy();

    // 修好数据之后再点重试 —— 这条验的是「重试不是摆设」
    shouldThrow = false;
    fireEvent.click(screen.getByText("重试"));

    expect(screen.getByText("恢复正常了")).toBeTruthy();
    spy.mockRestore();
  });
});

describe("CanvasBoundary", () => {
  it("整体崩溃时给「画布渲染出错」与两个出路，并通知宿主", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onCrash = vi.fn();

    render(
      <CanvasBoundary onCrash={onCrash} onClear={() => {}}>
        <Boom message="画布崩了" />
      </CanvasBoundary>,
    );

    expect(screen.getByText("画布渲染出错")).toBeTruthy();
    expect(screen.getByText(/画布崩了/)).toBeTruthy();
    expect(screen.getByText("重试")).toBeTruthy();
    expect(screen.getByText("清空画布")).toBeTruthy();
    // 崩溃必须通知宿主：它据此停掉自动快照，否则坏状态会被写回磁盘
    expect(onCrash).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("点「清空画布」先清空再重置边界", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onClear = vi.fn();

    render(
      <CanvasBoundary onClear={onClear}>
        <Boom />
      </CanvasBoundary>,
    );
    fireEvent.click(screen.getByText("清空画布"));

    expect(onClear).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("提示里写清工作流文件没丢（白屏最怕用户以为数据没了）", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <CanvasBoundary onClear={() => {}}>
        <Boom />
      </CanvasBoundary>,
    );

    expect(screen.getByText(/工作流文件还在磁盘上/)).toBeTruthy();
    spy.mockRestore();
  });
});

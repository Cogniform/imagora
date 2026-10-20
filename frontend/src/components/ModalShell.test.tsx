// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resetPopupCount } from "../popupLayer";
import { ModalShell } from "./ModalShell";
import { Select } from "./Select";

describe("ModalShell", () => {
  afterEach(() => {
    cleanup();
    resetPopupCount(); // 浮层计数是模块级状态，用例之间必须清，否则互相污染
    vi.useRealTimers();
  });

  it("弹窗里有展开的下拉时，Esc 先收下拉而不是关掉弹窗", () => {
    // 回归：ModalShell 的 Esc 挂在 document 的 **capture** 阶段，比 Select 自己的
    // onKeyDown 先跑。不判浮层的话，按一下 Esc 会把正在填的弹窗一起关掉。
    const onClose = vi.fn();
    render(
      <ModalShell title="测试弹窗" onClose={onClose}>
        <Select
          options={[
            { value: "a", label: "选项 A" },
            { value: "b", label: "选项 B" },
          ]}
          value="a"
          onChange={vi.fn()}
        />
      </ModalShell>,
    );

    fireEvent.click(screen.getByRole("button", { name: /选项 A/ }));
    expect(screen.getByRole("listbox")).toBeTruthy();

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "测试弹窗" })).toBeTruthy();

    // 下拉收起后再按一次，才轮到弹窗关闭
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("提供 dialog 语义，并区分面板点击与遮罩点击", () => {
    const onClose = vi.fn();
    render(
      <ModalShell title="测试弹窗" onClose={onClose}>
        <button type="button">内容按钮</button>
      </ModalShell>,
    );

    const dialog = screen.getByRole("dialog", { name: "测试弹窗" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    fireEvent.mouseDown(dialog);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.querySelector("[data-modal-overlay]") as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("打开时进入弹窗，Esc 关闭，卸载后归还焦点", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    const view = render(
      <ModalShell title="焦点弹窗" onClose={onClose}>
        <button type="button">首个按钮</button>
      </ModalShell>,
    );

    expect(screen.getByRole("button", { name: "首个按钮" })).toBe(document.activeElement);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    view.unmount();
    vi.runAllTimers();
    expect(trigger).toBe(document.activeElement);
    trigger.remove();
  });

  it("Tab 与 Shift+Tab 在弹窗内循环", () => {
    render(
      <ModalShell title="循环焦点" onClose={vi.fn()}>
        <button type="button">第一项</button>
        <button type="button">最后一项</button>
      </ModalShell>,
    );
    const first = screen.getByRole("button", { name: "第一项" });
    const last = screen.getByRole("button", { name: "最后一项" });
    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(first).toBe(document.activeElement);
    first.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(last).toBe(document.activeElement);
  });

  it("嵌套弹窗打开时，Esc 只交给顶层", () => {
    const closeOuter = vi.fn();
    const closeInner = vi.fn();
    render(
      <ModalShell title="外层" onClose={closeOuter}>
        <ModalShell title="内层" onClose={closeInner} nested>
          <button type="button">确认</button>
        </ModalShell>
      </ModalShell>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(closeInner).toHaveBeenCalledTimes(1);
    expect(closeOuter).not.toHaveBeenCalled();
  });
});

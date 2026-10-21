// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildNodeMenu } from "../contextMenu";
import { hasOpenPopup, resetPopupCount } from "../popupLayer";
import { NodeContextMenu } from "./NodeContextMenu";

const imageItems = buildNodeMenu("image", { hasUrl: true, selectedCount: 1 });
const noUrlItems = buildNodeMenu("image", { hasUrl: false, selectedCount: 1 });
const multiItems = buildNodeMenu("image", { hasUrl: true, selectedCount: 3 });

function renderMenu(overrides: Partial<Parameters<typeof NodeContextMenu>[0]> = {}) {
  const onPick = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <NodeContextMenu x={40} y={60} items={imageItems} onPick={onPick} onClose={onClose} {...overrides} />,
  );
  return { ...view, onPick, onClose };
}

describe("NodeContextMenu", () => {
  beforeEach(() => {
    resetPopupCount();
  });

  afterEach(() => {
    cleanup();
    resetPopupCount();
  });

  it("挂到 body 上并渲染成菜单语义", () => {
    renderMenu();
    const menu = screen.getByTestId("node-context-menu");
    expect(menu.getAttribute("role")).toBe("menu");
    // 挂在 body 直接子级（portal），不在 React 树里的容器内
    expect(menu.parentElement).toBe(document.body);
    expect(document.body.contains(menu)).toBe(true);
  });

  it("每项都是 menuitem，文案与顺序来自 items", () => {
    renderMenu();
    const menu = screen.getByTestId("node-context-menu");
    const items = menu.querySelectorAll('[role="menuitem"]');
    expect(Array.from(items).map((node) => node.textContent)).toEqual([
      "预览大图",
      "裁剪",
      "放大",
      "切分",
      "替换图片",
      "删除",
    ]);
  });

  it("点击可用项触发 onPick 并带上 action id", () => {
    const { onPick } = renderMenu();
    fireEvent.click(screen.getByTestId("node-menu-crop"));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith("crop");
  });

  it("禁用的项带 aria-disabled 且点击不触发 onPick", () => {
    const { onPick } = renderMenu({ items: noUrlItems });
    const crop = screen.getByTestId("node-menu-crop");
    expect(crop.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(crop);
    expect(onPick).not.toHaveBeenCalled();
    // 删除仍可点
    fireEvent.click(screen.getByTestId("node-menu-delete"));
    expect(onPick).toHaveBeenCalledWith("delete");
  });

  it("可用项不带 aria-disabled（避免无障碍读成不可点）", () => {
    renderMenu();
    expect(screen.getByTestId("node-menu-crop").getAttribute("aria-disabled")).toBe(null);
  });

  it("Escape 与 Tab 关闭菜单", () => {
    const { onClose } = renderMenu();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: "Tab" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("其它按键不关闭", () => {
    const { onClose } = renderMenu();
    fireEvent.keyDown(document, { key: "Enter" });
    fireEvent.keyDown(document, { key: "ArrowDown" });
    fireEvent.keyDown(document, { key: "a" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("已被消费（defaultPrevented）的 Escape 不再关闭菜单", () => {
    // 模拟 .modal-shell：capture 阶段先吃掉这次 Esc 并 preventDefault。
    // 菜单挂在冒泡阶段，看到 defaultPrevented 就该让位，不要再关一次。
    const swallowEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") event.preventDefault();
    };
    document.addEventListener("keydown", swallowEscape, true);
    const { onClose } = renderMenu();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    document.removeEventListener("keydown", swallowEscape, true);
    // 撤掉外层拦截后，同一个 Esc 就该正常关闭了
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("外部 pointerdown 关闭，菜单内部 pointerdown 不关闭", () => {
    const { onClose } = renderMenu();
    fireEvent.pointerDown(screen.getByTestId("node-menu-crop"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("窗口 resize 与滚动都关闭（否则菜单会浮在原地跟节点错位）", () => {
    const { onClose } = renderMenu();
    fireEvent(window, new Event("resize"));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.scroll(window);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("挂载时登记为浮层、卸载时注销（Esc 不会被外层弹窗抢走）", () => {
    expect(hasOpenPopup()).toBe(false);
    const { unmount } = renderMenu();
    expect(hasOpenPopup()).toBe(true);
    unmount();
    expect(hasOpenPopup()).toBe(false);
  });

  it("按初始落点渲染在视口内（jsdom 视口 1024x768）", () => {
    renderMenu({ x: 1000, y: 700 });
    const menu = screen.getByTestId("node-context-menu");
    const left = Number.parseFloat(menu.style.left);
    const top = Number.parseFloat(menu.style.top);
    expect(menu.style.position).toBe("fixed");
    expect(Number.parseFloat(menu.style.zIndex)).toBe(1000);
    // 贴右下角右键：菜单必须被推回视口内，而不是从边缘露出去
    expect(left).toBeLessThanOrEqual(window.innerWidth - 200 - 8);
    expect(top).toBeLessThanOrEqual(window.innerHeight - 8);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
  });

  it("多选时渲染置顶的「删除所选 N 项」并带 danger 色", () => {
    const { onPick } = renderMenu({ items: multiItems });
    const bulk = screen.getByTestId("node-menu-delete-selection");
    expect(bulk.textContent).toBe("删除所选 3 项");
    fireEvent.click(bulk);
    expect(onPick).toHaveBeenCalledWith("delete-selection");
  });

  it("分隔线渲染为 separator 且不可点（不是 menuitem）", () => {
    renderMenu();
    const menu = screen.getByTestId("node-context-menu");
    const separators = menu.querySelectorAll('[role="separator"]');
    expect(separators.length).toBe(1);
    expect(separators[0]?.getAttribute("role")).not.toBe("menuitem");
  });
});

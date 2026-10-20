// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Select } from "./Select";

const options = [
  { value: "a", label: "选项 A" },
  { value: "b", label: "选项 B" },
  { value: "c", label: "选项 C" },
];

describe("Select", () => {
  afterEach(cleanup);

  it("展示当前值并用鼠标选择", () => {
    const onChange = vi.fn();
    render(<Select options={options} value="a" onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: /选项 A/ });
    fireEvent.click(trigger);
    fireEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: "选项 B" }));
    expect(onChange).toHaveBeenCalledWith("b");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("方向键移动活动项，Enter 选择并归还焦点", () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    render(<Select options={options} value="a" onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: /选项 A/ });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(trigger.getAttribute("aria-activedescendant")).toContain("option-1");
    fireEvent.keyDown(trigger, { key: "Enter" });
    vi.runAllTimers();
    expect(onChange).toHaveBeenCalledWith("b");
    expect(trigger).toBe(document.activeElement);
    vi.useRealTimers();
  });

  it("Home 和 End 跳转首尾，Escape 不改变值", () => {
    const onChange = vi.fn();
    render(<Select options={options} value="b" onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: /选项 B/ });
    fireEvent.keyDown(trigger, { key: "End" });
    expect(trigger.getAttribute("aria-activedescendant")).toContain("option-2");
    fireEvent.keyDown(trigger, { key: "Home" });
    expect(trigger.getAttribute("aria-activedescendant")).toContain("option-0");
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("Tab 与外部点击关闭列表", () => {
    render(<Select options={options} value="a" onChange={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: /选项 A/ });
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: "Tab" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    fireEvent.mouseDown(document.body);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("暴露 option 选中语义，并容忍空选项和未知值", () => {
    const { rerender } = render(<Select options={options} value="b" onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /选项 B/ }));
    expect(screen.getByRole("option", { name: "选项 B" }).getAttribute("aria-selected")).toBe("true");
    rerender(<Select options={[]} value="missing" onChange={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: /请选择/ });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("展开列表挂到 body（不被滚动容器的 overflow 裁掉）", () => {
    // 回归：列表曾就地 absolute 定位，被弹窗的 overflow:hidden / overflow-y:auto 裁掉，
    // 表现为「下拉展开后底部几项看不见」。挂到 body 后不受任何祖先裁切。
    render(
      <div style={{ overflow: "hidden" }}>
        <Select options={options} value="a" onChange={vi.fn()} />
      </div>,
    );
    const trigger = screen.getByRole("button", { name: /选项 A/ });
    // 关闭时不渲染列表（避免撑高外层容器）
    expect(screen.queryByRole("listbox")).toBeNull();

    fireEvent.click(trigger);
    const listbox = screen.getByRole("listbox");
    // 关键：整棵浮层（含定位容器）必须挂在 body 下，不在任何裁切祖先里
    const portalRoot = document.body.querySelector('[data-portal="select-list"]');
    expect(portalRoot).not.toBeNull();
    expect(portalRoot?.parentElement).toBe(document.body);
    expect(listbox.closest('[data-portal="select-list"]')).toBe(portalRoot);
    expect(portalRoot?.className).toContain("fixed");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    // 挂在 body 后，点列表本身不能被判为「外部点击」而误关
    fireEvent.mouseDown(listbox);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    // 点真正的外部才关
    fireEvent.mouseDown(document.body);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("searchable：展开即聚焦搜索框，输入走模糊排序而不是 substring", () => {
    // 回归：模型 ID 动辄 `gpt-image-2.5-flare`，用户打 `flare` 或 `gi25` 都要命中。
    // 用 substring 过滤时 `gi25` 一个都匹配不上 —— 这正是「上游 7 个模型只显示 2 个」的同源问题。
    const models = [
      { value: "gpt-image-2", label: "gpt-image-2" },
      { value: "gpt-image-2.5", label: "gpt-image-2.5" },
      { value: "gpt-image-2.5-flare", label: "gpt-image-2.5-flare" },
      { value: "dall-e-3", label: "dall-e-3" },
    ];
    render(<Select options={models} value="gpt-image-2" onChange={vi.fn()} searchable />);
    fireEvent.click(screen.getByRole("button", { name: /gpt-image-2/ }));

    const search = screen.getByLabelText("筛选选项");
    expect(document.activeElement).toBe(search);

    // 有序子序列：g → i → 2 → 5 命中 gpt-image-2.5 系列，dall-e-3 不命中
    fireEvent.change(search, { target: { value: "gi25" } });
    const names = screen.getAllByRole("option").map((el) => el.textContent);
    expect(names).toEqual(["gpt-image-2.5", "gpt-image-2.5-flare"]);

    // 前缀命中排最前：打 flare 时 gpt-image-2.5-flare 在前
    fireEvent.change(search, { target: { value: "flare" } });
    expect(screen.getAllByRole("option")[0]?.textContent).toBe("gpt-image-2.5-flare");
  });

  it("searchable：无匹配时显示空态文案，且方向键不会落到不存在的项", () => {
    render(<Select options={options} value="a" onChange={vi.fn()} searchable emptyLabel="没有这个模型" />);
    const trigger = screen.getByRole("button", { name: /选项 A/ });
    fireEvent.click(trigger);
    const search = screen.getByLabelText("筛选选项");
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("没有这个模型")).toBeTruthy();
    // 空结果下按方向键不能崩、也不能选中任何东西
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(screen.getByRole("button", { name: /选项 A/ }).getAttribute("aria-expanded")).toBe("true");
  });

  it("分组：渲染组标题，键盘上下键跨组连续（标题不参与导航）", () => {
    const grouped = [
      { value: "volc-a", label: "volc-a", group: { id: "volc", label: "出厂来源" } },
      { value: "volc-b", label: "volc-b", group: { id: "volc", label: "出厂来源" } },
      { value: "api-a", label: "api-a", group: { id: "local", label: "本机来源" } },
    ];
    render(<Select options={grouped} value="volc-a" onChange={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: /volc-a/ });
    fireEvent.click(trigger);

    expect(screen.getByText("出厂来源")).toBeTruthy();
    expect(screen.getByText("本机来源")).toBeTruthy();
    // 组标题不是 option —— 它不该被读屏当成可选项
    expect(screen.getAllByRole("option")).toHaveLength(3);

    // 从 volc-b（下标 1）再按一下，跨到 api-a（下标 2），不会卡在标题上
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(trigger.getAttribute("aria-activedescendant")).toContain("option-1");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(trigger.getAttribute("aria-activedescendant")).toContain("option-2");
  });

  it("无分组时不出组标题（全部归入空标题的兜底组）", () => {
    render(<Select options={options} value="a" onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /选项 A/ }));
    // 三个选项同组、组标题为空串 → 一个 .select-group__title 都不该渲染
    expect(document.querySelectorAll(".select-group__title")).toHaveLength(0);
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });
});

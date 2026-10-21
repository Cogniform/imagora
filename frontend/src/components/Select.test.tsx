// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mergeCustomOption } from "../customValue";
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

  it("searchable 缺省：选项数不超阈值（3 项）时不出搜索框", () => {
    // 同一套控件契约：经典表单里的尺寸下拉只有 3~5 项，不该出现搜索框。
    render(<Select options={options} value="a" onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /选项 A/ }));
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(screen.queryByLabelText("筛选选项")).toBeNull();
  });

  it("searchable 缺省：选项数超阈值（5 项）时出搜索框且焦点落在搜索框", () => {
    // 画布节点里的尺寸下拉有十几项，展开就该能直接打字 —— 与上面的 3 项形成对照。
    const many = [
      { value: "s1", label: "尺寸 1" },
      { value: "s2", label: "尺寸 2" },
      { value: "s3", label: "尺寸 3" },
      { value: "s4", label: "尺寸 4" },
      { value: "s5", label: "尺寸 5" },
    ];
    render(<Select options={many} value="s1" onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /尺寸 1/ }));
    const search = screen.getByLabelText("筛选选项");
    // 焦点必须真的落进搜索框：历史缺陷是 rect 未算出的首帧聚焦失败后永不重试
    expect(document.activeElement).toBe(search);
    expect(screen.getAllByRole("option")).toHaveLength(many.length);
  });

  it("searchable={false}：5 项也强制不出搜索框", () => {
    const many = [
      { value: "s1", label: "尺寸 1" },
      { value: "s2", label: "尺寸 2" },
      { value: "s3", label: "尺寸 3" },
      { value: "s4", label: "尺寸 4" },
      { value: "s5", label: "尺寸 5" },
    ];
    render(<Select options={many} value="s1" onChange={vi.fn()} searchable={false} />);
    fireEvent.click(screen.getByRole("button", { name: /尺寸 1/ }));
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(screen.queryByLabelText("筛选选项")).toBeNull();
  });

  it("searchable（true）：3 项也强制出搜索框（向后兼容显式开启）", () => {
    render(<Select options={options} value="a" onChange={vi.fn()} searchable />);
    fireEvent.click(screen.getByRole("button", { name: /选项 A/ }));
    expect(screen.getByLabelText("筛选选项")).toBeTruthy();
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

  it("renderOption：每个选项里出现自定义节点，且选项文字仍在", () => {
    render(
      <Select
        options={options}
        value="a"
        onChange={vi.fn()}
        renderOption={(option) => <span data-testid="opt-icon">{option.value}</span>}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /选项 A/ }));

    // 列表里每行一个自定义节点
    const listbox = screen.getByRole("listbox");
    const optionIcons = within(listbox).getAllByTestId("opt-icon");
    expect(optionIcons).toHaveLength(options.length);
    expect(optionIcons.map((el) => el.textContent)).toEqual(["a", "b", "c"]);
    // 自定义节点插在文字前面，不顶掉文字本身（否则读屏与既有断言都会失配）
    const first = screen.getAllByRole("option")[0];
    expect(first?.textContent).toBe("a选项 A");
  });

  it("renderOption：收起状态的触发器也带图标（不用展开就能看出当前项）", () => {
    // 替身与真实用法一致：AspectIcon 这类装饰性图标是 aria-hidden 且无文本，
    // 所以不会污染触发器的可访问名。renderOption 若返回带文字的内容，名字会被拼上
    // —— 那是调用方的责任，组件不为它做特殊处理。
    render(
      <Select
        options={options}
        value="b"
        onChange={vi.fn()}
        renderOption={() => <span data-testid="opt-icon" aria-hidden="true" />}
      />,
    );
    // 未展开：只有触发器那一个图标
    expect(screen.getAllByTestId("opt-icon")).toHaveLength(1);
    // 触发器可访问名仍以文字为准
    expect(screen.getByRole("button", { name: "选项 B" })).toBeTruthy();
  });

  it("不传 renderOption 时没有自定义节点（纯文字，行为不变）", () => {
    render(<Select options={options} value="a" onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /选项 A/ }));
    expect(screen.queryAllByTestId("opt-icon")).toHaveLength(0);
    expect(screen.getAllByRole("option").map((el) => el.textContent)).toEqual(["选项 A", "选项 B", "选项 C"]);
  });
});

describe("Select 自由输入（allowCustom）", () => {
  afterEach(cleanup);

  const sizes = [
    { value: "1024x1024", label: "1024x1024" },
    { value: "1792x1024", label: "1792x1024" },
  ];

  it("输入清单外的值按 Enter：回调收到归一化值，列表关闭", () => {
    const onCreateCustom = vi.fn();
    const onChange = vi.fn();
    render(
      <Select options={sizes} value="1024x1024" onChange={onChange} searchable allowCustom onCreateCustom={onCreateCustom} />,
    );
    const trigger = screen.getByRole("button", { name: /1024x1024/ });
    fireEvent.click(trigger);
    const search = screen.getByLabelText("筛选选项");
    // 首尾空白被归一化掉：提交的是 1280x720，不是用户原样打的空格串
    fireEvent.change(search, { target: { value: "  1280x720  " } });
    fireEvent.keyDown(search, { key: "Enter" });

    expect(onCreateCustom).toHaveBeenCalledWith("1280x720");
    // 自由输入不走 onChange：新值由调用方落库后通过 value 回来
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("列表末尾出现「使用 “…”」按钮，点它等同回车创建", () => {
    const onCreateCustom = vi.fn();
    render(
      <Select options={sizes} value="1024x1024" onChange={vi.fn()} searchable allowCustom onCreateCustom={onCreateCustom} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /1024x1024/ }));
    const search = screen.getByLabelText("筛选选项");
    fireEvent.change(search, { target: { value: "1280x720" } });

    const custom = screen.getByTestId("select-custom-option");
    expect(custom.textContent).toBe("使用 “1280x720”");
    // 它是「动作」不是「选项」：不能被读屏当成可选项，也不占 option 编号
    expect(custom.getAttribute("role")).toBe("button");
    expect(screen.queryAllByRole("option")).toHaveLength(0);

    fireEvent.click(custom);
    expect(onCreateCustom).toHaveBeenCalledWith("1280x720");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("自定义行不改变 option 数量，也不参与 aria-activedescendant 编号", () => {
    render(
      <Select options={sizes} value="1024x1024" onChange={vi.fn()} searchable allowCustom onCreateCustom={vi.fn()} />,
    );
    const trigger = screen.getByRole("button", { name: /1024x1024/ });
    fireEvent.click(trigger);
    const search = screen.getByLabelText("筛选选项");
    // `1024` 是两条尺寸的子序列 → 两行可见，外加一行自定义动作
    fireEvent.change(search, { target: { value: "1024" } });
    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(screen.getByTestId("select-custom-option")).toBeTruthy();

    // 上下键只在真实 option 之间移动，活动项 id 必须真的存在
    fireEvent.keyDown(search, { key: "ArrowDown" });
    const activeId = trigger.getAttribute("aria-activedescendant");
    expect(activeId).not.toBeNull();
    expect(document.getElementById(activeId ?? "")?.getAttribute("role")).toBe("option");
  });

  it("输入精确命中已有项时走正常选中，不创建新值也不出自定义行", () => {
    const onCreateCustom = vi.fn();
    const onChange = vi.fn();
    render(
      <Select options={sizes} value="1024x1024" onChange={onChange} searchable allowCustom onCreateCustom={onCreateCustom} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /1024x1024/ }));
    const search = screen.getByLabelText("筛选选项");
    fireEvent.change(search, { target: { value: "1792x1024" } });
    expect(screen.queryByTestId("select-custom-option")).toBeNull();

    fireEvent.keyDown(search, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("1792x1024");
    expect(onCreateCustom).not.toHaveBeenCalled();
  });

  it("label 精确命中同样算已有项（不是只看 value）", () => {
    const labeled = [{ value: "gpt-image-2.5", label: "GPT 图像 2.5" }];
    const onCreateCustom = vi.fn();
    render(
      <Select options={labeled} value="" onChange={vi.fn()} searchable allowCustom onCreateCustom={onCreateCustom} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /请选择/ }));
    const search = screen.getByLabelText("筛选选项");
    fireEvent.change(search, { target: { value: "GPT 图像 2.5" } });
    expect(screen.queryByTestId("select-custom-option")).toBeNull();
  });

  it("空白输入不出现自定义行，Enter 也不会创建空值", () => {
    const onCreateCustom = vi.fn();
    render(
      <Select options={sizes} value="1024x1024" onChange={vi.fn()} searchable allowCustom onCreateCustom={onCreateCustom} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /1024x1024/ }));
    const search = screen.getByLabelText("筛选选项");
    fireEvent.change(search, { target: { value: "   " } });
    expect(screen.queryByTestId("select-custom-option")).toBeNull();
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onCreateCustom).not.toHaveBeenCalled();
  });

  it("超长输入：不出现自定义行，Enter 既不创建也不悄悄选中别的项", () => {
    // 65 字符超上限。此时用户意图明确是「用我打的这串」，退化成选中某个模糊命中
    // 的行等于改掉他要的值 —— 宁可什么都不做。
    const onCreateCustom = vi.fn();
    const onChange = vi.fn();
    render(
      <Select options={sizes} value="1024x1024" onChange={onChange} searchable allowCustom onCreateCustom={onCreateCustom} />,
    );
    const trigger = screen.getByRole("button", { name: /1024x1024/ });
    fireEvent.click(trigger);
    const search = screen.getByLabelText("筛选选项");
    fireEvent.change(search, { target: { value: "1".repeat(65) } });
    expect(screen.queryByTestId("select-custom-option")).toBeNull();

    fireEvent.keyDown(search, { key: "Enter" });
    expect(onCreateCustom).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("没开 searchable 时 allowCustom 不生效（没有输入入口，开关是死开关）", () => {
    const onCreateCustom = vi.fn();
    render(<Select options={sizes} value="1024x1024" onChange={vi.fn()} allowCustom onCreateCustom={onCreateCustom} />);
    const trigger = screen.getByRole("button", { name: /1024x1024/ });
    fireEvent.click(trigger);
    expect(screen.queryByLabelText("筛选选项")).toBeNull();
    expect(screen.queryByTestId("select-custom-option")).toBeNull();
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(onCreateCustom).not.toHaveBeenCalled();
  });

  it("清单为空也能展开手填（新供应商还没配模型时的唯一出路）", () => {
    const onCreateCustom = vi.fn();
    render(<Select options={[]} value="" onChange={vi.fn()} searchable allowCustom onCreateCustom={onCreateCustom} />);
    const trigger = screen.getByRole("button", { name: /请选择/ });
    fireEvent.click(trigger);
    const search = screen.getByLabelText("筛选选项");
    fireEvent.change(search, { target: { value: "brand-new-model" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onCreateCustom).toHaveBeenCalledWith("brand-new-model");
  });

  it("清单为空但没开 allowCustom 时仍保持旧行为（不展开空浮层）", () => {
    render(<Select options={[]} value="" onChange={vi.fn()} searchable />);
    const trigger = screen.getByRole("button", { name: /请选择/ });
    fireEvent.click(trigger);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("合并后的自定义值能显示在触发器上（不再退化成「请选择」）", () => {
    // mergeCustomOption 是调用方的接线方式：值不在清单里时把它补成一条选项，
    // 否则触发器找不到 current 就显示「请选择」—— 用户选过东西却像没选。
    render(<Select options={mergeCustomOption(sizes, "1280x720")} value="1280x720" onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "1280x720" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "1280x720" }));
    // 补进来的那条归在「自定义」组里，组标题照常渲染
    expect(screen.getByText("自定义")).toBeTruthy();
    expect(screen.getAllByRole("option")).toHaveLength(sizes.length + 1);
  });
});

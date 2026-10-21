// @vitest-environment jsdom

import { type ComponentProps, type ElementType, type ReactNode, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GroupNode, ImageNode, PromptNode } from "./CanvasNodes";
import type { CanvasGroupNodeData, CanvasImageNodeData } from "../types";

afterEach(cleanup);

/** 测试 mock 只给关心的字段，其余由类型逐字段把关；「不完整 props」的唯一断言点集中在此 */
function nodeProps<T extends ElementType>(props: Partial<ComponentProps<T>>): ComponentProps<T> {
  return props as ComponentProps<T>;
}

function renderImageNode(
  onZoom = vi.fn(),
  onCanvasDoubleClick = vi.fn(),
  lod?: boolean,
  dataPatch: Partial<CanvasImageNodeData> = {},
) {
  const onCrop = vi.fn();
  const onUpscale = vi.fn();
  const onSplit = vi.fn();
  const onMask = vi.fn();
  const onClearMask = vi.fn();
  const props = nodeProps<typeof ImageNode>({
    id: "image-1",
    type: "image",
    data: {
      registryId: "registry-1",
      name: "sample.png",
      url: "/sample.png",
      size: 1,
      ext: "png",
      refCount: 0,
      absPath: "C:\\sample.png",
      ...dataPatch,
    },
    selected: false,
    lod,
    onZoom,
    onReplace: vi.fn(),
    onDelete: vi.fn(),
    onCrop,
    onUpscale,
    onSplit,
    onMask,
    onClearMask,
  });

  render(
    <div onDoubleClick={onCanvasDoubleClick}>
      <ReactFlowProvider>
        <ImageNode {...props} />
      </ReactFlowProvider>
    </div>,
  );
  return { onZoom, onCanvasDoubleClick, onCrop, onUpscale, onSplit, onMask, onClearMask };
}

describe("ImageNode", () => {
  it("opens preview when the image is double-clicked", () => {
    const { onZoom } = renderImageNode();

    fireEvent.doubleClick(screen.getByAltText("sample.png"));

    expect(onZoom).toHaveBeenCalledWith("image-1");
  });

  it("does not bubble image double-clicks to the canvas", () => {
    const { onCanvasDoubleClick } = renderImageNode();

    fireEvent.doubleClick(screen.getByAltText("sample.png"));

    expect(onCanvasDoubleClick).not.toHaveBeenCalled();
  });

  it("places accessible image actions in the right-side rail", () => {
    renderImageNode();

    expect(screen.getByTestId("image-action-rail").className).toContain("left-full");
    expect(screen.getByRole("button", { name: "预览大图" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "裁剪图片" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "放大图片" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "切分图片" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "蒙版重绘" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "替换图片" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "删除图片" })).toBeTruthy();
  });

  it("keeps the action rail hoverable and unclickable while hidden", () => {
    renderImageNode();
    const rail = screen.getByTestId("image-action-rail");

    // 隐藏态必须挡掉命中测试：opacity:0 仍会参与命中，只靠透明度等于常驻一排隐形按钮。
    expect(rail.className).toContain("pointer-events-none");
    expect(rail.className).toContain("group-hover:pointer-events-auto");

    // 视觉间距必须来自容器内边距而不是外边距，否则鼠标移向按钮的途中会掉出 .group 导致闪断。
    expect(rail.className).toContain("pl-2");
    expect(rail.className).not.toContain("ml-2");
    expect(rail.className).not.toMatch(/\binvisible\b/);
  });

  it("uses the shared surface role and icon-button size tiers in the action rail", () => {
    renderImageNode(vi.fn(), vi.fn(), undefined, { refCount: 2 });
    const rail = screen.getByTestId("image-action-rail");

    // 操作栏是一块浮层：底色必须走 surface 角色类（写死白色底会被 surfaceAudit.test.ts 拦下），
    // 圆角/描边/阴影与全站卡片一致。
    // 注意：surfaceAudit 是逐行正则扫描、不区分注释与代码，本行断言刻意用正则而非类名字面量，
    // 否则这条"不许写死底色"的守卫自己就会被判为写死底色。
    expect(rail.className).toContain("surface-float");
    expect(rail.className).toContain("rounded-lg");
    expect(rail.className).toContain("shadow-sm");
    expect(rail.className).not.toMatch(/\bbg-(white|black)\b/);

    // 图标按钮收敛到 .btn-icon + .btn-icon--sm 尺寸档，不再手写 !px-1.5 !py-0.5 text-[10px] 魔法值。
    const cropButton = screen.getByRole("button", { name: "裁剪图片" });
    expect(cropButton.className).toContain("btn-icon");
    expect(cropButton.className).toContain("btn-icon--sm");
    expect(cropButton.className).not.toContain("text-[10px]");
    expect(cropButton.className).not.toContain("!px-1.5");
    expect(cropButton.className).not.toContain("!py-0.5");

    // 引用计数徽标跟 .btn-xs 对齐到 11px 档，不再是 10px。
    expect(screen.getByText("引用 2 处").className).toContain("text-[11px]");
  });

  it("wires crop and upscale buttons to their handlers", () => {
    const { onCrop, onUpscale } = renderImageNode();

    fireEvent.click(screen.getByRole("button", { name: "裁剪图片" }));
    expect(onCrop).toHaveBeenCalledWith("image-1");

    fireEvent.click(screen.getByRole("button", { name: "放大图片" }));
    expect(onUpscale).toHaveBeenCalledWith("image-1");
  });

  it("wires the split button to its handler", () => {
    const { onSplit } = renderImageNode();

    fireEvent.click(screen.getByRole("button", { name: "切分图片" }));
    expect(onSplit).toHaveBeenCalledWith("image-1");
  });

  it("wires the mask button to its handler", () => {
    const { onMask } = renderImageNode();

    fireEvent.click(screen.getByRole("button", { name: "蒙版重绘" }));
    expect(onMask).toHaveBeenCalledWith("image-1");
  });

  it("hides the mask badge while the image carries no mask", () => {
    renderImageNode();

    // 没设过蒙版就不该出现角标：蒙版会一直跟着图走，多一个常驻标签等于噪声。
    expect(screen.queryByRole("button", { name: "清除蒙版" })).toBeNull();
  });

  it("shows a clearable mask badge once the image carries a mask", () => {
    const { onClearMask } = renderImageNode(vi.fn(), vi.fn(), undefined, {
      maskDataUrl: "data:image/png;base64,AAAA",
    });

    // 蒙版对后续每次生成都生效，用户会忘掉自己设过 —— 角标本身就是撤销入口。
    fireEvent.click(screen.getByRole("button", { name: "清除蒙版" }));
    expect(onClearMask).toHaveBeenCalledWith("image-1");
  });

  it("leaves handle dimensions to the zoom-aware canvas styles", () => {
    renderImageNode();

    for (const handle of document.querySelectorAll(".react-flow__handle")) {
      expect(handle.className).not.toContain("!h-3");
      expect(handle.className).not.toContain("!w-8");
    }
  });
});

describe("node-pop animation wrapper", () => {
  it("adds the node-pop class to the image node card for inner animation", () => {
    renderImageNode();
    expect(document.querySelector(".node-pop")).toBeTruthy();
  });
});

/* ---------------- memo：父组件重渲染、props 全等时子组件不重渲染 ----------------
 *
 * memo 命中时 DOM 完全不变，靠查询/快照断言不了「没渲染」，所以把计数挂在 data 的 getter 上：
 * 组件函数体每次执行都会读 `missing` / `totalSize`，函数体没跑，计数就不涨。
 * 父组件侧同时统计自身渲染次数 —— 先证明「确实重渲染了」，否则「子组件计数不增」可能只是没触发更新。
 * 最后再翻一个真 prop（selected）断言计数必须上涨，证明探针灵敏、不是恒定的假阳性。
 */
function countDataReads<T extends object>(target: T, key: keyof T): () => number {
  let reads = 0;
  const value = target[key];
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    get() {
      reads += 1;
      return value;
    },
  });
  return () => reads;
}

/** 探针宿主：自己重渲染（子组件 props 不变），另有按钮翻转 selected（props 真变）。 */
function ParentRerenderProbe({
  renderChild,
  onParentRender,
}: {
  renderChild: (props: { selected: boolean }) => ReactNode;
  onParentRender: () => void;
}) {
  const [, setTick] = useState(0);
  const [selected, setSelected] = useState(false);
  onParentRender();
  return (
    <>
      <button type="button" onClick={() => setTick((t) => t + 1)}>
        同 props 重渲染
      </button>
      <button type="button" onClick={() => setSelected((v) => !v)}>
        翻转 selected
      </button>
      {renderChild({ selected })}
    </>
  );
}

describe("memo 浅比较", () => {
  it("ImageNode：父组件重渲染但 props 全等时不重渲染，props 真变才重渲染", () => {
    let parentRuns = 0;
    const data: CanvasImageNodeData = {
      registryId: "registry-1",
      name: "sample.png",
      url: "/sample.png",
      size: 1,
      ext: "png",
      refCount: 0,
      absPath: "C:\\sample.png",
    };
    const bodyReads = countDataReads(data, "missing");
    const props = nodeProps<typeof ImageNode>({
      id: "image-1",
      type: "image",
      data,
      selected: false,
      onZoom: vi.fn(),
      onReplace: vi.fn(),
      onDelete: vi.fn(),
      onCrop: vi.fn(),
      onUpscale: vi.fn(),
      onSplit: vi.fn(),
      onMask: vi.fn(),
      onClearMask: vi.fn(),
    });

    const { getByRole } = render(
      <ReactFlowProvider>
        <ParentRerenderProbe
          onParentRender={() => {
            parentRuns += 1;
          }}
          renderChild={({ selected }) => <ImageNode {...props} selected={selected} />}
        />
      </ReactFlowProvider>,
    );

    // 挂载：父组件渲染 1 次、子组件函数体至少跑过 1 次（探针已接通）
    const afterMount = bodyReads();
    expect(parentRuns).toBe(1);
    expect(afterMount).toBeGreaterThan(0);

    // 父组件强制重渲染、子组件 props 全等 → memo 命中，函数体不得再执行
    fireEvent.click(getByRole("button", { name: "同 props 重渲染" }));
    expect(parentRuns).toBe(2);
    expect(bodyReads()).toBe(afterMount);

    // 对照：真 prop 变了就必须重渲染（证明上面的「不增」不是探针失灵）
    fireEvent.click(getByRole("button", { name: "翻转 selected" }));
    expect(parentRuns).toBe(3);
    expect(bodyReads()).toBeGreaterThan(afterMount);
  });

  it("GroupNode：父组件重渲染但 props 全等时不重渲染，props 真变才重渲染", () => {
    let parentRuns = 0;
    const data: CanvasGroupNodeData = { name: "图片组", imageCount: 3, totalSize: 3 * 1024 * 1024 };
    const bodyReads = countDataReads(data, "totalSize");
    const props = nodeProps<typeof GroupNode>({
      id: "group-1",
      type: "group",
      data,
      selected: false,
      onDelete: vi.fn(),
    });

    const { getByRole } = render(
      <ReactFlowProvider>
        <ParentRerenderProbe
          onParentRender={() => {
            parentRuns += 1;
          }}
          renderChild={({ selected }) => <GroupNode {...props} selected={selected} />}
        />
      </ReactFlowProvider>,
    );

    const afterMount = bodyReads();
    expect(parentRuns).toBe(1);
    expect(afterMount).toBeGreaterThan(0);

    fireEvent.click(getByRole("button", { name: "同 props 重渲染" }));
    expect(parentRuns).toBe(2);
    expect(bodyReads()).toBe(afterMount);

    fireEvent.click(getByRole("button", { name: "翻转 selected" }));
    expect(parentRuns).toBe(3);
    expect(bodyReads()).toBeGreaterThan(afterMount);
  });
});

describe("PromptNode", () => {
  it("keeps failure text out of the card and shows the end of long output paths", () => {
    const outputDir = "C:\\very\\long\\campaign\\product\\outputs\\final";
    const failureMessage = "A very long provider failure that must not resize the card";
    const props = nodeProps<typeof PromptNode>({
      id: "prompt-1",
      type: "prompt",
      data: {
        prompt: "product photo",
        size: "1024x1024",
        quality: "high",
        outputDir,
        status: "failed",
        message: failureMessage,
      },
      selected: false,
      onUpdate: vi.fn(),
      onRun: vi.fn(),
      onDelete: vi.fn(),
      sizeOptions: [{ value: "1024x1024", label: "1:1" }],
      qualityOptions: [{ value: "high", label: "high" }],
    });

    render(<ReactFlowProvider><PromptNode {...props} /></ReactFlowProvider>);

    expect(screen.queryByText(failureMessage)).toBeNull();
    const pathInput = screen.getByDisplayValue(outputDir);
    expect(pathInput.className).toContain("text-right");
    expect(pathInput.getAttribute("title")).toBe(outputDir);
    expect(document.querySelector(".react-flow__node-prompt")).toBeNull();
  });

  it("uses the shared compact label and small button size tiers", () => {
    const props = nodeProps<typeof PromptNode>({
      id: "prompt-1",
      type: "prompt",
      data: {
        prompt: "product photo",
        size: "1024x1024",
        quality: "high",
        outputDir: "output",
        status: "idle",
      },
      selected: false,
      onUpdate: vi.fn(),
      onRun: vi.fn(),
      onDelete: vi.fn(),
      sizeOptions: [{ value: "1024x1024", label: "1:1" }],
      qualityOptions: [{ value: "high", label: "high" }],
    });

    render(<ReactFlowProvider><PromptNode {...props} /></ReactFlowProvider>);

    // 三个字段标签统一走 .field-label-compact（12px 档），不再各自写 field-label text-[10px]。
    const labels = screen.getAllByText(/^(尺寸|质量|输出路径)$/);
    expect(labels).toHaveLength(3);
    for (const label of labels) {
      expect(label.className).toBe("field-label-compact");
    }

    // 生成按钮走 .btn-sm 尺寸档，不再靠 !py-1 text-xs 临时拼。
    const runButton = screen.getByRole("button", { name: "运行" });
    expect(runButton.className).toContain("btn-sm");
    expect(runButton.className).not.toContain("!py-1");
  });
});

describe("PromptNode 生成中占位卡", () => {
  function renderPrompt(data: Partial<ComponentProps<typeof PromptNode>["data"]>, lod?: boolean) {
    const props = nodeProps<typeof PromptNode>({
      id: "prompt-1",
      type: "prompt",
      data: {
        prompt: "product photo",
        size: "1024x1024",
        quality: "high",
        outputDir: "output",
        status: "idle",
        ...data,
      },
      selected: false,
      lod,
      onUpdate: vi.fn(),
      onRun: vi.fn(),
      onDelete: vi.fn(),
      sizeOptions: [{ value: "1024x1024", label: "1:1" }],
      qualityOptions: [{ value: "high", label: "high" }],
    });
    render(<ReactFlowProvider><PromptNode {...props} /></ReactFlowProvider>);
    return props;
  }

  it("running：占位卡出现，秒数以 startedAtMs 为锚点（不从头数）", () => {
    // 锚点设在 8 秒前：卡片一旦自己从 0 走表，就会显示「生成中 0s」而不是 8s
    const startedAtMs = Date.now() - 8000;
    // 秒数由内部计时器每秒重算，断言用容差正则而不是固定字面量（用例执行耗时会带来 ±1s 漂移）
    renderPrompt({ status: "running", startedAtMs });

    const card = screen.getByTestId(`prompt-pending-${startedAtMs}`);
    expect(card.getAttribute("role")).toBe("status");
    // 关键断言：秒数来自锚点（8s）而不是从 0 数起；文案后半句由纯函数轮播，此处不锁死
    expect(card.getAttribute("aria-label")).toMatch(/^生成中 (8|9)s · .+…$/);
    expect(card.getAttribute("aria-label")).not.toContain("生成中 0s");
    expect(screen.getByTestId("generation-pending-bar").style.transform.startsWith("scaleX(")).toBe(true);
  });

  it("idle / queued / done / failed：都不渲染占位卡", () => {
    for (const status of ["idle", "queued", "done", "failed"] as const) {
      cleanup();
      renderPrompt({ status });
      expect(screen.queryByTestId("generation-pending"), status).toBeNull();
      expect(document.querySelector(".generation-pending"), status).toBeNull();
    }
  });

  it("lod 抽象模式：运行中也显示占位卡，且不渲染表单", () => {
    renderPrompt({ status: "running", startedAtMs: Date.now(), title: "主图" }, true);

    expect(document.querySelector(".generation-pending")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "运行" })).toBeNull();
  });

  it("离线的旧工作流缺 startedAtMs 时不崩，退化为一秒一跳的自计时卡", () => {
    renderPrompt({ status: "running" });

    const card = screen.getByTestId("prompt-pending-live");
    expect(card.getAttribute("aria-label")).toBe("生成中 0s · 正在理解提示词…");
  });
});

describe("LOD abstract mode", () => {
  it("keeps the image thumbnail and double-click zoom but drops the action rail", () => {
    const { onZoom } = renderImageNode(vi.fn(), vi.fn(), true);

    expect(screen.getByAltText("sample.png")).toBeTruthy();
    fireEvent.doubleClick(screen.getByAltText("sample.png"));
    expect(onZoom).toHaveBeenCalledWith("image-1");
    expect(screen.queryByTestId("image-action-rail")).toBeNull();
    expect(screen.queryByRole("button", { name: "替换图片" })).toBeNull();
    expect(screen.queryByRole("button", { name: "裁剪图片" })).toBeNull();
    expect(screen.queryByRole("button", { name: "放大图片" })).toBeNull();
    expect(screen.queryByRole("button", { name: "切分图片" })).toBeNull();
  });

  it("renders prompt cards as abstract read-only cards with status text", () => {
    const props = nodeProps<typeof PromptNode>({
      id: "prompt-1",
      type: "prompt",
      data: {
        prompt: "product photo",
        title: "主图",
        size: "1024x1024",
        quality: "high",
        outputDir: "output",
        status: "done",
        resultCount: 2,
      },
      selected: false,
      lod: true,
      onUpdate: vi.fn(),
      onRun: vi.fn(),
      onDelete: vi.fn(),
      sizeOptions: [{ value: "1024x1024", label: "1:1" }],
      qualityOptions: [{ value: "high", label: "high" }],
    });

    render(<ReactFlowProvider><PromptNode {...props} /></ReactFlowProvider>);

    expect(screen.getByText("主图")).toBeTruthy();
    expect(screen.getByText("完成 · 2 张")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "运行" })).toBeNull();
    // 抽象卡片保持与完整模式相同的宽度与最小高度（尺寸不缩水，字放大）
    const card = screen.getByText("主图").parentElement!;
    expect(card.className).toContain("!w-[380px]");
    expect(card.className).toContain("min-h-[320px]");
    expect(screen.getByText("主图").className).toContain("text-3xl");
    expect(screen.getByText("完成 · 2 张").className).toContain("text-xl");
  });

  it("renders a group node without hover delete actions in LOD mode", () => {
    const props = nodeProps<typeof GroupNode>({
      id: "group-1",
      type: "group",
      data: { name: "图片组", imageCount: 5, totalSize: 5 * 1024 * 1024 },
      selected: false,
      lod: true,
      onDelete: vi.fn(),
    });

    render(<ReactFlowProvider><GroupNode {...props} /></ReactFlowProvider>);

    expect(screen.getByText("5 张图")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "删除图片组" })).toBeNull();
  });

  it("shows a dedupe badge on the group card when the chain contains duplicates", () => {
    const props = nodeProps<typeof GroupNode>({
      id: "group-1",
      type: "group",
      data: { name: "图片组", imageCount: 3, totalSize: 3 * 1024 * 1024, duplicateCount: 2 },
      selected: false,
      onDelete: vi.fn(),
    });

    render(<ReactFlowProvider><GroupNode {...props} /></ReactFlowProvider>);

    // 数字直接是去重后的实际张数，重复只以「去重」标签提示
    expect(screen.getByText("3 张图")).toBeTruthy();
    expect(screen.getByText("去重")).toBeTruthy();
    expect(screen.queryByText(/去重实际/)).toBeNull();
  });

  it("omits the dedupe badge when the group has no duplicates", () => {
    const props = nodeProps<typeof GroupNode>({
      id: "group-1",
      type: "group",
      data: { name: "图片组", imageCount: 5, totalSize: 5 * 1024 * 1024 },
      selected: false,
      onDelete: vi.fn(),
    });

    render(<ReactFlowProvider><GroupNode {...props} /></ReactFlowProvider>);

    expect(screen.getByText("5 张图")).toBeTruthy();
    expect(screen.queryByText("去重")).toBeNull();
  });

  it("stacks background cards behind the group so a batch reads as a pile", () => {
    const props = nodeProps<typeof GroupNode>({
      id: "group-1",
      type: "group",
      data: { name: "图片组", imageCount: 4, totalSize: 4 * 1024 * 1024 },
      selected: false,
      onDelete: vi.fn(),
    });

    const { container } = render(<ReactFlowProvider><GroupNode {...props} /></ReactFlowProvider>);

    // 4 张图 = 1 张本体 + 3 张叠卡（imageCount - 1 夹到 3）
    const stacks = container.querySelectorAll('[aria-hidden="true"].pointer-events-none');
    expect(stacks).toHaveLength(3);
  });

  it("caps the stack at three cards no matter how many images are in the group", () => {
    const props = nodeProps<typeof GroupNode>({
      id: "group-1",
      type: "group",
      data: { name: "图片组", imageCount: 40, totalSize: 40 * 1024 * 1024 },
      selected: false,
      onDelete: vi.fn(),
    });

    const { container } = render(<ReactFlowProvider><GroupNode {...props} /></ReactFlowProvider>);

    // 张数是数据，不能直接当渲染数量：40 张渲染 39 层会拖垮缩放帧率
    const stacks = container.querySelectorAll('[aria-hidden="true"].pointer-events-none');
    expect(stacks).toHaveLength(3);
    expect(screen.getByText("40 张图")).toBeTruthy();
  });

  it("draws no stack cards for a single-image group", () => {
    const props = nodeProps<typeof GroupNode>({
      id: "group-1",
      type: "group",
      data: { name: "图片组", imageCount: 1, totalSize: 1024 * 1024 },
      selected: false,
      onDelete: vi.fn(),
    });

    const { container } = render(<ReactFlowProvider><GroupNode {...props} /></ReactFlowProvider>);

    expect(container.querySelectorAll('[aria-hidden="true"].pointer-events-none')).toHaveLength(0);
    expect(screen.getByText("1 张图")).toBeTruthy();
  });

  it("keeps the stack cards in LOD mode too", () => {
    const props = nodeProps<typeof GroupNode>({
      id: "group-1",
      type: "group",
      data: { name: "图片组", imageCount: 3, totalSize: 3 * 1024 * 1024 },
      selected: false,
      lod: true,
      onDelete: vi.fn(),
    });

    const { container } = render(<ReactFlowProvider><GroupNode {...props} /></ReactFlowProvider>);

    // LOD 只去掉 hover 操作栏，叠卡是「有多少张」的主要视觉信号，必须留着
    expect(container.querySelectorAll('[aria-hidden="true"].pointer-events-none')).toHaveLength(2);
  });

  it("renders a failed prompt status without leaking the failure message into the card", () => {
    const props = nodeProps<typeof PromptNode>({
      id: "prompt-1",
      type: "prompt",
      data: {
        prompt: "product photo",
        size: "1024x1024",
        quality: "high",
        outputDir: "output",
        status: "failed",
        message: "secret provider detail",
      },
      selected: false,
      lod: true,
      onUpdate: vi.fn(),
      onRun: vi.fn(),
      onDelete: vi.fn(),
      sizeOptions: [{ value: "1024x1024", label: "1:1" }],
      qualityOptions: [{ value: "high", label: "high" }],
    });

    render(<ReactFlowProvider><PromptNode {...props} /></ReactFlowProvider>);

    expect(screen.getByText("失败")).toBeTruthy();
    expect(screen.queryByText("secret provider detail")).toBeNull();
  });
});

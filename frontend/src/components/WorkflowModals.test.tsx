// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ZoomModal } from "./WorkflowModals";
import { copyImageToClipboard, copyTextToClipboard } from "../imageCopy";

// 剪贴板与 canvas 都是浏览器能力，jsdom 里没有（canvas 连 getContext 都返回 null）。
// 这里 mock 掉模块边界，只验证「点了按钮 -> 调了哪个能力 -> 界面怎么反馈」，
// 真实写剪贴板由 imageCopy 那层在真机兜底（同 imageOps 的 B 层约定）。
vi.mock("../imageCopy", () => ({
  copyImageToClipboard: vi.fn(),
  copyTextToClipboard: vi.fn(),
}));

/** 复制路径的样本值。**必须走 `{}` 表达式传**：JSX 属性字符串不做转义，
 *  `copyPath="D:\\out\\a.png"` 传进去的字面量是两个反斜杠，断言会莫名其妙对不上。 */
const COPY_PATH = "D:\\out\\a.png";

/**
 * 回归测试：ZoomModal 用 createPortal 挂到 body，合成事件沿 React 组件树冒泡（非 DOM 树）。
 * 若不在 Portal 根截停 click，外层宿主（如 HistoryGallery 遮罩 onClick=onClose）会被放大图内的
 * 点击误关 —— 表现为「点放大图中间却退出到画布」。关闭判定本身走 pointerdown，此处只验证截停冒泡。
 */
describe("ZoomModal（Portal 点击隔离）", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("点图片本体：不关闭放大预览，也不冒泡触发外层宿主关闭", () => {
    const onClose = vi.fn();
    const onHostClose = vi.fn();
    render(
      <div onClick={onHostClose}>
        <ZoomModal imageUrl="https://example.com/a.png" name="测试图" onClose={onClose} />
      </div>,
    );
    const img = screen.getByAltText("预览");
    fireEvent.pointerDown(img);
    fireEvent.click(img);
    expect(onClose).not.toHaveBeenCalled();
    expect(onHostClose).not.toHaveBeenCalled();
  });

  it("点空白处：只关闭放大预览，不冒泡触发外层宿主关闭", () => {
    const onClose = vi.fn();
    const onHostClose = vi.fn();
    render(
      <div onClick={onHostClose}>
        <ZoomModal imageUrl="https://example.com/a.png" name="测试图" onClose={onClose} />
      </div>,
    );
    const overlay = document.querySelector("[data-zoom-overlay]") as HTMLElement;
    fireEvent.pointerDown(overlay);
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onHostClose).not.toHaveBeenCalled();
  });
});

/**
 * 复制入口：单击不再跳新页面之后，复制/打开能力都落在预览弹窗里。
 * 断言三件事：① 两个复制按钮都在（「复制路径」只在给了 path 时出现）；
 * ② 点按钮不误关弹窗（控制条在 overlay 的排除名单里）；
 * ③ 复制失败要有可读提示，不能静默。
 */
describe("ZoomModal 复制入口", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("给了 copyPath：同时出现「复制图片」「复制路径」「新标签打开」", () => {
    render(
      <ZoomModal
        imageUrl="https://example.com/a.png"
        name="测试图"
        copyPath={COPY_PATH}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "复制图片" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "复制路径" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "新标签打开" }).getAttribute("target")).toBe("_blank");
  });

  it("没给 copyPath：不渲染「复制路径」（没有可复制路径就别给按钮）", () => {
    render(<ZoomModal imageUrl="blob:http://x/1" name="占位图" onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: "复制图片" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "复制路径" })).toBeNull();
  });

  it("复制路径：调用剪贴板并给出反馈，且不关闭弹窗", async () => {
    vi.mocked(copyTextToClipboard).mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(
      <ZoomModal
        imageUrl="https://example.com/a.png"
        name="测试图"
        copyPath={COPY_PATH}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "复制路径" }));

    await waitFor(() =>
      expect(copyTextToClipboard).toHaveBeenCalledWith("D:\\out\\a.png"),
    );
    expect(await screen.findByText("已复制路径")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("复制图片：调用图片复制能力并提示已复制", async () => {
    vi.mocked(copyImageToClipboard).mockResolvedValue(undefined);
    render(
      <ZoomModal
        imageUrl="https://example.com/a.png"
        name="测试图"
        copyPath={COPY_PATH}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "复制图片" }));

    await waitFor(() =>
      expect(copyImageToClipboard).toHaveBeenCalledWith("https://example.com/a.png"),
    );
    expect(await screen.findByText("已复制图片")).toBeTruthy();
  });

  it("剪贴板不可用：给出失败提示而不是静默", async () => {
    vi.mocked(copyTextToClipboard).mockRejectedValue(
      new Error("复制失败：浏览器拒绝了剪贴板访问"),
    );
    render(
      <ZoomModal
        imageUrl="https://example.com/a.png"
        name="测试图"
        copyPath={COPY_PATH}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "复制路径" }));

    expect(await screen.findByText("复制失败：浏览器拒绝了剪贴板访问")).toBeTruthy();
  });
});

/**
 * 「实际大小」与百分比读数：老实现把 1:1 写成 zoom=1，实际只是「回到刚打开时的大小」，
 * 与「适应窗口」完全重合（用户看不懂 1:1 到底指什么）。这里锁定：
 * ① 按钮叫「实际大小」而不是 `1:1`；② 读数按原始像素算（jsdom 里 naturalWidth 与
 * clientWidth 都可桩，因此这里能断言真比例，不必上真机）。
 */
describe("ZoomModal 缩放读数", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  /** jsdom 不会真的解码图片：手动桩掉自然尺寸与布局尺寸 */
  function stubImageSize(natural: { w: number; h: number }, box: { w: number; h: number }) {
    for (const [prop, value] of [
      ["naturalWidth", natural.w],
      ["naturalHeight", natural.h],
      ["clientWidth", box.w],
      ["clientHeight", box.h],
    ] as const) {
      Object.defineProperty(HTMLImageElement.prototype, prop, {
        configurable: true,
        get: () => value,
      });
    }
  }

  it("图片先被缩到窗口（布局 700/原图 1024）时，读数写 68% 而不是 100%", () => {
    stubImageSize({ w: 1024, h: 1536 }, { w: 700, h: 1050 });
    render(<ZoomModal imageUrl="https://example.com/a.png" name="测试图" onClose={vi.fn()} />);

    fireEvent.load(screen.getByAltText("预览"));

    expect(screen.getByText("68%")).toBeTruthy();
    expect(screen.queryByText("100%")).toBeNull();
  });

  it("「实际大小」按钮存在且不再叫 1:1；点了把倍率提到真实 100%", () => {
    stubImageSize({ w: 1024, h: 1536 }, { w: 512, h: 768 });
    render(<ZoomModal imageUrl="https://example.com/a.png" name="测试图" onClose={vi.fn()} />);
    fireEvent.load(screen.getByAltText("预览"));

    // 布局缩放 0.5 -> 读数 50%
    expect(screen.getByText("50%")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "1:1" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "实际大小" }));

    // 真实 1:1 的倍率 = 1/0.5 = 2 -> 读数 100%
    expect(screen.getByText("100%")).toBeTruthy();
  });
});

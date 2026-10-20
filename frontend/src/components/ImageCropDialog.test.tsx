// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as imageOps from "../imageOps";
import { ImageCropDialog } from "./ImageCropDialog";

/**
 * 裁剪对话框的交互层单测。
 *
 * 刻意**不测真实裁剪输出**：jsdom 的 `canvas.getContext("2d")` 恒为 null，
 * `cropDataUrl` 在这里只会走降级分支，断言它的像素结果没有意义。
 * 因此 canvas I/O 一律用 `vi.mock("../imageOps", …)` 做部分替身，只留纯几何函数真身
 * —— 比例换算（`fitCropToRatio` / `resizeCrop`）正是本组件最容易算错的地方，必须真跑。
 *
 * 另一个必须先解决的前提：jsdom 不做布局，`offsetWidth` / `clientWidth` 恒 0。
 * 视口 hook 在宽高为 0 时把 stage 算成 0×0，裁剪框会因为「除以 0」而无意义；
 * 所以下面给 `HTMLElement.prototype.clientWidth/clientHeight` 打了固定值（300×200），
 * 让 stage 的像素尺寸可预期 —— 这恰好也是拖拽手柄「像素位移 → 归一化位移」需要的基准。
 */
vi.mock("../imageOps", async () => {
  const actual = await vi.importActual<typeof import("../imageOps")>("../imageOps");
  return {
    ...actual,
    // 原图尺寸：8:5 的横图，与下面 mock 出来的 stage 盒（300×200）不同宽高比，
    // 这样「比例换算漏了 image 宽高」的写错方式会在断言里立刻暴露
    readImageSize: vi.fn().mockResolvedValue({ width: 1600, height: 1000 }),
    cropDataUrl: vi.fn().mockResolvedValue("data:image/png;base64,cropped"),
  };
});

/** 覆盖原型上的只读布局属性（jsdom 没有布局引擎，默认全 0） */
function stubLayout() {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 300 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 200 });
  // jsdom 同样没有指针捕获 API；组件对它做了存在性守卫（守卫才是被测行为），
  // 这里补一个空实现，让真实浏览器路径也能在这里跑通
  Object.assign(HTMLElement.prototype, {
    setPointerCapture: () => undefined,
    releasePointerCapture: () => undefined,
    hasPointerCapture: () => true,
  });
}

const SRC = "data:image/png;base64,origin";

function renderDialog(overrides: { onClose?: () => void; onConfirm?: (url: string) => void | Promise<void> } = {}) {
  const onClose = overrides.onClose ?? vi.fn();
  const onConfirm = overrides.onConfirm ?? vi.fn();
  render(<ImageCropDialog src={SRC} name="测试图" onClose={onClose} onConfirm={onConfirm} />);
  return { onClose, onConfirm };
}

/** 等裁剪框出现（它要等 readImageSize 这一轮 microtask 后才渲染） */
async function findCropBox(): Promise<HTMLElement> {
  return screen.findByTestId("crop-box");
}

describe("ImageCropDialog", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    // 恢复 mock 里的默认实现（clearAllMocks 只清调用记录，不清 mockRejectedValue 之类的一次性设置）
    vi.mocked(imageOps.readImageSize).mockResolvedValue({ width: 1600, height: 1000 });
    vi.mocked(imageOps.cropDataUrl).mockResolvedValue("data:image/png;base64,cropped");
  });

  it("渲染弹窗与六个比例按钮", async () => {
    stubLayout();
    renderDialog();

    expect(screen.getByTestId("image-crop-dialog")).toBeTruthy();
    // 弹窗标题带上文件名，便于确认自己裁的是哪张
    expect(screen.getByRole("dialog", { name: "裁剪图片 · 测试图" })).toBeTruthy();

    const ratioGroup = screen.getByRole("group", { name: "裁剪比例" });
    const labels = Array.from(ratioGroup.querySelectorAll("button")).map((node) => node.textContent);
    expect(labels).toEqual(["自由", "1:1", "4:3", "3:4", "16:9", "9:16"]);

    // 默认「自由」选中
    expect(screen.getByRole("button", { name: "自由" }).getAttribute("aria-pressed")).toBe("true");
    await findCropBox();
  });

  it("点「1:1」后裁剪框宽高相等（像素比例换算到归一化坐标）", async () => {
    stubLayout();
    renderDialog();

    const box = await findCropBox();
    fireEvent.click(screen.getByRole("button", { name: "1:1" }));

    // fitCropToRatio 是「保持中心、收缩到能放下的最大尺寸」：
    // 1600×1000 原图上归一化 1:1 的目标比例是 1000/1600 = 0.625，起点框 0.76×0.76，
    // 高度放得下 → 先取 height 0.76，width 收缩到 0.76 × 0.625 = 0.475。
    // 落回像素：0.475 × 1600 = 760 = 0.76 × 1000，确实是正方形 —— 那这一步到底证明了什么？
    // 证明的是「换算没漏掉 image 宽高」：漏掉时算出的会是 0.76×0.76（渲染成 300×200 的长方形）。
    await waitFor(() => {
      expect(box.style.width).toBe("47.5%");
      expect(box.style.height).toBe("76%");
    });

    // 换算成实际输出像素：宽 0.475×1600 = 760，高 0.76×1000 = 760 —— 严格相等才是 1:1
    const widthPercent = parseFloat(box.style.width) / 100;
    const heightPercent = parseFloat(box.style.height) / 100;
    expect(Math.round(widthPercent * 1600)).toBe(Math.round(heightPercent * 1000));
    expect(screen.getByRole("button", { name: "1:1" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("点「取消」调用 onClose，不触发确认链路", async () => {
    stubLayout();
    const { onClose } = renderDialog();
    await findCropBox();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(imageOps.cropDataUrl).not.toHaveBeenCalled();
  });

  it("确认裁剪成功：cropDataUrl → onConfirm → onClose", async () => {
    stubLayout();
    const { onClose, onConfirm } = renderDialog();
    await findCropBox();

    fireEvent.click(screen.getByRole("button", { name: "确认裁剪" }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith("data:image/png;base64,cropped"));
    expect(imageOps.cropDataUrl).toHaveBeenCalledWith(SRC, expect.objectContaining({ x: 0.12, y: 0.12 }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("cropDataUrl 失败：显示错误文案且不调 onConfirm", async () => {
    stubLayout();
    vi.mocked(imageOps.cropDataUrl).mockRejectedValueOnce(new Error("boom"));
    const { onClose, onConfirm } = renderDialog();
    await findCropBox();

    fireEvent.click(screen.getByRole("button", { name: "确认裁剪" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("裁剪失败：boom");
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    // 失败后按钮恢复可点，用户能重试
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "确认裁剪" }) as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it("拖拽手柄调用 resizeCrop（并带上锁定比例）", async () => {
    stubLayout();
    renderDialog();
    await findCropBox();

    // resizeCrop 用 spy 包住真身：既断言「被调了」，又保持比例数学是真的
    const spy = vi.spyOn(imageOps, "resizeCrop");
    fireEvent.click(screen.getByRole("button", { name: "16:9" }));

    const handle = document.querySelector('[data-handle="se"]');
    expect(handle).toBeTruthy();
    const node = handle as HTMLElement;
    fireEvent.pointerDown(node, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(node, { pointerId: 1, clientX: 160, clientY: 140 });
    fireEvent.pointerUp(node, { pointerId: 1, clientX: 160, clientY: 140 });

    expect(spy).toHaveBeenCalled();
    // 第二次实参是归一化位移：60/300 = 0.2、40/200 = 0.2（不是像素原值）
    const [, dx, dy, draggedHandle, ratio, box] = spy.mock.calls[0] ?? [];
    expect(dx).toBeCloseTo(0.2, 5);
    expect(dy).toBeCloseTo(0.2, 5);
    expect(draggedHandle).toBe("se");
    expect(ratio).toBeCloseTo(16 / 9, 5);
    expect(box).toEqual({ width: 300, height: 200 });
  });

  it("拖框内只平移：crop 位置变化、尺寸不变", async () => {
    stubLayout();
    renderDialog();
    const box = await findCropBox();

    const spy = vi.spyOn(imageOps, "moveCrop");
    fireEvent.pointerDown(box, { pointerId: 2, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(box, { pointerId: 2, clientX: 130, clientY: 120 });
    fireEvent.pointerUp(box, { pointerId: 2, clientX: 130, clientY: 120 });

    expect(spy).toHaveBeenCalled();
    const [, dx, dy] = spy.mock.calls[0] ?? [];
    expect(dx).toBeCloseTo(0.1, 5);
    expect(dy).toBeCloseTo(0.1, 5);
    await waitFor(() => {
      expect(box.style.width).toBe("76%");
      expect(box.style.height).toBe("76%");
    });
    // 起点 12% + 10% = 22%
    expect(box.style.left).toBe("22%");
    expect(box.style.top).toBe("22%");
  });
});

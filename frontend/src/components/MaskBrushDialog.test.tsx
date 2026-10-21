// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as imageOps from "../imageOps";
import { resetPopupCount } from "../popupLayer";
import { MaskBrushDialog } from "./MaskBrushDialog";

// 只 mock 读图尺寸这一层；蒙版几何（maskBrush.ts）全部用真实实现 ——
// 「涂了没有 / 确认按钮该不该亮」正是它的被测对象。
vi.mock("../imageOps", async () => {
  const actual = await vi.importActual<typeof import("../imageOps")>("../imageOps");
  return { ...actual, readImageSize: vi.fn() };
});

const readImageSizeMock = vi.mocked(imageOps.readImageSize);

const SRC = "data:image/png;base64,AAAA";
const MASK_DATA_URL = "data:image/png;base64,MASK";
const IMAGE = { width: 1600, height: 1000 };

/** 视口里给 canvas 的假布局盒（jsdom 的 getBoundingClientRect 恒为全 0） */
const RECT = { left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300 };

/**
 * 造一个指针事件。
 *
 * 不走 `fireEvent.pointerDown`：jsdom 至今没有 `PointerEvent`，
 * 走 testing-library 的 EventMap 会退化成 `Event`，`pointerId` / `clientX` / `clientY`
 * 能不能落到实例上取决于库的内部实现。这里显式 `Object.assign` 到原生 `Event` 上，
 * React 的合成事件会照常从 nativeEvent 读出来，行为与真实浏览器一致。
 */
function pointerEvent(type: string, init: { pointerId: number; clientX: number; clientY: number }): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, init);
  return event;
}

function canvasEl(): HTMLCanvasElement {
  return screen.getByTestId("mask-canvas") as HTMLCanvasElement;
}

function confirmButton(): HTMLButtonElement {
  // 不按可访问名查：busy 时文案变「处理中…」，名字跟着变，waitFor 会查丢
  return screen.getByTestId("mask-confirm") as HTMLButtonElement;
}

function clearButton(): HTMLButtonElement {
  return screen.getByTestId("mask-clear") as HTMLButtonElement;
}

function sizeSlider(): HTMLInputElement {
  return screen.getByTestId("mask-brush-size") as HTMLInputElement;
}

function modeButton(name: "画笔" | "橡皮擦"): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

function emptyHint(): HTMLElement | null {
  return screen.queryByTestId("mask-empty-hint");
}

/** 让 canvas 有一个非零布局盒，并把指针事件打到归一化坐标上 */
function armCanvas(): HTMLCanvasElement {
  const canvas = canvasEl();
  canvas.getBoundingClientRect = () => RECT as DOMRect;
  return canvas;
}

/** 画一笔：按下 → 拖到另一点 → 抬起（三个事件都带同一个 pointerId） */
function dragStroke(canvas: HTMLCanvasElement): void {
  // 从 (20,20) 拖到 (200,160)：RECT 是 400×300，归一化后正好落进图内
  fireEvent(canvas, pointerEvent("pointerdown", { pointerId: 1, clientX: 20, clientY: 20 }));
  fireEvent(canvas, pointerEvent("pointermove", { pointerId: 1, clientX: 200, clientY: 160 }));
  fireEvent(canvas, pointerEvent("pointerup", { pointerId: 1, clientX: 200, clientY: 160 }));
}

/** 让所有已排队的 microtask / 0ms timer 跑完，用于断言「迟到的结果被丢弃」 */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

function renderDialog(overrides: { name?: string | undefined; onConfirm?: (mask: string) => void | Promise<void> } = {}) {
  const onClose = vi.fn();
  const onConfirm = overrides.onConfirm ?? vi.fn();
  render(<MaskBrushDialog src={SRC} name={overrides.name} onClose={onClose} onConfirm={onConfirm} />);
  return { onClose, onConfirm };
}

/**
 * 装一个假的 canvas 2D 环境。
 *
 * 默认 jsdom 的 `getContext("2d")` 返回 null、`toDataURL` 直接抛「not implemented」，
 * 所以「导出成功」这条路径必须靠桩才能测；「导出失败」那条则**不装桩**（真实 jsdom 行为）。
 *
 * `globalCompositeOperation` 用访问器记录赋值序列：导出的 alpha 语义（透明=重绘）
 * 全靠合成模式表达，只看 `fill` 被调了几次是测不出来的。
 */
function installFakeCanvas(): { ctx: Record<string, unknown>; dataUrl: string; ops: string[] } {
  const ops: string[] = [];
  let composite = "source-over";
  const ctx: Record<string, unknown> = {
    save: vi.fn(),
    restore: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    fillStyle: "",
    get globalCompositeOperation() {
      return composite;
    },
    set globalCompositeOperation(next: string) {
      composite = next;
      ops.push(next);
    },
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    ctx as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(MASK_DATA_URL);
  return { ctx, dataUrl: MASK_DATA_URL, ops };
}

describe("MaskBrushDialog", () => {
  beforeEach(() => {
    readImageSizeMock.mockReset();
    readImageSizeMock.mockResolvedValue(IMAGE);
  });

  afterEach(() => {
    cleanup();
    resetPopupCount();
    vi.restoreAllMocks();
  });

  it("渲染出对话框、画布与全部工具，未涂时确认禁用并显示提示", async () => {
    renderDialog({ name: "红苹果.png" });

    const dialog = screen.getByTestId("mask-brush-dialog");
    expect(dialog.textContent).toContain("蒙版局部重绘 · 红苹果.png");
    expect(canvasEl()).toBeTruthy();
    expect(sizeSlider().value).toBe("8"); // MASK_BRUSH_DEFAULT = 0.08
    expect(clearButton()).toBeTruthy();

    // 默认画笔态
    expect(modeButton("画笔").getAttribute("aria-pressed")).toBe("true");
    expect(modeButton("橡皮擦").getAttribute("aria-pressed")).toBe("false");

    // 一笔没画：确认禁用 + 提示在位
    expect(confirmButton().disabled).toBe(true);
    expect(emptyHint()?.textContent).toBe("先在图上涂出要重绘的区域");

    // 尺寸读到后才允许确认（还要涂过）
    await waitFor(() => expect(readImageSizeMock).toHaveBeenCalledWith(SRC));
  });

  it("切换画笔 / 橡皮擦：aria-pressed 互斥翻转", () => {
    renderDialog();
    fireEvent.click(modeButton("橡皮擦"));
    expect(modeButton("橡皮擦").getAttribute("aria-pressed")).toBe("true");
    expect(modeButton("画笔").getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(modeButton("画笔"));
    expect(modeButton("画笔").getAttribute("aria-pressed")).toBe("true");
    expect(modeButton("橡皮擦").getAttribute("aria-pressed")).toBe("false");
  });

  it("拖动滑杆改笔刷大小，读数同步", () => {
    renderDialog();
    fireEvent.change(sizeSlider(), { target: { value: "20" } });
    expect(sizeSlider().value).toBe("20");
    expect(screen.getByText("20%")).toBeTruthy();

    // 超出上限被夹回 40
    fireEvent.change(sizeSlider(), { target: { value: "999" } });
    expect(sizeSlider().value).toBe("40");
  });

  it("涂一笔后确认启用、空提示消失，footer 显示笔数与原图尺寸", async () => {
    renderDialog();
    await waitFor(() => expect(readImageSizeMock).toHaveBeenCalled());
    const canvas = armCanvas();
    dragStroke(canvas);

    expect(confirmButton().disabled).toBe(false);
    expect(emptyHint()).toBeNull();
    await waitFor(() => expect(screen.getByText(/已涂 1 笔 · 原图 1600 × 1000/)).toBeTruthy());
  });

  it("只擦不涂仍算空蒙版：确认保持禁用、提示不消失", async () => {
    renderDialog();
    await waitFor(() => expect(readImageSizeMock).toHaveBeenCalled());
    const canvas = armCanvas();

    fireEvent.click(modeButton("橡皮擦"));
    dragStroke(canvas);

    // 橡皮擦笔画确实进了状态（清除按钮因此可点），但蒙版依然是空的
    expect(clearButton().disabled).toBe(false);
    expect(confirmButton().disabled).toBe(true);
    expect(emptyHint()?.textContent).toBe("先在图上涂出要重绘的区域");
  });

  it("点「清除」清空所有笔画，确认重新禁用", async () => {
    renderDialog();
    await waitFor(() => expect(readImageSizeMock).toHaveBeenCalled());
    const canvas = armCanvas();
    dragStroke(canvas);
    expect(confirmButton().disabled).toBe(false);

    fireEvent.click(clearButton());
    expect(confirmButton().disabled).toBe(true);
    expect(emptyHint()?.textContent).toBe("先在图上涂出要重绘的区域");
    expect(clearButton().disabled).toBe(true);
  });

  it("确认后回传蒙版 data URL 并关窗", async () => {
    installFakeCanvas();
    const { onClose, onConfirm } = renderDialog();
    await waitFor(() => expect(readImageSizeMock).toHaveBeenCalled());

    dragStroke(armCanvas());
    fireEvent.click(confirmButton());

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onConfirm).toHaveBeenCalledWith(MASK_DATA_URL);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("导出语义：先铺满不透明，再把涂过的区域抠成透明（透明 = 重绘）", async () => {
    const { ctx, ops } = installFakeCanvas();
    renderDialog();
    await waitFor(() => expect(readImageSizeMock).toHaveBeenCalled());

    dragStroke(armCanvas());
    fireEvent.click(confirmButton());
    await waitFor(() => expect(ctx.fillRect).toHaveBeenCalled());

    // 1) 起点是「全图保留」：整块画布铺不透明白
    const fillRect = ctx.fillRect as ReturnType<typeof vi.fn>;
    expect(fillRect).toHaveBeenCalledWith(0, 0, IMAGE.width, IMAGE.height);

    // 2) 画笔笔画在导出时走 destination-out —— 把白底抠成透明洞（要重绘的地方）
    //    预览阶段的画笔是 source-over（半透明白蒙层），所以序列里两者都有
    expect(ops).toContain("destination-out");
    expect(ops.indexOf("destination-out")).toBeGreaterThan(-1);
  });

  it("导出语义：橡皮擦在产物里是 source-over（把透明洞补回不透明 = 不重绘）", async () => {
    const { ctx, ops } = installFakeCanvas();
    renderDialog();
    await waitFor(() => expect(readImageSizeMock).toHaveBeenCalled());
    const canvas = armCanvas();

    // 先涂一笔（导出时 destination-out），再擦一笔（导出时 source-over）
    dragStroke(canvas);
    fireEvent.click(modeButton("橡皮擦"));
    dragStroke(canvas);
    expect(confirmButton().disabled).toBe(false);

    ops.length = 0;
    fireEvent.click(confirmButton());
    await waitFor(() => expect(ctx.fillRect).toHaveBeenCalled());

    // 导出阶段：第一笔（paint）抠洞，第二笔（erase）补回白色
    expect(ops).toContain("destination-out");
    expect(ops).toContain("source-over");
    expect(ops.lastIndexOf("source-over")).toBeGreaterThan(ops.lastIndexOf("destination-out"));
  });

  it("jsdom 没有 canvas 2D 上下文：涂画不崩，导出失败时给 role=alert 且不回调", async () => {
    // 真实 jsdom 的 getContext("2d") 就是 null，这里显式钉住这个前提
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const { onClose, onConfirm } = renderDialog();
    await waitFor(() => expect(readImageSizeMock).toHaveBeenCalled());
    expect(canvasEl().getContext("2d")).toBeNull();

    dragStroke(armCanvas()); // 预览重绘走 null 守卫，不该抛
    expect(confirmButton().disabled).toBe(false);

    fireEvent.click(confirmButton());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("canvas"));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    // 失败后恢复可重试
    await waitFor(() => expect(confirmButton().textContent).toBe("确认重绘"));
  });

  it("读原图尺寸失败时显示 role=alert，且确认始终禁用", async () => {
    readImageSizeMock.mockRejectedValue(new Error("decode fail"));
    renderDialog();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("decode fail"));
    expect(confirmButton().disabled).toBe(true);
  });

  it("点「取消」与按 Esc 都调用 onClose，不调 onConfirm", () => {
    const { onClose, onConfirm } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("确认回调未落地就卸载：迟到的结果不再调用 onClose", async () => {
    installFakeCanvas();
    // 上游（重绘请求）挂住不返回，模拟慢网络
    let settle: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const onClose = vi.fn();
    const onConfirm = vi.fn(() => pending);
    render(<MaskBrushDialog src={SRC} onClose={onClose} onConfirm={onConfirm} />);
    await waitFor(() => expect(readImageSizeMock).toHaveBeenCalled());

    dragStroke(armCanvas());
    fireEvent.click(confirmButton());
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));

    // 用户等不及，在回包前把对话框关了
    cleanup();
    settle?.();
    await flush();

    // aliveRef 拦住了：卸载后的 onClose 不该再触发
    expect(onClose).not.toHaveBeenCalled();
  });
});

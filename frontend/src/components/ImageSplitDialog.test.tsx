// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as imageOps from "../imageOps";
import * as imageSplit from "../imageSplit";
import { resetPopupCount } from "../popupLayer";
import { ImageSplitDialog } from "./ImageSplitDialog";

// 只 mock canvas I/O 两层（readImageSize / splitDataUrl），几何与命名函数
// （clampGrid / splitCellCount / splitOutputName / SPLIT_PRESETS）用真实实现 ——
// 它们才是"格子数、文件名预览是否正确"的被测对象。
// jsdom 的 canvas.getContext("2d") 返回 null，splitDataUrl 必须 mock 掉。
vi.mock("../imageSplit", async () => {
  const actual = await vi.importActual<typeof import("../imageSplit")>("../imageSplit");
  return { ...actual, splitDataUrl: vi.fn() };
});

vi.mock("../imageOps", async () => {
  const actual = await vi.importActual<typeof import("../imageOps")>("../imageOps");
  return { ...actual, readImageSize: vi.fn() };
});

const readImageSizeMock = vi.mocked(imageOps.readImageSize);
const splitDataUrlMock = vi.mocked(imageSplit.splitDataUrl);

const SRC = "data:image/png;base64,AAAA";
const PIECES = ["data:image/png;base64,P1", "data:image/png;base64,P2", "data:image/png;base64,P3"];

function rowsInput(): HTMLInputElement {
  return screen.getByLabelText("行数") as HTMLInputElement;
}

function colsInput(): HTMLInputElement {
  return screen.getByLabelText("列数") as HTMLInputElement;
}

function presetButton(rows: number, cols: number): HTMLButtonElement {
  return screen.getByTestId(`split-preset-${rows}x${cols}`) as HTMLButtonElement;
}

function confirmButton(): HTMLButtonElement {
  // 不按可访问名查：busy 时文案变「处理中…」，名字跟着变，waitFor 会查丢
  return screen.getByTestId("image-split-confirm") as HTMLButtonElement;
}

function cellCount(): number {
  return screen.queryAllByTestId("split-cell").length;
}

function countText(): string {
  return screen.getByTestId("split-count").textContent ?? "";
}

function renderDialog(
  overrides: { name?: string | undefined; onConfirm?: (dataUrls: string[]) => void | Promise<void> } = {},
) {
  const onClose = vi.fn();
  const onConfirm = overrides.onConfirm ?? vi.fn();
  render(
    <ImageSplitDialog src={SRC} name={overrides.name} onClose={onClose} onConfirm={onConfirm} />,
  );
  return { onClose, onConfirm };
}

/** 让已 resolve 的 promise 链（splitDataUrl → onConfirm → onClose）跑完 */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("ImageSplitDialog", () => {
  beforeEach(() => {
    readImageSizeMock.mockReset();
    splitDataUrlMock.mockReset();
    readImageSizeMock.mockResolvedValue({ width: 1600, height: 1000 });
    splitDataUrlMock.mockResolvedValue(PIECES);
  });

  afterEach(() => {
    cleanup();
    resetPopupCount();
  });

  it("渲染出对话框与五个网格预设按钮", () => {
    renderDialog();
    expect(screen.getByTestId("image-split-dialog")).toBeTruthy();
    expect(screen.getByTestId("split-preview")).toBeTruthy();
    // 预设文案来自 SPLIT_PRESETS（乘号两侧带空格），五个都要在
    for (const preset of imageSplit.SPLIT_PRESETS) {
      const button = presetButton(preset.rows, preset.cols);
      expect(button.textContent).toBe(preset.label);
    }
    expect(imageSplit.SPLIT_PRESETS).toHaveLength(5);
  });

  it("默认 2 × 2：预览 4 格，读数与预设高亮同步", async () => {
    renderDialog();
    expect(cellCount()).toBe(4);
    expect(countText()).toBe("将切成 4 张（2 行 × 2 列）");
    expect(presetButton(2, 2).getAttribute("aria-pressed")).toBe("true");
    // 读到原图尺寸后 footer 显示尺寸
    await waitFor(() => expect(screen.getByText(/原图 1600 × 1000/)).toBeTruthy());
  });

  it("点「3 × 3」后预览变 9 格，该按钮 aria-pressed=true，其余变 false", () => {
    renderDialog();
    fireEvent.click(presetButton(3, 3));
    expect(cellCount()).toBe(9);
    expect(countText()).toBe("将切成 9 张（3 行 × 3 列）");
    expect(presetButton(3, 3).getAttribute("aria-pressed")).toBe("true");
    expect(presetButton(2, 2).getAttribute("aria-pressed")).toBe("false");
  });

  it("手填行 3 / 列 5 得到 15 格；填 99 被夹到上限 8", () => {
    renderDialog();
    fireEvent.change(rowsInput(), { target: { value: "3" } });
    fireEvent.change(colsInput(), { target: { value: "5" } });
    expect(rowsInput().value).toBe("3");
    expect(colsInput().value).toBe("5");
    expect(cellCount()).toBe(15);
    expect(countText()).toBe("将切成 15 张（3 行 × 5 列）");

    fireEvent.change(rowsInput(), { target: { value: "99" } });
    expect(rowsInput().value).toBe("8");
    expect(cellCount()).toBe(40);

    fireEvent.change(colsInput(), { target: { value: "0" } });
    expect(colsInput().value).toBe("1");
  });

  it("行列为 1 × 1 时禁用确认并给出提示", () => {
    renderDialog();
    fireEvent.change(rowsInput(), { target: { value: "1" } });
    fireEvent.change(colsInput(), { target: { value: "1" } });
    expect(cellCount()).toBe(1);
    expect(countText()).toBe("将切成 1 张（1 行 × 1 列）");
    expect(confirmButton().disabled).toBe(true);
    expect(screen.getByText("1×1 等于不切，请选择至少 2 块")).toBeTruthy();
  });

  it("文件名预览列前 3 个，超过 3 个时补「…等 N 个」", () => {
    renderDialog({ name: "红苹果.png" });
    const names = screen.getByTestId("split-names");
    expect(names.textContent).toContain("红苹果-2x2-1.png");
    expect(names.textContent).toContain("红苹果-2x2-3.png");
    expect(names.textContent).not.toContain("红苹果-2x2-4.png");
    expect(names.textContent).toContain("…等 4 个");
  });

  it("点「取消」调用 onClose，不调 onConfirm", () => {
    const { onClose, onConfirm } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("确认后依次调 splitDataUrl → onConfirm → onClose", async () => {
    const { onClose, onConfirm } = renderDialog();
    fireEvent.click(presetButton(2, 3));
    fireEvent.click(confirmButton());
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(splitDataUrlMock).toHaveBeenCalledTimes(1);
    expect(splitDataUrlMock.mock.calls[0]![0]).toBe(SRC);
    expect(splitDataUrlMock.mock.calls[0]![1]).toEqual({ rows: 2, cols: 3 });
    expect(onConfirm).toHaveBeenCalledWith(PIECES);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("处理中按钮显示「处理中…」并禁用", async () => {
    splitDataUrlMock.mockImplementation(() => new Promise<string[]>(() => {}));
    renderDialog();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(confirmButton().textContent).toBe("处理中…"));
    expect(confirmButton().disabled).toBe(true);
  });

  it("splitDataUrl 失败：显示 role=alert 错误、不调 onConfirm、按钮恢复可点", async () => {
    splitDataUrlMock.mockRejectedValue(new Error("boom"));
    const { onClose, onConfirm } = renderDialog();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("boom"));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    // 失败后恢复可重试
    await waitFor(() => expect(confirmButton().disabled).toBe(false));
    expect(confirmButton().textContent).toBe("确认切分");
  });

  it("处理中被关窗后，迟到的切分结果不再回调 onConfirm", async () => {
    const deferred: { settle: ((urls: string[]) => void) | null } = { settle: null };
    splitDataUrlMock.mockImplementation(
      () =>
        new Promise<string[]>((resolve) => {
          deferred.settle = resolve;
        }),
    );
    const { onClose, onConfirm } = renderDialog();
    fireEvent.click(confirmButton());
    expect(splitDataUrlMock).toHaveBeenCalledTimes(1);

    cleanup(); // 等价于用户按 Esc / 点遮罩关窗：组件卸载
    deferred.settle?.(PIECES);
    await flush();

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("读原图尺寸失败时显示 role=alert，不崩且确认仍可用", async () => {
    readImageSizeMock.mockRejectedValue(new Error("decode fail"));
    renderDialog();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("decode fail"));
    expect(screen.getByText(/原图尺寸未知/)).toBeTruthy();
    expect(confirmButton().disabled).toBe(false);
  });

  it("按 Esc 关窗（由 ModalShell 统一处理，组件内不重复监听）", () => {
    const { onClose } = renderDialog();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetPopupCount } from "../popupLayer";
import * as imageOps from "../imageOps";
import { ImageUpscaleDialog } from "./ImageUpscaleDialog";

// 只 mock canvas I/O 两层（readImageSize / upscaleDataUrl），几何函数
// （resolveUpscaleSize / gcdRatio / clamp）用真实实现 —— 它们才是
// 「换算文案是否正确」的被测对象。不测真实 canvas 输出（jsdom 无 2D context）。
vi.mock("../imageOps", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("../imageOps")),
  readImageSize: vi.fn(),
  upscaleDataUrl: vi.fn(),
}));

const readImageSizeMock = vi.mocked(imageOps.readImageSize);
const upscaleMock = vi.mocked(imageOps.upscaleDataUrl);

const SRC = "data:image/png;base64,AAAA";
const UPSCALED = "data:image/png;base64,UUUV";

function targetInput(): HTMLInputElement {
  return screen.getByLabelText("目标长边") as HTMLInputElement;
}

function confirmButton(): HTMLButtonElement {
  // 不按可访问名查：busy 时文案变「处理中…」，名字跟着变，waitFor 会查丢
  return screen.getByTestId("image-upscale-confirm") as HTMLButtonElement;
}

function renderDialog(overrides: { onConfirm?: (dataUrl: string) => void } = {}) {
  const onClose = vi.fn();
  const onConfirm = overrides.onConfirm ?? vi.fn();
  render(<ImageUpscaleDialog src={SRC} onClose={onClose} onConfirm={onConfirm} />);
  return { onClose, onConfirm };
}

describe("ImageUpscaleDialog", () => {
  beforeEach(() => {
    readImageSizeMock.mockReset();
    upscaleMock.mockReset();
    readImageSizeMock.mockResolvedValue({ width: 1024, height: 768 });
    upscaleMock.mockResolvedValue(UPSCALED);
  });

  afterEach(() => {
    cleanup();
    resetPopupCount();
  });

  it("渲染出对话框与四个快捷长边按钮", () => {
    renderDialog();
    expect(screen.getByTestId("image-upscale-dialog")).toBeTruthy();
    for (const preset of ["1024", "2048", "3072", "4096"]) {
      expect(screen.getByRole("button", { name: preset })).toBeTruthy();
    }
  });

  it("读到原图尺寸后默认长边 = min(4096, max(1024, 原长边×2))", async () => {
    renderDialog();
    // 1024×768 → 长边×2 = 2048，落在 [1024, 4096] 内
    await waitFor(() => expect(targetInput().value).toBe("2048"));
    // 大图顶到上限
    readImageSizeMock.mockResolvedValue({ width: 5000, height: 3000 });
    // 重新渲染一个新实例验证上限分支（src 变化不会重算旧实例）
    cleanup();
    render(<ImageUpscaleDialog src={SRC} onClose={vi.fn()} onConfirm={vi.fn()} />);
    await waitFor(() => expect(targetInput().value).toBe("4096"));
  });

  it("点「2048」快捷按钮后目标长边输入框变成 2048", async () => {
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "2048" }));
    await waitFor(() => expect(targetInput().value).toBe("2048"));
  });

  it("手填 9999 被夹到 4096（上限）", async () => {
    renderDialog();
    fireEvent.change(targetInput(), { target: { value: "9999" } });
    await waitFor(() => expect(targetInput().value).toBe("4096"));
  });

  it("目标小于原图长边时显示提示但不禁用确认", async () => {
    renderDialog();
    // 等原图尺寸真正读到（初始 fallback 恰好也是 2048，不能拿输入框值判断）
    await waitFor(() => expect(screen.getByText(/原 1024×768 →/)).toBeTruthy());
    fireEvent.change(targetInput(), { target: { value: "500" } });
    expect(screen.getByText("目标小于原图，建议至少设为原图长边")).toBeTruthy();
    expect(confirmButton().disabled).toBe(false);
  });

  it("点「取消」调用 onClose，不调 onConfirm", () => {
    const { onClose, onConfirm } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("确认后依次调 upscaleDataUrl → onConfirm → onClose", async () => {
    const { onClose, onConfirm } = renderDialog();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(upscaleMock).toHaveBeenCalledTimes(1);
    expect(upscaleMock.mock.calls[0]![0]).toBe(SRC);
    expect(upscaleMock.mock.calls[0]![1]).toEqual({ targetLongEdge: 2048, algorithm: "high" });
    expect(onConfirm).toHaveBeenCalledWith(UPSCALED);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("处理中按钮显示「处理中…」并禁用", async () => {
    upscaleMock.mockImplementation(() => new Promise<string>(() => {}));
    renderDialog();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(confirmButton().textContent).toBe("处理中…"));
    expect(confirmButton().disabled).toBe(true);
  });

  it("upscaleDataUrl 失败 → 显示错误文案，不调 onConfirm", async () => {
    upscaleMock.mockRejectedValue(new Error("boom"));
    const { onClose, onConfirm } = renderDialog();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(screen.getByText(/boom/)).toBeTruthy());
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    // 失败后恢复可重试
    await waitFor(() => expect(confirmButton().disabled).toBe(false));
  });
});

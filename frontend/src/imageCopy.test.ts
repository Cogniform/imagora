// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `imageCopy` 的**路径选择**单测（B 层能力本身由真机兜底，见 README）。
 *
 * 锁住三件事：
 * ① 有本机绝对路径时走服务端同步写（浏览器那条异步投递早于"能粘"，见 ARCHITECTURE 8.3）；
 * ② 服务端这条路走不通时**静默回退**到浏览器 API —— 功能不能因此消失；
 * ③ 两条都不可用时抛可读错误，调用方才能提示（静默失败会让人以为已经复制了）。
 *
 * jsdom 没有 `ClipboardItem` / `navigator.clipboard`，这里按需桩；不碰 canvas 是因为
 * 桩的图片本身就是 `image/png`（非 PNG 的转码分支在 jsdom 里无从执行）。
 */

const systemClipboard = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ copyImageToSystemClipboard: systemClipboard }));

import { copyImageToClipboard } from "./imageCopy";

/** 浏览器剪贴板写入的桩 */
const clipboardWrite = vi.fn();
const IMAGE_URL = "/api/image?path=D%3A%5Cout%5Ca.png";
const IMAGE_PATH = "D:\\out\\a.png";

/** 桩一张 PNG（`readAsPngBlob` 对 PNG 不转码，因此不需要 canvas） */
function stubPngFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      blob: async () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }),
    })),
  );
}

class FakeClipboardItem {
  constructor(readonly items: Record<string, Blob>) {}
}

beforeEach(() => {
  systemClipboard.mockReset().mockResolvedValue(undefined);
  clipboardWrite.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("ClipboardItem", FakeClipboardItem);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { write: clipboardWrite, writeText: vi.fn() },
  });
  stubPngFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("copyImageToClipboard：优先服务端同步写", () => {
  it("给了本机路径：调服务端接口，且不经浏览器剪贴板（那条要转码、还是异步投递）", async () => {
    await copyImageToClipboard({ url: IMAGE_URL, path: IMAGE_PATH });

    expect(systemClipboard).toHaveBeenCalledWith(IMAGE_PATH);
    expect(clipboardWrite).not.toHaveBeenCalled();
  });

  it("服务端声明不支持（非 Windows / 旧服务端）：静默回退浏览器 API，功能不消失", async () => {
    systemClipboard.mockRejectedValue(new Error("HTTP 503: 只有 Windows 本机支持"));

    await copyImageToClipboard({ url: IMAGE_URL, path: IMAGE_PATH });

    expect(clipboardWrite).toHaveBeenCalledTimes(1);
    const item = clipboardWrite.mock.calls[0]?.[0]?.[0] as FakeClipboardItem;
    expect(Object.keys(item.items)).toEqual(["image/png"]);
  });

  it("没有本机路径（外链 / blob 占位图）：直接走浏览器 API", async () => {
    await copyImageToClipboard({ url: "blob:http://127.0.0.1:7860/abc" });

    expect(systemClipboard).not.toHaveBeenCalled();
    expect(clipboardWrite).toHaveBeenCalledTimes(1);
  });
});

describe("copyImageToClipboard：失败必须抛可读错误（不静默）", () => {
  it("浏览器不支持 ClipboardItem 且服务端不可用：抛出可操作的提示", async () => {
    systemClipboard.mockRejectedValue(new Error("HTTP 503"));
    vi.stubGlobal("ClipboardItem", undefined);

    await expect(copyImageToClipboard({ url: IMAGE_URL, path: IMAGE_PATH })).rejects.toThrow(
      "当前浏览器不支持复制图片，请改用「复制路径」",
    );
  });
});

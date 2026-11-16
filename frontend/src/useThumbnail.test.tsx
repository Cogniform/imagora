// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearThumbnailCache } from "./thumbnails";
import { useThumbnail } from "./useThumbnail";

/** 缩略图 hook：命中缓存同步给、未命中先空后给、失败退回原图、换图不串味 */
describe("useThumbnail", () => {
  const url = "/api/image?path=a.png";

  beforeEach(() => {
    vi.stubGlobal("URL", {
      createObjectURL: () => "blob:thumb-1",
      revokeObjectURL: () => {},
    });
    vi.stubGlobal("createImageBitmap", async () => ({ width: 1600, height: 1200, close: () => {} }));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: () => {} } as never);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback: BlobCallback) => {
      callback(new Blob(["thumb"], { type: "image/webp" }));
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, blob: async () => new Blob(["origin"]) })),
    );
  });

  afterEach(() => {
    cleanup();
    clearThumbnailCache();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("未命中先返回 null（卡片显示占位），生成完成后换成缩略图", async () => {
    const { result } = renderHook(() => useThumbnail(url));
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toBe("blob:thumb-1"));
  });

  it("命中缓存时首帧就是缩略图，不会闪一下空白", async () => {
    // 先跑一次把缓存填上
    const first = renderHook(() => useThumbnail(url));
    await waitFor(() => expect(first.result.current).toBe("blob:thumb-1"));
    first.unmount();

    const second = renderHook(() => useThumbnail(url));
    expect(second.result.current).toBe("blob:thumb-1");
  });

  it("生成失败退回原图地址（不让图变空白）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, blob: async () => new Blob([]) })),
    );
    const { result } = renderHook(() => useThumbnail(url));
    await waitFor(() => expect(result.current).toBe(url));
  });

  it("换图时不拿上一张的缩略图顶上", async () => {
    const { result, rerender } = renderHook(({ src }: { src: string }) => useThumbnail(src), {
      initialProps: { src: url },
    });
    await waitFor(() => expect(result.current).toBe("blob:thumb-1"));

    rerender({ src: "/api/image?path=b.png" });
    expect(result.current).toBeNull();
  });

  it("没有 url（图片缺失）时保持 null，不发请求", () => {
    const { result } = renderHook(() => useThumbnail(undefined));
    expect(result.current).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});

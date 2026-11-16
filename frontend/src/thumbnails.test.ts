// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  THUMB_CACHE_LIMIT,
  cachedThumbnail,
  clearThumbnailCache,
  loadThumbnail,
  thumbTargetSize,
} from "./thumbnails";

/** 纯函数：等比缩到长边上限以内，绝不放大 */
describe("thumbTargetSize", () => {
  it("横图按长边缩", () => {
    expect(thumbTargetSize(4096, 3072, 512)).toEqual({ width: 512, height: 384 });
  });

  it("竖图按长边缩", () => {
    expect(thumbTargetSize(3072, 4096, 512)).toEqual({ width: 384, height: 512 });
  });

  it("已经比目标小就不缩（返回 null，调用方直接用原图）", () => {
    expect(thumbTargetSize(400, 300, 512)).toBeNull();
    expect(thumbTargetSize(512, 512, 512)).toBeNull();
  });

  it("极端长条也不产出 0 尺寸（canvas.width = 0 会让 toBlob 抛错）", () => {
    const target = thumbTargetSize(10000, 3, 512);
    expect(target).toEqual({ width: 512, height: 1 });
  });

  it("非法入参返回 null，不产 NaN / 负数", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
      expect(thumbTargetSize(bad, 100, 512)).toBeNull();
      expect(thumbTargetSize(100, bad, 512)).toBeNull();
    }
    expect(thumbTargetSize(2000, 2000, 0)).toBeNull();
  });
});

/** 缓存与生成：用桩替代浏览器的解码 / 画布能力（jsdom 没有真实实现） */
describe("loadThumbnail", () => {
  const created: string[] = [];
  let revoked: string[] = [];
  let seq = 0;

  beforeEach(() => {
    created.length = 0;
    revoked = [];
    seq = 0;
    vi.stubGlobal("URL", {
      createObjectURL: () => {
        seq += 1;
        const url = `blob:thumb-${seq}`;
        created.push(url);
        return url;
      },
      revokeObjectURL: (url: string) => {
        revoked.push(url);
      },
    });
    // 1600×1200 的假原图：比 512 大，所以一定会走缩图分支
    vi.stubGlobal("createImageBitmap", async () => ({ width: 1600, height: 1200, close: () => {} }));
    const context = { drawImage: () => {} };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as never);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback: BlobCallback) => {
      callback(new Blob(["thumb"], { type: "image/webp" }));
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, blob: async () => new Blob(["origin"]) })),
    );
  });

  afterEach(() => {
    clearThumbnailCache();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("生成一次后进缓存，第二次不再取图", async () => {
    const first = await loadThumbnail("/api/image?path=a.png");
    expect(first).toBe("blob:thumb-1");
    expect(cachedThumbnail("/api/image?path=a.png")).toBe("blob:thumb-1");

    const second = await loadThumbnail("/api/image?path=a.png");
    expect(second).toBe("blob:thumb-1");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("同一张图并发请求只解码一次", async () => {
    const [a, b] = await Promise.all([
      loadThumbnail("/api/image?path=same.png"),
      loadThumbnail("/api/image?path=same.png"),
    ]);
    expect(a).toBe(b);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);
  });

  it("取图失败退回原图 URL（缩图是优化，不该让图变空白）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, blob: async () => new Blob([]) })),
    );
    await expect(loadThumbnail("/api/image?path=gone.png")).resolves.toBe("/api/image?path=gone.png");
    // 失败不进缓存：下次打开还会重试（文件可能只是暂时不可读）
    expect(cachedThumbnail("/api/image?path=gone.png")).toBeNull();
  });

  it("浏览器没有 createImageBitmap 时也退回原图，而不是抛错", async () => {
    vi.stubGlobal("createImageBitmap", undefined);
    await expect(loadThumbnail("/api/image?path=b.png")).resolves.toBe("/api/image?path=b.png");
  });

  it("小图不缩：直接用原图，不产生 blob", async () => {
    vi.stubGlobal("createImageBitmap", async () => ({ width: 200, height: 150, close: () => {} }));
    await expect(loadThumbnail("/api/image?path=small.png")).resolves.toBe("/api/image?path=small.png");
    expect(created).toHaveLength(0);
  });

  it("超过上限时淘汰最久未用的并释放它的 blob URL", async () => {
    for (let i = 0; i < THUMB_CACHE_LIMIT + 2; i += 1) {
      await loadThumbnail(`/api/image?path=${i}.png`);
    }
    // 最早的几张被淘汰，且它们的 blob URL 被显式释放（否则永不回收）
    expect(cachedThumbnail("/api/image?path=0.png")).toBeNull();
    expect(revoked.length).toBeGreaterThan(0);
    expect(revoked).toContain("blob:thumb-1");
    // 最近用过的还在
    expect(cachedThumbnail(`/api/image?path=${THUMB_CACHE_LIMIT + 1}.png`)).not.toBeNull();
  });
});

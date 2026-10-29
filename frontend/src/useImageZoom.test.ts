// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useImageZoom, type ZoomTarget } from "./useImageZoom";

const ITEM: ZoomTarget = { url: "/api/image?path=C%3A%5Ca.png", name: "测试图" };

/**
 * 回归测试：Gallery / HistoryGallery / 上传区共用的图片预览开关。
 *
 * 锁定 2026-10-29 起的交互契约：**单击不打开任何新页面**，双击才开放大预览。
 * 旧实现是「单击延时 250ms 开原图、双击取消那次开窗」，问题是单击即跳走（丢了当前
 * 上下文）且慢双击会连闪两个标签；现在没有任何延时/未决定时器，
 * 所以整个测试里 `window.open` 必须一次都没被调用。
 */
describe("useImageZoom（单击不跳转，双击开预览）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("初始无预览", () => {
    const { result } = renderHook(() => useImageZoom());
    expect(result.current.zoom).toBeNull();
  });

  it("openZoom 打开预览；全程不开新标签页", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { result } = renderHook(() => useImageZoom());

    act(() => result.current.openZoom(ITEM));

    expect(result.current.zoom).toEqual(ITEM);
    expect(open).not.toHaveBeenCalled();
  });

  it("closeZoom 关闭预览", () => {
    const { result } = renderHook(() => useImageZoom());

    act(() => result.current.openZoom(ITEM));
    act(() => result.current.closeZoom());

    expect(result.current.zoom).toBeNull();
  });

  it("hook 不再暴露单击开窗入口（删掉才不会有人把它接回 onClick）", () => {
    const { result } = renderHook(() => useImageZoom());
    expect(result.current).not.toHaveProperty("handleClick");
    expect(result.current).not.toHaveProperty("handleDoubleClick");
  });
});

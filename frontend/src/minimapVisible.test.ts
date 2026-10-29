// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CANVAS_ZOOM_MAX_PERCENT,
  CANVAS_ZOOM_MIN_PERCENT,
  MINIMAP_STORAGE_KEY,
  clampZoomPercent,
  readMinimapVisible,
  saveMinimapVisible,
  zoomToPercent,
} from "./minimapVisible";

describe("小地图显隐偏好", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("未设置时默认关闭（卡片少时小地图是纯负担）", () => {
    expect(readMinimapVisible()).toBe(false);
  });

  it("写入后读回", () => {
    saveMinimapVisible(true);
    expect(readMinimapVisible()).toBe(true);
    saveMinimapVisible(false);
    expect(readMinimapVisible()).toBe(false);
  });

  it("空白当未设置（关）；只有明确写 0/false 才关，其余非空值视为开", () => {
    localStorage.setItem(MINIMAP_STORAGE_KEY, "  ");
    expect(readMinimapVisible()).toBe(false);
    // 判据是「非 0 / 非 false 即开」——旧版本写进 localStorage 的值不该被误判成关
    localStorage.setItem(MINIMAP_STORAGE_KEY, "1");
    expect(readMinimapVisible()).toBe(true);
    localStorage.setItem(MINIMAP_STORAGE_KEY, "0");
    expect(readMinimapVisible()).toBe(false);
    localStorage.setItem(MINIMAP_STORAGE_KEY, "false");
    expect(readMinimapVisible()).toBe(false);
  });

  it("localStorage 不可用时静默降级（读回落默认、写不抛错）", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readMinimapVisible()).toBe(false);
    expect(() => saveMinimapVisible(true)).not.toThrow();
  });
});

/**
 * 缩放读数的归一化。**滑杆已移除**（2026-10-29）：滚轮与「放大/缩小」按钮足够，
 * 滑杆只换来一条要维护的双向同步。这里只剩「视口倍率 → 显示百分比」这一条派生方向，
 * 所以反向换算（sliderPercentToZoom）与持久化（read/saveZoomSliderPercent）一并删掉了 ——
 * 它们连同滑杆一起失去了调用方。
 */
describe("缩放读数归一化", () => {
  it("行程与 ReactFlow 的 minZoom/maxZoom 对齐", () => {
    expect(CANVAS_ZOOM_MIN_PERCENT).toBe(5);
    expect(CANVAS_ZOOM_MAX_PERCENT).toBe(200);
  });

  it("clampZoomPercent 夹进行程并取整", () => {
    expect(clampZoomPercent(1)).toBe(5);
    expect(clampZoomPercent(500)).toBe(200);
    expect(clampZoomPercent(87.6)).toBe(88);
  });

  it("clampZoomPercent 对 NaN / ±Infinity 走端点，不抛错", () => {
    expect(clampZoomPercent(Number.NaN)).toBe(5);
    expect(clampZoomPercent(Number.POSITIVE_INFINITY)).toBe(200);
    expect(clampZoomPercent(Number.NEGATIVE_INFINITY)).toBe(5);
  });

  it("zoomToPercent：倍率 → 百分比（100% 落在行程内，两端对齐）", () => {
    expect(zoomToPercent(1)).toBe(100);
    expect(zoomToPercent(1.5)).toBe(150);
    expect(zoomToPercent(0.37)).toBe(37);
    expect(zoomToPercent(1.25)).toBe(125);
    expect(zoomToPercent(0.05)).toBe(CANVAS_ZOOM_MIN_PERCENT);
    expect(zoomToPercent(2)).toBe(CANVAS_ZOOM_MAX_PERCENT);
  });

  it("zoomToPercent 对非法输入不抛错（首帧视口可能是 0）", () => {
    expect(zoomToPercent(Number.NaN)).toBe(CANVAS_ZOOM_MIN_PERCENT);
    expect(zoomToPercent(0)).toBe(CANVAS_ZOOM_MIN_PERCENT);
    expect(zoomToPercent(-1)).toBe(CANVAS_ZOOM_MIN_PERCENT);
  });
});

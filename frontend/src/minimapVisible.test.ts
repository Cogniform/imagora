// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";

import {
  MINIMAP_STORAGE_KEY,
  ZOOM_SLIDER_STORAGE_KEY,
  ZOOM_SLIDER_MAX_PERCENT,
  ZOOM_SLIDER_MIN_PERCENT,
  clampSliderPercent,
  readMinimapVisible,
  readZoomSliderPercent,
  saveMinimapVisible,
  saveZoomSliderPercent,
  sliderPercentToZoom,
  zoomToSliderPercent,
} from "./minimapVisible";

beforeEach(() => {
  localStorage.clear();
});

describe("小地图开关", () => {
  it("未设置时默认关闭", () => {
    expect(readMinimapVisible()).toBe(false);
  });

  it("写入 true 后读回 true，写入 false 后读回 false", () => {
    saveMinimapVisible(true);
    expect(readMinimapVisible()).toBe(true);
    saveMinimapVisible(false);
    expect(readMinimapVisible()).toBe(false);
  });

  it("空白字符串与脏值当作未设置（默认关闭），不抛错", () => {
    localStorage.setItem(MINIMAP_STORAGE_KEY, "   ");
    expect(readMinimapVisible()).toBe(false);
    localStorage.setItem(MINIMAP_STORAGE_KEY, "0");
    expect(readMinimapVisible()).toBe(false);
    localStorage.setItem(MINIMAP_STORAGE_KEY, "false");
    expect(readMinimapVisible()).toBe(false);
    localStorage.setItem(MINIMAP_STORAGE_KEY, "1");
    expect(readMinimapVisible()).toBe(true);
  });

  it("存储键是独立的，不会和缩放滑杆串味", () => {
    saveMinimapVisible(true);
    expect(localStorage.getItem(ZOOM_SLIDER_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(MINIMAP_STORAGE_KEY)).toBe("1");
  });
});

describe("缩放滑杆行程", () => {
  it("行程上下限与 ReactFlow 的 minZoom/maxZoom 对齐", () => {
    expect(ZOOM_SLIDER_MIN_PERCENT).toBe(5);
    expect(ZOOM_SLIDER_MAX_PERCENT).toBe(200);
  });

  it("clampSliderPercent 夹到行程内并取整", () => {
    expect(clampSliderPercent(1)).toBe(5);
    expect(clampSliderPercent(500)).toBe(200);
    expect(clampSliderPercent(87.6)).toBe(88);
  });

  it("clampSliderPercent 对 NaN / Infinity 走下限，不抛错", () => {
    expect(clampSliderPercent(Number.NaN)).toBe(5);
    expect(clampSliderPercent(Number.POSITIVE_INFINITY)).toBe(200);
    expect(clampSliderPercent(Number.NEGATIVE_INFINITY)).toBe(5);
  });
});

describe("缩放倍数与滑杆位置互转（直接百分比）", () => {
  it("100% 对应缩放 1", () => {
    expect(zoomToSliderPercent(1)).toBe(100);
    expect(sliderPercentToZoom(100)).toBe(1);
  });

  it("行程两端分别对应 minZoom 与 maxZoom", () => {
    expect(zoomToSliderPercent(0.05)).toBe(ZOOM_SLIDER_MIN_PERCENT);
    expect(zoomToSliderPercent(2)).toBe(ZOOM_SLIDER_MAX_PERCENT);
  });

  it("往返误差小于 1e-9（互为反函数）", () => {
    for (const zoom of [0.05, 0.1, 0.25, 0.5, 1, 1.5, 2]) {
      const roundTrip = sliderPercentToZoom(zoomToSliderPercent(zoom));
      expect(Math.abs(roundTrip - zoom)).toBeLessThan(1e-9);
    }
  });

  it("滑杆读数就是缩放百分比（不必二次换算）", () => {
    expect(zoomToSliderPercent(0.37)).toBe(37);
    expect(zoomToSliderPercent(1.25)).toBe(125);
  });

  it("非法缩放（NaN / 0 / 负数）一律走下限，不抛错", () => {
    expect(zoomToSliderPercent(Number.NaN)).toBe(ZOOM_SLIDER_MIN_PERCENT);
    expect(zoomToSliderPercent(0)).toBe(ZOOM_SLIDER_MIN_PERCENT);
    expect(zoomToSliderPercent(-1)).toBe(ZOOM_SLIDER_MIN_PERCENT);
  });

  it("sliderPercentToZoom 对越界输入先夹再换算", () => {
    expect(sliderPercentToZoom(1)).toBeCloseTo(0.05, 10);
    expect(sliderPercentToZoom(999)).toBeCloseTo(2, 10);
  });
});

describe("滑杆位置持久化", () => {
  it("未设置时默认 100", () => {
    expect(readZoomSliderPercent()).toBe(100);
  });

  it("写入后读回，越界值被夹进行程", () => {
    saveZoomSliderPercent(150);
    expect(readZoomSliderPercent()).toBe(150);
    saveZoomSliderPercent(1);
    expect(readZoomSliderPercent()).toBe(ZOOM_SLIDER_MIN_PERCENT);
    saveZoomSliderPercent(9999);
    expect(readZoomSliderPercent()).toBe(ZOOM_SLIDER_MAX_PERCENT);
  });

  it("脏值当作未设置（回落 100），不抛错", () => {
    localStorage.setItem(ZOOM_SLIDER_STORAGE_KEY, "  ");
    expect(readZoomSliderPercent()).toBe(100);
    localStorage.setItem(ZOOM_SLIDER_STORAGE_KEY, "abc");
    expect(readZoomSliderPercent()).toBe(100);
  });
});

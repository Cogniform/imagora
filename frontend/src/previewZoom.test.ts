import { describe, expect, it } from "vitest";

import {
  actualZoomPercent,
  clampPreviewPan,
  clampZoom,
  layoutScale,
  zoomForActualPixels,
  ZOOM_MAX,
  ZOOM_MIN,
} from "./previewZoom";

describe("clampZoom", () => {
  it("clamps to the configured range", () => {
    expect(clampZoom(0.01)).toBe(ZOOM_MIN);
    expect(clampZoom(100)).toBe(ZOOM_MAX);
    expect(clampZoom(2)).toBe(2);
  });
});

describe("clampPreviewPan", () => {
  const box = { width: 1000, height: 600 };
  const viewport = { width: 800, height: 500 };

  it("allows free pan when scaled size fits the viewport (clamps to 0)", () => {
    // zoom=0.5: 500x300 < viewport -> 不允许平移
    expect(clampPreviewPan({ x: 500, y: 300 }, 0.5, box, viewport)).toEqual({ x: 0, y: 0 });
  });

  it("clamps pan so the image center stays within the viewport", () => {
    // zoom=2: 2000x1200，中心对称夹紧 (2000-800)/2=600, (1200-500)/2=350
    expect(clampPreviewPan({ x: 9999, y: -9999 }, 2, box, viewport)).toEqual({ x: 600, y: -350 });
    expect(clampPreviewPan({ x: 0, y: 0 }, 2, box, viewport)).toEqual({ x: 0, y: 0 });
  });

  it("keeps an already-valid pan untouched", () => {
    expect(clampPreviewPan({ x: 200, y: -100 }, 2, box, viewport)).toEqual({ x: 200, y: -100 });
  });

  it("returns the pan unchanged before the image is measured", () => {
    expect(clampPreviewPan({ x: 50, y: 50 }, 1.5, { width: 0, height: 0 }, viewport)).toEqual({ x: 50, y: 50 });
  });
});

/**
 * 回归测试：「1:1」与百分比读数的真实含义。
 *
 * 预览里的 `zoom` 是叠在「已适应窗口的布局盒」上的倍率，不是相对原始像素的倍率。
 * 老实现把 `1:1` 写成 `zoom = 1`，于是它只是「回到刚打开时的大小」——一张被缩到 68% 的图，
 * 按了 1:1 还是 68%，而读数写着 100%，与「适应窗口」完全重合。
 */
describe("缩放倍率 ↔ 真实像素", () => {
  const natural = { width: 1024, height: 1536 };

  it("layoutScale：布局盒比原图窄就是被缩过（0 = 未测量，按 1 处理）", () => {
    expect(layoutScale(natural, { width: 700, height: 1050 })).toBeCloseTo(700 / 1024, 6);
    expect(layoutScale(natural, { width: 1024, height: 1536 })).toBe(1);
    expect(layoutScale(null, { width: 700, height: 1050 })).toBe(1);
    expect(layoutScale(natural, { width: 0, height: 0 })).toBe(1);
  });

  it("actualZoomPercent：zoom=1 且图被缩到 68% 时报 68%，不是 100%", () => {
    const box = { width: 700, height: 1050 };
    expect(actualZoomPercent(1, natural, box)).toBe(68);
    // 真实 1:1 的倍率下读数是 100%
    const oneToOne = zoomForActualPixels(natural, box);
    expect(actualZoomPercent(oneToOne, natural, box)).toBe(100);
  });

  it("actualZoomPercent：图比窗口小时（放大显示）读数超过 100%", () => {
    expect(actualZoomPercent(1, natural, { width: 2048, height: 3072 })).toBe(200);
  });

  it("zoomForActualPixels：把 1/布局缩放比夹进允许范围（大图不会算出 20 倍）", () => {
    expect(zoomForActualPixels(natural, { width: 512, height: 768 })).toBe(2);
    // 布局只有原图 1/20 时会被 ZOOM_MAX 截断，而不是算出 20
    expect(zoomForActualPixels(natural, { width: 51, height: 77 })).toBe(ZOOM_MAX);
    // 未测量时不改变倍率
    expect(zoomForActualPixels(null, { width: 0, height: 0 })).toBe(1);
  });
});

import { describe, expect, it } from "vitest";

import {
  actualZoomPercent,
  clampPreviewPan,
  clampZoom,
  FIT_MARGIN,
  fitZoomFor,
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

/**
 * 回归测试：「适应窗口」必须按布局盒算，且四周各留一成。
 *
 * 老实现拿**原始像素**当分母，算出的比例却乘在**已缩过一遍**的布局盒上 —— 等于缩两次：
 * 一张 1024×1536 的图在 1200×800 窗口里会从 800px 高缩到 408px，方形图缩到六成多。
 * 用户看到的就是「点了适应窗口反而变小」，和「双击打开时的贴边」两种样子。
 */
describe("fitZoomFor", () => {
  it("四周各留一成：竖向受限时按高度算出 80%", () => {
    // 已 fit 的盒子 533×800（1024×1536 塞进 1200×800），可视区同尺寸
    const zoom = fitZoomFor({ width: 533, height: 800 }, { width: 1200, height: 800 });
    expect(zoom).toBeCloseTo(0.8, 6);
    // 渲染后 426×640 = 视口高度的 80%，上下各留 10%
    expect(800 * zoom).toBeCloseTo(640, 6);
  });

  it("横向受限时同样留一成（不是只压高度）", () => {
    // 2048×1152 塞进 1200×800 后盒子 = 1200×675
    const zoom = fitZoomFor({ width: 1200, height: 675 }, { width: 1200, height: 800 });
    expect(1200 * zoom).toBeCloseTo(960, 6);
  });

  it("小图允许放大到占满 80%（不设 1 的上限，否则按下去毫无反应）", () => {
    expect(fitZoomFor({ width: 256, height: 256 }, { width: 1200, height: 800 })).toBeCloseTo(2.5, 6);
  });

  it("margin 可调：0.1 是默认的每边一成", () => {
    expect(FIT_MARGIN).toBe(0.1);
    const zero = fitZoomFor({ width: 800, height: 800 }, { width: 800, height: 800 }, 0);
    expect(zero).toBe(1);
  });

  it("未测量（盒子为 0）时不改变倍率", () => {
    expect(fitZoomFor({ width: 0, height: 0 }, { width: 1200, height: 800 })).toBe(1);
  });
});

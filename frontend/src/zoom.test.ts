import { describe, expect, it } from "vitest";

import {
  CANVAS_ZOOM_MAX_PERCENT,
  CANVAS_ZOOM_MIN_PERCENT,
  LOD_IN_ZOOM,
  LOD_OUT_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
  clampZoomPercent,
  nextLod,
  zoomToPercent,
} from "./zoom";

/**
 * 缩放的唯一真值表。
 *
 * 这里的断言分两类：
 *   1. **行程自洽**：百分比上下限必须由 MIN_ZOOM / MAX_ZOOM 算出来，
 *      而不是另写一个 5 / 200 —— 改倍率时忘了改百分比，就会「读数写着 200%
 *      而视口早就缩不动了」，这是最难查的一类 bug。
 *   2. **LOD 迟滞**：进/出用不同阈值，中间是死区。用同一个阈值时缩放停在临界点
 *      会反复翻转，每次翻转都重建全部节点，画面持续闪烁。
 */
describe("缩放行程", () => {
  it("百分比上下限由倍率算出来（不写第二份字面量）", () => {
    expect(CANVAS_ZOOM_MIN_PERCENT).toBe(Math.round(MIN_ZOOM * 100));
    expect(CANVAS_ZOOM_MAX_PERCENT).toBe(Math.round(MAX_ZOOM * 100));
    expect(CANVAS_ZOOM_MIN_PERCENT).toBe(5);
    expect(CANVAS_ZOOM_MAX_PERCENT).toBe(200);
  });

  it("clampZoomPercent 夹进行程并取整", () => {
    expect(clampZoomPercent(1)).toBe(5);
    expect(clampZoomPercent(500)).toBe(200);
    expect(clampZoomPercent(87.6)).toBe(88);
  });

  it("clampZoomPercent 对 NaN / ±Infinity 走端点，不抛错", () => {
    expect(clampZoomPercent(Number.NaN)).toBe(CANVAS_ZOOM_MIN_PERCENT);
    expect(clampZoomPercent(Number.POSITIVE_INFINITY)).toBe(CANVAS_ZOOM_MAX_PERCENT);
    expect(clampZoomPercent(Number.NEGATIVE_INFINITY)).toBe(CANVAS_ZOOM_MIN_PERCENT);
  });

  it("zoomToPercent：倍率 → 百分比（100% 落在行程内，两端对齐）", () => {
    expect(zoomToPercent(1)).toBe(100);
    expect(zoomToPercent(1.5)).toBe(150);
    expect(zoomToPercent(0.37)).toBe(37);
    expect(zoomToPercent(1.25)).toBe(125);
    expect(zoomToPercent(MIN_ZOOM)).toBe(CANVAS_ZOOM_MIN_PERCENT);
    expect(zoomToPercent(MAX_ZOOM)).toBe(CANVAS_ZOOM_MAX_PERCENT);
  });

  it("zoomToPercent 对非法输入不抛错（首帧视口可能是 0）", () => {
    expect(zoomToPercent(Number.NaN)).toBe(CANVAS_ZOOM_MIN_PERCENT);
    expect(zoomToPercent(0)).toBe(CANVAS_ZOOM_MIN_PERCENT);
    expect(zoomToPercent(-1)).toBe(CANVAS_ZOOM_MIN_PERCENT);
  });
});

describe("LOD 抽象模式阈值", () => {
  it("阈值是 15% 进、20% 出，且进 < 出（死区存在）", () => {
    expect(LOD_IN_ZOOM).toBe(0.15);
    expect(LOD_OUT_ZOOM).toBe(0.2);
    expect(LOD_IN_ZOOM).toBeLessThan(LOD_OUT_ZOOM);
  });

  it("缩到 15% 以下进入抽象模式", () => {
    expect(nextLod(false, 0.14)).toBe(true);
    expect(nextLod(false, 0.1)).toBe(true);
    // 边界本身不算「以下」：正好 15% 保持完整渲染
    expect(nextLod(false, LOD_IN_ZOOM)).toBe(false);
  });

  it("放大到 20% 以上才退出抽象模式", () => {
    expect(nextLod(true, 0.21)).toBe(false);
    expect(nextLod(true, 1)).toBe(false);
    // 边界本身不算「以上」：正好 20% 仍停在抽象模式
    expect(nextLod(true, LOD_OUT_ZOOM)).toBe(true);
  });

  it("死区（15%~20%）保持现状，不来回翻转", () => {
    // 这是迟滞的全部意义：停在中间时既不进也不出
    for (const zoom of [0.16, 0.17, 0.18, 0.19, 0.2]) {
      expect(nextLod(false, zoom)).toBe(false);
      expect(nextLod(true, zoom)).toBe(true);
    }
  });

  it("连续缩放穿过阈值只翻转一次（不抖动）", () => {
    // 从 100% 一路缩到 5%：只该在 14% 那一步翻成抽象，且不再翻回
    const steps = [1, 0.8, 0.5, 0.3, 0.22, 0.2, 0.18, 0.16, 0.14, 0.1, 0.05];
    let lod = false;
    const flips: number[] = [];
    for (const zoom of steps) {
      const next = nextLod(lod, zoom);
      if (next !== lod) flips.push(zoom);
      lod = next;
    }
    expect(flips).toEqual([0.14]);
    expect(lod).toBe(true);
  });
});

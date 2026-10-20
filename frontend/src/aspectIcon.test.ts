import { describe, expect, it } from "vitest";

import { ASPECT_ICON_LONG, ASPECT_ICON_MIN_SHORT, aspectIconSize, ratioFromSizeLabel } from "./aspectIcon";

describe("aspectIconSize", () => {
  it("横版：长边给宽，高按比例缩", () => {
    expect(aspectIconSize(2)).toEqual({ width: 24, height: 12 });
    expect(aspectIconSize(1.5)).toEqual({ width: 24, height: 16 });
  });

  it("竖版：长边给高，宽按比例缩", () => {
    expect(aspectIconSize(0.5)).toEqual({ width: 12, height: 24 });
    // 9:16 = 0.5625 → 24 * 0.5625 = 13.5 → round 14
    expect(aspectIconSize(0.5625)).toEqual({ width: 14, height: 24 });
  });

  it("正方形：两边都等于长边", () => {
    expect(aspectIconSize(1)).toEqual({ width: 24, height: 24 });
  });

  it("极端比例下短边夹到下限（否则会细成一条线，认不出是矩形）", () => {
    // 10:1 → 24/10 = 2.4，夹到 10
    expect(aspectIconSize(10)).toEqual({ width: 24, height: ASPECT_ICON_MIN_SHORT });
    // 0.02 → 24*0.02 = 0.48，夹到 10
    expect(aspectIconSize(0.02)).toEqual({ width: ASPECT_ICON_MIN_SHORT, height: 24 });
  });

  it("非法比例回落正方形（照常画，只是不带比例信息）", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1]) {
      expect(aspectIconSize(bad)).toEqual({ width: ASPECT_ICON_LONG, height: ASPECT_ICON_LONG });
    }
  });

  it("长边可覆盖，非法长边回落默认值", () => {
    expect(aspectIconSize(2, 40)).toEqual({ width: 40, height: 20 });
    expect(aspectIconSize(2, Number.NaN)).toEqual({ width: ASPECT_ICON_LONG, height: 12 });
    expect(aspectIconSize(2, 0)).toEqual({ width: ASPECT_ICON_LONG, height: 12 });
  });
});

describe("ratioFromSizeLabel", () => {
  // 以下标签全部抄自后端 core/config.py 的 size_options（真实下发的字符串），
  // 不是构造出来的样例 —— 正则必须对得上它们。
  it("优先取括号里的 a:b", () => {
    expect(ratioFromSizeLabel("1024x1024 (1:1 1K)")).toBe(1);
    expect(ratioFromSizeLabel("1536x1024 (3:2 横版)")).toBeCloseTo(1.5, 10);
    expect(ratioFromSizeLabel("1024x1536 (2:3 竖版)")).toBeCloseTo(2 / 3, 10);
    expect(ratioFromSizeLabel("1152x2048 (9:16 竖版长图)")).toBeCloseTo(9 / 16, 10);
    expect(ratioFromSizeLabel("2048x1152 (16:9 横版)")).toBeCloseTo(16 / 9, 10);
  });

  it("括号里没有比例时退回 WxH 宽高比（竖版长图 / 横版长图这两项靠它）", () => {
    expect(ratioFromSizeLabel("1024x1792 (竖版长图)")).toBeCloseTo(1024 / 1792, 10);
    expect(ratioFromSizeLabel("1792x1024 (横版长图)")).toBeCloseTo(1.75, 10);
  });

  it("label 直接是裸比例时也认", () => {
    expect(ratioFromSizeLabel("1:1")).toBe(1);
    expect(ratioFromSizeLabel("4:3")).toBeCloseTo(4 / 3, 10);
  });

  it("只有像素、没有比例也能算（自建来源常见）", () => {
    expect(ratioFromSizeLabel("1024x1024")).toBe(1);
    expect(ratioFromSizeLabel("1024X1024")).toBe(1);
    expect(ratioFromSizeLabel("2048 × 1024")).toBe(2);
  });

  it("解析不到就返回 null（调用方据此不渲染图标）", () => {
    expect(ratioFromSizeLabel("")).toBeNull();
    expect(ratioFromSizeLabel("请选择")).toBeNull();
    expect(ratioFromSizeLabel("high")).toBeNull();
  });

  it("解析出非正数也算失败（0 宽 / 0 高的脏数据不能变成 0 比例）", () => {
    expect(ratioFromSizeLabel("0x100")).toBeNull();
    expect(ratioFromSizeLabel("100x0")).toBeNull();
    expect(ratioFromSizeLabel("0:1")).toBeNull();
  });
});

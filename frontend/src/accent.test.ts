// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";

import {
  ACCENT_HUE_STORAGE_KEY,
  accentForWindow,
  accentFromHue,
  readAccentHue,
  saveAccentHue,
} from "./accent";

describe("accentForWindow", () => {
  it("同一编号恒定取色（刷新不变），null 回落 1 号窗口", () => {
    expect(accentForWindow(3)).toEqual(accentForWindow(3));
    expect(accentForWindow(null)).toEqual(accentForWindow(1));
  });

  it("色相按黄金角分布，相邻编号差异明显", () => {
    expect(accentForWindow(1).brand).toBe("hsl(0.0 55% 42%)");
    expect(accentForWindow(2).brand).toBe("hsl(137.5 55% 42%)");
    expect(accentForWindow(3).brand).toBe("hsl(275.0 55% 42%)");
    // 4 号越过 360 后回绕，保证多开时色相仍落在同一分布上
    expect(accentForWindow(4).brand).toBe("hsl(52.5 55% 42%)");
  });

  it("brand 与 brandDark 只差明度，色相与饱和度同值", () => {
    const { brand, brandDark } = accentForWindow(7);
    const hueOf = (value: string) => value.match(/hsl\(([-\d.]+) (\d+%) (\d+%)\)/);
    const bright = hueOf(brand);
    const dark = hueOf(brandDark);
    expect(bright?.[1]).toBe(dark?.[1]);
    expect(bright?.[2]).toBe(dark?.[2]);
    expect(bright?.[3]).toBe("42%");
    expect(dark?.[3]).toBe("34%");
  });

  it("0 号（越界输入）取余保留负号，行为由本例钉住", () => {
    expect(accentForWindow(0).brand).toBe("hsl(-137.5 55% 42%)");
  });
});

describe("accentFromHue（用户自定义主体色）", () => {
  it("色相归一到 [0, 360)：负数与超过 360 都回绕", () => {
    expect(accentFromHue(-137.5)).toEqual(accentFromHue(222.5));
    expect(accentFromHue(400)).toEqual(accentFromHue(40));
    expect(accentFromHue(0).brand).toBe("hsl(0.0 55% 42%)");
  });

  it("与自动取色共用同一套公式：色相相同的窗口取值一致", () => {
    expect(accentFromHue(137.508)).toEqual(accentForWindow(2));
  });

  it("非法输入（NaN/Infinity）回落 0 度，不产出坏值", () => {
    expect(accentFromHue(Number.NaN).brand).toBe("hsl(0.0 55% 42%)");
    expect(accentFromHue(Number.POSITIVE_INFINITY).brand).toBe("hsl(0.0 55% 42%)");
  });
});

describe("自定义色相的本地存取", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("未设置时读到 null（= 回到按窗口自动配色）", () => {
    expect(readAccentHue()).toBeNull();
  });

  it("存入后读回同一色相", () => {
    saveAccentHue(224);
    expect(readAccentHue()).toBe(224);
  });

  it("存入越界色相会先归一", () => {
    saveAccentHue(400);
    expect(readAccentHue()).toBe(40);
  });

  it("传 null 清除自定义", () => {
    saveAccentHue(96);
    expect(readAccentHue()).toBe(96);
    saveAccentHue(null);
    expect(readAccentHue()).toBeNull();
    expect(localStorage.getItem(ACCENT_HUE_STORAGE_KEY)).toBeNull();
  });

  it("空白或非法内容视为未设置，不抛错", () => {
    localStorage.setItem(ACCENT_HUE_STORAGE_KEY, "   ");
    expect(readAccentHue()).toBeNull();
    localStorage.setItem(ACCENT_HUE_STORAGE_KEY, "abc");
    expect(readAccentHue()).toBeNull();
  });
});

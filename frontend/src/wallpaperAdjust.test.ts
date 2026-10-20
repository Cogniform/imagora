// @vitest-environment jsdom

/** wallpaperAdjust 单测：钳制、默认值、filter 拼装与读写往返。 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  WALLPAPER_BLUR_LIMITS,
  WALLPAPER_BRIGHTNESS_LIMITS,
  WALLPAPER_BRIGHTNESS_DEFAULT,
  WALLPAPER_BLUR_DEFAULT,
  WALLPAPER_BRIGHTNESS_STORAGE_KEY,
  WALLPAPER_BLUR_STORAGE_KEY,
  clampWallpaperBlur,
  clampWallpaperBrightness,
  readWallpaperBlur,
  readWallpaperBrightness,
  saveWallpaperBlur,
  saveWallpaperBrightness,
  wallpaperFilter,
} from "./wallpaperAdjust";

describe("钳制与默认值", () => {
  it("模糊钳在 [0, 24]，非法值回落 0（原图）", () => {
    expect(clampWallpaperBlur(-5)).toBe(WALLPAPER_BLUR_LIMITS.min);
    expect(clampWallpaperBlur(999)).toBe(WALLPAPER_BLUR_LIMITS.max);
    expect(clampWallpaperBlur(7.5)).toBe(7.5);
    expect(clampWallpaperBlur(Number.NaN)).toBe(WALLPAPER_BLUR_DEFAULT);
    expect(clampWallpaperBlur("abc")).toBe(WALLPAPER_BLUR_DEFAULT);
    expect(clampWallpaperBlur(null)).toBe(WALLPAPER_BLUR_DEFAULT);
    expect(clampWallpaperBlur(undefined)).toBe(WALLPAPER_BLUR_DEFAULT);
    expect(clampWallpaperBlur("")).toBe(WALLPAPER_BLUR_DEFAULT);
  });

  it("明暗钳在 [0.5, 1.5]，非法值回落 1（原样）", () => {
    expect(clampWallpaperBrightness(0)).toBe(WALLPAPER_BRIGHTNESS_LIMITS.min);
    expect(clampWallpaperBrightness(9)).toBe(WALLPAPER_BRIGHTNESS_LIMITS.max);
    expect(clampWallpaperBrightness(1.25)).toBe(1.25);
    expect(clampWallpaperBrightness(Number.POSITIVE_INFINITY)).toBe(WALLPAPER_BRIGHTNESS_DEFAULT);
    expect(clampWallpaperBrightness("x")).toBe(WALLPAPER_BRIGHTNESS_DEFAULT);
    expect(clampWallpaperBrightness(null)).toBe(WALLPAPER_BRIGHTNESS_DEFAULT);
  });
});

describe("wallpaperFilter 拼装", () => {
  it("默认（0 / 1）只保留降噪，不产出多余的 blur / brightness", () => {
    expect(wallpaperFilter(0, 1)).toBe("saturate(0.62) contrast(0.94)");
  });

  it("模糊与明暗各自出现，且降噪永远排最前", () => {
    const f = wallpaperFilter(12, 0.7);
    expect(f.startsWith("saturate(0.62) contrast(0.94)")).toBe(true);
    expect(f).toContain("blur(12px)");
    expect(f).toContain("brightness(0.7)");
  });

  it("只有一条生效时就不写另一条（避免 no-op 指令）", () => {
    expect(wallpaperFilter(8, 1)).toContain("blur(8px)");
    expect(wallpaperFilter(8, 1)).not.toContain("brightness");
    expect(wallpaperFilter(0, 1.4)).toContain("brightness(1.4)");
    expect(wallpaperFilter(0, 1.4)).not.toContain("blur");
  });

  it("入参越界先钳再拼，绝不把非法值写进 CSS", () => {
    // 负模糊被钳到 0 → 不写 blur 分支；明暗 99 被钳到上限 1.5
    expect(wallpaperFilter(-3, 99)).toBe("saturate(0.62) contrast(0.94) brightness(1.5)");
    expect(wallpaperFilter(999, 0)).toContain("blur(24px)");
    expect(wallpaperFilter(Number.NaN, Number.NaN)).toBe("saturate(0.62) contrast(0.94)");
  });

  it("保留两位小数，避免 inline style 字符串过长", () => {
    expect(wallpaperFilter(1.23456, 1.23456)).toContain("blur(1.23px)");
    expect(wallpaperFilter(1.23456, 1.23456)).toContain("brightness(1.23)");
  });

  it("降噪可被替换（自定义时仍保持同一拼装路径）", () => {
    expect(wallpaperFilter(0, 1, "none")).toBe("none");
  });
});

describe("读写往返（仅本机 localStorage）", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  it("写入后读回同一值", () => {
    saveWallpaperBlur(6);
    saveWallpaperBrightness(1.2);
    expect(localStorage.getItem(WALLPAPER_BLUR_STORAGE_KEY)).toBe("6");
    expect(readWallpaperBlur()).toBe(6);
    expect(localStorage.getItem(WALLPAPER_BRIGHTNESS_STORAGE_KEY)).toBe("1.2");
    expect(readWallpaperBrightness()).toBe(1.2);
  });

  it("写入前先钳制，存储里不落越界值", () => {
    saveWallpaperBlur(999);
    saveWallpaperBrightness(-5);
    expect(localStorage.getItem(WALLPAPER_BLUR_STORAGE_KEY)).toBe("24");
    expect(localStorage.getItem(WALLPAPER_BRIGHTNESS_STORAGE_KEY)).toBe("0.5");
  });

  it("未设置 / 空白 / 非法一律回落到默认值", () => {
    localStorage.removeItem(WALLPAPER_BLUR_STORAGE_KEY);
    localStorage.removeItem(WALLPAPER_BRIGHTNESS_STORAGE_KEY);
    expect(readWallpaperBlur()).toBe(WALLPAPER_BLUR_DEFAULT);
    expect(readWallpaperBrightness()).toBe(WALLPAPER_BRIGHTNESS_DEFAULT);
    localStorage.setItem(WALLPAPER_BLUR_STORAGE_KEY, "  ");
    localStorage.setItem(WALLPAPER_BRIGHTNESS_STORAGE_KEY, "nope");
    expect(readWallpaperBlur()).toBe(WALLPAPER_BLUR_DEFAULT);
    expect(readWallpaperBrightness()).toBe(WALLPAPER_BRIGHTNESS_DEFAULT);
  });
});
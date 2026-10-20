/**
 * 壁纸调节 —— 模糊（高斯）与明暗两条独立参数。
 *
 * 与「卡片通透度」是两回事：通透度改的是卡片自己有多透，模糊/明暗改的是**壁纸本身**长什么样。
 * 两者互不影响，用户可以「卡片很透 + 壁纸清晰」，也可以「壁纸压暗让字更跳」。
 *
 * 为什么做成显式滑杆而不是随通透度自动联动：可读性问题该由用户自己权衡，
 * 系统替他决定只会两头不讨好（详见 wallpaperFilter 的说明）。
 *
 * 与 blurFor 的历史教训不冲突：那是「卡片表面**自动**跟着通透度糊」（被要求归零），
 * 这里是把模糊作为**壁纸自身的显式属性**交给用户，默认 0 即原图，行为完全可控。
 */

import { WALLPAPER_IMAGE_FILTER } from "./surface";

/** 模糊范围（px）。上限 24：再多只是把图抹成一团色块，看不出在放什么 */
export const WALLPAPER_BLUR_LIMITS = { min: 0, max: 24 } as const;

/** 明暗范围：0.5 ~ 1.5。1 = 原样；>1 提亮，<1 压暗 */
export const WALLPAPER_BRIGHTNESS_LIMITS = { min: 0.5, max: 1.5 } as const;

/** 默认值：原图，不做任何处理 */
export const WALLPAPER_BLUR_DEFAULT = 0;
export const WALLPAPER_BRIGHTNESS_DEFAULT = 1;

/** 存储键（仅本机浏览器） */
export const WALLPAPER_BLUR_STORAGE_KEY = "imagora.wallpaper-blur.v1";
export const WALLPAPER_BRIGHTNESS_STORAGE_KEY = "imagora.wallpaper-brightness.v1";

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 钳到 [0, 24]；非法值回落 0（原图） */
export function clampWallpaperBlur(value: unknown): number {
  if (value === null || value === undefined || value === "") return WALLPAPER_BLUR_DEFAULT;
  return clamp(value, WALLPAPER_BLUR_LIMITS.min, WALLPAPER_BLUR_LIMITS.max, WALLPAPER_BLUR_DEFAULT);
}

/** 钳到 [0.5, 1.5]；非法值回落 1（原样） */
export function clampWallpaperBrightness(value: unknown): number {
  if (value === null || value === undefined || value === "") return WALLPAPER_BRIGHTNESS_DEFAULT;
  return clamp(
    value,
    WALLPAPER_BRIGHTNESS_LIMITS.min,
    WALLPAPER_BRIGHTNESS_LIMITS.max,
    WALLPAPER_BRIGHTNESS_DEFAULT,
  );
}

/**
 * 把两条参数 + 固定降噪拼成**整条** filter 字面量。
 *
 * 为什么降噪还在：它抽掉颜色、保留明暗，是为了让前景文字读得清（见 WALLPAPER_IMAGE_FILTER）。
 * 模糊与明暗排在它之后——先降噪再调色，调完的结果才与滑杆读数一致。
 *
 * 两头都取整到 2 位：这是每帧都要重算的 inline style，字符串越短越好。
 */
export function wallpaperFilter(
  blur: number,
  brightness: number,
  denoise: string = WALLPAPER_IMAGE_FILTER,
): string {
  const b = Math.round(clampWallpaperBlur(blur) * 100) / 100;
  const l = Math.round(clampWallpaperBrightness(brightness) * 100) / 100;
  const parts = [denoise];
  if (b > 0) parts.push(`blur(${b}px)`);
  if (l !== 1) parts.push(`brightness(${l})`);
  return parts.join(" ");
}

/** 读模糊；未设置 / 非法一律回落 0 */
export function readWallpaperBlur(): number {
  try {
    const raw = localStorage.getItem(WALLPAPER_BLUR_STORAGE_KEY);
    if (raw === null || raw.trim() === "") return WALLPAPER_BLUR_DEFAULT;
    return clampWallpaperBlur(Number(raw));
  } catch {
    return WALLPAPER_BLUR_DEFAULT;
  }
}

/** 读明暗；未设置 / 非法一律回落 1 */
export function readWallpaperBrightness(): number {
  try {
    const raw = localStorage.getItem(WALLPAPER_BRIGHTNESS_STORAGE_KEY);
    if (raw === null || raw.trim() === "") return WALLPAPER_BRIGHTNESS_DEFAULT;
    return clampWallpaperBrightness(Number(raw));
  } catch {
    return WALLPAPER_BRIGHTNESS_DEFAULT;
  }
}

/** 写模糊（写入前先钳制，存储里绝不落越界值） */
export function saveWallpaperBlur(blur: number): void {
  try {
    localStorage.setItem(WALLPAPER_BLUR_STORAGE_KEY, String(clampWallpaperBlur(blur)));
  } catch {
    /* 隐私模式等场景：不持久化即可 */
  }
}

/** 写明暗（写入前先钳制） */
export function saveWallpaperBrightness(brightness: number): void {
  try {
    localStorage.setItem(WALLPAPER_BRIGHTNESS_STORAGE_KEY, String(clampWallpaperBrightness(brightness)));
  } catch {
    /* 隐私模式等场景：不持久化即可 */
  }
}
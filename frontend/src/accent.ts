/**
 * 主体色（按窗口编号取色，每个窗口一份）
 *
 * 两种来源，优先级：用户自定义 > 按窗口编号自动取色。
 * - 自动：编号不同 -> 色相差异大；同一编号 -> 颜色恒定（刷新不变）。
 *   黄金角 137.508° 分布保证相邻编号的颜色明显不同。
 * - 自定义：用户在「外观」里选定色相后，对所有窗口统一生效。
 *
 * 两处共用同一个公式（hsl(色相 55% 42%) 与 34% 的加深档），
 * 因此深浅、按钮投影、聚焦环都会自动配套，不会配出刺眼或发灰的颜色。
 */
const SATURATION = 55;
const BRAND_LIGHTNESS = 42;
const BRAND_DARK_LIGHTNESS = 34;

/** 把任意色相归一到 [0, 360) */
function normalizeHue(hue: number): number {
  if (!Number.isFinite(hue)) return 0;
  return ((hue % 360) + 360) % 360;
}

/** 由一个「已定稿的色相字符串」拼出整套主体色（正色 + 加深档），两处取色共用 */
function accentFromHueText(hueText: string): { brand: string; brandDark: string } {
  return {
    brand: `hsl(${hueText} ${SATURATION}% ${BRAND_LIGHTNESS}%)`,
    brandDark: `hsl(${hueText} ${SATURATION}% ${BRAND_DARK_LIGHTNESS}%)`,
  };
}

/** 由一个色相算出整套主体色（入参会被归一到 [0, 360)，供用户自定义色相使用） */
export function accentFromHue(hue: number): { brand: string; brandDark: string } {
  return accentFromHueText(normalizeHue(hue).toFixed(1));
}

/**
 * 按窗口编号算色相。
 * 注意：**不做归一**，越界编号（如 0）会得到负色相——该行为由 accent.test.ts 钉住。
 * 需要归一后的值时（例如写页面底色变量），调用方自行归一。
 */
export function hueForWindow(windowId: number | null): number {
  return (((windowId ?? 1) - 1) * 137.508) % 360;
}

/**
 * 按窗口编号自动取色（自定义未设置时的默认行为）。
 * 注意：这里**不做色相归一**，越界编号（如 0）仍按原样保留负号——
 * 该行为由 accent.test.ts 的用例钉住，改动会破坏既有契约。
 */
export function accentForWindow(windowId: number | null): { brand: string; brandDark: string } {
  return accentFromHueText(hueForWindow(windowId).toFixed(1));
}

/** 自定义主体色的存储键（仅本机浏览器） */
export const ACCENT_HUE_STORAGE_KEY = "imagora.accent-hue.v1";

/** 读自定义色相；未设置、空白或非法值一律返回 null（= 回到按窗口自动配色） */
export function readAccentHue(): number | null {
  try {
    const raw = localStorage.getItem(ACCENT_HUE_STORAGE_KEY);
    if (raw === null || raw.trim() === "") return null;
    const value = Number(raw);
    if (!Number.isFinite(value)) return null;
    return normalizeHue(value);
  } catch {
    return null;
  }
}

/** 写自定义色相；传 null 表示清除（恢复自动配色）。存储不可用时静默降级为不持久化。 */
export function saveAccentHue(hue: number | null): void {
  try {
    if (hue === null) localStorage.removeItem(ACCENT_HUE_STORAGE_KEY);
    else localStorage.setItem(ACCENT_HUE_STORAGE_KEY, String(normalizeHue(hue)));
  } catch {
    /* 隐私模式等场景下 localStorage 不可用：不持久化，不影响本次会话 */
  }
}

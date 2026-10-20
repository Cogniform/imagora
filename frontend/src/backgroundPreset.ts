/**
 * 背景预设 —— 整页背景可选几套现成底色。
 *
 * 底色只留两项：**跟随主体色**（默认）与**纯白**。
 * 纸纤维 / 木纹 / 干净冷灰 / 雾面四个纹理预设已移除（2026-10-03）：底纹与卡片表面叠加后整页发灰，
 * 且纹理属于装饰而非底色——要纹理的用户可以自己传图。
 *
 * 内置预设壁纸（青玉游龙 / 晨曦神兽）同批移除（2026-10-03）：两张近 800 KB 常驻仓库、
 * 且具体题材的图当内置预设不适合所有人。整页背景图现在只支持**用户自己上传**
 * （走 wallpaperStore 的 IndexedDB，原图存本机、不入库），因此本模块不再涉及图片。
 *
 * 底色只做**浅色系**。深色的「暗房 / 蓝图」不在其中：它们不是换一层背景就完事，
 * 顶栏、卡片、文字、按钮都要同时换一套深色值，否则浅色文字控件压在深底上直接不可读。
 * 那属于独立的深色主题工程，等确认要做再单独立项。
 *
 * 本模块只放纯数据与读写（无副作用、无 DOM），实际底色由 index.css 按 id 出。
 */

export type BackgroundPresetId = "accent" | "plain";

export interface BackgroundPreset {
  id: BackgroundPresetId;
  label: string;
  /** 悬停提示：一句话说清这套底色是什么 */
  hint: string;
}

/** 顺序即界面顺序：默认项在最前 */
export const BACKGROUND_PRESETS: readonly BackgroundPreset[] = [
  { id: "accent", label: "跟随主体色", hint: "默认：底色随主体色相变化，与按钮、角标同一色系" },
  { id: "plain", label: "纯白", hint: "纯白底色，不带纹理，也不跟主体色" },
] as const;

/** 存储键（仅本机浏览器）；键名带 v1，历史存量值由下面的回落路径兜住，不写迁移脚本 */
export const BACKGROUND_PRESET_STORAGE_KEY = "imagora.background-preset.v1";

/** 默认预设：跟随主体色（即改动前的既有观感，不能悄悄换掉默认） */
export const DEFAULT_BACKGROUND_PRESET: BackgroundPresetId = "accent";

const IDS: readonly BackgroundPresetId[] = BACKGROUND_PRESETS.map((preset) => preset.id);

/** 是否是合法预设 id（外部数据 / 存储值都要先过这一关） */
export function isBackgroundPresetId(value: unknown): value is BackgroundPresetId {
  return typeof value === "string" && (IDS as readonly string[]).includes(value);
}

/** 读预设；未设置 / 非法值一律回落默认（不抛错，存储不可用也一样）。
 *  已被移除的旧 id（纹理与内置壁纸）也走这条路径，因此不需要数据迁移。 */
export function readBackgroundPreset(): BackgroundPresetId {
  try {
    const raw = localStorage.getItem(BACKGROUND_PRESET_STORAGE_KEY);
    return isBackgroundPresetId(raw) ? raw : DEFAULT_BACKGROUND_PRESET;
  } catch {
    return DEFAULT_BACKGROUND_PRESET;
  }
}

/** 写预设；非法 id 忽略不写。存储不可用时静默不持久化，不影响本次会话。 */
export function saveBackgroundPreset(id: BackgroundPresetId): void {
  if (!isBackgroundPresetId(id)) return;
  try {
    localStorage.setItem(BACKGROUND_PRESET_STORAGE_KEY, id);
  } catch {
    /* 隐私模式等场景：不持久化即可 */
  }
}

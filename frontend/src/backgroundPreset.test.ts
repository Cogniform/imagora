// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import {
  BACKGROUND_PRESETS,
  BACKGROUND_PRESET_STORAGE_KEY,
  DEFAULT_BACKGROUND_PRESET,
  isBackgroundPresetId,
  readBackgroundPreset,
  saveBackgroundPreset,
} from "./backgroundPreset";

describe("预设清单", () => {
  it("id 不重复，且默认项排在最前（界面顺序即数组顺序）", () => {
    const ids = BACKGROUND_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe(DEFAULT_BACKGROUND_PRESET);
  });

  it("每一项都有中文标签与提示，不留空", () => {
    for (const preset of BACKGROUND_PRESETS) {
      expect(preset.label.trim().length).toBeGreaterThan(0);
      expect(preset.hint.trim().length).toBeGreaterThan(0);
    }
  });

  it("不含深色预设（暗房要整套深色界面，属独立工程）", () => {
    const ids = BACKGROUND_PRESETS.map((preset) => preset.id) as string[];
    expect(ids).not.toContain("dark");
    expect(ids).not.toContain("darkroom");
    expect(ids).not.toContain("blueprint");
  });

  it("只保留两项：跟随主体色 + 纯白", () => {
    expect(BACKGROUND_PRESETS.map((preset) => preset.id)).toEqual(["accent", "plain"]);
  });
});

describe("内置预设壁纸已移除（整页图只支持用户自己上传）", () => {
  it("清单里不再有 wallpaper 字段（预设不再是图片来源）", () => {
    for (const preset of BACKGROUND_PRESETS) {
      expect("wallpaper" in preset).toBe(false);
    }
  });

  it("两张内置壁纸的 id 不再是合法预设", () => {
    expect(isBackgroundPresetId("dragon")).toBe(false);
    expect(isBackgroundPresetId("tiger")).toBe(false);
  });

  it("四个纹理预设的 id 也不再合法", () => {
    for (const id of ["paper", "wood", "cool", "mist"]) {
      expect(isBackgroundPresetId(id)).toBe(false);
    }
  });
});

describe("isBackgroundPresetId", () => {
  it("合法 id 为真，其余一律为假", () => {
    expect(isBackgroundPresetId("accent")).toBe(true);
    expect(isBackgroundPresetId("plain")).toBe(true);
    expect(isBackgroundPresetId("dark")).toBe(false);
    expect(isBackgroundPresetId("")).toBe(false);
    expect(isBackgroundPresetId(null)).toBe(false);
    expect(isBackgroundPresetId(42)).toBe(false);
    expect(isBackgroundPresetId({ id: "plain" })).toBe(false);
  });
});

describe("读写", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("未设置时回落默认（跟随主体色）", () => {
    expect(readBackgroundPreset()).toBe(DEFAULT_BACKGROUND_PRESET);
  });

  it("存进去能读回来", () => {
    saveBackgroundPreset("plain");
    expect(readBackgroundPreset()).toBe("plain");
  });

  it("存储里是非法值时回落默认，不抛错", () => {
    localStorage.setItem(BACKGROUND_PRESET_STORAGE_KEY, "不存在的预设");
    expect(readBackgroundPreset()).toBe(DEFAULT_BACKGROUND_PRESET);
    localStorage.setItem(BACKGROUND_PRESET_STORAGE_KEY, "null");
    expect(readBackgroundPreset()).toBe(DEFAULT_BACKGROUND_PRESET);
  });

  it("已被移除的旧 id（纹理 / 内置壁纸）一律回落默认，不需要迁移脚本", () => {
    for (const legacy of ["paper", "wood", "cool", "mist", "dragon", "tiger"]) {
      localStorage.setItem(BACKGROUND_PRESET_STORAGE_KEY, legacy);
      expect(readBackgroundPreset()).toBe(DEFAULT_BACKGROUND_PRESET);
    }
  });

  it("每一项合法预设都能往返", () => {
    for (const preset of BACKGROUND_PRESETS) {
      saveBackgroundPreset(preset.id);
      expect(readBackgroundPreset()).toBe(preset.id);
    }
  });
});

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MINIMAP_STORAGE_KEY,
  readMinimapVisible,
  saveMinimapVisible,
} from "./minimapVisible";

describe("小地图显隐偏好", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("未设置时默认关闭（卡片少时小地图是纯负担）", () => {
    expect(readMinimapVisible()).toBe(false);
  });

  it("写入后读回", () => {
    saveMinimapVisible(true);
    expect(readMinimapVisible()).toBe(true);
    saveMinimapVisible(false);
    expect(readMinimapVisible()).toBe(false);
  });

  it("空白当未设置（关）；只有明确写 0/false 才关，其余非空值视为开", () => {
    localStorage.setItem(MINIMAP_STORAGE_KEY, "  ");
    expect(readMinimapVisible()).toBe(false);
    // 判据是「非 0 / 非 false 即开」——旧版本写进 localStorage 的值不该被误判成关
    localStorage.setItem(MINIMAP_STORAGE_KEY, "1");
    expect(readMinimapVisible()).toBe(true);
    localStorage.setItem(MINIMAP_STORAGE_KEY, "0");
    expect(readMinimapVisible()).toBe(false);
    localStorage.setItem(MINIMAP_STORAGE_KEY, "false");
    expect(readMinimapVisible()).toBe(false);
  });

  it("localStorage 不可用时静默降级（读回落默认、写不抛错）", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readMinimapVisible()).toBe(false);
    expect(() => saveMinimapVisible(true)).not.toThrow();
  });
});


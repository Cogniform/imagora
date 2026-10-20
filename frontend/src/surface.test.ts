// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import {
  FIELD_ALPHA_FLOOR,
  SURFACE_ROLE_DOC,
  SURFACE_TRANSPARENCY_DEFAULT,
  SURFACE_TRANSPARENCY_STORAGE_KEY,
  clampSurfaceTransparency,
  readSurfaceTransparency,
  saveSurfaceTransparency,
  surfaceTokens,
  surfaceVarList,
  type SurfaceTokens,
} from "./surface";

/** 从材质字符串里取出所有 alpha */
function alphasOf(value: string): number[] {
  return [...value.matchAll(/,\s*(0?\.\d+|1|0)\s*\)/g)].map((m) => Number(m[1]));
}

/** 从材质字符串里取出所有 rgb 通道，用来量「掺色离白多远」 */
function channelsOf(value: string): number[][] {
  return [...value.matchAll(/rgba\((\d+), (\d+), (\d+),/g)].map((m) => [
    Number(m[1]),
    Number(m[2]),
    Number(m[3]),
  ]);
}

const ROLES = ["base", "card", "panel", "float", "inset", "plain"] as const;

/** 某个角色在给定通透度下的平均不透明度 */
function alphaAvg(tokens: SurfaceTokens, role: (typeof ROLES)[number]): number {
  const alphas = alphasOf(tokens[role]);
  return alphas.reduce((a, b) => a + b, 0) / alphas.length;
}

describe("clampSurfaceTransparency", () => {
  it("区间外的值被夹回 [0, 1]", () => {
    expect(clampSurfaceTransparency(-1)).toBe(0);
    expect(clampSurfaceTransparency(2)).toBe(1);
  });

  it("空值 / 非法值回落默认", () => {
    expect(clampSurfaceTransparency(null)).toBe(SURFACE_TRANSPARENCY_DEFAULT);
    expect(clampSurfaceTransparency(undefined)).toBe(SURFACE_TRANSPARENCY_DEFAULT);
    expect(clampSurfaceTransparency("")).toBe(SURFACE_TRANSPARENCY_DEFAULT);
    expect(clampSurfaceTransparency(Number.NaN)).toBe(SURFACE_TRANSPARENCY_DEFAULT);
  });

  it("区间内原样返回", () => {
    expect(clampSurfaceTransparency(0.25)).toBe(0.25);
    expect(clampSurfaceTransparency("0.8")).toBe(0.8);
  });
});

describe("surfaceTokens 产出形状", () => {
  it("六档齐备，且都是合法 CSS 渐变", () => {
    const tokens = surfaceTokens(224, SURFACE_TRANSPARENCY_DEFAULT);
    for (const role of ROLES) {
      expect(tokens[role]).toMatch(/^linear-gradient\(150deg, rgba\(\d+, \d+, \d+, [\d.]+\), rgba\(\d+, \d+, \d+, [\d.]+\)\)$/);
    }
  });

  it("surfaceVarList 覆盖每个角色，且键名与 token 字段一一对应", () => {
    const tokens = surfaceTokens(224, SURFACE_TRANSPARENCY_DEFAULT);
    const vars = surfaceVarList(tokens);
    const names = vars.map(([n]) => n);
    // 每个角色一个变量 + blur；漏一个就会「新增角色但弹窗拿不到」
    expect(names).toEqual([
      "--surface-base",
      "--surface-card",
      "--surface-panel",
      "--surface-float",
      "--surface-inset",
      "--surface-plain",
      "--surface-blur",
    ]);
    for (const [name, value] of vars) {
      const role = name.replace("--surface-", "") as keyof SurfaceTokens;
      expect(value).toBe(tokens[role]);
    }
  });

  it("每个角色都有用途说明（新角色必须登记，否则文档与审计无从引用）", () => {
    for (const role of ROLES) {
      expect(SURFACE_ROLE_DOC[role]).toBeTruthy();
    }
  });
});

describe("掺色：这才是「跟随主体色」的可见量", () => {
  it("老实现的坑：色相在 token 里只差 2/255，肉眼不可见 —— 现在必须明显", () => {
    const tokens = surfaceTokens(285, SURFACE_TRANSPARENCY_DEFAULT);
    // 掺色最少的 plain 是纯白（画布主体有意不跟主体色）
    for (const role of ["base", "card", "panel"] as const) {
      const [top] = channelsOf(tokens[role]);
      const distance = Math.max(...(top ?? [0, 0, 0]).map((c) => 255 - c));
      // 老实现是 2/255；这里要求外壳至少 10/255，否则「跟了也看不出来」
      expect(distance).toBeGreaterThanOrEqual(10);
    }
  });

  it("画布主体（plain）不掺色 —— 看图台面带色会干扰对图片颜色的判断", () => {
    for (const hue of [0, 60, 200, 285, 330]) {
      const [top] = channelsOf(surfaceTokens(hue, 0.5).plain);
      expect(top).toEqual([255, 255, 255]);
    }
  });

  it("外壳比内容区掺得多（层次靠掺色量区分，越往里越中性）", () => {
    const t = surfaceTokens(285, 0.5);
    const dist = (role: (typeof ROLES)[number]) => {
      const [top] = channelsOf(t[role]);
      return Math.max(...(top ?? [255, 255, 255]).map((c) => 255 - c));
    };
    expect(dist("base")).toBeGreaterThan(dist("float"));
    expect(dist("panel")).toBeGreaterThan(dist("float"));
    expect(dist("float")).toBeGreaterThan(dist("inset"));
  });

  it("色相被归一：负值与 +360 等价，非法按 0", () => {
    expect(surfaceTokens(224, 0.5).card).not.toBe(surfaceTokens(0, 0.5).card);
    expect(surfaceTokens(-136, 0.5).card).toBe(surfaceTokens(224, 0.5).card);
    expect(surfaceTokens(Number.NaN, 0.5).card).toBe(surfaceTokens(0, 0.5).card);
  });
});

describe("不透明度：通透度滑杆必须真的有效", () => {
  it("每个角色都随通透度单调变透，且拉到头仍留一线白", () => {
    for (const role of ROLES) {
      const solid = alphaAvg(surfaceTokens(224, 0), role);
      const mid = alphaAvg(surfaceTokens(224, SURFACE_TRANSPARENCY_DEFAULT), role);
      const clear = alphaAvg(surfaceTokens(224, 1), role);
      expect(solid).toBeGreaterThan(mid);
      expect(mid).toBeGreaterThan(clear);
      expect(clear).toBeGreaterThan(0);
    }
  });

  it("可读性优先的角色（台面/浮层）全程托得住底线，不会掉到读不清", () => {
    for (const t of [0, 0.25, 0.55, 0.8, 1]) {
      expect(Math.min(...alphasOf(surfaceTokens(224, t).panel))).toBeGreaterThanOrEqual(0.68);
      expect(Math.min(...alphasOf(surfaceTokens(224, t).float))).toBeGreaterThanOrEqual(0.86);
    }
  });

  it("面板仍有行程（老写法用硬 floor 把滑杆压成死值，拉到一半以上毫无反应）", () => {
    const solid = alphaAvg(surfaceTokens(224, 0), "panel");
    const clear = alphaAvg(surfaceTokens(224, 1), "panel");
    expect(solid - clear).toBeGreaterThan(0.15);
  });

  it("嵌套不变量：内层不许比外层更透（否则壁纸从中间透出一个洞）", () => {
    for (const t of [0, 0.25, 0.55, 0.8, 1]) {
      const tokens = surfaceTokens(224, t);
      const card = alphaAvg(tokens, "card");
      const panel = alphaAvg(tokens, "panel");
      const float = alphaAvg(tokens, "float");
      expect(card).toBeLessThan(panel);
      expect(panel).toBeLessThan(float);
    }
  });

  it("输入框有 0.25 不透明度底线（灰字不飘）", () => {
    // inset 的两端都远高于底线，故这里直接锁「不会低于底线」
    for (const t of [0, 0.55, 1]) {
      expect(Math.min(...alphasOf(surfaceTokens(224, t).inset))).toBeGreaterThanOrEqual(
        FIELD_ALPHA_FLOOR,
      );
    }
  });
});

describe("毛玻璃", () => {
  it("彻底关闭：任何通透度都返回 none，绝不糊到壁纸", () => {
    for (const t of [0, 0.25, 0.55, 0.8, 1]) {
      expect(surfaceTokens(224, t).blur).toBe("none");
    }
    // 回归锁：老实现会返回 blur(20px)…blur(80px)，那层雾正是「看不清壁纸」的元凶
    expect(surfaceTokens(224, 1).blur).not.toMatch(/blur\(/);
  });
});

describe("读写", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("未设置时回落默认", () => {
    expect(readSurfaceTransparency()).toBe(SURFACE_TRANSPARENCY_DEFAULT);
  });

  it("存进去能读回来（越界先钳制）", () => {
    saveSurfaceTransparency(0.3);
    expect(readSurfaceTransparency()).toBe(0.3);
    saveSurfaceTransparency(5);
    expect(readSurfaceTransparency()).toBe(1);
  });

  it("存储里是坏值时回落默认，不抛错", () => {
    localStorage.setItem(SURFACE_TRANSPARENCY_STORAGE_KEY, "abc");
    expect(readSurfaceTransparency()).toBe(SURFACE_TRANSPARENCY_DEFAULT);
    localStorage.setItem(SURFACE_TRANSPARENCY_STORAGE_KEY, "  ");
    expect(readSurfaceTransparency()).toBe(SURFACE_TRANSPARENCY_DEFAULT);
  });
});

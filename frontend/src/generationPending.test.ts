import { describe, expect, it } from "vitest";

import {
  PENDING_MESSAGES,
  PENDING_PROGRESS_CAP,
  PENDING_PROGRESS_START,
  pendingLabel,
  pendingMessage,
  pendingProgress,
  pendingProgressScale,
} from "./generationPending";

/** 纯函数：渐近曲线 + 文案轮播（不碰 DOM，也不读时钟） */
describe("pendingProgress 渐近进度", () => {
  it("首秒就从起点出发，0s 时等于起点而不是 0", () => {
    expect(pendingProgress(0)).toBeCloseTo(PENDING_PROGRESS_START, 5);
    expect(pendingProgress(0)).toBeGreaterThan(0);
  });

  it("严格单调递增且永不超过上界", () => {
    let prev = -1;
    for (let s = 0; s <= 600; s += 1) {
      const v = pendingProgress(s);
      expect(v).toBeGreaterThan(prev);
      expect(v).toBeLessThan(PENDING_PROGRESS_CAP);
      prev = v;
    }
    // 一小时也只贴着上界，不会越过
    expect(pendingProgress(3600)).toBeLessThanOrEqual(PENDING_PROGRESS_CAP);
    expect(pendingProgress(3600)).toBeGreaterThan(97.9);
  });

  it("爬升速度越来越慢（渐近而非线性）", () => {
    const early = pendingProgress(10) - pendingProgress(0);
    const late = pendingProgress(120) - pendingProgress(110);
    expect(early).toBeGreaterThan(late * 5);
  });

  it("非法入参退化为 0s 的值，不产出 NaN", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -5]) {
      const v = pendingProgress(bad);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeCloseTo(PENDING_PROGRESS_START, 5);
    }
  });

  it("scale 是 0..1 的宽度比例，供 transform: scaleX() 使用", () => {
    expect(pendingProgressScale(0)).toBeCloseTo(PENDING_PROGRESS_START / 100, 5);
    expect(pendingProgressScale(600)).toBeLessThan(1);
    expect(pendingProgressScale(600)).toBeGreaterThan(0.97);
  });
});

describe("pendingMessage 文案轮播", () => {
  it("前两秒停留在首条，之后按 2s 换一条", () => {
    expect(pendingMessage(0)).toBe(PENDING_MESSAGES[0]);
    expect(pendingMessage(1)).toBe(PENDING_MESSAGES[0]);
    expect(pendingMessage(2)).toBe(PENDING_MESSAGES[1]);
    expect(pendingMessage(3)).toBe(PENDING_MESSAGES[1]);
    expect(pendingMessage(4)).toBe(PENDING_MESSAGES[2]);
  });

  it("播完一轮后循环，永不越界（noUncheckedIndexedAccess 下也不返回 undefined）", () => {
    const n = PENDING_MESSAGES.length;
    expect(pendingMessage(2 * n)).toBe(PENDING_MESSAGES[0]);
    for (let s = 0; s <= 2 * n * 3; s += 1) {
      expect(PENDING_MESSAGES).toContain(pendingMessage(s));
    }
  });

  it("非法入参取首条，空串也不崩", () => {
    expect(pendingMessage(Number.NaN)).toBe(PENDING_MESSAGES[0]);
    expect(pendingMessage(-1)).toBe(PENDING_MESSAGES[0]);
    expect(pendingMessage(Number.POSITIVE_INFINITY)).toBe(PENDING_MESSAGES[0]);
  });

  it("文案集合非空且无重复", () => {
    expect(PENDING_MESSAGES.length).toBeGreaterThan(1);
    expect(new Set(PENDING_MESSAGES).size).toBe(PENDING_MESSAGES.length);
  });
});

describe("pendingLabel 整行文案", () => {
  it("秒数前缀复用 generatingLabel，后半句跟轮播走", () => {
    expect(pendingLabel(0)).toBe(`生成中 0s · ${PENDING_MESSAGES[0]}`);
    expect(pendingLabel(8.7)).toBe(`生成中 8s · ${PENDING_MESSAGES[4]}`);
    // 12s ÷ 2s = 第 6 格，5 条文案一轮是 5，回落到第 1 条（循环）
    expect(pendingLabel(12)).toBe(`生成中 12s · ${PENDING_MESSAGES[1]}`);
    expect(pendingLabel(10)).toBe(`生成中 10s · ${PENDING_MESSAGES[0]}`);
  });

  it("非法入参按 0s 渲染，不出现 NaN", () => {
    expect(pendingLabel(Number.NaN)).toBe(`生成中 0s · ${PENDING_MESSAGES[0]}`);
    expect(pendingLabel(-3)).toBe(`生成中 0s · ${PENDING_MESSAGES[0]}`);
  });
});

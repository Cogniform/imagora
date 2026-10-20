import { describe, expect, it } from "vitest";

import { rankByName } from "./rankByName";

/** 只有 name 的候选项简写。 */
function names(...values: string[]): { name: string }[] {
  return values.map((name) => ({ name }));
}

/** 取排序结果的 name 序列，断言可读些。 */
function order(items: readonly { name: string }[]): string[] {
  return items.map((item) => item.name);
}

describe("rankByName", () => {
  it("空 query 原样返回，且是同一个数组引用", () => {
    const items = names("gpt-image-2.5", "gpt-image-2.5-flare");
    expect(rankByName(items, "")).toBe(items);
  });

  it("前缀命中排在中间命中之前", () => {
    // `flare` 是 "flare" 的前缀、只是 "gpt-image-2.5-flare" 的中间命中
    const items = names("gpt-image-2.5-flare", "flare");
    expect(order(rankByName(items, "flare"))).toEqual(["flare", "gpt-image-2.5-flare"]);
  });

  it("query = flare 时 -flare 那条在前（另一条不含 flare 被过滤）", () => {
    const items = names("gpt-image-2.5", "gpt-image-2.5-flare");
    expect(order(rankByName(items, "flare"))).toEqual(["gpt-image-2.5-flare"]);
  });

  it("有序子序列命中：query = gi25 能命中 gpt-image-2.5", () => {
    const items = names("gpt-image-2.5", "seedream-5-0-pro");
    expect(order(rankByName(items, "gi25"))).toEqual(["gpt-image-2.5"]);
  });

  it("不匹配的项被过滤掉", () => {
    const items = names("gpt-image-2.5", "gpt-image-2.5-flare", "seedream-5-0-pro");
    expect(order(rankByName(items, "zzz"))).toEqual([]);
  });

  it("同分时保持输入顺序（源顺序是最后一级 tiebreak）", () => {
    // 三个名字形状完全一样 → 分数相同，只能靠源顺序定先后
    const items = names("x-beta", "x-alpha", "x-gamma");
    expect(order(rankByName(items, "x"))).toEqual(["x-beta", "x-alpha", "x-gamma"]);
  });

  it("label 作为第二搜索键：name 不匹配但 label 匹配时也能命中", () => {
    const items = [
      { name: "gpt-image-2.5", label: "图片生成 2.5" },
      { name: "seedream-5-0-pro", label: "豆包 5.0 pro" },
    ];
    expect(order(rankByName(items, "豆包"))).toEqual(["seedream-5-0-pro"]);
  });

  it("全角连字符归一化：item 用 U+2011、query 用半角 - 也能命中", () => {
    const items = names("gpt\u2011image\u20112.5");
    expect(order(rankByName(items, "gpt-image"))).toEqual(["gpt\u2011image\u20112.5"]);
  });

  it("全角连字符归一化：item 用半角 -、query 用 U+2011 也能命中", () => {
    const items = names("gpt-image-2.5");
    expect(order(rankByName(items, "gpt\u2011image"))).toEqual(["gpt-image-2.5"]);
  });

  it("分隔符边界加分：query 2 在 gpt-image-2.5 里比在 gpt-image2.5 里排得更靠前", () => {
    // 故意把「无边界」那条放前面，靠排序把它翻到后面才算真加分
    const items = names("gpt-image2.5", "gpt-image-2.5");
    expect(order(rankByName(items, "2"))).toEqual(["gpt-image-2.5", "gpt-image2.5"]);
  });
});

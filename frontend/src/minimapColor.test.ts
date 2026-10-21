import { describe, expect, it } from "vitest";

import { minimapNodeColor } from "./minimapColor";

describe("小地图节点取色", () => {
  it("提示词节点用品牌色变量（跟随主体色，不写死十六进制）", () => {
    expect(minimapNodeColor({ type: "prompt" })).toBe("var(--color-brand)");
  });

  it("图片节点用中性深灰", () => {
    expect(minimapNodeColor({ type: "image" })).toBe("#7c8994");
  });

  it("图片组节点用中性浅灰", () => {
    expect(minimapNodeColor({ type: "group" })).toBe("#c4ccd4");
  });

  it("未知类型走中灰兜底，不抛错", () => {
    expect(minimapNodeColor({ type: "note" })).toBe("#a8b0b8");
  });

  it("type 缺失（旧工作流文件）同样走兜底", () => {
    expect(minimapNodeColor({})).toBe("#a8b0b8");
  });

  it("三类节点的取色互不相同，缩略图上可分辨", () => {
    const colors = ["prompt", "image", "group"].map((type) => minimapNodeColor({ type }));
    expect(new Set(colors).size).toBe(3);
  });
});

// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { dataUrlToFile, derivedImageName, derivedImageSeries } from "./dataUrlFile";

/** 1×1 透明 PNG 的 base64（固定值，避免测试里再依赖 canvas） */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("dataUrlToFile", () => {
  it("把 base64 PNG data URL 还原成带正确 MIME 的 File", async () => {
    const file = dataUrlToFile(`data:image/png;base64,${TINY_PNG_BASE64}`, "crop-x.png");
    expect(file.name).toBe("crop-x.png");
    expect(file.type).toBe("image/png");
    // 解码后的字节数应与 base64 长度吻合（1×1 PNG 约 68 字节）
    expect(file.size).toBeGreaterThan(50);
    const head = new Uint8Array(await file.arrayBuffer()).slice(0, 8);
    // PNG 魔数：89 50 4E 47 0D 0A 1A 0A
    expect([...head]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it("容忍 base64 段里的换行与空白", () => {
    const wrapped = `${TINY_PNG_BASE64.slice(0, 20)}\n${TINY_PNG_BASE64.slice(20)}`;
    const file = dataUrlToFile(`data:image/png;base64,${wrapped}`, "a.png");
    expect(file.size).toBeGreaterThan(50);
  });

  it("缺 MIME 时回退成 image/png", () => {
    const file = dataUrlToFile(`data:;base64,${TINY_PNG_BASE64}`, "a.png");
    expect(file.type).toBe("image/png");
  });

  it("支持百分号编码的 data URL（非 base64）", () => {
    const file = dataUrlToFile("data:image/svg+xml,%3Csvg%3E%3C/svg%3E", "a.svg");
    expect(file.type).toBe("image/svg+xml");
    expect(file.size).toBe(11);
  });

  it("非法 data URL 抛错，不返回空 File", () => {
    expect(() => dataUrlToFile("https://example.com/a.png", "a.png")).toThrow("不是合法的 data URL");
    expect(() => dataUrlToFile("data:image/png;base64,", "a.png")).toThrow("data URL 内容为空");
    expect(() => dataUrlToFile("data:image/png;base64,!!!!", "a.png")).toThrow("非法字符");
  });
});

describe("derivedImageName", () => {
  const at = new Date(2026, 9, 20, 13, 4, 5);

  it("形如 crop-原名-YYYYMMDD-HHmmss.png", () => {
    expect(derivedImageName("红苹果.png", "crop", at)).toBe("crop-红苹果-20261020-130405.png");
  });

  it("放大前缀是 upscale，且扩展名统一成 png（canvas 只导出 png）", () => {
    expect(derivedImageName("photo.jpeg", "upscale", at)).toBe("upscale-photo-20261020-130405.png");
  });

  it("没有扩展名也能处理", () => {
    expect(derivedImageName("plain", "crop", at)).toBe("crop-plain-20261020-130405.png");
  });

  it("清掉 Windows 文件名禁用字符，避免写盘失败", () => {
    const name = derivedImageName('a/b:c*d?e"f<g>h|i.png', "crop", at);
    expect(name).not.toMatch(/[\\/:*?"<>|]/);
    expect(name).toContain("crop-");
  });

  it("超长原名截到 40 字符以内，保留时间戳", () => {
    const long = `${"长".repeat(80)}.png`;
    const name = derivedImageName(long, "crop", at);
    // "crop-" (5) + 原名截断 (40) + "-" (1) + 时间戳 (15) + ".png" (4) = 65
    expect(name.length).toBe(65);
    expect(name.endsWith("-20261020-130405.png")).toBe(true);
  });

  it("空名字回退成 image", () => {
    expect(derivedImageName("", "crop", at)).toBe("crop-image-20261020-130405.png");
    expect(derivedImageName("   .png", "crop", at)).toBe("crop-image-20261020-130405.png");
  });
});

describe("derivedImageSeries", () => {
  const at = new Date(2026, 9, 20, 13, 4, 5);

  it("按顺序给出带序号的文件名，序号从 1 开始", () => {
    expect(derivedImageSeries("红苹果.png", "split", 3, at)).toEqual([
      "split-红苹果-20261020-130405-1.png",
      "split-红苹果-20261020-130405-2.png",
      "split-红苹果-20261020-130405-3.png",
    ]);
  });

  it("同批次内文件名互不相同（时间戳只到秒，序号是唯一去重手段）", () => {
    const names = derivedImageSeries("photo.png", "split", 9, at);
    expect(new Set(names).size).toBe(9);
  });

  it("数量为 0 或非法时返回空数组（不产出一张没名字的图）", () => {
    expect(derivedImageSeries("a.png", "split", 0, at)).toEqual([]);
    expect(derivedImageSeries("a.png", "split", Number.NaN, at)).toEqual([]);
    expect(derivedImageSeries("a.png", "split", -3, at)).toEqual([]);
  });

  it("数量带小数时向下取整（切出 4.7 张没有意义）", () => {
    expect(derivedImageSeries("a.png", "split", 2.9, at)).toHaveLength(2);
  });

  it("清掉禁用字符并保留回退名", () => {
    const names = derivedImageSeries('a/b:c*d.png', "split", 2, at);
    expect(names).toHaveLength(2);
    for (const name of names) {
      expect(name).not.toMatch(/[\\/:*?"<>|]/);
    }
    expect(derivedImageSeries("", "split", 1, at)).toEqual(["split-image-20261020-130405-1.png"]);
  });
});

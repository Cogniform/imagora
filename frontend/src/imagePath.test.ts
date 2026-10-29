import { describe, expect, it } from "vitest";

import { imagePathFromUrl } from "./imagePath";

/**
 * 回归测试：预览弹窗的「复制路径」要从注册表派生的 url 反解出本机绝对路径。
 * url 形态单一（见 core/registry.py:image_url），但三种「没有路径」的情况必须返回空串 ——
 * 调用方靠它决定按钮出不出，返回垃圾字符串就会给出一个点了没用的按钮。
 */
describe("imagePathFromUrl", () => {
  it("解出 Windows 绝对路径（中文与反斜杠都已编码）", () => {
    const url = `/api/image?path=${encodeURIComponent("D:\\我的图\\产品\\a.png")}`;
    expect(imagePathFromUrl(url)).toBe("D:\\我的图\\产品\\a.png");
  });

  it("保留 URL 里其它参数时的顺序无关性", () => {
    const encoded = encodeURIComponent("E:\\out\\b.png");
    expect(imagePathFromUrl(`/api/image?v=1&path=${encoded}`)).toBe("E:\\out\\b.png");
  });

  it("没有查询串 / 没有 path 参数 -> 空串", () => {
    expect(imagePathFromUrl("/api/image")).toBe("");
    expect(imagePathFromUrl("/api/image?v=1")).toBe("");
  });

  it("外链与 blob/data 占位图 -> 空串（不给出可点的「复制路径」）", () => {
    expect(imagePathFromUrl("https://example.com/a.png")).toBe("");
    expect(imagePathFromUrl("blob:http://127.0.0.1:7860/abc")).toBe("");
    expect(imagePathFromUrl("data:image/png;base64,AAAA")).toBe("");
  });

  it("空输入不抛错", () => {
    expect(imagePathFromUrl("")).toBe("");
  });
});

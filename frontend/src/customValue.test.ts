import { describe, expect, it } from "vitest";

import {
  isKnownValue,
  mergeCustomOption,
  normalizeCustomValue,
  validateCustomValue,
  type CustomValueOption,
} from "./customValue";

/** 造一条选项；不传 group 就是普通业务选项（eOPT 下不能显式写 group: undefined）。 */
function opt(value: string, group?: { id: string; label: string }): CustomValueOption {
  return { value, label: value, ...(group ? { group } : {}) };
}

const SIZES = [opt("1024x1024"), opt("1792x1024"), opt("1024x1792")];

describe("normalizeCustomValue", () => {
  it("去掉首尾空白", () => {
    expect(normalizeCustomValue("  1280x720  ")).toBe("1280x720");
    expect(normalizeCustomValue("\t1280x720\n")).toBe("1280x720");
  });

  it("把中间连续的空白折成一个半角空格", () => {
    expect(normalizeCustomValue("1280   x   720")).toBe("1280 x 720");
    expect(normalizeCustomValue("a\t\tb\n\nc")).toBe("a b c");
  });

  it("全角空格（U+3000）也算空白，一并折掉", () => {
    // 中文输入法下顺手敲出的全角空格是噪声，不是标识的一部分
    expect(normalizeCustomValue("\u30001280x720\u3000")).toBe("1280x720");
    expect(normalizeCustomValue("1280\u3000x\u3000720")).toBe("1280 x 720");
  });

  it("纯空白归一成空串", () => {
    expect(normalizeCustomValue("")).toBe("");
    expect(normalizeCustomValue("   ")).toBe("");
    expect(normalizeCustomValue("\t\n\u3000")).toBe("");
  });

  it("**不做大小写归一**（模型 ID 大小写敏感，改了就是发错请求）", () => {
    // 这条是硬约束：谁「顺手」加个 toLowerCase，这里立刻红
    expect(normalizeCustomValue("  Dall-E-3  ")).toBe("Dall-E-3");
    expect(normalizeCustomValue("GPT-Image-2.5")).toBe("GPT-Image-2.5");
  });

  it("不改写非空白字符（全角连字符原样保留，折叠是比对层的事）", () => {
    // apiCatalog.foldModelId 只在**比对**时折叠；要提交的字符串必须原样保留用户输入
    const fullWidthHyphen = "gpt\u2011image\u20112.5";
    expect(normalizeCustomValue(`  ${fullWidthHyphen}  `)).toBe(fullWidthHyphen);
  });
});

describe("isKnownValue", () => {
  it("命中清单里的值", () => {
    expect(isKnownValue(SIZES, "1792x1024")).toBe(true);
  });

  it("不在清单里返回 false", () => {
    expect(isKnownValue(SIZES, "1280x720")).toBe(false);
  });

  it("空清单永远 false", () => {
    expect(isKnownValue([], "anything")).toBe(false);
  });

  it("大小写敏感：清单里是 abc，查 ABC 不算命中", () => {
    // 与 normalizeCustomValue 同一条理由：标识的大小写是上游的一部分
    expect(isKnownValue([opt("abc")], "ABC")).toBe(false);
    expect(isKnownValue([opt("abc")], "abc")).toBe(true);
  });
});

describe("mergeCustomOption", () => {
  it("值已在清单里时返回**原数组引用**（避免每次渲染都造新数组，Select 的 useMemo 才不会全失效）", () => {
    expect(mergeCustomOption(SIZES, "1792x1024")).toBe(SIZES);
  });

  it("值不在清单里时追加到**末尾**，并挂上「自定义」分组", () => {
    const merged = mergeCustomOption(SIZES, "1280x720");
    expect(merged).toHaveLength(SIZES.length + 1);
    expect(merged[merged.length - 1]).toEqual({
      value: "1280x720",
      label: "1280x720",
      group: { id: "__custom", label: "自定义" },
    });
    // 顺序不能变：新值在最后，原清单原样在前面
    expect(merged.slice(0, SIZES.length)).toEqual(SIZES);
  });

  it("先归一化再比对：带空白的已有值不算新值", () => {
    expect(mergeCustomOption(SIZES, "  1024x1024  ")).toBe(SIZES);
  });

  it("空值 / 纯空白时返回原数组引用（没东西可加）", () => {
    expect(mergeCustomOption(SIZES, "")).toBe(SIZES);
    expect(mergeCustomOption(SIZES, "   ")).toBe(SIZES);
    expect(mergeCustomOption([], "")).toEqual([]);
  });

  it("追加的是归一化后的值，不是原始输入", () => {
    const merged = mergeCustomOption([], "  1280   x  720  ");
    expect(merged).toEqual([
      { value: "1280 x 720", label: "1280 x 720", group: { id: "__custom", label: "自定义" } },
    ]);
  });

  it("不修改入参数组（纯函数）", () => {
    const source: CustomValueOption[] = [opt("a")];
    const merged = mergeCustomOption(source, "b");
    expect(source).toHaveLength(1);
    expect(merged).toHaveLength(2);
  });

  it("空清单 + 非空值：得到只有一条自定义选项的数组", () => {
    expect(mergeCustomOption([], "auto")).toEqual([
      { value: "auto", label: "auto", group: { id: "__custom", label: "自定义" } },
    ]);
  });
});

describe("validateCustomValue", () => {
  it("空串被拒，理由是「不能为空」", () => {
    expect(validateCustomValue("")).toEqual({ ok: false, reason: "不能为空" });
  });

  it("纯空白被拒，理由同上", () => {
    expect(validateCustomValue("   \t\n\u3000 ")).toEqual({ ok: false, reason: "不能为空" });
  });

  it("通过时返回**归一化后**的值（调用方直接拿去提交）", () => {
    expect(validateCustomValue("  1280x720  ")).toEqual({ ok: true, value: "1280x720" });
  });

  it("长度按归一化后算：首尾空白不计入，64 字符通过", () => {
    const exact = "a".repeat(64);
    expect(validateCustomValue(`  ${exact}  `)).toEqual({ ok: true, value: exact });
  });

  it("65 字符被拒，理由是「太长」", () => {
    expect(validateCustomValue("a".repeat(65))).toEqual({ ok: false, reason: "太长" });
  });

  it("**不做格式校验**：尺寸、模型 ID、中文、带 @ 的别名都放行", () => {
    // 不同上游的格式差得远，前端一旦猜错就会拦掉合法值 —— 那比放过错值更糟
    for (const raw of ["1280x720", "1024*768", "gpt-image-2.5", "doubao-seedream-3-0-t2i", "自定义尺寸", "vendor@model:1", "auto", "16:9"]) {
      expect(validateCustomValue(raw), raw).toEqual({ ok: true, value: raw });
    }
  });
});

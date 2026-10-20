import { describe, expect, it } from "vitest";

import { findModel, findProvider, foldModelId, formatCost, priceHint, priceSummary, qualityAppliesTo, resolveSizes } from "./apiCatalog";
import type { ProviderCatalog, SizeOption } from "./types";

/** 火山方舟官方：0.2 / 0.3 元 */
const VOLC: ProviderCatalog = {
  name: "volc",
  label: "火山方舟官方",
  baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  apiPath: "/images/generations",
  defaultModel: "doubao-seedream-5-0-pro-260628",
  sizes: [{ value: "1024x1024", label: "1024x1024 (1:1 1K)", cost: 0.2 }],
  models: [
    {
      id: "doubao-seedream-5-0-pro-260628",
      label: "Seedream 5.0 pro",
      output_formats: ["png"],
      ratios: {},
      size_options: [
        { value: "1024x1024", label: "1024x1024 (1:1 1K)", cost: 0.2 },
        { value: "2048x2048", label: "2048x2048 (1:1 2K)", cost: 0.2 },
      ],
    },
  ],
};

/** wanwu 中转站：0.05 / 0.1 元（与官方必须分家） */
const WANWU: ProviderCatalog = {
  name: "wanwu",
  label: "aiwanwu 中转站",
  baseUrl: "https://2api.aiwanwu.cc",
  apiPath: "/v1/images/generations",
  defaultModel: "gpt-image-2.5-flare",
  sizes: [
    { value: "1024x1024", label: "1024x1024 (1:1 1K)", cost: 0.05 },
    { value: "2048x2048", label: "2048x2048 (1:1 2K)", cost: 0.1 },
  ],
  models: [
    {
      id: "gpt-image-2.5-flare",
      label: "GPT Image 2.5 Flare",
      output_formats: ["png"],
      ratios: {},
      size_options: [
        { value: "1024x1024", label: "1024x1024 (1:1 1K)", cost: 0.05 },
        { value: "2048x2048", label: "2048x2048 (1:1 2K)", cost: 0.1 },
      ],
    },
    {
      // 中转站只登记了全角连字符 ID —— 用户手打半角时也必须能命中
      id: "gpt\u2011image\u20112",
      label: "GPT Image 2",
      output_formats: ["png"],
      ratios: {},
      size_options: [{ value: "1024x1024", label: "1024x1024 (1:1 1K)", cost: 0.05 }],
    },
    {
      id: "no-size-model",
      label: "无自带尺寸的模型",
      output_formats: ["png"],
      ratios: {},
      size_options: [],
    },
  ],
};

const CATALOG = [VOLC, WANWU];
const OTHER: SizeOption[] = [{ value: "1024x1024", label: "1024x1024 (1:1)", cost: 9.9 }];

describe("findProvider", () => {
  it("按地址命中来源（忽略尾斜杠与大小写）", () => {
    expect(findProvider(CATALOG, "https://2api.aiwanwu.cc/")?.name).toBe("wanwu");
    expect(findProvider(CATALOG, "HTTPS://2API.AIWANWU.CC")?.name).toBe("wanwu");
  });

  it("未登记的地址 / 空目录 → undefined（不猜来源）", () => {
    expect(findProvider(CATALOG, "https://my-relay.example.com")).toBeUndefined();
    expect(findProvider(undefined, "https://2api.aiwanwu.cc")).toBeUndefined();
    expect(findProvider(CATALOG, "")).toBeUndefined();
  });
});

describe("foldModelId", () => {
  it("各类连字符折叠成半角 -（U+2011 与 U+002D 肉眼无差别）", () => {
    expect(foldModelId("gpt\u2011image\u20112")).toBe("gpt-image-2");
    expect(foldModelId("gpt-image-2")).toBe("gpt-image-2");
    expect(foldModelId(null)).toBe("");
  });
});

describe("findModel", () => {
  it("按 id 找到模型与它所属的来源", () => {
    expect(findModel(CATALOG, "gpt-image-2.5-flare")?.provider.name).toBe("wanwu");
  });

  it("全角 ID 的配置能被半角输入命中（反之亦然）", () => {
    expect(findModel(CATALOG, "gpt-image-2")?.model.label).toBe("GPT Image 2");
  });

  it("同名模型优先当前来源", () => {
    const dup: ProviderCatalog = { ...WANWU, name: "dup", models: [{ ...WANWU.models[0]!, id: "doubao-seedream-5-0-pro-260628" }] };
    expect(findModel([VOLC, dup], "doubao-seedream-5-0-pro-260628", "dup")?.provider.name).toBe("dup");
    expect(findModel([VOLC, dup], "doubao-seedream-5-0-pro-260628")?.provider.name).toBe("volc");
  });

  it("空 id / 未登记模型 → undefined", () => {
    expect(findModel(CATALOG, "")).toBeUndefined();
    expect(findModel(CATALOG, "unknown-model")).toBeUndefined();
  });
});

describe("resolveSizes", () => {
  it("回归：切到中转站地址 → 拿中转站的价，而不是 default_profile 的 0.2", () => {
    const sizes = resolveSizes({
      providers: CATALOG,
      baseUrl: "https://2api.aiwanwu.cc",
      modelId: "gpt-image-2.5-flare",
      fallbackSizes: VOLC.sizes,
    });
    expect(sizes.map((s) => s.cost)).toEqual([0.05, 0.1]);
  });

  it("用官方地址 → 官方的价", () => {
    const sizes = resolveSizes({
      providers: CATALOG,
      baseUrl: VOLC.baseUrl,
      modelId: VOLC.defaultModel,
      fallbackSizes: WANWU.sizes,
    });
    expect(sizes.map((s) => s.cost)).toEqual([0.2, 0.2]);
  });

  it("模型未自带尺寸 → 回退来源级尺寸；模型未知但来源已知 → 也用来源级", () => {
    const byModel = resolveSizes({ providers: CATALOG, baseUrl: WANWU.baseUrl, modelId: "no-size-model" });
    expect(byModel).toEqual(WANWU.sizes);
    const byProvider = resolveSizes({ providers: CATALOG, baseUrl: WANWU.baseUrl, modelId: "unknown" });
    expect(byProvider).toEqual(WANWU.sizes);
  });

  it("地址未登记但模型全库可查 → 用该模型的尺寸（我的接口 常跨来源）", () => {
    const sizes = resolveSizes({
      providers: CATALOG,
      baseUrl: "https://my-relay.example.com",
      modelId: "gpt-image-2.5-flare",
      fallbackSizes: OTHER,
    });
    expect(sizes.map((s) => s.cost)).toEqual([0.05, 0.1]);
  });

  it("地址与模型都认不出 → 回退后端 sizes；没有兜底则返空（宁可不显示也不标错价）", () => {
    expect(
      resolveSizes({ providers: CATALOG, baseUrl: "https://x.example.com", modelId: "nope", fallbackSizes: OTHER }),
    ).toEqual(OTHER);
    expect(resolveSizes({ providers: CATALOG, baseUrl: "https://x.example.com", modelId: "nope" })).toEqual([]);
  });
});

describe("金额文案", () => {
  it("formatCost 去掉浮点尾巴（0.10 → 0.1）", () => {
    expect(formatCost(0.1)).toBe("0.1");
    expect(formatCost(0.05)).toBe("0.05");
    expect(formatCost(0.30000000000000004)).toBe("0.3");
  });

  it("priceSummary 去重升序：0.05 / 0.1 元/张", () => {
    expect(priceSummary([...WANWU.sizes, { value: "2048x2048", label: "x", cost: 0.05 }])).toBe("0.05 / 0.1 元/张");
    expect(priceSummary([])).toBe("");
  });

  it("priceHint 单档只报一次，多档给出区间", () => {
    expect(priceHint([{ value: "a", label: "a", cost: 0.2 }])).toBe("计价 0.2 元/张");
    expect(priceHint([...WANWU.sizes])).toBe("计价 0.05 元/张 起，最高 0.1 元/张");
    expect(priceHint([])).toBe("");
  });
});

describe("qualityAppliesTo", () => {
  it("豆包 Seedream 不认质量参数（模型名前缀判定，大小写与空白无关）", () => {
    expect(qualityAppliesTo("doubao-seedream-5-0-pro-260628", VOLC.baseUrl)).toBe(false);
    expect(qualityAppliesTo("  Doubao-Seedream-4-0  ", "https://example.com")).toBe(false);
    // 中转站若代理豆包模型，上游照样没有这个参数 → 仍应隐藏
    expect(qualityAppliesTo("doubao-seedream-5-0-pro-260628", WANWU.baseUrl)).toBe(false);
  });

  it("中转站 / 自定义 OpenAI 兼容地址认质量参数", () => {
    expect(qualityAppliesTo("gpt-image-2.5-flare", WANWU.baseUrl)).toBe(true);
    expect(qualityAppliesTo("gpt-image-1", "https://my-relay.example.com")).toBe(true);
    expect(qualityAppliesTo("", "")).toBe(true);
  });

  it("模型名认不出时，火山官方地址兜底判为不认", () => {
    expect(qualityAppliesTo("", VOLC.baseUrl)).toBe(false);
    expect(qualityAppliesTo("some-alias", VOLC.baseUrl)).toBe(false);
  });
});

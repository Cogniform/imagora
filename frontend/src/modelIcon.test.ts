import { describe, expect, it } from "vitest";

import { MODEL_BRAND_GLYPH, modelBrand, modelBrandLabel, type ModelBrand } from "./modelIcon";

const ALL_BRANDS: ModelBrand[] = [
  "anthropic",
  "openai",
  "google",
  "deepseek",
  "glm",
  "qwen",
  "midjourney",
  "flux",
  "unknown",
];

describe("modelBrand：家族识别", () => {
  // 下面这些 ID 全部抄自真实上游返回（火山方舟 / wanwu 中转站 / 官方 API），
  // 不是构造出来的样例 —— 规则必须对得上它们。
  it("claude / anthropic → anthropic", () => {
    expect(modelBrand("claude-3-5-sonnet")).toBe("anthropic");
    expect(modelBrand("claude-opus-4-1")).toBe("anthropic");
    expect(modelBrand("anthropic.claude-3-haiku")).toBe("anthropic");
  });

  it("gemini / imagen / veo → google", () => {
    expect(modelBrand("gemini-2.0-flash")).toBe("google");
    expect(modelBrand("imagen-4.0-generate-001")).toBe("google");
    expect(modelBrand("veo-3.0-generate")).toBe("google");
    expect(modelBrand("models/gemini-2.5-pro")).toBe("google");
  });

  it("deepseek → deepseek", () => {
    expect(modelBrand("deepseek-v4")).toBe("deepseek");
    expect(modelBrand("deepseek-chat")).toBe("deepseek");
  });

  it("glm / chatglm / zhipu → glm", () => {
    expect(modelBrand("glm-5.3")).toBe("glm");
    expect(modelBrand("chatglm3-6b")).toBe("glm");
    expect(modelBrand("zhipu-glm-4")).toBe("glm");
  });

  it("qwen / qwq / tongyi → qwen", () => {
    expect(modelBrand("qwen-max")).toBe("qwen");
    expect(modelBrand("qwen-image-edit")).toBe("qwen");
    expect(modelBrand("qwq-32b")).toBe("qwen");
    expect(modelBrand("tongyi-wanx")).toBe("qwen");
  });

  it("midjourney → midjourney", () => {
    expect(modelBrand("midjourney-v6")).toBe("midjourney");
    expect(modelBrand("Midjourney-v7")).toBe("midjourney");
  });

  it("flux → flux", () => {
    expect(modelBrand("flux-pro-1.1")).toBe("flux");
    expect(modelBrand("flux-kontext-max")).toBe("flux");
  });

  it("gpt / dall-e / sora / codex → openai", () => {
    expect(modelBrand("gpt-image-2.5")).toBe("openai");
    expect(modelBrand("gpt-image-2.5-flare")).toBe("openai");
    expect(modelBrand("dall-e-3")).toBe("openai");
    expect(modelBrand("dalle-3")).toBe("openai");
    expect(modelBrand("sora-2")).toBe("openai");
    expect(modelBrand("codex-mini-latest")).toBe("openai");
  });

  it("认不出的 ID → unknown（自建来源可以填任意名字，不许报错）", () => {
    expect(modelBrand("my-private-model")).toBe("unknown");
    expect(modelBrand("sdxl-turbo")).toBe("unknown");
    expect(modelBrand("some-vendor-v1")).toBe("unknown");
  });

  it("空串 / 纯空白 → unknown", () => {
    expect(modelBrand("")).toBe("unknown");
    expect(modelBrand("   ")).toBe("unknown");
    expect(modelBrand("\t\n")).toBe("unknown");
  });
});

describe("modelBrand：大小写与连字符归一化", () => {
  it("大写 ID 也认（比较前统一小写）", () => {
    expect(modelBrand("GPT-4O")).toBe("openai");
    expect(modelBrand("Claude-3-Opus")).toBe("anthropic");
    expect(modelBrand("FLUX-PRO")).toBe("flux");
  });

  it("全角连字符 U+2011 归一化后仍能认出（本项目踩过的真实坑）", () => {
    // 中转站把 gpt‑image‑2.5 登记成 U+2011（非断行连字符），肉眼与键盘的 - 毫无区别。
    // 不做 foldModelId 归一化的话 gpt 匹配不到，图标会静默退化成 unknown。
    expect(modelBrand("gpt\u2011image\u20112.5")).toBe("openai");
    expect(modelBrand("midjourney\u2011v6")).toBe("midjourney");
    expect(modelBrand("claude\u20113\u20115\u2011sonnet")).toBe("anthropic");
  });

  it("其它横线变体（U+2013 短破折 / U+2014 长破折 / U+FF0D 全角减号）同样归一化", () => {
    expect(modelBrand("gpt\u2013image\u20132")).toBe("openai");
    expect(modelBrand("gpt\u2014image\u20142")).toBe("openai");
    expect(modelBrand("gpt\uff0dimage\uff0d2")).toBe("openai");
  });
});

describe("modelBrand：短标记的词边界（避免误判）", () => {
  it("mj 只在词边界算 Midjourney", () => {
    expect(modelBrand("mj-v6")).toBe("midjourney");
    expect(modelBrand("mj_v6")).toBe("midjourney");
    expect(modelBrand("mj")).toBe("midjourney");
    // 裸 includes("mj") 会把这两个认成 Midjourney
    expect(modelBrand("mjpeg-encoder")).toBe("unknown");
    expect(modelBrand("imjunk")).toBe("unknown");
  });

  it("o1 / o3 / o4 也走词边界（否则 info1 会被认成 OpenAI）", () => {
    expect(modelBrand("o3-mini")).toBe("openai");
    expect(modelBrand("o4-mini-high")).toBe("openai");
    expect(modelBrand("info1")).toBe("unknown");
    expect(modelBrand("foo3bar")).toBe("unknown");
  });
});

describe("modelBrand：优先级（命中即止，具体家族优先于宽泛的 openai）", () => {
  it("同时含 gpt 与更具体的家族名时，按规则表顺序给更具体的那个", () => {
    // 中转站常见写法：渠道前缀 + 真实家族名
    expect(modelBrand("gpt-claude-proxy")).toBe("anthropic");
    expect(modelBrand("gpt-gemini-bridge")).toBe("google");
  });

  it("veo / imagen 不被认成 openai（虽然都出现在同一批清单里）", () => {
    expect(modelBrand("veo-3.0")).toBe("google");
    expect(modelBrand("imagen-4")).toBe("google");
  });
});

describe("MODEL_BRAND_GLYPH", () => {
  it("每个品牌都有非空字形", () => {
    for (const brand of ALL_BRANDS) {
      expect(MODEL_BRAND_GLYPH[brand], `${brand} 缺字形`).toBeTruthy();
    }
  });

  it("字形是单个字符，且不是 emoji（emoji 在 Windows 上字形/基线不一致）", () => {
    for (const brand of ALL_BRANDS) {
      const glyph = MODEL_BRAND_GLYPH[brand];
      expect([...glyph], `${brand} 的字形应是单字符`).toHaveLength(1);
      const code = glyph.codePointAt(0) ?? 0;
      // 只允许 ASCII 字母与 U+00B7（中点）；emoji 与图形符号都在 U+2000 以上
      expect(code, `${brand} 的字形 ${glyph} 落在 emoji/符号区`).toBeLessThan(0x2000);
    }
  });

  it("各品牌字形互不相同（否则列表里分不出谁是谁）", () => {
    const glyphs = ALL_BRANDS.map((brand) => MODEL_BRAND_GLYPH[brand]);
    expect(new Set(glyphs).size).toBe(ALL_BRANDS.length);
  });
});

describe("modelBrandLabel", () => {
  it("每个品牌都有非空中文名", () => {
    for (const brand of ALL_BRANDS) {
      const label = modelBrandLabel(brand);
      expect(typeof label, `${brand} 的名字不是字符串`).toBe("string");
      expect(label.length, `${brand} 缺名字`).toBeGreaterThan(0);
    }
  });

  it("几个关键品牌的名字对得上（给 title 用，写错会误导用户）", () => {
    expect(modelBrandLabel("anthropic")).toBe("Anthropic");
    expect(modelBrandLabel("openai")).toBe("OpenAI");
    expect(modelBrandLabel("google")).toBe("Google");
    expect(modelBrandLabel("deepseek")).toBe("DeepSeek");
    expect(modelBrandLabel("glm")).toBe("智谱 GLM");
    expect(modelBrandLabel("qwen")).toBe("通义千问");
    expect(modelBrandLabel("midjourney")).toBe("Midjourney");
    expect(modelBrandLabel("flux")).toBe("Flux");
    expect(modelBrandLabel("unknown")).toBe("未知");
  });
});

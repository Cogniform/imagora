/**
 * 「这个模型是谁家的」—— 从模型 ID 猜品牌，给下拉列表配一个单字符小徽标。
 *
 * ## 为什么要它
 *
 * 中转站探出来的清单动辄几十上百个 ID（`gpt-image-2.5` / `dall-e-3` /
 * `gemini-2.0-flash` / `deepseek-v4` …），纯文字列表只能靠逐个读 ID 分辨厂商。
 * 一个字母的小徽标不占横向空间，扫一眼就能把同一家的模型聚成一片。
 *
 * ## 为什么是「猜」而不是查表
 *
 * 上游清单里没有任何品牌字段，只有 ID 字符串；而且来源可以是用户手填的任意
 * OpenAI 兼容地址（`my-private-model` 这种也合法）。所以这里只能做**启发式**，
 * 认不出就老实返回 `unknown` —— 宁可显示一个中点，也不要硬套一个错的品牌。
 *
 * ## 两个必须记住的坑
 *
 * 1. **全角连字符**：中转站把 `gpt‑image‑2.5` 登记成 U+2011（非断行连字符），
 *    肉眼与键盘打出的 `-` 毫无区别。必须先过 `foldModelId` 归一化，否则
 *    `includes("gpt")` 直接落空，图标静默退化成 unknown。同一套折叠规则
 *    后端 `core/config.py` 与 `apiCatalog.ts` 已经在用，这里复用同一份实现。
 * 2. **短标记要卡词边界**：`mj`（Midjourney）、`o1`/`o3`/`o4`（OpenAI 推理模型）
 *    都只有两个字符，裸 `includes` 会把 `mjpeg-encoder` 认成 Midjourney、
 *    把 `info1` 认成 OpenAI。所以这几个走「前后非字母数字」的边界匹配。
 *
 * 纯函数模块，不碰 DOM，有同名单测。
 */

import { foldModelId } from "./apiCatalog";

/** 支持的品牌（顺序即匹配优先级：越具体的越靠前） */
export type ModelBrand =
  | "anthropic"
  | "openai"
  | "google"
  | "deepseek"
  | "glm"
  | "qwen"
  | "midjourney"
  | "flux"
  | "unknown";

/**
 * 品牌图标要用的单字符字形。
 *
 * 只用 ASCII 大写字母 + 一个中点，**不用 emoji**：emoji 在 Windows 上的字形、
 * 基线与字号都和正文不一致，塞进 9px 的小方块里会糊成一团。单字符还有个好处是
 * 不需要任何图标库 —— 项目零新增依赖。
 *
 * `unknown` 也给了字形（`·`）而不是留空：列表里有一行没图标会显得整列错位。
 */
export const MODEL_BRAND_GLYPH: Record<ModelBrand, string> = {
  anthropic: "A",
  openai: "O",
  google: "G",
  deepseek: "D",
  glm: "Z",
  qwen: "Q",
  midjourney: "M",
  flux: "F",
  unknown: "·",
};

/** 短标记的边界匹配：前面是行首或非字母数字，且后面不再接字母。
 *
 *  `mj` 用它是为了不把 `mjpeg` 认成 Midjourney；`o1/o3/o4` 用它是为了不把
 *  `info1` / `foo3bar` 认成 OpenAI。后面放宽到「不接字母」而不是「必须是分隔符」，
 *  是为了让 `mj6` 这类写法也能命中。 */
function hasShortToken(haystack: string, token: string): boolean {
  return new RegExp(`(?:^|[^a-z0-9])${token}(?![a-z])`).test(haystack);
}

/** 从模型 ID 猜品牌。认不出返回 `unknown`（空串 / 纯空白也返回 `unknown`）。 */
export function modelBrand(modelId: string): ModelBrand {
  // 先折叠全角连字符再转小写 —— 顺序不能反，foldModelId 只做码点替换
  const id = foldModelId(modelId).trim().toLowerCase();
  if (!id) return "unknown";

  // 命中即止：越具体的家族越靠前，否则 `gpt-gemini-bridge` 会被宽泛的 `gpt` 抢走
  if (id.includes("claude") || id.includes("anthropic")) return "anthropic";
  if (
    id.includes("gemini") ||
    id.includes("google") ||
    id.includes("imagen") ||
    id.includes("veo")
  ) {
    return "google";
  }
  if (id.includes("deepseek")) return "deepseek";
  if (id.includes("glm") || id.includes("chatglm") || id.includes("zhipu")) return "glm";
  if (id.includes("qwen") || id.includes("qwq") || id.includes("tongyi")) return "qwen";
  if (id.includes("midjourney") || hasShortToken(id, "mj")) return "midjourney";
  if (id.includes("flux")) return "flux";
  if (
    id.includes("gpt") ||
    id.includes("dall-e") ||
    id.includes("dalle") ||
    id.includes("sora") ||
    id.includes("codex") ||
    hasShortToken(id, "o1") ||
    hasShortToken(id, "o3") ||
    hasShortToken(id, "o4")
  ) {
    return "openai";
  }
  return "unknown";
}

/** 品牌的中文名（给 `title` / `aria-label` 用，写错会直接误导用户） */
const BRAND_LABEL: Record<ModelBrand, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  deepseek: "DeepSeek",
  glm: "智谱 GLM",
  qwen: "通义千问",
  midjourney: "Midjourney",
  flux: "Flux",
  unknown: "未知",
};

/** 品牌的中文名。 */
export function modelBrandLabel(brand: ModelBrand): string {
  return BRAND_LABEL[brand];
}

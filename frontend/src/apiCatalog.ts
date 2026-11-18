/**
 * 「这套 API 收多少钱、能用哪些尺寸」——按**使用中的接口地址**解析，而不是按后端
 * 的 default_profile。
 *
 * 背景（真实踩坑）：config.json 的每个 profile 自带一套 size_options —— 火山方舟
 * 官方 0.2 / 0.3 元，wanwu 中转站 0.05 / 0.1 元。个人配置只覆盖 baseUrl / model /
 * path，若尺寸下拉仍读 default_profile 那张表，切到中转站后就会出现「用着 0.05 的
 * 接口，显示 0.2 的价」，甚至列出该模型根本不支持的档位（把 1728x2304 发给
 * gpt-image 系列，上游直接报错）。后端 /api/config 的 providers 下发各来源的
 * baseUrl + sizes + models，这个模块就是那层解析——纯函数，不依赖 React。
 *
 * 解析顺序（命中即止）：
 *   1. 全库按 id 找模型（优先当前来源）→ 用模型自带的 size_options
 *   2. 按 baseUrl 命中来源 → 用来源级 sizes
 *   3. 后端下发的 sizes（兜底：来源未在 config.json 登记，如用户手填的自定义地址）
 */

import type { ModelOption, ProviderCatalog, SizeOption } from "./types";

/** 地址归一：去首尾空白、去尾斜杠、统一小写 —— 只用于比对，不改写用户填的值。 */
export function normalizeBaseUrl(url: string): string {
  return (url || "").trim().replace(/\/+$/, "").toLowerCase();
}

/** 按接口地址命中来源（个人配置切了中转站就命中中转站那个 profile）。 */
export function findProvider(
  providers: ProviderCatalog[] | undefined,
  baseUrl: string,
): ProviderCatalog | undefined {
  const target = normalizeBaseUrl(baseUrl);
  if (!target) return undefined;
  return (providers ?? []).find((p) => normalizeBaseUrl(p.baseUrl) === target);
}

/** 各种「看起来像减号」的字符（与后端 core/config.py 的 _DASH_CODEPOINTS 同一集合）。
 *  中转站的 `gpt‑image‑2.5` 用的是 U+2011，肉眼与键盘能打出的 `-` 毫无区别，
 *  不折叠就匹配不上模型，于是价格静默回退成别的来源的。 */
const DASH_CODEPOINTS = new Set([
  0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212, 0xfe58, 0xfe63, 0xff0d,
]);

/** 模型 id 的连字符折叠（仅用于比对）。 */
export function foldModelId(modelId: string | null | undefined): string {
  if (!modelId) return "";
  let out = "";
  for (const ch of modelId) {
    const code = ch.codePointAt(0) ?? 0;
    out += DASH_CODEPOINTS.has(code) ? "-" : ch;
  }
  return out;
}

/** 跨来源找模型：优先当前来源（同名模型在不同 profile 单价可能不同），
 *  再全库找 ——「我的接口」里可能存着另一家的模型（如在中转站 profile 下测豆包）。 */
export function findModel(
  providers: ProviderCatalog[] | undefined,
  modelId: string,
  preferredProviderName?: string,
): { model: ModelOption; provider: ProviderCatalog } | undefined {
  const folded = foldModelId(modelId);
  if (!folded) return undefined;
  const list = providers ?? [];
  // 当前来源提到最前（同名模型在不同 profile 下单价可能不同）
  const preferred = list.find((p) => p.name === preferredProviderName);
  const ordered = preferred ? [preferred, ...list.filter((p) => p !== preferred)] : list;
  for (const provider of ordered) {
    const model = provider.models.find((m) => foldModelId(m.id) === folded);
    if (model) return { model, provider };
  }
  return undefined;
}

export interface ResolveSizesArgs {
  providers?: ProviderCatalog[] | undefined;
  /** 使用中的接口地址（个人配置优先，否则后端 profile 的 base_url） */
  baseUrl: string;
  /** 使用中的模型 id（个人配置优先，否则后端 default_model） */
  modelId: string;
  /** 后端下发的 sizes：来源未登记时的兜底，不给就返回空（宁可少显示，也不错标价） */
  fallbackSizes?: SizeOption[] | undefined;
}

/** 解析当前生效的尺寸表（价格随之正确）。 */
export function resolveSizes({
  providers,
  baseUrl,
  modelId,
  fallbackSizes,
}: ResolveSizesArgs): SizeOption[] {
  const provider = findProvider(providers, baseUrl);
  const hit = findModel(providers, modelId, provider?.name);
  if (hit && hit.model.size_options.length) return hit.model.size_options;
  if (provider && provider.sizes.length) return provider.sizes;
  return fallbackSizes ?? [];
}

/** 金额展示：去掉浮点尾巴与无意义的 0（0.10 → 0.1，0.30000000000000004 → 0.3）。 */
export function formatCost(cost: number): string {
  return String(Math.round(cost * 10000) / 10000);
}

/** 单价摘要：「0.05 / 0.1 元/张」（去重升序）；无价目返回空串。 */
export function priceSummary(sizes: SizeOption[]): string {
  const costs = [...new Set(sizes.map((s) => s.cost))].sort((a, b) => a - b);
  if (!costs.length) return "";
  return `${costs.map(formatCost).join(" / ")} 元/张`;
}

/** 模型价格提示：「计价 0.05 元/张 起，最高 0.1 元/张」；单一档位只说一次。 */
export function priceHint(sizes: SizeOption[]): string {
  const costs = [...new Set(sizes.map((s) => s.cost))].sort((a, b) => a - b);
  if (!costs.length) return "";
  const first = formatCost(costs[0] as number);
  const last = formatCost(costs[costs.length - 1] as number);
  return costs.length > 1
    ? `计价 ${first} 元/张 起，最高 ${last} 元/张`
    : `计价 ${first} 元/张`;
}


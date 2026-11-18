/**
 * `/api` 响应的形状守卫。
 *
 * 为什么需要：`requestJson` 只保证「拿到了 JSON」，不保证「形状对」—— 后端契约一旦
 * 变化（改名 / 改类型 / 缺字段），坏数据会一路流到渲染层才炸，错误信息远离根因
 * （`windowInherit.ts` 对 sessionStorage 已做过同型守卫，这里补上网络这一侧）。
 *
 * 两条约定：
 * - **只校验消费面真正读的字段**；多出的键一律放行 —— 后端新增字段不该让前端报错；
 * - 谓词用 `value is T` 收窄，调用处因此不需要断言（见 `api.ts` 的 `requestJson`）。
 */

import type { GenerationHistoryItem, HistoryInputRef } from "./api";
import type { AppConfig, ModelOption, ProviderCatalog, SizeOption } from "./types";

/** 供 `requestJson` 使用的校验器签名。 */
export type Validator<T> = (value: unknown) => value is T;

/** 普通对象（排除 null 与数组）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 尺寸选项：三个字段都被消费面读（下拉展示与费用）。 */
function isSizeOption(value: unknown): value is SizeOption {
  return (
    isRecord(value) &&
    typeof value.value === "string" &&
    typeof value.label === "string" &&
    typeof value.cost === "number"
  );
}

/** 可选模型：消费面读 id（匹配）/ label（下拉展示）/ size_options（尺寸与单价）。 */
function isModelOption(value: unknown): value is ModelOption {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.label === "string" &&
    Array.isArray(value.size_options) &&
    value.size_options.every(isSizeOption)
  );
}

/** 来源目录项：按 baseUrl 命中、用 sizes / models 换表 —— 形状错会导致价格算错而非报错。 */
function isProviderCatalog(value: unknown): value is ProviderCatalog {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.baseUrl === "string" &&
    Array.isArray(value.sizes) &&
    value.sizes.every(isSizeOption) &&
    Array.isArray(value.models) &&
    value.models.every(isModelOption)
  );
}

/** `/api/config` 响应：启动即消费，形状错了整页后续渲染连环崩。 */
export function isAppConfig(value: unknown): value is AppConfig {
  return (
    isRecord(value) &&
    Array.isArray(value.sizes) &&
    value.sizes.every(isSizeOption) &&
    Array.isArray(value.qualities) &&
    value.qualities.every((quality) => typeof quality === "string") &&
    typeof value.defaultOutputDir === "string" &&
    typeof value.windowId === "number" &&
    (value.qualityEffective === undefined ||
      typeof value.qualityEffective === "boolean") &&
    (value.providers === undefined ||
      (Array.isArray(value.providers) && value.providers.every(isProviderCatalog)))
  );
}

/** `/api/history` 响应：列表 + 是否还有更多。 */
export interface HistoryResponse {
  items: GenerationHistoryItem[];
  hasMore: boolean;
}

/** 参考图元信息：三字段都必填且被消费。 */
function isHistoryInputRef(value: unknown): value is HistoryInputRef {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.path === "string" &&
    typeof value.url === "string"
  );
}

const HISTORY_OPTIONAL_STRINGS = ["time", "mode", "prompt", "size", "quality", "status", "output"] as const;
const HISTORY_OPTIONAL_NUMBERS = ["refs", "cost", "seconds"] as const;

/**
 * 历史条目：三个必填字段 + 存在时的可选字段逐类校验。
 *
 * 可选字段「缺」合法、「在但类型错」是契约变化 —— 后者会在渲染处静默显示成
 * `[object Object]` 一类脏串，所以这里一并拦掉。
 */
function isHistoryItem(value: unknown): value is GenerationHistoryItem {
  if (!isRecord(value)) return false;
  if (typeof value.exists !== "boolean" || typeof value.path !== "string" || typeof value.url !== "string") {
    return false;
  }
  if (HISTORY_OPTIONAL_STRINGS.some((key) => value[key] !== undefined && typeof value[key] !== "string")) {
    return false;
  }
  if (HISTORY_OPTIONAL_NUMBERS.some((key) => value[key] !== undefined && typeof value[key] !== "number")) {
    return false;
  }
  if (value.inputRefs !== undefined && !(Array.isArray(value.inputRefs) && value.inputRefs.every(isHistoryInputRef))) {
    return false;
  }
  return value.inputRefMissing === undefined || typeof value.inputRefMissing === "boolean";
}

export function isHistoryResponse(value: unknown): value is HistoryResponse {
  return (
    isRecord(value) &&
    Array.isArray(value.items) &&
    value.items.every(isHistoryItem) &&
    typeof value.hasMore === "boolean"
  );
}

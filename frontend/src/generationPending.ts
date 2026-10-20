/**
 * 生成中占位卡的渐近进度曲线 + 文案轮播（纯函数，零 UI 依赖）。
 *
 * ## 为什么是「假进度」而不是真进度
 *
 * 生图接口不回报百分比：排队、上游推理、回传三段里只有头尾能被观测到。
 * 若老老实实显示「0% → 0% → 0% → 100%」，用户会以为卡死；所以这里给一条
 * **渐近曲线**——越接近 98% 爬得越慢，永远不越过 98%（最后 2% 留给真实完成）。
 * 把它当成「还在动」的证据，而不是承诺。
 *
 * ## 判据（generationPending.test.ts 钉住）
 *
 * - 同一 tick 恒定同值：纯函数，没有 Date.now / 随机数，测试可直接断言数字
 * - 严格不减、上界 98%：`PENDING_PROGRESS_CAP`
 * - 首秒就可见（不是从 0 起爬）：`10%`
 */
import { generatingLabel } from "./format";

/** tick 起点：0s 时的进度（%）。从 0 起爬会让人怀疑「是不是没开始」 */
export const PENDING_PROGRESS_START = 10;

/** 进度上界（%）：真进度只有结束那一刻才存在，最后一格留给完成事件 */
export const PENDING_PROGRESS_CAP = 98;

/** 渐近时间常数（秒）：越大越慢；28s 时约到 68%，60s 约 91% */
export const PENDING_PROGRESS_TAU = 28;

/**
 * 文案轮播间隔（秒）：文案不必每秒跳一次，2s 一换读数才跟得上。
 * 与参考实现 basketikun/infinite-canvas（MIT）的 `Math.floor(tick / 2)` 同口径。
 */
export const PENDING_MESSAGE_SECONDS = 2;

/** 等待期文案：不承诺具体耗时，只描述「正在做什么」 */
export const PENDING_MESSAGES: readonly string[] = [
  "正在理解提示词…",
  "正在构图…",
  "正在铺设光影…",
  "正在细化细节…",
  "快好了，正在收尾…",
];

/**
 * 第 `seconds` 秒时的进度百分比（夹在 [起点, 上界] 内，严格不减）。
 * 非法入参（NaN / ±Infinity / 负数）按 0s 处理，绝不产出 NaN%。
 */
export function pendingProgress(seconds: number): number {
  const s = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const raw = PENDING_PROGRESS_START + (1 - Math.exp(-s / PENDING_PROGRESS_TAU)) * (PENDING_PROGRESS_CAP - PENDING_PROGRESS_START);
  return Math.min(PENDING_PROGRESS_CAP, Math.max(PENDING_PROGRESS_START, raw));
}

/** 进度条的横向缩放比例（0..1）：样式层只写 `transform: scaleX()`，不给 width 做动画 */
export function pendingProgressScale(seconds: number): number {
  return pendingProgress(seconds) / 100;
}

/** 第 `seconds` 秒该显示哪一条文案（按 `PENDING_MESSAGE_SECONDS` 轮播，循环） */
export function pendingMessage(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const index = Math.floor(s / PENDING_MESSAGE_SECONDS) % PENDING_MESSAGES.length;
  return PENDING_MESSAGES[index] ?? PENDING_MESSAGES[0] ?? "";
}

/**
 * 整行文案：秒数前缀复用 `generatingLabel`（与经典表单、画布按钮同源），后半句是轮播说明。
 * 例：`生成中 8s · 正在构图…`
 */
export function pendingLabel(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return `${generatingLabel(s)} · ${pendingMessage(s)}`;
}

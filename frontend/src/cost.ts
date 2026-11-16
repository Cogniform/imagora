import type { HistoryStats } from "./api";

/**
 * 成本展示纯函数（看板 / 上限摘要共用，不依赖 React）。
 * 费用口径由后端决定（core/config.py 的 size_options），这里只负责显示。
 */

/** 金额（元，两位小数）；非有限数字回退 "-" */
export function formatMoney(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${value.toFixed(2)} 元`;
}

/** 百分比（一位小数）；无记录时回退 "-" */
export function formatRate(percent: number | null | undefined): string {
  if (typeof percent !== "number" || !Number.isFinite(percent)) return "-";
  return `${percent.toFixed(1)}%`;
}

/** 耗时（秒 → "12.3s" / "3m05s"），便于看板一行内展示 */
export function formatSeconds(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "-";
  if (value < 60) return `${value.toFixed(1)}s`;
  const minutes = Math.floor(value / 60);
  const seconds = Math.round(value - minutes * 60);
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

/** 上限一行摘要：今日已花 / 每日上限 / 余额；未设每日上限时明确写"不限"。
 *  兼容两种来源：BudgetInfo（dailyLimit 在顶层）与 BudgetCheck（dailyLimit 在 settings 里） */
export function budgetSummary(info: {
  spentToday: number;
  remaining: number;
  dailyLimit?: number;
  settings?: { dailyLimit: number };
}): string {
  const dailyLimit = info.dailyLimit ?? info.settings?.dailyLimit ?? 0;
  const spent = `今日 ${formatMoney(info.spentToday)}`;
  if (!dailyLimit || dailyLimit <= 0) return `${spent} · 未设每日上限（不限）`;
  return `${spent} / 每日上限 ${formatMoney(dailyLimit)} · 余额 ${formatMoney(info.remaining)}`;
}

/** 看板主指标行（label/value 对；组件只负责排版） */
export function statRows(stats: Pick<
  HistoryStats,
  "total" | "ok" | "error" | "successRate" | "cost" | "todayCost" | "avgSeconds"
>): { label: string; value: string }[] {
  return [
    { label: "今日花费", value: formatMoney(stats.todayCost) },
    { label: "累计花费", value: formatMoney(stats.cost) },
    { label: "成功率", value: `${formatRate(stats.successRate)}（${stats.ok}/${stats.total}）` },
    { label: "失败", value: String(stats.error) },
    { label: "成功平均耗时", value: formatSeconds(stats.avgSeconds) },
  ];
}

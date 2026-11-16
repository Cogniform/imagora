import { describe, expect, it } from "vitest";

import { budgetSummary, formatMoney, formatRate, formatSeconds, statRows } from "./cost";

/** 成本展示纯函数：金额/比例/耗时格式化与看板摘要行（口径由后端给出，这里只管显示） */
/** noUncheckedIndexedAccess 守卫：越界即失败，不把断言弱化为可选链 */
function indexed<T>(items: ArrayLike<T>, at: number): T {
  const item = items[at];
  if (item === undefined) throw new Error(`indexed: 长度 ${items.length} 越界下标 ${at}`);
  return item;
}

describe("cost 展示纯函数", () => {
  it("formatMoney：两位小数 + 元；非法值回退 -", () => {
    expect(formatMoney(0.15)).toBe("0.15 元");
    expect(formatMoney(3)).toBe("3.00 元");
    expect(formatMoney(0)).toBe("0.00 元");
    expect(formatMoney(null)).toBe("-");
    expect(formatMoney(undefined)).toBe("-");
    expect(formatMoney(Number.NaN)).toBe("-");
  });

  it("formatRate：一位小数百分比；无记录回退 -", () => {
    expect(formatRate(66.666)).toBe("66.7%");
    expect(formatRate(0)).toBe("0.0%");
    expect(formatRate(100)).toBe("100.0%");
    expect(formatRate(undefined)).toBe("-");
  });

  it("formatSeconds：60 秒内用秒，超过用分秒；0/非法回退 -", () => {
    expect(formatSeconds(12.34)).toBe("12.3s");
    expect(formatSeconds(59.9)).toBe("59.9s");
    expect(formatSeconds(60)).toBe("1m00s");
    expect(formatSeconds(190.9)).toBe("3m11s");
    expect(formatSeconds(0)).toBe("-");
    expect(formatSeconds(-5)).toBe("-");
    expect(formatSeconds(null)).toBe("-");
  });

  it("budgetSummary：未设每日上限时明确写不限；设了就显示余额", () => {
    expect(budgetSummary({ spentToday: 0.15, dailyLimit: 0, remaining: 0 })).toBe("今日 0.15 元 · 未设每日上限（不限）");
    expect(budgetSummary({ spentToday: 0.15, dailyLimit: 10, remaining: 9.85 })).toBe(
      "今日 0.15 元 / 每日上限 10.00 元 · 余额 9.85 元",
    );
  });

  it("budgetSummary：兼容上限预检结果（dailyLimit 在 settings 里）", () => {
    expect(budgetSummary({ spentToday: 0.15, remaining: 9.85, settings: { dailyLimit: 10 } })).toBe(
      "今日 0.15 元 / 每日上限 10.00 元 · 余额 9.85 元",
    );
    expect(budgetSummary({ spentToday: 0.15, remaining: 0, settings: { dailyLimit: 0 } })).toBe(
      "今日 0.15 元 · 未设每日上限（不限）",
    );
  });

  it("statRows：主指标行按固定顺序输出（今日/累计/成功率/失败/耗时）", () => {
    const rows = statRows({
      total: 556, ok: 290, error: 266, successRate: 52.2, cost: 28.9, todayCost: 1.2, avgSeconds: 190.9,
    });
    expect(rows.map((r) => r.label)).toEqual(["今日花费", "累计花费", "成功率", "失败", "成功平均耗时"]);
    expect(indexed(rows, 0).value).toBe("1.20 元");
    expect(indexed(rows, 2).value).toBe("52.2%（290/556）");
    expect(indexed(rows, 3).value).toBe("266");
    expect(indexed(rows, 4).value).toBe("3m11s");
  });
});

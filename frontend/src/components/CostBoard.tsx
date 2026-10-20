import { useEffect, useState } from "react";

import type { BudgetSettings, HistoryStats } from "../api";
import { statRows } from "../cost";

/** 预算设置初值（stats 未加载时按"不限"显示） */
const EMPTY_BUDGET: BudgetSettings = { dailyLimit: 0, singleRunLimit: 0 };

/**
 * 成本看板：账本原始行聚合的关键指标 + 本机预算设置（当日上限 / 单次上限，0 = 不限）。
 * 只负责渲染与本地草稿：数据加载与保存都交给宿主（HistoryGallery），保持组件无副作用。
 */
export function CostBoard({
  stats,
  loading,
  onRefresh,
  onSaveBudget,
}: {
  stats: HistoryStats | null;
  loading: boolean;
  onRefresh: () => void;
  onSaveBudget: (settings: BudgetSettings) => Promise<void>;
}) {
  const [draft, setDraft] = useState<BudgetSettings>(EMPTY_BUDGET);
  const [saving, setSaving] = useState(false);
  const [savedTip, setSavedTip] = useState("");

  // stats 变化时同步草稿（用户未编辑时的默认值：后端已保存的预算）
  useEffect(() => {
    if (stats) {
      setDraft({ dailyLimit: stats.budget.dailyLimit, singleRunLimit: stats.budget.singleRunLimit });
    }
  }, [stats]);

  const handleSave = async () => {
    setSaving(true);
    setSavedTip("");
    try {
      await onSaveBudget(draft);
      setSavedTip("预算已保存");
    } catch (err) {
      setSavedTip(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const rows = stats ? statRows(stats) : [];
  const topSizes = stats?.bySize.slice(0, 3) ?? [];

  return (
    <section data-testid="cost-board" className="corner-deco surface-float border-b border-neutral-200 px-4 pt-9 pb-3">
      {loading && !stats ? (
        <span className="text-[11px] text-neutral-400">正在统计成本...</span>
      ) : stats ? (
        <>
          {/* 指标 + 预算设置：指标等宽成列（标签在上、数值在下，列间对齐），
              设置靠右、与指标用竖线分区；窄屏各自换行。 */}
          <div className="flex flex-wrap items-stretch gap-x-4 gap-y-2">
            <div className="grid min-w-0 flex-1 grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3 lg:grid-cols-5">
              {rows.map((row) => (
                <div key={row.label} className="min-w-0">
                  <div className="truncate text-[10px] leading-4 text-neutral-400">{row.label}</div>
                  <div className="truncate text-[13px] font-semibold leading-5 text-neutral-800">{row.value}</div>
                </div>
              ))}
            </div>
            <div className="compact-controls flex shrink-0 flex-wrap items-center gap-2 border-neutral-200 pl-0 sm:border-l sm:pl-4">
              <label className="flex items-center gap-1">
                <span className="text-[11px] text-neutral-400">日预算</span>
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  value={draft.dailyLimit}
                  onChange={(event) => setDraft((prev) => ({ ...prev, dailyLimit: Number(event.target.value) }))}
                  title="当日累计费用上限（元），0 = 不限；超限提交前会要求确认"
                  className="field-control !w-20 text-right"
                />
              </label>
              <label className="flex items-center gap-1">
                <span className="text-[11px] text-neutral-400">单次上限</span>
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  value={draft.singleRunLimit}
                  onChange={(event) => setDraft((prev) => ({ ...prev, singleRunLimit: Number(event.target.value) }))}
                  title="单次提交（含批量重跑）预估上限（元），0 = 不限"
                  className="field-control !w-20 text-right"
                />
              </label>
              <button type="button" className="btn-ghost" disabled={saving} onClick={() => void handleSave()}>
                {saving ? "保存中..." : "保存预算"}
              </button>
              <button type="button" className="btn-ghost" disabled={loading} onClick={onRefresh}>
                刷新
              </button>
              {savedTip && <span className="text-[11px] text-neutral-400">{savedTip}</span>}
            </div>
          </div>
          {/* 按尺寸：次要信息，独立一行、与指标同一色阶（左上角小标签说明这是哪一类） */}
          {topSizes.length > 0 && (
            <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-neutral-100 pt-2 text-[11px] text-neutral-500">
              <span className="text-[10px] text-neutral-400">按尺寸</span>
              {topSizes.map((row) => (
                <span key={row.size} className="whitespace-nowrap">
                  {row.size} <span className="text-neutral-400">×{row.count}</span> · {row.cost.toFixed(2)} 元
                </span>
              ))}
            </div>
          )}
        </>
      ) : (
        <span className="text-[11px] text-neutral-400">成本统计不可用</span>
      )}
    </section>
  );
}

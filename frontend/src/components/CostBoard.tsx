import { useEffect, useRef, useState } from "react";

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
  /** 用户动过这两个框没有。
   *
   * 下面那句同步的本意是「用户没编辑时显示后端已保存的值」，但只看 `stats` 变化
   * 会把**用户刚敲进去的字**盖掉：stats 是一次网络请求，它晚到时（慢一点、
   * 或者保存后回读）就会把输入框重置回旧值 —— 用户看到的是「我打进去的 5 没了」。
   *
   * 用 **ref** 而不是 state，是因为这里要挡的是「已经在排队、还没跑的那次 effect」：
   * 那个 effect 的闭包里读到的是**它被创建时**的状态。若用 state，用户在这次 effect
   * 落地之前敲了字，闭包里 `dirty` 仍是 false，同步照样执行、照样把字盖掉 ——
   * 表现为同一份测试时红时绿（实测单文件连跑 8 次红 1 次）。
   * ref 是同步可见的，写入即生效，不存在这个窗口。 */
  const dirtyRef = useRef(false);

  // stats 变化时同步草稿（用户未编辑时的默认值：后端已保存的预算）
  useEffect(() => {
    if (!stats || dirtyRef.current) return;
    setDraft({ dailyLimit: stats.budget.dailyLimit, singleRunLimit: stats.budget.singleRunLimit });
  }, [stats]);

  /** 编辑：记下「用户动过」，并清掉上一次的保存提示 */
  const edit = (patch: Partial<BudgetSettings>) => {
    dirtyRef.current = true;
    setSavedTip("");
    setDraft((prev) => ({ ...prev, ...patch }));
  };

  const handleSave = async () => {
    setSaving(true);
    setSavedTip("");
    try {
      await onSaveBudget(draft);
      // 保存成功：交还控制权，下一次 stats 回读的值可以覆盖草稿
      dirtyRef.current = false;
      setSavedTip("上限已保存");
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
            <div className="cost-board-grid grid min-w-0 flex-1 gap-x-4 gap-y-2">
              {rows.map((row) => (
                <div key={row.label} className="min-w-0">
                  <div className="truncate text-[10px] leading-4 text-neutral-400">{row.label}</div>
                  <div className="truncate text-[13px] font-semibold leading-5 text-neutral-800">{row.value}</div>
                </div>
              ))}
            </div>
            <div className="compact-controls flex shrink-0 flex-wrap items-center gap-2 border-neutral-200 pl-0 sm:border-l sm:pl-4">
              <label className="flex items-center gap-1">
                <span className="text-[11px] text-neutral-400">每日上限</span>
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  value={draft.dailyLimit}
                  onChange={(event) => edit({ dailyLimit: Number(event.target.value) })}
                  title="每日累计花费上限（元），0 = 不限；超限提交前会要求确认"
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
                  onChange={(event) => edit({ singleRunLimit: Number(event.target.value) })}
                  title="单次提交（含批量重跑）预估花费上限（元），0 = 不限"
                  className="field-control !w-20 text-right"
                />
              </label>
              <button type="button" className="btn-ghost" disabled={saving} onClick={() => void handleSave()}>
                {saving ? "保存中..." : "保存上限"}
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

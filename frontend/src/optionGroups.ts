/**
 * 下拉选项分组（移植自 DeepSeek Harness，MIT，`ui-commands/src/client/option-groups.ts`）。
 *
 * 为什么需要它：下拉要按组渲染，但组的先后必须跟数据源（用户排好的顺序）一致，
 * 不能按字母序重排；且有的选项天生不带组（「不分组」也是一类），渲染层不想为此
 * 写分支 —— 所以这里保证：返回值永远是 `OptionGroup[]`，哪怕一个组都没有分。
 *
 * 与 DSH 原版的差异：原版按 `group?.name` 归组、无组项占据「首次出现」的位置；
 * imagora 改为按 `group.id` 归组，无组项统一进 id 为 `""` 的兜底组，且**混合
 * 时该兜底组排最后**（全部无组时就是那唯一一个组），组间按 group.id 首次出现
 * 顺序、组内保持源顺序。
 */

/** 一个可分组的下拉选项。group 缺省 = 不分组。 */
export interface GroupedOption {
  readonly value: string;
  readonly label: string;
  readonly group?: { readonly id: string; readonly label: string };
}

/** 一个分组：id / 显示名 / 该组内的选项（保持源顺序）。 */
export interface OptionGroup<T extends GroupedOption> {
  readonly id: string;
  readonly label: string;
  readonly rows: readonly T[];
}

/**
 * 按 group.id **首次出现顺序**分组；未带 group 的选项归入 id 为 `""` 的组。
 *
 * - 全部无 group：返回单个 `{ id: "", label: "", rows: 全部 }`，调用方可统一渲染；
 * - 混合：无 group 的项进 id 为 `""` 的组，该组排在最后；
 * - 组内、组间都保持源顺序；返回的行就是入参对象本身（不拷贝）。
 * @param options 候选项（源顺序）
 * @returns 分组结果；入参为空时返回空数组
 */
export function groupOptions<T extends GroupedOption>(options: readonly T[]): readonly OptionGroup<T>[] {
  const grouped = new Map<string, { label: string; rows: T[] }>();
  const ungrouped: T[] = [];
  for (const option of options) {
    // 只有「完全没带 group」才算不分组；带了 group 就按它的 id 归组（含 id 为空串）。
    const group = option.group;
    if (group === undefined) {
      ungrouped.push(option);
      continue;
    }
    const existing = grouped.get(group.id);
    if (existing !== undefined) existing.rows.push(option);
    else grouped.set(group.id, { label: group.label, rows: [option] });
  }
  if (grouped.size === 0) {
    return ungrouped.length === 0 ? [] : [{ id: "", label: "", rows: ungrouped }];
  }
  const result: OptionGroup<T>[] = [...grouped].map(([id, bucket]) => ({
    id,
    label: bucket.label,
    rows: bucket.rows,
  }));
  if (ungrouped.length > 0) result.push({ id: "", label: "", rows: ungrouped });
  return result;
}

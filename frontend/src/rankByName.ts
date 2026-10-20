/**
 * 按名字模糊排序 —— 下拉 / 命令面板的输入过滤用。
 *
 * 算法移植自 DeepSeek Harness（MIT 许可）的
 * `packages/client/ui-primitives/src/rank-by-name.ts`：query 必须是候选 name
 * （有 label 时 label 也算一个搜索键）的**大小写不敏感有序子序列**；排序三级：
 * 前缀命中优先 → 对齐分数降序 → 输入源顺序。为什么需要它：纯 substring 过滤
 * 会漏掉 `gi25` 这种缩写敲法；而朴素的子序列匹配又会把「跳了一大段字符」的
 * 误命中排到真正的前缀命中之前。这里的 DP 给边界 / 相邻命中加权、给跳字符
 * 降权，排序结果才接近人的直觉。
 *
 * 与 DSH 原版的差异（imagora 必须补上的一层）：比对前先把 query 与每个 key
 * 用 `foldModelId` 折叠「看起来像减号」的字符，再 toLowerCase。理由见
 * `apiCatalog.ts` 里 `DASH_CODEPOINTS` 的说明：中转站把 `gpt‑image‑2.5`
 * 登记成 U+2011 全角连字符，肉眼与键盘能打出的半角 `-` 完全一样，不折叠就
 * 永远搜不到（imagora 的历史坑）。折叠放在 toLowerCase 之前，且 name / label /
 * query 三者走同一条管道，`boundaryBonus` 里的 `-` 边界判定才能同时覆盖全角写法。
 */

import { foldModelId } from "./apiCatalog";

/** 一次命中：候选项 + 它在输入里的稳定位置。模块私有，不导出。 */
interface Ranked<T> {
  readonly item: T;
  readonly index: number;
  readonly prefix: boolean;
  readonly score: number;
}

/** 字符串开头和分隔符（`-` / `_`）之后的位置额外加分。模块私有。 */
function boundaryBonus(name: string, index: number): number {
  return index === 0 || name.charAt(index - 1) === "-" || name.charAt(index - 1) === "_" ? 8 : 0;
}

/**
 * O(name × query) 的 DP：给「有序子序列」里最强的那次对齐打分。
 * 边界位置和相邻接续加分；跳字符、行首空位扣分。query 不是 name 的子序列时
 * 返回 undefined。模块私有。
 */
function alignmentScore(name: string, query: string): number | undefined {
  if (query.length > name.length) return undefined;
  const noMatch = Number.NEGATIVE_INFINITY;
  let previous = Array<number>(name.length).fill(noMatch);
  for (let index = 0; index < name.length; index++) {
    if (name.charAt(index) === query.charAt(0)) previous[index] = 1 + boundaryBonus(name, index) - index;
  }
  for (let queryIndex = 1; queryIndex < query.length; queryIndex++) {
    const current = Array<number>(name.length).fill(noMatch);
    // 扫一遍上一行：`left` 是上一行回退一格的分数（相邻接续），`leftLeft`
    // 回退两格（可跳跃接续里最早的那个）。
    let left = noMatch;
    let leftLeft = noMatch;
    let bestGapped = noMatch;
    for (const [index, prior] of previous.entries()) {
      if (leftLeft !== noMatch) bestGapped = Math.max(bestGapped, leftLeft + index - 2);
      if (name.charAt(index) === query.charAt(queryIndex)) {
        const bonus = 1 + boundaryBonus(name, index);
        let score = noMatch;
        if (left !== noMatch) score = left + bonus + 4;
        if (bestGapped !== noMatch) score = Math.max(score, bestGapped + bonus + 1 - index);
        current[index] = score;
      }
      leftLeft = left;
      left = prior;
    }
    previous = current;
  }
  let best = noMatch;
  for (const score of previous) best = Math.max(best, score);
  return best === noMatch ? undefined : best;
}

/**
 * 按 query 给候选项排序。
 * @param items 候选项（保持源顺序；`label` 有则作为第二个搜索键）
 * @param rawQuery 用户输入；先做连字符折叠再转小写
 * @returns 命中的候选项：前缀命中在前 → 分数降序 → 源顺序；空 query 原样返回
 *   入参数组本身。
 */
export function rankByName<T extends { readonly name: string; readonly label?: string }>(
  items: readonly T[],
  rawQuery: string,
): readonly T[] {
  // 连字符折叠（见文件头）：半角 `gpt-image` 也能命中上游用 U+2011 登记的 id。
  const query = foldModelId(rawQuery).toLowerCase();
  if (query === "") return items;
  const ranked: Ranked<T>[] = [];
  items.forEach((item, index) => {
    const keys = item.label === undefined ? [item.name] : [item.name, item.label];
    let prefix = false;
    let score: number | undefined;
    for (const key of keys) {
      const lower = foldModelId(key).toLowerCase();
      const keyScore = alignmentScore(lower, query);
      if (keyScore === undefined) continue;
      prefix ||= lower.startsWith(query);
      score = score === undefined ? keyScore : Math.max(score, keyScore);
    }
    if (score !== undefined) ranked.push({ item, index, prefix, score });
  });
  ranked.sort(
    (left, right) =>
      Number(right.prefix) - Number(left.prefix) || right.score - left.score || left.index - right.index,
  );
  return ranked.map((match) => match.item);
}

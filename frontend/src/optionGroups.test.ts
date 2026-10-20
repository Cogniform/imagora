import { describe, expect, it } from "vitest";

import { groupOptions } from "./optionGroups";
import type { GroupedOption, OptionGroup } from "./optionGroups";

/** 选项简写；不传 group 就是「不分组」（eOPT 下不能显式写 group: undefined）。 */
function opt(value: string, group?: { id: string; label: string }): GroupedOption {
  return { value, label: value, ...(group ? { group } : {}) };
}

/** 取每组的 id / label / 组内 value 序列。 */
function shape(groups: readonly OptionGroup<GroupedOption>[]): {
  id: string;
  label: string;
  values: string[];
}[] {
  return groups.map((group) => ({
    id: group.id,
    label: group.label,
    values: group.rows.map((row) => row.value),
  }));
}

describe("groupOptions", () => {
  it("空数组 → 空结果", () => {
    expect(groupOptions([])).toEqual([]);
  });

  it("全部无 group → 单个 id 为 \"\"、label 为 \"\" 的组，含全部选项", () => {
    const a = opt("a");
    const b = opt("b");
    expect(shape(groupOptions([a, b]))).toEqual([{ id: "", label: "", values: ["a", "b"] }]);
  });

  it("单一 group：只出一组，组内保持源顺序", () => {
    const g = { id: "g1", label: "组一" };
    expect(shape(groupOptions([opt("a", g), opt("b", g), opt("c", g)]))).toEqual([
      { id: "g1", label: "组一", values: ["a", "b", "c"] },
    ]);
  });

  it("多个 group 按首次出现顺序排列（不是字母序）", () => {
    const z = { id: "zeta", label: "Z 组" };
    const a = { id: "alpha", label: "A 组" };
    // zeta 先出现就排前面，即便 alpha 字母序更靠前
    expect(shape(groupOptions([opt("z1", z), opt("a1", a), opt("z2", z)]))).toEqual([
      { id: "zeta", label: "Z 组", values: ["z1", "z2"] },
      { id: "alpha", label: "A 组", values: ["a1"] },
    ]);
  });

  it("混合有/无 group：无 group 那组排最后", () => {
    const g1 = { id: "g1", label: "组一" };
    const g2 = { id: "g2", label: "组二" };
    expect(
      shape(groupOptions([opt("a", g1), opt("u1"), opt("b", g2), opt("u2")])),
    ).toEqual([
      { id: "g1", label: "组一", values: ["a"] },
      { id: "g2", label: "组二", values: ["b"] },
      { id: "", label: "", values: ["u1", "u2"] },
    ]);
  });

  it("组内保持源顺序，且行就是入参对象本身", () => {
    const g = { id: "g1", label: "组一" };
    const rows = [opt("c", g), opt("a", g), opt("b", g)];
    const groups = groupOptions(rows);
    expect(shape(groups)).toEqual([{ id: "g1", label: "组一", values: ["c", "a", "b"] }]);
    const first = groups[0];
    expect(first?.rows[0]).toBe(rows[0]);
  });
});

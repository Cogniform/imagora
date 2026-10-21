/**
 * 「允许自由输入清单外的值」的纯函数层 —— 给 [components/Select.tsx](components/Select.tsx)
 * 的 `allowCustom` 用。
 *
 * 为什么需要：画布的尺寸下拉只有固定几档（`1024x1024` / `1792x1024` …），用户想填
 * `1280x720` 这种上游其实认、但清单里没有的尺寸时无处可去；模型下拉同理（新模型
 * 先能用、后进配置）。
 *
 * ## 三条设计取舍（每条都别「顺手改掉」，改之前先读理由）
 *
 * 1. **归一化只处理空白，不做大小写归一**。模型 ID（`gpt-image-2.5-flare`）与尺寸
 *    字符串都是上游的**字面标识**，大小写敏感：`Dall-E-3` 与 `dall-e-3` 在有的中转站
 *    上是两个东西，替用户「纠正」大小写等于发错请求。空白则不同 —— 从文档里复制粘贴
 *    常带首尾空格、Tab、换行、全角空格（U+3000），那些是噪声，不是标识的一部分。
 *
 * 2. **不做格式校验**。不同上游的模型 ID 与尺寸格式差得远（`gpt-image-2.5`、
 *    `doubao-seedream-3-0-t2i`、`1024x1024`、`1280x720`、`auto`、带 `@` 的别名…），
 *    前端一旦猜错格式就会**拦掉合法值** —— 那比放过一个错值更糟：错值上游会明确报错，
 *    被拦掉的值用户连试的机会都没有。所以只挡两种结构上不可能成立的输入：
 *    空（含纯空白）、以及长到不像标识的串。
 *
 * 3. **清单里已有的值不造新选项**，且此时 `mergeCustomOption` 返回**入参数组本身**
 *    （引用相等，不是拷贝）。调用方通常在渲染期算选项：
 *    `options={mergeCustomOption(base, value)}`，每次渲染都返回新数组会让 Select 内部
 *    依赖 `options` 的 useMemo 全部失效（`visible` / `groups` / `indexOf` 连锁重算）。
 */

/** 自定义选项的固定分组：渲染层据此显示「自定义」组标题，与业务分组区分开。 */
const CUSTOM_GROUP: { id: string; label: string } = { id: "__custom", label: "自定义" };

/**
 * 自由输入值的长度上限（按 UTF-16 码元算，模型 ID 与尺寸都是 ASCII，不必按码点算）。
 * 64 的来历：最长的一类模型 ID（`doubao-seedream-3-0-t2i-250415`）约 30 字符，
 * 留一倍余量即可；再长就不像标识、更像误粘贴了一整段提示词。
 */
const MAX_CUSTOM_VALUE_LENGTH = 64;

/** 一条可参与分组的选项（与 `SelectOption` / `GroupedOption` 结构兼容）。 */
export interface CustomValueOption {
  value: string;
  label: string;
  group?: { id: string; label: string };
}

/** 校验结果：通过时带**归一化后**的值，调用方直接拿它去提交即可。 */
export type CustomValueResult = { ok: true; value: string } | { ok: false; reason: string };

/**
 * 归一化用户输入：去首尾空白，把中间连续的空白折成一个半角空格。
 *
 * - 不做大小写归一（理由见文件头第 1 条）；
 * - 不做其它字符替换（全角连字符之类的历史坑由 `apiCatalog.foldModelId` 在**比对**时
 *   处理，这里不能改写用户真正要提交的字符串）。
 *
 * `\s` 在 JS 里覆盖 Tab / 换行 / 不换行空格 / 全角空格（U+3000）——中文输入法下
 * 顺手敲出的全角空格会被一并折掉，这是刻意的。
 * @param raw 用户原始输入
 * @returns 归一化后的字符串；空输入或纯空白返回空串
 */
export function normalizeCustomValue(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/**
 * 这个值是否已经在清单里（**精确比对，大小写敏感**）。
 *
 * 调用方应传已归一化的值（`normalizeCustomValue` 的结果），本函数不再二次归一化：
 * 清单里的 `value` 是配置写死的标识，不该被同一套空白规则改写。
 * @param options 候选项
 * @param value 待查的值
 */
export function isKnownValue(options: readonly { value: string }[], value: string): boolean {
  return options.some((option) => option.value === value);
}

/**
 * 把当前值合进选项清单：不在清单里就作为一条「自定义」选项**追加到末尾**。
 *
 * 为什么必须合：`Select` 的触发器显示的是 `options.find(o => o.value === value)`，
 * 值不在清单里时它会退化成「请选择」—— 用户明明选过东西，界面上却像没选。
 *
 * 三种情况：
 * - 值在清单里 → 返回**入参数组本身**（引用相等，见文件头第 3 条）；
 * - 空值 / 纯空白 → 同样返回入参本身（没东西可加）；
 * - 其余 → 返回新数组，末尾多一条 `{ value, label: value, group: 自定义 }`。
 *
 * 不修改入参数组（纯函数）。
 * @param options 原选项清单
 * @param value 当前值
 * @returns 可直接交给 `Select` 的 `options`
 */
export function mergeCustomOption(
  options: readonly CustomValueOption[],
  value: string,
): CustomValueOption[] {
  const normalized = normalizeCustomValue(value);
  if (normalized === "" || isKnownValue(options, normalized)) {
    // 断言只放宽 `readonly`：本函数从不改写入参数组，调用方自己的数组本来就可变。
    return options as CustomValueOption[];
  }
  return [...options, { value: normalized, label: normalized, group: CUSTOM_GROUP }];
}

/**
 * 校验一次自由输入，通过时返回归一化后的值。
 *
 * 只挡两种情况（理由见文件头第 2 条，**刻意不做格式校验**）：
 * - 空串 / 纯空白 → `{ ok: false, reason: "不能为空" }`
 * - 归一化后超长 → `{ ok: false, reason: "太长" }`
 * @param raw 用户原始输入
 */
export function validateCustomValue(raw: string): CustomValueResult {
  const value = normalizeCustomValue(raw);
  if (value === "") return { ok: false, reason: "不能为空" };
  if (value.length > MAX_CUSTOM_VALUE_LENGTH) return { ok: false, reason: "太长" };
  return { ok: true, value };
}

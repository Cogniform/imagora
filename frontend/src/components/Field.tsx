/**
 * Field —— 表单字段壳组件（排版 + 无障碍关联）。
 *
 * 为什么要有这个组件：imagora 此前每个弹窗各自手写一遍 label + hint + error，
 * 且 hint 与 error 常常同时渲染成两行（一行灰、一行红），把弹窗垂直空间吃掉一截。
 * 本组件把这块收拢：hint 与 error 共用同一个消息槽位 <p id={`${id}-message`}>，
 * invalid 时 error 顶掉 hint，任何时刻至多一行提示。
 *
 * 移植自 DeepSeek Harness（MIT）的 SettingsValueField（packages/client/ui-primitives/
 * src/settings-form/fields.tsx 49-115 行），保留其三条核心设计：
 * 1. hint/error 共用一个消息槽位，绝不同时渲染两行；
 * 2. aria-describedby 拼接消息槽位 id（无内容时传 undefined 而非空字符串）；
 * 3. aria-invalid 用条件展开写法（exactOptionalPropertyTypes 下不能写 aria-invalid={undefined}）。
 *
 * DSH 没有的难点：children 是调用方渲染好的控件，Field 拿不到 DOM 引用，
 * 因此用 cloneElement 把 aria-describedby / aria-invalid 注入控件元素。
 */
import { cloneElement, isValidElement } from "react";
import type { ReactElement, ReactNode } from "react";

interface FieldProps {
  /** 控件 id：label 的 htmlFor 与 aria-describedby 都基于它推导（必须调用方给，不用 useId） */
  id: string;
  label: string;
  /** 一行说明，显示在控件下方；invalid 时被 error 顶掉。
   *  显式允许 undefined：调用方常用 `hint={lookup()?.hint}` 这种可能查不到值的写法，
   *  在 exactOptionalPropertyTypes 下 `hint?: string` 会拒绝 undefined。 */
  hint?: string | undefined;
  /** 校验失败文案；有值即视为 invalid */
  error?: string | null | undefined;
  /** label 右侧的附加操作（如「获取可用模型」按钮）；放在 label 行，不占控件位置 */
  action?: ReactNode;
  /** 控件本体。Field 只负责排版与无障碍关联，不关心是 input / textarea / 自研下拉 */
  children: ReactNode;
  /** 额外类名，挂在外层容器 */
  className?: string;
}

export function Field({
  id,
  label,
  hint,
  error,
  action,
  children,
  className = "",
}: FieldProps) {
  const messageId = `${id}-message`;
  const invalid = error != null && error !== "";
  // 可描述内容：仅当有消息槽位时才拼 id；无内容时必须传 undefined（不是空字符串），
  // 否则控件上会出现空值的 aria-describedby。
  const description = invalid || hint ? messageId : undefined;

  // children 只接受单个 ReactElement，此时用 cloneElement 注入 aria 属性。
  // 退化路径：若 children 不是单个元素（数组、字符串等），无法注入，
  // 就原样渲染、不加 aria —— 无障碍关联由调用方自行处理。
  const control = isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        "aria-describedby": description,
        ...(invalid ? { "aria-invalid": true } : {}),
      })
    : children;

  return (
    <div className={className}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <label className="field-label" htmlFor={id}>
          {label}
        </label>
        {action}
      </div>
      {control}
      {invalid || hint ? (
        <p
          id={messageId}
          className={invalid ? "text-caption mt-2 text-red-600" : "text-caption mt-2"}
        >
          {invalid ? error : hint}
        </p>
      ) : null}
    </div>
  );
}

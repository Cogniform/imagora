/**
 * 拖拽对齐线的模块级 store：`setSnapGuides` / `subscribe` / `getSnapGuides`。
 *
 * 为什么不放在 CanvasPage 的 `useState` 里：
 * 拖拽时对齐线每帧都可能变，而它只是几条绝对定位的 div。state 挂在 2357 行的
 * CanvasPage 上，写入就等于让整棵树参与一次渲染调度；搬到模块级后，只有真正读它的
 * `SnapGuides` 组件会被通知。
 *
 * 契约（有 `snapGuidesStore.test.ts` 钉住）：
 * - 值按**内容**比较：逐条比 `axis` / `position` / `targetId`，全同即视为没变，**不通知**。
 *   拖拽时大多数帧的 guides 内容不变，没必要唤醒任何组件。
 * - `getSnapGuides()` 返回稳定引用：内容不变时始终是同一个数组，可直接当
 *   `useSyncExternalStore` 的 snapshot（返回新数组会触发无限重渲染）。
 * - 写入的数组视为只读：调用方之后不得原地修改（现有调用方都是新建数组）。
 */

import type { SnapGuide } from "./snapGuide";

type Listener = () => void;

/** 当前帧的对齐线；空数组是常态（未拖拽 / 没吸到邻居） */
let current: readonly SnapGuide[] = [];

const listeners = new Set<Listener>();

/** 逐条比较：顺序敏感（每轴最多一条，`snapToNeighbors` 的输出顺序稳定） */
function sameGuide(a: SnapGuide, b: SnapGuide): boolean {
  return a.axis === b.axis && a.position === b.position && a.targetId === b.targetId;
}

function sameGuides(a: readonly SnapGuide[], b: readonly SnapGuide[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    // noUncheckedIndexedAccess：长度相等时一定存在，这里只是让类型收窄
    if (!left || !right) return false;
    if (!sameGuide(left, right)) return false;
  }
  return true;
}

/** 写入当前帧的对齐线。内容没变就不通知（拖拽中绝大多数帧走这条早退） */
export function setSnapGuides(next: readonly SnapGuide[]): void {
  if (sameGuides(current, next)) return;
  current = next;
  // 先复制一份再遍历：订阅者在回调里退订不会打乱本次派发
  for (const listener of [...listeners]) listener();
}

/** 当前对齐线；内容不变时引用稳定，可直接作为 `useSyncExternalStore` 的 snapshot */
export function getSnapGuides(): readonly SnapGuide[] {
  return current;
}

/** 订阅对齐线变化，返回退订函数（`useSyncExternalStore` 的 subscribe 契约） */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

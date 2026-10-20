/** 打开中的浮层计数（下拉列表等挂在 body 上的弹出层）。
 *
 *  为什么需要它：`.modal-shell` 的 Esc 监听挂在 **capture 阶段**
 *  （`document.addEventListener("keydown", handler, true)`），比 React 挂在
 *  触发器按钮上的 `onKeyDown` 先跑。若不拦，展开下拉时按 Esc 会**直接关掉整个弹窗**，
 *  而不是先收起下拉 —— 用户的手感是「按一下 Esc，连我正在填的窗口都没了」。
 *
 *  约定：浮层打开时 push、关闭时 pop；弹窗的 Esc 处理先问 `hasOpenPopup()`，
 *  有浮层就让给浮层消费，因此需要按两次 Esc（先收浮层、再关弹窗）。
 *
 *  纯函数式计数，无副作用，便于单测。
 */
let openPopups = 0;

export function pushPopup(): void {
  openPopups += 1;
}

export function popPopup(): void {
  openPopups = Math.max(0, openPopups - 1);
}

/** 有浮层正打开（Esc 应先给它） */
export function hasOpenPopup(): boolean {
  return openPopups > 0;
}

/** 仅测试用：重置计数，避免用例间互相污染 */
export function resetPopupCount(): void {
  openPopups = 0;
}

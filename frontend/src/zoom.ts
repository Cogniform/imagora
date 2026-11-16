/**
 * 画布缩放的**唯一真值表**。
 *
 * 为什么要有这个文件：缩放相关的数字原本散在三处 —— ReactFlow 的 `minZoom`/`maxZoom`
 * props、控制坞的 fitView 参数、缩放读数的百分比行程，再加上 LOD 的进出阈值。
 * 它们必须互相对齐，而「对齐」靠人记是记不住的：
 *
 *   - 读数写着 200% 而视口早就缩不动了（maxZoom 改了、百分比没跟着改）；
 *   - fitView 的 minZoom 比 ReactFlow 的 minZoom 还小，全览时视口被顶回来、节点出屏；
 *   - LOD 的进阈值比出阈值大，缩放停在临界点反复翻转（详见 LOD 那一节）。
 *
 * 所以：**所有数字在这里定义一次，别处只引用**。要调就调这里，调完两侧自动一致。
 *
 * 另一半约束在 `minimapVisible.ts` 与 `CanvasPage.tsx` 的调用点注释里：
 * 百分比与倍率必须同源，所以百分比不写成字面量，而是从倍率算出来。
 */

/* ---------------- 视口行程 ---------------- */

/** ReactFlow 允许缩到多小。低于这个值节点上的小控件只剩一两个像素，缩了也没意义 */
export const MIN_ZOOM = 0.05;

/** ReactFlow 允许放到多大。再大只是把像素拉成方块，看不清细节也点不准 */
export const MAX_ZOOM = 2;

/**
 * 「一屏全览」时允许缩到多小（比 MIN_ZOOM 更小）。
 *
 * 卡片很多时 fitView 必须能缩到 5% 以下，否则「全部显示」根本做不到 ——
 * 它只作用于 fitView，不影响用户滚轮能拖到的范围。
 */
export const MIN_FIT_ZOOM = 0.02;

/* ---------------- 内边距与动画 ---------------- */

/** 全览留白：节点多时留太多会白白缩掉一档，0.15 是「看得出边距、又不浪费画面」的实测值 */
export const FIT_PADDING = 0.15;

/** 全览允许放大到的上限：只有一两个节点时 fitView 会放到很大，2 倍封顶 */
export const FIT_MAX_ZOOM = MAX_ZOOM;

/** 「放大 / 缩小」按钮的过渡时长（ms）：再长就有点拖沓 */
export const ZOOM_ANIM_MS = 180;

/** fitView 的过渡时长（ms）：视口要移动更远，比单步缩放略长 */
export const FIT_ANIM_MS = 300;

/* ---------------- 缩放读数（百分比） ---------------- */

/** 可显示行程的下限（百分比整数），与 MIN_ZOOM 同源 */
export const CANVAS_ZOOM_MIN_PERCENT = Math.round(MIN_ZOOM * 100);

/** 可显示行程的上限（百分比整数），与 MAX_ZOOM 同源 */
export const CANVAS_ZOOM_MAX_PERCENT = Math.round(MAX_ZOOM * 100);

/**
 * 把任意数字夹进行程并取整。
 *
 * NaN 走下限（读数必须是个数）；±Infinity 按方向夹到端点 ——
 * 视口算出 Infinity 通常是「节点还没测量」，夹到端点比夹到下限更接近用户预期。
 */
export function clampZoomPercent(percent: number): number {
  if (Number.isNaN(percent)) return CANVAS_ZOOM_MIN_PERCENT;
  if (percent === Number.POSITIVE_INFINITY) return CANVAS_ZOOM_MAX_PERCENT;
  if (percent === Number.NEGATIVE_INFINITY) return CANVAS_ZOOM_MIN_PERCENT;
  return Math.min(CANVAS_ZOOM_MAX_PERCENT, Math.max(CANVAS_ZOOM_MIN_PERCENT, Math.round(percent)));
}

/**
 * 缩放倍数 → 显示用百分比（整数，夹进行程）。
 *
 * 读数是**纯派生显示**：视口变了就重算，没有用户输入，因此不需要反向换算，
 * 也不需要持久化（滑杆时代那套 `sliderPercentToZoom` / `read/saveZoomSliderPercent`
 * 随滑杆一起删掉了）。
 *
 * 非法输入（NaN / Infinity / ≤0）一律夹到下限，不抛错 —— 视口在首帧可能是 0，
 * 抛错会让整个画布白屏，代价远大于显示一个不精确的数字。
 */
export function zoomToPercent(zoom: number): number {
  if (Number.isNaN(zoom) || zoom <= 0) return CANVAS_ZOOM_MIN_PERCENT;
  return clampZoomPercent(zoom * 100);
}

/* ---------------- LOD 抽象模式 ---------------- */

/**
 * 缩到**这个倍率以下**进入抽象模式（节点降级成轻量卡片）。
 *
 * 为什么需要它：几十上百张卡时，每张都带右侧操作栏、入场动画、合成层。
 * 缩到 15% 以下时那些小控件在屏幕上只有一两个像素，谁也点不到、看不清，
 * 却照样参与布局与合成 —— 平移和缩放就掉帧。
 */
export const LOD_IN_ZOOM = 0.15;

/**
 * 放大到**这个倍率以上**退出抽象模式。
 *
 * **迟滞（hysteresis）是这一节唯一容易写错的地方**：进/出用同一个阈值时，
 * 缩放停在临界点上会反复翻转，每次翻转都重建全部节点，画面持续闪烁。
 * 0.15~0.20 这一段是「保持现状」的死区 —— 停在这里不进也不出。
 */
export const LOD_OUT_ZOOM = 0.2;

/**
 * 由「当前是否抽象」与「新的缩放倍率」算出「新的是否抽象」。
 *
 * 纯函数：不读 DOM、不碰 React，方便单测覆盖临界与死区。
 * 注意入参是**当前状态**而不是上一帧的 zoom —— 状态机只看自己现在在哪个档，
 * 这样即便某次 onMove 丢了（快速拖动时的合并帧），下一次也能自愈。
 */
export function nextLod(current: boolean, zoom: number): boolean {
  if (!current && zoom < LOD_IN_ZOOM) return true;
  if (current && zoom > LOD_OUT_ZOOM) return false;
  return current;
}

/**
 * 预览缩放纯函数：平移夹紧 + 缩放范围。
 * 与组件解耦便于单测——交互状态的数学边界集中在这里，改 UI 不碰算法。
 */

/** 预览缩放范围 */
export const ZOOM_MIN = 0.2;
export const ZOOM_MAX = 8;

export const clampZoom = (zoom: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));

/**
 * 限制平移范围：放大后至少让图片主体留在可视区内（中心对称夹紧）。
 * @param pan 期望平移（px）
 * @param zoom 当前缩放
 * @param box 图片布局盒（fit 到容器后的实际尺寸）
 * @param viewport 可视区尺寸
 */
export function clampPreviewPan(
  pan: { x: number; y: number },
  zoom: number,
  box: { width: number; height: number },
  viewport: { width: number; height: number },
): { x: number; y: number } {
  if (!box.width || !box.height) return pan;
  const scaledW = box.width * zoom;
  const scaledH = box.height * zoom;
  const maxX = Math.max(0, (scaledW - viewport.width) / 2);
  const maxY = Math.max(0, (scaledH - viewport.height) / 2);
  return {
    x: Math.min(maxX, Math.max(-maxX, pan.x)),
    y: Math.min(maxY, Math.max(-maxY, pan.y)),
  };
}

/* ---------------- 缩放倍率 ↔ 真实像素 ----------------
 *
 * 预览里的 `zoom` 是**叠在「已适应窗口的布局盒」之上的倍率**，不是相对原始像素的倍率：
 * `<img>` 带 `max-width/max-height:100%`，一显示就已经被缩到窗口里了。
 * 于是 `zoom = 1` 只等于「刚打开时的大小」——对一张 1024×1536 的图，屏幕上可能只有 68%，
 * 而读数却写着 100%（曾因此把「1:1」按钮做成与「适应窗口」完全相同的动作）。
 *
 * 换算用 `layoutScale`：一张图在布局盒里被缩了多少。
 * - 真实百分比 = `zoom × layoutScale`
 * - 显示到 100%（1 图像像素 = 1 屏幕像素）所需的 zoom = `1 / layoutScale`
 */

/** 图片在布局盒里的缩放比（≤1 时表示被缩小过；0 表示还没测量） */
export function layoutScale(
  natural: { width: number; height: number } | null,
  box: { width: number; height: number },
): number {
  if (!natural || !natural.width || !box.width) return 1;
  return box.width / natural.width;
}

/** 相对原始像素的真实显示百分比（四舍五入到整数） */
export function actualZoomPercent(
  zoom: number,
  natural: { width: number; height: number } | null,
  box: { width: number; height: number },
): number {
  return Math.round(zoom * layoutScale(natural, box) * 100);
}

/** 「实际大小（1:1）」对应的 zoom：让 1 图像像素 = 1 屏幕像素，并夹进允许的缩放范围 */
export function zoomForActualPixels(
  natural: { width: number; height: number } | null,
  box: { width: number; height: number },
): number {
  const scale = layoutScale(natural, box);
  if (!scale) return 1;
  return clampZoom(1 / scale);
}

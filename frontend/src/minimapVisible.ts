/**
 * 画布小地图开关 + 缩放读数归一化的纯逻辑。
 *
 * 两者都是**纯偏好/纯显示**：没有图、没有服务端状态。
 * 小地图一个布尔落 localStorage；缩放读数是视口的派生显示，不落盘
 * （2026-10-29 移除了缩放滑杆：滚轮与「放大/缩小」按钮已够用，滑杆只是多一条要维护的双向同步）。
 * 读写风格与 canvasBounds.ts / accent.ts / wallpaperStore.ts 一致 ——
 * 非法 / 空白一律当未设置，try/catch 静默降级（隐私模式下 localStorage 不可用时不影响本次会话）。
 *
 * 为什么小地图默认关：占画布一角固定面积，对「只有几张卡片」的轻量用法是纯负担；
 * 只有卡片铺开后才值得开，用户显式打开才落盘。
 */

/** 小地图开关的存储键（仅本机浏览器） */
export const MINIMAP_STORAGE_KEY = "imagora.canvas-minimap.v1";

/** 读小地图开关；未设置 / 空白 / 非法一律回落默认值 false（= 不显示小地图） */
export function readMinimapVisible(): boolean {
  try {
    const raw = localStorage.getItem(MINIMAP_STORAGE_KEY);
    if (raw === null || raw.trim() === "") return false;
    return raw.trim() !== "0" && raw.trim() !== "false";
  } catch {
    return false;
  }
}

/** 写小地图开关；存储不可用时静默不持久化（本次会话仍然生效） */
export function saveMinimapVisible(visible: boolean): void {
  try {
    localStorage.setItem(MINIMAP_STORAGE_KEY, visible ? "1" : "0");
  } catch {
    /* 隐私模式等场景下 localStorage 不可用：不持久化，不影响本次会话 */
  }
}

/**
 * 画布缩放的可显示行程（百分比，整数）。
 *
 * 下限 5 与 ReactFlow 的 minZoom={0.05} 对齐；上限 200 与 maxZoom={2} 对齐。
 * 刻意不做成函数参数 —— 它们必须和 CanvasPage 里的 ReactFlow props 同步，
 * 参数化会让两处数字各自漂移（读数写着 400% 而视口早就到底了，是最难查的一类 bug）。
 */
export const CANVAS_ZOOM_MIN_PERCENT = 5;
export const CANVAS_ZOOM_MAX_PERCENT = 200;

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
  return Math.min(
    CANVAS_ZOOM_MAX_PERCENT,
    Math.max(CANVAS_ZOOM_MIN_PERCENT, Math.round(percent)),
  );
}

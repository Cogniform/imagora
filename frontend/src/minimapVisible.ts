/**
 * 画布小地图开关 + 缩放滑杆的纯逻辑。
 *
 * 两个都是**纯偏好项**：没有图、没有服务端状态，一个布尔 / 一个数字落 localStorage。
 * 读写风格与 canvasBounds.ts / accent.ts / wallpaperStore.ts 一致 ——
 * 非法 / 空白一律当未设置，try/catch 静默降级（隐私模式下 localStorage 不可用时不影响本次会话）。
 *
 * 为什么默认关：小地图占画布右下角一块固定面积（160×110），
 * 对「只有几张卡片」的轻量用法是纯负担；只有卡片铺开后才值得开。
 * 默认值是 false，用户显式打开才落盘。
 */

/** 小地图开关的存储键（仅本机浏览器） */
export const MINIMAP_STORAGE_KEY = "imagora.canvas-minimap.v1";

/** 缩放滑杆的存储键（仅本机浏览器；记的是「上次滑杆位置」，不是视口缩放） */
export const ZOOM_SLIDER_STORAGE_KEY = "imagora.canvas-zoom-slider.v1";

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
 * 缩放滑杆的行程（百分比，整数）。
 *
 * 下限 5 与 ReactFlow 的 minZoom={0.05} 对齐；上限 200 与 maxZoom={2} 对齐。
 * 上下限刻意不放进函数参数 —— 它们必须和 CanvasPage 里的 ReactFlow props 同步，
 * 做成参数会让两处数字漂移（滑杆拖到底但视口还在缩，是最难查的一类 bug）。
 */
export const ZOOM_SLIDER_MIN_PERCENT = 5;
export const ZOOM_SLIDER_MAX_PERCENT = 200;

/**
 * 缩放倍数 → 滑杆位置（百分比整数）。
 *
 * 用**直接百分比**（p = 100z）而不是对数刻度：
 * 滑杆行程 5%~200% 与缩放区间 0.05~2 的跨度**都正好是 40 倍**，
 * 端点对齐后对数映射在数学上精确退化为 p = 100z（ln p = ln 100 + ln z 里系数恰为 1），
 * 写一套 log 运算只是把同一根直线算两遍，还多出浮点误差。
 * 直接百分比另有两个好处：滑杆读数就是用户看到的缩放百分比（不必再解释），
 * 且 100% 天然落在行程 48.7% 处，接近居中。
 *
 * 非法输入（NaN / Infinity / ≤0）一律夹到下限，不抛错 —— 滑杆是受控组件，
 * 抛错会让整个画布白屏，代价远大于显示一个不精确的位置。
 */
export function zoomToSliderPercent(zoom: number): number {
  if (Number.isNaN(zoom) || zoom <= 0) return ZOOM_SLIDER_MIN_PERCENT;
  return clampSliderPercent(zoom * 100);
}

/**
 * 滑杆位置（百分比）→ 缩放倍数。
 *
 * 与 zoomToSliderPercent 互为反函数（往返误差 < 1e-9，单测有断言）。
 * 非法输入一律夹到下限再换算，理由同上。
 */
export function sliderPercentToZoom(percent: number): number {
  return clampSliderPercent(percent) / 100;
}

/**
 * 把任意数字夹进滑杆行程并取整。
 *
 * NaN 走下限（滑杆是受控组件，位置必须是个数）；±Infinity 按方向夹到端点 ——
 * 视口算出 Infinity 通常是「节点还没测量」，夹到端点比夹到下限更接近用户预期。
 */
export function clampSliderPercent(percent: number): number {
  if (Number.isNaN(percent)) return ZOOM_SLIDER_MIN_PERCENT;
  if (percent === Number.POSITIVE_INFINITY) return ZOOM_SLIDER_MAX_PERCENT;
  if (percent === Number.NEGATIVE_INFINITY) return ZOOM_SLIDER_MIN_PERCENT;
  return Math.min(ZOOM_SLIDER_MAX_PERCENT, Math.max(ZOOM_SLIDER_MIN_PERCENT, Math.round(percent)));
}

/** 读上次的滑杆位置；未设置 / 空白 / 非法一律回落 100（= 原始大小） */
export function readZoomSliderPercent(): number {
  try {
    const raw = localStorage.getItem(ZOOM_SLIDER_STORAGE_KEY);
    if (raw === null || raw.trim() === "") return 100;
    const parsed = Number.parseInt(raw.trim(), 10);
    return clampSliderPercent(Number.isNaN(parsed) ? 100 : parsed);
  } catch {
    return 100;
  }
}

/** 写滑杆位置；存储不可用时静默不持久化 */
export function saveZoomSliderPercent(percent: number): void {
  try {
    localStorage.setItem(ZOOM_SLIDER_STORAGE_KEY, String(clampSliderPercent(percent)));
  } catch {
    /* 隐私模式等场景下 localStorage 不可用：不持久化，不影响本次会话 */
  }
}

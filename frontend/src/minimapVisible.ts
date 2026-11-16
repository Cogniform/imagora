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

/* 缩放读数的归一化（`zoomToPercent` / `clampZoomPercent` / 行程常量）已移到
 * `zoom.ts` —— 那些数字必须与 ReactFlow 的 minZoom/maxZoom、fitView 参数同源，
 * 归到「缩放唯一真值表」里才不会被改漏。这里只留小地图开关。 */


/**
 * 画布缩略图：把原图缩到「卡片实际需要的尺寸」再显示。
 *
 * ## 为什么需要它
 *
 * 出图默认 3072×4096 这类大图，浏览器显示一张就要在内存里摊开一份 RGBA：
 * `3072 × 4096 × 4 ≈ 48 MB`。而画布卡片只显示 128×160，等于为了看指甲盖大的方格子
 * 摊开整张原图。十几张卡片同时可见时，光位图就能吃掉几百 MB —— 拖动画布发涩、
 * 切面板回来顿一下，主要都是它。
 *
 * 所以：**卡片一律用缩略图，原图只在双击预览 / 裁剪 / 放大 / 蒙版时加载。**
 *
 * ## 为什么在浏览器里缩，而不是让服务端出图
 *
 * 服务端要缩图就得引入图像库（或用系统工具），那会给插件加上运行期依赖；
 * 而缩图这件事纯属「显示层」问题。浏览器自带能力足够，且两个项目能共用同一份实现。
 *
 * ## 为什么缓存是模块级的 Map（不是组件 state）
 *
 * 画布面板切走时组件会被卸载（宿主插槽是 keyed 单条渲染），但**模块还活着**。
 * 缓存挂在模块上，切回来就不用重新解码一遍 —— 否则每次切面板都要把可见的图
 * 重新摊开一次，等于把要解决的问题又请回来。只有整页刷新才会清空。
 *
 * 缓存有上限并做 LRU：缩略图很小（几十 KB），但仍要防止长会话里无界增长；
 * 被淘汰的条目会 `revokeObjectURL`，否则 blob URL 永不释放。
 */

/** 缩略图长边（px）。卡片显示 128×160；这一档在 2× 屏与适度放大下仍然清晰，
 *  再往上加就是拿内存换肉眼看不出的锐度。 */
export const THUMB_MAX_EDGE = 512;

/** 缓存条目上限：约 240 × 几十 KB ≈ 十几 MB，足够覆盖一整块画布。 */
export const THUMB_CACHE_LIMIT = 240;

/** src → 已生成的 blob URL（键是原图 URL，天然带资产 id，不会串图） */
const cache = new Map<string, string>();

/** src → 进行中的生成（同一张图被多张卡片引用时只解码一次） */
const inflight = new Map<string, Promise<string>>();

/**
 * 缩略图的目标尺寸：等比缩到长边 `maxEdge` 以内，**绝不放大**。
 *
 * 纯函数，非法入参（NaN / 0 / 负数）一律返回 `null`（由调用方退回原图），
 * 不产出 0 或负尺寸 —— `canvas.width = 0` 会让 `toBlob` 抛错。
 */
export function thumbTargetSize(
  width: number,
  height: number,
  maxEdge: number = THUMB_MAX_EDGE,
): { width: number; height: number } | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(maxEdge)) return null;
  if (width <= 0 || height <= 0 || maxEdge <= 0) return null;
  if (width <= maxEdge && height <= maxEdge) return null;
  const scale = maxEdge / Math.max(width, height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** 已生成好的缩略图 URL；没有就返回 null（调用方据此先显示占位，不加载原图）。 */
export function cachedThumbnail(src: string): string | null {
  const hit = cache.get(src);
  if (hit === undefined) return null;
  // LRU：用过的挪到队尾，淘汰时从队首拿走最久没用的
  cache.delete(src);
  cache.set(src, hit);
  return hit;
}

function remember(src: string, url: string): void {
  cache.set(src, url);
  while (cache.size > THUMB_CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done === true) break;
    const stale = cache.get(oldest.value);
    cache.delete(oldest.value);
    if (stale !== undefined) URL.revokeObjectURL(stale);
  }
}

/**
 * 把图片解码成缩略图 blob URL。
 *
 * 两条路径都要有：`createImageBitmap` 带 `resize*` 选项时浏览器可以**按目标尺寸解码**
 * （JPEG 走这条，省掉整张位图）；不支持或抛错时退回「先解码再画到画布上」——
 * 结果一样，只是多一次瞬时全尺寸解码。
 *
 * 任何一步失败都返回原图 URL：缩略图是优化，不该让图变成空白。
 */
async function renderThumbnail(src: string, maxEdge: number): Promise<string> {
  const response = await fetch(src);
  if (!response.ok) throw new Error(`缩略图取图失败：${response.status}`);
  const blob = await response.blob();

  const bitmap = await createImageBitmap(blob);
  const target = thumbTargetSize(bitmap.width, bitmap.height, maxEdge);
  // 已经比目标还小：直接用原图，没必要再造一份
  if (target === null) {
    bitmap.close();
    return src;
  }

  const canvas = document.createElement("canvas");
  canvas.width = target.width;
  canvas.height = target.height;
  const context = canvas.getContext("2d");
  if (context === null) {
    bitmap.close();
    return src;
  }
  context.drawImage(bitmap, 0, 0, target.width, target.height);
  bitmap.close();

  const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.9));
  if (out === null) return src;
  return URL.createObjectURL(out);
}

/**
 * 取缩略图 URL：命中缓存直接返回，否则生成一次（同一张图并发调用只跑一趟）。
 *
 * 失败会退回原图 URL —— 调用方永远拿到一个能显示的地址。
 */
export function loadThumbnail(src: string, maxEdge: number = THUMB_MAX_EDGE): Promise<string> {
  const hit = cachedThumbnail(src);
  if (hit !== null) return Promise.resolve(hit);
  const running = inflight.get(src);
  if (running !== undefined) return running;

  const job = renderThumbnail(src, maxEdge)
    .catch(() => src)
    .then((url) => {
      inflight.delete(src);
      if (url !== src) remember(src, url);
      return url;
    });
  inflight.set(src, job);
  return job;
}

/** 清空缓存并释放 blob URL（测试用；也留给「换目录」这类需要重来的场景）。 */
export function clearThumbnailCache(): void {
  for (const url of cache.values()) URL.revokeObjectURL(url);
  cache.clear();
  inflight.clear();
}

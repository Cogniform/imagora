/**
 * 图片卡片上用的缩略图取数 hook。
 *
 * 卡片只显示 128×160，而原图是 3072×4096 —— 直接 `src={原图}` 等于为看一个小方格
 * 摊开 48 MB 位图，十几张卡就是几百 MB。这里统一走 `thumbnails` 的会话缓存：
 *
 * - 命中缓存 → **同步**返回（首帧就是图，切走面板再回来不会闪一下空白）；
 * - 没命中 → 先返回 `null`（卡片显示占位），后台生成好再换上来；
 * - 生成失败 / 本来就比目标还小 → 返回**原图地址**（与加这个 hook 之前的行为一致）。
 *
 * **原图地址仍然归调用方管**：双击预览 / 裁剪 / 放大 / 蒙版要的是真实像素，
 * 一律传 `data.url`，不能拿缩略图凑数。
 */
import { useEffect, useState } from "react";

import { cachedThumbnail, loadThumbnail } from "./thumbnails";

export function useThumbnail(src: string | undefined): string | null {
  // 首帧先查缓存：命中就不必等一个 effect 周期，避免「先空一下再出图」
  const [resolved, setResolved] = useState<{ src: string; url: string } | null>(() => {
    if (!src) return null;
    const hit = cachedThumbnail(src);
    return hit === null ? null : { src, url: hit };
  });

  useEffect(() => {
    if (!src) return undefined;
    const hit = cachedThumbnail(src);
    if (hit !== null) {
      setResolved({ src, url: hit });
      return undefined;
    }
    let cancelled = false;
    void loadThumbnail(src).then((url) => {
      // 失败时 loadThumbnail 原样返回 src → 卡片退回原图，与旧行为一致
      if (!cancelled) setResolved({ src, url });
    });
    return () => {
      cancelled = true;
    };
  }, [src]);

  // src 变了但新地址还没解析出来：返回 null，绝不拿上一张的缩略图顶上
  if (resolved === null || resolved.src !== src) return null;
  return resolved.url;
}

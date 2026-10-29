import { useCallback, useState } from "react";

/**
 * 图片预览的开关状态（Gallery 结果图 / HistoryGallery 生产历史 / 上传区缩略图共用）。
 *
 * 交互契约（2026-10-29 起）：**单击不打开任何新页面**，双击才开放大预览；
 * 复制（图片本体 / 文件路径）与「新标签打开」都在预览弹窗里作为显式按钮提供。
 *
 * 早先的实现是「单击延时 250ms 开原图、双击取消那次开窗再放大」。那套时序有两个问题：
 * ① 单击意味着「跳走」——在结果墙/历史列表里点一下图就把浏览器切到新标签，
 *    用户只是想看看这张图，却丢了当前上下文；
 * ② 靠 250ms 延时区分单击与双击，慢一点的双击会先开窗再放大，连闪两个标签。
 * 现在单击什么都不做，双击直达预览，不再需要任何延时或未决定时器
 * （`CLICK_OPEN_DELAY_MS` 与它对应的清理逻辑一起删掉了）。
 */

export interface ZoomTarget {
  url: string;
  name: string;
  /** 图片在本机的绝对路径（预览里「复制路径」用）；未知时不传，那个按钮就不出现 */
  path?: string | undefined;
}

export function useImageZoom() {
  const [zoom, setZoom] = useState<ZoomTarget | null>(null);

  /** 双击缩略图：打开放大预览 */
  const openZoom = useCallback((item: ZoomTarget) => setZoom(item), []);
  const closeZoom = useCallback(() => setZoom(null), []);

  return { zoom, openZoom, closeZoom };
}

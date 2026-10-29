/**
 * 从图片 URL 反解本机绝对路径。
 *
 * 背景：预览弹窗要提供「复制文件路径」，但结果图/历史图只拿到注册表派生的
 * `url`（`/api/image?path=<编码后的绝对路径>`，单一产地见 core/registry.py:image_url）。
 * 与其让每个组件各写一遍 `split("?")`，不如收成一处并加单测 —— 画布回流那边
 * 早就有一份同样逻辑的内联版本（CanvasPage 里解析结果图 path），将来一并收口到这里。
 *
 * 只认 `path=` 这一种形态：其它来源（外链图片、blob:、data:）一律返回空串，
 * 调用方据此**不显示**「复制路径」按钮，而不是显示一个点了没用的按钮。
 */

/** 从 `/api/image?path=...` 这类 URL 取回绝对路径；取不到返回空串 */
export function imagePathFromUrl(url: string): string {
  if (!url) return "";
  const queryStart = url.indexOf("?");
  if (queryStart < 0) return "";
  const query = url.slice(queryStart + 1);
  const value = new URLSearchParams(query).get("path");
  return value ? value : "";
}

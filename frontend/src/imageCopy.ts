/**
 * 图片写进剪贴板（预览弹窗的「复制图片」用）。
 *
 * **两条路，优先走服务端**（2026-11-01 实测后改；背景见 ARCHITECTURE 8.3）：
 * ① 服务端同步写 —— 有本机绝对路径时调 `POST /api/clipboard/image`，后端直接
 *    `SetClipboardData(CF_DIB)`，**接口返回即代表别的程序已经能粘到**；
 * ② 浏览器 API —— 没有路径（外链 / blob 占位图）或服务端这条走不通时退回
 *    `navigator.clipboard.write()`。它有三个现实约束：只接受 **PNG** 的
 *    `ClipboardItem`（生成结果可能是 jpeg / webp，非 PNG 一律先经 canvas 转码）、
 *    必须在**用户手势**里调用、要安全上下文（`127.0.0.1` / `localhost` 算安全）。
 *
 * 为什么优先服务端：浏览器写图片是**异步投递**，Promise resolve 时系统剪贴板里
 * 还没有位图，要 100~300ms 后才读得到（大图更久，偶发整次丢弃），页面失活时还会
 * 被挂起 —— 表现就是「提示已复制、切到微信立刻 Ctrl+V 是空的」。服务端那条没有
 * 这层异步，也因此"复制成功"的提示对用户才作数。
 *
 * 失败一律抛错，由调用方给用户一句人话 —— 静默失败会让人以为图已经复制了。
 * 本模块不做 canvas 层的单测：jsdom 里没有 `getContext("2d")`（见 README：不装
 * canvas 包）；`imageCopy.test.ts` 只锁「走哪条路 / 怎么回退」这层决策。
 */

import { copyImageToSystemClipboard } from "./api";

/** 复制目标：URL 用来退回浏览器路径，本机绝对路径用来走服务端同步写 */
export interface ImageCopySource {
  url: string;
  /** 本机绝对路径；不给（外链 / blob / data URL）就只走浏览器路径 */
  path?: string | undefined;
}

/** 把任意图片 URL 读成 PNG Blob（浏览器路径专用） */
async function readAsPngBlob(url: string): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`读取图片失败（HTTP ${response.status}）`);
  const blob = await response.blob();
  if (blob.type === "image/png") return blob;

  // 非 PNG：解码 → 画到 canvas → 导出 PNG。用 createImageBitmap 优先（不阻塞主线程解码）
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("浏览器不支持 canvas，无法转换图片格式");
    ctx.drawImage(bitmap, 0, 0);
    const png = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    if (!png) throw new Error("图片格式转换失败");
    return png;
  } finally {
    bitmap.close();
  }
}

/** 浏览器路径：读图 → 转码 → `clipboard.write`；失败抛 Error */
async function copyImageViaBrowser(url: string): Promise<void> {
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
    throw new Error("当前浏览器不支持复制图片，请改用「复制路径」");
  }
  const png = await readAsPngBlob(url);
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

/** 把图片复制到系统剪贴板；失败抛 Error（调用方负责提示） */
export async function copyImageToClipboard(source: ImageCopySource): Promise<void> {
  if (source.path) {
    try {
      await copyImageToSystemClipboard(source.path);
      return;
    } catch {
      // 旧服务端（405）/ 非 Windows / 依赖缺失：功能不能因此消失，退回浏览器路径
    }
  }
  await copyImageViaBrowser(source.url);
}

/** 复制一段文本（路径 / 提示词）；剪贴板不可用时抛错，让调用方给出提示 */
export async function copyTextToClipboard(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) throw new Error("浏览器不允许访问剪贴板");
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // 浏览器的原始拒绝理由（NotAllowedError: denied …）对用户没有信息量，
    // 统一换成「该怎么办」的说法；这一点与 CopyChip（静默失败）刻意不同：
    // 那里失败只是没高亮，这里失败会让用户以为已经复制走了。
    throw new Error("复制失败：浏览器拒绝了剪贴板访问");
  }
}

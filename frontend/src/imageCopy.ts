/**
 * 图片写进剪贴板（预览弹窗的「复制图片」用）。
 *
 * 两个现实约束决定了实现形态：
 * ① 浏览器只接受 **PNG** 的 `ClipboardItem`（Chrome/Safari 都是），而生成结果可能是
 *    jpeg / webp，所以非 PNG 一律先经 canvas 转成 PNG；
 * ② 必须在**用户手势**里调用，且要安全上下文（`127.0.0.1` / `localhost` 算安全）。
 *
 * 失败一律抛错，由调用方给用户一句人话 —— 静默失败会让人以为图已经复制了。
 * 本模块不做单测：canvas 在 jsdom 里没有 `getContext("2d")`（见 README：不装 canvas 包），
 * 与 `imageOps.ts` 的 B 层同属「只由类型与真机验证兜底」的一层。
 */

/** 把任意图片 URL 读成 PNG Blob */
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

/** 把图片复制到系统剪贴板；失败抛 Error（调用方负责提示） */
export async function copyImageToClipboard(url: string): Promise<void> {
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
    throw new Error("当前浏览器不支持复制图片，请改用「复制路径」");
  }
  const png = await readAsPngBlob(url);
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
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

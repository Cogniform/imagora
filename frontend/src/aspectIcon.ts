/**
 * 比例预览图标的几何计算 + 从尺寸标签反解比例（纯函数，不依赖 React）。
 *
 * ## 为什么图标尺寸要算，而不是写死
 *
 * 尺寸下拉里每一项都是「1536x1024 (3:2 横版)」这种文字，光看数字判断不出谁横谁竖。
 * 给每项配一个同比例的小矩形，用户扫一眼就知道「这条是横的、那条是竖的」——
 * 所以矩形必须按真实比例算，不能一律画成正方形。
 *
 * ## 短边为什么要夹一个下限
 *
 * 24px 的长边配上 `7:4`、`16:9` 这类比例时，短边只剩 10~13px 还看得见；
 * 但极端比例（用户自建来源可以填任意尺寸）会把短边压到 1~2px，看起来就是一条线，
 * 反而认不出是矩形。因此短边夹到 `ASPECT_ICON_MIN_SHORT`：宁可略微失真，也要保住
 * 「这是个矩形」的形状识别。失真只在极端比例下发生，常用比例（1:1 / 3:2 / 16:9）都
 * 在 24px 长边下算出来 ≥13px，不受影响。
 *
 * ## 比例从哪来（重要：标签的真实格式）
 *
 * 尺寸标签由后端 `core/config.py` 的 `size_options` 下发，实测格式是
 * `"1024x1024 (1:1 1K)"` / `"1024x1536 (2:3 竖版)"` / `"1152x2048 (9:16 竖版长图)"`，
 * **不是**带价格后缀的写法（价格是独立的 `cost` 字段，不进 label）。
 *
 * 关键坑：`"1024x1792 (竖版长图)"` 与 `"1792x1024 (横版长图)"` 括号里**根本没有 a:b**，
 * 只有中文方位词。所以必须有「退回 WxH 宽高比」这一层，否则这两项拿不到比例、
 * 图标直接不渲染 —— 而它们恰恰是用户最容易搞混横竖的两项。
 */

/** 图标长边（px）。24 是下拉行高内不撑高的上限。 */
export const ASPECT_ICON_LONG = 24;

/** 短边下限（px）：低于它就看不出是矩形了（见文件头说明）。 */
export const ASPECT_ICON_MIN_SHORT = 10;

/** 图标外框尺寸（px） */
export interface AspectIconSize {
  width: number;
  height: number;
}

/**
 * 括号里的比例，如 `"(1:1 1K)"` / `"(9:16 竖版长图)"` 里的 `1:1`、`9:16`。
 *
 * 只认括号内的：括号外可能还有别的数字（成本、像素），无差别匹配会抓错。
 */
const PAREN_RATIO_RE = /\([^)]*?(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)[^)]*\)/;

/**
 * 不带括号的裸比例。给「label 直接就是 `1:1`」的写法兜底
 * （`SizeOption.label` 在测试数据与部分自建来源里出现过这种精简写法）。
 */
const BARE_RATIO_RE = /(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/;

/** 宽高像素，如 `1024x1024`；分隔符兼容 x / X / × / *（自建来源手填可能有全角乘号）。 */
const PIXEL_SIZE_RE = /(\d+)\s*[x×*]\s*(\d+)/i;

/**
 * 按比例算图标外框尺寸：长边恒为 `long`，短边按比例缩放并夹到下限。
 *
 * - `ratio >= 1`（横版或正方形）：宽 = long，高 = 长边 / 比例；
 * - `ratio < 1`（竖版）：高 = long，宽 = 长边 × 比例；
 * - 非法比例（NaN / ±Infinity / ≤0）：回落正方形 `{ long, long }` —— 图标照常画出来，
 *   只是不带比例信息，比「不渲染」更容易发现问题。
 * @param ratio 宽高比（宽 / 高）
 * @param long 长边像素；非法值回落 `ASPECT_ICON_LONG`
 * @returns 图标外框的宽高（整数 px）
 */
export function aspectIconSize(ratio: number, long: number = ASPECT_ICON_LONG): AspectIconSize {
  const edge = Number.isFinite(long) && long > 0 ? long : ASPECT_ICON_LONG;
  if (!Number.isFinite(ratio) || ratio <= 0) return { width: edge, height: edge };
  if (ratio >= 1) {
    return { width: edge, height: Math.max(ASPECT_ICON_MIN_SHORT, Math.round(edge / ratio)) };
  }
  return { width: Math.max(ASPECT_ICON_MIN_SHORT, Math.round(edge * ratio)), height: edge };
}

/** 把两个数字字符串折成比例；任一侧非正 / 非有限则返回 null（视为「这层没解析到」）。 */
function ratioFromPair(width: string | undefined, height: string | undefined): number | null {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return w / h;
}

/**
 * 从尺寸标签解析宽高比，解析不到返回 `null`（调用方据此不渲染图标）。
 *
 * 解析顺序（前面的命中就不再看后面的）：
 * 1. 括号里的 `a:b` —— 最权威，是后端显式标注的比例；
 * 2. 裸 `a:b` —— 兼容 label 直接写 `1:1` 的精简写法；
 * 3. `WxH` 宽高比 —— `"1024x1792 (竖版长图)"` 这类**括号里没有比例**的项靠它兜底。
 * @param label 尺寸标签，如 `"1536x1024 (3:2 横版)"`
 * @returns 宽高比；三层都没解析到（或解析出非正数）返回 `null`
 */
export function ratioFromSizeLabel(label: string): number | null {
  const paren = PAREN_RATIO_RE.exec(label);
  if (paren) {
    const ratio = ratioFromPair(paren[1], paren[2]);
    if (ratio !== null) return ratio;
  }
  const bare = BARE_RATIO_RE.exec(label);
  if (bare) {
    const ratio = ratioFromPair(bare[1], bare[2]);
    if (ratio !== null) return ratio;
  }
  const pixels = PIXEL_SIZE_RE.exec(label);
  if (pixels) return ratioFromPair(pixels[1], pixels[2]);
  return null;
}

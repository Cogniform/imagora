/**
 * 蒙版笔刷的纯几何 / 状态函数（零 UI 依赖，配 `maskBrush.test.ts` 单测）。
 *
 * 三条贯穿全模块的约定，改动前先读：
 *
 * 1. **坐标一律归一化 0..1**（`BrushPoint` 相对原图宽高）。
 *    canvas 的显示尺寸随窗口变，存像素坐标会让同一笔在缩放后错位；
 *    归一化后只在渲染 / 导出时乘一次宽高，缩放天然跟随。
 *
 * 2. **`size` 是「占图片短边的比例」，不是像素**（见 `brushRadiusPx`）。
 *    同一笔在 4K 图和 512 图上的视觉粗细应该一致；用像素做单位，
 *    大图上笔刷会细如发丝、小图上一下糊掉整张图。
 *
 * 3. **`appendPoint` 会节流**：新点离上一点太近就**返回原数组引用**（不是拷贝）。
 *    pointermove 每秒能来上百次，不节流的话 strokes 数组会涨到几十万点，
 *    撤销栈与导出（逐点画圆）全部卡死。调用方靠 `next === points` 判断
 *    「这一帧没变」，从而跳过 setState。
 *
 * 「只擦不涂」≠「涂过」：`hasPaint` / `isMaskEmpty` 分开判，理由见各自注释。
 */

/** 笔刷模式：涂白 / 擦除 */
export type BrushMode = "paint" | "erase";

/** 归一化坐标点（0..1，相对原图宽高） */
export interface BrushPoint {
  x: number;
  y: number;
}

/** 一笔：模式 + 笔刷大小（占短边比例）+ 归一化点列 */
export interface MaskStroke {
  mode: BrushMode;
  size: number;
  points: BrushPoint[];
}

/** 图片像素尺寸 */
export interface BrushSize {
  width: number;
  height: number;
}

/** 归一化包围盒（0..1，左 / 上 / 右 / 下） */
export interface BrushBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 笔刷直径占图片短边的最小比例（1%） */
export const MASK_BRUSH_MIN = 0.01;

/** 笔刷直径占图片短边的最大比例（40%） */
export const MASK_BRUSH_MAX = 0.4;

/** 默认笔刷大小（短边的 8%）：小图够细、大图不至于细到看不见 */
export const MASK_BRUSH_DEFAULT = 0.08;

/**
 * 相邻采样点的最小归一化间距（0.4%）。
 * 归一化空间的欧氏距离——本函数没有 image 参数，非方形图上 x / y 的像素尺度不同，
 * 但节流只需要「够近了」这个量级判断，不值得为它多传一个尺寸。
 */
export const MASK_POINT_MIN_GAP = 0.004;

/** 单次插值最多补几个点：只防病态输入（指针跳到图外再跳回来），正常拖动永远走不到 */
const MASK_INTERPOLATE_MAX_STEPS = 2048;

/** 坐标是否可用（NaN / ±Infinity 一律视为无效） */
function isFinitePoint(point: BrushPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

/** 把值夹进 [0, 1]；NaN 按下限 0 处理 */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * 把笔刷大小夹进 [MIN, MAX]。
 *
 * 非法值（NaN / ±Infinity）回落 `MASK_BRUSH_DEFAULT` 而不是下限：
 * 滑杆读回一个坏值时缩到 1% 会细得像发丝，用户会以为「画笔坏了」；
 * 退回默认粗细至少还能继续画。
 */
export function clampBrushSize(size: number): number {
  if (!Number.isFinite(size)) return MASK_BRUSH_DEFAULT;
  return Math.min(MASK_BRUSH_MAX, Math.max(MASK_BRUSH_MIN, size));
}

/**
 * 笔刷半径（**原图像素**）。
 *
 * `size` 是直径占图片**短边**的比例，所以半径 = `size × 短边 / 2`。
 * 用短边而不是长边 / 面积：短边决定「一眼看过去的粗细」，
 * 拿长边做基准会让 16:9 图上的笔刷比 1:1 图上粗一截。
 *
 * 尺寸退化（0 / 负数 / NaN）返回 0——调用方据此跳过绘制，不抛错。
 */
export function brushRadiusPx(size: number, image: BrushSize): number {
  const shortEdge = Math.min(image.width, image.height);
  if (!Number.isFinite(shortEdge) || shortEdge <= 0) return 0;
  return (clampBrushSize(size) * shortEdge) / 2;
}

/**
 * `appendPoint` 节流命中时返回**原数组引用**（调用方靠 `next === points` 跳过 setState）。
 * 入参是 `readonly`，这里把引用原样交还：函数本身不改它，只是签名收窄过。
 */
function sameReference(points: readonly BrushPoint[]): BrushPoint[] {
  return points as BrushPoint[];
}

/**
 * 追加一个采样点，**带节流**。
 *
 * - 空数组 → 返回含该点的新数组；
 * - 与最后一个点的归一化距离 **≤** `minGap` → 返回**原数组引用**（不是拷贝）；
 * - 否则返回新数组（不修改入参）。
 *
 * 比较用 `<=` 而不是 `<`：这样 `minGap = 0` 仍有意义 —— 它挡掉**完全重合**的点
 * （插值补点时调用方传 0，重合点会让同一处画两遍圆，白花时间），
 * 但不会挡任何真正移动过的点。传负数 / NaN 也按 0 处理。
 * 坐标非有限（NaN / ±Infinity）时整帧丢弃并返回原引用——坏事件不能污染 strokes。
 */
export function appendPoint(
  points: readonly BrushPoint[],
  point: BrushPoint,
  minGap: number = MASK_POINT_MIN_GAP,
): BrushPoint[] {
  if (!isFinitePoint(point)) return sameReference(points);
  const last = points[points.length - 1];
  if (!last) return [point];
  const gap = Number.isFinite(minGap) ? Math.max(0, minGap) : 0;
  if (Math.hypot(point.x - last.x, point.y - last.y) <= gap) return sameReference(points);
  return [...points, point];
}

/**
 * 两个采样点之间的补点（**不含** `from` / `to` 两端，调用方自己追加 `to`）。
 *
 * 快速拖动时两个 pointermove 之间可能隔很远，不插值就会画成一串断续的圆点；
 * 按 `radiusPx / 4` 的步长补点——这个密度下相邻圆重叠 75%，肉眼看是连续笔迹，
 * 又不会把点数组撑爆（步长再细只是白花内存）。
 *
 * 距离在**像素空间**里量（x 乘宽、y 乘高）：归一化空间的欧氏距离在 16:9 图上
 * 会把横向间距算大、竖向算小，补出来的点疏密不均。
 *
 * `radiusPx <= 0`（尺寸还没读到）时**不插值**：宁可这一帧点稀疏，
 * 也不要在未知尺度上瞎补点（半径 0 会让步长退化成 0，补出无穷多个点）。
 */
export function interpolatePoints(
  from: BrushPoint,
  to: BrushPoint,
  radiusPx: number,
  image: BrushSize,
): BrushPoint[] {
  if (!isFinitePoint(from) || !isFinitePoint(to)) return [];
  if (!(image.width > 0) || !(image.height > 0)) return [];
  if (!Number.isFinite(image.width) || !Number.isFinite(image.height)) return [];
  const step = radiusPx / 4;
  if (!Number.isFinite(step) || step <= 0) return [];

  const dx = (to.x - from.x) * image.width;
  const dy = (to.y - from.y) * image.height;
  const distance = Math.hypot(dx, dy);
  if (!(distance > 0)) return [];

  const rawSteps = Math.ceil(distance / step);
  if (rawSteps <= 1) return [];
  const steps = Math.min(rawSteps, MASK_INTERPOLATE_MAX_STEPS);

  const out: BrushPoint[] = [];
  for (let index = 1; index < steps; index += 1) {
    const ratio = index / steps;
    out.push({
      x: from.x + (to.x - from.x) * ratio,
      y: from.y + (to.y - from.y) * ratio,
    });
  }
  return out;
}

/**
 * 是否真的涂过（存在 **paint** 笔画且点不为空）。
 *
 * 必须和「有笔画」分开判：只擦不涂等于没涂——mask 全透明，
 * 上游拿到的是一张「整图都要重绘」的空蒙版，既花钱又白干。
 */
export function hasPaint(strokes: readonly MaskStroke[]): boolean {
  return strokes.some((stroke) => stroke.mode === "paint" && stroke.points.length > 0);
}

/**
 * 蒙版是否为空（= 没有可导出的内容）。
 *
 * 定义就是 `!hasPaint`：**只有橡皮擦笔画也算空**。确认按钮据此禁用，
 * 这是最容易漏的一条——橡皮擦在预览里看得到反馈，用户以为「我画了」。
 */
export function isMaskEmpty(strokes: readonly MaskStroke[]): boolean {
  return !hasPaint(strokes);
}

/**
 * 所有 paint 笔画的圆点包围盒（归一化 0..1），空蒙版返回 `null`。
 *
 * 每个圆点的包围盒要**减去半径**（圆半径换成归一化：x 除以图宽、y 除以图高——
 * 像素半径是各向同性的，归一化后横竖半径不相等）。
 * 结果再夹回 [0,1]：笔刷压在图边缘时圆会溢到图外，溢出的部分不属于这张图，
 * 上层拿它裁区域时夹过才准。
 *
 * 橡皮擦笔画**不进**包围盒：它不产生「要重绘」的区域。
 */
export function maskBoundingBox(strokes: readonly MaskStroke[], image: BrushSize): BrushBox | null {
  if (!Number.isFinite(image.width) || !Number.isFinite(image.height)) return null;
  if (!(image.width > 0) || !(image.height > 0)) return null;

  let box: BrushBox | null = null;
  for (const stroke of strokes) {
    if (stroke.mode !== "paint" || stroke.points.length === 0) continue;
    const radius = brushRadiusPx(stroke.size, image);
    const radiusX = radius / image.width;
    const radiusY = radius / image.height;
    for (const point of stroke.points) {
      if (!isFinitePoint(point)) continue;
      const left = clamp01(point.x - radiusX);
      const top = clamp01(point.y - radiusY);
      const right = clamp01(point.x + radiusX);
      const bottom = clamp01(point.y + radiusY);
      box =
        box === null
          ? { left, top, right, bottom }
          : {
              left: Math.min(box.left, left),
              top: Math.min(box.top, top),
              right: Math.max(box.right, right),
              bottom: Math.max(box.bottom, bottom),
            };
    }
  }
  return box;
}

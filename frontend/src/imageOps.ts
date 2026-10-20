/**
 * 图像运算模块（裁剪 / 放大的底层工具），分两层：
 *
 * - A 层纯几何数学：`CropRect` 全部使用归一化 0~1 坐标（相对原图宽高），
 *   不碰 DOM，配 `imageOps.test.ts` 单测。
 * - B 层 canvas I/O：`loadImage` / `readImageSize` / `cropDataUrl` / `upscaleDataUrl`，
 *   依赖浏览器 canvas（jsdom 没有 2D context，不写单测）。
 *   模块顶层不访问 `document` / `window`，DOM 只出现在 B 层函数体内。
 *
 * 语义移植自 basketikun-infinite-canvas（MIT）：
 * `web/src/lib/canvas/canvas-image-data.ts` 与 `canvas-node-crop-dialog.tsx`。
 */

// ============================================================
// A 层：纯几何数学
// ============================================================

/** 裁剪框，归一化坐标（0~1，相对原图宽高） */
export type CropRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** 八向拖拽手柄（n/s/e/w 及组合） */
export type CropHandle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export type ImageSize = { width: number; height: number };

export type UpscaleAlgorithm = "nearest" | "bilinear" | "high";

export type UpscaleParams = {
  /** 目标长边像素 */
  targetLongEdge: number;
  algorithm: UpscaleAlgorithm;
};

/** 放大长边上限 */
export const MAX_UPSCALE_LONG_EDGE = 4096;

/** 裁剪框最小边长（归一化） */
export const CROP_MIN_SIZE = 0.06;

/** 数值夹紧；NaN 按下限处理（拖拽数据异常时不抛错） */
export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.min(hi, Math.max(lo, value));
}

/**
 * 把任意裁剪框收拢进 [0,1]²：宽高先夹到 [minSize, 1]，再把左上角夹回界内。
 */
export function clampCrop(rect: CropRect, minSize: number = CROP_MIN_SIZE): CropRect {
  const width = clamp(rect.width, minSize, 1);
  const height = clamp(rect.height, minSize, 1);
  return {
    width,
    height,
    x: clamp(rect.x, 0, 1 - width),
    y: clamp(rect.y, 0, 1 - height),
  };
}

/** 默认裁剪框：0.76 边长的居中正方形（三边留 0.12 呼吸位） */
export function centeredSquareCrop(): CropRect {
  return { x: 0.12, y: 0.12, width: 0.76, height: 0.76 };
}

/** 平移裁剪框，夹在图内不越界 */
export function moveCrop(crop: CropRect, dx: number, dy: number): CropRect {
  return {
    ...crop,
    x: clamp(crop.x + dx, 0, 1 - crop.width),
    y: clamp(crop.y + dy, 0, 1 - crop.height),
  };
}

/**
 * 拖拽手柄改变裁剪框大小。
 *
 * @param dx dy 归一化位移（像素位移分别除以显示盒宽高）
 * @param handle 被拖的手柄，决定动哪条边、以及对侧边是否固定
 * @param aspectRatio 锁定的**像素**宽高比（如 1 = 1:1，4/3 = 4:3）；null = 自由
 * @param box 显示盒（getBoundingClientRect），用于像素比例 → 归一化比例换算
 *
 * 换算核心：`aspectRatio` 是像素比例，`CropRect` 是归一化坐标。显示盒宽 W 高 H
 * （boxAspect = H / W）时，归一化宽 1 对应 W 像素、归一化高 1 对应 H 像素，
 * 因此归一化空间的目标比例是 `normalizedRatio = aspectRatio * boxAspect`。
 * 漏了这一步，1:1 会裁出长方形。
 */
export function resizeCrop(
  crop: CropRect,
  dx: number,
  dy: number,
  handle: CropHandle,
  aspectRatio: number | null,
  box: ImageSize,
): CropRect {
  const next = { ...crop };
  if (handle.includes("e")) next.width = crop.width + dx;
  if (handle.includes("s")) next.height = crop.height + dy;
  if (handle.includes("w")) {
    next.x = crop.x + dx;
    next.width = crop.width - dx;
  }
  if (handle.includes("n")) {
    next.y = crop.y + dy;
    next.height = crop.height - dy;
  }
  if (aspectRatio !== null && aspectRatio > 0 && box.width > 0 && box.height > 0) {
    const normalizedRatio = aspectRatio * (box.height / box.width);
    const horizontalOnly =
      (handle.includes("e") || handle.includes("w")) && !handle.includes("n") && !handle.includes("s");
    // 只拖横向手柄时以宽度为准；拖角手柄时看哪根轴的位移大
    const useWidth =
      horizontalOnly || (handle.length > 1 && Math.abs(dx * box.width) >= Math.abs(dy * box.height));
    if (useWidth) next.height = next.width / normalizedRatio;
    else next.width = next.height * normalizedRatio;
    if (handle.includes("w")) next.x = crop.x + crop.width - next.width;
    if (handle.includes("n")) next.y = crop.y + crop.height - next.height;
    // 两轮夹紧：先整体缩放防越界，再兜底最小尺寸
    const scaleDown = Math.min(1, 1 / Math.max(next.width, 0.001), 1 / Math.max(next.height, 0.001));
    next.width *= scaleDown;
    next.height *= scaleDown;
    if (next.width < CROP_MIN_SIZE || next.height < CROP_MIN_SIZE) {
      const minimumScale = Math.max(
        CROP_MIN_SIZE / Math.max(next.width, 0.001),
        CROP_MIN_SIZE / Math.max(next.height, 0.001),
      );
      next.width *= minimumScale;
      next.height *= minimumScale;
    }
    // 收拢兜底：极端过拖可能产出非正 / 越界尺寸，最后一道保证
    // 「比例不变、落在 [0,1]² 内、永不为负」（正常拖拽到不了这里，值不变）
    next.width = clamp(next.width, CROP_MIN_SIZE, 1);
    next.height = clamp(next.height, CROP_MIN_SIZE, 1);
    const fitWidth = Math.min(next.width, next.height * normalizedRatio, 1);
    const fitHeight = Math.min(next.height, fitWidth / normalizedRatio, 1);
    next.width = fitHeight * normalizedRatio;
    next.height = fitHeight;
  } else {
    next.width = clamp(next.width, CROP_MIN_SIZE, 1);
    next.height = clamp(next.height, CROP_MIN_SIZE, 1);
  }
  next.x = clamp(next.x, 0, 1 - next.width);
  next.y = clamp(next.y, 0, 1 - next.height);
  return next;
}

/**
 * 把裁剪框按目标**像素**比例调整（切比例预设时用）：保持中心收缩到能放下的最大尺寸。
 * 同样要做像素比例 → 归一化比例换算（`ratio * image.height / image.width`）。
 */
export function fitCropToRatio(crop: CropRect, ratio: number, image: ImageSize): CropRect {
  const normalizedRatio = ratio * (image.height / image.width);
  let width = crop.width;
  let height = width / normalizedRatio;
  if (height > crop.height) {
    height = crop.height;
    width = height * normalizedRatio;
  }
  if (width > 1) {
    width = 1;
    height = width / normalizedRatio;
  }
  if (height > 1) {
    height = 1;
    width = height * normalizedRatio;
  }
  return {
    x: clamp(crop.x + (crop.width - width) / 2, 0, 1 - width),
    y: clamp(crop.y + (crop.height - height) / 2, 0, 1 - height),
    width,
    height,
  };
}

/** 按目标长边等比算放大后尺寸，长边夹到 MAX_UPSCALE_LONG_EDGE，最小 1px；非法目标（NaN）按 1 处理 */
export function resolveUpscaleSize(width: number, height: number, targetLongEdge: number): ImageSize {
  const longEdge = Math.max(1, width, height);
  const requested = Number.isNaN(targetLongEdge) ? 1 : targetLongEdge;
  const target = Math.min(MAX_UPSCALE_LONG_EDGE, Math.max(1, Math.round(requested)));
  const scale = target / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** 最大公约数（非负整数；0 输入回落 1，避免除零） */
export function gcd(a: number, b: number): number {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y) {
    const remainder = x % y;
    x = y;
    y = remainder;
  }
  return Math.max(1, x);
}

/** 把像素宽高约分成 "16:9" 这类显示比例 */
export function gcdRatio(width: number, height: number): string {
  const divisor = gcd(width, height);
  return `${Math.round(width / divisor)}:${Math.round(height / divisor)}`;
}

// ============================================================
// B 层：canvas I/O（jsdom 无 2D context，不写单测）
// ============================================================

/** 把 dataUrl 加载成 HTMLImageElement；加载失败 reject */
export function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`图片加载失败：${dataUrl.slice(0, 64)}`));
    image.src = dataUrl;
  });
}

/** 读图片原始像素尺寸 */
export async function readImageSize(dataUrl: string): Promise<ImageSize> {
  const image = await loadImage(dataUrl);
  return { width: image.naturalWidth, height: image.naturalHeight };
}

/**
 * 裁剪并导出 PNG dataUrl。
 * `crop` 省略时取**居中正方形**（短边为边长）；`crop` 为归一化 0~1 坐标。
 */
export async function cropDataUrl(dataUrl: string, crop?: CropRect): Promise<string> {
  const image = await loadImage(dataUrl);
  if (crop) {
    return drawCrop(
      image,
      Math.floor(crop.x * image.width),
      Math.floor(crop.y * image.height),
      Math.ceil(crop.width * image.width),
      Math.ceil(crop.height * image.height),
    );
  }
  const size = Math.min(image.width, image.height);
  const sx = Math.max(0, Math.floor((image.width - size) / 2));
  const sy = Math.max(0, Math.floor((image.height - size) / 2));
  return drawCrop(image, sx, sy, size, size);
}

/** 放大并导出 PNG dataUrl：`high` 逐级 ×2（避免一次性放大的糊），其余单次重采样 */
export async function upscaleDataUrl(dataUrl: string, params: UpscaleParams): Promise<string> {
  const image = await loadImage(dataUrl);
  const { width, height } = resolveUpscaleSize(image.width, image.height, params.targetLongEdge);
  return params.algorithm === "high"
    ? drawStepUpscale(image, width, height)
    : drawResizeDataUrl(image, image.width, image.height, width, height, params.algorithm);
}

function drawCrop(image: HTMLImageElement, sx: number, sy: number, sw: number, sh: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, sw);
  canvas.height = Math.max(1, sh);
  const context = canvas.getContext("2d");
  if (!context) return image.src;
  context.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

function drawStepUpscale(image: HTMLImageElement, width: number, height: number): string {
  let source: CanvasImageSource = image;
  let sourceWidth = image.width;
  let sourceHeight = image.height;
  while (sourceWidth * 2 < width && sourceHeight * 2 < height) {
    const nextWidth = sourceWidth * 2;
    const nextHeight = sourceHeight * 2;
    source = drawResizeCanvas(source, sourceWidth, sourceHeight, nextWidth, nextHeight, "high");
    sourceWidth = nextWidth;
    sourceHeight = nextHeight;
  }
  return drawResizeDataUrl(source, sourceWidth, sourceHeight, width, height, "high");
}

function drawResizeDataUrl(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
  algorithm: UpscaleAlgorithm,
): string {
  return drawResizeCanvas(source, sourceWidth, sourceHeight, width, height, algorithm).toDataURL("image/png");
}

function drawResizeCanvas(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
  algorithm: UpscaleAlgorithm,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return canvas;
  context.imageSmoothingEnabled = algorithm !== "nearest";
  context.imageSmoothingQuality = algorithm === "bilinear" ? "medium" : "high";
  context.drawImage(source, 0, 0, sourceWidth, sourceHeight, 0, 0, width, height);
  return canvas;
}

/**
 * MaskBrushDialog —— 蒙版局部重绘对话框（P1 第 13 项）。
 *
 * 职责：让用户在原图上刷出蒙版 → 导出一张**与原图同尺寸**的 PNG 蒙版（data URL）
 * 交回上层，由上层随「局部重绘」请求一起发给上游。
 *
 * ## 导出约定：`MASK_ALPHA_CONVENTION = "transparent-is-editable"`
 *
 * 与后端 `core/api.py` 的 `generate_image()` docstring 完全一致
 * （OpenAI images/edits 口径）：**透明像素 = 要重绘的区域，不透明像素 = 保持原样**。
 *
 * 所以导出画布是「先铺满不透明白（全图保留）→ 把涂过的笔画抠成透明（这些地方重绘）」。
 * 界面文案「涂出要重绘的区域」与产物语义因此是自洽的：**用户涂到的地方就是会被重绘的地方**。
 * 橡皮擦走反向合成（`source-over`）把透明洞补回白色，等于「这块不重绘了」。
 *
 * ## 三个坐标空间（混了就必错）
 * - **归一化 0..1**（`BrushPoint`）：唯一的状态真相，见 `maskBrush.ts` 的模块注释；
 * - **预览 canvas 像素**：只用于画在屏幕上，尺寸 = 原图按 `PREVIEW_MAX_EDGE` 等比缩小；
 * - **原图像素**：只在 `exportMaskDataUrl` 里出现一次。
 *   预览与导出共用 `brushRadiusPx`，所以「屏幕上看到的粗细」与「导出图里的粗细」同构。
 *
 * ## 几个刻意的取舍
 * - **预览 canvas 用 CSS `opacity` 半透明**：全不透明白会把底图完全盖死，
 *   用户根本看不见自己在遮哪里。导出 canvas 不吃这个 opacity，仍是纯不透明。
 * - **节流靠引用相等**：`appendPoint` 命中节流时返回原数组引用，
 *   这里用 `next === points` 跳过 setState —— pointermove 每秒上百次也不会把 React 拖垮。
 * - **插值补点用 `minGap = 0`**：补点密度已由 `radiusPx / 4` 控制，
 *   再过一遍 `MASK_POINT_MIN_GAP` 会把细笔刷（半径 < 4px）的补点全丢掉，笔迹变虚线。
 * - **`setPointerCapture?.()` 必须带可选链**：jsdom 没有这个 API，裸调会让测试炸。
 * - **`getContext("2d")` 处处判空**：jsdom 恒返回 null，判空才是被测试覆盖的真实路径。
 */

import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import type { ReactElement } from "react";

import { errMessage } from "../format";
import { readImageSize } from "../imageOps";
import type { ImageSize } from "../imageOps";
import {
  MASK_BRUSH_DEFAULT,
  MASK_BRUSH_MAX,
  MASK_BRUSH_MIN,
  appendPoint,
  brushRadiusPx,
  clampBrushSize,
  interpolatePoints,
  isMaskEmpty,
} from "../maskBrush";
import type { BrushMode, BrushPoint, BrushSize, MaskStroke } from "../maskBrush";
import { ModalShell } from "./ModalShell";

/**
 * 蒙版 alpha 约定。改上游 / 改导出语义时先看这个常量，别靠猜。
 *
 * `"transparent-is-editable"` = 透明像素代表「这里要重绘」，不透明像素代表「这里保留」。
 * 导出实现是「全图铺白 + 把涂过的区域抠成透明」，所以**用户涂白的区域在产物里是透明的**，
 * 与后端 `core/api.py` 的 `generate_image()` 口径一致。
 */
export const MASK_ALPHA_CONVENTION = "transparent-is-editable";

export interface MaskBrushDialogProps {
  /** 原图 URL（画布节点上的 /api/image/... 或 data URL） */
  src: string;
  /** 标题里显示的名字 */
  name?: string | undefined;
  onClose: () => void;
  /** 确认：回传与原图同尺寸的蒙版 PNG data URL；调用方负责拼进局部重绘请求 */
  onConfirm: (maskDataUrl: string) => void | Promise<void>;
}

/** 导出蒙版的填充色：不透明白 = 已涂区域 */
const MASK_FILL = "rgba(255, 255, 255, 1)";

/** 预览 canvas 的 CSS 不透明度（导出不受影响） */
const PREVIEW_OPACITY = 0.72;

/**
 * 预览 canvas 背板的最长边。
 * 几何全部归一化，预览分辨率与导出分辨率无关；4K 图按原尺寸重绘每帧都要几十毫秒，
 * 压到 1280 足够看清笔迹，也省下几十 MB 的 canvas 内存。
 */
const PREVIEW_MAX_EDGE = 1280;

/** 视口高度（与 `<img>` 的 max-h 保持一致：img 是决定 canvas 尺寸的那一层，两处必须同值） */
const VIEWPORT_HEIGHT = "min(56vh, 520px)";

/** 拖拽中的一笔（`pointerId` 用来忽略多指 / 鼠标离开后的杂散事件） */
interface DraftStroke {
  pointerId: number;
  mode: BrushMode;
  size: number;
  points: BrushPoint[];
}

/** 把值夹进 [0, 1]；NaN 按下限处理 */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * 在任意 2D 上下文里画一笔的圆点序列。
 * 预览与导出共用：同一套归一化几何、同一个半径换算，视觉与产物不会走样。
 *
 * `holeMode` 决定这一笔在合成时是「涂白」还是「抠洞」：
 * - 预览（`holeMode = false`）：涂白 = 屏幕上的半透明白色蒙层，擦除 = 挖掉蒙层露出底图；
 * - 导出（`holeMode = true`）：画布已铺满不透明白，涂白 = 抠成透明（这里要重绘），
 *   擦除 = 把透明洞填回白色（这里不重绘）。
 *
 * 两种模式下合成方式正好相反，所以用同一个布尔量而不是各写一份循环 ——
 * 半径换算、点序、`save/restore` 纪律必须完全一致，否则预览与产物会走样。
 */
function drawStrokeCircles(
  context: CanvasRenderingContext2D,
  stroke: MaskStroke,
  image: BrushSize,
  holeMode = false,
): void {
  const radius = brushRadiusPx(stroke.size, image);
  if (!(radius > 0)) return;
  const paint = stroke.mode === "paint";
  context.save();
  context.globalCompositeOperation = paint === holeMode ? "destination-out" : "source-over";
  context.fillStyle = MASK_FILL;
  for (const point of stroke.points) {
    context.beginPath();
    context.arc(point.x * image.width, point.y * image.height, radius, 0, Math.PI * 2);
    context.fill();
  }
  context.restore();
}

/**
 * 生成蒙版 data URL：**与原图同尺寸**，全图不透明，涂过的区域透明。
 *
 * 取不到 2D 上下文时抛错（而不是返回空串）：空蒙版发给上游等于「整图重绘」，
 * 又慢又花钱，宁可让用户看到明确的失败提示。
 */
function exportMaskDataUrl(strokes: readonly MaskStroke[], image: ImageSize): string {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.width));
  canvas.height = Math.max(1, Math.round(image.height));
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("当前环境不支持 canvas 2D，无法生成蒙版");
  }
  // 起点是「全图保留」：铺满不透明白，再把用户涂过的地方抠成透明。
  // 反过来（透明起手 + 涂白）会得到「涂过 = 保留」，与后端约定正好相反，
  // 结果是用户圈哪块、上游就偏偏不重绘哪块。
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.save();
  context.globalCompositeOperation = "source-over";
  context.fillStyle = MASK_FILL;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.restore();
  for (const stroke of strokes) {
    if (stroke.points.length === 0) continue;
    drawStrokeCircles(context, stroke, canvas, true);
  }
  return canvas.toDataURL("image/png");
}

export function MaskBrushDialog(props: MaskBrushDialogProps): ReactElement {
  const { src, name, onClose, onConfirm } = props;

  const [imageSize, setImageSize] = useState<ImageSize | null>(null);
  const [strokes, setStrokes] = useState<MaskStroke[]>([]);
  const [draft, setDraft] = useState<MaskStroke | null>(null);
  const [mode, setMode] = useState<BrushMode>("paint");
  const [size, setSize] = useState(MASK_BRUSH_DEFAULT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const draftRef = useRef<DraftStroke | null>(null);
  /** 组件是否仍挂载：关窗后迟到的导出结果不该再回调 onConfirm */
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // 读原图尺寸：笔刷半径、导出尺寸、预览背板全靠它
  useEffect(() => {
    let cancelled = false;
    setImageSize(null);
    readImageSize(src).then(
      (loaded) => {
        if (!cancelled) setImageSize(loaded);
      },
      (reason: unknown) => {
        if (!cancelled) setError(`读取图片尺寸失败：${errMessage(reason)}`);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [src]);

  // 换图：笔画与草稿都清掉（上一张的蒙版绝不能带到新图上）
  useEffect(() => {
    setStrokes([]);
    setDraft(null);
    draftRef.current = null;
    setError(null);
    setBusy(false);
  }, [src]);

  /** 预览 canvas 的背板尺寸（保持原图宽高比，长边不超过 PREVIEW_MAX_EDGE） */
  const previewSize = useMemo<BrushSize>(() => {
    if (!imageSize) return { width: 1, height: 1 };
    const longEdge = Math.max(imageSize.width, imageSize.height);
    const scale = longEdge > PREVIEW_MAX_EDGE ? PREVIEW_MAX_EDGE / longEdge : 1;
    return {
      width: Math.max(1, Math.round(imageSize.width * scale)),
      height: Math.max(1, Math.round(imageSize.height * scale)),
    };
  }, [imageSize]);

  // 预览重绘：笔画 / 草稿 / 尺寸任一变化就整体重画。
  // 归一化几何 + 预览像素尺寸 ⇒ 每帧重画也不会错位，不需要增量补画那套复杂度。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext?.("2d") ?? null;
    // jsdom / 极端浏览器：没有 2D 上下文就静默降级，涂画与导出仍然照常走状态层
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (!imageSize) return;
    for (const stroke of strokes) {
      drawStrokeCircles(context, stroke, previewSize);
    }
    if (draft) {
      drawStrokeCircles(context, draft, previewSize);
    }
  }, [strokes, draft, imageSize, previewSize]);

  /** 指针位置 → 归一化坐标；取不到布局（jsdom 全 0）时返回 null，直接丢弃这一帧 */
  const pointFromEvent = (event: PointerEvent<HTMLCanvasElement>): BrushPoint | null => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return null;
    return {
      x: clamp01((event.clientX - rect.left) / rect.width),
      y: clamp01((event.clientY - rect.top) / rect.height),
    };
  };

  const handlePointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (busy || !imageSize) return;
    const point = pointFromEvent(event);
    if (!point) return;
    event.preventDefault();
    // 可选链是硬要求：jsdom 没有指针捕获 API，裸调会让整条测试链炸掉
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const started: DraftStroke = {
      pointerId: event.pointerId,
      mode,
      size,
      points: [point],
    };
    draftRef.current = started;
    setDraft({ mode: started.mode, size: started.size, points: started.points });
  };

  const handlePointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const current = draftRef.current;
    if (!current || event.pointerId !== current.pointerId || !imageSize) return;
    const point = pointFromEvent(event);
    if (!point) return;
    event.preventDefault();
    const last = current.points[current.points.length - 1];
    if (!last) return;

    // 快速拖动时两个 pointermove 之间可能隔很远，先按 radiusPx / 4 补点，
    // 否则笔迹会画成一串断续的圆点。
    const radius = brushRadiusPx(current.size, imageSize);
    let next = current.points;
    for (const bridge of interpolatePoints(last, point, radius, imageSize)) {
      // minGap 传 0：补点密度已经由插值步长控制，再过一遍节流会把细笔刷的补点全丢掉
      next = appendPoint(next, bridge, 0);
    }
    next = appendPoint(next, point);
    // 节流命中时 appendPoint 返回原引用 ⇒ 这一帧没有任何新点，跳过 setState
    if (next === current.points) return;
    current.points = next;
    setDraft({ mode: current.mode, size: current.size, points: next });
  };

  const finishStroke = (event: PointerEvent<HTMLCanvasElement>) => {
    const current = draftRef.current;
    if (!current || event.pointerId !== current.pointerId) return;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
    draftRef.current = null;
    setDraft(null);
    const points = current.points;
    if (points.length === 0) return;
    const committed: MaskStroke = { mode: current.mode, size: current.size, points };
    setStrokes((existing) => [...existing, committed]);
  };

  const clearAll = () => {
    if (busy) return;
    setStrokes([]);
    setDraft(null);
    draftRef.current = null;
    setError(null);
  };

  const handleConfirm = async () => {
    if (busy || !imageSize || isMaskEmpty(strokes)) return;
    setBusy(true);
    setError(null);
    try {
      const maskDataUrl = exportMaskDataUrl(strokes, imageSize);
      if (!aliveRef.current) return;
      await onConfirm(maskDataUrl);
      if (!aliveRef.current) return;
      onClose();
    } catch (reason) {
      if (aliveRef.current) setError(`蒙版生成失败：${errMessage(reason)}`);
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  };

  const empty = isMaskEmpty(strokes);
  const sizePercent = Math.round(size * 100);

  return (
    <ModalShell
      title={`蒙版局部重绘${name ? ` · ${name}` : ""}`}
      onClose={onClose}
      testId="mask-brush-dialog"
      className="!w-[min(920px,94vw)]"
    >
      <header className="modal-header">
        <h3 className="modal-title">蒙版局部重绘{name ? ` · ${name}` : ""}</h3>
        <p className="modal-subtitle">用画笔涂出要重绘的区域，橡皮擦可修正；导出的蒙版与原图同尺寸。</p>
      </header>

      <div className="mb-3 flex flex-wrap items-center gap-1.5" role="group" aria-label="蒙版工具">
        <button
          type="button"
          aria-pressed={mode === "paint"}
          className={`chip chip--sm ${mode === "paint" ? "chip--brand" : "chip--quiet"}`}
          onClick={() => setMode("paint")}
        >
          画笔
        </button>
        <button
          type="button"
          aria-pressed={mode === "erase"}
          className={`chip chip--sm ${mode === "erase" ? "chip--brand" : "chip--quiet"}`}
          onClick={() => setMode("erase")}
        >
          橡皮擦
        </button>

        <span className="ml-2 text-[11px] text-neutral-400">画笔大小</span>
        <input
          type="range"
          data-testid="mask-brush-size"
          aria-label="画笔大小"
          min={MASK_BRUSH_MIN * 100}
          max={MASK_BRUSH_MAX * 100}
          step={1}
          value={sizePercent}
          onChange={(event) => setSize(clampBrushSize(Number(event.target.value) / 100))}
          className="range-field w-32"
        />
        <span className="text-[11px] tabular-nums text-neutral-400">{sizePercent}%</span>

        <button
          type="button"
          data-testid="mask-clear"
          className="chip chip--sm chip--quiet ml-auto"
          disabled={busy || strokes.length === 0}
          onClick={clearAll}
        >
          清除
        </button>
      </div>

      <div
        className="relative flex items-center justify-center overflow-hidden rounded-xl border border-neutral-200/80 surface-inset"
        style={{ height: VIEWPORT_HEIGHT }}
      >
        {/* 这一层是 canvas 的定位基准：它的大小由 <img> 决定，所以 canvas 恰好盖住图片本身，
            而不是盖住可能带黑边的整个视口盒 —— 归一化坐标才不会因为 letterbox 而错位 */}
        <div className="relative min-w-0">
          <img
            src={src}
            alt=""
            draggable={false}
            className="block select-none"
            style={{ maxHeight: VIEWPORT_HEIGHT, maxWidth: "100%" }}
          />
          <canvas
            ref={canvasRef}
            data-testid="mask-canvas"
            width={previewSize.width}
            height={previewSize.height}
            className="absolute inset-0 h-full w-full touch-none cursor-crosshair"
            style={{ opacity: PREVIEW_OPACITY }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={finishStroke}
            onPointerCancel={finishStroke}
          />
        </div>
      </div>

      {error ? (
        <p role="alert" className="mt-2 text-xs text-red-600">
          {error}
        </p>
      ) : null}

      <footer className="modal-footer">
        {empty ? (
          <span
            className="mr-auto self-center text-[11px] text-neutral-400"
            data-testid="mask-empty-hint"
          >
            先在图上涂出要重绘的区域
          </span>
        ) : (
          <span className="mr-auto self-center text-[11px] tabular-nums text-neutral-400">
            已涂 {strokes.length} 笔 · 原图 {imageSize ? `${imageSize.width} × ${imageSize.height}` : "读取中…"}
          </span>
        )}
        <button type="button" className="btn-ghost btn-sm" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          data-testid="mask-confirm"
          className="btn-primary btn-sm"
          disabled={busy || !imageSize || empty}
          onClick={() => {
            void handleConfirm();
          }}
        >
          {busy ? "处理中…" : "确认重绘"}
        </button>
      </footer>
    </ModalShell>
  );
}

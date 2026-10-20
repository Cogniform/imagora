import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";

import {
  centeredSquareCrop,
  cropDataUrl,
  fitCropToRatio,
  gcdRatio,
  moveCrop,
  readImageSize,
  resizeCrop,
  type CropHandle,
  type CropRect,
  type ImageSize,
} from "../imageOps";
import { useImageEditorViewport } from "../useImageEditorViewport";
import { ModalShell } from "./ModalShell";

/**
 * 裁剪对话框：图片按视口适配显示，上面叠一个可拖可缩的裁剪框。
 *
 * 分工（三个坐标空间，混了就必错）：
 * - `src` / 原图像素：`cropDataUrl` 落盘时用，`ImageSize` 就是它；
 * - `CropRect`：归一化 0~1（相对原图宽高），**唯一的状态真相**，跨缩放不丢精度；
 * - stage 像素：裁剪框画在 stage 层上，`left/top/width/height` 由 `crop` 乘 stage 尺寸得来。
 *   指针位移也先除以 stage 宽高归一化，再交给 `moveCrop` / `resizeCrop`——
 *   直接在 stage 像素上算，用户放大到 4 倍拖一下就会位移过头。
 *
 * 比例锁定：`aspectRatio` 是**像素**比例（1:1 / 16:9），`CropRect` 是归一化坐标，
 * 换算由 `resizeCrop` / `fitCropToRatio` 内部完成（`ratio * image.height / image.width`）。
 * 本组件只负责把 imageSize 换成 stage 盒传进去，不做第二套比例数学。
 *
 * 交互收口：拖框内平移、拖八个手柄改尺寸、比例按钮切预设、确认走 canvas 导出。
 * Esc / 焦点陷阱 / 遮罩点击全由 ModalShell 管，这里**不重复监听 keydown**。
 */

export interface ImageCropDialogProps {
  src: string;
  name?: string | undefined;
  onClose: () => void;
  onConfirm: (dataUrl: string) => void | Promise<void>;
}

/** 比例预设：null = 自由（不锁比例） */
interface RatioPreset {
  label: string;
  value: number | null;
}

const RATIO_PRESETS: readonly RatioPreset[] = [
  { label: "自由", value: null },
  { label: "1:1", value: 1 },
  { label: "4:3", value: 4 / 3 },
  { label: "3:4", value: 3 / 4 },
  { label: "16:9", value: 16 / 9 },
  { label: "9:16", value: 9 / 16 },
];

/** 手柄相对裁剪框的位置（百分比，落在四角 / 四边中点；-50% 让方块以该点为心） */
const HANDLE_POSITION: Record<CropHandle, { left: string; top: string }> = {
  nw: { left: "0%", top: "0%" },
  n: { left: "50%", top: "0%" },
  ne: { left: "100%", top: "0%" },
  e: { left: "100%", top: "50%" },
  se: { left: "100%", top: "100%" },
  s: { left: "50%", top: "100%" },
  sw: { left: "0%", top: "100%" },
  w: { left: "0%", top: "50%" },
};

const HANDLES: readonly CropHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** 每个手柄的光标（对角线用 nwse / nesw 两个方向标） */
const HANDLE_CURSOR: Record<CropHandle, string> = {
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
};

/** 遮罩底色：只用既有 scrim token，不写死颜色（surfaceAudit 会红） */
const SCRIM_COLOR = "var(--scrim-bg)";

/** 拖拽中的指针状态：起点坐标 + 起始裁剪框（每次 move 都从起点重算，不累积浮点误差） */
interface DragState {
  pointerId: number;
  kind: "move" | "resize";
  handle: CropHandle | null;
  startX: number;
  startY: number;
  origin: CropRect;
}

export function ImageCropDialog({ src, name, onClose, onConfirm }: ImageCropDialogProps) {
  const [imageSize, setImageSize] = useState<ImageSize | null>(null);
  const [crop, setCrop] = useState<CropRect>(centeredSquareCrop);
  const [aspectRatio, setAspectRatio] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dragRef = useRef<DragState | null>(null);

  const viewport = useImageEditorViewport(imageSize, true);
  const stageRef = viewport.stageRef;

  // 读原图尺寸：裁剪框的比例换算依赖它，没尺寸时先不画框（否则比例会按 0 算）
  useEffect(() => {
    let cancelled = false;
    setImageSize(null);
    readImageSize(src).then(
      (size) => {
        if (!cancelled) setImageSize(size);
      },
      () => {
        if (!cancelled) setError("图片尺寸读取失败，请关闭后重试");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [src]);

  // 换图：裁剪框与比例都回到初始（上一张的选择不该带到新图上）
  useEffect(() => {
    setCrop(centeredSquareCrop());
    setAspectRatio(null);
    setError(null);
    setBusy(false);
  }, [src]);

  /** stage 当前像素尺寸（Handle 的归一化换算基准）；stage 未布局时给 1 兜底避免除零 */
  const readStageSize = useCallback((): ImageSize => {
    const stage = stageRef.current;
    if (!stage) return { width: 1, height: 1 };
    return { width: Math.max(1, stage.clientWidth), height: Math.max(1, stage.clientHeight) };
  }, [stageRef]);

  const startMove = (event: PointerEvent<HTMLDivElement>) => {
    if (busy) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      kind: "move",
      handle: null,
      startX: event.clientX,
      startY: event.clientY,
      origin: crop,
    };
  };

  const startResize = (event: PointerEvent<HTMLDivElement>, handle: CropHandle) => {
    if (busy) return;
    // 手柄在裁剪框里、裁剪框在 stage 里，不截停的话会同时触发「拖框内平移」
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      kind: "resize",
      handle,
      startX: event.clientX,
      startY: event.clientY,
      origin: crop,
    };
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const box = readStageSize();
    const dx = (event.clientX - drag.startX) / box.width;
    const dy = (event.clientY - drag.startY) / box.height;
    if (drag.kind === "move") {
      setCrop(moveCrop(drag.origin, dx, dy));
      return;
    }
    const handle = drag.handle;
    if (!handle) return;
    setCrop(resizeCrop(drag.origin, dx, dy, handle, aspectRatio, box));
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
    dragRef.current = null;
  };

  /** 切比例：锁定后立刻把当前框收成该比例（保持中心），否则按钮选了却看不出变化 */
  const chooseRatio = (ratio: number | null) => {
    setAspectRatio(ratio);
    if (ratio === null || !imageSize) return;
    setCrop((current) => fitCropToRatio(current, ratio, imageSize));
  };

  const confirm = async () => {
    if (busy || !imageSize) return;
    setBusy(true);
    setError(null);
    try {
      const dataUrl = await cropDataUrl(src, crop);
      await onConfirm(dataUrl);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error && reason.message ? `裁剪失败：${reason.message}` : "裁剪失败，请重试");
      setBusy(false);
    }
  };

  const stageSize = readStageSize();
  const boxStyle: CSSProperties = {
    left: `${crop.x * 100}%`,
    top: `${crop.y * 100}%`,
    width: `${crop.width * 100}%`,
    height: `${crop.height * 100}%`,
    boxShadow: `0 0 0 9999px ${SCRIM_COLOR}`,
    border: "1px solid color-mix(in srgb, var(--color-brand) 56%, transparent)",
    cursor: busy ? "default" : "grab",
    touchAction: "none",
  };
  const sizeLabel = `${Math.round(crop.width * (imageSize?.width ?? stageSize.width))} × ${Math.round(
    crop.height * (imageSize?.height ?? stageSize.height),
  )}`;

  return (
    <ModalShell
      title={`裁剪图片${name ? ` · ${name}` : ""}`}
      onClose={onClose}
      testId="image-crop-dialog"
      className="!w-[min(920px,94vw)]"
    >
      <header className="modal-header">
        <h3 className="modal-title">裁剪图片</h3>
        <p className="modal-subtitle">
          {name ? `${name} · ` : ""}
          拖框内平移，拖手柄改尺寸；滚轮缩放、空格 + 拖拽平移视图。
        </p>
      </header>

      <div className="mb-3 flex flex-wrap items-center gap-1.5" role="group" aria-label="裁剪比例">
        {RATIO_PRESETS.map((preset) => {
          const active = preset.value === aspectRatio;
          return (
            <button
              key={preset.label}
              type="button"
              aria-pressed={active}
              onClick={() => chooseRatio(preset.value)}
              className={`chip chip--sm ${active ? "chip--brand" : "chip--quiet"}`}
            >
              {preset.label}
            </button>
          );
        })}
        <span className="ml-auto text-[11px] tabular-nums text-neutral-400" data-testid="crop-size">
          {sizeLabel}px
        </span>
      </div>

      <div
        ref={viewport.viewportRef}
        className={`relative h-[min(56vh,520px)] touch-none rounded-xl border border-neutral-200/80 surface-inset ${viewport.scrollClassName}`}
        {...viewport.panHandlers}
      >
        <div className="relative" style={viewport.contentStyle}>
          <div ref={viewport.stageRef} className="absolute" style={viewport.stageStyle}>
            <img src={src} alt="" style={viewport.mediaStyle} draggable={false} className="select-none" />
            {imageSize ? (
              <div
                data-testid="crop-box"
                className="absolute select-none"
                style={boxStyle}
                onPointerDown={startMove}
                onPointerMove={handlePointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              >
                {/* 三分线：只做视觉参考，不吃指针事件 */}
                <div className="pointer-events-none absolute inset-0" aria-hidden="true">
                  {[1, 2].map((index) => (
                    <span
                      key={`v${index}`}
                      className="absolute top-0 h-full w-px"
                      style={{ left: `${(index * 100) / 3}%`, background: `${SCRIM_COLOR}` }}
                    />
                  ))}
                  {[1, 2].map((index) => (
                    <span
                      key={`h${index}`}
                      className="absolute left-0 w-full"
                      style={{ top: `${(index * 100) / 3}%`, height: 1, background: `${SCRIM_COLOR}` }}
                    />
                  ))}
                </div>
                {HANDLES.map((handle) => {
                  const position = HANDLE_POSITION[handle];
                  return (
                    <div
                      key={handle}
                      data-handle={handle}
                      aria-hidden="true"
                      className="absolute rounded-sm border border-white"
                      style={{
                        left: position.left,
                        top: position.top,
                        width: 10,
                        height: 10,
                        marginLeft: -5,
                        marginTop: -5,
                        background: "var(--color-brand)",
                        cursor: HANDLE_CURSOR[handle],
                        touchAction: "none",
                      }}
                      onPointerDown={(event) => startResize(event, handle)}
                      onPointerMove={handlePointerMove}
                      onPointerUp={endDrag}
                      onPointerCancel={endDrag}
                    />
                  );
                })}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {error ? (
        <p role="alert" className="mt-2 text-xs text-red-600">
          {error}
        </p>
      ) : null}

      <div className="modal-footer">
        <span className="mr-auto self-center text-[11px] text-neutral-400">
          {imageSize
            ? `原图 ${imageSize.width} × ${imageSize.height} · 输出比例 ${gcdRatio(crop.width, crop.height)}`
            : "正在读取图片…"}
        </span>
        <button type="button" className="btn-ghost btn-sm" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="btn-primary btn-sm"
          disabled={busy || !imageSize}
          onClick={() => {
            void confirm();
          }}
        >
          {busy ? "处理中…" : "确认裁剪"}
        </button>
      </div>
    </ModalShell>
  );
}

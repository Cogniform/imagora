/**
 * ImageUpscaleDialog —— 图片放大对话框（P1-D）。
 *
 * 职责：选目标长边（快捷按钮 / 手填，范围 64 – MAX_UPSCALE_LONG_EDGE）+
 * 选重采样算法 → 实时显示「原图 → 目标尺寸」换算 → 调 imageOps.upscaleDataUrl
 * 产出放大后的 dataUrl 交回上层（onConfirm），由上层决定落库 / 回填画布。
 *
 * 几个刻意的设计：
 * - 目标长边在原图尺寸读到之前就先给 2048 兜底值，读到后再按
 *   `min(4096, max(1024, 原长边 × 2))` 覆盖（仅当用户没动过输入框）。
 *   读尺寸要走一次 Image 解码，是异步的；确认按钮不该干等它 ——
 *   真正放大时 upscaleDataUrl 自己会再加载一次原图，尺寸晚到不阻塞主流程。
 * - 目标小于原图只提示、不禁用确认：用户可能就是想要一张缩小的底图，
 *   硬拦会把合理操作逼到没有出口。
 * - Esc / 遮罩点击 / 焦点圈 / Tab 循环全由 ModalShell 统一管，这里不重复监听 keydown。
 * - 处理期间用户仍可取消（Esc / 取消 / 点遮罩）：卸载后用 aliveRef 拦住
 *   「迟到的结果」，避免窗都关了 onConfirm 还被调一次。
 */
import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";

import { errMessage } from "../format";
import {
  clamp,
  gcdRatio,
  MAX_UPSCALE_LONG_EDGE,
  readImageSize,
  resolveUpscaleSize,
  upscaleDataUrl,
} from "../imageOps";
import type { ImageSize, UpscaleAlgorithm } from "../imageOps";
import { Field } from "./Field";
import { ModalShell } from "./ModalShell";
import { Select } from "./Select";

export interface ImageUpscaleDialogProps {
  src: string;
  name?: string | undefined;
  onClose: () => void;
  onConfirm: (dataUrl: string) => void | Promise<void>;
}

const PRESET_LONG_EDGES = [1024, 2048, 3072, MAX_UPSCALE_LONG_EDGE] as const;

/** 原图尺寸未知时的目标长边兜底值（读到尺寸后按公式覆盖） */
const FALLBACK_TARGET = 2048;

/** 手填下限：再小没有放大意义 */
const MIN_TARGET = 64;

const ALGORITHM_OPTIONS: { value: UpscaleAlgorithm; label: string }[] = [
  { value: "high", label: "高质量（逐级放大）" },
  { value: "bilinear", label: "双线性（平滑）" },
  { value: "nearest", label: "最近邻（像素风）" },
];

const ALGORITHM_HINTS: Record<UpscaleAlgorithm, string> = {
  nearest: "逐像素复制，结果锐利但可能有锯齿，适合像素画",
  bilinear: "双线性插值，一次重采样到位，边缘平滑",
  high: "逐级 ×2 放大再收敛到目标尺寸，细节保留最好",
};

export function ImageUpscaleDialog(props: ImageUpscaleDialogProps): ReactElement {
  const { src, name, onClose, onConfirm } = props;

  const [size, setSize] = useState<ImageSize | null>(null);
  const [sizeError, setSizeError] = useState<string | null>(null);
  const [target, setTarget] = useState(String(FALLBACK_TARGET));
  const [algorithm, setAlgorithm] = useState<UpscaleAlgorithm>("high");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 用户是否主动改过目标长边：读到原图尺寸后只覆盖「没动过」的默认值 */
  const touchedRef = useRef(false);
  /** 组件是否仍挂载：取消 / Esc 关窗后，迟到的放大结果不该再回调 onConfirm */
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void readImageSize(src)
      .then((loaded) => {
        if (cancelled) return;
        setSize(loaded);
        setSizeError(null);
        // 默认值 = min(上限, max(1024, 原长边 × 2))：小图直接翻倍，大图顶到上限
        if (!touchedRef.current) {
          const longEdge = Math.max(loaded.width, loaded.height);
          setTarget(String(Math.min(MAX_UPSCALE_LONG_EDGE, Math.max(1024, longEdge * 2))));
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setSizeError(errMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [src]);

  const parsedTarget = Number.parseInt(target, 10);
  const targetValid = !Number.isNaN(parsedTarget);
  const nextSize =
    size !== null && targetValid ? resolveUpscaleSize(size.width, size.height, parsedTarget) : null;
  const originalLongEdge = size !== null ? Math.max(size.width, size.height) : null;
  const belowOriginal = originalLongEdge !== null && targetValid && parsedTarget < originalLongEdge;

  const setTargetLongEdge = (raw: string) => {
    touchedRef.current = true;
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed)) {
      // 清空输入框是打字过程的中间态，放行空值（确认按钮此时禁用）
      setTarget("");
      return;
    }
    setTarget(String(clamp(parsed, MIN_TARGET, MAX_UPSCALE_LONG_EDGE)));
  };

  const handleConfirm = async () => {
    if (busy || !targetValid) return;
    setBusy(true);
    setError(null);
    try {
      const dataUrl = await upscaleDataUrl(src, { targetLongEdge: parsedTarget, algorithm });
      if (!aliveRef.current) return;
      await onConfirm(dataUrl);
      if (!aliveRef.current) return;
      onClose();
    } catch (err) {
      if (aliveRef.current) setError(errMessage(err));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  };

  const conversionText =
    size !== null && nextSize !== null && originalLongEdge !== null
      ? `原 ${size.width}×${size.height} → ${nextSize.width}×${nextSize.height}（${(
          Math.max(nextSize.width, nextSize.height) / originalLongEdge
        ).toFixed(1)}×）· 显示比例 ${gcdRatio(nextSize.width, nextSize.height)}`
      : "正在读取原图尺寸…";

  return (
    <ModalShell
      title={`放大图片${name ? ` · ${name}` : ""}`}
      onClose={onClose}
      testId="image-upscale-dialog"
      className="!w-[min(560px,94vw)]"
    >
      <header className="modal-header">
        <h3 className="modal-title">放大图片{name ? ` · ${name}` : ""}</h3>
        <p className="modal-subtitle">按目标长边等比放大，输出 PNG。</p>
      </header>

      <div className="modal-body flex flex-col gap-4">
        <div className="flex justify-center">
          <img alt="原图预览" className="max-h-[240px] max-w-full rounded-lg" src={src} />
        </div>

        {sizeError !== null && (
          <p role="alert" className="text-xs text-red-600">
            读取原图尺寸失败：{sizeError}
          </p>
        )}

        <Field
          id="iu-target"
          label="目标长边"
          hint={
            belowOriginal
              ? "目标小于原图，建议至少设为原图长边"
              : `范围 ${MIN_TARGET} – ${MAX_UPSCALE_LONG_EDGE}，可点快捷按钮或手动输入`
          }
        >
          <div className="flex flex-wrap items-center gap-2">
            {PRESET_LONG_EDGES.map((preset) => (
              <button
                key={preset}
                type="button"
                aria-pressed={target === String(preset)}
                className={target === String(preset) ? "btn-primary btn-xs" : "btn-ghost btn-xs"}
                onClick={() => setTargetLongEdge(String(preset))}
              >
                {preset}
              </button>
            ))}
            <input
              id="iu-target"
              type="number"
              min={MIN_TARGET}
              max={MAX_UPSCALE_LONG_EDGE}
              step={1}
              className="field-control w-28 text-sm"
              value={target}
              onChange={(event) => setTargetLongEdge(event.target.value)}
            />
          </div>
        </Field>

        <Field id="iu-algorithm" label="放大算法" hint={ALGORITHM_HINTS[algorithm]}>
          <Select
            id="iu-algorithm"
            options={ALGORITHM_OPTIONS}
            value={algorithm}
            onChange={(value) => setAlgorithm(value as UpscaleAlgorithm)}
          />
        </Field>

        <p className="text-caption">{conversionText}</p>

        {error !== null && (
          <div role="status" className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}
      </div>

      <footer className="modal-footer">
        <button type="button" className="btn-ghost btn-sm" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="btn-primary btn-sm"
          data-testid="image-upscale-confirm"
          disabled={busy || !targetValid}
          onClick={() => void handleConfirm()}
        >
          {busy ? "处理中…" : "确认放大"}
        </button>
      </footer>
    </ModalShell>
  );
}

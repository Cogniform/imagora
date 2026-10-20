/**
 * ImageSplitDialog —— 网格切分对话框（P2-B）。
 *
 * 职责：选行列网格（五个快捷预设 / 手填 1 – 8）→ 实时画出切分预览与格子数 →
 * 列出前几个输出文件名 → 调 imageSplit.splitDataUrl 一次性切出全部格子，
 * 把 dataUrl 数组交回上层（onConfirm），由上层决定落库 / 回填画布。
 *
 * 几个刻意的设计：
 * - 预览只用绝对定位的 DOM 网格叠在 `<img>` 上，**不真画 canvas**：切分本身是纯几何
 *   （splitCells 算归一化矩形），预览只需要"线画在哪"；真起一张 canvas 既费内存，
 *   又会和真实切分结果对不齐（预览显示尺寸 ≠ 原图尺寸）。
 * - 行 / 列输入框存的是**字符串**而不是数字：清空输入框是打字过程的中间态，
 *   存数字会被迫立刻回填一个 1，用户没法把 "12" 改成 "3"。网格由
 *   `clampGrid(parseInt(行), parseInt(列))` 派生，非数字自动回落 1（clampGrid 自己兜）。
 * - 手填即时夹紧（99 → 8）：夹紧结果写回输入框，用户立刻看到合法值，不留"填了但没生效"。
 * - 1×1 不禁用输入、只禁用确认并给出提示 —— 1×1 是合法的"不切"输入，
 *   静默把它抬到 2×2 会让用户以为自己填错了。
 * - 确认按钮**不**因"原图尺寸还没读到"而禁用：splitDataUrl 自己会再加载一次原图，
 *   尺寸只用于显示，晚到不该阻塞主流程。
 * - Esc / 遮罩点击 / 焦点圈 / Tab 循环全由 ModalShell 统一管，这里不重复监听 keydown。
 * - 处理期间用户仍可取消（Esc / 取消 / 点遮罩）：卸载后用 aliveRef 拦住"迟到的切分结果"，
 *   避免窗都关了 onConfirm 还被调一次。
 */
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactElement } from "react";

import { errMessage } from "../format";
import { readImageSize } from "../imageOps";
import type { ImageSize } from "../imageOps";
import {
  clampGrid,
  splitCellCount,
  splitDataUrl,
  splitOutputName,
  SPLIT_MAX_COLS,
  SPLIT_MAX_ROWS,
  SPLIT_MIN_CELLS,
  SPLIT_PRESETS,
} from "../imageSplit";
import type { SplitGrid } from "../imageSplit";
import { Field } from "./Field";
import { ModalShell } from "./ModalShell";

export interface ImageSplitDialogProps {
  src: string;
  name?: string | undefined;
  onClose: () => void;
  onConfirm: (dataUrls: string[]) => void | Promise<void>;
}

/** 默认网格：最常用的 2 × 2 */
const DEFAULT_GRID: SplitGrid = { rows: 2, cols: 2 };

/** 文件名预览最多列几个（再多就只给总数，避免弹窗被撑长） */
const NAME_PREVIEW_LIMIT = 3;

/** 原名为空时的兜底名（splitOutputName 会再去掉扩展名） */
const FALLBACK_NAME = "image.png";

/** 网格线颜色：从品牌色掺出来，深浅底图上都看得见，又不至于喧宾夺主 */
const CELL_LINE_COLOR = "color-mix(in srgb, var(--color-brand) 48%, transparent)";

/** 每格只画右 / 下两条线，相邻两格共用一条，不会出现 2px 双线 */
const CELL_LINE_STYLE: CSSProperties = {
  borderRightWidth: 1,
  borderRightStyle: "solid",
  borderRightColor: CELL_LINE_COLOR,
  borderBottomWidth: 1,
  borderBottomStyle: "solid",
  borderBottomColor: CELL_LINE_COLOR,
};

/** 整块网格补上左 / 上两条线，凑成完整外框（否则最左列 / 最上行没有边） */
const GRID_FRAME_STYLE: CSSProperties = {
  borderLeftWidth: 1,
  borderLeftStyle: "solid",
  borderLeftColor: CELL_LINE_COLOR,
  borderTopWidth: 1,
  borderTopStyle: "solid",
  borderTopColor: CELL_LINE_COLOR,
};

export function ImageSplitDialog(props: ImageSplitDialogProps): ReactElement {
  const { src, name, onClose, onConfirm } = props;

  const [imageSize, setImageSize] = useState<ImageSize | null>(null);
  const [sizeError, setSizeError] = useState<string | null>(null);
  /** 行 / 列输入框的原始文本（允许空串这个打字中间态） */
  const [rowsText, setRowsText] = useState(String(DEFAULT_GRID.rows));
  const [colsText, setColsText] = useState(String(DEFAULT_GRID.cols));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 组件是否仍挂载：取消 / Esc 关窗后，迟到的切分结果不该再回调 onConfirm */
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // 读原图尺寸：只用于显示"原图 W × H"，读不到也不拦切分（splitDataUrl 会自己再加载）
  useEffect(() => {
    let cancelled = false;
    setImageSize(null);
    setSizeError(null);
    void readImageSize(src)
      .then((loaded) => {
        if (cancelled) return;
        setImageSize(loaded);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setSizeError(errMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [src]);

  // 网格从文本派生：parseInt 拿到 NaN 时 clampGrid 会回落 1，空输入框因此是安全的
  const grid = clampGrid(Number.parseInt(rowsText, 10), Number.parseInt(colsText, 10));
  const total = splitCellCount(grid);
  const canSplit = total >= SPLIT_MIN_CELLS;

  const setAxis = (axis: "rows" | "cols", raw: string) => {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed)) {
      // 清空输入框是打字过程的中间态，放行空值（网格回落 1×N，确认会被禁用）
      if (axis === "rows") setRowsText("");
      else setColsText("");
      return;
    }
    const next = axis === "rows" ? clampGrid(parsed, grid.cols) : clampGrid(grid.rows, parsed);
    if (axis === "rows") setRowsText(String(next.rows));
    else setColsText(String(next.cols));
  };

  const applyPreset = (preset: SplitGrid) => {
    setRowsText(String(preset.rows));
    setColsText(String(preset.cols));
  };

  const baseName = name ?? FALLBACK_NAME;
  const previewNames: string[] = [];
  for (let index = 1; index <= Math.min(NAME_PREVIEW_LIMIT, total); index += 1) {
    previewNames.push(splitOutputName(baseName, index, total, grid.rows, grid.cols));
  }
  const hiddenCount = total - previewNames.length;

  const sizeText = imageSize
    ? `原图 ${imageSize.width} × ${imageSize.height}`
    : sizeError !== null
      ? "原图尺寸未知"
      : "正在读取原图尺寸…";

  const handleConfirm = async () => {
    if (busy || !canSplit) return;
    setBusy(true);
    setError(null);
    try {
      const dataUrls = await splitDataUrl(src, grid);
      if (!aliveRef.current) return;
      await onConfirm(dataUrls);
      if (!aliveRef.current) return;
      onClose();
    } catch (err) {
      if (aliveRef.current) setError(`切分失败：${errMessage(err)}`);
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  };

  return (
    <ModalShell
      title={`切分图片${name ? ` · ${name}` : ""}`}
      onClose={onClose}
      testId="image-split-dialog"
      className="!w-[min(680px,94vw)]"
    >
      <header className="modal-header">
        <h3 className="modal-title">切分图片{name ? ` · ${name}` : ""}</h3>
        <p className="modal-subtitle">按行 × 列切成多张 PNG，每格单独输出。</p>
      </header>

      <div className="modal-body flex flex-col gap-4">
        <div className="flex justify-center">
          <div
            data-testid="split-preview"
            className="relative inline-block max-w-full overflow-hidden rounded-lg surface-inset"
          >
            <img
              src={src}
              alt=""
              draggable={false}
              className="block max-h-[300px] max-w-full select-none"
            />
            {/* 切分线只是视觉参考：不吃指针事件，也不进无障碍树 */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 grid"
              style={{
                ...GRID_FRAME_STYLE,
                gridTemplateColumns: `repeat(${grid.cols}, 1fr)`,
                gridTemplateRows: `repeat(${grid.rows}, 1fr)`,
              }}
            >
              {Array.from({ length: total }, (_, index) => (
                <span key={index} data-testid="split-cell" style={CELL_LINE_STYLE} />
              ))}
            </div>
          </div>
        </div>

        <div className="mb-1 flex flex-wrap items-center gap-1.5" role="group" aria-label="网格预设">
          {SPLIT_PRESETS.map((preset) => {
            const active = preset.rows === grid.rows && preset.cols === grid.cols;
            return (
              <button
                key={preset.label}
                type="button"
                aria-pressed={active}
                data-testid={`split-preset-${preset.rows}x${preset.cols}`}
                onClick={() => applyPreset(preset)}
                className={`chip chip--sm ${active ? "chip--brand" : "chip--quiet"}`}
              >
                {preset.label}
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-start gap-3">
          <Field
            id="is-rows"
            label="行数"
            hint={`行列各 1 – ${SPLIT_MAX_ROWS}，可直接填数字`}
            className="w-32"
          >
            <input
              id="is-rows"
              type="number"
              min={1}
              max={SPLIT_MAX_ROWS}
              step={1}
              className="field-control w-full text-sm"
              value={rowsText}
              onChange={(event) => setAxis("rows", event.target.value)}
            />
          </Field>
          <Field id="is-cols" label="列数" className="w-32">
            <input
              id="is-cols"
              type="number"
              min={1}
              max={SPLIT_MAX_COLS}
              step={1}
              className="field-control w-full text-sm"
              value={colsText}
              onChange={(event) => setAxis("cols", event.target.value)}
            />
          </Field>
        </div>

        <div className="flex flex-col gap-1">
          <p className="text-caption" data-testid="split-count">
            {`将切成 ${total} 张（${grid.rows} 行 × ${grid.cols} 列）`}
          </p>
          {canSplit ? null : (
            <p className="text-caption text-amber-600">1×1 等于不切，请选择至少 2 块</p>
          )}
        </div>

        <div data-testid="split-names" className="rounded-lg px-3 py-2 surface-inset">
          <p className="text-caption mb-1">输出文件名</p>
          <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] tabular-nums text-neutral-500">
            {previewNames.map((preview) => (
              <li key={preview}>{preview}</li>
            ))}
          </ul>
          {hiddenCount > 0 ? (
            <p className="mt-1 text-[11px] text-neutral-400">{`…等 ${total} 个`}</p>
          ) : null}
        </div>

        {sizeError !== null && (
          <p role="alert" className="text-xs text-red-600">
            读取原图尺寸失败：{sizeError}
          </p>
        )}

        {error !== null && (
          <p role="alert" className="text-xs text-red-600">
            {error}
          </p>
        )}
      </div>

      <footer className="modal-footer">
        <span className="mr-auto self-center text-[11px] text-neutral-400">{sizeText}</span>
        <button type="button" className="btn-ghost btn-sm" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="btn-primary btn-sm"
          data-testid="image-split-confirm"
          disabled={busy || !canSplit}
          onClick={() => void handleConfirm()}
        >
          {busy ? "处理中…" : "确认切分"}
        </button>
      </footer>
    </ModalShell>
  );
}

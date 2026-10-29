import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import { createPortal } from "react-dom";

import { copyImageToClipboard, copyTextToClipboard } from "../imageCopy";
import { actualZoomPercent, clampPreviewPan, clampZoom, zoomForActualPixels } from "../previewZoom";
import { ModalShell } from "./ModalShell";

/** 工作流条目（保存/加载弹窗共用） */
export interface WorkflowEntry {
  name: string;
  modified: string;
}

/** 保存工作流弹窗：固定目录 output/workflows/，只填名字，可点已有工作流填充（同名覆盖有确认） */
export function WorkflowSaveModal({
  saveName,
  onSaveNameChange,
  workflows,
  onPickName,
  onConfirm,
  onClose,
}: {
  saveName: string;
  onSaveNameChange: (value: string) => void;
  workflows: WorkflowEntry[];
  onPickName: (name: string) => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <ModalShell title="保存工作流" onClose={onClose} className="modal-panel--sm">
      <header className="modal-header">
        <h3 className="modal-title">保存工作流</h3>
        <p className="modal-subtitle">命名并保存当前画布，之后可继续编辑。</p>
      </header>
      <input
        value={saveName}
        onChange={(e) => onSaveNameChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onConfirm();
        }}
        placeholder="输入工作流名字（存到 output/workflows/）"
        autoFocus
        className="field-control mb-3"
      />
      {workflows.length > 0 && (
        <div className="mb-3 max-h-36 overflow-auto rounded-lg border border-neutral-200">
          {workflows.map((w) => (
            <button
              key={w.name}
              type="button"
              onClick={() => onPickName(w.name)}
              className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs text-neutral-700 hover:bg-brand/5 hover:text-brand"
            >
              <span className="truncate">{w.name}</span>
              <span className="shrink-0 text-[10px] text-neutral-400">{w.modified}</span>
            </button>
          ))}
        </div>
      )}
      <div className="modal-footer">
        <button type="button" className="btn-ghost btn-sm" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="btn-primary btn-sm"
          disabled={!saveName.trim()}
          onClick={onConfirm}
        >
          保存
        </button>
      </div>
    </ModalShell>
  );
}

/** 加载工作流弹窗：列出已保存的工作流选择 */
export function WorkflowLoadModal({
  workflows,
  onLoad,
  onClose,
}: {
  workflows: WorkflowEntry[];
  onLoad: (name: string) => void;
  onClose: () => void;
}) {
  return (
    <ModalShell title="加载工作流" onClose={onClose} className="modal-panel--sm">
      <header className="modal-header">
        <h3 className="modal-title">加载工作流</h3>
        <p className="modal-subtitle">选择一份已保存的画布继续工作。</p>
      </header>
      {workflows.length > 0 ? (
        <div className="workflow-list max-h-72 overflow-auto">
          {workflows.map((w) => (
            <button
              key={w.name}
              type="button"
              onClick={() => onLoad(w.name)}
              className="workflow-list__item"
            >
              <span className="truncate">{w.name}</span>
              <span className="workflow-list__meta">{w.modified}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="modal-empty">还没有保存的工作流</div>
      )}
      <div className="modal-footer">
        <button type="button" className="btn-ghost btn-sm" onClick={onClose}>
          取消
        </button>
      </div>
    </ModalShell>
  );
}

/* ---------------- 放大预览：滚轮缩放 + 拖拽平移 + 适应窗口 ----------------
 * 状态收敛为一个 view 对象（zoom + pan），缩放锚定指针位置（transform-origin 为图片中心
 * 时的精确补偿），放大后拖拽平移，双击回到「适应窗口」，Esc / 点击遮罩关闭。
 * 缩放与夹紧的数学在 previewZoom.ts（纯函数，有单测）。
 *
 * **zoom 的含义**：叠加在「已按窗口缩好的布局盒」之上的倍率，不等于「相对原图」的比例。
 * 百分比读数与「实际大小」都要经 `layoutScale` 换算（见 previewZoom.ts 的换算三件套），
 * 否则一张被缩到 68% 的图会显示 100%，而「1:1」也只是回到刚打开时的大小。
 *
 * 图片直接以 imageUrl 显示（前端统一传注册表派生的 url，画布节点与经典表单共用本组件）。
 * 全屏布局：图片区占满整个窗口（contain 不裁切），控制条/文件名/提示悬浮叠加在底部，
 * 不占图片空间（对照旧版 90vw×calc(100vh-9rem) 容器内布局）。 */

/** 滚轮缩放步进 */
const ZOOM_STEP = 1.2;

/** 预览控制坞的按钮样式：压在图片上的中性半透白（不跟随主体色，见 surfaceAudit 的 TSX 豁免）。
 *  统一定义而不是每处重写 —— 早先 6 个按钮三种写法（有的带圆角、有的没有、字号还不一致），
 *  排在同一行里像是拼出来的。**高度必须一致**（`h-7` + `inline-flex items-center`）：
 *  只按 padding 撑高时，图标按钮（24px）会比文字按钮（20px）高一圈，一行里出现两种基线。 */
const DOCK_BUTTON =
  "inline-flex h-7 items-center justify-center rounded-md bg-white/10 px-2.5 leading-none text-white/90 transition-colors duration-200 hover:bg-white/20 hover:text-white";
const DOCK_ICON_BUTTON = `${DOCK_BUTTON} w-7 px-0`;

interface PreviewView {
  zoom: number;
  pan: { x: number; y: number };
}

export function ZoomModal({
  imageUrl,
  name,
  copyPath,
  onClose,
}: {
  /** 可直接显示的完整图片 URL：画布与经典表单统一传注册表派生的 url（组件不再关心路径拼接） */
  imageUrl: string;
  name: string;
  /** 本机绝对路径：给了才显示「复制路径」（外链 / blob: 占位图没有可复制路径） */
  copyPath?: string | undefined;
  onClose: () => void;
}) {
  const [view, setView] = useState<PreviewView>({ zoom: 1, pan: { x: 0, y: 0 } });
  /** 拖拽平移进行中（指针捕获期间持续更新；驱动光标样式与过渡开关） */
  const [dragging, setDragging] = useState(false);
  /** 复制反馈：null = 没在反馈；"copied" / "failed" + 一句原因 */
  const [copyState, setCopyState] = useState<{ kind: "copied" | "failed"; text: string } | null>(
    null,
  );
  const copyTimerRef = useRef<number | null>(null);
  /** 图片自然尺寸（onLoad 后获得，供「适应窗口」与真实百分比计算） */
  const naturalRef = useRef<{ width: number; height: number } | null>(null);
  /** 同一份自然尺寸的**状态**副本：百分比读数要跟着它重渲染（ref 变了不会触发渲染） */
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  /** 图片布局盒（fit 到容器后的实际尺寸，缩放基准） */
  const imageBoxRef = useRef<{ width: number; height: number }>({ width: 0, height: 0 });
  /** 拖拽状态：起点、起始平移、是否已发生位移、按下位置是否在图片本体上 */
  const dragRef = useRef<{
    startX: number;
    startY: number;
    panX: number;
    panY: number;
    moved: boolean;
    onImage: boolean;
  } | null>(null);
  /** 图片可视区（90vw×85vh 容器，平移夹紧与缩放锚点都以它为基准） */
  const wrapRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  /** 按下未移动视为"点击"的位移阈值（px），超过才算拖拽平移 */
  const CLICK_TOLERANCE = 5;

  /** 限制平移范围：数学在 previewZoom.ts:clampPreviewPan（纯函数，有单测） */
  const clampPan = useCallback((next: PreviewView): PreviewView => {
    const viewport = viewportRef.current;
    if (!viewport) return next;
    return {
      zoom: next.zoom,
      pan: clampPreviewPan(next.pan, next.zoom, imageBoxRef.current, {
        width: viewport.clientWidth,
        height: viewport.clientHeight,
      }),
    };
  }, []);

  const reset = useCallback(() => setView({ zoom: 1, pan: { x: 0, y: 0 } }), []);

  /** 测量图片布局盒：onLoad 与窗口尺寸变化后都要重测，否则「实际大小」按旧盒子算。
   *  自然尺寸同步写进 state —— 百分比读数由它派生，只放 ref 里界面不会更新。 */
  const measureImage = useCallback(() => {
    const img = imageRef.current;
    if (!img) return;
    imageBoxRef.current = { width: img.clientWidth, height: img.clientHeight };
    const next = { width: img.naturalWidth, height: img.naturalHeight };
    naturalRef.current = next;
    setNatural((prev) =>
      prev && prev.width === next.width && prev.height === next.height ? prev : next,
    );
  }, []);

  // 窗口尺寸变化会改变布局盒（图片是 max-width/max-height 约束的），跟着重测
  useEffect(() => {
    const onResize = () => measureImage();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [measureImage]);

  /** 「实际大小（1:1）」：1 图像像素 = 1 屏幕像素。
   *
   *  **不能写成 zoom=1**：zoom 是叠在「已适应窗口的布局盒」上的倍率，一张 1024×1536 的图
   *  在窗口里可能先被缩到 68%，此时 zoom=1 只回到 68%——那正是「1:1 按钮等于适应窗口」
   *  的老毛病。真实 1:1 的倍率 = 1 / 布局缩放比（见 previewZoom.ts:zoomForActualPixels）。 */
  const actualSize = useCallback(() => {
    const zoom = zoomForActualPixels(naturalRef.current, imageBoxRef.current);
    setView((prev) => clampPan({ zoom, pan: prev.pan }));
  }, [clampPan]);

  /** 适应窗口：按图片自然尺寸缩放到当前视口（全屏布局，控制条悬浮不占位，留 2% 呼吸） */
  const fitToWindow = useCallback(() => {
    const natural = naturalRef.current;
    const wrap = wrapRef.current;
    if (!natural || !wrap) return;
    const availW = wrap.clientWidth * 0.98;
    const availH = wrap.clientHeight * 0.98;
    const zoom = clampZoom(Math.min(1, availW / natural.width, availH / natural.height));
    setView({ zoom, pan: { x: 0, y: 0 } });
  }, []);

  /** 滚轮缩放：以指针位置为锚点（原生非被动监听，保证 preventDefault 拦截页面滚动） */
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const rect = viewport.getBoundingClientRect();
      // 指针相对图片中心的偏移（缩放锚点）
      const cursorX = event.clientX - rect.left - rect.width / 2;
      const cursorY = event.clientY - rect.top - rect.height / 2;
      setView((prev) => {
        const zoom = clampZoom(event.deltaY < 0 ? prev.zoom * ZOOM_STEP : prev.zoom / ZOOM_STEP);
        if (zoom === prev.zoom) return prev;
        // 保持指针下的图像内容不动：pan' = p - (p - pan) * (zoom'/zoom)
        const k = zoom / prev.zoom;
        return clampPan({
          zoom,
          pan: { x: cursorX - (cursorX - prev.pan.x) * k, y: cursorY - (cursorY - prev.pan.y) * k },
        });
      });
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [clampPan]);

  /** Esc 关闭 */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  /** 复制反馈 1.2s 后自动消失；卸载时清定时器（否则关掉弹窗还在 setState） */
  useEffect(
    () => () => {
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
    },
    [],
  );

  const showCopyState = (kind: "copied" | "failed", text: string) => {
    setCopyState({ kind, text });
    if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopyState(null), 1200);
  };

  /** 复制图片本体：走 canvas 转 PNG 后写剪贴板（失败给出可读原因，不静默） */
  const handleCopyImage = async () => {
    try {
      await copyImageToClipboard(imageUrl);
      showCopyState("copied", "已复制图片");
    } catch (err) {
      showCopyState("failed", err instanceof Error ? err.message : "复制失败");
    }
  };

  /** 复制文件路径（本机绝对路径；没有可复制路径时按钮本就不渲染） */
  const handleCopyPath = async () => {
    try {
      await copyTextToClipboard(copyPath ?? "");
      showCopyState("copied", "已复制路径");
    } catch (err) {
      showCopyState("failed", err instanceof Error ? err.message : "复制失败");
    }
  };

  const onPointerDown = (event: PointerEvent) => {
    // 未放大：不拦截，冒泡给 overlay 判定（点空白关闭 / 点图片本体不关）
    if (view.zoom <= 1) return;
    // 放大：拦截并捕获指针用于拖拽；按下位置记录是否在图片本体（endDrag 判断点击时用）
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget instanceof Element) event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      panX: view.pan.x,
      panY: view.pan.y,
      moved: false,
      onImage: event.target === imageRef.current,
    };
    setDragging(true);
  };
  const onPointerMove = (event: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    // 位移超过阈值才进入平移，避免"点击"被误判为拖拽
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) <= CLICK_TOLERANCE) return;
    drag.moved = true;
    setView((prev) =>
      clampPan({
        ...prev,
        pan: { x: drag.panX + dx, y: drag.panY + dy },
      }),
    );
  };
  const endDrag = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    setDragging(false);
    // 放大态下"按下未拖动"= 点击：点在空白（非图片本体）则关闭
    if (drag && !drag.moved && !drag.onImage) onClose();
  };

  /** 点击关闭判定：图片本体与按钮（控制条）不关闭，其余区域（含图片周围透明容器）都算"空白处"。
   *  用 pointerdown 而非 click——放大后拖拽的 pointer capture 会把 click 目标重定向到容器，
   *  按 target 判断会误关；pointerdown 始终派发到真实按下元素。 */
  const onOverlayPointerDown = (event: PointerEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest("button, [data-zoom-image], [data-zoom-controls]")) return;
    onClose();
  };

  // Portal 到 body：脱离带动画 transform 的祖先（如经典表单结果栏 panel-card enter-up，
  // fill both 后 transform 仍非 none 会把 fixed 后代捕获进自己的包含块），保证真正全屏。
  // Portal 的合成事件沿 React 组件树冒泡（非 DOM 树）——若不在此截停 click，
  // 外层宿主（如 HistoryGallery 的遮罩 onClick=onClose）会被 Portal 内的点击误关，
  // 表现为「点放大图中间却退出到画布」。关闭判定本身走 pointerdown，此处只管截停冒泡。
  return createPortal(
    <div
      ref={wrapRef}
      data-zoom-overlay
      className="fixed inset-0 z-50 select-none bg-black/60"
      onPointerDown={onOverlayPointerDown}
      onClick={(event) => event.stopPropagation()}
    >
      {/* 图片可视区：占满整个窗口（contain 不裁切），四周无容器黑边，真正全屏 */}
      <div
        ref={viewportRef}
        className="fixed inset-0 flex touch-none items-center justify-center"
        style={{ cursor: dragging ? "grabbing" : view.zoom > 1 ? "grab" : "zoom-in" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={(e) => {
          e.stopPropagation();
          reset();
        }}
      >
        <img
          ref={imageRef}
          data-zoom-image
          src={imageUrl}
          alt="预览"
          draggable={false}
          onLoad={(e) => {
            const img = e.currentTarget;
            naturalRef.current = { width: img.naturalWidth, height: img.naturalHeight };
            imageBoxRef.current = { width: img.clientWidth, height: img.clientHeight };
            measureImage();
          }}
          className="select-none object-contain"
          style={{
            maxWidth: "100%",
            maxHeight: "100%",
            transform: `translate(${view.pan.x}px, ${view.pan.y}px) scale(${view.zoom})`,
            transformOrigin: "center center",
            // 拖拽中禁用过渡，保证平移跟手；缩放/按钮操作保留轻微过渡
            transition: dragging ? "none" : "transform 0.1s ease-out",
          }}
        />
      </div>
      {/* 顶部信息条：左侧文件名（超长省略，悬停给完整路径）、右侧关闭。
          旧版把文件名塞进底部控制条的第一行，于是「一列三个居中的东西」（名字 / 缩放 / 操作 /
          提示语）挤成一个灰方块，既没有主次也分不清哪行是状态、哪行是按钮。现在按职责分两处：
          身份信息在上、操作在下，中间整块留给图片。 */}
      <div
        data-zoom-controls
        className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-3 p-3"
      >
        <div
          className="pointer-events-auto flex h-7 max-w-[62vw] items-center truncate rounded-lg bg-black/40 px-2.5 text-xs text-white/85 shadow-lg"
          title={copyPath || name}
        >
          {name}
        </div>
        <button
          type="button"
          aria-label="关闭预览"
          title="关闭（Esc）"
          onClick={onClose}
          className="pointer-events-auto flex h-7 w-7 flex-none items-center justify-center rounded-full bg-black/40 text-white/80 shadow-lg transition-colors duration-200 hover:bg-white/20 hover:text-white"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>
      {/* 底部控制坞：**单行三组**（缩放 / 视图 / 动作），组间一条细分隔线。
          不占图片空间；data-zoom-controls 让 overlay 的「点空白关闭」把它排除在外。
          提示语不再常驻显示（四段说明挤在 10px 灰字里最乱），改挂 title —— 交互本身一用就会。 */}
      <div data-zoom-controls className="absolute inset-x-0 bottom-3 flex justify-center px-3">
        <div
          className="relative flex items-center gap-1 rounded-xl bg-black/40 px-1.5 py-1 text-xs text-white shadow-lg"
          title="滚轮缩放 · 放大后拖拽平移 · 双击回到适应窗口 · 点击空白处或 Esc 关闭"
        >
          {/* 组 1：缩放（步进按钮夹住读数，读数是这一组的中心而不是夹在操作按钮中间） */}
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="缩小"
              title="缩小"
              className={DOCK_ICON_BUTTON}
              onClick={() => setView((prev) => clampPan({ ...prev, zoom: clampZoom(prev.zoom / ZOOM_STEP) }))}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M3.5 8h9" />
              </svg>
            </button>
            {/* 读数按**原始像素**算（view.zoom × 布局缩放比），不是 view.zoom 本身：
                图片先被 max-width/height 缩进窗口，直接乘 100 会对着 68% 的画面写 100%。 */}
            <span
              className="flex h-7 w-12 items-center justify-center tabular-nums text-white/90"
              title={`${natural ? `${natural.width}×${natural.height} · ` : ""}相对原图的实际显示比例`}
            >
              {actualZoomPercent(view.zoom, natural, imageBoxRef.current)}%
            </span>
            <button
              type="button"
              aria-label="放大"
              title="放大"
              className={DOCK_ICON_BUTTON}
              onClick={() => setView((prev) => clampPan({ ...prev, zoom: clampZoom(prev.zoom * ZOOM_STEP) }))}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M3.5 8h9M8 3.5v9" />
              </svg>
            </button>
          </div>

          <span aria-hidden="true" className="mx-0.5 h-4 w-px flex-none bg-white/20" />

          {/* 组 2：视图档位。「实际大小」= 1 图像像素 = 1 屏幕像素（旧标签写 1:1 而实现是 zoom=1，
              只等于「回到刚打开时的大小」，与「适应窗口」完全重合 —— 已改为真 1:1）。 */}
          <div className="flex items-center gap-1">
            <button type="button" className={DOCK_BUTTON} onClick={fitToWindow}>
              适应窗口
            </button>
            <button
              type="button"
              className={DOCK_BUTTON}
              onClick={actualSize}
              title="实际大小：1 个图像像素 = 1 个屏幕像素（大图会超出窗口，可拖拽查看）"
            >
              实际大小
            </button>
          </div>

          <span aria-hidden="true" className="mx-0.5 h-4 w-px flex-none bg-white/20" />

          {/* 组 3：动作。图片单击不再跳新页面（旧行为），复制/打开都是显式按钮；
              反馈做成坞上方的浮标（绝对定位），不进布局 —— 反馈一变宽窄就会让鼠标底下的
              按钮挪位置（早先改按钮文字也踩过同一个坑）。 */}
          <div className="flex items-center gap-1">
            <button type="button" className={DOCK_BUTTON} onClick={() => void handleCopyImage()}>
              复制图片
            </button>
            {copyPath && (
              <button
                type="button"
                className={DOCK_BUTTON}
                title={copyPath}
                onClick={() => void handleCopyPath()}
              >
                复制路径
              </button>
            )}
            <a href={imageUrl} target="_blank" rel="noreferrer" className={DOCK_BUTTON}>
              新标签打开
            </a>
          </div>

          {copyState && (
            <span
              role="status"
              aria-live="polite"
              className={`pointer-events-none absolute -top-9 left-1/2 max-w-[60vw] -translate-x-1/2 truncate rounded-md px-2 py-1 text-[11px] shadow-lg ${
                copyState.kind === "copied" ? "bg-emerald-600/90 text-white" : "bg-amber-600/90 text-white"
              }`}
            >
              {copyState.text}
            </span>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

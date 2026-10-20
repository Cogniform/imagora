import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type DragEventHandler, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Layers, Plus, Type, X } from "lucide-react";
import type { Edge, Node, ReactFlowInstance } from "@xyflow/react";
import {
  CANVAS_DRAG_MIME,
  TOOLBAR_DROP_LABEL_CANCEL,
  TOOLBAR_DROP_LABELS,
  countDraggedFiles,
  dragCarriesFiles,
  dropChipLabel,
  extractImageFiles,
  isInsideRect,
  resolveDropIntent,
  type CanvasDropIntent,
} from "./canvasDrop";

/* ---------------- 画布拖拽接线 hook（文件多图 / 工具栏按钮拖出共用） ----------------
 * 职责：落点示意（跟随光标小胶囊）的显隐/定位/文案、拖放意图解析、window 级兜底守卫、
 * 工作区四事件（dragenter/over/leave/drop）。纯逻辑在 canvasDrop.ts，落点换算在 dropPointFromEvent。
 * 高频 dragover 移动只写 DOM（transform/文案），不经 React 状态；状态仅在拖拽起止等低频事件变化。
 * 工具栏拖出：落画布容器内松手才新建，画布外（工具栏/空白）松手取消（示意文案相应切换）。 */

/** 落点示意未拖拽时的占位文案（实际文案在拖拽开始/进入时写入，见 showDropChip） */
const DROP_CHIP_PLACEHOLDER = "松开添加图片";

/** 落点示意相对光标的偏移（右 22 / 下 28px）：略大于鼠标，避免被拖拽虚影遮挡 */
const DROP_CHIP_OFFSET_X = 22;
const DROP_CHIP_OFFSET_Y = 28;
/** 落点示意到视口边缘的最小留白（保证胶囊完整可见） */
const DROP_CHIP_MARGIN = 8;

/** 泛型 N/E 与画布的实际节点/边类型对齐（ReactFlowInstance 是泛型，ref 类型需一致才能传入） */
export interface CanvasDropCallbacks<N extends Node = Node, E extends Edge = Edge> {
  /** 画布容器引用：落点夹紧到可见画布区域 */
  canvasRef: RefObject<HTMLDivElement | null>;
  /** React Flow 实例引用：screenToFlowPosition 换算落点 */
  rfInstanceRef: RefObject<ReactFlowInstance<N, E> | null>;
  /** 弹窗打开时暂停拖放接管（避免误落到弹窗背后） */
  modalOpen: boolean;
  /** 落点换算兜底：实例未就绪时回退视口中心定位 */
  getCreatePosition: () => { x: number; y: number };
  /** 文件拖放落画布：files 已按 isImageFile 过滤，dropPoint 已夹紧到画布 */
  onDropFiles: (files: File[], dropPoint: { x: number; y: number }) => void | Promise<void>;
  /** 工具栏按钮拖放落画布：新建提示词卡片 / 图片组 */
  onDropNode: (kind: "prompt" | "group", dropPoint: { x: number; y: number }) => void;
  /** 日志输出（未拖入图片等提示） */
  onLog: (message: string) => void;
}

export interface UseCanvasDropResult {
  /** 当前拖拽意图（决定落点示意图标/文案、画布 copy 光标）；null = 无拖拽 */
  dropIntent: CanvasDropIntent | null;
  /** 落点示意元素（portal 到 body，跟随光标；渲染到组件任意位置即可） */
  dropChip: ReactNode;
  /** 工作区拖放四事件（挂在 CanvasPage 根节点） */
  dragHandlers: {
    onDragEnter: DragEventHandler<HTMLDivElement>;
    onDragOver: DragEventHandler<HTMLDivElement>;
    onDragLeave: DragEventHandler<HTMLDivElement>;
    onDrop: DragEventHandler<HTMLDivElement>;
  };
  /** 工具栏按钮拖起：登记拖拽类型并显示落点示意（dragStart 用） */
  startToolbarDrag: (event: DragEvent<HTMLButtonElement>, kind: "prompt" | "group") => void;
  /** 清理落点示意（dragEnd / 复位用） */
  hideDropChip: () => void;
}

export function useCanvasDrop<N extends Node = Node, E extends Edge = Edge>({
  canvasRef,
  rfInstanceRef,
  modalOpen,
  getCreatePosition,
  onDropFiles,
  onDropNode,
  onLog,
}: CanvasDropCallbacks<N, E>): UseCanvasDropResult {
  const [dropIntent, setDropIntent] = useState<CanvasDropIntent | null>(null);
  /** 意图最新引用：window 级跟随/事件回调经 ref 读取（避免闭包过期） */
  const dropIntentRef = useRef<CanvasDropIntent | null>(null);
  /** 文件拖拽进入/离开计数：dragenter/dragleave 在子元素间移动成对触发，计数平衡防示意闪烁 */
  const dragDepthRef = useRef(0);
  /** 落点示意外层元素：位置由 positionDropChip 直接写 transform */
  const dropChipRef = useRef<HTMLDivElement>(null);
  /** 落点示意内层胶囊：画布内/外状态（is-outside 类）由 dragover 直接切换（icon 双态，不经 React 状态） */
  const dropChipInnerRef = useRef<HTMLDivElement>(null);
  /** 落点示意文案（图片数量 / 新建类型） */
  const dropChipTextRef = useRef<HTMLSpanElement>(null);

  /** 显示落点示意：intent 决定 drop 行为与图标，label 决定文案 */
  const showDropChip = useCallback((intent: CanvasDropIntent, label: string) => {
    dropIntentRef.current = intent;
    setDropIntent(intent);
    const text = dropChipTextRef.current;
    if (text && text.textContent !== label) text.textContent = label;
  }, []);

  /** 隐藏落点示意（drop / dragend / 失焦 / 文件拖拽离开工作区）；顺带复位画布内/外状态类 */
  const hideDropChip = useCallback(() => {
    dropIntentRef.current = null;
    setDropIntent(null);
    dropChipInnerRef.current?.classList.remove("is-outside");
  }, []);

  /** 落点示意跟随光标：直接写 fixed 定位元素的 transform（不进 React 状态，只做合成器层位移）；
   *  贴近视口右/下边缘时向内收，保证胶囊完整可见。 */
  const positionDropChip = useCallback((clientX: number, clientY: number) => {
    const chip = dropChipRef.current;
    if (!chip) return;
    const x = Math.min(clientX + DROP_CHIP_OFFSET_X, window.innerWidth - chip.offsetWidth - DROP_CHIP_MARGIN);
    const y = Math.min(clientY + DROP_CHIP_OFFSET_Y, window.innerHeight - chip.offsetHeight - DROP_CHIP_MARGIN);
    chip.style.transform = `translate(${Math.max(DROP_CHIP_MARGIN, x)}px, ${Math.max(DROP_CHIP_MARGIN, y)}px)`;
  }, []);

  /** 拖放落点换算：屏幕坐标 → 画布坐标；落点在工作区但画布外（工具栏）时夹紧到画布边缘，
   *  保证节点始终落在可见画布内（实例未就绪回退视口中心定位）。 */
  const dropPointFromEvent = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } => {
      const rf = rfInstanceRef.current;
      const el = canvasRef.current;
      if (!rf || !el) return getCreatePosition();
      const rect = el.getBoundingClientRect();
      const x = Math.min(Math.max(clientX, rect.left), rect.left + rect.width);
      const y = Math.min(Math.max(clientY, rect.top), rect.top + rect.height);
      return rf.screenToFlowPosition({ x, y });
    },
    [canvasRef, getCreatePosition, rfInstanceRef],
  );

  /* ---------------- 拖拽兜底：窗口级拦截 + 全局跟随 + 状态复位 ----------------
   * 1) 文件拖拽在 window 层 preventDefault：落到工作区外不会触发浏览器「打开文件」导航；
   *    只拦截携带 Files 的拖拽，文本拖拽进输入框不受影响。
   * 2) 工具栏拖出时落点示意【全局】跟随光标：任何位置的 dragover 都更新胶囊位置（不 preventDefault）；
   *    同时按位置切换文案——画布内「松开新建」，画布外「松开取消」（先于 drop 给出反馈）。
   * 3) dragend / 窗口失焦复位拖拽状态：文件拖出浏览器窗口或按 Esc 取消时没有 drop 事件，
   *    计数可能残留，统一归零保证下次拖拽状态干净。 */
  useEffect(() => {
    const preventFileDrop = (event: WindowEventMap["dragover"]) => {
      if (dragCarriesFiles(event)) event.preventDefault();
    };
    const positionToolbarDrag = (event: WindowEventMap["dragover"]) => {
      const intent = dropIntentRef.current;
      if (!intent || intent === "images") return;
      positionDropChip(event.clientX, event.clientY);
      // 画布内 = 松手新建；画布外 = 松手取消（文案与图标实时切换，先于 drop 行为给出反馈）
      const el = canvasRef.current;
      const inside = !!el && isInsideRect(event.clientX, event.clientY, el.getBoundingClientRect());
      const label = inside ? TOOLBAR_DROP_LABELS[intent] : TOOLBAR_DROP_LABEL_CANCEL;
      const text = dropChipTextRef.current;
      if (text && text.textContent !== label) text.textContent = label;
      dropChipInnerRef.current?.classList.toggle("is-outside", !inside);
    };
    const resetDragState = () => {
      dragDepthRef.current = 0;
      hideDropChip();
    };
    window.addEventListener("dragover", preventFileDrop);
    window.addEventListener("dragover", positionToolbarDrag);
    window.addEventListener("drop", preventFileDrop);
    window.addEventListener("dragend", resetDragState);
    window.addEventListener("blur", resetDragState);
    return () => {
      window.removeEventListener("dragover", preventFileDrop);
      window.removeEventListener("dragover", positionToolbarDrag);
      window.removeEventListener("drop", preventFileDrop);
      window.removeEventListener("dragend", resetDragState);
      window.removeEventListener("blur", resetDragState);
    };
  }, [canvasRef, hideDropChip, positionDropChip]);

  /** 工作区拖放四事件（挂 CanvasPage 根节点）：整块工作区都是拖放区，UI 上不出现浏览器禁止标志；
   *  文本/无关拖拽放行（输入框原生行为不受影响）；弹窗打开时暂停接管。 */
  const dragHandlers = useMemo<UseCanvasDropResult["dragHandlers"]>(() => {
    const resolveKind = (event: DragEvent) => resolveDropIntent(event, dropIntentRef.current);

    const handleDragEnter = (event: DragEvent) => {
      if (modalOpen) return;
      const kind = resolveKind(event);
      if (!kind) return;
      event.preventDefault();
      if (kind === "images") {
        dragDepthRef.current += 1;
        showDropChip(kind, dropChipLabel(kind, countDraggedFiles(event.dataTransfer)));
      } else {
        // 工具栏拖出：示意已由 dragstart 显示（全局跟随），这里只允许 drop 生效
        showDropChip(kind, dropChipLabel(kind, 0));
      }
      positionDropChip(event.clientX, event.clientY);
    };

    const handleDragOver = (event: DragEvent) => {
      if (modalOpen) return;
      const kind = resolveKind(event);
      if (!kind) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      positionDropChip(event.clientX, event.clientY);
    };

    const handleDragLeave = (event: DragEvent) => {
      if (modalOpen) return;
      // 只对文件拖拽做计数平衡：离开工作区即隐藏示意；工具栏拖出示意全局跟随，不在这里隐藏
      if (resolveKind(event) === "images") {
        dragDepthRef.current -= 1;
        if (dragDepthRef.current <= 0) {
          dragDepthRef.current = 0;
          hideDropChip();
        }
      }
    };

    const handleDrop = (event: DragEvent) => {
      if (modalOpen) return;
      const kind = resolveKind(event);
      if (!kind) return;
      event.preventDefault();
      dragDepthRef.current = 0;
      hideDropChip();
      // 工具栏拖出：只有落在画布容器内才新建；画布外（工具栏/空白）松手即取消——
      // drop 派发到工作区根节点（整体接管 preventDefault）后才走到这里，画布外直接 return 不再夹紧放置。
      if (kind !== "images") {
        const el = canvasRef.current;
        if (!el || !isInsideRect(event.clientX, event.clientY, el.getBoundingClientRect())) return;
      }
      const dropPoint = dropPointFromEvent(event.clientX, event.clientY);
      if (kind === "images") {
        const files = extractImageFiles(event.dataTransfer);
        if (!files.length) {
          onLog("未检测到图片文件，拖拽未添加任何图片");
          return;
        }
        void onDropFiles(files, dropPoint);
      } else {
        onDropNode(kind, dropPoint);
      }
    };

    return {
      onDragEnter: handleDragEnter,
      onDragOver: handleDragOver,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop,
    };
  }, [canvasRef, dropPointFromEvent, hideDropChip, modalOpen, onDropFiles, onDropNode, onLog, positionDropChip, showDropChip]);

  /** 工具栏按钮拖起：登记拖拽类型 → 显示落点示意（portal 全局跟随，不限于画布内） */
  const startToolbarDrag = useCallback(
    (event: DragEvent<HTMLButtonElement>, kind: "prompt" | "group") => {
      event.dataTransfer.setData(CANVAS_DRAG_MIME, kind);
      event.dataTransfer.effectAllowed = "copy";
      showDropChip(kind, dropChipLabel(kind, 0));
      positionDropChip(event.clientX, event.clientY);
    },
    [positionDropChip, showDropChip],
  );

  /** 落点示意元素：portal 到 body + fixed 定位，工具栏拖出时可全局跟随（不限于画布内）；
   *  外层由 positionDropChip 直接写 transform（不触发 React 渲染），内层负责外观与入场动画。 */
  const dropChip = useMemo(
    () =>
      createPortal(
        <div
          ref={dropChipRef}
          data-drop-chip
          aria-hidden
          className="pointer-events-none fixed left-0 top-0 z-[9999] w-max will-change-transform"
        >
          <div
            ref={dropChipInnerRef}
            className={`canvas-drop-chip surface-float flex items-center gap-2 rounded-full border border-brand/40 px-3 py-1.5 text-sm font-medium text-neutral-700 shadow-md ${dropIntent ? "show" : ""}`}
          >
            <span className="drop-chip-icon drop-chip-icon--create">
              {dropIntent === "prompt" ? (
                <Type size={15} strokeWidth={2.5} className="text-brand" />
              ) : dropIntent === "group" ? (
                <Layers size={15} strokeWidth={2.5} className="text-brand" />
              ) : (
                <Plus size={15} strokeWidth={3} className="text-brand" />
              )}
            </span>
            <span className="drop-chip-icon drop-chip-icon--cancel" aria-hidden>
              <X size={15} strokeWidth={2.5} className="text-red-500" />
            </span>
            <span ref={dropChipTextRef} className="whitespace-nowrap">{DROP_CHIP_PLACEHOLDER}</span>
          </div>
        </div>,
        document.body,
      ),
    [dropIntent],
  );

  return { dropIntent, dropChip, dragHandlers, startToolbarDrag, hideDropChip };
}

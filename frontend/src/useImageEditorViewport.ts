import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

/**
 * 图片编辑器视口（缩放 + 平移 + 空格拖拽）——预览区的交互内核，与渲染解耦。
 *
 * 移植自 basketikun/infinite-canvas（MIT）的 use-image-editor-viewport.ts，
 * 按本仓约束重写：严格开关（exactOptionalPropertyTypes / noUncheckedIndexedAccess）、
 * 导出纯函数便于单测、中文注释写明「为什么」。
 *
 * 视口模型（三者必须一起看，改一个就要重推另两个）：
 * - baseSize：图片按「视口减去 padding」等比缩小（只缩不放，scale 上限 1）后的**基准尺寸**；
 * - stageSize：基准尺寸 × zoom，即图片在滚动内容里占据的框；
 * - contentSize：滚动内容的尺寸，最小铺满视口，这样图片小于视口时仍能水平/垂直居中。
 * 因此 zoom 只改 stageSize，baseSize 不变；mediaStyle 用 transform: scale(zoom) 把基准尺寸放大到 stage 尺寸
 * （transform 不触发重排，拖拽缩放时不会逐帧排版 2000px 的图片）。
 *
 * 缩放锚点的两段式（最容易写错的地方）：
 * 1. setZoomAround 在**当前**布局下把指针位置换算成「相对图片的比例 + 相对视口的偏移」，存进 zoomAnchorRef，然后只 setZoom；
 * 2. useLayoutEffect 在**新**布局**提交后、绘制前**读回锚点，换算新的 scrollLeft/scrollTop，再清空锚点。
 * 分两段是因为新 scroll 位置依赖新 stage 尺寸，而新尺寸要到渲染后才知道；
 * 用 useLayoutEffect 而不是 useEffect，是为了让滚动调整发生在浏览器绘制前——否则会闪一帧错位。
 */

/** 图片显示尺寸（px） */
export interface ImageEditorSize {
  width: number;
  height: number;
}

/** 缩放上限：1 = 适配尺寸，4 = 四倍（图片不像画布，放大再多只会看出模糊） */
export const IMAGE_EDITOR_MIN_ZOOM = 1;
export const IMAGE_EDITOR_MAX_ZOOM = 4;
/** 每档滚轮/按钮缩放的倍率（1.2 的几何级数，档位手感均匀） */
export const IMAGE_EDITOR_ZOOM_STEP = 1.2;
/** 适配时图片四周留白（px）：贴边会显得局促，也留出拖拽的抓取感 */
export const IMAGE_EDITOR_VIEWPORT_PADDING = 16;
/** 跟随缩放生效的滚动条类名；未放大时切到 overflow-hidden，避免多出 0px 滚动条占位 */
export const IMAGE_EDITOR_SCROLL_CLASS = "overflow-scroll";
export const IMAGE_EDITOR_NO_SCROLL_CLASS = "overflow-hidden";

/** 缩放锚点：一次 setZoom 之前记录的「指针在图片上的比例」与「指针在视口上的偏移」 */
interface ZoomAnchor {
  zoom: number;
  ratioX: number;
  ratioY: number;
  viewportX: number;
  viewportY: number;
}

/** 拖拽平移进行中的指针状态（scrollLeft/Top 是按下那一刻的值） */
interface PanState {
  pointerId: number;
  x: number;
  y: number;
  scrollLeft: number;
  scrollTop: number;
}

/** 把任意数字夹进 [min, max]；NaN 会原样穿出，只用于已知有限的输入（尺寸、比例） */
export function clampImageEditorValue(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 图片适配到视口的基准尺寸。
 *
 * - 无图 / 视口未测量（宽或高为 0）→ 0×0：此时不该画出任何东西，也让 setZoomAround 提前返回；
 * - scale 上限 1（Math.min(..., 1)）：小图不放大到铺满，否则纯色小图会被糊成一片；
 * - Math.floor 后 Math.max(1)：极小视口下算出 0 会让后续除法得到 Infinity，钉成 1px 更安全。
 */
export function fitImageToViewport(image: ImageEditorSize | null, viewport: ImageEditorSize): ImageEditorSize {
  if (!image || !viewport.width || !viewport.height) return { width: 0, height: 0 };
  const availableWidth = Math.max(1, viewport.width - IMAGE_EDITOR_VIEWPORT_PADDING * 2);
  const availableHeight = Math.max(1, viewport.height - IMAGE_EDITOR_VIEWPORT_PADDING * 2);
  const scale = Math.min(availableWidth / image.width, availableHeight / image.height, 1);
  return {
    width: Math.max(1, Math.floor(image.width * scale)),
    height: Math.max(1, Math.floor(image.height * scale)),
  };
}

/**
 * 滚动内容尺寸：至少铺满视口，图片更大时才撑开。
 * 没有这条 Math.max，图片小于视口时内容盒比视口窄，stageOffset 的居中就算不出来（scroll 左端对齐，图片偏左）。
 */
export function imageEditorContentSize(stage: ImageEditorSize, viewport: ImageEditorSize): ImageEditorSize {
  return {
    width: Math.max(viewport.width, stage.width),
    height: Math.max(viewport.height, stage.height),
  };
}

/** 图片在滚动内容里的居中偏移；内容比 stage 大时才 > 0 */
export function imageEditorStageOffset(content: ImageEditorSize, stage: ImageEditorSize): { left: number; top: number } {
  return {
    left: Math.max(0, Math.round((content.width - stage.width) / 2)),
    top: Math.max(0, Math.round((content.height - stage.height) / 2)),
  };
}

/** 是否还能放大 / 是否已经放大（都按 0.001 容差判，避免浮点累积误差让按钮永远亮着） */
export function canImageEditorZoomIn(zoom: number): boolean {
  return zoom < IMAGE_EDITOR_MAX_ZOOM - 0.001;
}

export function canImageEditorZoomOut(zoom: number): boolean {
  return zoom > IMAGE_EDITOR_MIN_ZOOM + 0.001;
}

/** 放大状态下才允许滚动条（类名由调用方挂到视口节点上） */
export function imageEditorScrollClassName(zoom: number): string {
  return canImageEditorZoomOut(zoom) ? IMAGE_EDITOR_SCROLL_CLASS : IMAGE_EDITOR_NO_SCROLL_CLASS;
}

/**
 * 锚点生效后的滚动位置。
 *
 * 推导：希望「图片上比例 ratio 的那一点」仍落在「视口偏移 viewport 处」，
 * 而该点在滚动内容里的坐标是 `内容居中偏移 + ratio × stage 尺寸`，故 scroll = 该坐标 − viewport 偏移。
 * 居中偏移用新 stage 尺寸重算（而不是复用渲染前算好的 stageOffset），因为这里是布局提交后读的 clientWidth，
 * 与渲染时的 viewportSize 可能差一帧——用新值才能和浏览器实际排版对齐。
 */
export function imageEditorAnchorScroll(
  anchor: Pick<ZoomAnchor, "ratioX" | "ratioY" | "viewportX" | "viewportY">,
  stage: ImageEditorSize,
  viewport: ImageEditorSize,
): { scrollLeft: number; scrollTop: number } {
  const content = imageEditorContentSize(stage, viewport);
  const offset = imageEditorStageOffset(content, stage);
  return {
    scrollLeft: offset.left + anchor.ratioX * stage.width - anchor.viewportX,
    scrollTop: offset.top + anchor.ratioY * stage.height - anchor.viewportY,
  };
}

/**
 * 由指针位置换算缩放锚点。
 *
 * ratioX/ratioY 夹到 [0, 1]：指针可能在图片外的留白上（滚轮在留白区也会缩放），
 * 夹紧等价于「以最近的一条边为锚」，比放任比例越界导致滚动到内容之外更符合预期。
 * stage 宽高用 Math.max(1, ...) 兜底，避免 stage 尚未布局（rect 全 0）时除出 Infinity。
 */
export function imageEditorAnchorAt(
  nextZoom: number,
  pointer: { x: number; y: number },
  viewportRect: { left: number; top: number },
  stageRect: { left: number; top: number; width: number; height: number },
): ZoomAnchor {
  return {
    zoom: nextZoom,
    ratioX: clampImageEditorValue((pointer.x - stageRect.left) / Math.max(1, stageRect.width), 0, 1),
    ratioY: clampImageEditorValue((pointer.y - stageRect.top) / Math.max(1, stageRect.height), 0, 1),
    viewportX: pointer.x - viewportRect.left,
    viewportY: pointer.y - viewportRect.top,
  };
}

/** 平移：内容随手指同向移动，滚动位置反向变化 */
export function imageEditorPanScroll(pan: PanState, pointer: { x: number; y: number }): { scrollLeft: number; scrollTop: number } {
  return {
    scrollLeft: pan.scrollLeft - (pointer.x - pan.x),
    scrollTop: pan.scrollTop - (pointer.y - pan.y),
  };
}

/** 按下指针是否该开始平移：中键，或空格按住时的左键 */
export function isImageEditorPanGesture(button: number, spacePressed: boolean): boolean {
  return button === 1 || (button === 0 && spacePressed);
}

/** 焦点是否在可编辑元素上——此时空格是空格，不是抓手 */
const EDITABLE_SELECTOR = "input,textarea,[contenteditable='true']";
/** 会被空格「点击」的元素：按下空格前先 blur，否则焦点按钮会被空格触发一次 */
const FOCUSABLE_SPACE_TARGET = "button,a,[role='button']";

export function useImageEditorViewport(image: ImageEditorSize | null, open: boolean) {
  const viewportNodeRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<PanState | null>(null);
  const zoomAnchorRef = useRef<ZoomAnchor | null>(null);
  const [viewportElement, setViewportElement] = useState<HTMLDivElement | null>(null);
  const [viewportSize, setViewportSize] = useState<ImageEditorSize>({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(IMAGE_EDITOR_MIN_ZOOM);
  const [isPanning, setIsPanning] = useState(false);
  const [spacePressed, setSpacePressed] = useState(false);
  const spacePressedRef = useRef(false);

  /** 回调 ref：把节点同时存进 ref（给事件监听用，不触发重渲染）和 state（给 effect 依赖用） */
  const viewportRef = useCallback((node: HTMLDivElement | null) => {
    viewportNodeRef.current = node;
    setViewportElement(node);
  }, []);

  const imageWidth = image?.width;
  const imageHeight = image?.height;

  // 换图或重新打开：缩放回到适配档，丢弃上一次的锚点（否则会用旧图的锚点算新图的滚动位置）
  useEffect(() => {
    if (!open) return;
    zoomAnchorRef.current = null;
    setZoom(IMAGE_EDITOR_MIN_ZOOM);
  }, [open, imageWidth, imageHeight]);

  // 空格抓手：捕获阶段拦下，避免浏览器把空格当成滚动页面 / 触发聚焦按钮
  useEffect(() => {
    if (!open) return;
    const releaseSpace = () => {
      spacePressedRef.current = false;
      setSpacePressed(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(EDITABLE_SELECTOR)) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (document.activeElement instanceof HTMLElement && document.activeElement.matches(FOCUSABLE_SPACE_TARGET)) {
        document.activeElement.blur();
      }
      spacePressedRef.current = true;
      setSpacePressed(true);
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code !== "Space" || !spacePressedRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      releaseSpace();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    // 窗口失焦（切标签页 / 弹系统框）时 keyup 不会到达，必须主动释放，否则抓手状态永久卡住
    window.addEventListener("blur", releaseSpace);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("blur", releaseSpace);
      spacePressedRef.current = false;
    };
  }, [open]);

  // 视口尺寸测量：ResizeObserver 跟随窗口/面板变化，只在真正变了才 setState（避免无谓重渲染）
  useEffect(() => {
    if (!open || !viewportElement) return;
    const updateSize = () => {
      const width = viewportElement.clientWidth;
      const height = viewportElement.clientHeight;
      setViewportSize((current) => (current.width === width && current.height === height ? current : { width, height }));
    };
    updateSize();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateSize);
    observer.observe(viewportElement);
    return () => observer.disconnect();
  }, [open, viewportElement]);

  const baseSize = fitImageToViewport(image, viewportSize);
  const stageSize: ImageEditorSize = { width: baseSize.width * zoom, height: baseSize.height * zoom };
  const contentSize = imageEditorContentSize(stageSize, viewportSize);
  const stageOffset = imageEditorStageOffset(contentSize, stageSize);

  // 第二段缩放：布局提交后、绘制前，按锚点重算滚动位置
  useLayoutEffect(() => {
    const viewport = viewportNodeRef.current;
    const anchor = zoomAnchorRef.current;
    if (!viewport || !anchor || Math.abs(anchor.zoom - zoom) > 0.001) return;
    const next = imageEditorAnchorScroll(
      anchor,
      { width: baseSize.width * zoom, height: baseSize.height * zoom },
      { width: viewport.clientWidth, height: viewport.clientHeight },
    );
    viewport.scrollLeft = next.scrollLeft;
    viewport.scrollTop = next.scrollTop;
    zoomAnchorRef.current = null;
  }, [baseSize.height, baseSize.width, zoom]);

  /** 第一段缩放：记锚点 + setZoom。不给坐标时以视口中心为锚（按钮缩放走这条） */
  const setZoomAround = useCallback(
    (nextZoom: number, clientX?: number, clientY?: number) => {
      const viewport = viewportNodeRef.current;
      const stage = stageRef.current;
      if (!viewport || !stage || !baseSize.width || !baseSize.height) return;

      const boundedZoom = clampImageEditorValue(nextZoom, IMAGE_EDITOR_MIN_ZOOM, IMAGE_EDITOR_MAX_ZOOM);
      if (Math.abs(boundedZoom - zoom) < 0.001) return;

      const viewportRect = viewport.getBoundingClientRect();
      const stageRect = stage.getBoundingClientRect();
      const pointer = {
        x: clientX ?? viewportRect.left + viewportRect.width / 2,
        y: clientY ?? viewportRect.top + viewportRect.height / 2,
      };
      zoomAnchorRef.current = imageEditorAnchorAt(boundedZoom, pointer, viewportRect, stageRect);
      setZoom(boundedZoom);
    },
    [baseSize.height, baseSize.width, zoom],
  );

  // 滚轮缩放：passive: false 才能在滚动容器上 preventDefault（否则页面/父级跟着滚）
  useEffect(() => {
    if (!open || !viewportElement) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setZoomAround(event.deltaY < 0 ? zoom * IMAGE_EDITOR_ZOOM_STEP : zoom / IMAGE_EDITOR_ZOOM_STEP, event.clientX, event.clientY);
    };
    viewportElement.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewportElement.removeEventListener("wheel", handleWheel);
  }, [open, setZoomAround, viewportElement, zoom]);

  // 平移用捕获阶段：图片上的子元素（按钮、热区）先拿到事件也没关系，平移优先
  const startPan = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isImageEditorPanGesture(event.button, spacePressedRef.current)) return;
    event.preventDefault();
    event.stopPropagation();
    const viewport = event.currentTarget;
    panRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
    };
    viewport.setPointerCapture(event.pointerId);
    setIsPanning(true);
  }, []);

  const movePan = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan || event.pointerId !== pan.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const next = imageEditorPanScroll(pan, { x: event.clientX, y: event.clientY });
    event.currentTarget.scrollLeft = next.scrollLeft;
    event.currentTarget.scrollTop = next.scrollTop;
  }, []);

  const stopPan = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan || event.pointerId !== pan.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    panRef.current = null;
    setIsPanning(false);
  }, []);

  /** 中键点击会触发浏览器「在新标签打开链接」的默认行为，这里吃掉 */
  const preventAuxClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  return {
    viewportRef,
    stageRef,
    zoom,
    isPanning,
    spacePressed,
    scrollClassName: imageEditorScrollClassName(zoom),
    panHandlers: {
      onPointerDownCapture: startPan,
      onPointerMoveCapture: movePan,
      onPointerUpCapture: stopPan,
      onPointerCancelCapture: stopPan,
      onAuxClick: preventAuxClick,
    },
    canZoomIn: canImageEditorZoomIn(zoom),
    canZoomOut: canImageEditorZoomOut(zoom),
    /** 图片显示尺寸 / 原始尺寸，供「100%」读数或坐标换算 */
    imageScale: image && image.width ? stageSize.width / image.width : 0,
    zoomIn: () => setZoomAround(zoom * IMAGE_EDITOR_ZOOM_STEP),
    zoomOut: () => setZoomAround(zoom / IMAGE_EDITOR_ZOOM_STEP),
    resetZoom: () => setZoomAround(IMAGE_EDITOR_MIN_ZOOM),
    contentStyle: { width: contentSize.width, height: contentSize.height } satisfies CSSProperties,
    stageStyle: {
      left: stageOffset.left,
      top: stageOffset.top,
      width: stageSize.width,
      height: stageSize.height,
    } satisfies CSSProperties,
    mediaStyle: {
      width: baseSize.width,
      height: baseSize.height,
      transform: `translateZ(0) scale(${zoom})`,
      transformOrigin: "top left",
    } satisfies CSSProperties,
  };
}

export type ImageEditorViewport = ReturnType<typeof useImageEditorViewport>;

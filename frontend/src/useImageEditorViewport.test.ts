// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  IMAGE_EDITOR_MAX_ZOOM,
  IMAGE_EDITOR_MIN_ZOOM,
  IMAGE_EDITOR_NO_SCROLL_CLASS,
  IMAGE_EDITOR_SCROLL_CLASS,
  IMAGE_EDITOR_ZOOM_STEP,
  canImageEditorZoomIn,
  canImageEditorZoomOut,
  clampImageEditorValue,
  fitImageToViewport,
  imageEditorAnchorAt,
  imageEditorAnchorScroll,
  imageEditorContentSize,
  imageEditorPanScroll,
  imageEditorScrollClassName,
  imageEditorStageOffset,
  isImageEditorPanGesture,
  useImageEditorViewport,
  type ImageEditorSize,
} from "./useImageEditorViewport";

/**
 * 覆盖图片编辑器视口的两个必须钉死的部分：
 * 1. 纯函数：适配尺寸 / 居中偏移 / 锚点换算 / 平移方向 —— 交互手感全由这几个公式决定，改了要能立刻发现；
 * 2. hook 状态机：缩放夹紧、锚点重算滚动、空格抓手、滚轮 passive:false、中键平移。
 * jsdom 没有布局，clientWidth / getBoundingClientRect 都是 0，因此 hook 用例手动桩掉
 * HTMLDivElement 原型上的 getter / 方法。
 */

const IMAGE: ImageEditorSize = { width: 400, height: 200 };
const VIEWPORT: ImageEditorSize = { width: 200, height: 200 };

const proto = HTMLDivElement.prototype;

/** 把原型上的某个 getter 桩成固定值；返回还原函数 */
function stubGetter(name: "clientWidth" | "clientHeight", value: number) {
  const descriptor = Object.getOwnPropertyDescriptor(proto, name);
  Object.defineProperty(proto, name, { configurable: true, get: () => value });
  return () => {
    if (descriptor) Object.defineProperty(proto, name, descriptor);
    else delete (proto as unknown as Record<string, unknown>)[name];
  };
}

/** 桩 getBoundingClientRect：offset 模拟元素在文档里的位置，宽高由参数给定 */
function stubRect(left: number, top: number, width: number, height: number) {
  const original = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function (this: HTMLDivElement) {
    return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) };
  } as unknown as typeof proto.getBoundingClientRect;
  return () => {
    proto.getBoundingClientRect = original;
  };
}

/** 可写的 scrollLeft / scrollTop（jsdom 实现为不可写属性，直接赋值静默失败） */
function stubScroll() {
  const state = { left: 0, top: 0 };
  const leftDesc = Object.getOwnPropertyDescriptor(Element.prototype, "scrollLeft");
  const topDesc = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  Object.defineProperty(Element.prototype, "scrollLeft", {
    configurable: true,
    get: () => state.left,
    set: (value: number) => {
      state.left = value;
    },
  });
  Object.defineProperty(Element.prototype, "scrollTop", {
    configurable: true,
    get: () => state.top,
    set: (value: number) => {
      state.top = value;
    },
  });
  return {
    state,
    restore: () => {
      if (leftDesc) Object.defineProperty(Element.prototype, "scrollLeft", leftDesc);
      if (topDesc) Object.defineProperty(Element.prototype, "scrollTop", topDesc);
    },
  };
}

/** 指针捕获桩（jsdom 未实现 setPointerCapture / hasPointerCapture） */
function stubPointerCapture() {
  const held = new Set<number>();
  proto.setPointerCapture = function (this: HTMLDivElement, id: number) {
    held.add(id);
  } as unknown as typeof proto.setPointerCapture;
  proto.hasPointerCapture = function (this: HTMLDivElement, id: number) {
    return held.has(id);
  } as unknown as typeof proto.hasPointerCapture;
  proto.releasePointerCapture = function (this: HTMLDivElement, id: number) {
    held.delete(id);
  } as unknown as typeof proto.releasePointerCapture;
  return held;
}

/** 合成一个 React 指针事件所需的最小字段 */
function pointerEvent(overrides: Record<string, unknown>) {
  return {
    button: 0,
    pointerId: 1,
    clientX: 0,
    clientY: 0,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    currentTarget: document.createElement("div"),
    ...overrides,
  } as never;
}

describe("useImageEditorViewport 纯函数", () => {
  it("clampImageEditorValue 夹紧上下界", () => {
    expect(clampImageEditorValue(5, 0, 1)).toBe(1);
    expect(clampImageEditorValue(-5, 0, 1)).toBe(0);
    expect(clampImageEditorValue(0.5, 0, 1)).toBe(0.5);
  });

  it("fitImageToViewport：等比缩小到视口减留白，且小图不放大", () => {
    // 视口 200-32=168 可用宽；400×200 图按 min(168/400, 168/200, 1)=0.42 缩放
    expect(fitImageToViewport(IMAGE, VIEWPORT)).toEqual({ width: 168, height: 84 });
    // 小图（100×50）scale 被 1 封顶，保持原尺寸
    expect(fitImageToViewport({ width: 100, height: 50 }, VIEWPORT)).toEqual({ width: 100, height: 50 });
  });

  it("fitImageToViewport：无图或视口未测量返回 0×0", () => {
    expect(fitImageToViewport(null, VIEWPORT)).toEqual({ width: 0, height: 0 });
    expect(fitImageToViewport(IMAGE, { width: 0, height: 200 })).toEqual({ width: 0, height: 0 });
    expect(fitImageToViewport(IMAGE, { width: 200, height: 0 })).toEqual({ width: 0, height: 0 });
  });

  it("fitImageToViewport：极小视口仍返回至少 1px（不产生 0 宽导致后续除零）", () => {
    expect(fitImageToViewport({ width: 4000, height: 2000 }, { width: 20, height: 20 })).toEqual({ width: 1, height: 1 });
  });

  it("imageEditorContentSize：内容至少铺满视口，stage 更大时撑开", () => {
    expect(imageEditorContentSize({ width: 50, height: 50 }, VIEWPORT)).toEqual(VIEWPORT);
    expect(imageEditorContentSize({ width: 500, height: 300 }, { width: 200, height: 200 })).toEqual({ width: 500, height: 300 });
  });

  it("imageEditorStageOffset：内容大于 stage 时居中并取整，反之偏移为 0", () => {
    // (200-101)/2 = 49.5 → round 50
    expect(imageEditorStageOffset({ width: 200, height: 200 }, { width: 101, height: 60 })).toEqual({ left: 50, top: 70 });
    expect(imageEditorStageOffset({ width: 100, height: 100 }, { width: 200, height: 200 })).toEqual({ left: 0, top: 0 });
  });

  it("canImageEditorZoomIn / Out 按 0.001 容差判边界", () => {
    expect(canImageEditorZoomIn(IMAGE_EDITOR_MIN_ZOOM)).toBe(true);
    expect(canImageEditorZoomIn(IMAGE_EDITOR_MAX_ZOOM)).toBe(false);
    expect(canImageEditorZoomIn(IMAGE_EDITOR_MAX_ZOOM - 0.0001)).toBe(false);
    expect(canImageEditorZoomOut(IMAGE_EDITOR_MIN_ZOOM)).toBe(false);
    expect(canImageEditorZoomOut(IMAGE_EDITOR_MIN_ZOOM + 1e-9)).toBe(false);
    expect(canImageEditorZoomOut(IMAGE_EDITOR_MIN_ZOOM + 0.01)).toBe(true);
  });

  it("imageEditorScrollClassName：放大才允许滚动条", () => {
    expect(imageEditorScrollClassName(IMAGE_EDITOR_MIN_ZOOM)).toBe(IMAGE_EDITOR_NO_SCROLL_CLASS);
    expect(imageEditorScrollClassName(IMAGE_EDITOR_MIN_ZOOM + 0.5)).toBe(IMAGE_EDITOR_SCROLL_CLASS);
  });

  it("isImageEditorPanGesture：中键始终可拖，左键需空格按住", () => {
    expect(isImageEditorPanGesture(1, false)).toBe(true);
    expect(isImageEditorPanGesture(0, true)).toBe(true);
    expect(isImageEditorPanGesture(0, false)).toBe(false);
    expect(isImageEditorPanGesture(2, true)).toBe(false);
  });

  it("imageEditorAnchorAt：指针在图片上换算比例，视口外夹到 [0,1]", () => {
    const anchor = imageEditorAnchorAt(2, { x: 150, y: 80 }, { left: 100, top: 50 }, { left: 100, top: 50, width: 100, height: 100 });
    expect(anchor).toEqual({ zoom: 2, ratioX: 0.5, ratioY: 0.3, viewportX: 50, viewportY: 30 });

    const clamped = imageEditorAnchorAt(2, { x: 0, y: 500 }, { left: 100, top: 50 }, { left: 100, top: 50, width: 100, height: 100 });
    expect(clamped.ratioX).toBe(0);
    expect(clamped.ratioY).toBe(1);
  });

  it("imageEditorAnchorAt：stage 未布局（宽高 0）时除零兜底，不产生 Infinity", () => {
    const anchor = imageEditorAnchorAt(2, { x: 150, y: 80 }, { left: 100, top: 50 }, { left: 100, top: 50, width: 0, height: 0 });
    expect(Number.isFinite(anchor.ratioX)).toBe(true);
    expect(Number.isFinite(anchor.ratioY)).toBe(true);
  });

  it("imageEditorAnchorScroll：换算后同一图片点仍落在同一视口偏移", () => {
    // 视口 200×200，stage 放大到 336×168：宽撑开（偏移 0），高仍小于视口（居中偏移 16）
    const scroll = imageEditorAnchorScroll(
      { ratioX: 0.5, ratioY: 0.5, viewportX: 100, viewportY: 100 },
      { width: 336, height: 168 },
      VIEWPORT,
    );
    expect(scroll).toEqual({ scrollLeft: 68, scrollTop: 0 });
  });

  it("imageEditorAnchorScroll：stage 小于视口时按居中偏移修正", () => {
    const scroll = imageEditorAnchorScroll(
      { ratioX: 0, ratioY: 0, viewportX: 0, viewportY: 0 },
      { width: 100, height: 100 },
      VIEWPORT,
    );
    expect(scroll).toEqual({ scrollLeft: 50, scrollTop: 50 });
  });

  it("imageEditorPanScroll：内容跟手同向移动（滚动位置反向）", () => {
    const pan = { pointerId: 1, x: 100, y: 100, scrollLeft: 40, scrollTop: 60 };
    expect(imageEditorPanScroll(pan, { x: 70, y: 130 })).toEqual({ scrollLeft: 70, scrollTop: 30 });
  });
});

describe("useImageEditorViewport（hook 状态机）", () => {
  const restores: Array<() => void> = [];
  /** 每个用例挂过的 hook 实例的卸载函数（afterEach 统一回收） */
  const mounted: Array<() => void> = [];

  afterEach(() => {
    // 卸载顺序很重要：hook 的 window keydown 监听是匿名函数，无法 removeEventListener，
    // 留下未卸载的实例会让 keydown 被多个实例同时响应；而在用例里倒序还原原型桩、
    // 在用例外（这里）卸载，才不会出现「先拆桩、后卸载」导致清理时报错。
    while (mounted.length) mounted.pop()?.();
    while (restores.length) restores.pop()?.();
    vi.restoreAllMocks();
  });

  /** 挂载 hook 并把 viewportRef / stageRef 接到两个真实 div 上，返回常用句柄 */
  function mountHook(open = true) {
    restores.push(stubGetter("clientWidth", VIEWPORT.width));
    restores.push(stubGetter("clientHeight", VIEWPORT.height));
    const scroll = stubScroll();
    restores.push(scroll.restore);

    const { result, unmount, rerender } = renderHook(
      ({ open: isOpen }: { open: boolean }) => useImageEditorViewport(IMAGE, isOpen),
      { initialProps: { open } },
    );
    mounted.push(unmount);
    const viewport = document.createElement("div");
    const stage = document.createElement("div");
    act(() => {
      result.current.viewportRef(viewport);
      result.current.stageRef.current = stage;
    });
    return { result, unmount, rerender, viewport, stage, scroll };
  }

  it("默认停在适配档：zoom=1、不可再缩小、无滚动条", () => {
    const { result } = mountHook();
    expect(result.current.zoom).toBe(IMAGE_EDITOR_MIN_ZOOM);
    expect(result.current.canZoomOut).toBe(false);
    expect(result.current.canZoomIn).toBe(true);
    expect(result.current.scrollClassName).toBe(IMAGE_EDITOR_NO_SCROLL_CLASS);
    // 基准尺寸 168×84，zoom=1 时 stage 与之相同
    expect(result.current.stageStyle.width).toBe(168);
    expect(result.current.stageStyle.height).toBe(84);
    // 内容铺满视口 → 水平居中偏移 16、垂直居中偏移 58
    expect(result.current.contentStyle).toEqual({ width: 200, height: 200 });
    expect(result.current.stageStyle.left).toBe(16);
    expect(result.current.stageStyle.top).toBe(58);
    expect(result.current.mediaStyle.transform).toBe("translateZ(0) scale(1)");
  });

  it("zoomIn 按 1.2 倍递增并在上限夹紧，同时切到可滚动类名", () => {
    const { result } = mountHook();
    act(() => result.current.zoomIn());
    expect(result.current.zoom).toBeCloseTo(IMAGE_EDITOR_ZOOM_STEP, 10);
    expect(result.current.scrollClassName).toBe(IMAGE_EDITOR_SCROLL_CLASS);
    expect(result.current.canZoomOut).toBe(true);

    for (let i = 0; i < 10; i += 1) act(() => result.current.zoomIn());
    expect(result.current.zoom).toBe(IMAGE_EDITOR_MAX_ZOOM);
    expect(result.current.canZoomIn).toBe(false);
    expect(result.current.stageStyle.width).toBe(168 * IMAGE_EDITOR_MAX_ZOOM);
  });

  it("zoomOut 不会低于适配档", () => {
    const { result } = mountHook();
    act(() => result.current.zoomOut());
    expect(result.current.zoom).toBe(IMAGE_EDITOR_MIN_ZOOM);
  });

  it("resetZoom 回到适配档：不可再缩小、内容退回铺满视口", () => {
    restores.push(stubRect(0, 0, VIEWPORT.width, VIEWPORT.height));
    const { result } = mountHook();
    act(() => result.current.zoomIn());
    act(() => result.current.zoomIn());
    act(() => result.current.resetZoom());
    expect(result.current.zoom).toBe(IMAGE_EDITOR_MIN_ZOOM);
    expect(result.current.canZoomOut).toBe(false);
    expect(result.current.scrollClassName).toBe(IMAGE_EDITOR_NO_SCROLL_CLASS);
    expect(result.current.contentStyle).toEqual({ width: VIEWPORT.width, height: VIEWPORT.height });
  });

  it("关闭态（!open）不装空格监听、不测尺寸", () => {
    const add = vi.spyOn(window, "addEventListener");
    const { result } = mountHook(false);
    expect(add.mock.calls.filter(([type]) => type === "keydown")).toHaveLength(0);
    expect(result.current.viewportRef).toBeTypeOf("function");
  });

  it("空格按下 → spacePressed=true；松开 / 窗口失焦 → 释放", () => {
    restores.push(stubRect(0, 0, VIEWPORT.width, VIEWPORT.height));
    const { result } = mountHook();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", bubbles: true }));
    });
    expect(result.current.spacePressed).toBe(true);

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keyup", { code: "Space", bubbles: true }));
    });
    expect(result.current.spacePressed).toBe(false);

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", bubbles: true }));
    });
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(result.current.spacePressed).toBe(false);
  });

  it("空格在输入框里不抢：可编辑元素上的 Space 不触发抓手", () => {
    const { result } = mountHook();
    const input = document.createElement("input");
    // 必须挂进文档：游离节点的合成事件升不到 window，测不到「输入框里的空格不算抓手」
    document.body.appendChild(input);
    try {
      act(() => {
        input.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", bubbles: true }));
      });
      expect(result.current.spacePressed).toBe(false);
    } finally {
      input.remove();
    }
  });

  it("滚轮向上放大、向下缩小，且以 passive:false 注册（可 preventDefault）", () => {
    restores.push(stubRect(0, 0, VIEWPORT.width, VIEWPORT.height));
    // 全局桩住 addEventListener 才能抓到注册参数：滚轮监听挂在实例上，而实例是挂载后才创建的
    const add = vi.spyOn(EventTarget.prototype, "addEventListener");
    const { result, viewport } = mountHook();

    // 只找 hook 注册的那一条（React 自己也给容器挂 passive:true 的 wheel 代理监听，别抓错）
    const wheelCall = add.mock.calls.find(([type, , options]) => {
      const passive = (options as { passive?: boolean } | undefined)?.passive;
      return type === "wheel" && passive === false;
    });
    expect(wheelCall?.[2]).toEqual({ passive: false });

    const event = new WheelEvent("wheel", { deltaY: -100, cancelable: true, bubbles: true });
    act(() => {
      viewport.dispatchEvent(event);
    });
    expect(result.current.zoom).toBeCloseTo(IMAGE_EDITOR_ZOOM_STEP, 10);
    expect(event.defaultPrevented).toBe(true);

    act(() => {
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, cancelable: true, bubbles: true }));
    });
    expect(result.current.zoom).toBeCloseTo(IMAGE_EDITOR_MIN_ZOOM, 10);
  });

  it("中键按下开始平移并跟随指针滚动，抬起结束", () => {
    restores.push(stubRect(0, 0, 200, 200));
    const held = stubPointerCapture();
    const { result, viewport, scroll } = mountHook();
    scroll.state.left = 100;
    scroll.state.top = 100;

    const down = pointerEvent({ button: 1, currentTarget: viewport, clientX: 50, clientY: 50 });
    act(() => result.current.panHandlers.onPointerDownCapture(down));
    expect(result.current.isPanning).toBe(true);
    expect(held.has(1)).toBe(true);

    act(() => result.current.panHandlers.onPointerMoveCapture(pointerEvent({ currentTarget: viewport, clientX: 20, clientY: 70 })));
    expect(scroll.state.left).toBe(130);
    expect(scroll.state.top).toBe(80);

    act(() => result.current.panHandlers.onPointerUpCapture(pointerEvent({ currentTarget: viewport })));
    expect(result.current.isPanning).toBe(false);
    expect(held.has(1)).toBe(false);
  });

  it("左键不按空格时不平移（保持图片自身的点击语义）", () => {
    restores.push(stubRect(0, 0, 200, 200));
    stubPointerCapture();
    const { result, viewport } = mountHook();
    act(() => result.current.panHandlers.onPointerDownCapture(pointerEvent({ button: 0, currentTarget: viewport })));
    expect(result.current.isPanning).toBe(false);
  });

  it("按下空格后左键可平移", () => {
    restores.push(stubRect(0, 0, VIEWPORT.width, VIEWPORT.height));
    stubPointerCapture();
    const { result, viewport } = mountHook();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", bubbles: true }));
    });
    act(() => result.current.panHandlers.onPointerDownCapture(pointerEvent({ button: 0, currentTarget: viewport })));
    expect(result.current.isPanning).toBe(true);
  });

  it("非当前指针的 move/up 被忽略（多指场景不串台）", () => {
    restores.push(stubRect(0, 0, 200, 200));
    stubPointerCapture();
    const { result, viewport, scroll } = mountHook();
    act(() => result.current.panHandlers.onPointerDownCapture(pointerEvent({ button: 1, pointerId: 7, currentTarget: viewport })));
    act(() => result.current.panHandlers.onPointerMoveCapture(pointerEvent({ pointerId: 8, clientX: 0, clientY: 0, currentTarget: viewport })));
    expect(scroll.state.left).toBe(0);
    act(() => result.current.panHandlers.onPointerUpCapture(pointerEvent({ pointerId: 8, currentTarget: viewport })));
    expect(result.current.isPanning).toBe(true);
  });

  it("中键 auxclick 被吃掉，其它键放行", () => {
    const { result } = mountHook();
    const middle = { button: 1, preventDefault: vi.fn(), stopPropagation: vi.fn() } as never;
    act(() => result.current.panHandlers.onAuxClick(middle));
    expect((middle as unknown as { preventDefault: ReturnType<typeof vi.fn> }).preventDefault).toHaveBeenCalled();

    const left = { button: 0, preventDefault: vi.fn(), stopPropagation: vi.fn() } as never;
    act(() => result.current.panHandlers.onAuxClick(left));
    expect((left as unknown as { preventDefault: ReturnType<typeof vi.fn> }).preventDefault).not.toHaveBeenCalled();
  });

  it("关闭再打开时缩放回到适配档", () => {
    const { result, rerender } = mountHook();
    act(() => result.current.zoomIn());
    act(() => rerender({ open: false }));
    act(() => rerender({ open: true }));
    expect(result.current.zoom).toBe(IMAGE_EDITOR_MIN_ZOOM);
  });
});

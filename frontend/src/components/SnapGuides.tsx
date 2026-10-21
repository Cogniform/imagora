/**
 * 对齐线渲染层：订阅 `snapGuidesStore`，把当前帧的对齐线画成几条绝对定位的 div。
 *
 * 单独成组件的理由：对齐线只在拖拽的那几帧存在，值却每帧都可能变。它如果写在
 * CanvasPage 的渲染体里，就等于让整个页面跟着这个瞬时值走；拆出来后只有这一个
 * 组件订阅它，页面本体不再读 guides。
 *
 * DOM 契约（E2E 与基线测试依赖，改之前先看 `frontend/e2e`）：
 * - 必须画在 React Flow 的 `ViewportPortal` 里，才能随平移/缩放自动跟随；
 * - `className="snap-guide"`、`data-axis`、`data-testid="snap-guide"` 与内联 style
 *   都是既有契约，逐字符保持原样；
 * - 横向线（axis="x"）是竖直的一条，纵向线（axis="y"）是水平的一条。
 *
 * `memo` 不是装饰：CanvasPage 因节点坐标更新而重渲染时，props 为空的本组件直接跳过，
 * 对齐线只在 store 真的变化时才重画。
 */

import { memo, useSyncExternalStore } from "react";
import { ViewportPortal } from "@xyflow/react";

import { getSnapGuides, subscribe } from "../snapGuidesStore";

export const SnapGuides = memo(function SnapGuides() {
  const guides = useSyncExternalStore(subscribe, getSnapGuides);
  return (
    <ViewportPortal>
      {guides.map((guide) => (
        <div
          key={`${guide.axis}-${guide.position}-${guide.targetId}`}
          className="snap-guide"
          data-axis={guide.axis}
          data-testid="snap-guide"
          style={
            guide.axis === "x"
              ? { left: guide.position, top: -10000, width: 1, height: 20000 }
              : { left: -10000, top: guide.position, width: 20000, height: 1 }
          }
        />
      ))}
    </ViewportPortal>
  );
});

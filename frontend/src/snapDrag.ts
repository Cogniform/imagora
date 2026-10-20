/**
 * 拖拽吸附接线层：把 `snapGuide` 的纯函数接到 React Flow 的 `onNodesChange` 上。
 *
 * 为什么单独一层而不是直接写进 CanvasPage：
 * - `snapGuide` 是零依赖纯函数（好测、可复用），但「哪些 change 算拖拽」「节点尺寸从哪来」
 *   「多选拖动要不要吸」是**接线策略**，和画布组件绑死就没法单测了；
 * - 这一层只依赖 `NodeChange` 类型与 `nodeSize`，仍然不碰 DOM，可以整块单测。
 *
 * 三条接线策略（每条都有测试钉住，改之前先想清楚为什么）：
 *
 * 1. **只吸单节点拖动**。多选拖动时 React Flow 会为每个选中节点各发一条 position change，
 *    逐条独立吸附会把它们吸到不同的对齐线上 —— 一组节点的相对位置当场被拆散。
 *    正确做法是「算出一个公共位移再整体平移」，但那需要知道哪一个是光标下的主节点，
 *    而 change 里没有这个信息。与其猜，不如多选时不吸（相对布局 > 对齐线）。
 *
 * 2. **找不到邻居就不动**。`snapGuide` 明确不自动退回网格；这里也不加网格兜底 ——
 *    用户把图精确摆在任意位置是合法需求，网格会把「差 3px」硬拽到 8px 的倍数上。
 *
 * 3. **只在 `dragging === true` 时吸**。React Flow 在拖拽结束后还会补发一次
 *    `dragging: false` 的最终位置；对它再吸一次等于把用户松手的位置二次挪动，
 *    鼠标和节点会脱节。
 */

import type { NodeChange, NodePositionChange } from "@xyflow/react";

import { nodeSize } from "./layout";
import { snapToNeighbors, type SnapBox, type SnapGuide } from "./snapGuide";
import type { WorkflowNode } from "./types";

/** 吸附开关的本地偏好（与 minimapVisible / canvasBounds 同一套「一偏好一模块」惯例） */
export const SNAP_STORAGE_KEY = "imagora.canvas-snap.v1";

/** 读吸附开关。默认**开**：对齐是画布的默认期望，想自由摆放的人才会去关 */
export function readSnapEnabled(): boolean {
  try {
    const raw = window.localStorage.getItem(SNAP_STORAGE_KEY);
    // 只有明确写过 "0" 才算关；没写过、写坏了都按默认开
    if (raw === null) return true;
    return raw !== "0";
  } catch {
    return true;
  }
}

/** 存吸附开关。隐私模式 / 配额满时静默失败，不打断画布 */
export function saveSnapEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(SNAP_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // 存不下就退回默认，宁可偏好丢失也不能让拖拽抛错
  }
}

/**
 * 把节点转成吸附用的矩形。
 *
 * 尺寸走 `nodeSize`（优先 `measured`，缺失时用类型估算），因为图片节点高度随图片比例变化，
 * 用固定常量会让「底部对齐」吸到错的位置。
 */
export function snapBoxOf(node: WorkflowNode): SnapBox {
  const size = nodeSize(node);
  return {
    id: node.id,
    x: node.position.x,
    y: node.position.y,
    width: size.width,
    height: size.height,
  };
}

/** 接线结果：给 React Flow 的 changes + 需要画出来的对齐线 */
export interface SnapDragOutcome<C extends NodeChange = NodeChange> {
  changes: readonly C[];
  guides: SnapGuide[];
}

const EMPTY_GUIDES: SnapGuide[] = [];

/**
 * 对一批节点变更做吸附修正。
 *
 * 泛型 `C` 让调用方保住 `NodeChange<WorkflowNode>` 的具体类型 —— React Flow 的
 * `NodeChange` 默认参数是 `NodeBase`，直接用它会把带 data 的 add/replace change 削平，
 * 回传给 `onNodesChange` 时类型对不上。
 *
 * 返回**新的** changes 数组，入参不被修改（React Flow 的 changes 可能被上游复用，
 * 原地改会让「拖拽开始」的历史快照跟着变）。
 */
export function applySnapToChanges<C extends NodeChange>(
  changes: readonly C[],
  nodes: readonly WorkflowNode[],
  enabled: boolean,
): SnapDragOutcome<C> {
  if (!enabled) return { changes, guides: EMPTY_GUIDES };

  // 找出真正在拖的节点。泛型 C 无法用类型谓词收窄（谓词要求目标类型可赋给 C，
  // 而 C 可能是更窄的子类型），所以先按字段判定再显式断言。
  const dragging: NodePositionChange[] = [];
  for (const change of changes) {
    const candidate = change as unknown as NodePositionChange;
    if (candidate.type === "position" && candidate.dragging === true && candidate.position !== undefined) {
      dragging.push(candidate);
    }
  }
  if (dragging.length !== 1) return { changes, guides: EMPTY_GUIDES };

  const moving = dragging[0];
  if (!moving) return { changes, guides: EMPTY_GUIDES };

  const movingNode = nodes.find((node) => node.id === moving.id);
  const position = moving.position;
  if (!movingNode || !position) return { changes, guides: EMPTY_GUIDES };

  // 用「这一帧的新位置」当移动盒，而不是 nodes 里的旧位置 —— 否则永远差一帧
  const movingBox: SnapBox = { ...snapBoxOf(movingNode), x: position.x, y: position.y };
  const others: SnapBox[] = [];
  for (const node of nodes) {
    if (node.id === moving.id) continue;
    others.push(snapBoxOf(node));
  }

  const snapped = snapToNeighbors(movingBox, others);
  if (snapped.guides.length === 0) return { changes, guides: EMPTY_GUIDES };

  const next: C[] = changes.map((change) =>
    (change as unknown as NodePositionChange).id === moving.id && change.type === "position"
      ? ({ ...change, position: { x: snapped.x, y: snapped.y } } as unknown as C)
      : change,
  );
  return { changes: next, guides: snapped.guides };
}

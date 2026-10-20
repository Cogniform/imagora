import type { WorkflowEdge, WorkflowNode } from "./types";

export interface CanvasHistoryState {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

function copyState(state: CanvasHistoryState): CanvasHistoryState {
  return { nodes: [...state.nodes], edges: [...state.edges] };
}

/** 保存用户操作前的画布快照；运行状态更新不应调用 record。 */
export function createCanvasHistory(limit = 50) {
  const maxEntries = Math.max(1, Math.floor(limit));
  const past: CanvasHistoryState[] = [];
  const future: CanvasHistoryState[] = [];

  return {
    /**
     * 记录一次画布快照。默认清空重做栈——这是正确语义：新分支会让旧重做失效。
     * `preserveRedo` 只用于「派生重算」（自动整理 / 自动连线这类不改用户意图、只改布局的操作）：
     * 它之前的撤销记录仍然可重做。删节点、上传图片等改变画布内容的操作必须保持默认清空。
     */
    record(state: CanvasHistoryState, options?: { preserveRedo?: boolean }) {
      past.push(copyState(state));
      if (past.length > maxEntries) past.splice(0, past.length - maxEntries);
      if (options?.preserveRedo !== true) future.length = 0;
    },
    undo(current: CanvasHistoryState): CanvasHistoryState | null {
      const previous = past.pop();
      if (!previous) return null;
      future.unshift(copyState(current));
      return copyState(previous);
    },
    restore(current: CanvasHistoryState): CanvasHistoryState | null {
      const next = future.shift();
      if (!next) return null;
      past.push(copyState(current));
      return copyState(next);
    },
    canUndo: () => past.length > 0,
    canRestore: () => future.length > 0,
    clear() {
      past.length = 0;
      future.length = 0;
    },
  };
}

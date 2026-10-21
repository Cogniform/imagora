import type { WorkflowEdge, WorkflowNode } from "./types";
import { stripAnimClasses } from "./workflow";

export interface RecoverySnapshotPayload {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

/** 只保存可恢复的画布内容：剥离动画类（运行时视觉标记），并排除计时、错误和任务状态等运行期字段。 */
export function buildRecoverySnapshot(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
): RecoverySnapshotPayload {
  return {
    nodes: nodes.map((node) => {
      const cleaned = stripAnimClasses(node.className);
      const base = { ...node };
      if (cleaned === undefined) delete base.className;
      else base.className = cleaned;
      if (base.type !== "prompt") return base;
      const {
        startedAtMs: _startedAtMs,
        resultCount: _resultCount,
        message: _message,
        cancelRequested: _cancelRequested,
        ...data
      } = base.data;
      return {
        ...base,
        data: { ...data, quality: data.quality ?? "high", status: "idle" },
      };
    }),
    edges: [...edges],
  };
}

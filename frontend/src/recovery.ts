import type { WorkflowEdge, WorkflowNode } from "./types";
import { stripAnimClasses } from "./workflow";

export interface RecoverySnapshotPayload {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

/** 只保存可恢复的画布内容：剥离动画类（运行时视觉标记），并排除计时、错误和任务状态等运行期字段。
 *
 * **`taskId` 刻意保留**：它不是运行期状态，而是「任务在服务端还活着」的唯一线索。
 * 切标签页 / 刷新后画布组件卸载、内存映射清空，靠它才能在回来时重新认领任务
 * （见 useGenerationTask 的 reattach）。
 *
 * **`maskDataUrl` 刻意剥掉**：它是原图尺寸的 PNG data URL（几 MB 量级），而快照
 * 每 2.5 秒重写一次、留最近 5 份 —— 一旦用过蒙版，快照会从几 KB 涨到几十 MB
 * 并反复写盘。代价是刷新后涂抹痕迹不恢复（图、位置、引用关系都不受影响），
 * 要用就重涂一遍。 */
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
      if (base.type === "image") {
        const { maskDataUrl: _maskDataUrl, ...data } = base.data;
        return { ...base, data };
      }
      if (base.type !== "prompt") return base;
      const {
        startedAtMs: _startedAtMs,
        resultCount: _resultCount,
        message: _message,
        cancelRequested: _cancelRequested,
        ...data
      } = base.data;
      /* 必需字段只保证「是字符串」，**不替用户编造值**。
       *
       * 为什么必须有这一步：快照是**下一次启动的唯一来源**。节点 data 里若留着
       * `undefined`（缺字段的旧文件、手改的 JSON），它会被原样写回磁盘，
       * 下次打开又读回同一份坏数据 —— 一次事故就变成每次打开都崩、界面里还没法自救。
       * 这里落盘前把形状压缩成合法字符串，坏数据最多影响它自己这一次。
       *
       * 为什么缺失时补空串而不是补一个默认尺寸：空串是**诚实的**「还不知道」，
       * 加载侧（`workflowToCanvas`）会按当前配置的第一档补上，那时才知道用户用的是哪个模型。
       * 在这里写死 1024x1024 等于把一个猜测永久钉进存档，换模型后就成了错的值。 */
      const text = (value: unknown): string => (typeof value === "string" ? value : "");
      return {
        ...base,
        data: {
          ...data,
          prompt: text(data.prompt),
          size: text(data.size),
          quality: text(data.quality) || "high",
          outputDir: text(data.outputDir),
          status: "idle",
        },
      };
    }),
    edges: [...edges],
  };
}

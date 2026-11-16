import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { recoveryLatest, recoverySave } from "./api";
import { errMessage } from "./format";
import { buildRecoverySnapshot } from "./recovery";
import type { WorkflowEdge, WorkflowNode } from "./types";
import { workflowToCanvas } from "./workflow";

interface UseCanvasRecoveryOptions {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  onRestore: (nodes: WorkflowNode[], edges: WorkflowEdge[]) => void;
  onLog: (line: string) => void;
  /** 修复缺 size/quality 的旧卡片时用的缺省值（配置里的第一档，与新建卡片同源）。
   *  刻意收成两个**原始值**而不是一个对象：对象字面量每次渲染都是新引用，
   *  放进下面那个恢复 effect 的依赖里会让它反复重跑 —— 表现是每次渲染都弹一次
   *  「是否恢复」确认框。 */
  defaultSize?: string | undefined;
  defaultQuality?: string | undefined;
}

/** 自动保存到独立恢复快照，并在挂载时询问是否恢复最近快照。 */
export function useCanvasRecovery({
  nodes,
  edges,
  onRestore,
  onLog,
  defaultSize,
  defaultQuality,
}: UseCanvasRecoveryOptions) {
  const [ready, setReady] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  useEffect(() => {
    let active = true;
    recoveryLatest()
      .then((snapshot) => {
        if (!active || !snapshot.ok || !snapshot.nodes?.length) return;
        const label = snapshot.savedAt ? `（${snapshot.savedAt}）` : "";
        if (!window.confirm(`发现画布恢复存档${label}，是否恢复？`)) return;
        const restored = workflowToCanvas(snapshot.nodes, snapshot.edges ?? [], snapshot.missing ?? [], {
          size: defaultSize,
          quality: defaultQuality,
        });
        onRestore(restored.nodes, restored.edges);
        onLog("已恢复最近一次画布存档");
        // 跳过的节点要说出来，否则用户只会以为卡是自己丢的
        if (restored.dropped.length) {
          onLog(`${restored.dropped.length} 个节点数据不完整，已跳过（${restored.dropped[0]?.reason ?? "未知"}）`);
        }
      })
      .catch((err) => {
        if (active) onLog(`读取恢复存档失败：${errMessage(err)}`);
      })
      .finally(() => {
        if (active) setReady(true);
      });
    return () => {
      active = false;
    };
  }, [defaultQuality, defaultSize, onLog, onRestore]);

  const snapshot = useMemo(() => buildRecoverySnapshot(nodes, edges), [nodes, edges]);
  const snapshotKey = useMemo(() => JSON.stringify(snapshot), [snapshot]);
  const saveSnapshot = useCallback(() => {
    void recoverySave(snapshot).catch((err) => {
      if (mountedRef.current) onLog(`自动保存失败：${errMessage(err)}`);
    });
  }, [onLog, snapshot]);

  useEffect(() => {
    if (!ready || !snapshot.nodes.length) return;
    const timer = window.setTimeout(saveSnapshot, 1500);
    return () => window.clearTimeout(timer);
  }, [ready, saveSnapshot, snapshot.nodes.length, snapshotKey]);
}

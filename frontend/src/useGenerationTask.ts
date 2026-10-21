import { useCallback, useEffect, useRef, useState } from "react";
import { cancelTask, checkBudget, fetchTask, isHttpError, submitGenerate } from "./api";
import { errMessage } from "./format";
import type { GenerateParams, GenerationTaskSnapshot, GenerationTaskStatus } from "./types";

/** 任务视图 = 服务端快照 + 前端本地计时（elapsed 秒） */
export interface GenerationTaskView extends GenerationTaskSnapshot {
  /** 本地计时：running 起每秒刷新（以 startedAt 锚定），未开始为 0 */
  elapsed: number;
}

const POLL_INTERVAL_MS = 2000;

/** 任务终态（轮询可停）：历史面板批量重跑的等待循环共用同一口径 */
export const TERMINAL_STATUSES: readonly GenerationTaskStatus[] = ["done", "failed", "cancelled"];

/**
 * 提交（单张走经典表单 / 画布节点）：命中预算闸门（服务端 409）时问一次再重提。
 *
 * 服务端在「超预算且未确认」时返回 409 + 结构化 detail；这里读 /api/budget/check 拿到
 * 人话原因，确认后带 allowOverBudget 重提。confirmedRef 记忆"本次会话已确认"——
 * 「全部运行」会连续提交多条，只在第一次询问，不连问 N 次。
 * 注：这是单张提交的兜底确认（原生 confirm）；历史面板的批量重跑走自己的样式化弹窗。
 */
async function submitWithBudgetConfirm(
  params: GenerateParams,
  confirmedRef: { current: boolean },
): Promise<{ taskId: string; status: GenerationTaskStatus }> {
  try {
    return await submitGenerate(params);
  } catch (err) {
    if (!isHttpError(err) || err.status !== 409) throw err;
    if (!confirmedRef.current) {
      const check = await checkBudget({ count: 1, size: params.size }).catch(() => null);
      const reason = check?.reason || errMessage(err);
      const accepted = typeof window !== "undefined" && window.confirm(`超出预算：${reason}\n仍要生成吗？`);
      if (!accepted) throw err;
      confirmedRef.current = true;
    }
    return await submitGenerate({ ...params, allowOverBudget: true });
  }
}

export interface UseGenerationTaskResult {
  /** 提交生成任务，立即返回 taskId（自动注册并开始轮询） */
  submit: (params: GenerateParams) => Promise<string>;
  /** 请求取消任务（尽力而为，不抛错） */
  cancel: (taskId: string) => Promise<void>;
  /** 读取某任务最新视图（含本地 elapsed） */
  get: (taskId: string) => GenerationTaskView | undefined;
  /** 当前所有已注册任务（含已终态；「全部运行」按钮的运行中判定用） */
  tasks: GenerationTaskView[];
  /** 订阅任务变化（任意状态更新 / elapsed 每秒刷新），返回取消订阅函数 */
  subscribe: (listener: (taskId: string, view: GenerationTaskView) => void) => () => void;
}

/**
 * 统一「提交 - 轮询」hook：经典表单与画布共用。
 * - 提交后立即注册任务视图并开始轮询（2s）
 * - 竞态防护：每任务一个轮询 timer，被替换 / 停止后过期结果直接丢弃
 * - elapsed 本地计时：running 且有 startedAt 后每秒刷新，其余状态不推进
 * - 终态（done/failed/cancelled）自动停止轮询，但任务视图保留（结果回流 / 重试展示用）
 */
export function useGenerationTask(): UseGenerationTaskResult {
  const tasksRef = useRef(new Map<string, GenerationTaskView>());
  const pollTimersRef = useRef(new Map<string, number>());
  const elapsedTimersRef = useRef(new Map<string, number>());
  const listenersRef = useRef(new Set<(taskId: string, view: GenerationTaskView) => void>());
  /** 本窗口会话内已确认过超预算（「全部运行」多条提交只问一次） */
  const overBudgetConfirmedRef = useRef(false);
  /** 已在本窗口点过取消、尚未走到终态的任务：本机意图要压过「取消前那一刻」的旧快照 */
  const requestedCancelRef = useRef(new Set<string>());
  const [, setVersion] = useState(0);

  const emit = useCallback((taskId: string, view: GenerationTaskView) => {
    listenersRef.current.forEach((listener) => listener(taskId, view));
    setVersion((v) => v + 1); // 驱动 tasks 列表重渲染
  }, []);

  const stopPoll = useCallback((taskId: string) => {
    const pollTimer = pollTimersRef.current.get(taskId);
    if (pollTimer !== undefined) {
      window.clearInterval(pollTimer);
      pollTimersRef.current.delete(taskId);
    }
    const elapsedTimer = elapsedTimersRef.current.get(taskId);
    if (elapsedTimer !== undefined) {
      window.clearInterval(elapsedTimer);
      elapsedTimersRef.current.delete(taskId);
    }
  }, []);

  const ensureElapsedTimer = useCallback(
    (taskId: string, startedAt: number) => {
      if (elapsedTimersRef.current.has(taskId)) return;
      const timer = window.setInterval(() => {
        const current = tasksRef.current.get(taskId);
        if (!current || current.status !== "running") {
          window.clearInterval(timer);
          elapsedTimersRef.current.delete(taskId);
          return;
        }
        const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
        if (elapsed !== current.elapsed) {
          const next = { ...current, elapsed };
          tasksRef.current.set(taskId, next);
          emit(taskId, next);
        }
      }, 1000);
      elapsedTimersRef.current.set(taskId, timer);
    },
    [emit],
  );

  const poll = useCallback(
    (taskId: string) => {
      stopPoll(taskId);
      const timer = window.setInterval(async () => {
        // 竞态防护：timer 已被替换（重新提交）或停止（终态/卸载）时丢弃过期结果
        if (pollTimersRef.current.get(taskId) !== timer) return;
        try {
          const snap = await fetchTask(taskId);
          if (pollTimersRef.current.get(taskId) !== timer) return;
          const prev = tasksRef.current.get(taskId);
          const terminal = TERMINAL_STATUSES.includes(snap.status);
          if (terminal) requestedCancelRef.current.delete(taskId);
          const view: GenerationTaskView = {
            ...snap,
            elapsed: prev?.elapsed ?? 0,
            // 点过取消但服务端还没认下时，在途/此轮轮询拿到的仍是取消前的旧状态：
            // 本机意图优先，否则「取消中…」会被旧快照冲回可点，用户能重复点。
            // 终态只认服务端那一份（终态即「意图已结清」，不再叠加，避免挂着取消痕迹）。
            cancelRequested:
              snap.cancelRequested === true || (!terminal && requestedCancelRef.current.has(taskId)),
          };
          tasksRef.current.set(taskId, view);
          if (snap.status === "running" && typeof snap.startedAt === "number") {
            view.elapsed = Math.max(0, Math.floor((Date.now() - snap.startedAt) / 1000));
            ensureElapsedTimer(taskId, snap.startedAt);
          }
          if (terminal) {
            stopPoll(taskId);
          }
          emit(taskId, view);
        } catch {
          if (pollTimersRef.current.get(taskId) !== timer) return;
          requestedCancelRef.current.delete(taskId);
          stopPoll(taskId);
          // 任务不存在 / 已过期（TTL）或网络错误：标记失败，避免界面悬挂
          const view: GenerationTaskView = {
            taskId,
            status: "failed",
            error: "任务查询失败（可能已过期或服务重启）",
            elapsed: tasksRef.current.get(taskId)?.elapsed ?? 0,
          };
          tasksRef.current.set(taskId, view);
          emit(taskId, view);
        }
      }, POLL_INTERVAL_MS);
      pollTimersRef.current.set(taskId, timer);
    },
    [emit, ensureElapsedTimer, stopPoll],
  );

  const submit = useCallback(
    async (params: GenerateParams): Promise<string> => {
      const { taskId, status } = await submitWithBudgetConfirm(params, overBudgetConfirmedRef);
      const view: GenerationTaskView = { taskId, status, elapsed: 0 };
      tasksRef.current.set(taskId, view);
      emit(taskId, view);
      if (status === "queued" || status === "running") {
        poll(taskId);
      }
      return taskId;
    },
    [emit, poll],
  );

  const cancel = useCallback(
    async (taskId: string) => {
      const current = tasksRef.current.get(taskId);
      if (current && !TERMINAL_STATUSES.includes(current.status)) {
        // 先落本机意图再发请求：卡片立刻进「取消中…」，且此后任何快照都盖上这层意图
        //（清除只发生在终态或查询失败，所以不会永久禁用）
        requestedCancelRef.current.add(taskId);
        const next: GenerationTaskView = { ...current, cancelRequested: true };
        tasksRef.current.set(taskId, next);
        emit(taskId, next);
      }
      await cancelTask(taskId).catch(() => {
        /* 尽力而为：服务端 404 等场景不阻断界面 */
      });
    },
    [emit],
  );

  const get = useCallback((taskId: string) => tasksRef.current.get(taskId), []);

  const subscribe = useCallback((listener: (taskId: string, view: GenerationTaskView) => void) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  // 卸载时清理全部定时器
  useEffect(() => {
    const pollTimers = pollTimersRef.current;
    const elapsedTimers = elapsedTimersRef.current;
    return () => {
      pollTimers.forEach((timer) => window.clearInterval(timer));
      elapsedTimers.forEach((timer) => window.clearInterval(timer));
      pollTimers.clear();
      elapsedTimers.clear();
    };
  }, []);

  return {
    submit,
    cancel,
    get,
    tasks: Array.from(tasksRef.current.values()),
    subscribe,
  };
}

"""跨窗口共享的全局生成任务注册表 + 并发执行池（单进程内存实现）。

多窗口 = 多个浏览器标签页，前端各自独立，但都打向同一个后端进程；
任务表与执行池在进程内全局共享，因此「全局并发 MAX_CONCURRENCY」对所有
窗口 / 所有模式（经典表单 / 无限画布）统一生效——经典表单与画布提交的
生成任务进入同一执行池，谁先拿到空槽谁先跑，超出并发上限的自动排队。

约束与取舍（详见 ARCHITECTURE.md「生成任务管线」）：
- 必须单 worker 启动（uvicorn 不传 --workers）：多 worker 各自持有一套任务表
  与执行池，并发上限按 worker 数翻倍，无法保证全局唯一；
- 任务表纯内存：服务重启后任务状态丢失；前端刷新页面会丢失轮询句柄，
  但已提交任务仍会在后台完成（生成结果照常落盘，只是不再回流到界面）；
- 取消为「逻辑取消」：排队中（未开始）的任务取消后不执行；已 running 的任务
  无法中断上游 API（requests 同步阻塞），会跑完当前请求再丢弃结果、释放执行槽。
"""

import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

# 全局同时执行的生成任务数（执行池大小即并发上限）
MAX_CONCURRENCY = 10
# 任务表上限：超出时清理最旧的终态任务
MAX_TASKS = 500
# 终态任务保留秒数（给前端轮询留出窗口），超时惰性清理
TERMINAL_TTL_SECONDS = 600

# 状态机：queued → running → done / failed（任意状态可被取消 → cancelled）
QUEUED = "queued"
RUNNING = "running"
DONE = "done"
FAILED = "failed"
CANCELLED = "cancelled"
TERMINAL_STATUSES = (DONE, FAILED, CANCELLED)


@dataclass
class GenerationTask:
    """一次生成任务的完整上下文（提交时快照，执行线程只读 + 写结果）。"""

    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    status: str = QUEUED
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    cancel_requested: bool = False
    # 生成参数（multipart 兜底文件已在提交线程落临时文件，路径存这里）
    prompt: str = ""
    size: str = ""
    quality: str = ""
    output_dir: str = ""
    win: int = 0
    ref_bases: list[str] = field(default_factory=list)
    temp_bases: list[str] = field(default_factory=list)
    # 稳定提交 id（提交时生成、进程无关，供落盘提交图快照与账本追溯）
    submission_id: str = ""
    # 参考图在提交阶段已注册进 .assets 的 id（server 用；persist 按 id 解析，不重复注册）
    input_asset_ids: list[str] = field(default_factory=list)
    # 结果（由注入的 run_task 写入）
    results: list[dict] = field(default_factory=list)
    messages: list[str] = field(default_factory=list)
    total_cost: float = 0.0
    error: str | None = None

    @property
    def terminal(self) -> bool:
        return self.status in TERMINAL_STATUSES


class TaskManager:
    """任务表 + 执行池：ThreadPoolExecutor 本身即并发限制器（无独立信号量）。

    run_task(task): 执行一次生成并写 task.results / task.messages / task.total_cost，
    由调用方（server）注入；内部消化异常（写 task.error），TaskManager 只做状态编排与兜底。
    """

    def __init__(
        self,
        concurrency: int = MAX_CONCURRENCY,
        max_tasks: int = MAX_TASKS,
        terminal_ttl: float = TERMINAL_TTL_SECONDS,
        run_task=None,
    ):
        self._concurrency = max(1, int(concurrency))
        self._max_tasks = max_tasks
        self._terminal_ttl = terminal_ttl
        self._run_task = run_task
        self._tasks: dict[str, GenerationTask] = {}
        self._lock = threading.Lock()
        self._executor = ThreadPoolExecutor(
            max_workers=self._concurrency, thread_name_prefix="gen-"
        )

    # ---------- 对外 API ----------

    def submit(self, task: GenerationTask) -> str:
        """登记任务并入执行池，立即返回 task_id（状态 queued，跑起来转 running）。"""
        with self._lock:
            self._tasks[task.id] = task
            self._evict_terminal_locked()
        self._executor.submit(self._run, task.id)
        return task.id

    def snapshot(self, task_id: str) -> dict | None:
        """取任务快照（前端轮询用）。终态超 TTL 的惰性清理后返回 None。"""
        with self._lock:
            task = self._tasks.get(task_id)
            if task is None:
                return None
            if (
                task.terminal
                and time.time() - (task.finished_at or task.created_at)
                > self._terminal_ttl
            ):
                del self._tasks[task_id]
                return None
            return {
                "taskId": task.id,
                "status": task.status,
                "startedAt": int(task.started_at * 1000) if task.started_at else None,
                "results": list(task.results),
                "messages": list(task.messages),
                "totalCost": task.total_cost,
                "error": task.error,
                "cancelRequested": task.cancel_requested,
                "submissionId": task.submission_id,
            }

    def cancel(self, task_id: str) -> bool:
        """标记取消：排队中任务不执行；running 任务跑完后丢弃结果。返回是否可取消。"""
        with self._lock:
            task = self._tasks.get(task_id)
            if task is None or task.terminal:
                return False
            task.cancel_requested = True
            return True

    # ---------- 内部：执行编排 ----------

    def _run(self, task_id: str) -> None:
        task = self._get(task_id)
        if task is None:
            return
        if task.cancel_requested:
            self._finish(task, CANCELLED, cleanup_temp=True)
            return
        with self._lock:
            task.status = RUNNING
            task.started_at = time.time()
        try:
            if self._run_task is not None:
                self._run_task(task)
            if task.cancel_requested:
                self._finish(task, CANCELLED, cleanup_temp=True)
            elif task.error is not None:
                self._finish(task, FAILED, cleanup_temp=True)
            else:
                self._finish(task, DONE, cleanup_temp=True)
        except Exception as exc:  # 兜底：run_task 内部未消化干净的异常
            task.error = str(exc)
            self._finish(task, FAILED, cleanup_temp=True)

    def _finish(self, task: GenerationTask, status: str, cleanup_temp: bool) -> None:
        with self._lock:
            task.status = status
            task.finished_at = time.time()
        if cleanup_temp:
            for tmp in task.temp_bases:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass

    def _get(self, task_id: str) -> GenerationTask | None:
        with self._lock:
            return self._tasks.get(task_id)

    def _evict_terminal_locked(self) -> None:
        """超上限时清理终态任务：先清超 TTL 的，仍超则清最旧终态（保持插入序）。"""
        overflow = len(self._tasks) - self._max_tasks
        if overflow <= 0:
            return
        now = time.time()
        expired = [
            tid
            for tid, t in self._tasks.items()
            if t.terminal and now - (t.finished_at or t.created_at) > self._terminal_ttl
        ]
        for tid in expired[:overflow]:
            del self._tasks[tid]
        overflow = len(self._tasks) - self._max_tasks
        if overflow > 0:
            for tid, t in list(self._tasks.items()):
                if overflow <= 0:
                    break
                if t.terminal:
                    del self._tasks[tid]
                    overflow -= 1

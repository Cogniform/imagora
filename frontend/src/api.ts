import type {
  AppConfig,
  AssetEntry,
  ConfigWriteResult,
  GenerateParams,
  GenerationTaskStatus,
  GenerationTaskSnapshot,
  RefItem,
  WorkflowEdge,
  WorkflowNode,
} from "./types";

/** 从错误响应体里取可读原因：FastAPI 的 detail（字符串或 {reason}）优先，非 JSON 原样截断 */
function errorDetail(text: string): string {
  try {
    const parsed = JSON.parse(text) as { detail?: unknown };
    const detail = parsed?.detail;
    if (typeof detail === "string") return detail;
    if (detail && typeof detail === "object" && "reason" in detail) {
      return String((detail as { reason: unknown }).reason);
    }
  } catch {
    // 非 JSON（HTML 报错页等）：走下方原样截断
  }
  return text.slice(0, 200);
}

/** 带 HTTP 状态码的请求错误（调用方用 isHttpError 判别，如 409 超预算分支） */
export interface HttpError extends Error {
  status: number;
}

/** 判别请求抛出的 Error 是否带 HTTP status（不依赖断言，未知值安全） */
export function isHttpError(error: unknown): error is HttpError {
  return error instanceof Error && "status" in error && typeof error.status === "number";
}

/** 通用 JSON 请求，非 2xx 抛 HttpError（带 status，供调用方区分 409 超预算等分支） */
async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const detail = await res.text();
    // 405 的实际含义：路径没匹配到任何 API 路由，请求掉进了末尾的静态文件挂载
    // （StaticFiles 只服务 GET/HEAD，对 POST 一律回 405）。
    // 真实场景几乎只有一种成因：页面是新构建的，但后端进程还是旧的、
    // 不认识这个接口（改了后端代码后没重启服务）。直接翻译成人话，别让用户猜。
    if (res.status === 405) {
      throw Object.assign(
        new Error("服务端是旧版本，不认识这个功能（HTTP 405）。请关闭 imagora 窗口后重新打开一次。"),
        { status: res.status },
      );
    }
    throw Object.assign(new Error(`HTTP ${res.status}: ${errorDetail(detail)}`), {
      status: res.status,
    });
  }
  return res.json() as Promise<T>;
}

/** 写配置的令牌（内存驻留，不写 localStorage）：
 *  由 ConfigGuardMiddleware 在 GET /api/config 的响应头里下发，同源页面能读，
 *  跨站页面受同源策略限制读不到响应头内容，因此拼不出合法令牌。 */
let configToken: string | null = null;

/** 获取应用初始化配置（尺寸/质量/默认输出路径/窗口编号）
 *  传 win 表示沿用已有窗口编号（URL ?win= 或 window.name 记忆），否则由服务端分配。
 *  顺带取出写配置令牌（令牌就是在这个响应里下发的）。 */
export async function getConfig(win?: number): Promise<AppConfig> {
  const query = win ? `?win=${win}` : "";
  const res = await fetch(`/api/config${query}`);
  if (!res.ok) throw new Error(`获取配置失败（HTTP ${res.status}）`);
  configToken = res.headers.get("X-Config-Token") ?? configToken;
  return (await res.json()) as AppConfig;
}

/** 切换配置：写 ACTIVE_PROFILE 与 MODEL_<PROFILE>。
 *
 *  界面只做「选」不做「写」——接口地址 / 路径 / 密钥是定义性内容，改文件即可，
 *  所以这里只可能出现这两个字段（服务端契约更宽，见 docs/config-write-api-design.md）。
 *  失败时抛 HttpError（409 = 文件被外部修改）。 */
export function writeConfig(payload: {
  profile: string;
  changes: Partial<Record<"profile" | "model", string>>;
  expectedMtimes?: { env?: number | null; config?: number | null };
}): Promise<ConfigWriteResult> {
  return requestJson<ConfigWriteResult>("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...tokenHeader() },
    body: JSON.stringify(payload),
  });
}

function tokenHeader(): Record<string, string> {
  return configToken ? { "X-Config-Token": configToken } : {};
}

export function getHealthDetails(): Promise<{
  ok: boolean;
  checks: { apiKey: boolean; frontendBuilt: boolean; outputWritable: boolean };
  issues: string[];
}> {
  return requestJson("/api/health/details");
}

/** 弹出系统文件夹选择器，返回选中的路径（取消则返回原路径） */
export async function selectFolder(current: string): Promise<{ path: string }> {
  return requestJson<{ path: string }>("/api/select-folder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ current }),
  });
}

/** 在系统资源管理器中打开指定文件夹 */
export async function openFolder(path: string): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>("/api/open-folder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
}

/** 参考图落盘服务端（添加进上传区时即调），返回带 path/url/size/ext 的元信息 */
export async function uploadRefs(files: File[]): Promise<RefItem[]> {
  const formData = new FormData();
  for (const file of files) {
    formData.append("images", file);
  }
  const res = await requestJson<{ refs: RefItem[] }>("/api/upload-ref", { method: "POST", body: formData });
  return res.refs;
}

/** 删除已落盘参考图（尽力而为，失败不阻断界面） */
export async function deleteRef(path: string): Promise<void> {
  await requestJson("/api/delete-ref", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
}

/** 记住输出路径：用户一改路径即上报，服务重启后默认沿用（失败不影响界面） */
export async function rememberOutputDir(path: string): Promise<void> {
  await requestJson("/api/output-dir", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
}

/** 文生图 / 图生图（refPaths 优先复用已上传参考图，files 为未上传兜底）
 *  提交后立即返回 {taskId, status}，后续用 fetchTask 轮询快照。
 *
 *  **不携带任何凭据**：配置只有一份，在 .env / config.json 里，服务端自己读。
 *  此前这里会读 localStorage 拼上 api_key / api_base_url —— 那是「浏览器也存一份配置」
 *  时代的产物，已随配置归一移除（见 docs/config-write-api-design.md）。 */
export async function submitGenerate(
  params: GenerateParams,
): Promise<{ taskId: string; status: GenerationTaskStatus }> {
  const formData = new FormData();
  formData.append("prompt", params.prompt);
  if (params.refPaths.length) {
    // 字段名与后端参数名一致（ref_paths: str = Form），后端按 REF_DIR 校验
    formData.append("ref_paths", JSON.stringify(params.refPaths));
  }
  for (const file of params.files) {
    // 字段名必须与后端参数名一致（images: list[UploadFile]），否则后端收不到图片
    formData.append("images", file);
  }
  formData.append("size", params.size);
  formData.append("quality", params.quality);
  formData.append("output_dir", params.outputDir);
  formData.append("win", String(params.win)); // 与后端 Form 参数名一致，日志按窗口溯源
  if (params.allowOverBudget) {
    // 预算预检已确认：超限才放行（见 core/cost.py check_budget 与 /api/budget/check）
    formData.append("allow_over_budget", "true");
  }
  return requestJson("/api/generate", { method: "POST", body: formData });
}


/* ---------------- 生成任务（异步任务管线：提交 / 轮询 / 取消） ---------------- */

/** 轮询任务快照（排队 / 执行 / 完成 / 失败 / 取消） */
export function fetchTask(taskId: string): Promise<GenerationTaskSnapshot> {
  return requestJson<GenerationTaskSnapshot>(`/api/tasks/${encodeURIComponent(taskId)}`);
}

/** 请求取消任务（排队中立即取消；运行中等待当前张完成后丢弃结果） */
export async function cancelTask(taskId: string): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, {
    method: "POST",
  });
}

/* ---------------- 画布工作流（无限画布：图片节点 + 提示词节点） ---------------- */

/** 画布：上传本地图片（multipart），服务端复制进 output/.canvas/ 并登记 registry */
export async function canvasUpload(files: File[]): Promise<{ images: AssetEntry[] }> {
  const formData = new FormData();
  for (const file of files) {
    formData.append("images", file);
  }
  return requestJson<{ images: AssetEntry[] }>("/api/canvas/upload", {
    method: "POST",
    body: formData,
  });
}

/** 画布：从输出目录导入图片（目录递归 / 单文件），复制进 .canvas 并登记 */
export async function canvasImport(
  paths: string[],
): Promise<{ imported: AssetEntry[]; skipped: { path: string; reason: string }[] }> {
  return requestJson("/api/canvas/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths }),
  });
}

/** 画布：删除图片（注册表移除 + 尽力删文件） */
export async function canvasDeleteImage(id: string): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>("/api/canvas/image/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
}

/** 工作流：保存为 JSON 文件（固定目录 output/workflows/<name>.json，仅需名字） */
export async function workflowSave(params: {
  name: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}): Promise<{ ok: boolean; path: string }> {
  return requestJson("/api/canvas/workflow/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
}

/** 工作流：列出 output/workflows/ 下所有工作流（按修改时间倒序） */
export async function workflowList(): Promise<{ workflows: { name: string; modified: string }[] }> {
  return requestJson("/api/canvas/workflow/list");
}

/** 工作流：按名加载（固定目录解析 + 文件存在性校验，缺失进 missing） */
export async function workflowLoad(
  name: string,
): Promise<{ name: string; nodes: WorkflowNode[]; edges: WorkflowEdge[]; missing: string[] }> {
  return requestJson("/api/canvas/workflow/load?name=" + encodeURIComponent(name));
}

export interface RecoverySnapshotResponse {
  ok: boolean;
  empty?: boolean;
  name?: string;
  savedAt?: string;
  nodes?: WorkflowNode[];
  edges?: WorkflowEdge[];
  missing?: string[];
}

/** 创建新的系统恢复快照；服务端保证不会覆盖手动命名工作流。 */
export async function recoverySave(params: {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}): Promise<{ ok: true; path: string; name: string; savedAt: string }> {
  return requestJson("/api/canvas/recovery/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
}

/** 读取最近一份可用系统恢复快照。 */
export async function recoveryLatest(): Promise<RecoverySnapshotResponse> {
  return requestJson("/api/canvas/recovery/latest");
}

/** 经典提交整图导入画布：按 submissionId 取提交图快照（图片路径已实时解析，缺失进 missing） */
export async function importSubmission(
  submissionId: string,
): Promise<{ name: string; nodes: WorkflowNode[]; edges: WorkflowEdge[]; missing: string[] }> {
  return requestJson("/api/canvas/import-submission", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ submissionId }),
  });
}

/** 历史记录参考图条目（后端按注册表解析 /api/history inputAssetIds） */
export interface HistoryInputRef {
  id: string;
  path: string;
  url: string;
}

export interface GenerationHistoryItem {
  time?: string;
  mode?: string;
  refs?: number;
  prompt?: string;
  size?: string;
  quality?: string;
  status?: string;
  cost?: number;
  seconds?: number;
  output?: string;
  exists: boolean;
  path: string;
  url: string;
  /** 参考图（按注册表解析；旧记录 / 纯文生图为空数组） */
  inputRefs?: HistoryInputRef[];
  /** 图生图记录但参考图找不回（有 refs 计数、inputAssetIds 缺失或解析失败） */
  inputRefMissing?: boolean;
}

export async function generationHistory(params: {
  limit?: number;
  offset?: number;
  query?: string;
  status?: string;
} = {}): Promise<{ items: GenerationHistoryItem[]; hasMore: boolean }> {
  const query = new URLSearchParams();
  query.set("limit", String(params.limit ?? 60));
  if (params.offset) query.set("offset", String(params.offset));
  if (params.query) query.set("query", params.query);
  if (params.status) query.set("status", params.status);
  return requestJson(`/api/history?${query.toString()}`);
}

export async function importHistoryAsset(path: string): Promise<{
  imported: AssetEntry[];
  skipped: { path: string; reason: string }[];
}> {
  return requestJson("/api/history/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
}

/* ---------------- 成本看板 + 预算保护（core/cost.py ↔ server.py 同名契约） ---------------- */

/** 本机预算设置（output/.budget.json，git 忽略；0 = 不限） */
export interface BudgetSettings {
  /** 当日累计费用上限（元），0 = 不限 */
  dailyLimit: number;
  /** 单次提交预估上限（元），0 = 不限 */
  singleRunLimit: number;
}

/** 预算 + 今日占用（GET/POST /api/budget 返回） */
export interface BudgetInfo extends BudgetSettings {
  /** 今天已花（只统计成功记录） */
  spentToday: number;
  /** 日预算余额（未设日预算时为 0） */
  remaining: number;
}

export interface HistoryStatsDay {
  date: string;
  count: number;
  ok: number;
  error: number;
  cost: number;
}

export interface HistoryStatsSizeRow {
  size: string;
  count: number;
  cost: number;
}

export interface HistoryStatsModeRow {
  mode: string;
  count: number;
  cost: number;
}

/** 成本看板数据（GET /api/history/stats；账本**原始行**聚合，不去重不截断） */
export interface HistoryStats {
  total: number;
  ok: number;
  error: number;
  successRate: number;
  cost: number;
  seconds: number;
  avgSeconds: number;
  todayCost: number;
  byDay: HistoryStatsDay[];
  bySize: HistoryStatsSizeRow[];
  byMode: HistoryStatsModeRow[];
  budget: BudgetInfo;
}

/** 预算预检结果（POST /api/budget/check；无副作用） */
export interface BudgetCheck {
  allowed: boolean;
  over: boolean;
  confirmed: boolean;
  reason: string;
  estimate: number;
  spentToday: number;
  remaining: number;
  settings: BudgetSettings;
}

export function generationStats(days = 14): Promise<HistoryStats> {
  return requestJson<HistoryStats>(`/api/history/stats?days=${days}`);
}

export function getBudget(): Promise<BudgetInfo> {
  return requestJson<BudgetInfo>("/api/budget");
}

export function saveBudget(settings: BudgetSettings): Promise<{ ok: boolean } & BudgetSettings> {
  return requestJson("/api/budget", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
}

/** 提交前预检：按本次内容估算费用并判断是否超预算（不提交、不花钱） */
export function checkBudget(payload: {
  count?: number;
  size?: string;
  items?: { size: string }[];
}): Promise<BudgetCheck> {
  return requestJson<BudgetCheck>("/api/budget/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/** 批量提交的单个条目（生成历史「重跑失败项」用；refPaths 只接受 .refs/.assets 内路径） */
export interface BatchSubmitItem {
  prompt: string;
  size: string;
  quality: string;
  refPaths: string[];
}

export interface BatchSubmitResult {
  submitted: { taskId: string; prompt: string; size: string; cost: number }[];
  skipped: { index: number; reason: string }[];
  estimate: number;
  budget: BudgetCheck;
}

/** 批量提交生成（一次请求多条，服务端并发队列执行）；超预算未确认时后端 409 */
export function submitGenerateBatch(payload: {
  items: BatchSubmitItem[];
  outputDir?: string;
  win?: number;
  allowOverBudget?: boolean;
}): Promise<BatchSubmitResult> {
  return requestJson<BatchSubmitResult>("/api/generate/batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

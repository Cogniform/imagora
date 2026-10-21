import { resolvePromptRefs, type PromptRefCandidate } from "./promptRefs";
import type {
  AssetEntry,
  CanvasPromptNodeData,
  WorkflowEdge,
  WorkflowNode,
} from "./types";

/** 批量导入图片节点时的错开间距（避免互相重叠） */
const IMAGE_STEP = 260;

/* ---------------- 文件识别：拖拽/粘贴/选择共用同一判定，保证各入口行为一致 ---------------- */

/** 常见图片扩展名（MIME 缺失时兜底识别；与后端 core/canvas.py IMAGE_EXTENSIONS 对齐） */
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;

/** 判断 File 是否为图片：优先按 MIME（image/*），MIME 缺失（部分系统拖拽/粘贴不给类型）时按扩展名兜底。
 *  拖拽进来的非图片文件（如 .txt）在此被过滤，只把图片交给上传接口。 */
export function isImageFile(file: File): boolean {
  if (file.type.startsWith("image/")) return true;
  return IMAGE_EXT_RE.test(file.name);
}

/* ---------------- 新建节点落点：视口中心 + 连续创建阶梯错开 ----------------
 * 纯函数：与上次落点相近（视口基本没动）时每次 +CREATE_STAGGER_STEP，
 * 否则回到视口中心。不依赖节点总数——节点一多按总数取模偏移会越偏越远（历史 bug）。 */
export const CREATE_STAGGER_STEP = 30;
/** 与上次落点相距多少以内视为"连续创建"（视口没怎么动） */
export const CREATE_STAGGER_RADIUS = 200;

export function staggerCreatePosition(
  center: { x: number; y: number },
  last: { x: number; y: number } | null,
): { position: { x: number; y: number }; next: { x: number; y: number } } {
  if (
    last &&
    Math.abs(last.x - center.x) < CREATE_STAGGER_RADIUS &&
    Math.abs(last.y - center.y) < CREATE_STAGGER_RADIUS
  ) {
    const next = { x: last.x + CREATE_STAGGER_STEP, y: last.y + CREATE_STAGGER_STEP };
    return { position: next, next };
  }
  return { position: center, next: center };
}

/* ---------------- 运行期动画类：节点 className 上的视觉标记，不持久化 ---------------- */

/** 动画类正则：node-enter / node-exiting / enter-delay-1..3 */
const ANIM_CLASS_RE = /^(?:node-enter|node-exiting|enter-delay-[1-3])$/;

/** 剥离 className 中的全部动画类（加载工作流时清理运行时标记） */
export function stripAnimClasses(className?: string): string | undefined {
  if (!className) return undefined;
  const cleaned = className.split(/\s+/).filter((c) => c && !ANIM_CLASS_RE.test(c));
  return cleaned.length ? cleaned.join(" ") : undefined;
}

/** 只提取 className 中的动画类（高亮类合并时保留动画标记） */
export function extractAnimClasses(className?: string): string {
  if (!className) return "";
  return className.split(/\s+/).filter((c) => c && ANIM_CLASS_RE.test(c)).join(" ");
}

/** 给节点 className 追加交错入场动画类（按 index 循环 enter-delay-1..3，不覆盖已有类） */
export function withEnterAnim(node: WorkflowNode, index: number): WorkflowNode {
  const anim = `node-enter enter-delay-${(index % 3) + 1}`;
  const cls = [node.className, anim].filter(Boolean).join(" ");
  return { ...node, className: cls };
}

/** 从注册表条目构建单个画布图片节点（url 由后端统一提供，与 node.data.url 同约定） */
export function buildImageNode(
  entry: AssetEntry,
  position: { x: number; y: number },
): WorkflowNode {
  return {
    id: `img-${entry.id}`,
    type: "image",
    position,
    data: {
      registryId: entry.id,
      name: entry.name,
      url: entry.url,
      size: entry.size,
      ext: entry.ext,
      refCount: 0,
      absPath: entry.absPath,
    },
  };
}

/** 从参数构建单个提示词节点（点击居中新建 / 工具栏拖放新建共用同一构建，默认参数由调用方提供） */
export function buildPromptNode(
  position: { x: number; y: number },
  params: { size: string; quality: string; outputDir: string },
): WorkflowNode {
  return {
    id: `prompt-${Date.now()}`,
    type: "prompt",
    position,
    data: {
      prompt: "",
      size: params.size,
      quality: params.quality,
      outputDir: params.outputDir,
      status: "idle" as const,
    },
  };
}

/** 从参数构建单个图片组节点（点击居中新建 / 工具栏拖放新建共用同一构建） */
export function buildGroupNode(position: { x: number; y: number }): WorkflowNode {
  return {
    id: `group-${Date.now()}`,
    type: "group",
    position,
    data: { name: "图片组", imageCount: 0, totalSize: 0 },
  };
}

/** 注册表条目批量建节点：按 registryId 去重（同一文件画布上只一个节点）。
 *  origin 可选：本批节点以该坐标（画布视口中心）为起点，缺省回退画布左上角 (40,40)；
 *  批次内按 IMAGE_STEP 横向排开。origin 由调用方负责错开（getCreatePosition 记忆阶梯），
 *  这里不再按节点数叠加偏移，避免"上传/新建越偏越远"的漂移。 */
export function canvasEntriesToNodes(
  entries: AssetEntry[],
  existing: WorkflowNode[],
  origin?: { x: number; y: number },
): WorkflowNode[] {
  const seen = new Set<string>();
  for (const node of existing) {
    if (node.type === "image") {
      seen.add(node.data.registryId);
    }
  }
  const created: WorkflowNode[] = [];
  const baseX = origin?.x ?? 40;
  const baseY = origin?.y ?? 40;
  let n = 0;
  for (const entry of entries) {
    if (seen.has(entry.id)) {
      continue;
    }
    seen.add(entry.id);
    created.push(buildImageNode(entry, { x: baseX + n * IMAGE_STEP, y: baseY }));
    n += 1;
  }
  return created;
}

/** 工作流加载结果转画布：按 missing 列表给对应图片节点打标（红框提示文件缺失）；
 *  prompt 节点归一化（重置运行状态为 idle，位置/参数无损保留） */
export function workflowToCanvas(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  missing: string[],
): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  const missingSet = new Set(missing);
  const marked = nodes.map((node) => {
    const cleaned = stripAnimClasses(node.className);
    const base = { ...node };
    if (cleaned === undefined) delete base.className;
    else base.className = cleaned;
    if (base.type === "image" && missingSet.has(base.data.registryId)) {
      return { ...base, data: { ...base.data, missing: true } };
    }
    if (base.type === "prompt") {
      // 无损：保留位置/提示词/尺寸/质量/输出路径，仅清掉运行期状态
      return {
        ...base,
        data: {
          ...base.data,
          quality: base.data.quality ?? "high",
          status: "idle" as const,
          startedAtMs: undefined,
          resultCount: undefined,
          message: undefined,
        },
      };
    }
    return base;
  });
  return { nodes: marked, edges };
}

/** 更新单个提示词节点的 data（纯函数：不匹配/非提示词节点原样返回，避免无谓新引用）。
 *  幂等：patch 各键与现状一致时不产生新数组（任务轮询重复推送 running 快照时零重渲染）。 */
export function updatePromptNode(
  nodes: WorkflowNode[],
  nodeId: string,
  patch: Partial<CanvasPromptNodeData>,
): WorkflowNode[] {
  let changed = false;
  const next = nodes.map((n) => {
    if (n.id !== nodeId || n.type !== "prompt") return n;
    const same = Object.keys(patch).every((key) => n.data[key] === patch[key]);
    if (same) return n;
    changed = true;
    return { ...n, data: { ...n.data, ...patch } };
  });
  return changed ? next : nodes;
}

/** 批量更新选区内提示词节点的输出目录；其他节点类型与未选中节点保持原引用。 */
export function updateSelectedPromptOutputDirs(
  nodes: WorkflowNode[],
  selectedIds: ReadonlySet<string>,
  outputDir: string,
): { nodes: WorkflowNode[]; changedCount: number } {
  let changedCount = 0;
  const next = nodes.map((node) => {
    if (node.type !== "prompt" || !selectedIds.has(node.id) || node.data.outputDir === outputDir) {
      return node;
    }
    changedCount += 1;
    return { ...node, data: { ...node.data, outputDir } };
  });
  return { nodes: changedCount ? next : nodes, changedCount };
}

/** 连线类型硬约束（纯函数，CanvasPage 的 isValidConnection 委托实现）：
 *  - 图片 → 提示词 / 图片组（提示词顶部仅一条入边，多图经图片组聚合）
 *  - 图片组 → 提示词 / 图片组（组可作中转：连到组即把上游图片递归传递聚合进来）
 *  - 提示词 → 图片（产出边：生成结果自动连线，也可手动拖）
 *  组链可成环（自由画布不阻止，聚合计数由 computeCounts 的 visited 防环兜底）；
 *  自环（source === target）一律拒绝。 */
export function canConnect(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  connection: { source: string; target: string },
): boolean {
  if (!connection.source || !connection.target || connection.source === connection.target) return false;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const source = byId.get(connection.source);
  const target = byId.get(connection.target);
  if (source?.type === "image") {
    if (target?.type !== "prompt" && target?.type !== "group") return false;
    if (target?.type === "prompt" && edges.some((e) => e.target === connection.target)) return false;
    return true;
  }
  if (source?.type === "group") {
    if (target?.type !== "prompt" && target?.type !== "group") return false;
    if (target?.type === "prompt" && edges.some((e) => e.target === connection.target)) return false;
    return true;
  }
  // 产出边：提示词节点连到结果图片（生成结果自动连线，也可手动拖）
  if (source?.type === "prompt") {
    return target?.type === "image";
  }
  return false;
}

/** 计数索引：一次建好的只读中间量（{@link buildCountIndexes} 产出，两个计数阶段消费） */
interface CountIndexes {
  byId: Map<string, WorkflowNode>;
  incoming: Map<string, string[]>;
  outEdges: Map<string, string[]>;
}

/** 建索引：入边/出边表 + id 查表（分组展开与引用溯源共用） */
function buildCountIndexes(nodes: WorkflowNode[], edges: WorkflowEdge[]): CountIndexes {
  // 入边索引：target -> [source...]（分组递归展开用，避免每层全量过滤）
  const incoming = new Map<string, string[]>();
  // 出边索引：source -> [target...]（引用溯源用）
  const outEdges = new Map<string, string[]>();
  for (const edge of edges) {
    const inList = incoming.get(edge.target);
    if (inList) inList.push(edge.source);
    else incoming.set(edge.target, [edge.source]);
    const outList = outEdges.get(edge.source);
    if (outList) outList.push(edge.target);
    else outEdges.set(edge.source, [edge.target]);
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return { byId, incoming, outEdges };
}

// 引用溯源：从每张图片沿参考数据流方向 BFS，收集可达提示词集合（visited 防组环，
// 提示词/图片节点不扩展出边——那属于产出方向，反向追溯会串流到无关卡片）。
function tracePromptRefs(
  nodes: WorkflowNode[],
  idx: CountIndexes,
  refCounts: Map<string, number>,
): void {
  const { byId, outEdges } = idx;
  for (const node of nodes) {
    if (node.type !== "image") continue;
    const seen = new Set<string>([node.id]);
    const prompts = new Set<string>();
    const stack = [...(outEdges.get(node.id) ?? [])];
    while (stack.length) {
      const nextId = stack.pop()!;
      if (seen.has(nextId)) continue;
      seen.add(nextId);
      const next = byId.get(nextId);
      if (!next) continue;
      if (next.type === "prompt") {
        prompts.add(nextId);
      } else if (next.type === "group") {
        stack.push(...(outEdges.get(nextId) ?? []));
      }
    }
    refCounts.set(node.data.registryId, prompts.size);
  }
}

/** 递归展开一个图片组：直接入边图片计数、嵌套组透传。
 *  stack 是调用方的**路径栈**（进组 add、出组 delete 回溯），环上靠它剪枝而非全局 visited。 */
function expandGroup(
  groupId: string,
  stack: Set<string>,
  idx: CountIndexes,
): { count: number; ids: string[] } {
  const { byId, incoming } = idx;
  if (stack.has(groupId)) return { count: 0, ids: [] };
  const node = byId.get(groupId);
  if (node?.type !== "group") return { count: 0, ids: [] };
  stack.add(groupId);
  let count = 0;
  const ids: string[] = [];
  for (const srcId of incoming.get(groupId) ?? []) {
    const src = byId.get(srcId);
    if (!src) continue;
    if (src.type === "image") {
      count += 1;
      ids.push(src.data.registryId);
    } else if (src.type === "group") {
      const sub = expandGroup(srcId, stack, idx);
      count += sub.count;
      ids.push(...sub.ids);
    }
  }
  stack.delete(groupId);
  return { count, ids };
}

// 分组聚合：每个组各自以空栈展开（不记忆化——成环时缓存会污染环后节点的值）；
// 同趟收集 registryId 列表供去重口径使用。
function aggregateGroups(
  nodes: WorkflowNode[],
  idx: CountIndexes,
  groupCounts: Map<string, number>,
  groupSizes: Map<string, number>,
  groupDups: Map<string, number>,
): void {
  // registryId -> 单节点大小（画布同一文件只有一个节点，无冲突）
  const sizeById = new Map<string, number>();
  for (const node of nodes) {
    if (node.type === "image") sizeById.set(node.data.registryId, node.data.size ?? 0);
  }
  for (const node of nodes) {
    if (node.type !== "group") continue;
    const { count, ids } = expandGroup(node.id, new Set(), idx);
    const unique = new Set(ids);
    groupCounts.set(node.id, unique.size);
    groupSizes.set(node.id, Array.from(unique).reduce((sum, rid) => sum + (sizeById.get(rid) ?? 0), 0));
    groupDups.set(node.id, count - unique.size);
  }
}

/** 计算各图片节点的引用计数与分组节点成员数/总大小，
 *  返回 registryId -> refCount、groupId -> 成员数、groupId -> 总字节、groupId -> 重复条目数。
 *  引用计数 = **引用溯源**：图片数据最终流到的提示词数（N 处 = N 个提示词引用该图）。
 *  沿参考数据流方向（图片/组 → … → 提示词）从图片正向遍历，经图片组链中转到达也算，
 *  同一提示词多路径去重、组环 visited 剪（环上不重复计入、不死循环）；
 *  只连到图片组、组链尚未接提示词的图片引用为 0；到达提示词即收集并停止扩展
 *  （提示词→结果图片是产出方向，不属于参考流，不反向追溯）。
 *  分组计数**递归聚合**：直接入边图片计入，嵌套图片组（组连组）透传其展开结果；
 *  组链成环以 visited 剪枝（环上不重复计入、不死循环），自环同样被剪。
 *  **去重口径**：groupCounts / groupSizes 是**去重后**的唯一口径（同一张图按 registryId
 *  经多条路径到达只算一次——与 collectIncomingImages 交给提示词的实际图片一致）；
 *  groupDups = 原始条目 - 唯一张数，>0 时 UI 在组卡标「去重」提示。 */
export function computeCounts(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
): {
  refCounts: Map<string, number>;
  groupCounts: Map<string, number>;
  groupSizes: Map<string, number>;
  groupDups: Map<string, number>;
} {
  const refCounts = new Map<string, number>();
  const groupCounts = new Map<string, number>();
  const groupSizes = new Map<string, number>();
  const groupDups = new Map<string, number>();
  for (const node of nodes) {
    if (node.type === "image") {
      refCounts.set(node.data.registryId, 0);
    }
    if (node.type === "group") {
      groupCounts.set(node.id, 0);
      groupSizes.set(node.id, 0);
      groupDups.set(node.id, 0);
    }
  }
  const idx = buildCountIndexes(nodes, edges);
  tracePromptRefs(nodes, idx, refCounts);
  aggregateGroups(nodes, idx, groupCounts, groupSizes, groupDups);
  return { refCounts, groupCounts, groupSizes, groupDups };
}

/** 收集提示词节点入边的图片节点（纯函数：图片组递归展开，visited 防环）。
 *  运行前锁定参考图集合，画布后续编辑不影响本次运行。 */
export function collectIncomingImages(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  promptNodeId: string,
): WorkflowNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const images: WorkflowNode[] = [];
  const visited = new Set<string>([promptNodeId]);
  const stack: string[] = edges
    .filter((e) => e.target === promptNodeId)
    .map((e) => e.source);
  while (stack.length) {
    const sid = stack.pop()!;
    if (visited.has(sid)) continue;
    visited.add(sid);
    const node = byId.get(sid);
    if (!node) continue;
    if (node.type === "image") {
      images.push(node);
    } else if (node.type === "group") {
      // 分组：递归收集其入边（image 或嵌套 group）
      edges.filter((e) => e.target === sid).forEach((e) => stack.push(e.source));
    }
  }
  return images;
}

/** 按提示词里的 `@` 引用过滤参考图；无引用时退回沿入边全收集（保持旧行为）。
 *  候选池 = 入边可达的图片 —— 引用一张没连线的图等于绕过画布连线直接传图，不允许。
 *  `mode === "invalid"` 时也返回能对上的那些 + `unknown`，是否中止由调用方决定（纯函数不抛）。 */
export function collectPromptRefImages(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  promptNodeId: string,
  promptText: string,
): { images: WorkflowNode[]; unknown: string[]; mode: "all" | "explicit" | "invalid" } {
  const incoming = collectIncomingImages(nodes, edges, promptNodeId);
  const candidates: PromptRefCandidate[] = incoming.map((node) => ({
    id: node.id,
    name: node.type === "image" ? node.data.name : "",
  }));
  const resolution = resolvePromptRefs(promptText, candidates);
  if (resolution.mode === "all") return { images: incoming, unknown: [], mode: "all" };
  // explicit / invalid：都按引用出现顺序挑图，invalid 的 unknown 交给调用方报错
  const byId = new Map(incoming.map((node) => [node.id, node]));
  const images: WorkflowNode[] = [];
  for (const id of resolution.ids) {
    const node = byId.get(id);
    if (node) images.push(node);
  }
  return { images, unknown: resolution.unknown, mode: resolution.mode };
}

/** 提示词节点的入边图片绝对路径快照（纯函数：运行前锁定参考图集合，画布后续编辑不影响本次运行）。
 *  缺失（无 absPath）的图片自动跳过——是否缺失由 collectIncomingImages 另行判定。 */
export function snapshotIncomingAbsPaths(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  promptNodeId: string,
): string[] {
  return collectIncomingImages(nodes, edges, promptNodeId)
    .map((n) => (n.type === "image" ? n.data.absPath : undefined))
    .filter((p): p is string => Boolean(p));
}

/** 自动连线的可变状态：{@link addAutoEdge} 是唯一写入口 */
interface AutoConnectState {
  next: WorkflowEdge[];
  pairs: Set<string>;
  connected: Set<string>;
}

/** 两节点位置的平方距离（只用于比较远近，不开方） */
function edgeDistanceSq(a: WorkflowNode, b: WorkflowNode): number {
  const dx = a.position.x - b.position.x;
  const dy = a.position.y - b.position.y;
  return dx * dx + dy * dy;
}

/** 候选里离 node 最近的一个（候选为空返回 null） */
function nearestNode(node: WorkflowNode, candidates: WorkflowNode[]): WorkflowNode | null {
  return candidates.reduce<WorkflowNode | null>((closest, candidate) => (
    !closest || edgeDistanceSq(node, candidate) < edgeDistanceSq(node, closest) ? candidate : closest
  ), null);
}

/** 加一条边：同 source->target 已存在则跳过；成功时同步去重表与连通表 */
function addAutoEdge(state: AutoConnectState, source: WorkflowNode, target: WorkflowNode): void {
  const id = `${source.id}->${target.id}`;
  if (state.pairs.has(id)) return;
  state.next.push({ id, source: source.id, target: target.id });
  state.pairs.add(id);
  state.connected.add(source.id);
}

// 图片优先归入就近的图片组（否则直接连提示词）。
function connectOrphanImages(
  state: AutoConnectState,
  nodes: WorkflowNode[],
  prompts: WorkflowNode[],
  groups: WorkflowNode[],
): void {
  for (const image of nodes.filter((node) => node.type === "image" && !state.connected.has(node.id))) {
    const prompt = nearestNode(image, prompts);
    if (prompt && image.position.y > prompt.position.y) {
      addAutoEdge(state, prompt, image);
      continue;
    }
    const nearbyGroup = nearestNode(image, groups.filter((group) => group.position.y >= image.position.y));
    if (nearbyGroup && (!prompt || edgeDistanceSq(image, nearbyGroup) < edgeDistanceSq(image, prompt))) {
      addAutoEdge(state, image, nearbyGroup);
    } else if (prompt) {
      addAutoEdge(state, image, prompt);
    }
  }
}

// 最后把仍孤立的图片组连接到最近的提示词。
function connectOrphanGroups(
  state: AutoConnectState,
  groups: WorkflowNode[],
  prompts: WorkflowNode[],
  promptIds: ReadonlySet<string>,
): void {
  for (const group of groups) {
    const hasPromptConnection = state.next.some(
      (edge) => edge.source === group.id && promptIds.has(edge.target),
    );
    if (!hasPromptConnection) {
      const prompt = nearestNode(group, prompts);
      if (prompt) addAutoEdge(state, group, prompt);
    }
  }
}

// 已有图片组可以复用：每张新提示词卡片都应获得一个参考来源。
function ensurePromptReferences(
  state: AutoConnectState,
  prompts: WorkflowNode[],
  groups: WorkflowNode[],
  nodeById: ReadonlyMap<string, WorkflowNode>,
): void {
  const populatedGroups = groups.filter((group) => state.next.some(
    (edge) => edge.target === group.id && nodeById.get(edge.source)?.type === "image",
  ));
  const referenceGroups = populatedGroups.length ? populatedGroups : groups;
  for (const prompt of prompts) {
    const hasReference = state.next.some((edge) => {
      const sourceType = nodeById.get(edge.source)?.type;
      return edge.target === prompt.id && (sourceType === "image" || sourceType === "group");
    });
    if (hasReference) continue;
    const group = nearestNode(prompt, referenceGroups);
    if (group) addAutoEdge(state, group, prompt);
  }
}

/** 自动补齐明显的连线：只处理孤立节点，已有连线保持不动。 */
export function autoConnect(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowEdge[] {
  const prompts = nodes.filter((node) => node.type === "prompt");
  const groups = nodes.filter((node) => node.type === "group");
  if (!prompts.length && !groups.length) return edges;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const promptIds = new Set(prompts.map((prompt) => prompt.id));
  const state: AutoConnectState = {
    next: [...edges],
    connected: new Set(edges.flatMap((edge) => [edge.source, edge.target])),
    pairs: new Set(edges.map((edge) => `${edge.source}->${edge.target}`)),
  };

  connectOrphanImages(state, nodes, prompts, groups);
  connectOrphanGroups(state, groups, prompts, promptIds);
  ensurePromptReferences(state, prompts, groups, nodeById);
  return state.next;
}

/** 自动连线（仅选中）：只对选中节点之间的孤立关系自动补边——候选与新增边两端均限定在选中集合内，
 *  未选中节点的既有连线与孤立状态不受影响。selectedIds 为空时原样返回。 */
export function autoConnectSelection(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  selectedIds: ReadonlySet<string>,
): WorkflowEdge[] {
  if (!selectedIds.size) return edges;
  const selected = nodes.filter((node) => selectedIds.has(node.id));
  if (!selected.length) return edges;
  return autoConnect(selected, edges);
}

/** 把一次提交图快照合并进现有画布（Phase B 统一导入，纯函数不改入参）。
 *  图片节点按 registryId 去重复用现有节点；提示词/图片组节点用提交命名空间 id 追加；
 *  边按实际落点映射。落点压在现有内容下方，横向排开。 */
export function mergeSubmissionGraph(
  subNodes: WorkflowNode[],
  subEdges: WorkflowEdge[],
  existing: WorkflowNode[],
  existingEdges: WorkflowEdge[],
  submissionId: string,
): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  const idMap = new Map<string, string>();
  const seenRegistry = new Set<string>();
  const added: WorkflowNode[] = [];
  for (const n of existing) {
    if (n.type === "image") seenRegistry.add(n.data.registryId);
  }
  const maxY = existing.reduce((m, n) => Math.max(m, n.position.y), 0);
  const baseX = existing.length ? existing.reduce((m, n) => Math.min(m, n.position.x), 0) : 0;
  let col = 0;
  for (const n of subNodes) {
    if (n.type === "image") {
      const rid = n.data.registryId;
      const reused = existing.find((x) => x.type === "image" && x.data.registryId === rid);
      if (reused) {
        idMap.set(n.id, reused.id);
        continue;
      }
      if (seenRegistry.has(rid)) continue;
      seenRegistry.add(rid);
      const newId = `img-${rid}`;
      idMap.set(n.id, newId);
      added.push({ ...n, id: newId, position: { x: baseX + col * 40, y: maxY + 80 } });
      col += 1;
    } else {
      const newId = `${n.id}-import-${submissionId}`;
      idMap.set(n.id, newId);
      added.push({ ...n, id: newId, position: { x: baseX + col * 40, y: maxY + 80 } });
      col += 1;
    }
  }
  const edges: WorkflowEdge[] = [];
  for (const e of subEdges) {
    const source = idMap.get(e.source);
    const target = idMap.get(e.target);
    if (!source || !target) continue;
    edges.push({ ...e, id: `${source}->${target}`, source, target });
  }
  return { nodes: [...existing, ...added], edges: [...existingEdges, ...edges] };
}

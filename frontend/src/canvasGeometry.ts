/**
 * 画布几何纯函数：节点包围盒、拖拽入组、组成员收集、分组包裹矩形、聚焦视口。
 *
 * 移植自 basketikun/infinite-canvas（MIT License），语义重写为 imagora 纯函数：
 * 原 `web/src/lib/canvas/canvas-node-geometry.ts` 直接吃 `CanvasNodeData`（宽高必填、
 * 分组关系写在 `metadata.groupId` 里）。这里只依赖 `NodeBox` 这个最小形状 ——
 * 宽高可缺省（缺省按 0 计），分组关系由调用方通过 `groupIdOf` 回调注入，
 * 于是本模块不 import 任何项目类型、不碰 DOM、不读 store，可以单独单测。
 *
 * 坐标约定：`position` 是节点左上角的世界坐标；`Rect` 用 left/top/right/bottom
 * 而不是 x/y/width/height，调用方要贴边时不必再自己算一次 right/bottom。
 * 所有函数都是纯的：只读入参，不修改数组 / 集合，返回值全是新对象。
 */

/** 世界坐标点（画布缩放前的逻辑坐标） */
export interface Point {
  x: number;
  y: number;
}

/** 宽高（视口尺寸或节点尺寸） */
export interface Size {
  width: number;
  height: number;
}

/** 轴对齐矩形（左 / 上 / 右 / 下边界，含边界） */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 几何计算需要的最小节点形状；`type` / `width` / `height` 都可缺省 */
export interface NodeBox {
  id: string;
  type?: string;
  position: Point;
  width?: number;
  height?: number;
}

/** 视口变换：世界坐标乘 `k` 再加 `x` / `y` 得到屏幕坐标 */
export interface ViewportTransform {
  x: number;
  y: number;
  k: number;
}

/** 聚焦时要让出的屏幕空间：节点上方浮层、下方浮层、以及底部常驻 dock */
export interface FrameInsets {
  above: number;
  below: number;
  bottomInset: number;
}

/** 分组包裹矩形在成员包围盒四周的留白 */
export const GROUP_WRAP_PADDING = 24;

/** 分组包裹矩形顶部额外多留的高度（给分组顶部工具栏腾位置，按钮不压成员） */
export const GROUP_WRAP_TOP_PADDING = 52;

/** 聚焦时节点最多占视口宽 / 高的比例 */
export const FOCUS_MAX_VIEWPORT_RATIO = 0.6;

/** 聚焦缩放下限（再小的节点也不缩到看不见） */
export const FOCUS_MIN_ZOOM = 0.05;

/** 聚焦缩放上限（再小的节点也不放大到糊） */
export const FOCUS_MAX_ZOOM = 1;

/** 分组节点的 type 标记；imagora 的节点数据里 `type` 是普通字符串 */
const GROUP_NODE_TYPE = "group";

/** 数值夹紧；NaN 按下限处理（拖拽 / 尺寸数据异常时不抛错） */
function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(Math.max(value, min), max);
}

/** 节点宽 / 高，缺省按 0 计（与 `position` 组成一个可能退化的盒） */
function widthOf(node: NodeBox): number {
  return node.width ?? 0;
}

function heightOf(node: NodeBox): number {
  return node.height ?? 0;
}

/**
 * 一组节点的包围盒。
 *
 * 空数组返回 `{left:0, top:0, right:0, bottom:0}` 这个退化盒 —— 不能把 `±Infinity`
 * 的初值直接返回出去，否则调用方算出来的 x / width 全是 Infinity 或 NaN。
 */
export function nodeBounds(nodes: readonly NodeBox[]): Rect {
  if (nodes.length === 0) return { left: 0, top: 0, right: 0, bottom: 0 };
  return nodes.reduce<Rect>(
    (acc, node) => ({
      left: Math.min(acc.left, node.position.x),
      top: Math.min(acc.top, node.position.y),
      right: Math.max(acc.right, node.position.x + widthOf(node)),
      bottom: Math.max(acc.bottom, node.position.y + heightOf(node)),
    }),
    { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
  );
}

/**
 * 节点中心点是否落在 group 矩形内（含边界）。
 *
 * 判的是**中心点**而不是「整体包含」：整体包含会让大节点永远拖不进小组
 * （大节点的盒吞得下 group，但中心点未必在 group 里）。
 */
export function containsCenter(group: NodeBox, node: NodeBox): boolean {
  const centerX = node.position.x + widthOf(node) / 2;
  const centerY = node.position.y + heightOf(node) / 2;
  const left = group.position.x;
  const top = group.position.y;
  return (
    centerX >= left &&
    centerX <= left + widthOf(group) &&
    centerY >= top &&
    centerY <= top + heightOf(group)
  );
}

/**
 * 拖拽过程中找「松手该落进哪个 group」，找不到返回 `null`。
 *
 * 三条约束：
 * - 被拖集合里只要含 group 就直接 `null`：imagora 不支持组嵌套组；
 * - 只考虑 `type === "group"` 且自己没被拖的节点；
 * - 倒序遍历 nodes 而不是 copy + reverse —— 这个函数每帧拖拽都跑，
 *   且后出现的 group 在视觉上压在上层，重叠时优先命中它。
 */
export function findGroupDropTarget(
  movedIds: ReadonlySet<string>,
  nodes: readonly NodeBox[],
): NodeBox | null {
  if (nodes.some((node) => movedIds.has(node.id) && node.type === GROUP_NODE_TYPE)) return null;
  const movingNodes = nodes.filter(
    (node) => movedIds.has(node.id) && node.type !== GROUP_NODE_TYPE,
  );
  if (movingNodes.length === 0) return null;
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const group = nodes[index];
    if (group === undefined) continue;
    if (group.type !== GROUP_NODE_TYPE || movedIds.has(group.id)) continue;
    if (movingNodes.some((node) => containsCenter(group, node))) return group;
  }
  return null;
}

/**
 * 算出把被拖节点整体平移进 group 内缩区的位移（不修改任何输入，只返回 dx / dy）。
 *
 * 内缩区 = group 矩形四边各收 `GROUP_WRAP_PADDING`。整体比内缩区还宽时只能贴左
 * （先保证左边界不出界，右边溢出由 group 宽度本身承载）；否则左出界贴左、右出界贴右、
 * 都在界内则不动。竖向同理。这样拖进来的节点不会被塞到 group 外面去。
 */
export function snapNodesIntoGroup(
  movedIds: ReadonlySet<string>,
  nodes: readonly NodeBox[],
  group: NodeBox,
): { dx: number; dy: number } {
  const movingNodes = nodes.filter(
    (node) => movedIds.has(node.id) && node.type !== GROUP_NODE_TYPE,
  );
  if (movingNodes.length === 0) return { dx: 0, dy: 0 };
  const bounds = nodeBounds(movingNodes);
  const left = group.position.x + GROUP_WRAP_PADDING;
  const top = group.position.y + GROUP_WRAP_PADDING;
  const right = group.position.x + widthOf(group) - GROUP_WRAP_PADDING;
  const bottom = group.position.y + heightOf(group) - GROUP_WRAP_PADDING;
  const dx =
    bounds.right - bounds.left > right - left || bounds.left < left
      ? left - bounds.left
      : bounds.right > right
        ? right - bounds.right
        : 0;
  const dy =
    bounds.bottom - bounds.top > bottom - top || bounds.top < top
      ? top - bounds.top
      : bounds.bottom > bottom
        ? bottom - bounds.bottom
        : 0;
  return { dx, dy };
}

/**
 * 把选中集合展开成「真正要处理的节点」：选中的 group 换成它的全部成员。
 *
 * `groupIdOf` 由调用方注入（imagora 的组关系不在节点里，避免这里耦合数据模型）。
 * 结果按 nodes 原序、天然去重 —— 直接按 nodes 过滤，group 和成员同时被选中也只出现一次；
 * group 节点本身不会出现在结果里（它只是容器，尺寸不参与成员的包围盒计算）。
 */
export function collectGroupMemberNodes(
  selectedIds: readonly string[],
  nodes: readonly NodeBox[],
  groupIdOf: (node: NodeBox) => string | undefined,
): NodeBox[] {
  const selected = new Set(selectedIds);
  const selectedGroupIds = new Set(
    nodes
      .filter((node) => node.type === GROUP_NODE_TYPE && selected.has(node.id))
      .map((node) => node.id),
  );
  return nodes.filter((node) => {
    if (node.type === GROUP_NODE_TYPE) return false;
    if (selected.has(node.id)) return true;
    const groupId = groupIdOf(node);
    return groupId !== undefined && selectedGroupIds.has(groupId);
  });
}

/**
 * 分组节点的包裹矩形：成员包围盒外扩 `GROUP_WRAP_PADDING`，
 * **顶部额外多留 `GROUP_WRAP_TOP_PADDING`** 给分组工具栏腾位置。
 *
 * 顶部和底部留白故意不等：上方要放按钮条，下方只是呼吸位。
 */
export function getGroupWrapRect(members: readonly NodeBox[]): Rect {
  const bounds = nodeBounds(members);
  return {
    left: bounds.left - GROUP_WRAP_PADDING,
    top: bounds.top - GROUP_WRAP_TOP_PADDING,
    right: bounds.right + GROUP_WRAP_PADDING,
    bottom: bounds.bottom + GROUP_WRAP_PADDING,
  };
}

/**
 * 聚焦某个节点（分组）时的视口变换：把「上浮层 + 节点 + 下浮层」这一整块塞进可用区域。
 *
 * 缩放取三个约束里最小的一个：节点不超过视口宽的 60%、不超过视口高的 60%、
 * 不超过竖向剩余空间（可用高 × 0.92 扣掉上下浮层），再夹到 [0.05, 1]。
 *
 * 竖向落位把三件套当成一个整体块 `blockHeight`：`slack` 是块之外剩下的高，
 * 无下浮层时上下各分一半；有下浮层时按 3:1 分（上方拿 0.75），块因此整体下移、
 * 下浮层面板贴近底部 dock 而不是悬在半空。
 * `y` 末项的 `-(below - above) / 2` 把「块心」换算成「节点心」。
 *
 * 注意 `blockHeight` 必须含 `above` / `below`（原版即如此）：若只写 `height * k`，
 * 节点顶边会向上侵入 `above` 预留带 `(above + below) / 2` 像素，被悬停工具栏压住。
 * `focusViewportForNode` 的单测里有一条专门钉这个不变式。
 *
 * 宽 / 高缺失、非正、NaN 时没有可缩放的东西：返回 `{x:0, y:0, k:1}`，绝不产出 Infinity。
 */
export function focusViewportForNode(
  node: NodeBox,
  size: Size,
  frame: FrameInsets,
): ViewportTransform {
  const width = widthOf(node);
  const height = heightOf(node);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    return { x: 0, y: 0, k: 1 };
  }
  const usableBottom = Math.max(0, size.height - frame.bottomInset);
  const verticalRoom = usableBottom * 0.92 - frame.above - frame.below;
  const k = clamp(
    Math.min(
      (size.width * FOCUS_MAX_VIEWPORT_RATIO) / width,
      (size.height * FOCUS_MAX_VIEWPORT_RATIO) / height,
      verticalRoom / height,
    ),
    FOCUS_MIN_ZOOM,
    FOCUS_MAX_ZOOM,
  );
  const blockHeight = frame.above + height * k + frame.below;
  const slack = usableBottom - blockHeight;
  const blockTop = slack * (frame.below > 0 && slack > 0 ? 0.75 : 0.5);
  const centerX = node.position.x + width / 2;
  const centerY = node.position.y + height / 2;
  return {
    x: size.width / 2 - centerX * k,
    y: blockTop + blockHeight / 2 - centerY * k - (frame.below - frame.above) / 2,
    k,
  };
}

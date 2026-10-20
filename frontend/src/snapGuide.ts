/**
 * 拖拽吸附纯函数：邻居对齐线吸附（`snapToNeighbors`）+ 网格兜底（`snapToGrid`）。
 *
 * 对齐吸附语义参考 basketikun/infinite-canvas（MIT License），纯函数重写：
 * 原实现把吸附逻辑揉进画布 store 的拖拽回调里，这里剥成不 import 任何项目类型、
 * 不碰 DOM / canvas / store 的两个函数 —— 可以单独单测，也能被任意拖拽实现复用。
 *
 * 四条必须守住的语义（这两个函数每帧拖拽都跑，写错就是整块画布手感崩）：
 * - x 与 y **各自独立决策**：只吸到一个轴时另一个轴原样返回，不是「两轴都命中才吸」；
 * - 阈值比较是严格 `<`：距离正好等于阈值不吸附（边界留给调用方的死区 / 惯性）；
 * - 找不到邻居就原样返回，**不自动退回网格** —— 要不要退化由调用方决定，
 *   `snapToGrid` 是另一个独立函数，不是 `snapToNeighbors` 的兜底分支；
 * - 非法输入（NaN / Infinity / 阈值或步长非正）一律安全退化成「原坐标 + 空 guides」，
 *   绝不抛错：拖拽是每帧调用，抛一次错就整块画布白屏。
 */

/** 参与吸附判定的矩形：世界坐标左上角 + 宽高 */
export interface SnapBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 一条真正生效的对齐线（只有发生了位移的轴才会出现） */
export interface SnapGuide {
  axis: "x" | "y";
  /** 吸附后该轴应对齐到的画布坐标 */
  position: number;
  /** 参与对齐的对方节点 id */
  targetId: string;
}

/** 吸附结果：建议的新坐标 + 需要画出来的对齐线（每轴最多一条） */
export interface SnapResult {
  x: number;
  y: number;
  guides: SnapGuide[];
}

/** 邻居吸附的默认阈值（像素）：距离**小于**它才吸 */
export const SNAP_THRESHOLD = 6;

/** 网格吸附的默认步长（像素） */
export const SNAP_STEP_GRID = 8;

/** 三个对齐候选在盒内的相对位置：0 = 左/上边缘，0.5 = 中心，1 = 右/下边缘 */
const EDGE_RATIOS = [0, 0.5, 1] as const;

/** 单个轴上的最佳吸附候选 */
interface AxisSnap {
  /** 要施加到该轴坐标上的位移 */
  delta: number;
  /** 对齐后该轴的画布坐标（= 对方那条线的位置） */
  position: number;
  targetId: string;
}

/** 盒在某个轴上的第 `ratio` 条对齐线坐标（左/中/右 或 上/中/下） */
function edgeAt(box: SnapBox, axis: "x" | "y", ratio: number): number {
  const origin = axis === "x" ? box.x : box.y;
  const size = axis === "x" ? box.width : box.height;
  return origin + size * ratio;
}

/**
 * 盒的坐标与宽高是否都是有限数。
 *
 * 只要有一个是 NaN / Infinity，它所在轴的整条对齐线就不可信（中心与对边会被污染），
 * 所以按「整个调用退化」处理，而不是只丢那一个轴 —— 退化的语义必须是可预期的。
 */
function isUsableBox(box: SnapBox): boolean {
  return (
    Number.isFinite(box.x) &&
    Number.isFinite(box.y) &&
    Number.isFinite(box.width) &&
    Number.isFinite(box.height)
  );
}

/**
 * 在单个轴上找最近的吸附目标；找不到返回 `null`。
 *
 * 拿 moving 的 3 条线分别与每个 other 的 3 条线比差（共 9 组），
 * 取 `|diff|` 最小且**严格小于** `threshold` 的那个。并列时保留先遇到的
 * （others 数组顺序 → 对方线序 边缘/中心/对边 → 自己线序 边缘/中心/对边），
 * 于是同样的输入永远给同样的结果，不会因为遍历细节抖动。
 *
 * 两个防御，都不是「多写的分支」而是真实会踩的坑：
 * - `other.id === moving.id` 直接跳过：调用方很可能把整份节点数组传进来，
 *   自己跟自己比差值恒为 0，会冒出一条指向自己的假 guide；
 * - 邻居里夹着非法数据只跳过那一个，不连坐 —— 坏节点不该让整次拖拽失去吸附。
 */
function findAxisSnap(
  moving: SnapBox,
  others: readonly SnapBox[],
  axis: "x" | "y",
  threshold: number,
): AxisSnap | null {
  const movingLines = EDGE_RATIOS.map((ratio) => edgeAt(moving, axis, ratio));
  let best: AxisSnap | null = null;
  let bestDistance = Infinity;
  // 用索引遍历而不是 for-of：这个函数每帧拖拽都跑，省掉迭代器；下标在
  // `noUncheckedIndexedAccess` 下是 `T | undefined`，必须先收窄再用。
  for (let index = 0; index < others.length; index += 1) {
    const other = others[index];
    if (other === undefined) continue;
    if (other.id === moving.id) continue;
    if (!isUsableBox(other)) continue;
    for (let otherRatio = 0; otherRatio < EDGE_RATIOS.length; otherRatio += 1) {
      const ratio = EDGE_RATIOS[otherRatio];
      if (ratio === undefined) continue;
      const target = edgeAt(other, axis, ratio);
      for (let movingRatio = 0; movingRatio < movingLines.length; movingRatio += 1) {
        const line = movingLines[movingRatio];
        if (line === undefined) continue;
        const delta = target - line;
        const distance = Math.abs(delta);
        if (distance >= threshold || distance >= bestDistance) continue;
        bestDistance = distance;
        best = { delta, position: target, targetId: other.id };
      }
    }
  }
  return best;
}

/**
 * 从被拖节点与其它节点的三对齐线（左/中/右、上/中/下）里找最近的吸附目标。
 *
 * 两个轴分别跑一遍 `findAxisSnap`，因此**可能只吸一个轴**：另一个轴保持原值，
 * 也不出 guide（guide 只画真正生效的那条线）。`others` 为空或全部超出阈值时
 * 原样返回 `x` / `y` —— 这里刻意不退回网格吸附，退化时机归调用方管。
 *
 * 返回的 `x` / `y` 允许是浮点（只加位移，不做 round）；`guides` 顺序固定为 x 在前。
 */
export function snapToNeighbors(
  moving: SnapBox,
  others: readonly SnapBox[],
  threshold: number = SNAP_THRESHOLD,
): SnapResult {
  const fallback: SnapResult = { x: moving.x, y: moving.y, guides: [] };
  if (!isUsableBox(moving)) return fallback;
  if (!Number.isFinite(threshold) || threshold <= 0) return fallback;

  const snapX = findAxisSnap(moving, others, "x", threshold);
  const snapY = findAxisSnap(moving, others, "y", threshold);

  const guides: SnapGuide[] = [];
  if (snapX !== null) {
    guides.push({ axis: "x", position: snapX.position, targetId: snapX.targetId });
  }
  if (snapY !== null) {
    guides.push({ axis: "y", position: snapY.position, targetId: snapY.targetId });
  }

  return {
    x: snapX === null ? moving.x : moving.x + snapX.delta,
    y: snapY === null ? moving.y : moving.y + snapY.delta,
    guides,
  };
}

/**
 * 没有邻居可吸附时退化为网格吸附（默认 8px 栅格），坐标对齐到栅格后返回。
 *
 * `guides` 恒为 `[]`：网格吸附不画对齐线（网格本身已经给出视觉参考）。
 * 只动 `x` / `y`，`width` / `height` 不参与 —— 网格对齐的是节点左上角。
 *
 * 两个细节：
 * - `Math.round(-0.5)` 得到 `-0`，`-0 * step` 仍是 `-0`；这里把 `-0` 归一成 `0`，
 *   免得负坐标附近算出来的坐标带个负零（`Object.is(-0, 0)` 为假，容易在别处炸断言）。
 * - 步长合法但除出来溢出成 Infinity 时（如 `x = 1e308, step = 1e-10`）也退回原值：
 *   有限输入不该产出无限坐标，那会让节点直接飞出画布。
 */
export function snapToGrid(moving: SnapBox, step: number = SNAP_STEP_GRID): SnapResult {
  const fallback: SnapResult = { x: moving.x, y: moving.y, guides: [] };
  if (!Number.isFinite(step) || step <= 0) return fallback;
  if (!Number.isFinite(moving.x) || !Number.isFinite(moving.y)) return fallback;
  const x = Math.round(moving.x / step) * step;
  const y = Math.round(moving.y / step) * step;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return fallback;
  return { x: x === 0 ? 0 : x, y: y === 0 ? 0 : y, guides: [] };
}

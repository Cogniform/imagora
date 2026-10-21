/**
 * 连线（edge）样式纯函数：把「鼠标悬停 / 被选中 / 因选中节点而降权」翻译成 React Flow 的 inline style。
 *
 * 要解决的问题：画布上的连线原本没有任何 hover 反馈 —— 鼠标移到线上时线不变粗也不变色，
 * 用户看不出「这条线是可以点选、可以删掉的」，甚至会以为画布是只读的；选中一条线之后同样
 * 缺少视觉确认。反过来，选中一个节点时满屏连线一样重，看不出这个节点到底连着谁。
 * 本模块给出四态（idle / hovered / selected / dimmed）的描边色、线宽、透明度与是否流动。
 *
 * 为什么拆成纯函数：这些判定全是「输入 → 输出」的纯映射，跟 React、DOM、React Flow 都无关。
 * 剥出来之后可以单测覆盖全部组合（尤其是「selected 优先于 hovered」这种容易写反的规则），
 * UI 层（CanvasPage）只负责把 hovered / selected / 是否降权三个布尔值传进来，不再散落样式魔法数。
 * 因此本文件不 import 任何 React / React Flow / 项目类型，也不读写 DOM。
 *
 * 颜色 token：全部取 index.css 里真实存在的 CSS 变量，TS 里不写死任何十六进制 ——
 * 亮暗两套取值（:root / body[data-ds-dark-theme]）由 CSS 负责切换，TS 只认变量名。
 */

/**
 * 连线的视觉状态：
 * - idle：静默（没有悬停、没有选中、也没有因选中节点而降权）；
 * - hovered：鼠标悬停；
 * - selected：被选中（Delete / Backspace 删的就是它）；
 * - dimmed：视觉降权 —— 用户选中了某些节点，这条线与它们无关，淡出以免干扰视线。
 *   dimmed 只是降权，不是删除：连线仍在图上，仍可点选、仍可双击删除。
 */
export type EdgeVisualState = "idle" | "hovered" | "selected" | "dimmed";

/** 一条连线在某状态下的完整外观；animated 直接对应 React Flow 的 edge.animated（流动动画） */
export interface EdgeStyle {
  stroke: string;
  strokeWidth: number;
  opacity: number;
  animated: boolean;
}

/** 静默 / 降权态的线宽（像素）：细到不抢节点的视觉权重，但仍看得清走向 */
export const EDGE_WIDTH_IDLE = 1.5;

/** 悬停 / 选中态的线宽（像素）：比 idle 粗 1px，鼠标扫过时能立刻看出「这条线被指到了」 */
export const EDGE_WIDTH_ACTIVE = 2.5;

/** 降权态透明度：淡到几乎退成背景纹理，但仍能看出两个节点之间有线 */
export const EDGE_OPACITY_DIMMED = 0.25;

/**
 * 连线三态描边色 token。
 * 亮暗两套值都在 index.css 里给出，这里只引用变量名，不写死颜色。
 */
export const EDGE_STROKE_IDLE = "var(--edge-stroke-idle)";
export const EDGE_STROKE_HOVERED = "var(--edge-stroke-hovered)";
export const EDGE_STROKE_SELECTED = "var(--edge-stroke-selected)";

/**
 * 四态 → 外观的查表。用 Record 而不是数组下标，`noUncheckedIndexedAccess` 下无需额外收窄。
 *
 * 为什么 dimmed 的 animated 是 false：降权态的线已经淡到 0.25 透明度，如果还在跑流动动画，
 * 满屏几十条淡线一起流动反而比不降权更吵 —— 降权的目的就是「让无关的东西安静下来」。
 */
const VISUAL_STYLE: Record<EdgeVisualState, EdgeStyle> = {
  idle: { stroke: EDGE_STROKE_IDLE, strokeWidth: EDGE_WIDTH_IDLE, opacity: 1, animated: true },
  hovered: { stroke: EDGE_STROKE_HOVERED, strokeWidth: EDGE_WIDTH_ACTIVE, opacity: 1, animated: true },
  selected: { stroke: EDGE_STROKE_SELECTED, strokeWidth: EDGE_WIDTH_ACTIVE, opacity: 1, animated: true },
  dimmed: {
    stroke: EDGE_STROKE_IDLE,
    strokeWidth: EDGE_WIDTH_IDLE,
    opacity: EDGE_OPACITY_DIMMED,
    animated: false,
  },
};

/** edgeVisualState 的入参 */
export interface EdgeVisualStateInput {
  /** 这条线是否被鼠标悬停 */
  hovered: boolean;
  /** 这条线是否被选中 */
  selected: boolean;
  /**
   * 这条线是否「因当前选中状态而该降权」。
   *
   * 注意语义：不是「画布上存在选中」，而是「这一条线要淡出」。调用方应传入
   * `dimmedEdgeIds(...).includes(edge.id)` 的结果 —— 只有两端都与选中节点无关的线才该淡出，
   * 一端连着选中节点的线必须保持正常亮度，否则「看清这个节点连着谁」的目的就落空了。
   */
  hasSelection: boolean;
}

/**
 * 从三个布尔值判定视觉状态，优先级：selected > hovered > (hasSelection ? dimmed : idle)。
 *
 * 为什么 selected 优先于 hovered：选中是「持久」状态，hover 是「瞬时」状态。如果 hover 覆盖
 * selected，用户点中一条线后鼠标一移开，线就会从选中色降级成 hover 色、再降级成 idle 色，
 * 让人怀疑「到底选中了没有」，Delete 键按下去也不知道会删掉什么。
 *
 * 为什么 hovered 优先于 dimmed：降权是背景处理，用户的鼠标已经明确指到这条线上了，
 * 此刻它就该亮起来 —— 否则会出现「能指到、能点，但永远是灰的」的死角。
 */
export function edgeVisualState(input: EdgeVisualStateInput): EdgeVisualState {
  if (input.selected) return "selected";
  if (input.hovered) return "hovered";
  if (input.hasSelection) return "dimmed";
  return "idle";
}

/**
 * 状态 → 外观。返回新对象（不是查表里的引用），调用方可以放心改写返回值而不会污染全局表。
 */
export function edgeStyle(state: EdgeVisualState): EdgeStyle {
  const base = VISUAL_STYLE[state];
  return { stroke: base.stroke, strokeWidth: base.strokeWidth, opacity: base.opacity, animated: base.animated };
}

/**
 * 算出「该降权的连线 id」：两端都不在 selectedNodeIds 里的连线。
 *
 * 为什么是「两端都不在」而不是「任一端不在」：用户选中一个提示词节点时，想看的是
 * 「它连着哪些图片」—— 这些线的另一端没被选中，但必须保持正常亮度；只有跟它毫无关系的线
 * 才该淡出。按「任一端不在」判定会把要看的那几条也一起淡掉，等于把功能做反。
 *
 * 没有选中任何节点时返回空数组（没有任何理由降权），调用方据此跳过整轮样式重算。
 */
export function dimmedEdgeIds(
  edges: readonly { id: string; source: string; target: string }[],
  selectedNodeIds: readonly string[],
): string[] {
  if (selectedNodeIds.length === 0) return [];
  const selected = new Set(selectedNodeIds);
  const ids: string[] = [];
  for (const edge of edges) {
    if (!selected.has(edge.source) && !selected.has(edge.target)) ids.push(edge.id);
  }
  return ids;
}

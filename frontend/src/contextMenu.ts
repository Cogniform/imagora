/**
 * 画布节点右键菜单的**纯逻辑**：菜单项怎么排、贴哪儿、多高、哪些键该关掉它。
 *
 * 这里刻意不碰 DOM、不碰 React —— 菜单的「内容」和「位置算术」是最容易被改错的两块
 * （少一项、顺序错、菜单从视口右边缘露出去），把它们做成纯函数才能在单测里逐条钉住。
 * 渲染与事件绑定在 `components/NodeContextMenu.tsx`。
 *
 * ## 为什么菜单项要按节点类型分派
 *
 * 同一个右键动作在不同节点上意义不同：图片节点能裁剪 / 放大 / 切分，提示词节点只能运行，
 * 分组节点只能删。把三者塞进一份通用清单再逐项 disable，用户会看到一堆永远点不亮的项；
 * 全部按类型裁剪又会让「这里还能干什么」不可发现。
 *
 * ## 为什么「图片还没上传」时保留禁用项
 *
 * 图片节点的 URL 是异步来的（上传 / 生成回流）。此时若把预览 / 裁剪 / 放大 / 切分 / 替换
 * 直接从菜单里拿掉，用户只会看到孤零零一条「删除」，合理推断是「这个功能没有」，
 * 而不是「等图到了就有」。所以这些项**保留但 disabled**，菜单同时在教「能做什么」。
 *
 * ## 为什么高度要算而不是写死
 *
 * 菜单高度直接决定 `clampMenuPosition` 的 y 是否要往上翻（贴屏幕底部右键时）。
 * 写死一个数字，加一项就会让菜单从底部溢出去。所以高度必须由 items 推出来。
 */

/** 一条可点的菜单项 */
export interface ContextMenuAction {
  id: string;
  label: string;
  /** 危险动作：删除这类不可撤销的操作，渲染成危险色 */
  danger?: boolean;
  /** 暂不可用：仍显示，但置灰且点了不回调 */
  disabled?: boolean;
}

/** 菜单里的一格：要么是可点项，要么是分隔线 */
export type ContextMenuItem = { kind: "action"; action: ContextMenuAction } | { kind: "separator" };

/** 决定菜单内容的上下文 */
export interface NodeMenuOptions {
  /** 图片节点是否已有图（上传完成 / 生成回流）。非图片节点忽略此项 */
  hasUrl: boolean;
  /** 当前选中的节点数。> 1 时菜单顶部多出「删除所选 N 项」 */
  selectedCount: number;
}

/** 视口坐标点（右键落点 / 菜单左上角） */
export interface MenuPoint {
  x: number;
  y: number;
}

/** 矩形尺寸（菜单自身尺寸 / 视口尺寸共用） */
export interface MenuSize {
  width: number;
  height: number;
}

/** 菜单宽度：固定值，因为项都是短标签，让宽度跟着最长标签跳来跳去反而更乱 */
export const MENU_WIDTH = 200;

/** 菜单与视口边缘的最小间距 */
export const MENU_MARGIN = 8;

/** 单个 action 项的高度（px）。渲染端必须用同一个值，否则菜单底部会被裁 */
export const MENU_ITEM_HEIGHT = 28;

/** 分隔线占位：1px 线 + 上下各 4px 间距。与渲染端的 `h-px my-1` 严格对应 */
const SEPARATOR_HEIGHT = 1 + 2 * 4;

/** 构造一条 action 项。用赋值而非字面量，是因为 exactOptionalPropertyTypes 下
 *  `{ danger: undefined }` 不满足 `danger?: boolean`。 */
function makeAction(
  id: string,
  label: string,
  options: { danger?: boolean; disabled?: boolean } = {},
): ContextMenuItem {
  const action: ContextMenuAction = { id, label };
  if (options.danger) action.danger = true;
  if (options.disabled) action.disabled = true;
  return { kind: "action", action };
}

const SEPARATOR: ContextMenuItem = { kind: "separator" };

/**
 * 按节点类型构造菜单。
 *
 * 动作 id（接线方按 id 分派，不要按 label 匹配 —— label 是给人看的，会改）：
 * - `delete-selection`：删除所有选中节点（仅 selectedCount > 1）
 * - `preview` / `crop` / `upscale` / `split` / `replace`：图片节点
 * - `run` / `copy-prompt`：提示词节点
 * - `delete`：所有类型的单节点删除
 */
export function buildNodeMenu(nodeType: string, opts: NodeMenuOptions): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];

  // 多选时置顶：批量删除是右键多选场景下的主动作，不该埋在底部
  if (opts.selectedCount > 1) {
    items.push(makeAction("delete-selection", `删除所选 ${opts.selectedCount} 项`, { danger: true }));
    items.push(SEPARATOR);
  }

  if (nodeType === "image") {
    // 没图时保留但禁用：直接消失会让用户以为功能不存在
    const disabled = !opts.hasUrl;
    items.push(
      makeAction("preview", "预览大图", { disabled }),
      makeAction("crop", "裁剪", { disabled }),
      makeAction("upscale", "放大", { disabled }),
      makeAction("split", "切分", { disabled }),
      makeAction("replace", "替换图片", { disabled }),
      SEPARATOR,
    );
  } else if (nodeType === "prompt") {
    items.push(makeAction("run", "运行"), makeAction("copy-prompt", "复制提示词"), SEPARATOR);
  }
  // group 与未知类型：只剩删除

  items.push(makeAction("delete", "删除", { danger: true }));
  return items;
}

/**
 * 把菜单左上角夹进视口，右 / 下各留 `margin`。
 *
 * **两侧都要夹**：只夹右下的话，在视口左边缘或上边缘右键，菜单会有一半露到屏幕外
 * —— 用户看到的是一个缺了左半边的菜单。
 *
 * 菜单比视口还大时（极窄窗口），上限退化为 0：贴着左上角显示，至少让第一项可见。
 */
export function clampMenuPosition(
  anchor: MenuPoint,
  size: MenuSize,
  viewport: MenuSize,
  margin: number = MENU_MARGIN,
): MenuPoint {
  const maxX = Math.max(0, viewport.width - size.width - margin);
  const maxY = Math.max(0, viewport.height - size.height - margin);
  return {
    x: Math.min(Math.max(0, anchor.x), maxX),
    y: Math.min(Math.max(0, anchor.y), maxY),
  };
}

/** 菜单总高：action 算一项高度，分隔线算线宽 + 上下间距 */
export function menuHeight(items: readonly ContextMenuItem[]): number {
  return items.reduce(
    (total, item) => total + (item.kind === "action" ? MENU_ITEM_HEIGHT : SEPARATOR_HEIGHT),
    0,
  );
}

/** 该按键是否应关闭菜单（Esc 收起浮层、Tab 移走焦点，两者都该让菜单消失） */
export function isMenuDismissKey(key: string): boolean {
  return key === "Escape" || key === "Tab";
}

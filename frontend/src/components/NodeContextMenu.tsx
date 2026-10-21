import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  MENU_ITEM_HEIGHT,
  MENU_WIDTH,
  clampMenuPosition,
  isMenuDismissKey,
  menuHeight,
  type ContextMenuItem,
  type MenuPoint,
  type MenuSize,
} from "../contextMenu";
import { popPopup, pushPopup } from "../popupLayer";

export interface NodeContextMenuProps {
  /** 右键落点（视口坐标） */
  x: number;
  y: number;
  items: readonly ContextMenuItem[];
  /** 点中某项。禁用的项不会触发 */
  onPick: (actionId: string) => void;
  onClose: () => void;
}

function viewportSize(): MenuSize {
  return { width: window.innerWidth, height: window.innerHeight };
}

/** 菜单左上角：先按**算出来的**高度夹一次，避免首帧就从屏幕底部溢出去 */
function initialPosition(x: number, y: number, items: readonly ContextMenuItem[]): MenuPoint {
  return clampMenuPosition({ x, y }, { width: MENU_WIDTH, height: menuHeight(items) }, viewportSize());
}

/**
 * 画布节点的右键菜单。
 *
 * ## 为什么挂到 body 而不是就地定位
 *
 * 节点卡片自身是 `overflow:hidden` 的滚动容器（图片节点里还有一层可滚动内容），
 * 就地 `absolute` 定位会被裁掉一半。挂到 body 后不受任何祖先裁切 —— 与 `Select` 的
 * 下拉列表同一个理由、同一套做法（`createPortal` + `fixed` + 视口坐标）。
 *
 * ## 为什么要 pushPopup / popPopup
 *
 * `.modal-shell` 的 Esc 监听挂在 **capture 阶段**，比 React 的事件处理先跑。菜单开着时
 * 按 Esc 的意图是「收起菜单」，若不登记为浮层，一次 Esc 会顺手把外层弹窗也关掉
 * （见 `popupLayer.ts` 的说明）。挂载即 push、卸载即 pop，弹窗那边会先问 `hasOpenPopup()`。
 *
 * ## 为什么滚动 / 改窗口尺寸就直接关，而不是跟着重算
 *
 * 画布滚动时节点会跟着走，而右键落点是**视口坐标**、不会跟着变。要么每帧按节点新位置
 * 重算（还得把 React Flow 的 transform 读进来），要么关掉。关掉是用户预期内的行为：
 * 滚轮一动菜单消失，不会出现「菜单浮在原地、跟节点错位」的鬼影。
 *
 * ## 高度为什么要量一次
 *
 * `menuHeight` 是按常量算的（28px/项），但真实行高受字体、缩放、用户浏览器最小字号影响。
 * 挂载后用 `useLayoutEffect` 量一次真实高度并重新夹 y —— 否则贴屏幕底部右键时，
 * 算出来的高度偏小、菜单下半截就出屏了。量不到（jsdom 返回 0）时保持算出来的位置。
 */
export function NodeContextMenu({ x, y, items, onPick, onClose }: NodeContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<MenuPoint>(() => initialPosition(x, y, items));
  /** 悬停高亮：复用 `.select-option.is-active`，不新造 CSS 类 */
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // 登记为「有浮层」：Esc 先给菜单，不会穿透去关外层弹窗
  useEffect(() => {
    pushPopup();
    return () => popPopup();
  }, []);

  // 量一次真实高度再夹：常量高度只是兜底
  useLayoutEffect(() => {
    const height = menuRef.current?.getBoundingClientRect().height ?? 0;
    if (height <= 0) return;
    const next = clampMenuPosition({ x, y }, { width: MENU_WIDTH, height }, viewportSize());
    setPosition((prev) => (prev.x === next.x && prev.y === next.y ? prev : next));
  }, [x, y]);

  useEffect(() => {
    const handlePointerDown = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      // 已经有人消费掉这次按键（例如外层弹窗自己的 Esc 逻辑）就不要再关一遍
      if (event.defaultPrevented) return;
      if (!isMenuDismissKey(event.key)) return;
      onClose();
    };
    const handleViewportChange = () => onClose();

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", handleViewportChange);
    // capture：节点内部的滚动容器滚动也要关，否则菜单会跟节点错位
    window.addEventListener("scroll", handleViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label="节点操作"
      data-testid="node-context-menu"
      data-portal="node-context-menu"
      // .select-list 已是「浮层」角色：var(--surface-float) 底 + 描边 + 圆角 + 阴影 + 4px 内边距
      className="select-list flex flex-col"
      style={{
        position: "fixed",
        left: position.x,
        top: position.y,
        width: MENU_WIDTH,
        zIndex: 1000,
        userSelect: "none",
      }}
    >
      {items.map((item, index) => {
        if (item.kind === "separator") {
          return (
            // h-px + my-1 = 1 + 4 * 2 = 9px，与 contextMenu.ts 的 SEPARATOR_HEIGHT 严格对应
            <div
              key={`separator-${index}`}
              role="separator"
              className="my-1 h-px"
              style={{ background: "color-mix(in srgb, var(--color-brand) 14%, transparent)" }}
            />
          );
        }
        const { action } = item;
        const disabled = action.disabled === true;
        return (
          <button
            key={action.id}
            type="button"
            role="menuitem"
            data-testid={`node-menu-${action.id}`}
            aria-disabled={disabled ? "true" : undefined}
            onClick={() => {
              // 不用原生 disabled：那会让键盘焦点跳过它，而 aria-disabled 才是菜单的标准语义。
              // 因此这里必须自己挡住点击。
              if (disabled) return;
              onPick(action.id);
            }}
            onMouseEnter={() => setHoveredId(action.id)}
            onMouseLeave={() => setHoveredId(null)}
            // .select-option 给排版与圆角；高度必须钉成 MENU_ITEM_HEIGHT，
            // 它的 min-height:34px 会让菜单比 menuHeight() 算出来的更高
            className={`select-option w-full ${hoveredId === action.id ? "is-active" : ""}`}
            style={{
              height: MENU_ITEM_HEIGHT,
              minHeight: 0,
              paddingTop: 0,
              paddingBottom: 0,
              ...(disabled
                ? { color: "rgba(23, 32, 43, 0.38)", cursor: "default" }
                : action.danger
                  ? // 危险色与 .btn-danger / .chip--danger 同源；--color-danger 尚未在 index.css 定义，
                    // 因此带兜底值，将来补上 token 就自动跟随
                    { color: "var(--color-danger, #dc2626)" }
                  : {}),
            }}
          >
            {action.label}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}

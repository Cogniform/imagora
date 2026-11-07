import type { CSSProperties } from "react";

/**
 * 内联图标：画布用到的图形全部画在这个文件里，不依赖图标库。
 *
 * ## 为什么换成内联图标
 *
 * 原版这两处的图标来自 `lucide-react`。维护者同时在维护 DSH 插件版
 * （`dsh-imagora-desk`），两个项目的画布是同一套交互，图标语言必须收敛成一套 ——
 * 否则同一颗「裁剪」按钮在两边是两种笔触，来回切项目就觉得整块界面不像一个产品。
 * 2026-11-07 定下：**以插件版那套内联图标为准**（24 viewBox、`strokeWidth 1.7`、
 * round cap/join、`currentColor`），原版先换这两处：画布左下角控件坞（`DockRow`）
 * 与节点右侧 hover 操作栏（`ActionButton`）。
 *
 * 其余地方（顶栏、可拖出按钮的把手、结果区状态图标）仍走 lucide —— 不在这轮范围内，
 * 所以 `lucide-react` 依赖**保留**，别看到「本文件不引图标库」就顺手从
 * package.json 里删掉它。
 *
 * ## 形状从哪来（改形状 = 两边一起改）
 *
 * 下面的 `PATHS` 是 `dsh-imagora-desk/src/client/icons.tsx` 的逐字拷贝，不是另画一套。
 * 保留完整清单（含本仓暂时用不到的 `play` / `stop` / `copy` / `close` 等）是刻意的：
 * 只留用得到的那几条，下次同步就只能靠人肉比对，而形状一旦分叉就再也对不回来。
 * 想换某个图形 → **两个仓库同时改**。
 *
 * 与插件版的唯一差别：插件版的 `Icon` 多一个 `strokeWidth` 参数（它用 `grip` 画拖拽把手，
 * 要靠 2.5 的粗点撑出存在感）；本仓的拖拽把手仍走 lucide 的 `GripVertical`，
 * 所以这里不需要那个参数。
 *
 * ## 语义映射（按钮的 label / title / aria-label 一个都没动，只换图形）
 *
 * 控件坞（[CanvasPage.tsx](CanvasPage.tsx) 的 `<DockRow icon={…}>`，尺寸都是 14）：
 * `ZoomIn → zoomIn` · `ZoomOut → zoomOut` · `Maximize → maximize` · `Crosshair → focus` ·
 * `Magnet → magnet` · `Map → map` · `Lock → lock` · `LockOpen → unlock` · `CircleHelp → help`
 *
 * 节点右侧操作栏（[CanvasNodes.tsx](CanvasNodes.tsx) 的 `<ActionButton>`，尺寸都是 14）：
 * `Eye → eye` · `Crop → crop` · `Maximize2 → expand` · `Scissors → grid` ·
 * `Brush → wand` · `RefreshCw → image` · `Trash2 → trash`
 *
 * ## 一个绕不开的坑：别在组件作用域里 import 一个叫 `Map` 的图标
 *
 * 换之前控件坞写的是 `Map as MapIcon` —— 之所以要起别名，是因为名叫 `Map` 的组件会遮蔽
 * 全局 `Map` 类型，React Flow 的泛型推断（`useNodesState` / `NodeChange<…>`）会当场崩掉，
 * 报一串和 UI 毫无关系的类型错误。这里用字符串 `"map"` 取图形，不会再撞名，
 * 但下次想加图标时记住这条：**名字走 `PATHS` 的键，别 import 同名组件**。
 */

/** 图标名 → SVG path 的 `d`。键名与插件版逐字一致，别在本仓另起名字。 */
const PATHS: Record<string, string> = {
  plus: "M12 5v14M5 12h14",
  image: "M4 5h16v14H4zM4 15l4.5-4.5 3 3L15 10l5 5",
  play: "M8 5.5v13l11-6.5z",
  stop: "M7 7h10v10H7z",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
  eye: "M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12zM12 9.6a2.4 2.4 0 100 4.8 2.4 2.4 0 000-4.8z",
  link: "M9.5 14.5l5-5M8 12l-2 2a3.5 3.5 0 005 5l2-2M16 12l2-2a3.5 3.5 0 00-5-5l-2 2",
  save: "M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6",
  folder: "M3 6h6l2 2h10v11H3z",
  clock: "M12 7v5l3.5 2M12 3a9 9 0 100 18 9 9 0 000-18z",
  maximize: "M4 9V4h5M20 15v5h-5M15 4h5v5M9 20H4v-5",
  map: "M9 4l6 2 6-2v14l-6 2-6-2-6 2V6zM9 4v14M15 6v14",
  help: "M12 17h.01M9.2 9a2.8 2.8 0 015.6.6c0 1.9-2.8 2.2-2.8 3.9",
  copy: "M8 8h11v11H8zM5 16V5h11",
  close: "M6 6l12 12M18 6L6 18",
  wand: "M5 19l9-9M14 5l1 2 2 1-2 1-1 2-1-2-2-1 2-1zM19 12l.7 1.3L21 14l-1.3.7L19 16l-.7-1.3L17 14l1.3-.7z",
  layers: "M12 4l8 4-8 4-8-4 8-4zM4 12l8 4 8-4M4 16l8 4 8-4",
  crop: "M6 3v13a2 2 0 002 2h13M3 6h13a2 2 0 012 2v13",
  grid: "M4 4h16v16H4zM9.3 4v16M14.7 4v16M4 9.3h16M4 14.7h16",
  expand: "M9 4H4v5M15 20h5v-5M4 4l6 6M20 20l-6-6",
  // 控件坞那几行（原版 DockRow 每行都有 14px 图标，只留文字会比原版单薄一档）
  zoomIn: "M11 4.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM20 20l-4-4M8 11h6M11 8v6",
  zoomOut: "M11 4.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM20 20l-4-4M8 11h6",
  focus: "M12 3v3M12 18v3M3 12h3M18 12h3M12 8.5a3.5 3.5 0 100 7 3.5 3.5 0 000-7z",
  magnet: "M6 4v8a6 6 0 0012 0V4M6 4h4v8M18 4h-4v8",
  lock: "M7.5 11V8a4.5 4.5 0 019 0v3M5 11h14v9H5z",
  unlock: "M7.5 11V8a4.5 4.5 0 018.9-1M5 11h14v9H5z",
  grip: "M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01",
};

/** 全站唯一一套笔画参数：viewBox 24、线宽 1.7、圆头圆角、颜色跟 `currentColor`。
 *  图标是**前景**不是表面，所以只用 `currentColor` 继承所在行的文字色 ——
 *  悬停态、开关态（控件坞 `.dock-row.is-on`）、危险态（`.btn-danger`）全都自动跟上，
 *  不需要为每种状态各写一份颜色。 */
const STROKE_WIDTH = 1.7;

export interface IconProps {
  /** `PATHS` 里的键名（与插件版一致）。拼错不会报错，见下方注释。 */
  name: string;
  /** 边长（px）。两条调用点都是 14 —— 与原 lucide 图标同尺寸，换图形不动布局。 */
  size?: number;
  style?: CSSProperties;
}

export function Icon({ name, size = 14, style }: IconProps) {
  // 名字打错时退回 `help`（问号），而不是什么都不画：画出一个问号一眼就能看出
  // 「这里没配对」，渲染成空白反而像是布局少了一块、要 debug 半天。
  // 这条兜底与插件版行为一致，两边别各改一半。
  const d = PATHS[name] ?? PATHS.help ?? "";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE_WIDTH}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      // display:block + flex:none：图标在按钮里当零件用，不能带基线空隙、
      // 也不能被 flex 容器压扁（原 lucide 的 svg 默认就是这样）。
      style={{ display: "block", flex: "none", ...style }}
    >
      <path d={d} />
    </svg>
  );
}

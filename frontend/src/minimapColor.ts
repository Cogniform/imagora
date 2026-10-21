import type { Node } from "@xyflow/react";

/** 小地图节点配色：提示词卡用品牌色，图片 / 图片组用两档中性灰。
 *
 *  取的是 index.css 里的品牌色与既有中性色，不新增色板 —— 小地图是导航辅助，
 *  不该引入第五套配色。未知类型走中灰兜底（工作流文件可能来自旧版本，
 *  node.type 未必落在当前三类里）。 */
const MINIMAP_NODE_COLORS = {
  prompt: "var(--color-brand)",
  image: "#7c8994",
  group: "#c4ccd4",
} as const;

/** 未知 / 缺失类型的兜底色（比图片组的浅灰更深一档，缩略图上仍看得见） */
const MINIMAP_NODE_FALLBACK_COLOR = "#a8b0b8";

/** 按节点类型取小地图颜色。纯映射：不读 DOM、不读主题实际值，返回值原样交给 MiniMap。 */
export function minimapNodeColor(node: Pick<Node, "type">): string {
  switch (node.type) {
    case "prompt":
      return MINIMAP_NODE_COLORS.prompt;
    case "image":
      return MINIMAP_NODE_COLORS.image;
    case "group":
      return MINIMAP_NODE_COLORS.group;
    default:
      return MINIMAP_NODE_FALLBACK_COLOR;
  }
}

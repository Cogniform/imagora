import { aspectIconSize } from "../aspectIcon";

/**
 * 比例预览图标：一个按真实宽高比缩放的**空心矩形**。
 *
 * 用途是尺寸下拉里「这条是横的还是竖的」——`1536x1024 (3:2 横版)` 这类文字
 * 光看数字判断不出方向，配一个同比例的框就一目了然。几何算法在
 * [aspectIcon.ts](../aspectIcon.ts)（纯函数，有单测）。
 *
 * ## 颜色只用 currentColor
 *
 * 项目里容器底色只能来自 `surface.ts`（[surfaceAudit.test.ts](../surfaceAudit.test.ts)
 * 机械把关，写死白色类名或硬编码颜色会红）。这里更简单：图标是**前景**不是表面，
 * 用 `currentColor` 就直接继承所在行的文字颜色 —— 选中态、悬停态、禁用态全都自动跟上，
 * 不需要为每种状态各写一份颜色。
 */

export interface AspectIconProps {
  /** 宽高比（宽 / 高）；`null` 表示解析不到，此时不渲染 */
  ratio: number | null;
  className?: string;
}

export function AspectIcon({ ratio, className }: AspectIconProps) {
  // 解析不到比例就不画 —— 画个正方形反而会暗示「这是 1:1」
  if (ratio === null) return null;
  const { width, height } = aspectIconSize(ratio);
  return (
    <span
      aria-hidden="true"
      className={className}
      style={{
        width,
        height,
        borderWidth: 2,
        borderStyle: "solid",
        borderColor: "currentColor",
        borderRadius: 2,
        display: "inline-block",
        flexShrink: 0,
      }}
    />
  );
}

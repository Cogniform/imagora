import { MODEL_BRAND_GLYPH, modelBrand, modelBrandLabel } from "../modelIcon";

/**
 * 模型品牌小徽标：一个 16×16 的圆角方块，里面一个单字符。
 *
 * 用途是「添加供应商」弹窗的模型下拉 —— 中转站探出来的清单动辄几十上百个 ID，
 * 纯文字列表只能逐个读 ID 才知道哪家是哪家。徽标不占横向空间（16px，和文字之间
 * 靠 Select 的 `gap-2` 分开），扫一眼就能把同一家的模型聚成一片。品牌识别规则在
 * [modelIcon.ts](../modelIcon.ts)（纯函数，有单测）。
 *
 * ## 为什么是字符而不是图标库
 *
 * 项目零新增依赖，也不该为 9 个字母引一整个图标库。单字符还有个好处：它跟随
 * `font-size` 缩放，塞进 9px 的方块里仍然清晰；emoji 在 Windows 上字形与基线
 * 都和正文对不齐，反而更糊。
 *
 * ## 颜色只用 currentColor
 *
 * 容器底色只能来自 `surface.ts`（[surfaceAudit.test.ts](../surfaceAudit.test.ts)
 * 机械把关，写死白色类名或硬编码颜色会红）。这里更简单：徽标是**前景**不是表面，
 * 底衬用 `color-mix(in srgb, currentColor 12%, transparent)` —— 它由当前文字色
 * 稀释而来，选中态 / 悬停态 / 禁用态全都自动跟上，不需要为每种状态各写一份颜色。
 *
 * ## unknown 也渲染
 *
 * 认不出品牌时显示一个中点，**不返回 null**：列表里突然有一行没图标，整列会显得
 * 错位，而且用户会以为「这个模型有问题」。中点表达的是「不知道」，不是「不支持」。
 */

export interface ModelIconProps {
  /** 模型 ID（内部转品牌） */
  modelId: string;
  className?: string;
}

export function ModelIcon({ modelId, className }: ModelIconProps) {
  const brand = modelBrand(modelId);
  return (
    <span
      // 纯装饰：品牌信息已经隐含在模型 ID 里，读屏软件念一遍字母只会干扰
      aria-hidden="true"
      // 悬停给全名 —— 单个字母在 `A` / `Z` 之间并不自解释
      title={modelBrandLabel(brand)}
      className={className}
      style={{
        width: 16,
        height: 16,
        borderRadius: 4,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        fontSize: 9,
        fontWeight: 600,
        lineHeight: 1,
        background: "color-mix(in srgb, currentColor 12%, transparent)",
        color: "currentColor",
      }}
    >
      {MODEL_BRAND_GLYPH[brand]}
    </span>
  );
}

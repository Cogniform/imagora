/**
 * 表面材质 —— 全站所有「容器底色」的唯一产地。
 *
 * ## 为什么要有这个模块
 *
 * 曾经散落着 15 处硬编码 `rgba(255,255,255,…)`：生成历史整窗是 `#f4f1eb` 米色、
 * 加载工作流列表、下拉浮层、画布节点卡、结果缩略图、最近提示词行……于是「换主体色」
 * 只换了看得见的那一半。现在**任何容器底色都必须来自这里**，由
 * [surfaceAudit.test.ts](surfaceAudit.test.ts) 机械把关（CI 里会红）。
 *
 * ## 两个正交的轴
 *
 * | 轴 | 管什么 | 谁决定 |
 * |---|---|---|
 * | **掺色 `tint`** | 这个面**是什么色**（容器身份） | 角色：外壳多掺、内容区少掺 |
 * | **不透明度 `alpha`** | 这个面**透多少**（壁纸露多少） | 用户那条「通透度」滑杆 |
 *
 * 老实现把两者**耦合**了：token 只写 `hsl(hue 30% 98.4% / a)`，而 98.4% 亮度 +
 * 30% 饱和度算出来的颜色离纯白只有 **2/255** —— 数学上不可见。「看起来跟了主体色」
 * 完全来自「alpha 低、页面底色透上来」。一旦某个面需要不透明（弹窗、列表行），
 * 颜色就消失 —— 实测同屏出现「左边卡片是粉的、右边结果区是白的」，且"更强的一档"反而更白。
 *
 * 所以现在：**颜色写在颜色里，透明度写在不透明度里**，各管各的。
 *
 * ## 掺色为什么解成真实 RGB
 *
 * 直觉上会写 `hsl(hue 30% 97%)`，但「饱和度 + 亮度」组合出来的实际离白距离极不直观
 * （老实现就栽在这：写了 30% 饱和度，实际只差 2/255）。这里改为取一个明确饱和的基色
 * `hsl(hue 80% 62%)`，按 `tint` 比例与纯白线性混合 —— `tint` 于是有了直观含义：
 * **离白多远**（0.10 ≈ 17/255，肉眼明确可见）。
 *
 * ## 嵌套方向（别搞反）
 *
 * 外壳掺色最明显（负责「这是紫调界面」），越往里越中性、越实（负责「内容看得清」）。
 * **内层不许比外层更透** —— 否则壁纸会从容器中间透出一个洞。
 * 默认通透度下各角色的实际不透明度（可复算，`surfaceAudit` 会锁住这条不变量）：
 *
 *     卡片 0.47 < 台面 0.85 < 浮层 0.94
 *
 * ## 不跟随主体色的那一个
 *
 * `plain`（画布主体）掺色为 0：它是**看图的台面**，带色会干扰对生成图颜色的判断。
 * 这条是有意为之，别"顺手统一"掉。
 */

/** 一个表面角色的配方。全部是显式常量 —— 改观感只动这张表。 */
interface SurfaceRole {
  /** 与 `hsl(hue 80% 62%)` 的混合比例：0 = 纯中性白，0.10 ≈ 离白 17/255 */
  tint: number;
  /** 150deg 渐变**上端**的不透明度：[通透度 0 时, 通透度 1 时]（线性插值） */
  alphaTop: readonly [number, number];
  /** 渐变**下端**的不透明度，同上 */
  alphaBottom: readonly [number, number];
}

/**
 * 角色表 —— 唯一需要理解的东西。
 *
 * 取舍：
 * - `base` / `card` 可以很透（0.9→0.12）：大面积衬底，透一点只是让壁纸露出来。
 * - `panel`（台面 / 弹窗外壳 / 生成历史外壳）落在 0.97→0.76：里面常是密集表单与长文本，
 *   底下一花逐行读值就费劲 —— 这是老实现 `MODAL_ALPHA_FLOOR = 0.86` 想解决的问题，
 *   现在改用「两端各留余地」的插值表达：既保住可读性，又让通透度滑杆**仍然有行程**
 *   （老写法的硬 floor 会把滑杆压成死值，拉到一半以上完全没反应）。
 * - `float`（浮层）掺色最低、不透明度最高：它叠在别的表面**上面**，要压得住下面，
 *   同时保持「内容是白的」这一读感。
 * - `inset`（输入框）几乎中性：浅灰底字压在花哨底上会发飘（另有 FIELD_ALPHA_FLOOR）。
 * - `plain` 掺色为 0（画布主体，见文件头说明）。
 */
const ROLES = {
  base: { tint: 0.1, alphaTop: [0.92, 0.34], alphaBottom: [0.78, 0.26] },
  card: { tint: 0.095, alphaTop: [0.9, 0.12], alphaBottom: [0.68, 0.09] },
  panel: { tint: 0.1, alphaTop: [0.97, 0.76], alphaBottom: [0.92, 0.7] },
  float: { tint: 0.055, alphaTop: [0.99, 0.9], alphaBottom: [0.96, 0.88] },
  inset: { tint: 0.025, alphaTop: [0.9, 0.35], alphaBottom: [0.9, 0.35] },
  plain: { tint: 0, alphaTop: [0.94, 0.8], alphaBottom: [0.9, 0.76] },
} as const satisfies Record<string, SurfaceRole>;

export type SurfaceRoleName = keyof typeof ROLES;

/** 注入到 CSS 的整套表面变量（键名带 `--`） */
export interface SurfaceTokens {
  base: string;
  card: string;
  panel: string;
  float: string;
  inset: string;
  plain: string;
  /** 毛玻璃（当前恒 `none`） */
  blur: string;
}

export type SurfaceVarName =
  | "--surface-base"
  | "--surface-card"
  | "--surface-panel"
  | "--surface-float"
  | "--surface-inset"
  | "--surface-plain"
  | "--surface-blur";

/** 通透度区间：0 = 最实（接近全白），1 = 最透（接近全透明） */
export const SURFACE_TRANSPARENCY_LIMITS = { min: 0, max: 1 } as const;

/** 默认通透度。0.55：维护者要求「再透明一些」后的取值 */
export const SURFACE_TRANSPARENCY_DEFAULT = 0.55;

/** 存储键（仅本机浏览器） */
export const SURFACE_TRANSPARENCY_STORAGE_KEY = "imagora.surface-transparency.v1";

/** 掺色基色：足够饱和才能「掺一点就看得见」 */
const TINT_SOURCE = { saturation: 0.8, lightness: 0.62 } as const;

/** 渐变两端的掺色系数：上端略淡、下端略浓，保留原来那条 150deg 微渐变 */
const GRADIENT = { top: 0.88, bottom: 1.18 } as const;

/**
 * 输入框的不透明度下限。
 *
 * 为什么只有输入框有底线：卡片/面板是**大面积衬底**，透一点只是让壁纸露出来；
 * 输入框里常是**给用户看的浅灰底字**（placeholder、下拉里的尺寸/质量），
 * 压在花哨壁纸上会直接发飘；控件本身又需要一条边界。
 * 25% 白足够让灰字站住、输入区一眼可辨，同时壁纸仍从底下透出来（不是一块白板）。
 */
export const FIELD_ALPHA_FLOOR = 0.25;

/**
 * 毛玻璃开关：`none` = 彻底关掉（默认，也是唯一取值）。
 *
 * 为什么连 8~12px 都不要：维护者要的是**壁纸原样**。任何半径的毛玻璃都在容器底下
 * 铺一层雾，雾一存在，壁纸清晰度就打折 —— 而容器的可读性靠壁纸降噪
 * （WALLPAPER_IMAGE_FILTER）与文字极淡白描边就够了。
 * 教训：模糊是「把背景弄走」的手段，不是「把背景变好看」的手段。
 *
 * 函数保留（而不是删掉让 CSS 回落）：整条字面量仍由 JS 注入，将来要恢复可调时不改调用方。
 */
export function blurFor(_transparency: number): string {
  return "none";
}

/**
 * 壁纸生效时给壁纸加的降噪：稍微去饱和 + 压一点点对比。
 *
 * 为什么不是加一层半透明白（scrim）：白纱会把整张图提亮变灰，壁纸立刻失去层次。
 * 去饱和只抽掉颜色、保留明暗，画面安静下来、文字好读，细节与纵深还在。
 */
export const WALLPAPER_IMAGE_FILTER = "saturate(0.62) contrast(0.94)";

function clampNumber(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(SURFACE_TRANSPARENCY_LIMITS.max, Math.max(SURFACE_TRANSPARENCY_LIMITS.min, n));
}

/** 把任意入参钳到 [0, 1]；非法值回落默认 */
export function clampSurfaceTransparency(value: unknown): number {
  if (value === null || value === undefined || value === "") return SURFACE_TRANSPARENCY_DEFAULT;
  return clampNumber(value, SURFACE_TRANSPARENCY_DEFAULT);
}

/** 归一化色相（非法按 0，与 accent.ts 一致） */
function normalizeHue(hue: number): number {
  if (!Number.isFinite(hue)) return 0;
  return ((hue % 360) + 360) % 360;
}

/** HSL → RGB（0-255）。只在本模块用 */
function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const hp = hue / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let rgb: [number, number, number];
  if (hp < 1) rgb = [c, x, 0];
  else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x];
  else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const m = lightness - c / 2;
  return [
    Math.round((rgb[0] + m) * 255),
    Math.round((rgb[1] + m) * 255),
    Math.round((rgb[2] + m) * 255),
  ];
}

/**
 * 把一个「离白多远」的掺色量解成真实 RGB。
 *
 * 为什么不用 `hsl(hue s% l%)` 直接写：饱和度与亮度组合出来的实际离白距离极不直观，
 * 老实现就栽在这里（写了 30% 饱和度，实际只差 2/255）。改成对饱和基色做线性混合后，
 * `tint` 就是**可见量本身**，可算、可测、可解释。
 */
function tintToRgb(hue: number, tint: number): [number, number, number] {
  if (tint <= 0) return [255, 255, 255];
  const [sr, sg, sb] = hslToRgb(hue, TINT_SOURCE.saturation, TINT_SOURCE.lightness);
  return [
    Math.round(255 + (sr - 255) * tint),
    Math.round(255 + (sg - 255) * tint),
    Math.round(255 + (sb - 255) * tint),
  ];
}

function rgba([r, g, b]: readonly [number, number, number], alpha: number): string {
  return `rgba(${r}, ${g}, ${b}, ${Math.round(alpha * 1000) / 1000})`;
}

/** 通透度 → 某个渐变端点的不透明度（两端线性插值） */
function alphaAt(range: readonly [number, number], transparency: number): number {
  const t = clampSurfaceTransparency(transparency);
  return range[0] + (range[1] - range[0]) * t;
}

/** 一个角色的完整 150deg 微渐变字面量 */
function gradientOf(hue: number, role: SurfaceRole, transparency: number): string {
  const top = tintToRgb(hue, role.tint * GRADIENT.top);
  const bottom = tintToRgb(hue, role.tint * GRADIENT.bottom);
  return `linear-gradient(150deg, ${rgba(top, alphaAt(role.alphaTop, transparency))}, ${rgba(bottom, alphaAt(role.alphaBottom, transparency))})`;
}

/**
 * 算出整套表面材质。色相决定掺什么色，通透度决定各角色透多少。
 * 色相非法时按 0 处理（与 accent.ts 的归一策略一致）。
 */
export function surfaceTokens(hue: number, transparency: number): SurfaceTokens {
  const h = normalizeHue(hue);
  const t = clampSurfaceTransparency(transparency);
  return {
    base: gradientOf(h, ROLES.base, t),
    card: gradientOf(h, ROLES.card, t),
    panel: gradientOf(h, ROLES.panel, t),
    float: gradientOf(h, ROLES.float, t),
    inset: gradientOf(h, ROLES.inset, t),
    plain: gradientOf(h, ROLES.plain, t),
    blur: blurFor(t),
  };
}

/**
 * token → CSS 变量名。**注入方一律遍历它**，别手写 setProperty ——
 * 否则新增角色时会漏掉一处（`.imagora-app` 与 `document.documentElement` 都要写），
 * 表现是「弹窗拿不到新 token」。
 */
export function surfaceVarList(tokens: SurfaceTokens): Array<[SurfaceVarName, string]> {
  return [
    ["--surface-base", tokens.base],
    ["--surface-card", tokens.card],
    ["--surface-panel", tokens.panel],
    ["--surface-float", tokens.float],
    ["--surface-inset", tokens.inset],
    ["--surface-plain", tokens.plain],
    ["--surface-blur", tokens.blur],
  ];
}

/** 角色 → 用途说明。文档与审计测试都引用它，保持单一事实来源。 */
export const SURFACE_ROLE_DOC: Record<SurfaceRoleName, string> = {
  base: "骨架：页面衬底、顶栏、画布工具栏",
  card: "大面衬底：经典表单三张输入卡",
  panel: "台面：经典输出区、弹窗外壳、生成历史外壳",
  float: "浮层：下拉列表、列表行、画布节点卡、结果缩略图、最近提示词",
  inset: "内嵌：输入框、次级小块",
  plain: "中性（不跟随主体色）：画布主体 —— 看图台面",
};

/** 读通透度；未设置 / 非法一律回落默认（存储不可用也一样，不抛错） */
export function readSurfaceTransparency(): number {
  try {
    const raw = localStorage.getItem(SURFACE_TRANSPARENCY_STORAGE_KEY);
    if (raw === null || raw.trim() === "") return SURFACE_TRANSPARENCY_DEFAULT;
    return clampSurfaceTransparency(Number(raw));
  } catch {
    return SURFACE_TRANSPARENCY_DEFAULT;
  }
}

/** 写通透度（写入前先钳制，存储里绝不落越界值）。存储不可用时静默不持久化。 */
export function saveSurfaceTransparency(transparency: number): void {
  try {
    localStorage.setItem(
      SURFACE_TRANSPARENCY_STORAGE_KEY,
      String(clampSurfaceTransparency(transparency)),
    );
  } catch {
    /* 隐私模式等场景：不持久化即可 */
  }
}

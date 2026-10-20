// @vitest-environment node
/**
 * 表面审计 —— 挡住「又有人写死一个白色」这类腐化。
 *
 * ## 为什么需要它
 *
 * `surface.ts` 是容器底色的唯一产地，但这条约定**靠人记得**就会失效：
 * 真实发生过 —— 全站 15 处容器写死 `rgba(255,255,255,…)`（生成历史整窗是 `#f4f1eb` 米色、
 * 加载工作流列表、下拉浮层、画布节点卡、结果缩略图…），于是「换主体色」只换了一半。
 *
 * 所以把约定变成**机械判据**：本测试解析 `index.css`，任何配置了容器底色的选择器
 * 必须走 `var(--surface-*)` / `var(--field-bg)`，否则失败 —— 除非在下面的白名单里
 * 且有登记理由。
 *
 * ## 白名单的判据
 *
 * 只放两类：
 * 1. **语义色**：危险红 / 待重启琥珀 / 遮罩深色 —— 跟随主体色会丢失含义
 * 2. **中性控件**：滑杆轨道、开关滑块、页签选中态、滚动条 —— 它们本来就该是无彩的
 *
 * 想加白名单可以，但必须在 `EXEMPT` 里写下**为什么它不该跟随主体色**。
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SRC_DIR = __dirname;
const CSS_PATH = path.join(SRC_DIR, "index.css");

/**
 * 允许写死底色的选择器（子串匹配）→ 理由。
 *
 * 判据：它**该不该**跟随主体色？不该，才允许进这里。
 */
const EXEMPT: Array<[string, string]> = [
  // —— 语义色：跟随主体色会丢失含义 ——
  [".chip--danger", "危险红：语义固定，跟随主体色会让「危险」不再可辨"],
  [".chip--pending", "待重启琥珀：刻意与语义警告区分，跟随主体色会与品牌色混淆"],
  [".prompt-import-issue", "导入报错底色：语义红，同 chip--danger"],
  [".log-box", "日志区底色：中性深色块，它是内容不是容器"],
  // —— 遮罩：压暗用的隔离层，带色会让弹窗底色发脏 ——
  [".modal-shell", "遮罩：已改读 --scrim-* 中性 token（此处匹配嵌套/历史两条同源规则）"],
  [".history-overlay", "遮罩：与弹窗遮罩统一成同一组 --scrim-*"],
  ["html[data-wallpaper=\"on\"] body", "壁纸铺底时页面让位给壁纸，固定深色以免未解码时闪主色底"],
  [".react-flow__renderer", "画布渲染层的中心光晕：它是高光不是容器底色，白色才成立"],
  // —— 中性控件：本来就该无彩 ——
  [".switch", "开关轨道：中性灰。跟随主体色会让「开/关」与品牌色混淆"],
  [".switch::after", "开关滑块：纯白旋钮"],
  [".range-field", "通用滑杆轨道：中性灰，避免与「主体色滑杆」的彩虹轨道混淆"],
  [".range-field::-webkit-slider-thumb", "滑杆旋钮：控件零件"],
  [".range-field::-moz-range-thumb", "滑杆旋钮：同上（Firefox 用 moz 伪元素）"],
  [".accent-hue", "主体色滑杆的彩虹轨道：它本身就是选色器"],
  [".accent-hue::-webkit-slider-thumb", "滑杆旋钮：控件零件"],
  [".accent-hue::-moz-range-thumb", "滑杆旋钮：同上（Firefox 用 moz 伪元素）"],
  [".tabs", "页签轨道：中性灰，选中片是白 —— 对比来自轨道本身"],
  [".tabs__item[aria-selected=\"true\"]", "页签选中片：在灰轨道上的白片，白才是它的语义"],
  [".size-pill", "尺寸标签底：中性灰小片"],
  ["::-webkit-scrollbar", "滚动条：走 --sb-* 中性变量，轨道透明以跟随所在容器"],
  [".chip--quiet", "安静角标：中性灰，刻意不抢品牌色"],
  [".btn-ghost", "幽灵按钮：常态透明底，无表面可谈"],
  [".imagora-wallpaper__image", "壁纸图层本身：它就是要显示的那张图"],
  [".bg-swatch", "材质选择器色块：与 body 共用同一组 --bg-* 声明，跟着变"],
  [".select-option.is-active", "下拉高亮：走 --color-brand 的 mix，已属 token 体系"],
  [".workflow-list__item:hover", "列表行悬停：同上，品牌色 mix"],
  [".recent-prompt:hover", "最近提示词悬停：同上，品牌色 mix"],
  [".studio-canvas .react-flow__controls-button:hover", "画布按钮悬停：同上，品牌色 mix"],
  [".prompt-import-issue", "导入报错底：语义红"],
];

/**
 * TSX 里允许写死的表面（Tailwind 类名）→ 理由。**按「文件 + 类名」精确匹配**，
 * 不做全局放行 —— 否则 `bg-white` 一进清单，以后谁写都能过，清单就成了后门。
 *
 * 为什么还要查 TSX：Tailwind 的 `bg-white` 生成的是 `background-color`，
 * **接不了渐变 token**，所以它天然是「绕过表面系统」的捷径 —— 真实发生过
 * （生成历史头部与列表行的 `bg-white` 直接盖掉了我刚改好的 CSS 规则）。
 */
const TSX_EXEMPT: Array<[file: string, token: string, reason: string]> = [
  [
    "components/CanvasPage.tsx",
    "bg-white",
    "拖拽把手旋钮（16px 圆点）：控件零件不是容器，中性白才能在任意底色的卡片上显出对比",
  ],
  ["components/WorkflowModals.tsx", "bg-black/60", "放大预览遮罩：与弹窗遮罩同类，中性压暗"],
  [
    "components/WorkflowModals.tsx",
    "bg-black/40",
    "放大预览底部控制条：压在图片上，中性深底才能保证任何图上都可读",
  ],
  [
    "components/WorkflowModals.tsx",
    "bg-white/10",
    "压在图片上的按钮：白色低透明度叠层，跟随主体色会与图片本身打架",
  ],
  ["components/WorkflowModals.tsx", "bg-white/20", "同上（hover 态）"],
];

/** 该选择器是否已登记豁免 */
function isExempt(selector: string): boolean {
  return EXEMPT.some(([needle]) => selector.includes(needle));
}

interface Rule {
  selector: string;
  line: number;
  declaration: string;
}

/** 抽出所有「设了背景色/背景图但在写死颜色」的声明 */
function findHardcodedSurfaces(): Rule[] {
  const raw = readFileSync(CSS_PATH, "utf-8");
  // 去注释（保留换行以维持行号）
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

  const out: Rule[] = [];
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = ruleRe.exec(css)) !== null) {
    const selector = (match[1] ?? "").trim().split("\n").pop()?.trim() ?? "";
    const body = match[2] ?? "";
    const line = css.slice(0, match.index).split("\n").length;

    for (const decl of body.split(";")) {
      const d = decl.trim();
      if (!/^background(-color|-image)?\s*:/.test(d)) continue;
      if (/var\(--(surface|scrim|field|bg|sb|color)-/.test(d)) continue;
      if (/:\s*(transparent|none|inherit|currentColor|unset)\s*$/.test(d)) continue;
      if (!/#|rgba?\(|color-mix|hsl\(/.test(d)) continue;
      if (/var\(--color-brand\)|--btn-fill/.test(d)) continue;

      out.push({ selector, line, declaration: d });
    }
  }
  return out;
}

/** 递归收集 src 下的所有 .tsx */
function collectTsx(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectTsx(full, acc);
    else if (entry.name.endsWith(".tsx")) acc.push(full);
  }
  return acc;
}

/** TSX 里用了哪些「写死表面的 Tailwind 类」 */
function findHardcodedTsxSurfaces(): Array<{ file: string; line: number; cls: string }> {
  const out: Array<{ file: string; line: number; cls: string }> = [];
  for (const file of collectTsx(SRC_DIR)) {
    const rel = path.relative(SRC_DIR, file).split(path.sep).join("/");
    const lines = readFileSync(file, "utf-8").split("\n");
    for (const [index, line] of lines.entries()) {
      for (const m of line.matchAll(/\b(bg-(?:white|black)(?:\/\d+)?)\b/g)) {
        const cls = m[1] ?? "";
        // 按「文件 + 类名」精确豁免；不做全局放行
        if (TSX_EXEMPT.some(([f, token]) => f === rel && token === cls)) continue;
        out.push({ file: rel, line: index + 1, cls });
      }
    }
  }
  return out;
}

describe("表面审计：容器底色只能来自 surface.ts", () => {
  const offenders = findHardcodedSurfaces().filter((r) => !isExempt(r.selector));

  it("index.css 里没有未登记的写死底色", () => {
    const report = offenders
      .map((r) => `  index.css:${r.line}  ${r.selector}\n      ${r.declaration}`)
      .join("\n");
    expect(
      offenders,
      `发现 ${offenders.length} 处写死底色。容器底色请走 var(--surface-*)，` +
        `确有必要豁免就到 surfaceAudit.test.ts 的 EXEMPT 里登记理由：\n${report}`,
    ).toEqual([]);
  });

  it("TSX 里没有未登记的写死表面（bg-white 接不了渐变 token，是绕过系统的捷径）", () => {
    const bad = findHardcodedTsxSurfaces();
    const report = bad.map((r) => `  ${r.file}:${r.line}  ${r.cls}`).join("\n");
    expect(
      bad,
      `发现 ${bad.length} 处 TSX 写死表面。容器请挂 .surface-* 角色类；` +
        `确有必要豁免就到 TSX_EXEMPT 里登记理由：\n${report}`,
    ).toEqual([]);
  });

  it("豁免清单每一条都写了理由（避免变成垃圾桶）", () => {
    for (const [selector, reason] of EXEMPT) {
      expect(reason.length, `${selector} 缺少理由`).toBeGreaterThan(4);
    }
    for (const [file, token, reason] of TSX_EXEMPT) {
      expect(reason.length, `${file} 的 ${token} 缺少理由`).toBeGreaterThan(4);
    }
  });

  it("每个 --surface-* 角色都在 CSS 里有消费方（新增角色不能只定义不用）", () => {
    const css = readFileSync(CSS_PATH, "utf-8");
    for (const role of ["base", "card", "panel", "float", "inset", "plain"]) {
      expect(css, `--surface-${role} 没有任何消费方`).toContain(`var(--surface-${role}`);
    }
  });

  it("角色类齐备（TSX 靠它们声明表面，缺一个就会有人回头写 bg-white）", () => {
    const css = readFileSync(CSS_PATH, "utf-8");
    for (const role of ["base", "card", "panel", "float", "inset", "plain"]) {
      expect(css, `缺少 .surface-${role} 角色类`).toMatch(
        new RegExp(`\\.surface-${role}\\s*\\{[^}]*background:\\s*var\\(--surface-${role}\\)`),
      );
    }
  });

  it("没有容器硬编码 backdrop-filter: blur()（壁纸要原样，只许遮罩用 --scrim-blur）", () => {
    const css = readFileSync(CSS_PATH, "utf-8");
    const hardcoded = [...css.matchAll(/backdrop-filter:\s*blur\(/g)];
    // 去注释后统计，注释里提到 blur( 不算
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const real = [...stripped.matchAll(/backdrop-filter:\s*blur\(/g)];
    expect(real.length, `发现 ${real.length} 处硬编码 backdrop-filter: blur()，应走 var(--surface-blur)`).toBe(
      0,
    );
    void hardcoded;
  });
});


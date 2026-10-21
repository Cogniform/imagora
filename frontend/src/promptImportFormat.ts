/** 提示词导入格式解析 —— 纯函数、零依赖
 *
 * 导入格式（块式）：
 *   === 标题 ===
 *   ```text
 *   ratio: N:M
 *
 *   <提示词正文，可多行>
 *   ```
 *
 * 解析策略：按标题锚点切分行段；段内取第一个围栏为开、最后一个围栏为闭；
 * 块内首非空行为 ratio 元数据行。缺任何必需元素 → 进 issues，绝不静默猜测。
 * 块数量不设上限——通用工具，任意多卡片都能导入。
 */

/** 导入格式中间结构：解析器 / 尺寸映射器 / 建卡构造器共用的唯一类型 */
export interface PromptCardSpec {
  /** 标题行内容，如「示例图1」 */
  title: string;
  /** 元数据行解析出的比例，如 "1:1" */
  ratio: string;
  /** 提示词正文（trim 后） */
  prompt: string;
}

export type PromptIssueCode =
  | "missing-header" // 有围栏无标题行
  | "missing-fence" // 有标题行无围栏
  | "missing-ratio" // 块内无 ratio 行
  | "bad-ratio" // ratio 行格式非法（非 数字:数字）
  | "empty-prompt" // 提示词正文为空
  | "duplicate-title"; // 标题重复

export interface PromptParseIssue {
  code: PromptIssueCode;
  /** 关联块的标题（可缺，如 missing-header 无标题） */
  title?: string;
  message: string;
}

export interface PromptParseResult {
  /** 完全合法、可直接建卡的条目 */
  cards: PromptCardSpec[];
  /** 有问题的条目（不进 cards，逐条标红） */
  issues: PromptParseIssue[];
  /** 解析过程中被忽略的散落文字片段（供日志提示） */
  skippedText: string[];
}

const HEADER_RE = /^=== (.+) ===\s*$/;
const FENCE_RE = /^```(?:text)?\s*$/;
const RATIO_RE = /^ratio:\s*(\d+):(\d+)\s*$/;
const RATIO_PREFIX_RE = /^ratio\b/i;

/** 文本中是否包含围栏行（按行扫描，不整串匹配） */
function containsFence(text: string): boolean {
  return text.split("\n").some((line) => FENCE_RE.test(line));
}

/** 导入格式文本 → 解析结果（标题锚点切分 + 段内首尾围栏配对） */
export function parsePromptImportFormat(text: string): PromptParseResult {
  // 预处理：去 BOM、统一换行
  const src = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = src.split("\n");

  const cards: PromptCardSpec[] = [];
  const issues: PromptParseIssue[] = [];
  const skipped: string[] = [];

  // 收集标题锚点（行号 + 标题）
  const headers: { title: string; line: number }[] = [];
  lines.forEach((line, i) => {
    const title = line.match(HEADER_RE)?.[1];
    if (title !== undefined) headers.push({ title: title.trim(), line: i });
  });

  // 全文无标题
  if (headers.length === 0) {
    const trimmed = src.trim();
    if (trimmed) skipped.push(trimmed);
    if (containsFence(src)) {
      issues.push({ code: "missing-header", message: "全文未找到 === 标题 === 行，但存在代码块围栏" });
    }
    return { cards, issues, skippedText: skipped };
  }

  // 序言段：首个标题之前
  const prelude = lines.slice(0, headers[0]?.line ?? 0).join("\n").trim();
  if (prelude) {
    skipped.push(prelude);
    if (containsFence(prelude)) {
      issues.push({ code: "missing-header", message: "标题之前存在代码块围栏（疑似缺标题的块）" });
    }
  }

  const seenTitles = new Set<string>();
  for (let h = 0; h < headers.length; h++) {
    const header = headers[h];
    if (header === undefined) continue;
    const { title } = header;
    const segStart = header.line + 1;
    const nextHeader = headers[h + 1];
    const segEnd = nextHeader === undefined ? lines.length : nextHeader.line;
    const segLines = lines.slice(segStart, segEnd);

    // 标题去重（保留首个）
    if (seenTitles.has(title)) {
      issues.push({ code: "duplicate-title", title, message: `标题重复：「${title}」` });
      continue;
    }
    seenTitles.add(title);

    // 围栏配对：第一个为开、最后一个为闭
    const fences: number[] = [];
    segLines.forEach((line, i) => {
      if (FENCE_RE.test(line)) fences.push(i);
    });
    const open = fences[0];
    const close = fences[fences.length - 1];
    if (open === undefined || close === undefined) {
      issues.push({ code: "missing-fence", title, message: `「${title}」缺少代码块围栏（需要 \`\`\`text）` });
      continue;
    }

    // 开围栏之前的散落文字
    const before = segLines.slice(0, open).join("\n").trim();
    if (before) skipped.push(before);

    // 块体 = 开围栏行之后 到 闭围栏行之前
    const bodyLines = segLines.slice(open + 1, close);
    const firstNonBlank = bodyLines.findIndex((l) => l.trim() !== "");
    if (firstNonBlank === -1) {
      issues.push({ code: "missing-ratio", title, message: `「${title}」块内没有内容` });
      continue;
    }

    // 首非空行必须是 ratio: N:M
    const firstLine = (bodyLines[firstNonBlank] ?? "").trim();
    const ratioMatch = firstLine.match(RATIO_RE);
    if (!ratioMatch) {
      // 首行以 ratio 开头但格式非法 → bad-ratio；否则视为缺 ratio 行
      if (RATIO_PREFIX_RE.test(firstLine)) {
        issues.push({ code: "bad-ratio", title, message: `「${title}」ratio 行格式非法：${firstLine}` });
      } else {
        issues.push({
          code: "missing-ratio",
          title,
          message: `「${title}」缺少 ratio 元数据行（块内首行应为 ratio: N:M）`,
        });
      }
      continue;
    }
    const ratio = `${ratioMatch[1]}:${ratioMatch[2]}`;

    // ratio 行之后全部内容为正文（不强依赖空行分隔）
    const prompt = bodyLines.slice(firstNonBlank + 1).join("\n").trim();
    if (!prompt) {
      issues.push({ code: "empty-prompt", title, message: `「${title}」提示词正文为空` });
      continue;
    }

    cards.push({ title, ratio, prompt });
  }

  return { cards, issues, skippedText: skipped };
}

// ---- 尺寸映射：单一事实源在 config.sizes（/api/config 下发），不硬编码 ----

import type { SizeOption, WorkflowNode } from "./types";

export interface ResolvedSize {
  /** 前端展示/生成用的尺寸值（config.sizes[].value，如 "1024x1024"） */
  value: string;
  /** true 表示按 label 未匹配到比例，回退到 sizes[0] */
  fallback: boolean;
}

/** 解析 "N:M" 比例 → 匹配 config.sizes 中 label 含 "(N:M" 的项（label 形如 "1024x1024 (1:1 1K)"） */
export function resolveCardSize(ratio: string, sizes: SizeOption[]): ResolvedSize {
  const first = sizes[0];
  if (!/^\d+:\d+$/.test(ratio) || first === undefined) {
    return { value: first?.value ?? "1024x1024", fallback: true };
  }
  const match = sizes.find((s) => s.label.includes(`(${ratio}`));
  if (!match) {
    return { value: first.value, fallback: true };
  }
  return { value: match.value, fallback: false };
}

// ---- 建卡构造器：导入格式条目 → WorkflowNode 数组 ----

export interface PromptNodeBuildConfig {
  sizes: SizeOption[];
  defaultQuality: string;
  defaultOutputDir: string;
}

/** 每张卡片产出一个 PromptNode；落点由 `importCardPositions` 按卡片真实尺寸铺开
 *  （每行 3 张、列距 420、行距 400，整行以 origin 为中心）。
 *
 *  历史坑：旧实现在 origin 上按 6 列 × 30px 步进平铺，而卡片实际宽 380px，
 *  批量导入 8 张会完全叠成一张 —— 铺排逻辑只此一处，别在调用侧再算一遍。 */
export function buildPromptNodes(
  cards: PromptCardSpec[],
  config: PromptNodeBuildConfig,
  origin: { x: number; y: number },
): WorkflowNode[] {
  const positions = importCardPositions(origin, cards.length);
  return cards.map((card, i) => {
    const size = resolveCardSize(card.ratio, config.sizes);
    return {
      id: `prompt-${Date.now()}-${i}`,
      type: "prompt" as const,
      position: positions[i] ?? origin,
      data: {
        prompt: card.prompt,
        size: size.value,
        quality: config.defaultQuality,
        outputDir: config.defaultOutputDir,
        status: "idle" as const,
        title: card.title,
      },
    };
  });
}

// ---- 批量导入的卡片铺排：按卡片真实尺寸排，不能再用 30px 网格 ----

/** 提示词卡片宽度：CanvasNodes 的 PromptNode 根节点写死 `!w-[380px]` */
export const IMPORT_CARD_WIDTH = 380;

/**
 * 提示词卡片高度（约值，用于行距）。
 *
 * 依据 CanvasNodes.tsx:485-557 的固定结构逐项累加（box-sizing: border-box）：
 * - 上下边框 2 + 内边距 `!p-3` 24
 * - 标题 `text-xs` 16 + `mb-2` 8 = 24
 * - textarea `rows=5`、`text-xs leading-relaxed` → 5 × 19.5 = 97.5，加 `py-2` 16 + 边框 2 = 115.5
 * - 尺寸/质量行 `mt-2` 8 + label 16 + `mt-0.5` 2 + 控件 38 = 64
 * - 输出路径行 同上 = 64
 * - 运行按钮行 `mt-2` 8 + `btn-sm`（`py-1 text-xs`）24 = 32
 * 合计 325.5px；LOD 占位卡 `min-h-[320px]` 也印证这一量级。取 326。
 */
export const IMPORT_CARD_HEIGHT = 326;

/** 列间距：卡宽 380 之外再留 40，列距 420 ≥ 400（380 + 间距）的要求 */
export const IMPORT_CARD_COLUMN_GAP = 40;

/** 行间距：326 的卡高之外留 74，行距 400，避免上下两张贴在一起 */
export const IMPORT_CARD_ROW_GAP = 74;

/** 相邻两列的 x 距离 */
export const IMPORT_CARD_COLUMN_PITCH = IMPORT_CARD_WIDTH + IMPORT_CARD_COLUMN_GAP;

/** 相邻两行的 y 距离 */
export const IMPORT_CARD_ROW_PITCH = IMPORT_CARD_HEIGHT + IMPORT_CARD_ROW_GAP;

/** 每行最多放几张：3 列在 1280–1440 宽的视口里刚好铺满可视区，再多就要横向拖拽 */
export const IMPORT_CARDS_PER_ROW = 3;

/**
 * 批量导入的卡片坐标：给定**单张卡应有的落点** origin 与数量，返回逐张不重叠的坐标。
 *
 * - 每行 `IMPORT_CARDS_PER_ROW` 张，列距 420（卡宽 380 + 40 间距），行距 400（卡高 326 + 74）。
 * - 整行以 origin 的水平中心对齐：单张时坐标就是 origin（与「新建一张卡」的落点一致），
 *   多张时向两侧展开，避免整批从视口中心往右溢出。
 * - origin.y 是第一行的顶部，向下换行；不做垂直居中，否则首行会顶到工具栏下面。
 */
export function importCardPositions(
  origin: { x: number; y: number },
  count: number,
): { x: number; y: number }[] {
  const total = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  const positions: { x: number; y: number }[] = [];
  for (let i = 0; i < total; i++) {
    const row = Math.floor(i / IMPORT_CARDS_PER_ROW);
    const column = i % IMPORT_CARDS_PER_ROW;
    const rowCount = Math.min(IMPORT_CARDS_PER_ROW, total - row * IMPORT_CARDS_PER_ROW);
    // 每行按实际张数居中：最后一行不满时也居中，而不是全部靠左
    const rowWidth = rowCount * IMPORT_CARD_WIDTH + (rowCount - 1) * IMPORT_CARD_COLUMN_GAP;
    const startX = origin.x + IMPORT_CARD_WIDTH / 2 - rowWidth / 2;
    positions.push({
      x: startX + column * IMPORT_CARD_COLUMN_PITCH,
      y: origin.y + row * IMPORT_CARD_ROW_PITCH,
    });
  }
  return positions;
}
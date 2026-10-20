/**
 * 图像切分模块（网格 / 自定义切割线 → 归一化裁剪框，外加逐格导出与命名）。
 *
 * 和 imageOps.ts 一样分两层：
 * - A 层纯几何：`clampGrid` / `splitCells` / `splitCellsByLines` / `splitCellCount`，
 *   坐标一律归一化 0~1（相对原图宽高），不碰 DOM，配 `imageSplit.test.ts` 单测。
 * - B 层 canvas I/O：`splitDataUrl` 逐格复用 imageOps.ts 的 `cropDataUrl` 导出 PNG
 *   dataUrl（jsdom 没有 2D context，不写单测）。
 *
 * 模块顶层不访问 `document` / `window`，DOM 只出现在 B 层函数体里。
 *
 * 切分能力参考 basketikun/infinite-canvas（MIT License），纯函数重写：原实现
 * `web/src/components/canvas/canvas-node-split-dialog.tsx` 用 React state 存横向 / 纵向
 * 切割线位置、相邻两条线之间即一格；这里把那套"切割线模型"落成不依赖 React 的纯函数，
 * 并把等分网格统一成"生成等分切割线"的同一条路径（`splitCells` 走 `index / total`，
 * `splitCellsByLines` 走用户自定义位置）。
 */

import { cropDataUrl, type CropRect } from "./imageOps";

/** 网格切分参数（行数 × 列数） */
export interface SplitGrid {
  rows: number;
  cols: number;
}

/** 预设网格（UI 按钮直接可显示；只读，防止调用方改到常量本身） */
export type SplitPreset = {
  readonly label: string;
  readonly rows: number;
  readonly cols: number;
};

/** 切分至少要有 2 格才算"真的切了"；1×1 是合法的"不切"输入，不在这里拦截 */
export const SPLIT_MIN_CELLS = 2;

/** 行数上限 */
export const SPLIT_MAX_ROWS = 8;

/** 列数上限 */
export const SPLIT_MAX_COLS = 8;

/** 常用网格预设（都落在行列上限内） */
export const SPLIT_PRESETS: readonly SplitPreset[] = [
  { label: "2 × 2", rows: 2, cols: 2 },
  { label: "2 × 3", rows: 2, cols: 3 },
  { label: "3 × 2", rows: 3, cols: 2 },
  { label: "3 × 3", rows: 3, cols: 3 },
  { label: "4 × 4", rows: 4, cols: 4 },
];

/** 切割线去重容差（归一化坐标）：两条线间距不超过它就当同一条 */
const LINE_EPSILON = 1e-6;

/** 切割线与 0 / 1 的最小距离；更近的线会被夹掉（否则会切出零宽 / 几乎看不见的格子） */
const LINE_EDGE_MARGIN = 0.02;

/** 输出文件名里 stem 的最大长度（按码位计，避免切断 emoji 的代理对） */
const NAME_STEM_MAX = 40;

/** 文件名里不允许出现的字符（Windows 全平台通用的一套） */
const ILLEGAL_NAME_RE = /[\\/:*?"<>|]/g;

/** stem 兜底值（原名为空或全是非法字符时用） */
const FALLBACK_STEM = "image";

/** 单轴夹紧：取整 → 非有限数（NaN / ±Infinity）回落 1 → 夹到 [1, max] */
function clampAxis(value: number, max: number): number {
  const rounded = Math.round(value);
  if (!Number.isFinite(rounded)) return 1;
  return Math.min(max, Math.max(1, rounded));
}

/**
 * 把任意行列数收拢成合法网格：各自 `Math.round`，非有限数回落 1，
 * 再夹到 `[1, SPLIT_MAX_ROWS]` / `[1, SPLIT_MAX_COLS]`。
 *
 * 注意 1×1 是**合法**输入（等于不切），这里不抬到 2；"是否真的切了"由调用方用
 * `SPLIT_MIN_CELLS` 自行判断。
 */
export function clampGrid(rows: number, cols: number): SplitGrid {
  return { rows: clampAxis(rows, SPLIT_MAX_ROWS), cols: clampAxis(cols, SPLIT_MAX_COLS) };
}

/**
 * 网格切分：返回 `rows * cols` 个归一化裁剪框，**行优先**（第 0 行从左到右，再第 1 行）。
 *
 * 浮点精度：格子坐标一律用 `index / total` 直接算，不做累加（累加会漂）；每行 / 每列
 * 的最后一格用 `1 - 起点` 收尾，保证"起点 + 长度"恰好落在 1、不越界。
 */
export function splitCells(grid: SplitGrid): CropRect[] {
  const { rows, cols } = clampGrid(grid.rows, grid.cols);
  const cells: CropRect[] = [];
  for (let row = 0; row < rows; row += 1) {
    const y = row / rows;
    const height = row === rows - 1 ? 1 - y : 1 / rows;
    for (let col = 0; col < cols; col += 1) {
      const x = col / cols;
      const width = col === cols - 1 ? 1 - x : 1 / cols;
      cells.push({ x, y, width, height });
    }
  }
  return cells;
}

/** 归一化区间（左闭右开，相邻区间首尾相接） */
type Interval = { start: number; end: number };

/**
 * 切割线归一化：只留 (0,1) 开区间 → 升序排序 → 容差 `LINE_EPSILON` 去重 →
 * 夹掉距 0 / 1 不足 `LINE_EDGE_MARGIN` 的线（贴边线会切出零宽格子）。
 */
function normalizeLines(lines: readonly number[]): number[] {
  const sorted = lines
    .filter((line) => Number.isFinite(line) && line > 0 && line < 1)
    .sort((a, b) => a - b);
  const deduped: number[] = [];
  let previous = Number.NEGATIVE_INFINITY;
  for (const line of sorted) {
    if (line - previous > LINE_EPSILON) {
      deduped.push(line);
      previous = line;
    }
  }
  return deduped.filter((line) => line >= LINE_EDGE_MARGIN && 1 - line >= LINE_EDGE_MARGIN);
}

/** `[0, ...lines, 1]` 相邻成对 → 区间列表（无线时就是一个 0~1 的整区间） */
function toIntervals(lines: readonly number[]): Interval[] {
  const intervals: Interval[] = [];
  let start: number | null = null;
  for (const edge of [0, ...lines, 1]) {
    if (start !== null) intervals.push({ start, end: edge });
    start = edge;
  }
  return intervals;
}

/**
 * 自定义切割线切分：`rowLines` / `colLines` 是归一化 0~1 的**内部**切割线位置
 * （不含 0 与 1，传了也会被过滤），相邻两条线之间成一格。
 *
 * 处理顺序：只留 (0,1) → 排序 → 容差 1e-6 去重 → 夹掉距端点 < 0.02 的线。
 * 过滤后没有线就返回单个全图格子。返回 `(行线+1) × (列线+1)` 个格子，行优先。
 */
export function splitCellsByLines(rowLines: readonly number[], colLines: readonly number[]): CropRect[] {
  const rowIntervals = toIntervals(normalizeLines(rowLines));
  const colIntervals = toIntervals(normalizeLines(colLines));
  const cells: CropRect[] = [];
  for (const row of rowIntervals) {
    for (const col of colIntervals) {
      cells.push({ x: col.start, y: row.start, width: col.end - col.start, height: row.end - row.start });
    }
  }
  return cells;
}

/** 网格切分后的格子数（先 `clampGrid`，所以 1×1 返回 1、超限按上限算） */
export function splitCellCount(grid: SplitGrid): number {
  const { rows, cols } = clampGrid(grid.rows, grid.cols);
  return rows * cols;
}

/** 去掉最后一个扩展名（`a.b.png` → `a.b`；没有点或是隐藏文件名则原样返回） */
function stripExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return name;
  const separator = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  return dot > separator ? name.slice(0, dot) : name;
}

/** 去首尾空白 → 截到 `NAME_STEM_MAX` 个码位 → 空了回落 `FALLBACK_STEM` */
function toStem(name: string): string {
  const trimmed = name.trim();
  const clipped = Array.from(trimmed).slice(0, NAME_STEM_MAX).join("");
  return clipped.length > 0 ? clipped : FALLBACK_STEM;
}

/**
 * 生成单格输出文件名：`<stem>-<rows>x<cols>-<index>.png`（index 1 基），
 * 例如 2×2 网格的第 3 张是 `红苹果-2x2-3.png`。
 *
 * - `baseName` 去扩展名（只认最后一个 `.`，且必须在路径分隔符之后）
 * - 非法字符 `\ / : * ? " < > |` 一律换成 `_`
 * - stem 去首尾空白后截到 40 字符；仍为空则回落 `image`
 * - `total` 只用于调用方一致性校验：与 `rows * cols` 不符时**仍按传入的 rows/cols
 *   命名**，不报错
 */
export function splitOutputName(baseName: string, index: number, total: number, rows: number, cols: number): string {
  // total 只做一致性校验（见上），命名不依赖它；显式读一次以免被当成未使用参数。
  void total;
  const stem = toStem(stripExtension(baseName).replace(ILLEGAL_NAME_RE, "_"));
  const ordinal = Number.isFinite(index) ? Math.max(1, Math.round(index)) : 1;
  return `${stem}-${rows}x${cols}-${ordinal}.png`;
}

/**
 * 逐格导出：对 `splitCells(grid)` 的每个格子调 imageOps.ts 的 `cropDataUrl` 导出 PNG
 * dataUrl，全部完成后按**与 `splitCells` 相同的顺序**返回。
 *
 * `cropDataUrl` 是静态 import —— 动态 import 会与模块顶部的静态 import 混用，
 * vite 会报 "dynamic import will not move module into another chunk" 一类警告。
 */
export async function splitDataUrl(dataUrl: string, grid: SplitGrid): Promise<string[]> {
  return Promise.all(splitCells(grid).map((crop) => cropDataUrl(dataUrl, crop)));
}

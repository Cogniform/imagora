/**
 * data URL ↔ File 的转换工具。
 *
 * 存在的理由：裁剪 / 放大对话框（ImageCropDialog / ImageUpscaleDialog）用 canvas 导出
 * 结果，拿到的必然是 `data:image/png;base64,...` 形式的 data URL；而画布上传接口
 * `canvasUpload(files: File[])` 只收 `File`。这一层转换放在独立模块里，既能单测，
 * 也不把 `atob` / `Blob` 这类浏览器 API 撒进 1700 行的 CanvasPage.tsx。
 *
 * 模块顶层不访问 DOM，纯字符串处理 + 标准 Blob/File 构造。
 */

/** 派生图的文件名前缀（用于在输出目录里一眼看出这张图是加工来的） */
export type DerivedPrefix = "crop" | "upscale" | "split";

const DATA_URL_RE = /^data:([^;,]*)((?:;[^,]*)?),(.*)$/s;

/** base64 字母表快速校验（含 padding）；不匹配就走百分号解码分支 */
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * 把 data URL 还原成 `File`，供 `canvasUpload` 上传。
 *
 * 支持两种载荷：
 * - `data:image/png;base64,AAAA...`（canvas `toDataURL` 的产物，本项目的唯一来源）
 * - `data:image/svg+xml,%3Csvg...`（百分号编码，SVG 常见；顺带支持，不额外成本）
 *
 * 非法输入抛错而不是返回空 File —— 上传一张 0 字节的图会让画布多出一个永远加载
 * 失败的红框节点，不如当场失败让调用方提示。
 */
export function dataUrlToFile(dataUrl: string, fileName: string): File {
  const matched = DATA_URL_RE.exec(dataUrl);
  if (!matched) {
    throw new Error("不是合法的 data URL");
  }
  const mime = (matched[1] ?? "").trim() || "image/png";
  const params = matched[2] ?? "";
  const payload = matched[3] ?? "";
  const bytes = params.includes(";base64") ? decodeBase64(payload) : decodePercent(payload);
  if (bytes.length === 0) {
    throw new Error("data URL 内容为空");
  }
  return new File([bytes], fileName, { type: mime });
}

/** base64 → 字节；`atob` 对空白宽容但对手误不宽容，这里先剔除换行再判字母表 */
function decodeBase64(payload: string): Uint8Array {
  const compact = payload.replace(/\s+/g, "");
  if (!BASE64_RE.test(compact)) {
    throw new Error("data URL 的 base64 段含非法字符");
  }
  const binary = atob(compact);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** 百分号编码 → 字节（非 base64 的 data URL） */
function decodePercent(payload: string): Uint8Array {
  const text = decodeURIComponent(payload);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    bytes[i] = text.charCodeAt(i) & 0xff;
  }
  return bytes;
}

/**
 * 生成派生图文件名，形如 `crop-红苹果-20261020-131045.png`。
 *
 * 为什么带时间戳而不是 `-1`/`-2` 序号：序号需要先查目录里已有多少张，等于为了取名
 * 多一次网络往返；时间戳（秒级）在本机单用户场景下重名概率可忽略，真撞了后端注册表
 * 也会按内容哈希去重。
 *
 * `at` 可注入便于单测；不传取当前时间。
 */
export function derivedImageName(
  sourceName: string,
  prefix: DerivedPrefix,
  at: Date = new Date(),
): string {
  const stem = sourceName.replace(/\.[^./\\]+$/, "").trim() || "image";
  // Windows 文件名禁用字符 + 冒号（时间戳里的冒号会把路径切断）
  const safe = stem.replace(/[\\/:*?"<>|]/g, "_").slice(0, 40);
  return `${prefix}-${safe}-${compactStamp(at)}.png`;
}

/** `YYYYMMDD-HHmmss`，本地时间（用户看输出目录时对得上自己动手的时刻） */
function compactStamp(at: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const date = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `${date}-${time}`;
}

/**
 * 一次产出多张派生图（切分）的文件名，形如
 * `split-红苹果-20261020-131045-1.png`、`...-2.png`。
 *
 * 为什么不能直接对每张调 `derivedImageName`：它的时间戳只到秒，同一批切分必然
 * 落在同一秒，多张图会拿到**同一个文件名**（上传时互相覆盖，画布上只剩一张）。
 * 所以批量场景必须带序号；序号从 1 开始、按传入顺序连续，与 `splitCells` 的
 * 行优先顺序一致，用户看文件名就能对回原图的位置。
 */
export function derivedImageSeries(
  sourceName: string,
  prefix: DerivedPrefix,
  count: number,
  at: Date = new Date(),
): string[] {
  const total = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (total === 0) return [];
  const stem = sourceName.replace(/\.[^./\\]+$/, "").trim() || "image";
  const safe = stem.replace(/[\\/:*?"<>|]/g, "_").slice(0, 40);
  const stamp = compactStamp(at);
  const names: string[] = [];
  for (let i = 1; i <= total; i += 1) {
    names.push(`${prefix}-${safe}-${stamp}-${i}.png`);
  }
  return names;
}

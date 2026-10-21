/**
 * 提示词 `@` 引用 —— 让用户能指定「这次只用这几张图」，而不是沿入边全收集。
 *
 * ## 三条语义（缺一不可，改任何一条都会让既有工作流静默产出不同结果）
 *
 * 1. 提示词里**一个有效引用都没有** → 调用方保持旧行为（沿入边全收集）。
 *    既有工作流的提示词里没有 `@`，此时若改成「只用 0 张图」，每个老工作流都会
 *    从图生图变成文生图。
 * 2. **至少一个有效引用** → 只用被引用的那几张（按提示词里的出现顺序去重）。
 * 3. 写了 `@` 却**一个都对不上**图片节点名 → `mode === "invalid"`，由调用方报错中止。
 *    静默回退到全收集会让用户以为引用生效了，实际用的是别的图。
 *
 * ## 语法
 *
 * - 简单形式 `@cat.png`：名字字符集 `[\w\u4e00-\u9fa5.-]`（字母数字下划线 / 中文 / 点 / 横线），
 *   **遇空格即停** —— 所以带空格的名字必须用花括号形式；
 * - 花括号形式 `@{my cat.png}`：`@` 后紧跟 `{`，读到下一个 `}` 为止（名字内部不能含 `}`）；
 * - `@@` 是转义：`@@foo` 表示字面量 `@foo`，不算引用；
 * - `@` 前面必须是行首、空白或标点，**不能紧贴字母/数字** ——
 *   否则 `user@example.com` 会被当成引用 `@example`。
 *
 * 本模块是纯函数：不做 IO、不抛异常，解析结果交给调用方决定怎么用。
 */

/** 可被引用的候选（画布图片节点：id 是节点 id，name 是文件名） */
export interface PromptRefCandidate {
  id: string;
  name: string;
}

/** 解析出的一个引用 token：`name` 是名字原文，`[start, end)` 是它在文本里的区间 */
export interface PromptRefToken {
  name: string;
  start: number;
  end: number;
}

/** 解析 + 匹配结果：`all` 保持旧行为，`explicit` 只用 ids，`invalid` 有对不上的名字 */
export interface PromptRefResolution {
  mode: "all" | "explicit" | "invalid";
  ids: string[];
  unknown: string[];
}

/** 引用触发符：提示词里写 `@名字` 表示「只用这张图」 */
export const PROMPT_REF_TRIGGER = "@";

/** 简单形式的名字字符集（单个字符；`.`, `-` 放在末尾避免被当成区间） */
const SIMPLE_NAME_CHAR_RE = /[\w\u4e00-\u9fa5.-]/;
/** 整串都是简单形式字符 —— {@link promptRefInsertion} 的判据 */
const SIMPLE_NAME_RE = /^[\w\u4e00-\u9fa5.-]+$/;
/** 紧贴在 `@` 前面会让它变成「词内 @」的字符（邮箱就靠这条挡掉） */
const LETTER_OR_DIGIT_RE = /[\p{L}\p{N}]/u;

/** 扫描事件：引用 token 或 `@@` 转义（{@link stripPromptRefs} 要按原位置重建文本） */
type RefScanEvent =
  | { kind: "ref"; token: PromptRefToken }
  | { kind: "escape"; start: number; end: number };

/** `@` 前面这一字符是否允许起引用：行首 / 空白 / 标点都行，字母数字不行 */
function isRefBoundary(prev: string | undefined): boolean {
  if (prev === undefined) return true;
  return !LETTER_OR_DIGIT_RE.test(prev);
}

/** 名字归一：两侧 trim + 折叠内部空白（比较用，不做大小写归一 —— 图片名大小写敏感）。
 *  规则与 `customValue.normalizeCustomValue` 一致，但**刻意不 import**：
 *  图片名的匹配规则不该随「下拉框自由输入」的归一化策略一起漂移。 */
function normalizeRefName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

/** 单趟左到右扫描，产出引用与转义事件（解析与去花括号共用同一套判定，不会走偏） */
function scanPromptRefs(text: string): RefScanEvent[] {
  const events: RefScanEvent[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== PROMPT_REF_TRIGGER) {
      i += 1;
      continue;
    }
    const next = text[i + 1];
    // `@@`：字面量 `@`，不算引用（strip 要还原成单个 `@`）
    if (next === PROMPT_REF_TRIGGER) {
      events.push({ kind: "escape", start: i, end: i + 2 });
      i += 2;
      continue;
    }
    // 花括号形式：读到下一个 `}` 为止
    if (next === "{") {
      const close = text.indexOf("}", i + 2);
      if (close === -1) {
        // 未闭合的 `{`：整段当字面量（不产生 token，避免把普通文本误判成引用）
        i += 1;
        continue;
      }
      const name = text.slice(i + 2, close);
      if (name.trim() !== "" && isRefBoundary(text[i - 1])) {
        events.push({ kind: "ref", token: { name, start: i, end: close + 1 } });
      }
      i = close + 1;
      continue;
    }
    // 简单形式：贪心吃到第一个非名字字符（空格、标点等）为止
    if (next !== undefined && SIMPLE_NAME_CHAR_RE.test(next)) {
      let end = i + 1;
      while (end < text.length) {
        const ch = text[end];
        if (ch === undefined || !SIMPLE_NAME_CHAR_RE.test(ch)) break;
        end += 1;
      }
      if (isRefBoundary(text[i - 1])) {
        events.push({ kind: "ref", token: { name: text.slice(i + 1, end), start: i, end } });
      }
      i = end;
      continue;
    }
    // 孤立 `@`（后面没有名字）：字面量
    i += 1;
  }
  return events;
}

/** 解析提示词里的引用 token（按出现顺序；`@@` 转义与孤立 `@` 不算引用） */
export function parsePromptRefs(text: string): PromptRefToken[] {
  const tokens: PromptRefToken[] = [];
  for (const event of scanPromptRefs(text)) {
    if (event.kind === "ref") tokens.push(event.token);
  }
  return tokens;
}

/**
 * 解析 + 对候选名匹配。
 *
 * - 0 个 token → `{ mode: "all" }`（调用方保持「沿入边全收集」的旧行为）；
 * - 全部对上 → `{ mode: "explicit", ids }`（按出现顺序去重）；
 * - 有对不上的 → `{ mode: "invalid", ids, unknown }`（ids 仍返回能对上的，由调用方决定是否中止）。
 *
 * 名字匹配是**精确匹配**（区分大小写），两边先 trim + 折叠空白；
 * 同名候选（画布上两个节点同名）全部计入，不静默丢掉其中一个。
 */
export function resolvePromptRefs(
  text: string,
  candidates: readonly PromptRefCandidate[],
): PromptRefResolution {
  const tokens = parsePromptRefs(text);
  if (tokens.length === 0) return { mode: "all", ids: [], unknown: [] };

  // 名字 -> 候选 id（同名候选按给出顺序全部保留）
  const idsByName = new Map<string, string[]>();
  for (const candidate of candidates) {
    const key = normalizeRefName(candidate.name);
    if (key === "") continue;
    const bucket = idsByName.get(key);
    if (bucket === undefined) {
      idsByName.set(key, [candidate.id]);
    } else if (!bucket.includes(candidate.id)) {
      bucket.push(candidate.id);
    }
  }

  const ids: string[] = [];
  const seenIds = new Set<string>();
  const unknown: string[] = [];
  const seenUnknown = new Set<string>();
  for (const token of tokens) {
    const key = normalizeRefName(token.name);
    const matched = idsByName.get(key);
    if (matched === undefined) {
      if (!seenUnknown.has(key)) {
        seenUnknown.add(key);
        unknown.push(key);
      }
      continue;
    }
    for (const id of matched) {
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      ids.push(id);
    }
  }

  if (unknown.length > 0) return { mode: "invalid", ids, unknown };
  return { mode: "explicit", ids, unknown: [] };
}

/** 把名字插进提示词时该写什么：能被简单形式完整匹配就 `@name`，否则 `@{name}` */
export function promptRefInsertion(name: string): string {
  const trimmed = name.trim();
  if (SIMPLE_NAME_RE.test(trimmed)) return PROMPT_REF_TRIGGER + trimmed;
  return PROMPT_REF_TRIGGER + "{" + trimmed + "}";
}

/**
 * 去掉引用语法，还原成给上游模型看的纯文本：`@{cat.png}` → `@cat.png`，`@@` → `@`。
 *
 * 用途：上游模型不认识花括号写法，会把 `@{cat.png}` 当乱码。运行时发给上游的
 * 提示词必须是 `stripPromptRefs(prompt)`，而不是原始 prompt。
 */
export function stripPromptRefs(text: string): string {
  const events = scanPromptRefs(text);
  if (events.length === 0) return text;
  const out: string[] = [];
  let cursor = 0;
  for (const event of events) {
    const start = event.kind === "ref" ? event.token.start : event.start;
    const end = event.kind === "ref" ? event.token.end : event.end;
    out.push(text.slice(cursor, start));
    out.push(event.kind === "ref" ? PROMPT_REF_TRIGGER + event.token.name : PROMPT_REF_TRIGGER);
    cursor = end;
  }
  out.push(text.slice(cursor));
  return out.join("");
}

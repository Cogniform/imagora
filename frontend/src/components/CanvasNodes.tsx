import { memo, useEffect, useState, type ReactNode } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { Brush, Crop, Eye, Maximize2, RefreshCw, Scissors, Trash2 } from "lucide-react";
import type { CanvasGroupNodeData, CanvasImageNodeData, CanvasPromptNodeData } from "../types";
import { ratioFromSizeLabel } from "../aspectIcon";
import { mergeCustomOption } from "../customValue";
import { generatingLabel } from "../format";
import { AspectIcon } from "./AspectIcon";
import { FolderPicker } from "./FolderPicker";
import { GenerationPending } from "./GenerationPending";
import { Select, type SelectOption } from "./Select";

/**
 * 尺寸下拉行左侧的比例预览图标。
 *
 * 尺寸标签是「1024x1536 (2:3 竖版)」这种文字，光看数字判断不出横竖；配一个按真实
 * 宽高比缩放的空心矩形，扫一眼就知道哪条是横的。比例从标签里反解（`ratioFromSizeLabel`
 * 纯函数，有单测），解析不到时返回 null、图标不渲染 —— 宁可没有，也不画个正方形
 * 暗示「这是 1:1」。
 *
 * 只有尺寸下拉用，质量下拉（low/medium/high）不传 `renderOption`，保持纯文字。
 */
function sizeOptionIcon(option: SelectOption): ReactNode {
  return <AspectIcon ratio={ratioFromSizeLabel(option.label)} className="text-neutral-400" />;
}

/* ---------------- 统一节点右侧操作区（hover 显示，竖排不遮挡内容，全部 nodrag 防误拖） ----------------
 * 这里同时修掉两个真实缺陷，改动都集中在这一处，别退回 `ml-2` + 裸 `opacity-0` 的老写法：
 *
 * 1) **hover 闪断**：老写法用 `ml-2` 留出 8px 空隙，鼠标从节点移向按钮的途中会短暂落在
 *    画布上，`.group:hover` 断开 → 操作栏淡出 → 再进入又淡入，看起来在闪。
 *    修法：容器**不留外边距**（`left-full` 起于节点右缘，零几何间隙），8px 视觉间距改由容器
 *    自身的 `pl-2` 内边距提供。内边距属于容器盒子，鼠标落在里面仍算 hover 在 `.group` 的
 *    后代上，整段路径连续，不再有真空。
 *
 * 2) **隐形按钮吃点击**：`opacity: 0` 的元素**依然参与命中测试**，老写法等于在每张图右侧
 *    常驻一排看不见却可点的按钮，点画布空白会误触。修法：隐藏态加 `pointer-events-none`，
 *    悬停节点时再用 `group-hover:pointer-events-auto` 放开。
 *    **刻意不用 `invisible`**（`visibility: hidden`）：它会把按钮从无障碍树里摘掉，
 *    E2E 的 `get_by_role("button", { name: "裁剪图片" })` 与读屏器都会查不到；而 `opacity: 0`
 *    不影响无障碍树，只有命中测试被 `pointer-events` 拦下，两者互不干扰。
 *    顺序上也安全：鼠标直接移到按钮区域时容器仍是 `pointer-events-none`，点击穿透到画布，
 *    正是想要的行为；只有先悬停节点、容器放开之后，移入按钮才接得上 hover。
 *
 * 竖排而非横排：横排会在 380px 宽的提示词卡上方压住邻居节点，竖排只占右侧一条窄带。 */
function NodeActions({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div
      data-testid={testId}
      className="absolute left-full top-2 z-30 flex flex-col gap-1 surface-float rounded-lg border border-white/40 p-1 pl-2 shadow-sm opacity-0 pointer-events-none transition-opacity group-hover:pointer-events-auto group-hover:opacity-100"
    >
      {children}
    </div>
  );
}

function ActionButton({
  onClick,
  danger,
  label,
  children,
}: {
  onClick: () => void;
  danger?: boolean;
  label?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`nodrag btn-ghost btn-icon btn-icon--sm p-0 ${danger ? "btn-danger" : ""}`}
    >
      {children}
    </button>
  );
}

/* ---------------- 三类节点共用的连接把手：顶部接收上游、底部输出下游 ----------------
 * 样式收敛到这一处（尺寸交给画布 zoom 样式，见 CanvasNodes.test.tsx 的回归断言）。
 * Fragment 不产生 DOM 节点——两个把手仍是节点根 div 的直接子元素，绝对定位与
 * React Flow 的 handle 注册（走 context，不走 DOM 父子）均不受影响。 */
function NodeHandles() {
  return (
    <>
      <Handle
        type="target"
        position={Position.Top}
        className="!rounded !border-0 !bg-brand/90"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        className="!rounded !border-0 !bg-brand"
      />
    </>
  );
}

/* ---------------- 图片节点：固定宽度、高度按图片比例自适应 ---------------- */
export type ImageFlowNode = Node<CanvasImageNodeData, "image">;

interface ImageNodeExtraProps {
  /** 替换图片（换一张图，旧文件保留） */
  onReplace: (nodeId: string) => void;
  /** 删除节点（仅移除节点与连线，不删文件） */
  onDelete: (nodeId: string) => void;
  /** 放大预览 */
  onZoom: (nodeId: string) => void;
  /** 裁剪（产出新图，旧图保留） */
  onCrop: (nodeId: string) => void;
  /** 放大像素（产出新图，旧图保留） */
  onUpscale: (nodeId: string) => void;
  /** 切分（按网格切成多张新图，旧图保留） */
  onSplit: (nodeId: string) => void;
  /** 蒙版（涂出重绘区域，产出新图，旧图保留） */
  onMask: (nodeId: string) => void;
  /** 清除这张图上的蒙版（蒙版会一直跟着图走，必须给一个显眼的撤销入口） */
  onClearMask: (nodeId: string) => void;
}

export const ImageNode = memo(function ImageNode({
  id,
  data,
  selected,
  lod,
  onReplace,
  onDelete,
  onZoom,
  onCrop,
  onUpscale,
  onSplit,
  onMask,
  onClearMask,
}: NodeProps<ImageFlowNode> & ImageNodeExtraProps & { lod?: boolean | undefined }) {
  // lod / normal 两分支共用的三段片段（原为两份逐字相同的内联 JSX）
  const missingBadge = data.missing ? (
    <span className="chip chip--sm chip--danger absolute right-1 top-1 z-20">
      文件缺失
    </span>
  ) : null;
  // 蒙版角标：蒙版会一直跟着这张图走，后续每次「以它为参考图」都按蒙版重绘。
  // 没有可见提示的话用户会忘掉自己设过，生成结果不对还找不到原因 —— 所以角标
  // 本身就是一个按钮，点一下清除。放在左上角（右上角已被「文件缺失」占用）。
  const maskBadge = data.maskDataUrl ? (
    <button
      type="button"
      className="chip chip--sm chip--brand nodrag absolute left-1 top-1 z-20"
      title="这张图已设蒙版（局部重绘）。点击清除"
      aria-label="清除蒙版"
      onClick={(event) => {
        event.stopPropagation();
        onClearMask(id);
      }}
    >
      蒙版
    </button>
  ) : null;
  // 固定展示框避免图片加载后撑高节点，object-contain 保留完整画面。
  const thumb = (
    <div
      className="h-40 w-32 cursor-zoom-in overflow-hidden rounded bg-neutral-50"
      onDoubleClick={(event) => {
        event.stopPropagation();
        onZoom(id);
      }}
    >
      {data.url ? (
        <img src={data.url} alt={data.name} loading="lazy" decoding="async" className="block h-full w-full object-contain" draggable={false} />
      ) : (
        <div className="flex h-full w-full items-center justify-center p-2 text-center text-[11px] text-red-500">
          图片缺失
        </div>
      )}
    </div>
  );
  const meta = (
    <>
      <div className="mt-1 max-w-[128px] truncate text-[11px] text-neutral-600" title={data.name}>
        {data.name}
      </div>
      <div className={`text-[11px] ${data.refCount > 0 ? "text-brand" : "text-neutral-400"}`}>
        {data.refCount > 0 ? `引用 ${data.refCount} 处` : "未引用"}
      </div>
    </>
  );
  // LOD 抽象模式：保留缩略图、双击放大与名称/引用行，去掉右侧操作栏与 node-pop 入场动画（节点多时轻量渲染）
  if (lod) {
    return (
      <div
        className={`panel-card relative !p-2 ${data.missing ? "!border-red-400" : ""} ${
          selected ? "node-selected" : ""
        }`}
      >
        <NodeHandles />
        {missingBadge}
        {maskBadge}
        {thumb}
        {meta}
      </div>
    );
  }
  return (
    <div
      className={`panel-card group relative !p-2 node-pop ${data.missing ? "!border-red-400" : ""} ${
        selected ? "node-selected" : ""
      }`}
    >
      {/* 顶部接收提示词产出；底部作为参考图输出。 */}
      <NodeHandles />
      {missingBadge}
      {maskBadge}
      {/* 图片专用操作区：悬停时在右侧显示，不遮挡图片。 */}
      <NodeActions testId="image-action-rail">
        <ActionButton label="预览大图" onClick={() => onZoom(id)}>
          <Eye aria-hidden="true" size={14} />
        </ActionButton>
        <ActionButton label="裁剪图片" onClick={() => onCrop(id)}>
          <Crop aria-hidden="true" size={14} />
        </ActionButton>
        <ActionButton label="放大图片" onClick={() => onUpscale(id)}>
          <Maximize2 aria-hidden="true" size={14} />
        </ActionButton>
        <ActionButton label="切分图片" onClick={() => onSplit(id)}>
          <Scissors aria-hidden="true" size={14} />
        </ActionButton>
        <ActionButton label="蒙版重绘" onClick={() => onMask(id)}>
          <Brush aria-hidden="true" size={14} />
        </ActionButton>
        <ActionButton label="替换图片" onClick={() => onReplace(id)}>
          <RefreshCw aria-hidden="true" size={14} />
        </ActionButton>
        <ActionButton label="删除图片" onClick={() => onDelete(id)} danger>
          <Trash2 aria-hidden="true" size={14} />
        </ActionButton>
      </NodeActions>
      {thumb}
      {meta}
    </div>
  );
});

/* ---------------- 图片组节点：聚合多张图片后统一连到提示词节点 ---------------- */
export type GroupFlowNode = Node<CanvasGroupNodeData, "group">;

interface GroupNodeExtraProps {
  onDelete: (nodeId: string) => void;
}

export const GroupNode = memo(function GroupNode({
  id,
  data,
  selected,
  lod,
  onDelete,
}: NodeProps<GroupFlowNode> & GroupNodeExtraProps & { lod?: boolean | undefined }) {
  const mb = data.totalSize > 0 ? (data.totalSize / (1024 * 1024)).toFixed(1) : "0.0";
  // 去重标签：组链聚合含重复图片时（同一张图经多条路径到达），数字已是去重后实际张数，仅打标提示；
  // 配色跟随动态主体色（bg-brand/10 + text-brand，与组卡 bg-brand/5 同族，不引入孤立色相）
  const dup = data.duplicateCount ?? 0;
  const dupBadge = dup > 0 ? (
    <span
      className="chip chip--sm chip--brand mt-1"
      title={`已去重 ${dup} 张重复图片`}
    >
      去重
    </span>
  ) : null;
  /* 叠卡：用几张错位的背景卡把「这是一组、里面有 N 张」直接画出来，不靠读数字。
   *
   * 参考 basketikun/infinite-canvas 的 BatchFrame（MIT）：纯 CSS、零状态、零布局计算 ——
   * 只是几个绝对定位的 div 平移 + 微旋转，不参与 React Flow 的节点尺寸测量。
   *
   * 为什么要夹到 3 张：张数是数据，不能直接当渲染数量 —— 一个 40 张图的组会渲染 39 层
   * 叠卡，每层都是独立合成层，缩放时帧率会掉。夹到 3 张之后「3 张以上」在视觉上是同一个
   * 意思（后面还有很多），用数字补足精度。
   *
   * z 序靠 DOM 顺序而不是 z-index：叠卡写在 body 之前，后绘制的 body 自然压在上面；
   * 父元素没有 z-index 也就没有层叠上下文，写负 z-index 反而会被父元素背景盖住。
   */
  const stackCount = Math.min(Math.max(data.imageCount - 1, 0), 3);
  const stackCards = Array.from({ length: stackCount }, (_, index) => (
    <div
      key={index}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 rounded-lg"
      style={{
        transform: `translate(${10 + index * 6}px, ${4 + index * 3}px) rotate(${1.5 + index}deg)`,
        background: "color-mix(in srgb, var(--color-brand) 9%, transparent)",
        boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--color-brand) 14%, transparent)",
      }}
    />
  ));
  const body = (
    <div className="relative py-2 text-center">
      <div className="text-xl font-semibold leading-tight text-brand-dark">
        {data.imageCount} 张图
      </div>
      <div className="mt-1 text-base text-neutral-500">{mb} MB</div>
      {dupBadge}
    </div>
  );
  // LOD 抽象模式：去掉 hover 删除栏，只保留组本体（组节点本身已足够轻量）
  if (lod) {
    return (
      <div
        className={`relative w-56 rounded-lg bg-brand/5 !p-4 ${selected ? "node-selected" : ""}`}
      >
        <NodeHandles />
        {stackCards}
        {body}
      </div>
    );
  }
  return (
    <div
      className={`group relative w-56 rounded-lg bg-brand/5 !p-4 node-pop ${selected ? "node-selected" : ""}`}
    >
      {/* 顶部接收图片，底部输出到提示词。 */}
      <NodeHandles />
      {stackCards}
      <NodeActions>
        <ActionButton label="删除图片组" onClick={() => onDelete(id)} danger>
          <Trash2 aria-hidden="true" size={14} />
        </ActionButton>
      </NodeActions>
      {body}
    </div>
  );
});

/* ---------------- 提示词节点 ---------------- */
export type PromptFlowNode = Node<CanvasPromptNodeData, "prompt">;

interface PromptNodeExtraProps {
  /** 节点参数就地更新（上抛给画布 setNodes） */
  onUpdate: (nodeId: string, patch: Partial<CanvasPromptNodeData>) => void;
  /** 运行该节点（独立任务，入边快照参考图） */
  onRun: (nodeId: string) => void;
  /** 删除该节点（连同其连线） */
  onDelete: (nodeId: string) => void;
  /** 尺寸/质量选项（由画布 config 派生传入） */
  sizeOptions: { value: string; label: string }[];
  qualityOptions: { value: string; label: string }[];
  /** 当前模型是否认质量档位（豆包 Seedream 不认 → 不渲染那一栏）；缺省按 true 处理 */
  qualityEffective?: boolean | undefined;
}

type PromptNodeProps = NodeProps<PromptFlowNode> & PromptNodeExtraProps;

/* 秒数文字：以 startedAtMs 锚定、组件内部每秒自计时刷新——只重渲染自身文字，
 * 不触碰状态灯 / 卡片其余部分（原逐秒写节点 data 导致悬停闪烁）。 */
function ElapsedText({ startedAtMs }: { startedAtMs?: number | undefined }) {
  const [seconds, setSeconds] = useState(() =>
    startedAtMs ? Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000)) : 0,
  );
  useEffect(() => {
    if (!startedAtMs) return;
    const timer = window.setInterval(() => {
      setSeconds(Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [startedAtMs]);
  return <>{generatingLabel(seconds)}</>;
}

/* 生成中占位卡：生成期间顶替结果区，让「已提交、还没回图」这段时间有可见的推进感。
 * 秒数以节点上的 startedAtMs 为准（画布在 queued→running 转换时写一次），
 * **不让占位卡自己从 0 走表**——否则切后台再回来、或卡片重挂载时秒数会倒退重来（受控优先）。
 * 锚点缺失（离线的旧工作流）才退化为自计时。 */
function PendingSeconds({ startedAtMs }: { startedAtMs?: number | undefined }) {
  const anchor = startedAtMs ?? null;
  const [seconds, setSeconds] = useState(() => (anchor ? Math.max(0, Math.floor((Date.now() - anchor) / 1000)) : 0));
  useEffect(() => {
    if (!anchor) return;
    const timer = window.setInterval(() => {
      setSeconds(Math.max(0, Math.floor((Date.now() - anchor) / 1000)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [anchor]);
  return <GenerationPending elapsed={anchor ? seconds : undefined} testId={`prompt-pending-${anchor ?? "live"}`} />;
}

/* 状态指示灯：圆点颜色映射状态，悬停 title 看详情（张数 / 失败原因），
 * 就绪灰、排队琥珀、生成中品牌色呼吸、完成绿、失败红。
 * 生成中的秒数刻意不进 title（挂 tooltip 每秒跳字 → 悬停闪烁），秒数只在运行按钮文字上走。 */
function StatusLight({ data }: { data: CanvasPromptNodeData }) {
  let color = "bg-neutral-300";
  let pulse = "";
  let title = "就绪";
  switch (data.status) {
    case "queued":
      color = "bg-amber-400";
      title = "排队中";
      break;
    case "running":
      color = "bg-brand";
      pulse = "animate-pulse";
      title = "生成中";
      break;
    case "done":
      color = "bg-green-500";
      title = `完成 · ${data.resultCount ?? 0} 张`;
      break;
    case "failed":
      color = "bg-red-500";
      title = data.message ? `失败：${data.message}` : "失败";
      break;
  }
  return (
    <span className="flex justify-center py-0.5" title={title}>
      <span className={`h-2.5 w-2.5 rounded-full ${color} ${pulse}`} />
    </span>
  );
}

/** LOD 抽象模式的提示词状态摘要：居中大字展示；title 带完整详情 */
function promptStatusSummary(data: CanvasPromptNodeData): { text: string; detail: string; className: string } {
  switch (data.status) {
    case "queued":
      return { text: "排队中", detail: "排队中", className: "text-amber-500" };
    case "running":
      return {
        text: "生成中",
        detail: "生成中",
        className: "animate-pulse text-brand",
      };
    case "done":
      return {
        text: `完成 · ${data.resultCount ?? 0} 张`,
        detail: `完成 · ${data.resultCount ?? 0} 张`,
        className: "text-green-600",
      };
    case "failed":
      return { text: "失败", detail: data.message ? `失败：${data.message}` : "失败", className: "text-red-500" };
    default:
      return { text: "就绪", detail: "就绪", className: "text-neutral-400" };
  }
}

export const PromptNode = memo(function PromptNode({
  id,
  data,
  selected,
  lod,
  onUpdate,
  onRun,
  onDelete,
  sizeOptions,
  qualityOptions,
  qualityEffective = true,
}: PromptNodeProps & { lod?: boolean | undefined }) {
  const running = data.status === "running";
  const queued = data.status === "queued";
  const busy = running || queued;
  // LOD 抽象模式：标题大字 + 状态居中，不可编辑、无运行按钮；保留连接把手与拖拽
  if (lod) {
    const summary = promptStatusSummary(data);
    return (
      <div
        className={`panel-card flex min-h-[320px] !w-[380px] flex-col items-center justify-center gap-3 !p-3 ${selected ? "node-selected" : ""}`}
      >
        <NodeHandles />
        <div
          className="max-w-full truncate text-center text-3xl font-semibold leading-tight text-brand-dark"
          title={data.title ?? "提示词生成"}
        >
          {data.title ?? "提示词生成"}
        </div>
        <div className={`max-w-full truncate text-center text-xl font-medium ${summary.className}`} title={summary.detail}>
          {running ? <ElapsedText startedAtMs={data.startedAtMs} /> : summary.text}
        </div>
        {/* 抽象模式不渲染表单，占位卡缩到一行内联条，只保留「在动」的观感，不抢标题的视觉重量 */}
        {running && (
          <div className="w-full px-2">
            <PendingSeconds startedAtMs={data.startedAtMs} />
          </div>
        )}
      </div>
    );
  }
  return (
    <div className={`panel-card group relative !w-[380px] min-w-0 !p-3 node-pop ${selected ? "node-selected" : ""}`}>
      {/* 顶部接收参考图，底部输出生成结果。 */}
      <NodeHandles />
      {/* 右侧统一操作区：状态灯 + 删除 */}
      <NodeActions>
        <StatusLight data={data} />
        <ActionButton label="删除" onClick={() => onDelete(id)} danger>
          <Trash2 aria-hidden="true" size={14} />
        </ActionButton>
      </NodeActions>
      {/* 标题只做定位标签：完整提示词就在下方 textarea 里可见可编辑，
          不再挂 title —— 原生 tooltip 画在顶层，会压住 z-index 1001 的 hover 操作栏。 */}
      <div className="mb-2 truncate text-xs font-semibold text-brand-dark">
        {data.title ?? "提示词生成"}
      </div>
      <textarea
        value={data.prompt}
        onChange={(e) => onUpdate(id, { prompt: e.target.value })}
        rows={5}
        placeholder="英文提示词，例如：a red apple on white background"
        className="nodrag field-control resize-y text-xs leading-relaxed"
      />
      <div className={`nodrag mt-2 grid gap-2 ${qualityEffective ? "grid-cols-[7fr_3fr]" : "grid-cols-1"}`}>
        <div className="min-w-0">
          <label className="field-label-compact">尺寸</label>
          <Select
            options={mergeCustomOption(sizeOptions, data.size)}
            value={data.size}
            onChange={(v) => onUpdate(id, { size: v })}
            // 自由输入：清单只有固定几档，而上游常认清单外的尺寸（1280x720 之类）。
            // 不校验格式 —— 前端猜格式就会拦掉合法值，错值让上游去报错更好（见 customValue.ts 文件头）。
            searchable
            allowCustom
            onCreateCustom={(v) => onUpdate(id, { size: v })}
            renderOption={sizeOptionIcon}
            className="mt-0.5"
          />
        </div>
        {qualityEffective && (
          <div className="min-w-0">
            <label className="field-label-compact">质量</label>
            <Select
              options={qualityOptions}
              value={data.quality}
              onChange={(v) => onUpdate(id, { quality: v })}
              className="mt-0.5"
            />
          </div>
        )}
      </div>
      <div className="nodrag mt-2">
        <label className="field-label-compact">输出路径</label>
        <div className="mt-0.5">
          <FolderPicker value={data.outputDir} onChange={(v) => onUpdate(id, { outputDir: v })} alignEnd />
        </div>
      </div>
      {/* 生成中占位卡：顶替结果区的位置。只有 running 才挂载（queued 还没开始计时，
          自计时从挂载那刻起算，提前挂载会把排队时间算成生成时间）。 */}
      {running && (
        <div className="nodrag mb-2">
          <PendingSeconds startedAtMs={data.startedAtMs} />
        </div>
      )}
      <div className="nodrag mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => onRun(id)}
          disabled={busy || !data.prompt.trim()}
          className={`btn-primary btn-sm flex-1 ${busy ? "btn-busy" : ""}`}
        >
          {running ? <ElapsedText startedAtMs={data.startedAtMs} /> : queued ? "排队中..." : "运行"}
        </button>
      </div>
    </div>
  );
});

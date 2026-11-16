// 错误边界：把「一处渲染失败」的影响限制在最小范围。
//
// 为什么必须有它：这个项目所有画布数据都来自**外部** —— 工作流文件、恢复快照、
// 宿主的接口回包。字段缺失可以补（见 workflow.ts 的 workflowToCanvas），
// 但**想不到的**缺陷补不完。一个渲染异常若没有边界，React 会卸载整棵树：
// 用户看到整页空白，界面上也没有任何入口自救（实测踩过两次，第二次写完字段校验
// 才补上这一层）。
//
// 分两层，职责不同：
//   NodeBoundary   单张卡出错 → 只有那张卡变成「这张卡出错了」，其余照常可用
//   CanvasBoundary 画布整体出错（含 React Flow 内部抛的错）→ 画布区换成一句话 + 两个按钮
//
// 一条硬规矩：**边界把错误吞掉了，控制台必须留完整堆栈**。否则以后排查只剩
// 「界面说这张卡出错了」，不知道哪里错 —— 那比白屏更难查。
import { Component, type ErrorInfo, type ReactNode } from "react";

interface BoundaryProps {
  children: ReactNode;
  /** 出错时的替代界面；`reset` 清掉错误状态、重新尝试渲染 */
  fallback: (error: Error, reset: () => void) => ReactNode;
  /** 旁路回调（写日志 / 停掉自动保存）。堆栈只进控制台，不上屏。 */
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface BoundaryState {
  error: Error | null;
}

/**
 * 通用错误边界（React 只支持类组件做这件事，没有 hook 版本）。
 *
 * 没出错时**原样返回 children**，不多套一层 DOM —— 节点的定位与尺寸由 React Flow
 * 挂在它自己的外层元素上，多一层包裹会把选择框、拖拽把手的位置算歪。
 */
export class ErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[imagora] 渲染出错", error, info.componentStack);
    this.props.onError?.(error, info);
  }

  /** 重试：清掉错误状态，让 React 重新渲染一次子树 */
  reset = () => this.setState({ error: null });

  override render() {
    if (this.state.error) return this.props.fallback(this.state.error, this.reset);
    return this.props.children;
  }
}

/** 错误消息压成一行：边界里的替代界面很小，多行长堆栈会把卡片撑爆 */
function briefMessage(error: Error): string {
  const text = String(error?.message ?? error ?? "未知错误").split("\n")[0] ?? "";
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
}

/** 单张卡片的边界：坏一张只坏一张，其余照常可用 */
export function NodeBoundary({ nodeId, children }: { nodeId?: string | undefined; children: ReactNode }) {
  return (
    <ErrorBoundary
      fallback={(error, reset) => (
        <div
          className="w-[300px] rounded-xl border border-red-200 bg-red-50 p-3 text-red-800 shadow-sm"
          data-node-id={nodeId}
          title={String(error?.stack ?? error)}
        >
          <div className="text-xs font-semibold">这张卡出错了</div>
          <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-red-700">{briefMessage(error)}</p>
          <p className="mt-1 text-[10px] text-red-500">选中它按 Delete 删掉即可，其余卡片不受影响</p>
          <button type="button" className="btn-ghost btn-xs mt-2 nodrag" onClick={reset}>
            重试
          </button>
        </div>
      )}
    >
      {children}
    </ErrorBoundary>
  );
}

/**
 * 画布整体的边界：兜住 NodeBoundary 拦不到的那些（React Flow 自己读
 * `node.position.x` 抛的错就属于这一类）。
 *
 * 替代界面必须给**出路**：只写「出错了」等于让用户对着白屏。这里给两个按钮 ——
 * 重试（同一次渲染可能已经好了，比如数据刚被别的路径修正），
 * 以及清空画布（把这份坏状态丢掉，用户的工作流文件在磁盘上，不会丢）。
 */
export function CanvasBoundary({
  children,
  onCrash,
  onClear,
}: {
  children: ReactNode;
  /** 出错时通知宿主（画布侧用它停掉自动快照，别把坏状态写回磁盘） */
  onCrash?: (error: Error) => void;
  /** 清空画布：由调用方实现（它才知道怎么重置节点与边） */
  onClear: () => void;
}) {
  return (
    <ErrorBoundary
      onError={(error) => onCrash?.(error)}
      fallback={(error, reset) => (
        <div role="alert" className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
          <h3 className="text-sm font-semibold text-red-700">画布渲染出错</h3>
          <p className="max-w-[52ch] text-xs text-neutral-600">{briefMessage(error)}</p>
          <p className="max-w-[52ch] text-[11px] leading-5 text-neutral-400">
            你的工作流文件还在磁盘上，没有丢。可以先重试；如果还是不行，清空画布再从工作流里重新加载。
          </p>
          <div className="mt-1 flex gap-2">
            <button type="button" className="btn-primary btn-sm" onClick={reset}>
              重试
            </button>
            <button
              type="button"
              className="btn-ghost btn-sm"
              onClick={() => {
                onClear();
                reset();
              }}
            >
              清空画布
            </button>
          </div>
        </div>
      )}
    >
      {children}
    </ErrorBoundary>
  );
}

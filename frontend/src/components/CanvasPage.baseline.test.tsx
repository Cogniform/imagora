// @vitest-environment jsdom

/**
 * CanvasPage 行为基线（拆分安全网）。
 *
 * 目标：只锁「用户能看见 / 调用方能观察到」的行为，不碰 useState 个数、内部函数名、行号。
 * 巨型组件拆分时，任何一步让这些断言变红，都说明拆分改变了可观察契约。
 *
 * 测试替身的分工：
 * - `@xyflow/react`：记录 props、真正用 `nodeTypes[type]` 渲染节点（这样才能数挂载次数），
 *   并模拟最小的选中 / 空白点击 / 视口移动契约。jsdom 没有布局能力，真 ReactFlow 既慢又测不出这些。
 * - `./CanvasNodes`：渲染与生产组件一致的统计 / 状态文案，并暴露节点上的操作按钮，
 *   用来观察 CanvasPage 传给节点的 data 与回调。
 * - 弹窗：轻量替身，只验证 CanvasPage 的开关与入参；弹窗自身行为由各自单测覆盖。
 */

import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig, AssetEntry, WorkflowFile } from "../types";
import { CanvasPage } from "./CanvasPage";
import {
  canvasUpload,
  importHistoryAsset,
  importSubmission,
  selectFolder,
  workflowList,
  workflowLoad,
  workflowSave,
} from "../api";

/** noUncheckedIndexedAccess 守卫：越界即失败，不把断言弱化为可选链。 */
function indexed<T>(items: ArrayLike<T>, at: number): T {
  const item = items[at];
  if (item === undefined) throw new Error(`indexed: 长度 ${items.length} 越界下标 ${at}`);
  return item;
}

const h = vi.hoisted(() => {
  return {
    rfProps: [] as any[],
    dropArgs: [] as any[],
    mounts: { image: 0, prompt: 0, group: 0 },
    zoomTo: vi.fn(),
    fitView: vi.fn(async () => true),
    setViewport: vi.fn(async () => undefined),
    taskSubmit: vi.fn(async () => "task-1"),
    taskCancel: vi.fn(async () => undefined),
    taskSubscriber: null as null | ((taskId: string, view: any) => void),
    /** 在跑的任务列表：mock 的 useGenerationTask 直接读它（工具栏「取消全部」的显隐与计数靠这个） */
    tasks: [] as { taskId: string; status: string }[],
    clipboardWrite: vi.fn(async () => undefined),
  };
});

vi.mock("../api", () => ({
  canvasUpload: vi.fn(),
  importHistoryAsset: vi.fn(),
  importSubmission: vi.fn(),
  selectFolder: vi.fn(),
  workflowList: vi.fn(),
  workflowLoad: vi.fn(),
  workflowSave: vi.fn(),
}));

vi.mock("../useCanvasDrop", () => ({
  useCanvasDrop: (args: any) => {
    h.dropArgs.push(args);
    return {
      dropIntent: null,
      dropChip: null,
      dragHandlers: {},
      startToolbarDrag: vi.fn(),
      hideDropChip: vi.fn(),
    };
  },
}));

vi.mock("../useCanvasRecovery", () => ({
  useCanvasRecovery: vi.fn(),
}));

vi.mock("../useGenerationTask", () => ({
  useGenerationTask: () => ({
    submit: h.taskSubmit,
    cancel: h.taskCancel,
    subscribe: (listener: (taskId: string, view: any) => void) => {
      h.taskSubscriber = listener;
      return () => {
        if (h.taskSubscriber === listener) h.taskSubscriber = null;
      };
    },
    get: () => undefined,
    tasks: h.tasks,
  }),
}));

vi.mock("./CanvasNodes", () => {
  function statusText(data: any): string {
    switch (data.status) {
      case "queued":
        return "排队中";
      case "running":
        return "生成中";
      case "done":
        return `完成 · ${data.resultCount ?? 0} 张`;
      case "failed":
        return "失败";
      default:
        return "就绪";
    }
  }

  function ImageNode(props: any) {
    React.useEffect(() => {
      h.mounts.image += 1;
    }, []);
    const { id, data, selected, lod, positionAbsoluteX, positionAbsoluteY } = props;
    return (
      <div
        data-testid={`image-node-${id}`}
        data-node-type="image"
        data-selected={selected ? "1" : "0"}
        data-lod={lod ? "1" : "0"}
        data-position={`${positionAbsoluteX},${positionAbsoluteY}`}
        data-position-absolute={`${positionAbsoluteX},${positionAbsoluteY}`}
      >
        <span>{data.name}</span>
        <span data-testid={`ref-${id}`}>{data.refCount > 0 ? `引用 ${data.refCount} 处` : "未引用"}</span>
        <button type="button" aria-label={`预览大图-${id}`} onClick={(e) => { e.stopPropagation(); props.onZoom(id); }}>
          预览大图
        </button>
        <button type="button" aria-label={`裁剪图片-${id}`} onClick={(e) => { e.stopPropagation(); props.onCrop(id); }}>
          裁剪图片
        </button>
        <button type="button" aria-label={`放大图片-${id}`} onClick={(e) => { e.stopPropagation(); props.onUpscale(id); }}>
          放大图片
        </button>
        <button type="button" aria-label={`切分图片-${id}`} onClick={(e) => { e.stopPropagation(); props.onSplit(id); }}>
          切分图片
        </button>
        <button type="button" aria-label={`蒙版重绘-${id}`} onClick={(e) => { e.stopPropagation(); props.onMask(id); }}>
          蒙版重绘
        </button>
        <button type="button" aria-label={`替换图片-${id}`} onClick={(e) => { e.stopPropagation(); props.onReplace(id); }}>
          替换图片
        </button>
        <button type="button" aria-label={`删除图片-${id}`} onClick={(e) => { e.stopPropagation(); props.onDelete(id); }}>
          删除图片
        </button>
      </div>
    );
  }

  function GroupNode(props: any) {
    React.useEffect(() => {
      h.mounts.group += 1;
    }, []);
    const { id, data, selected, lod, positionAbsoluteX, positionAbsoluteY } = props;
    const mb = data.totalSize > 0 ? (data.totalSize / (1024 * 1024)).toFixed(1) : "0.0";
    return (
      <div
        data-testid={`group-node-${id}`}
        data-node-type="group"
        data-selected={selected ? "1" : "0"}
        data-lod={lod ? "1" : "0"}
        data-position={`${positionAbsoluteX},${positionAbsoluteY}`}
      >
        <span data-testid={`group-count-${id}`}>{data.imageCount} 张图</span>
        <span data-testid={`group-size-${id}`}>{mb} MB</span>
      </div>
    );
  }

  function PromptNode(props: any) {
    React.useEffect(() => {
      h.mounts.prompt += 1;
    }, []);
    const { id, data, selected, lod, positionAbsoluteX, positionAbsoluteY } = props;
    return (
      <div
        data-testid={`prompt-node-${id}`}
        data-node-type="prompt"
        data-selected={selected ? "1" : "0"}
        data-lod={lod ? "1" : "0"}
        data-position={`${positionAbsoluteX},${positionAbsoluteY}`}
        data-position-absolute={`${positionAbsoluteX},${positionAbsoluteY}`}
      >
        <span data-testid={`status-${id}`} data-status={data.status} data-message={data.message ?? ""}>
          {statusText(data)}
        </span>
        <textarea
          aria-label={`提示词-${id}`}
          value={data.prompt}
          onChange={(e) => props.onUpdate(id, { prompt: e.target.value })}
        />
        <button type="button" aria-label={`运行-${id}`} onClick={(e) => { e.stopPropagation(); props.onRun(id); }}>
          运行
        </button>
        {(data.status === "queued" || data.status === "running") && (
          <button
            type="button"
            aria-label={`取消-${id}`}
            disabled={data.cancelRequested === true}
            onClick={(e) => { e.stopPropagation(); props.onCancel(id); }}
          >
            {data.cancelRequested === true ? "取消中…" : "取消"}
          </button>
        )}
        <button type="button" aria-label={`删除节点-${id}`} onClick={(e) => { e.stopPropagation(); props.onDelete(id); }}>
          删除
        </button>
      </div>
    );
  }

  return { ImageNode, GroupNode, PromptNode };
});

vi.mock("./WorkflowModals", () => ({
  WorkflowSaveModal: (props: any) => (
    <div data-testid="save-modal">
      <input
        aria-label="工作流名称"
        value={props.saveName}
        onChange={(e) => props.onSaveNameChange(e.target.value)}
      />
      {props.workflows.map((w: any) => (
        <button key={w.name} type="button" onClick={() => props.onPickName(w.name)}>
          {w.name}
        </button>
      ))}
      <button type="button" onClick={props.onConfirm}>确认保存</button>
      <button type="button" onClick={props.onClose}>关闭</button>
    </div>
  ),
  WorkflowLoadModal: (props: any) => (
    <div data-testid="load-modal">
      {props.workflows.map((w: any) => (
        <button key={w.name} type="button" onClick={() => props.onLoad(w.name)}>
          {w.name}
        </button>
      ))}
      <button type="button" onClick={props.onClose}>关闭</button>
    </div>
  ),
  ZoomModal: (props: any) => (
    <div data-testid="zoom-modal">
      <span>{props.name}</span>
      <button type="button" onClick={props.onClose}>关闭</button>
    </div>
  ),
}));

vi.mock("./PromptImportModal", () => ({
  // 真实弹窗的解析/预览由 PromptImportModal 自己的测试与 promptImportFormat.test.ts 覆盖；
  // 这里只需要一个能触发「批量建卡」的入口，用来钉住 CanvasPage 的落点铺排接线。
  PromptImportModal: (props: any) => (
    <div data-testid="import-modal">
      <button
        type="button"
        onClick={() =>
          props.onConfirm([
            { title: "A", ratio: "1:1", prompt: "a red apple" },
            { title: "B", ratio: "1:1", prompt: "a green pear" },
          ])
        }
      >
        模拟导入两张
      </button>
      <button type="button" onClick={props.onClose}>关闭</button>
    </div>
  ),
}));

vi.mock("./HistoryGallery", () => ({
  HistoryGallery: (props: any) =>
    props.open ? (
      <div data-testid="history-gallery">
        <button type="button" onClick={props.onClose}>关闭</button>
      </div>
    ) : null,
}));

vi.mock("./ModalShell", () => ({
  ModalShell: (props: any) => (
    <div data-testid="modal-shell">
      <h3>{props.title}</h3>
      {props.children}
    </div>
  ),
}));

vi.mock("./ImageCropDialog", () => ({
  ImageCropDialog: (props: any) => (
    <div data-testid="crop-modal">
      <span>{props.name}</span>
      <button type="button" onClick={props.onClose}>关闭</button>
    </div>
  ),
}));

vi.mock("./ImageUpscaleDialog", () => ({
  ImageUpscaleDialog: (props: any) => (
    <div data-testid="upscale-modal">
      <button type="button" onClick={props.onClose}>关闭</button>
    </div>
  ),
}));

vi.mock("./ImageSplitDialog", () => ({
  ImageSplitDialog: (props: any) => (
    <div data-testid="split-modal">
      <button type="button" onClick={props.onClose}>关闭</button>
    </div>
  ),
}));

vi.mock("./MaskBrushDialog", () => ({
  MaskBrushDialog: (props: any) => (
    <div data-testid="mask-modal">
      <button type="button" onClick={props.onClose}>关闭</button>
    </div>
  ),
}));

vi.mock("./NodeContextMenu", () => ({
  NodeContextMenu: (props: any) => (
    <div data-testid="node-menu">
      {props.items.map((item: any, index: number) =>
        item.kind === "separator" ? (
          <hr key={`sep-${index}`} />
        ) : (
          <button
            key={item.action.id}
            type="button"
            data-action={item.action.id}
            disabled={item.action.disabled === true}
            onClick={() => props.onPick(item.action.id)}
          >
            {item.action.label}
          </button>
        ),
      )}
    </div>
  ),
}));

vi.mock("@xyflow/react", () => {
  type AnyNode = any;
  type AnyChange = any;

  function applyNodeChanges(nodes: AnyNode[], changes: AnyChange[]): AnyNode[] {
    let next = nodes;
    for (const change of changes) {
      if (change.type === "remove") {
        next = next.filter((n) => n.id !== change.id);
      } else if (change.type === "position") {
        next = next.map((n) =>
          n.id === change.id
            ? {
                ...n,
                position: change.position ?? n.position,
                positionAbsoluteX: change.positionAbsolute?.x ?? change.position?.x ?? n.position.x,
                positionAbsoluteY: change.positionAbsolute?.y ?? change.position?.y ?? n.position.y,
              }
            : n,
        );
      } else if (change.type === "select") {
        next = next.map((n) => (n.id === change.id ? { ...n, selected: change.selected } : n));
      } else if (change.type === "dimensions" && change.dimensions) {
        next = next.map((n) => (n.id === change.id ? { ...n, measured: change.dimensions } : n));
      } else if (change.type === "replace" && change.item) {
        next = next.map((n) => (n.id === change.id ? change.item : n));
      }
    }
    return next;
  }

  function useNodesState(initial: AnyNode[]) {
    const [nodes, setNodes] = React.useState<AnyNode[]>(initial);
    const onNodesChange = React.useCallback((changes: AnyChange[]) => {
      setNodes((current) => applyNodeChanges(current, changes));
    }, []);
    return [nodes, setNodes, onNodesChange];
  }

  function useEdgesState(initial: AnyNode[]) {
    const [edges, setEdges] = React.useState<AnyNode[]>(initial);
    const onEdgesChange = React.useCallback((changes: AnyChange[]) => {
      setEdges((current) => {
        let next = current;
        for (const change of changes) {
          if (change.type === "remove") next = next.filter((e) => e.id !== change.id);
          else if (change.type === "select") next = next.map((e) => (e.id === change.id ? { ...e, selected: change.selected } : e));
          else if (change.type === "add" && change.item) next = [...next, change.item];
          else if (change.type === "reset" && change.item) next = change.item;
        }
        return next;
      });
    }, []);
    return [edges, setEdges, onEdgesChange];
  }

  function addEdge(edge: AnyNode, edges: AnyNode[]) {
    return [...edges, { ...edge, id: edge.id ?? `e-${edges.length}-${edge.source}-${edge.target}` }];
  }

  function ReactFlow(props: any) {
    h.rfProps.push(props);
    const [selectedIds, setSelectedIds] = React.useState<Set<string>>(() => new Set());
    const nodes = props.nodes as AnyNode[];

    const instance = {
      getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
      zoomTo: h.zoomTo,
      setViewport: h.setViewport,
      fitView: h.fitView,
      screenToFlowPosition: (point: { x: number; y: number }) => point,
      flowToScreenPosition: (point: { x: number; y: number }) => point,
      getNodes: () => props.nodes,
      getEdges: () => props.edges,
    };

    React.useEffect(() => {
      props.onInit?.(instance);
      // 只在挂载时交付实例；后续 props 变化不应重新初始化画布
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const emitSelection = (next: Set<string>) => {
      setSelectedIds(next);
      props.onSelectionChange?.({
        nodes: nodes.filter((n) => next.has(n.id)),
        edges: [],
      });
    };

    const handleNodeClick = (event: React.MouseEvent, node: AnyNode) => {
      event.stopPropagation();
      const multi = event.shiftKey || event.ctrlKey || event.metaKey;
      const next = new Set<string>(multi ? selectedIds : []);
      if (multi && next.has(node.id)) next.delete(node.id);
      else next.add(node.id);
      emitSelection(next);
    };

    return (
      <div
        data-testid="rf-pane"
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          setSelectedIds(new Set());
          props.onSelectionChange?.({ nodes: [], edges: [] });
          props.onPaneClick?.();
        }}
      >
        {props.children}
        <div data-testid="edge-count">{props.edges.length}</div>
        {nodes.map((node) => {
          const NodeComponent = props.nodeTypes?.[node.type];
          return (
            <div
              key={node.id}
              className="react-flow__node"
              data-id={node.id}
              data-testid={`rf-node-${node.id}`}
              data-selected={selectedIds.has(node.id) || node.selected ? "1" : "0"}
              onClick={(event) => handleNodeClick(event, node)}
            >
              {NodeComponent ? (
                <NodeComponent
                  id={node.id}
                  data={node.data}
                  type={node.type}
                  selected={selectedIds.has(node.id) || node.selected === true}
                  dragging={false}
                  positionAbsoluteX={node.positionAbsoluteX ?? node.position.x}
                  positionAbsoluteY={node.positionAbsoluteY ?? node.position.y}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    );
  }

  function Controls(props: any) {
    return <div data-testid="controls">{props.children}</div>;
  }

  function ControlButton(props: any) {
    return (
      <button type="button" {...props}>
        {props.children}
      </button>
    );
  }

  function MiniMap(props: any) {
    return <div role="region" aria-label={props.ariaLabel} data-testid="minimap" />;
  }

  function ViewportPortal(props: any) {
    return <>{props.children}</>;
  }

  function Background() {
    return null;
  }

  function Handle() {
    return <span data-testid="handle" />;
  }

  function ReactFlowProvider(props: any) {
    return <>{props.children}</>;
  }

  return {
    ReactFlow,
    Controls,
    ControlButton,
    MiniMap,
    ViewportPortal,
    Background,
    Handle,
    ReactFlowProvider,
    useNodesState,
    useEdgesState,
    addEdge,
    BackgroundVariant: { Dots: "dots", Lines: "lines", Cross: "cross" },
    Position: { Top: "top", Bottom: "bottom", Left: "left", Right: "right" },
  };
});

const CONFIG: AppConfig = {
  sizes: [{ value: "1024x1024", label: "1024x1024", cost: 0.2 }],
  qualities: ["high", "low"],
  defaultOutputDir: "D:\\out",
  windowId: 1,
};

function asset(id: string, name: string, size = 1024 * 1024): AssetEntry {
  return {
    id,
    relPath: `images/${name}`,
    absPath: `D:\\out\\images\\${name}`,
    url: `http://localhost/images/${name}`,
    name,
    size,
    ext: "png",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function lastRf(): any {
  const props = h.rfProps[h.rfProps.length - 1];
  if (!props) throw new Error("ReactFlow 尚未渲染");
  return props;
}

function lastDrop(): any {
  const args = h.dropArgs[h.dropArgs.length - 1];
  if (!args) throw new Error("useCanvasDrop 尚未调用");
  return args;
}

function renderPage(props: Partial<React.ComponentProps<typeof CanvasPage>> = {}) {
  return render(<CanvasPage config={CONFIG} {...props} />);
}

function createPromptCard(): void {
  fireEvent.click(screen.getByRole("button", { name: "新建提示词卡片" }));
}

function createGroupCard(): void {
  fireEvent.click(screen.getByRole("button", { name: "新建图片组" }));
}

async function uploadImages(entries: AssetEntry[]): Promise<void> {
  vi.mocked(canvasUpload).mockResolvedValueOnce({ images: entries });
  const input = document.querySelector('input[type="file"]');
  if (!(input instanceof HTMLInputElement)) throw new Error("找不到上传文件输入框");
  const files = entries.map((entry) => new File([entry.name], entry.name, { type: "image/png" }));
  fireEvent.change(input, { target: { files } });
  await waitFor(() => {
    expect(screen.getByText(entries[0]?.name ?? "")).toBeTruthy();
  });
}

function selectNode(id: string, init: { shiftKey?: boolean; ctrlKey?: boolean } = {}): void {
  fireEvent.click(screen.getByTestId(`rf-node-${id}`), init);
}

function moveViewport(zoom: number): void {
  act(() => {
    lastRf().onMove(null, { x: 0, y: 0, zoom });
  });
}

function dragNode(id: string, position: { x: number; y: number }): void {
  act(() => {
    // 顶层节点没有 parent，React Flow 的 position change 只需 position；
    // 吸附层会改写 position，若同时塞 positionAbsolute 会绕过被测接线层。
    lastRf().onNodesChange([{ id, type: "position", position, dragging: true }]);
  });
}

function connectNodes(source: string, target: string): void {
  act(() => {
    lastRf().onConnect({ source, target, sourceHandle: null, targetHandle: null });
  });
}

function rightClickNode(id: string): void {
  const node = screen.getByTestId(`rf-node-${id}`);
  fireEvent.mouseDown(node, { button: 2, clientX: 100, clientY: 100 });
  fireEvent.mouseUp(window, { clientX: 100, clientY: 100 });
}

function pressUndo(): void {
  fireEvent.keyDown(window, { key: "z", ctrlKey: true });
}

function pressRedo(): void {
  fireEvent.keyDown(window, { key: "y", ctrlKey: true });
}

function promptNodeIds(): string[] {
  return screen.queryAllByTestId(/^prompt-node-/).map((el) => {
    const testId = el.getAttribute("data-testid") ?? "";
    return testId.slice("prompt-node-".length);
  });
}

function nodePosition(id: string): { x: number; y: number } {
  const raw = screen.getByTestId(`prompt-node-${id}`).getAttribute("data-position") ?? "";
  const [rawX, rawY] = raw.split(",");
  const x = Number(rawX ?? "");
  const y = Number(rawY ?? "");
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`节点 ${id} 没有有效位置：${raw}`);
  return { x, y };
}

beforeEach(() => {
  h.rfProps.length = 0;
  h.dropArgs.length = 0;
  h.mounts.image = 0;
  h.mounts.prompt = 0;
  h.mounts.group = 0;
  h.taskSubscriber = null;
  h.tasks = [];

  h.zoomTo.mockReset();
  h.fitView.mockReset().mockResolvedValue(true);
  h.setViewport.mockReset().mockResolvedValue(undefined);
  h.taskSubmit.mockReset().mockResolvedValue("task-1");
  h.taskCancel.mockReset().mockResolvedValue(undefined);
  h.clipboardWrite.mockReset().mockResolvedValue(undefined);

  window.localStorage.clear();

  vi.mocked(canvasUpload).mockReset().mockResolvedValue({ images: [] });
  vi.mocked(importHistoryAsset).mockReset().mockResolvedValue({ imported: [], skipped: [] });
  vi.mocked(importSubmission).mockReset().mockResolvedValue({ nodes: [], edges: [], missing: [] } as any);
  vi.mocked(selectFolder).mockReset().mockResolvedValue({ path: "" });
  vi.mocked(workflowList).mockReset().mockResolvedValue({ workflows: [] });
  vi.mocked(workflowLoad).mockReset().mockResolvedValue({ version: 1, name: "w", nodes: [], edges: [], missing: [] } as any);
  // 真实签名是 { ok: boolean; path: string }；CanvasPage 只消费 path，ok 是接口成功判定位。
  vi.mocked(workflowSave).mockReset().mockResolvedValue({ ok: true, path: "D:\\out\\wf.json" });

  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });

  vi.spyOn(window, "confirm").mockReturnValue(true);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: h.clipboardWrite },
  });

  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 800,
    bottom: 600,
    width: 800,
    height: 600,
    toJSON: () => ({}),
  });

  let now = 1_000;
  vi.spyOn(Date, "now").mockImplementation(() => {
    now += 1;
    return now;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("契约：拆分时最容易崩的接线", () => {
  it("无依赖变化的重渲染不重建 nodeTypes 引用", () => {
    renderPage();
    const first = lastRf().nodeTypes;
    fireEvent.click(screen.getByRole("button", { name: "操作帮助与快捷键" }));
    expect(lastRf().nodeTypes).toBe(first);
  });

  it("无依赖变化的重渲染不重挂载已存在节点", () => {
    renderPage();
    createPromptCard();
    expect(promptNodeIds()).toHaveLength(1);

    // 建卡本身会经历 React 的一次开发期状态更新器重放；从稳定态开始计数。
    h.mounts.prompt = 0;
    fireEvent.click(screen.getByRole("button", { name: "操作帮助与快捷键" }));
    expect(h.mounts.prompt).toBe(0);
  });

  it("高频回调在重渲染后保持身份稳定", () => {
    renderPage();
    const before = lastRf();
    fireEvent.click(screen.getByRole("button", { name: "操作帮助与快捷键" }));
    const after = lastRf();

    expect(after.onNodesChange).toBe(before.onNodesChange);
    expect(after.onEdgesChange).toBe(before.onEdgesChange);
    expect(after.onSelectionChange).toBe(before.onSelectionChange);
    expect(after.onMove).toBe(before.onMove);
  });

  it("LOD 迟滞：阈值之间来回缩放不翻转，越过外侧阈值才切换", () => {
    renderPage();
    createPromptCard();
    const id = indexed(promptNodeIds(), 0);

    expect(screen.getByTestId(`prompt-node-${id}`).getAttribute("data-lod")).toBe("0");

    moveViewport(0.05);
    expect(screen.getByTestId(`prompt-node-${id}`).getAttribute("data-lod")).toBe("1");

    moveViewport(0.15);
    expect(screen.getByTestId(`prompt-node-${id}`).getAttribute("data-lod")).toBe("1");

    moveViewport(0.25);
    expect(screen.getByTestId(`prompt-node-${id}`).getAttribute("data-lod")).toBe("0");

    moveViewport(0.15);
    expect(screen.getByTestId(`prompt-node-${id}`).getAttribute("data-lod")).toBe("0");
  });

  it("Ctrl+Z 一次只撤销一步", () => {
    renderPage();
    createPromptCard();
    createPromptCard();
    expect(promptNodeIds()).toHaveLength(2);

    pressUndo();
    expect(promptNodeIds()).toHaveLength(1);
  });

  it("Ctrl+Z 不吞掉浏览器默认行为之外的焦点输入（可编辑元素不触发）", () => {
    renderPage();
    createPromptCard();
    createPromptCard();
    const id = indexed(promptNodeIds(), 0);

    fireEvent.keyDown(screen.getByLabelText(`提示词-${id}`), { key: "z", ctrlKey: true });
    expect(promptNodeIds()).toHaveLength(2);
  });

  describe("modalOpen 完整性", () => {
    // 必须是逐条字面量写法：仓里的文档计数脚本只认行首的 `it` 直接调用，
    // it.each 或循环里的用例都会被算成 1 条，文档数字就会与 vitest 实跑对不上。
    const assertModalOpen = async (trigger: () => Promise<void> | void) => {
      renderPage();
      await trigger();
      await waitFor(() => {
        expect(lastDrop().modalOpen).toBe(true);
      });
    };

    it("帮助 打开时 modalOpen 为 true", async () => {
      await assertModalOpen(() => {
        fireEvent.click(screen.getByRole("button", { name: "操作帮助与快捷键" }));
      });
    });

    it("保存 打开时 modalOpen 为 true", async () => {
      await assertModalOpen(async () => {
        createPromptCard();
        fireEvent.click(screen.getByRole("button", { name: "保存工作流" }));
        await waitFor(() => expect(screen.getByTestId("save-modal")).toBeTruthy());
      });
    });

    it("加载 打开时 modalOpen 为 true", async () => {
      await assertModalOpen(async () => {
        vi.mocked(workflowList).mockResolvedValue({ workflows: [{ name: "w1", modified: "2026-01-01" }] });
        fireEvent.click(screen.getByRole("button", { name: "加载工作流" }));
        await waitFor(() => expect(screen.getByTestId("load-modal")).toBeTruthy());
      });
    });

    it("粘贴导入 打开时 modalOpen 为 true", async () => {
      await assertModalOpen(() => {
        fireEvent.click(screen.getByRole("button", { name: "粘贴导入" }));
      });
    });

    it("生成历史 打开时 modalOpen 为 true", async () => {
      await assertModalOpen(() => {
        fireEvent.click(screen.getByRole("button", { name: "生成历史" }));
      });
    });

    it("放大预览 打开时 modalOpen 为 true", async () => {
      await assertModalOpen(async () => {
        await uploadImages([asset("a", "a.png")]);
        fireEvent.click(screen.getByRole("button", { name: "预览大图-img-a" }));
        await waitFor(() => expect(screen.getByTestId("zoom-modal")).toBeTruthy());
      });
    });

    it("裁剪 打开时 modalOpen 为 true", async () => {
      await assertModalOpen(async () => {
        await uploadImages([asset("a", "a.png")]);
        fireEvent.click(screen.getByRole("button", { name: "裁剪图片-img-a" }));
        await waitFor(() => expect(screen.getByTestId("crop-modal")).toBeTruthy());
      });
    });

    it("放大 打开时 modalOpen 为 true", async () => {
      await assertModalOpen(async () => {
        await uploadImages([asset("a", "a.png")]);
        fireEvent.click(screen.getByRole("button", { name: "放大图片-img-a" }));
        await waitFor(() => expect(screen.getByTestId("upscale-modal")).toBeTruthy());
      });
    });

    it("切分 打开时 modalOpen 为 true", async () => {
      await assertModalOpen(async () => {
        await uploadImages([asset("a", "a.png")]);
        fireEvent.click(screen.getByRole("button", { name: "切分图片-img-a" }));
        await waitFor(() => expect(screen.getByTestId("split-modal")).toBeTruthy());
      });
    });

    it("蒙版 打开时 modalOpen 为 true", async () => {
      await assertModalOpen(async () => {
        await uploadImages([asset("a", "a.png")]);
        fireEvent.click(screen.getByRole("button", { name: "蒙版重绘-img-a" }));
        await waitFor(() => expect(screen.getByTestId("mask-modal")).toBeTruthy());
      });
    });
  });
});

describe("节点增删", () => {
  it("新建提示词卡片：出现一张提示词节点并记录日志", () => {
    renderPage();
    createPromptCard();

    expect(promptNodeIds()).toHaveLength(1);
    expect(screen.getByText("已新建提示词卡片")).toBeTruthy();
  });

  it("新建图片组：出现一个图片组节点并记录日志", () => {
    renderPage();
    createGroupCard();

    expect(screen.getByTestId(/^group-node-/)).toBeTruthy();
    expect(screen.getByText("已新建图片组，把图片连进来即可")).toBeTruthy();
  });

  // 旧实现整批共用 origin + 30px 栅格，而卡片宽 380px：8 张导入会完全叠住。
  it("粘贴导入按卡片真实尺寸铺开：两张卡不叠在同一坐标", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "粘贴导入" }));
    fireEvent.click(screen.getByRole("button", { name: "模拟导入两张" }));

    const ids = promptNodeIds();
    expect(ids).toHaveLength(2);
    const first = nodePosition(indexed(ids, 0));
    const second = nodePosition(indexed(ids, 1));
    // 同一行、列距 = 卡宽 380 + 间距 40；旧实现这里是 30px（几乎重叠）
    expect(second.y).toBe(first.y);
    expect(Math.abs(second.x - first.x)).toBe(420);
  });

  it("上传图片：按后端返回创建图片节点", async () => {
    renderPage();
    await uploadImages([asset("a", "a.png"), asset("b", "b.png")]);

    expect(screen.getByText("a.png")).toBeTruthy();
    expect(screen.getByText("b.png")).toBeTruthy();
    expect(screen.getByText("已上传 2 张图片到画布")).toBeTruthy();
  });

  it("删除所选：选中节点从画布消失并记录数量", async () => {
    renderPage();
    await uploadImages([asset("a", "a.png")]);
    selectNode("img-a");

    fireEvent.click(screen.getByRole("button", { name: "删除所选" }));

    expect(screen.queryByTestId("image-node-img-a")).toBeNull();
    expect(screen.getByText("已删除 1 个选中节点（文件保留）")).toBeTruthy();
  });

  it("节点自带删除：单节点删除也走同一条删除路径", () => {
    renderPage();
    createPromptCard();
    const id = indexed(promptNodeIds(), 0);

    fireEvent.click(screen.getByRole("button", { name: `删除节点-${id}` }));

    expect(screen.queryByTestId(`prompt-node-${id}`)).toBeNull();
    expect(screen.getByText("已删除节点（文件保留）")).toBeTruthy();
  });
});

describe("选中集", () => {
  it("单击选中一个节点", () => {
    renderPage();
    createPromptCard();
    const id = indexed(promptNodeIds(), 0);

    selectNode(id);

    expect(screen.getByRole("button", { name: "删除所选" })).toBeTruthy();
    expect(screen.getByTestId(`rf-node-${id}`).getAttribute("data-selected")).toBe("1");
  });

  it("Shift 多选得到集合，Ctrl 再次点击取消单个", () => {
    renderPage();
    createPromptCard();
    createPromptCard();
    const first = indexed(promptNodeIds(), 0);
    const second = indexed(promptNodeIds(), 1);

    selectNode(first);
    selectNode(second, { shiftKey: true });
    expect(screen.getByRole("button", { name: "删除所选 (2)" })).toBeTruthy();

    selectNode(second, { ctrlKey: true });
    expect(screen.getByRole("button", { name: "删除所选" })).toBeTruthy();
  });

  it("框选按矩形包含关系得到节点集合", () => {
    renderPage();
    createPromptCard();
    createPromptCard();
    const pane = screen.getByTestId("rf-pane");

    fireEvent.mouseDown(pane, { button: 2, clientX: 0, clientY: 0 });
    fireEvent.mouseMove(window, { clientX: 1000, clientY: 1000 });
    fireEvent.mouseUp(window, { clientX: 1000, clientY: 1000 });

    const selected = screen.getAllByTestId(/^rf-node-/).filter((el) => el.getAttribute("data-selected") === "1");
    expect(selected).toHaveLength(2);
  });

  it("点空白清空选中集", () => {
    renderPage();
    createPromptCard();
    const id = indexed(promptNodeIds(), 0);
    selectNode(id);
    expect(screen.getByRole("button", { name: "删除所选" })).toBeTruthy();

    fireEvent.click(screen.getByTestId("rf-pane"));

    expect(screen.queryByRole("button", { name: "删除所选" })).toBeNull();
  });
});

describe("撤销/重做", () => {
  it("撤销恢复上一画布形态，重做恢复当前形态", () => {
    renderPage();
    createPromptCard();
    createPromptCard();
    const first = indexed(promptNodeIds(), 0);

    pressUndo();
    expect(promptNodeIds()).toHaveLength(1);
    expect(screen.getByText("已撤销画布操作")).toBeTruthy();

    pressRedo();
    expect(promptNodeIds()).toHaveLength(2);
    expect(screen.getByText("已恢复画布操作")).toBeTruthy();
    expect(screen.getByTestId(`prompt-node-${first}`)).toBeTruthy();
  });

  it("撤销拖拽：节点位置回到拖动前", () => {
    renderPage();
    createPromptCard();
    const id = indexed(promptNodeIds(), 0);

    const before = nodePosition(id);

    act(() => {
      lastRf().onNodeDragStart();
    });
    dragNode(id, { x: before.x + 100, y: before.y + 80 });
    expect(nodePosition(id)).toEqual({ x: before.x + 100, y: before.y + 80 });

    pressUndo();

    expect(nodePosition(id)).toEqual(before);
  });

  it("撤销后执行普通动作会清空重做栈", () => {
    renderPage();
    createPromptCard();
    createPromptCard();
    pressUndo();
    expect(screen.getByRole("button", { name: "恢复" }).hasAttribute("disabled")).toBe(false);

    createPromptCard();

    expect(screen.getByRole("button", { name: "恢复" }).hasAttribute("disabled")).toBe(true);
  });

  it("局部自动整理保留重做栈（preserveRedo）", () => {
    renderPage();
    createPromptCard();
    createPromptCard();
    const first = indexed(promptNodeIds(), 0);

    pressUndo();
    selectNode(first);
    fireEvent.click(screen.getByRole("button", { name: "自动整理" }));

    expect(screen.getByRole("button", { name: "恢复" }).hasAttribute("disabled")).toBe(false);
    pressRedo();
    expect(promptNodeIds()).toHaveLength(2);
  });
});

describe("拖拽吸附接线", () => {
  it("onNodesChange 的 position 与 positionAbsolute 同步落到节点", () => {
    renderPage();
    createPromptCard();
    const id = indexed(promptNodeIds(), 0);

    dragNode(id, { x: 520, y: 380 });

    const node = screen.getByTestId(`prompt-node-${id}`);
    expect(node.getAttribute("data-position")).toBe("520,380");
    expect(node.getAttribute("data-position-absolute")).toBe("520,380");
  });

  it("开启吸附时靠近邻居会吸到邻居坐标并显示对齐线", () => {
    renderPage();
    createPromptCard();
    createPromptCard();
    const first = indexed(promptNodeIds(), 0);
    const second = indexed(promptNodeIds(), 1);
    const firstPos = nodePosition(first);
    const secondPos = nodePosition(second);

    dragNode(second, { x: firstPos.x + 5, y: secondPos.y });

    expect(nodePosition(second).x).toBe(firstPos.x);
    expect(nodePosition(first)).toEqual(firstPos);
    expect(screen.getAllByTestId("snap-guide").length).toBeGreaterThan(0);
  });

  it("关闭吸附后拖动不吸邻居，也不显示对齐线", () => {
    renderPage();
    createPromptCard();
    createPromptCard();
    const first = indexed(promptNodeIds(), 0);
    const second = indexed(promptNodeIds(), 1);
    const firstPos = nodePosition(first);
    const secondPos = nodePosition(second);

    fireEvent.click(screen.getByRole("button", { name: "关闭拖拽吸附" }));
    dragNode(second, { x: firstPos.x + 5, y: secondPos.y });

    expect(nodePosition(second)).toEqual({ x: firstPos.x + 5, y: secondPos.y });
    expect(screen.queryAllByTestId("snap-guide")).toHaveLength(0);
  });
});

describe("右键菜单", () => {
  it("图片节点与提示词节点的菜单动作不同", async () => {
    renderPage();
    createPromptCard();
    await uploadImages([asset("a", "a.png")]);
    const promptId = indexed(promptNodeIds(), 0);

    rightClickNode("img-a");
    expect(screen.getByRole("button", { name: "预览大图" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "裁剪" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "运行" })).toBeNull();
    fireEvent.click(screen.getByTestId("rf-pane"));

    rightClickNode(promptId);
    expect(screen.getByRole("button", { name: "运行" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "复制提示词" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "裁剪" })).toBeNull();
  });

  it("多选时置顶「删除所选 N 项」，点击后批量删除", async () => {
    renderPage();
    await uploadImages([asset("a", "a.png"), asset("b", "b.png")]);
    selectNode("img-a");
    selectNode("img-b", { shiftKey: true });

    rightClickNode("img-b");

    const buttons = screen.getAllByRole("button");
    const menu = screen.getByTestId("node-menu");
    const firstMenuButton = indexed(Array.from(menu.querySelectorAll("button")), 0);
    expect(firstMenuButton.textContent).toBe("删除所选 2 项");
    expect(buttons.length).toBeGreaterThan(0);

    fireEvent.click(firstMenuButton);
    expect(screen.queryByTestId("image-node-img-a")).toBeNull();
    expect(screen.queryByTestId("image-node-img-b")).toBeNull();
  });

  it("图片菜单动作接到对应弹窗", async () => {
    renderPage();
    await uploadImages([asset("a", "a.png")]);

    rightClickNode("img-a");
    fireEvent.click(screen.getByRole("button", { name: "裁剪" }));

    await waitFor(() => expect(screen.getByTestId("crop-modal")).toBeTruthy());
  });

  // 右键菜单的「蒙版重绘」曾只存在于悬停操作栏；两个入口必须落到同一个弹窗。
  it("右键菜单的「蒙版重绘」与悬停操作栏接到同一个弹窗", async () => {
    renderPage();
    await uploadImages([asset("a", "a.png")]);

    rightClickNode("img-a");
    fireEvent.click(screen.getByRole("button", { name: "蒙版重绘" }));

    await waitFor(() => expect(screen.getByTestId("mask-modal")).toBeTruthy());
  });

  it("提示词菜单复制提示词写入剪贴板", async () => {
    renderPage();
    createPromptCard();
    const id = indexed(promptNodeIds(), 0);
    fireEvent.change(screen.getByLabelText(`提示词-${id}`), { target: { value: "a red apple" } });

    rightClickNode(id);
    fireEvent.click(screen.getByRole("button", { name: "复制提示词" }));

    expect(h.clipboardWrite).toHaveBeenCalledWith("a red apple");
    await waitFor(() => expect(screen.getByText("已复制提示词")).toBeTruthy());
  });
});

describe("工作流保存/加载", () => {
  it("保存调用 workflowSave，入参包含名字与去掉动画类的节点", async () => {
    renderPage();
    createPromptCard();
    fireEvent.click(screen.getByRole("button", { name: "保存工作流" }));
    await waitFor(() => expect(screen.getByTestId("save-modal")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("工作流名称"), { target: { value: "我的流程" } });
    fireEvent.click(screen.getByRole("button", { name: "确认保存" }));

    await waitFor(() => expect(workflowSave).toHaveBeenCalledTimes(1));
    const payload = indexed(vi.mocked(workflowSave).mock.calls, 0)[0];
    expect(payload.name).toBe("我的流程");
    expect(payload.edges).toHaveLength(0);
    const savedNode = indexed(payload.nodes, 0);
    expect(savedNode.type).toBe("prompt");
    expect(savedNode.className).toBeUndefined();
    expect(screen.getByText("工作流已保存：D:\\out\\wf.json")).toBeTruthy();
  });

  it("空画布保存只提示，不调用后端", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "保存工作流" }));

    expect(workflowSave).not.toHaveBeenCalled();
    expect(screen.getByText("画布为空，无需保存")).toBeTruthy();
  });

  it("加载调用 workflowLoad 并重建画布", async () => {
    const loaded: WorkflowFile = {
      version: 1,
      name: "w1",
      nodes: [
        {
          id: "prompt-loaded",
          type: "prompt",
          position: { x: 10, y: 20 },
          data: { prompt: "loaded prompt", size: "1024x1024", quality: "high", outputDir: "D:\\out", status: "idle" },
        },
        {
          id: "img-loaded",
          type: "image",
          position: { x: 300, y: 20 },
          data: {
            registryId: "loaded",
            name: "loaded.png",
            url: "http://localhost/loaded.png",
            size: 2048,
            ext: "png",
            refCount: 0,
            absPath: "D:\\out\\loaded.png",
          },
        },
      ],
      edges: [{ id: "e1", source: "img-loaded", target: "prompt-loaded" }],
    };
    vi.mocked(workflowList).mockResolvedValue({ workflows: [{ name: "w1", modified: "2026-01-01" }] });
    vi.mocked(workflowLoad).mockResolvedValue({ ...loaded, missing: [] } as any);

    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "加载工作流" }));
    await waitFor(() => expect(screen.getByTestId("load-modal")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "w1" }));

    await waitFor(() => expect(screen.getByTestId("prompt-node-prompt-loaded")).toBeTruthy());
    expect(workflowLoad).toHaveBeenCalledWith("w1");
    expect(screen.getByDisplayValue("loaded prompt")).toBeTruthy();
    expect(screen.getByTestId("edge-count").textContent).toBe("1");
    expect(screen.getByText("已加载「w1」")).toBeTruthy();
  });

  it("加载失败保留当前画布并提示", async () => {
    vi.mocked(workflowList).mockResolvedValue({ workflows: [{ name: "w1", modified: "2026-01-01" }] });
    vi.mocked(workflowLoad).mockRejectedValue(new Error("boom"));

    renderPage();
    createPromptCard();
    fireEvent.click(screen.getByRole("button", { name: "加载工作流" }));
    await waitFor(() => expect(screen.getByTestId("load-modal")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "w1" }));

    await waitFor(() => expect(screen.getByText("加载失败：boom")).toBeTruthy());
    expect(promptNodeIds()).toHaveLength(1);
  });
});

describe("任务状态机", () => {
  it("提交→排队→生成中→完成，并传递完整入参", async () => {
    renderPage();
    createPromptCard();
    const id = indexed(promptNodeIds(), 0);
    fireEvent.change(screen.getByLabelText(`提示词-${id}`), { target: { value: "a cat" } });

    fireEvent.click(screen.getByRole("button", { name: `运行-${id}` }));

    await waitFor(() => expect(h.taskSubmit).toHaveBeenCalledTimes(1));
    expect(h.taskSubmit).toHaveBeenCalledWith({
      prompt: "a cat",
      refPaths: [],
      files: [],
      size: "1024x1024",
      quality: "high",
      outputDir: "D:\\out",
      win: 0,
    });
    expect(screen.getByTestId(`status-${id}`).getAttribute("data-status")).toBe("queued");

    act(() => {
      h.taskSubscriber?.("task-1", { taskId: "task-1", status: "running", startedAt: 123, results: [], elapsed: 0 });
    });
    expect(screen.getByTestId(`status-${id}`).getAttribute("data-status")).toBe("running");

    act(() => {
      h.taskSubscriber?.("task-1", { taskId: "task-1", status: "done", startedAt: 123, results: [], elapsed: 1 });
    });
    await waitFor(() => expect(screen.getByTestId(`status-${id}`).getAttribute("data-status")).toBe("done"));
    expect(screen.getByTestId(`status-${id}`).textContent).toBe("完成 · 0 张");
  });

  it("失败状态落到节点并记录原因", async () => {
    renderPage();
    createPromptCard();
    const id = indexed(promptNodeIds(), 0);
    fireEvent.change(screen.getByLabelText(`提示词-${id}`), { target: { value: "a cat" } });
    fireEvent.click(screen.getByRole("button", { name: `运行-${id}` }));
    await waitFor(() => expect(h.taskSubmit).toHaveBeenCalled());

    act(() => {
      h.taskSubscriber?.("task-1", {
        taskId: "task-1",
        status: "failed",
        startedAt: 123,
        error: "boom",
        results: [],
        elapsed: 1,
      });
    });

    expect(screen.getByTestId(`status-${id}`).getAttribute("data-status")).toBe("failed");
    expect(screen.getByTestId(`status-${id}`).getAttribute("data-message")).toBe("boom");
  });

  it("任务取消后节点回到就绪并记录日志", async () => {
    renderPage();
    createPromptCard();
    const id = indexed(promptNodeIds(), 0);
    fireEvent.change(screen.getByLabelText(`提示词-${id}`), { target: { value: "a cat" } });
    fireEvent.click(screen.getByRole("button", { name: `运行-${id}` }));
    await waitFor(() => expect(h.taskSubmit).toHaveBeenCalled());

    act(() => {
      h.taskSubscriber?.("task-1", { taskId: "task-1", status: "cancelled", results: [], elapsed: 1 });
    });

    expect(screen.getByTestId(`status-${id}`).getAttribute("data-status")).toBe("idle");
    expect(screen.getByText(`节点 ${id}：任务已取消`)).toBeTruthy();
  });

  it("删除运行中的节点会取消对应任务", async () => {
    renderPage();
    createPromptCard();
    const id = indexed(promptNodeIds(), 0);
    fireEvent.change(screen.getByLabelText(`提示词-${id}`), { target: { value: "a cat" } });
    fireEvent.click(screen.getByRole("button", { name: `运行-${id}` }));
    await waitFor(() => expect(h.taskSubmit).toHaveBeenCalled());
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: `删除节点-${id}` }));

    expect(h.taskCancel).toHaveBeenCalledWith("task-1");
    expect(screen.queryByTestId(`prompt-node-${id}`)).toBeNull();
  });
});

describe("取消入口（issue #33）", () => {
  /** 建卡 → 填词 → 运行，直到提交完成（taskId 已登记，可以取消了） */
  async function runCard() {
    renderPage();
    createPromptCard();
    const id = indexed(promptNodeIds(), 0);
    fireEvent.change(screen.getByLabelText(`提示词-${id}`), { target: { value: "a cat" } });
    fireEvent.click(screen.getByRole("button", { name: `运行-${id}` }));
    await waitFor(() => expect(h.taskSubmit).toHaveBeenCalled());
    // 等提交的 promise 链落地：taskId 是在 await 之后才登记进 nodeTaskRef 的
    await act(async () => {});
    return id;
  }

  it("单卡取消：请求后端并置「取消中」，不立刻复位成就绪", async () => {
    const id = await runCard();

    fireEvent.click(screen.getByRole("button", { name: `取消-${id}` }));

    expect(h.taskCancel).toHaveBeenCalledWith("task-1");
    expect(screen.getByText(`节点 ${id}：已请求取消（生成中的会在当前这张完成后停下）`)).toBeTruthy();
    // 关键：还在跑，状态不能假装已经停下（后端是「跑完当前张再丢弃结果」）
    expect(screen.getByTestId(`status-${id}`).getAttribute("data-status")).toBe("queued");
    expect((screen.getByRole("button", { name: `取消-${id}` }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("终态 cancelled 到达：取消中标记清掉，卡片回到就绪", async () => {
    const id = await runCard();
    fireEvent.click(screen.getByRole("button", { name: `取消-${id}` }));

    act(() => {
      h.taskSubscriber?.("task-1", { taskId: "task-1", status: "cancelled", results: [], elapsed: 1 });
    });

    expect(screen.getByTestId(`status-${id}`).getAttribute("data-status")).toBe("idle");
    // 取消了就不该再有取消按钮（就绪卡片上没有可取消的东西）
    expect(screen.queryByRole("button", { name: `取消-${id}` })).toBeNull();
  });

  it("服务端不认取消（任务已过期 404）：按钮要能回到可点，不能卡在「取消中」", async () => {
    const id = await runCard();
    fireEvent.click(screen.getByRole("button", { name: `取消-${id}` }));

    // 服务端快照里 cancelRequested 仍是 false / 缺失 → 以快照为准回退
    act(() => {
      h.taskSubscriber?.("task-1", { taskId: "task-1", status: "running", startedAt: 1, results: [], elapsed: 2 });
    });

    const cancel = screen.getByRole("button", { name: `取消-${id}` }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(false);
  });

  it("工具栏「取消全部」：只在有任务在跑时出现，点击取消每个在跑任务", async () => {
    h.tasks = [
      { taskId: "task-1", status: "running" },
      { taskId: "task-2", status: "queued" },
      { taskId: "task-3", status: "done" },
    ];
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "取消全部 (2)" }));

    // 只有 queued/running 算「在跑」，done 不重复取消
    expect(h.taskCancel).toHaveBeenCalledTimes(2);
    expect(h.taskCancel).toHaveBeenCalledWith("task-1");
    expect(h.taskCancel).toHaveBeenCalledWith("task-2");
    expect(screen.getByText("已请求取消 2 个任务（生成中的会在当前这张完成后停下）")).toBeTruthy();
  });

  it("没有任务在跑时不出现「取消全部」（避免一个点了没反应的按钮）", () => {
    renderPage();

    expect(screen.queryByRole("button", { name: /取消全部/ })).toBeNull();
  });
});

describe("画布偏好", () => {
  it("缩放滑杆百分比与视口缩放互转", () => {
    renderPage();
    const slider = screen.getByRole("slider", { name: "画布缩放" });
    expect((slider as HTMLInputElement).value).toBe("100");

    fireEvent.change(slider, { target: { value: "150" } });
    expect(h.zoomTo).toHaveBeenCalledWith(1.5, { duration: 0 });
    expect(slider.getAttribute("aria-valuetext")).toBe("150%");

    fireEvent.pointerUp(slider);
    expect(window.localStorage.getItem("imagora.canvas-zoom-slider.v1")).toBe("150");

    moveViewport(0.5);
    expect((slider as HTMLInputElement).value).toBe("50");
  });

  it("小地图显隐偏好读写并挂载/卸载 MiniMap", () => {
    renderPage();
    expect(screen.queryByTestId("minimap")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "显示小地图" }));
    expect(screen.getByTestId("minimap")).toBeTruthy();
    expect(window.localStorage.getItem("imagora.canvas-minimap.v1")).toBe("1");

    fireEvent.click(screen.getByRole("button", { name: "隐藏小地图" }));
    expect(screen.queryByTestId("minimap")).toBeNull();
    expect(window.localStorage.getItem("imagora.canvas-minimap.v1")).toBe("0");
  });

  it("吸附开关偏好写入 localStorage", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "关闭拖拽吸附" }));
    expect(window.localStorage.getItem("imagora.canvas-snap.v1")).toBe("0");

    fireEvent.click(screen.getByRole("button", { name: "开启拖拽吸附" }));
    expect(window.localStorage.getItem("imagora.canvas-snap.v1")).toBe("1");
  });
});

describe("统计刷新（counts）", () => {
  it("新增图片节点后统计立即反映张数", async () => {
    renderPage();
    await uploadImages([asset("a", "a.png"), asset("b", "b.png"), asset("c", "c.png")]);

    expect(screen.getAllByText("未引用")).toHaveLength(3);
  });

  it("把图片接到提示词后引用计数立即变化", async () => {
    renderPage();
    createPromptCard();
    const promptId = indexed(promptNodeIds(), 0);
    await uploadImages([asset("a", "a.png")]);

    connectNodes("img-a", promptId);

    expect(screen.getByTestId("ref-img-a").textContent).toBe("引用 1 处");
  });

  it("组内删除图片后组统计立即减一", async () => {
    renderPage();
    createGroupCard();
    await uploadImages([asset("a", "a.png"), asset("b", "b.png")]);
    const groupId = screen.getByTestId(/^group-node-/).getAttribute("data-testid")?.slice("group-node-".length);
    if (!groupId) throw new Error("找不到图片组");
    connectNodes("img-a", groupId);
    connectNodes("img-b", groupId);
    expect(screen.getByTestId(`group-count-${groupId}`).textContent).toBe("2 张图");

    fireEvent.click(screen.getByRole("button", { name: "删除图片-img-a" }));

    expect(screen.getByTestId(`group-count-${groupId}`).textContent).toBe("1 张图");
  });

  it("替换组内图片后组总大小立即更新", async () => {
    renderPage();
    createGroupCard();
    await uploadImages([asset("a", "a.png", 1024 * 1024)]);
    const groupId = screen.getByTestId(/^group-node-/).getAttribute("data-testid")?.slice("group-node-".length);
    if (!groupId) throw new Error("找不到图片组");
    connectNodes("img-a", groupId);
    expect(screen.getByTestId(`group-size-${groupId}`).textContent).toBe("1.0 MB");

    fireEvent.click(screen.getByRole("button", { name: "替换图片-img-a" }));
    const inputs = document.querySelectorAll('input[type="file"]');
    const replaceInput = inputs[1];
    if (!(replaceInput instanceof HTMLInputElement)) throw new Error("找不到替换文件输入框");
    vi.mocked(canvasUpload).mockResolvedValueOnce({ images: [asset("a2", "a2.png", 5 * 1024 * 1024)] });
    fireEvent.change(replaceInput, {
      target: { files: [new File(["x"], "a2.png", { type: "image/png" })] },
    });

    await waitFor(() => expect(screen.getByText("a2.png")).toBeTruthy());
    expect(screen.getByTestId(`group-size-${groupId}`).textContent).toBe("5.0 MB");
  });
});

describe("结果回流：把新节点带进视野", () => {
  /** 造一条「结果图已生成」的任务快照：url 里的 path 是回流导入的输入 */
  const okResult = {
    status: "ok" as const,
    url: "/api/image?path=D%3A%5Cout%5Ca.png",
  };

  function landResult(): void {
    act(() => {
      h.taskSubscriber?.("task-1", {
        taskId: "task-1",
        status: "done",
        startedAt: 1,
        results: [okResult],
        elapsed: 1,
      });
    });
  }

  it("结果图落在视口下沿之外时平移视口（缩放不被抢走）", async () => {
    // 默认 getBoundingClientRect 是 800x600：卡片在视口中心（约 y=300），
    // 结果图落在卡片正下方（y≈680），整块在视口外 —— 真实事故的几何复现。
    vi.mocked(importHistoryAsset).mockResolvedValue({
      imported: [asset("abc", "a.png")],
      skipped: [],
    });
    renderPage();
    createPromptCard();
    const id = indexed(promptNodeIds(), 0);
    fireEvent.change(screen.getByLabelText(`提示词-${id}`), { target: { value: "a cat" } });
    fireEvent.click(screen.getByRole("button", { name: `运行-${id}` }));
    await waitFor(() => expect(h.taskSubmit).toHaveBeenCalled());

    landResult();

    await waitFor(() => expect(h.setViewport).toHaveBeenCalledTimes(1));
    // 无参 vi.fn() 的 calls 被推成 [[]]，args 取不出来，这里显式断言形状
    const call = h.setViewport.mock.calls[0] as unknown as [unknown, unknown?];
    const viewport = call[0] as { x: number; y: number; zoom: number };
    expect(viewport.zoom).toBe(1);
    expect(viewport.y).toBeLessThan(0);
    expect(call[1]).toEqual({ duration: 220 });
  });

  it("结果图本来就在视野内时不碰视口", async () => {
    // 把视口撑到 2000 高：卡片落在中心（y≈1000），结果图 y≈1380 仍可见 → 不该平移
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 800,
      bottom: 2000,
      width: 800,
      height: 2000,
      toJSON: () => ({}),
    });
    vi.mocked(importHistoryAsset).mockResolvedValue({
      imported: [asset("abc", "a.png")],
      skipped: [],
    });
    renderPage();
    createPromptCard();
    const id = indexed(promptNodeIds(), 0);
    fireEvent.change(screen.getByLabelText(`提示词-${id}`), { target: { value: "a cat" } });
    fireEvent.click(screen.getByRole("button", { name: `运行-${id}` }));
    await waitFor(() => expect(h.taskSubmit).toHaveBeenCalled());

    landResult();

    await waitFor(() => expect(screen.getByTestId("rf-node-img-abc")).toBeTruthy());
    expect(h.setViewport).not.toHaveBeenCalled();
  });
});

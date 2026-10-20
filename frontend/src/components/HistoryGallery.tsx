import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";

import {
  generationHistory,
  generationStats,
  openFolder,
  saveBudget,
  type BudgetSettings,
  type GenerationHistoryItem,
  type HistoryStats,
} from "../api";
import { errMessage } from "../format";
import { useImageZoom } from "../useImageZoom";
import { CostBoard } from "./CostBoard";
import { ModalShell } from "./ModalShell";
import { Select } from "./Select";
import { ZoomModal } from "./WorkflowModals";

function parentDirectory(path: string): string {
  return path.replace(/[\\/][^\\/]+$/, "");
}

/** 提示词行：先显示 2 行、超出省略（line-clamp-2）；仅当文字确实被截断时，悬浮显示完整多行（短文案不弹无意义浮层）。
    定位：**单轴跟随鼠标 Y**，宽度固定屏幕 80% 且水平居中（左/右各留 10vw，永不出屏），高度随行数自动长。
    渲染走 createPortal 到 body —— 弹窗面板自带 `overflow: hidden` 且入场动画留下 transform，
    fixed 定位在带 transform 的祖先里会以「那个祖先」为包含块而不是视口：不 Portal 就会被面板裁掉、
    而且 window.innerHeight 的 clamp 也在错误坐标系里量（曾表现为浮层飘到面板底部、下半截看不见）。 */
function PromptCell({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  /** null = 不显示 */
  const [tipY, setTipY] = useState<number | null>(null);
  const [top, setTop] = useState(0);

  const onEnter = (event: MouseEvent<HTMLParagraphElement>) => {
    const el = ref.current;
    // scrollHeight > clientHeight 即发生了 2 行截断，才需要浮层补全
    if (el && el.scrollHeight > el.clientHeight) setTipY(event.clientY);
  };
  const onMove = (event: MouseEvent<HTMLParagraphElement>) => {
    setTipY((cur) => (cur != null ? event.clientY : cur));
  };
  const onLeave = () => {
    setTipY(null);
    setTop(0);
  };

  // 跟随鼠标 y 并整体夹进视口（下边溢出靠挪位，而不是让它被切掉）。
  // 再高就顶到 8px，并由 max-height + 自身滚动兜底，保证长提示词也读得到底。
  useLayoutEffect(() => {
    if (tipY != null && tipRef.current) {
      const rect = tipRef.current.getBoundingClientRect();
      setTop(Math.max(8, Math.min(tipY + 16, window.innerHeight - rect.height - 8)));
    }
  }, [tipY, text]);

  return (
    <>
      <p
        ref={ref}
        onMouseEnter={onEnter}
        onMouseMove={onMove}
        onMouseLeave={onLeave}
        className="line-clamp-2 text-xs leading-4 text-neutral-700"
      >
        {text}
      </p>
      {tipY != null &&
        createPortal(
          <div
            ref={tipRef}
            data-testid="prompt-tip"
            className="pointer-events-none fixed z-[60] max-h-[calc(100vh-16px)] overflow-y-auto rounded-lg bg-neutral-800 px-3 py-2 text-xs leading-5 text-white shadow-lg"
            style={{
              // 宽固定屏幕 80% 且水平居中（左/右各留 10vw，永不出屏）
              left: "10vw",
              width: "80vw",
              top,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {text}
          </div>,
          document.body,
        )}
    </>
  );
}

export function HistoryGallery({
  open,
  onClose,
  onImport,
}: {
  open: boolean;
  onClose: () => void;
  onImport: (path: string) => Promise<void>;
}) {
  const [items, setItems] = useState<GenerationHistoryItem[]>([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  /** 聚合后是否还有下一页（滚动到底 / 点「加载更多」追加，避免一次渲染 200 条卡顿） */
  const [hasMore, setHasMore] = useState(false);
  /** 首屏加载 / 翻页追加用两个独立状态，追加时不遮住已渲染列表 */
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  /** 滚动容器（接近底部自动翻页的判定基准） */
  const listRef = useRef<HTMLDivElement>(null);
  /** 请求代次：搜索/状态/重开变化自增，旧响应（竞态）丢弃 */
  const seqRef = useRef(0);
  /** 最新 items 长度镜像，翻页 offset 不依赖闭包里的过期 items */
  const itemsRef = useRef<GenerationHistoryItem[]>([]);
  /** query/status 镜像：回调保持稳定引用（open 打开 effect 只依赖 open），又能读到最新筛选值 */
  const queryRef = useRef(query);
  const statusRef = useRef(status);
  queryRef.current = query;
  statusRef.current = status;
  /** 单击开原图 / 双击放大预览（与经典表单结果图同款交互，共用 ZoomModal） */
  const { zoom, handleClick, handleDoubleClick, closeZoom } = useImageZoom();

  /* ---------------- 成本看板 ---------------- */
  const [stats, setStats] = useState<HistoryStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  /** 成本看板读取失败的一句话提示；null = 无 */
  const [statsNotice, setStatsNotice] = useState<string | null>(null);

  /** 图生图失败但参考图已找不回的记录数（只提示，无法重跑）。
      服务端给 inputRefMissing 标记；若没给，则按「声明了参考图却一张都没带上」推断。 */
  const lostRefCount = useMemo(
    () =>
      items.filter(
        (it) =>
          it.status === "error" && (it.inputRefMissing || ((it.refs ?? 0) > 0 && !it.inputRefs?.length)),
      ).length,
    [items],
  );

  /** 分页大小：DOM 总量控制在单页数量级，滚动顺滑 */
  const PAGE_SIZE = 60;

  /** 成本看板数据（账本原始行聚合 + 预算占用） */
  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      setStats(await generationStats());
    } catch (err) {
      setStatsNotice(`成本统计读取失败：${errMessage(err)}`);
    } finally {
      setStatsLoading(false);
    }
  }, []);

  /** 保存本机预算设置并回读看板（0 = 不限） */
  const handleSaveBudget = useCallback(async (settings: BudgetSettings) => {
    await saveBudget(settings);
    await loadStats();
  }, [loadStats]);

  /** 首屏 / 搜索重载：重置分页从第 0 页拉取（overrides 用于 select 等"值刚变"的场景） */
  const load = useCallback(
    async (overrides?: { query?: string; status?: string }) => {
      const seq = ++seqRef.current;
      setLoading(true);
      setError("");
      try {
        const result = await generationHistory({
          limit: PAGE_SIZE,
          offset: 0,
          query: overrides?.query ?? queryRef.current,
          status: overrides?.status ?? statusRef.current,
        });
        if (seq !== seqRef.current) return; // 期间搜索/筛选已变，丢弃本次结果
        setItems(result.items);
        itemsRef.current = result.items;
        setHasMore(result.hasMore);
      } catch (err) {
        if (seq !== seqRef.current) return;
        setError(errMessage(err));
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    },
    [],
  );

  /** 追加下一页：offset = 当前已加载条数（聚合后语义，见 /api/history 契约） */
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    const seq = seqRef.current;
    setLoadingMore(true);
    setError("");
    try {
      const result = await generationHistory({
        limit: PAGE_SIZE,
        offset: itemsRef.current.length,
        query: queryRef.current,
        status: statusRef.current,
      });
      if (seq !== seqRef.current) return;
      setItems((prev) => [...prev, ...result.items]);
      itemsRef.current = [...itemsRef.current, ...result.items];
      setHasMore(result.hasMore);
    } catch (err) {
      if (seq !== seqRef.current) return;
      setError(errMessage(err));
    } finally {
      if (seq === seqRef.current) setLoadingMore(false);
    }
  }, [hasMore, loadingMore]);

  useEffect(() => {
    if (open) {
      void load();
      void loadStats();
    }
  }, [load, loadStats, open]);



  /** 接近底部阈值（px）：提前预载下一页，滚到手感不间断 */
  const NEAR_BOTTOM_PX = 600;

  /** 滚动接近底部 → 自动翻页（loadMore 内部有 hasMore/loadingMore 守卫，高频滚动安全） */
  const handleScroll = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    if (list.scrollHeight - list.scrollTop - list.clientHeight < NEAR_BOTTOM_PX) void loadMore();
  }, [loadMore]);

  /** 追加后仍未占满可视区（历史总量 < 一个视口）→ 自动续拉直到填满或无更多；
   *  clientHeight===0 判定"未布局"环境（jsdom 无滚动布局）跳过，避免测试里连锁拉空 mock。 */
  useEffect(() => {
    const list = listRef.current;
    if (!open || !list || !hasMore || loadingMore) return;
    if (list.clientHeight === 0) return;
    if (list.scrollHeight - list.scrollTop - list.clientHeight < NEAR_BOTTOM_PX) void loadMore();
  }, [open, items.length, hasMore, loadingMore, loadMore]);

  if (!open) return null;
  return (
    <>
      <ModalShell title="生成历史" onClose={onClose} className="history-modal modal-panel--history corner-rings" overlayClassName="history-overlay">
        <header className="flex flex-wrap items-center gap-2 border-b border-neutral-200 surface-float px-4 py-3">
          <h2 className="mr-2 text-sm font-semibold">生成历史</h2>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void load(); }}
            placeholder="搜索提示词、质量或文件名"
            className="field-control !w-72 !py-1"
          />
          <Select
            value={status}
            onChange={(next) => { setStatus(next); void load({ status: next }); }}
            className="w-28"
            options={[{ value: "", label: "全部状态" }, { value: "ok", label: "成功" }, { value: "error", label: "失败" }]}
          />
          <button type="button" className="btn-ghost !px-3 !py-1" onClick={() => void load()}>搜索</button>

          {lostRefCount > 0 && (
            <span className="text-[11px] text-amber-600" title="图生图记录但参考图已从资产库找不回，无法还原">
              {lostRefCount} 条参考图已丢失
            </span>
          )}
          <button type="button" className="btn-ghost ml-auto !px-3 !py-1" onClick={onClose}>关闭</button>
        </header>
        <CostBoard
          stats={stats}
          loading={statsLoading}
          onRefresh={() => void loadStats()}
          onSaveBudget={handleSaveBudget}
        />
        {statsNotice && (
          <div data-testid="stats-notice" className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-[11px] text-amber-800">
            {statsNotice}
          </div>
        )}

        <div ref={listRef} data-testid="history-list" onScroll={handleScroll} className="min-h-0 flex-1 overflow-auto p-4">
          {error && <div className="mb-3 border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
          {loading ? (
            <div className="py-16 text-center text-sm text-neutral-400">正在读取历史...</div>
          ) : items.length ? (
            /* 列表视图：两栏网格卡片。横排卡片——左侧 160px 结果图占满卡片高度，
               右侧提示词随容器宽（2 行截断）+ 大参考图 + 全文字按钮（底部对齐）；结果图 min-h-36 兜底卡片高度。 */
            <>
              <ul className="grid grid-cols-2 gap-3">
              {items.map((item, index) => {
                return (
                <li key={`${item.time}-${item.output}-${index}`} className="flex gap-3 rounded-lg border border-neutral-200 surface-float p-3">
                  <div className="w-40 min-h-36 flex-none self-stretch overflow-hidden bg-neutral-100">
                    {item.url ? (
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noreferrer"
                        className="block h-full w-full"
                        title="单击新窗口打开原图 · 双击放大预览"
                      >
                        <div
                          className="h-full w-full cursor-zoom-in"
                          onClick={(e) => handleClick(e, { url: item.url, name: item.prompt || "生成结果" })}
                          onDoubleClick={() => handleDoubleClick({ url: item.url, name: item.prompt || "生成结果" })}
                        >
                          <img src={item.url} alt={item.prompt || "生成结果"} loading="lazy" decoding="async" className="h-full w-full object-contain" />
                        </div>
                      </a>
                    ) : (
                      <div className="flex h-full w-full items-center justify-center px-1">
                        <span className="text-center text-[11px] leading-tight text-neutral-400">{item.status === "error" ? "生成失败" : "文件已移动"}</span>
                      </div>
                    )}
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <PromptCell text={item.prompt || "无提示词"} />
                    <p className="text-[10px] text-neutral-400">{item.time} · {item.quality || "-"} · {item.size || "-"}</p>
                    {item.inputRefs && item.inputRefs.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {item.inputRefs.map((ref) => (
                          <div
                            key={ref.id}
                            className="h-14 w-14 cursor-zoom-in overflow-hidden border border-neutral-200 bg-neutral-100"
                            title="单击新窗口打开参考图 · 双击放大预览"
                            onClick={(e) => handleClick(e, { url: ref.url, name: "参考图" })}
                            onDoubleClick={() => handleDoubleClick({ url: ref.url, name: "参考图" })}
                          >
                            <img src={ref.url} alt="参考图" loading="lazy" decoding="async" className="h-full w-full object-cover" />
                          </div>
                        ))}
                      </div>
                    )}
                    {item.inputRefMissing && <p className="text-[10px] text-amber-600">参考图缺失</p>}
                    <div className="mt-auto flex gap-1.5">
                      <button type="button" className="btn-ghost min-w-0 flex-1 !px-1.5 !py-1 text-[11px]" onClick={() => void navigator.clipboard.writeText(item.prompt || "")}>复制提示词</button>
                      <button type="button" disabled={!item.path} className="btn-ghost min-w-0 flex-1 !px-1.5 !py-1 text-[11px]" onClick={() => void openFolder(parentDirectory(item.path))}>打开目录</button>
                      <button type="button" disabled={!item.path} className="btn-primary min-w-0 flex-1 !px-1.5 !py-1 text-[11px]" onClick={() => void onImport(item.path)}>导入当前画布</button>
                    </div>
                  </div>
                </li>
                );
              })}
            </ul>
            {/* 底部翻页区：滚动接近底部自动加载，按钮仅作手动兜底 */}
            <div className="py-3 text-center text-xs text-neutral-400">
              {loadingMore ? (
                "正在加载更多..."
              ) : hasMore ? (
                <button type="button" className="btn-ghost !px-3 !py-1 text-xs" onClick={() => void loadMore()}>
                  加载更多
                </button>
              ) : (
                "已显示全部记录"
              )}
            </div>
            </>
          ) : (
            <div className="py-16 text-center text-sm text-neutral-400">没有匹配的生成记录</div>
          )}
        </div>
      </ModalShell>
      {zoom && <ZoomModal imageUrl={zoom.url} name={zoom.name} onClose={closeZoom} />}

    </>
  );
}
// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ResultPanel } from "./ResultPanel";
import type { ResultItem } from "../types";

const META = { refCount: 0, size: "1024x1024", quality: "high", outputDir: "C:/out" };
const ITEM = { status: "ok", message: "已保存", url: "http://x/img.png" } as ResultItem;

/** 回归测试：经典表单结果区 5 态面板（排队/生成/失败/取消/画廊透传）+ 切换过渡（旧层淡出保留） */
describe("ResultPanel 状态面板", () => {
  afterEach(() => {
    cleanup(); // 无 globals 注入时不自动清理，显式清 DOM 防跨用例文本撞车
    vi.useRealTimers();
  });

  it("queued：显示排队面板（琥珀语义 + 参数摘要）", () => {
    render(<ResultPanel status="queued" elapsed={0} meta={META} results={[]} />);
    expect(screen.getByText("排队中…")).toBeTruthy();
    expect(screen.getByText(/文生图 · 1024x1024 · high/)).toBeTruthy();
    expect(screen.queryByText("生成中 0s")).toBeNull();
  });

  it("running：显示生成秒数与预计时长，不出现画廊空态", () => {
    render(<ResultPanel status="running" elapsed={12} meta={META} results={[]} />);
    expect(screen.getByText("生成中 12s")).toBeTruthy();
    expect(screen.getByText(/约需 1-2 分钟/)).toBeTruthy();
    expect(screen.queryByText("还没有结果")).toBeNull();
  });

  it("running：参考图数量出现在参数摘要（图生图）", () => {
    render(<ResultPanel status="running" elapsed={3} meta={{ ...META, refCount: 2 }} results={[]} />);
    expect(screen.getByText(/图生图 · 1024x1024 · high · 参考图 2 张/)).toBeTruthy();
  });

  it("failed：失败面板显示原因，错误摘要可达", () => {
    render(<ResultPanel status="failed" elapsed={0} meta={META} error="PermissionError: [Errno 13]" results={[]} />);
    expect(screen.getByText("生成失败")).toBeTruthy();
    expect(screen.getByText("PermissionError: [Errno 13]")).toBeTruthy();
  });

  it("cancelled：显示已取消面板", () => {
    render(<ResultPanel status="cancelled" elapsed={0} meta={META} results={[]} />);
    expect(screen.getByText("生成已取消")).toBeTruthy();
  });

  it("空态/完成：透传 Gallery（空态文案或图片网格）", () => {
    const { rerender } = render(<ResultPanel status={null} elapsed={0} meta={META} results={[]} />);
    expect(screen.getByText("还没有结果")).toBeTruthy();
    rerender(<ResultPanel status="done" elapsed={0} meta={META} results={[ITEM]} />);
    // 图片不再是链接（单击不再跳新页面，双击才开预览），所以按 alt 找图并断言没有 link
    expect(screen.getByAltText("已保存")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("状态切换：旧面板保留淡出层（交叉淡化），到时移除", () => {
    vi.useFakeTimers();
    const { rerender } = render(<ResultPanel status="queued" elapsed={0} meta={META} results={[]} />);
    rerender(<ResultPanel status="running" elapsed={2} meta={META} results={[]} />);
    // 切换瞬间：旧「排队中」仍保留 + 新「生成中 2s」已入场
    expect(screen.getByText("排队中…")).toBeTruthy();
    expect(screen.getByText("生成中 2s")).toBeTruthy();
    // 淡出结束后旧层移除
    act(() => vi.advanceTimersByTime(250));
    expect(screen.queryByText("排队中…")).toBeNull();
    expect(screen.getByText("生成中 2s")).toBeTruthy();
  });
});

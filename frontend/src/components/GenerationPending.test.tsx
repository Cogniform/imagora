// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GenerationPending } from "./GenerationPending";
import { PENDING_MESSAGES, pendingProgressScale } from "../generationPending";

/** 生成中占位卡：每秒 tick 的进度条 + 文案轮播（只动 transform: scaleX） */
describe("GenerationPending", () => {
  afterEach(() => {
    cleanup(); // 无 globals 注入时不自动清理，显式清 DOM 防跨用例撞车
    vi.useRealTimers();
  });

  it("自走表：0s 起显示纯函数给的起点文案", () => {
    render(<GenerationPending />);
    expect(screen.getByTestId("generation-pending")).toBeTruthy();
    expect(screen.getByText(`生成中 0s · ${PENDING_MESSAGES[0]}`)).toBeTruthy();
  });

  it("每秒 tick 一次：1s / 2s 文案跟着轮播前进", () => {
    vi.useFakeTimers();
    render(<GenerationPending />);

    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText(`生成中 1s · ${PENDING_MESSAGES[0]}`)).toBeTruthy();

    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText(`生成中 2s · ${PENDING_MESSAGES[1]}`)).toBeTruthy();

    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.getByText(`生成中 4s · ${PENDING_MESSAGES[2]}`)).toBeTruthy();
  });

  it("进度条只用 transform: scaleX，且单调变宽", () => {
    vi.useFakeTimers();
    render(<GenerationPending />);
    const bar = screen.getByTestId("generation-pending-bar");

    const read = () => {
      const raw = bar.style.transform; // 期望形如 scaleX(0.1234)
      const m = /^scaleX\(([\d.]+)\)$/.exec(raw);
      expect(m, `进度条 transform 应为 scaleX(n)：${raw}`).not.toBeNull();
      return Number(m?.[1]);
    };

    expect(bar.style.transform.startsWith("scaleX(")).toBe(true);
    const first = read();
    act(() => { vi.advanceTimersByTime(1000); });
    const second = read();
    act(() => { vi.advanceTimersByTime(5000); });
    const third = read();

    expect(first).toBeCloseTo(pendingProgressScale(0), 4);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
    expect(third).toBeLessThanOrEqual(1);
  });

  it("受控 elapsed：不走表，显示父组件给的秒数", () => {
    vi.useFakeTimers();
    const { rerender } = render(<GenerationPending elapsed={7} />);
    expect(screen.getByText(`生成中 7s · ${PENDING_MESSAGES[3]}`)).toBeTruthy();

    act(() => { vi.advanceTimersByTime(5000); });
    expect(screen.getByText(`生成中 7s · ${PENDING_MESSAGES[3]}`)).toBeTruthy();

    rerender(<GenerationPending elapsed={21} />);
    expect(screen.getByText(`生成中 21s · ${PENDING_MESSAGES[0]}`)).toBeTruthy();
  });

  it("label 覆盖整行文案；className / testId 可透传", () => {
    render(<GenerationPending elapsed={3} label="正在串行排队…" className="w-[420px]" testId="pending-x" />);
    const card = screen.getByTestId("pending-x");
    expect(card.className).toContain("w-[420px]");
    expect(card.className).toContain("generation-pending");
    expect(screen.getByText("正在串行排队…")).toBeTruthy();
  });

  it("卸载后停表，不再 setState（避免卸载后计时器泄漏）", () => {
    vi.useFakeTimers();
    const { unmount } = render(<GenerationPending />);
    act(() => { vi.advanceTimersByTime(1000); });
    const pending = vi.getTimerCount();
    expect(pending).toBeGreaterThan(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("无长驻状态：role=status + aria-live，读屏读整行而不是每秒播报", () => {
    render(<GenerationPending elapsed={4} />);
    const card = screen.getByTestId("generation-pending");
    expect(card.getAttribute("role")).toBe("status");
    expect(card.getAttribute("aria-live")).toBe("polite");
    expect(card.getAttribute("aria-label")).toBe(`生成中 4s · ${PENDING_MESSAGES[2]}`);
  });
});

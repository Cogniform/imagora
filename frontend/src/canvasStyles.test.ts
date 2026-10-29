import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./index.css", import.meta.url), "utf8");

describe("canvas connection styles", () => {
  it("keeps stable handle geometry so edges remain aligned at every zoom", () => {
    expect(css).toContain("width: 32px");
    expect(css).toContain("height: 12px");
    expect(css).not.toContain("calc(32px / var(--canvas-zoom, 1))");
    expect(css).not.toContain("calc(12px / var(--canvas-zoom, 1))");
    expect(css).not.toMatch(/react-flow__handle-(?:top|bottom)[\s\S]{0,160}scale\(/);
  });

  it("uses the active window brand for the temporary connection", () => {
    expect(css).toMatch(/react-flow__connection-path[\s\S]*stroke: var\(--color-brand\)/);
    expect(css).not.toMatch(/react-flow__connection-path[\s\S]*#ef4444/);
  });
});

describe("canvas node enter/exit animations", () => {
  it("animates the inner .node-pop card, never the positioning wrapper", () => {
    expect(css).toMatch(/\.react-flow__node\.node-enter \.node-pop\s*\{[^}]*animation:/);
    expect(css).toMatch(/\.react-flow__node\.node-exiting \.node-pop\s*\{[^}]*animation:/);
    // 外层只做类选择器，不允许给 .react-flow__node 自身设置 transform（会与 React Flow 定位冲突）
    expect(css).not.toMatch(/\.react-flow__node\.node-enter\s*\{[^}]*transform/);
    expect(css).not.toMatch(/\.react-flow__node\.node-exiting\s*\{[^}]*transform/);
  });

  it("stagger delays apply to the inner card via descendant selectors", () => {
    for (const n of [1, 2, 3]) {
      expect(css).toMatch(new RegExp(`\\.react-flow__node\\.node-enter\\.enter-delay-${n} \\.node-pop\\s*\\{[^}]*animation-delay`));
    }
  });
});

describe("画布控制坞", () => {
  const page = readFileSync(new URL("./components/CanvasPage.tsx", import.meta.url), "utf8");

  /**
   * 每一行必须带中文标签：这一列原本只有图标（`+ − ⛶ 🔒 ▣ ◎`），用户反馈「完全糊里糊涂」。
   * 同时锁住两个已知几何坑：① 行宽由 `.dock-row` 钉死，不能写 `w-auto`（`115%` 会把整列撑宽）；
   * ② 小地图在左上角 —— 右下角是日志轮播，放一起会把刚出现的日志压住。
   */
  it("控制坞每行都是「图标 + 文字标签」", () => {
    for (const label of ["放大", "缩小", "适应", "聚焦", "吸附", "地图", "帮助"]) {
      expect(page).toContain(`label="${label}"`);
    }
  });

  it("行宽钉死，不靠内容撑开", () => {
    expect(css).toMatch(/\.dock-row\s*\{[^}]*width:\s*64px/);
    expect(page).not.toContain("!w-auto");
  });

  it("小地图放左上角（右下角留给日志轮播）", () => {
    expect(page).toContain('position="top-left"');
  });
});

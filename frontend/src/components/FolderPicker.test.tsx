// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FolderPicker } from "./FolderPicker";
import { selectFolder } from "../api";

vi.mock("../api", () => ({
  selectFolder: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.mocked(selectFolder).mockReset();
});

/* 路径一律用 `value={"..."}` 传：JSX 的属性字面量**不处理反斜杠转义**，
   写成 value="D:\\out" 得到的是两个反斜杠，断言会当场对不上。 */
const CURRENT = "D:\\out";

describe("FolderPicker", () => {
  it("文字档：按钮上是「选择文件夹」，输入框可手输", () => {
    const onChange = vi.fn();
    render(<FolderPicker value={CURRENT} onChange={onChange} />);

    const button = screen.getByRole("button", { name: "选择文件夹" });
    expect(button.textContent).toBe("选择文件夹");

    fireEvent.change(screen.getByDisplayValue(CURRENT), { target: { value: "E:\\other" } });
    expect(onChange).toHaveBeenCalledWith("E:\\other");
  });

  it("图标档：只剩一枚图标按钮，无障碍名仍是「选择文件夹」", () => {
    render(<FolderPicker value={CURRENT} onChange={vi.fn()} icon />);

    // 无障碍名与 hover 文案都在 aria-label / title 上：文字没丢，只是不占版面
    const button = screen.getByRole("button", { name: "选择文件夹" });
    expect(button.getAttribute("title")).toBe("选择文件夹");
    expect(button.textContent?.trim()).toBe("");
    // 图标档必须同时带 .btn-icon：正方形与同高靠这个类在 index.css 里定死
    expect(button.className).toContain("btn-icon");
  });

  it("点按钮弹系统选择器，选中的路径写回；取消（空路径）不动原值", async () => {
    const onChange = vi.fn();
    vi.mocked(selectFolder).mockResolvedValue({ path: "E:\\picked", canceled: false });
    const { rerender } = render(<FolderPicker value="" onChange={onChange} icon />);

    fireEvent.click(screen.getByRole("button", { name: "选择文件夹" }));
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith("E:\\picked"));

    // 取消：服务端回空路径，组件不该把它当成一次修改
    onChange.mockClear();
    vi.mocked(selectFolder).mockResolvedValue({ path: "", canceled: true });
    rerender(<FolderPicker value={CURRENT} onChange={onChange} icon />);
    fireEvent.click(screen.getByRole("button", { name: "选择文件夹" }));
    await vi.waitFor(() => expect(selectFolder).toHaveBeenCalledTimes(2));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("选择器把当前值当起点传下去（重新选时不停在默认目录）", async () => {
    vi.mocked(selectFolder).mockResolvedValue({ path: "E:\\picked", canceled: false });
    render(<FolderPicker value={CURRENT} onChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "选择文件夹" }));
    await vi.waitFor(() => expect(selectFolder).toHaveBeenCalledWith(CURRENT));
  });
});

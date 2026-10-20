// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Field } from "./Field";

afterEach(cleanup);

describe("Field", () => {
  it("label 与控件通过 htmlFor / id 关联", () => {
    render(
      <Field id="api-url" label="API 地址">
        <input id="api-url" />
      </Field>,
    );
    expect(screen.getByLabelText("API 地址")).toBeDefined();
  });

  it("hint 显示在消息槽位 <p> 里，控件 aria-describedby 指向该 <p>", () => {
    render(
      <Field id="api-url" label="API 地址" hint="以 /v1 结尾">
        <input id="api-url" />
      </Field>,
    );
    const p = screen.getByText("以 /v1 结尾");
    expect(p.id).toBe("api-url-message");
    expect(screen.getByLabelText("API 地址").getAttribute("aria-describedby")).toBe(
      "api-url-message",
    );
  });

  it("有 error 时 <p> 显示 error（不是 hint），且只有一行提示", () => {
    render(
      <Field id="api-url" label="API 地址" hint="以 /v1 结尾" error="地址无效">
        <input id="api-url" />
      </Field>,
    );
    expect(screen.getByText("地址无效")).toBeDefined();
    expect(screen.queryByText("以 /v1 结尾")).toBeNull();
  });

  it("有 error 时控件 aria-invalid=true；无 error 时没有该属性", () => {
    const { rerender } = render(
      <Field id="api-url" label="API 地址" error="地址无效">
        <input id="api-url" />
      </Field>,
    );
    expect(screen.getByLabelText("API 地址").getAttribute("aria-invalid")).toBe("true");

    rerender(
      <Field id="api-url" label="API 地址" hint="以 /v1 结尾">
        <input id="api-url" />
      </Field>,
    );
    expect(screen.getByLabelText("API 地址").getAttribute("aria-invalid")).toBeNull();
  });

  it("无 hint 无 error 时不渲染 <p>，控件没有 aria-describedby", () => {
    render(
      <Field id="api-url" label="API 地址">
        <input id="api-url" />
      </Field>,
    );
    expect(document.querySelector("p")).toBeNull();
    expect(screen.getByLabelText("API 地址").getAttribute("aria-describedby")).toBeNull();
  });

  it("action 渲染在 label 行", () => {
    render(
      <Field
        id="api-url"
        label="API 地址"
        action={<button type="button">获取可用模型</button>}
      >
        <input id="api-url" />
      </Field>,
    );
    expect(screen.getByText("获取可用模型")).toBeDefined();
  });

  it("children 不是单个 ReactElement（数组）时不崩，正常渲染", () => {
    render(
      <Field id="api-url" label="API 地址" hint="以 /v1 结尾">
        {["前缀", <input id="api-url" key="ctl" />]}
      </Field>,
    );
    expect(document.getElementById("api-url")).not.toBeNull();
    // 退化路径：不注入 aria，但排版与消息槽位仍正常
    expect(screen.getByText("以 /v1 结尾")).toBeDefined();
  });

  it("children 是字符串时不崩，正常渲染", () => {
    render(
      <Field id="api-url" label="API 地址">
        纯文本控件占位
      </Field>,
    );
    expect(screen.getByText("纯文本控件占位")).toBeDefined();
  });
});

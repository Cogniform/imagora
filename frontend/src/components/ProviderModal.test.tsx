// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetPopupCount } from "../popupLayer";
import { ProviderModal } from "./ProviderModal";

const createProvider = vi.fn();
const probeProviderModels = vi.fn();

vi.mock("../api", () => ({
  createProvider: (...args: unknown[]) => createProvider(...args),
  probeProviderModels: (...args: unknown[]) => probeProviderModels(...args),
}));

const FILE_STATE = {
  envPath: "/tmp/.env",
  configPath: "/tmp/config.json",
  profile: "volc",
  fileProfile: "volc",
  registeredProfiles: ["volc"],
  envNames: { baseUrl: "BASE_URL_VOLC", apiPath: "API_PATH_VOLC", model: "MODEL_VOLC", apiKey: "API_KEY_VOLC" },
  mtimes: { env: 1, config: 1 },
  fields: {
    baseUrl: { fileValue: "" },
    apiPath: { fileValue: "" },
    model: { fileValue: "" },
    apiKey: { configured: false },
  },
  pending: [],
};

function fillBasics(overrides: Partial<Record<"name" | "url" | "key" | "model", string>> = {}) {
  fireEvent.change(screen.getByLabelText("Provider ID"), {
    target: { value: overrides.name ?? "acme" },
  });
  fireEvent.change(screen.getByLabelText("API 地址"), {
    target: { value: overrides.url ?? "https://gateway.example/v1" },
  });
  if (overrides.key) {
    fireEvent.change(screen.getByLabelText("API 密钥"), { target: { value: overrides.key } });
  }
  if (overrides.model !== undefined) {
    fireEvent.change(screen.getByLabelText("默认模型"), { target: { value: overrides.model } });
  }
}

function submitButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "创建供应商" }) as HTMLButtonElement;
}

describe("ProviderModal", () => {
  beforeEach(() => {
    createProvider.mockReset();
    probeProviderModels.mockReset();
    createProvider.mockResolvedValue({
      ok: true,
      name: "acme",
      profile: {},
      path: "/tmp/providers.local.json",
      pending: [],
      fileState: FILE_STATE,
    });
  });

  afterEach(() => {
    cleanup();
    resetPopupCount();
    vi.useRealTimers();
  });

  it("必填项没填时创建按钮是禁用的", () => {
    render(<ProviderModal registeredNames={[]} onClose={vi.fn()} onCreated={vi.fn()} />);
    expect(submitButton().disabled).toBe(true);
  });

  it("填齐 ID 与地址后按钮可用", () => {
    render(<ProviderModal registeredNames={[]} onClose={vi.fn()} onCreated={vi.fn()} />);
    fillBasics();
    expect(submitButton().disabled).toBe(false);
  });

  it("Provider ID 格式错误时给出提示并禁用按钮", () => {
    render(<ProviderModal registeredNames={[]} onClose={vi.fn()} onCreated={vi.fn()} />);
    fillBasics({ name: "Acme Gateway" });
    expect(screen.getByText(/只能小写字母开头/)).toBeTruthy();
    expect(submitButton().disabled).toBe(true);
  });

  it("ID 与已注册来源重名时拦住", () => {
    render(<ProviderModal registeredNames={["acme"]} onClose={vi.fn()} onCreated={vi.fn()} />);
    fillBasics({ name: "acme" });
    expect(screen.getByText("这个 ID 已被占用")).toBeTruthy();
    expect(submitButton().disabled).toBe(true);
  });

  it("地址缺协议时拦住", () => {
    render(<ProviderModal registeredNames={[]} onClose={vi.fn()} onCreated={vi.fn()} />);
    fillBasics({ url: "gateway.example/v1" });
    expect(screen.getByText(/需要以 http:\/\/ 或 https:\/\/ 开头/)).toBeTruthy();
    expect(submitButton().disabled).toBe(true);
  });

  it("提交时把表单整理成 draft（空字段不传）", async () => {
    const onCreated = vi.fn();
    render(<ProviderModal registeredNames={[]} onClose={vi.fn()} onCreated={onCreated} />);
    fillBasics();
    fireEvent.click(submitButton());

    await waitFor(() => expect(createProvider).toHaveBeenCalledTimes(1));
    const draft = createProvider.mock.calls[0]![0] as Record<string, unknown>;
    expect(draft.name).toBe("acme");
    expect(draft.baseUrl).toBe("https://gateway.example/v1");
    expect(draft.protocol).toBe("openai");
    expect(draft.model).toBe("");
    expect(draft.activate).toBe(false);
    // 没填的密钥 / 自定义路径不该出现在请求体里
    expect("apiKey" in draft).toBe(false);
    expect("generationsPath" in draft).toBe(false);
  });

  it("填了密钥才传 apiKey", async () => {
    render(<ProviderModal registeredNames={[]} onClose={vi.fn()} onCreated={vi.fn()} />);
    fillBasics({ key: "sk-abc" });
    fireEvent.click(submitButton());
    await waitFor(() => expect(createProvider).toHaveBeenCalledTimes(1));
    expect((createProvider.mock.calls[0]![0] as Record<string, unknown>).apiKey).toBe("sk-abc");
  });

  it("勾选「创建后切换」才传 activate", async () => {
    render(<ProviderModal registeredNames={[]} onClose={vi.fn()} onCreated={vi.fn()} />);
    fillBasics();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(submitButton());
    await waitFor(() => expect(createProvider).toHaveBeenCalledTimes(1));
    expect((createProvider.mock.calls[0]![0] as Record<string, unknown>).activate).toBe(true);
  });

  it("成功后把结果交给上层（由上层刷新配置）", async () => {
    const onCreated = vi.fn();
    render(<ProviderModal registeredNames={[]} onClose={vi.fn()} onCreated={onCreated} />);
    fillBasics();
    fireEvent.click(submitButton());
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect((onCreated.mock.calls[0]![0] as { name: string }).name).toBe("acme");
  });

  it("失败时显示原因且不关窗", async () => {
    createProvider.mockRejectedValueOnce(new Error("HTTP 400: 来源「acme」已存在"));
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(<ProviderModal registeredNames={[]} onClose={onClose} onCreated={onCreated} />);
    fillBasics();
    fireEvent.click(submitButton());

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("已存在"));
    expect(onCreated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("自定义协议必须填生成路径", () => {
    render(<ProviderModal registeredNames={[]} onClose={vi.fn()} onCreated={vi.fn()} />);
    fillBasics();
    fireEvent.click(screen.getByRole("button", { name: "API 协议" }));
    fireEvent.click(screen.getByRole("option", { name: "自定义路径" }));
    expect(screen.getByText("自定义协议必须填 generations 路径")).toBeTruthy();
    expect(submitButton().disabled).toBe(true);
  });

  it("自定义路径不以 / 开头时拦住", () => {
    render(<ProviderModal registeredNames={[]} onClose={vi.fn()} onCreated={vi.fn()} />);
    fillBasics();
    fireEvent.click(screen.getByRole("button", { name: "API 协议" }));
    fireEvent.click(screen.getByRole("option", { name: "自定义路径" }));
    fireEvent.change(screen.getByLabelText("生成路径"), { target: { value: "v1/images" } });
    expect(screen.getByText("路径必须以 / 开头")).toBeTruthy();
  });

  it("自定义协议填好后随请求带上路径", async () => {
    render(<ProviderModal registeredNames={[]} onClose={vi.fn()} onCreated={vi.fn()} />);
    fillBasics();
    fireEvent.click(screen.getByRole("button", { name: "API 协议" }));
    fireEvent.click(screen.getByRole("option", { name: "自定义路径" }));
    fireEvent.change(screen.getByLabelText("生成路径"), { target: { value: "/v2/paint" } });
    fireEvent.click(submitButton());

    await waitFor(() => expect(createProvider).toHaveBeenCalledTimes(1));
    const draft = createProvider.mock.calls[0]![0] as Record<string, unknown>;
    expect(draft.protocol).toBe("custom");
    expect(draft.generationsPath).toBe("/v2/paint");
  });

  it("「获取可用模型」探到清单后切成下拉并自动选第一个", async () => {
    probeProviderModels.mockResolvedValue({
      ok: true,
      models: [
        { id: "gpt-image-2", label: "gpt-image-2" },
        { id: "dall-e-3", label: "dall-e-3" },
      ],
    });
    render(<ProviderModal registeredNames={[]} onClose={vi.fn()} onCreated={vi.fn()} />);
    fillBasics();
    fireEvent.click(screen.getByRole("button", { name: "获取可用模型" }));

    // 探到清单后模型字段从文本框换成下拉（datalist 会按输入过滤、原生渲染还随浏览器变，
    // 曾经导致「上游 7 个模型只显示 2 个」）。下拉的触发器可访问名来自 label。
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "默认模型" }).textContent).toBe("gpt-image-2"),
    );
    expect(screen.getByText(/探到 2 个模型/)).toBeTruthy();
  });

  it("探到清单后可以点「手填」切回文本框", async () => {
    probeProviderModels.mockResolvedValue({
      ok: true,
      models: [
        { id: "gpt-image-2", label: "gpt-image-2" },
        { id: "dall-e-3", label: "dall-e-3" },
      ],
    });
    render(<ProviderModal registeredNames={[]} onClose={vi.fn()} onCreated={vi.fn()} />);
    fillBasics();
    fireEvent.click(screen.getByRole("button", { name: "获取可用模型" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "手填" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "手填" }));
    const input = screen.getByLabelText("默认模型") as HTMLInputElement;
    expect(input.tagName).toBe("INPUT");
    // 当前值在清单里，切回手填时不该被清掉
    expect(input.value).toBe("gpt-image-2");
  });

  it("清单外的 ID 手填后能原样提交（不许剥夺自定义模型）", async () => {
    probeProviderModels.mockResolvedValue({
      ok: true,
      models: [{ id: "gpt-image-2", label: "gpt-image-2" }],
    });
    render(<ProviderModal registeredNames={[]} onClose={vi.fn()} onCreated={vi.fn()} />);
    fillBasics();
    fireEvent.click(screen.getByRole("button", { name: "获取可用模型" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "手填" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "手填" }));
    fireEvent.change(screen.getByLabelText("默认模型"), { target: { value: "my-private-model" } });
    fireEvent.click(submitButton());

    await waitFor(() => expect(createProvider).toHaveBeenCalledTimes(1));
    expect((createProvider.mock.calls[0]![0] as Record<string, unknown>).model).toBe(
      "my-private-model",
    );
  });

  it("探测带上当前密钥与 ID（便于服务端复用已存的 Key）", async () => {
    probeProviderModels.mockResolvedValue({ ok: true, models: [] });
    render(<ProviderModal registeredNames={[]} onClose={vi.fn()} onCreated={vi.fn()} />);
    fillBasics({ key: "sk-probe" });
    fireEvent.click(screen.getByRole("button", { name: "获取可用模型" }));

    await waitFor(() => expect(probeProviderModels).toHaveBeenCalledTimes(1));
    expect(probeProviderModels.mock.calls[0]![0]).toEqual({
      baseUrl: "https://gateway.example/v1",
      apiKey: "sk-probe",
      name: "acme",
    });
  });

  it("探测失败时显示原因，且不阻止手填", async () => {
    probeProviderModels.mockRejectedValueOnce(new Error("连接不上该地址：ConnectionError"));
    render(<ProviderModal registeredNames={[]} onClose={vi.fn()} onCreated={vi.fn()} />);
    fillBasics();
    fireEvent.click(screen.getByRole("button", { name: "获取可用模型" }));

    await waitFor(() => expect(screen.getByText(/连接不上该地址/)).toBeTruthy());
    expect(submitButton().disabled).toBe(false);
  });

  it("地址为空时「获取可用模型」是禁用的", () => {
    render(<ProviderModal registeredNames={[]} onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Provider ID"), { target: { value: "acme" } });
    const probeBtn = screen.getByRole("button", { name: "获取可用模型" }) as HTMLButtonElement;
    expect(probeBtn.disabled).toBe(true);
  });

  it("弹窗有 dialog 语义与稳定 testId", () => {
    render(<ProviderModal registeredNames={[]} onClose={vi.fn()} onCreated={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "添加第三方供应商" })).toBeTruthy();
    expect(document.querySelector('[data-testid="provider-modal"]')).toBeTruthy();
  });

  it("Esc 关窗（没有展开的浮层时）", () => {
    const onClose = vi.fn();
    render(<ProviderModal registeredNames={[]} onClose={onClose} onCreated={vi.fn()} />);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("下拉展开时 Esc 先收下拉，不关窗", () => {
    const onClose = vi.fn();
    render(<ProviderModal registeredNames={[]} onClose={onClose} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "API 协议" }));
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});

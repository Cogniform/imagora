import { useMemo, useRef, useState } from "react";

import { createProvider, probeProviderModels } from "../api";
import { errMessage } from "../format";
import type { ProviderDraft, ProviderCreateResult } from "../types";
import { ModalShell } from "./ModalShell";
import { Select } from "./Select";

/** Provider ID 的校验规则：与服务端 core/provider_store.py 的 _NAME_RE 一致。
 *  前端先拦一遍是为了「边打字边看得见」——服务端仍然会再校验（前端校验不是防线）。 */
const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** 协议预设：与 core/provider_store.py 的 PROTOCOL_PRESETS 一一对应。
 *  imagora 只有「OpenAI 兼容 images」这一种真实上游协议，所谓「协议」实际只决定
 *  路径前缀 —— 地址里已含版本号（如火山方舟的 /api/v3）就选 ark，否则选 openai。
 *  注意：地址末尾若带 /v1，服务端会把路径里重复的那段去掉（dedupe_version_prefix），
 *  所以 openai 这一项**不要求**地址不带版本号 —— 以前这里写「地址不含版本号」而示例
 *  又给 https://gateway.example/v1，自相矛盾，用户按示例填就撞上 /v1/v1 的 404。 */
const PROTOCOLS: { value: ProviderDraft["protocol"]; label: string; hint: string }[] = [
  {
    value: "openai",
    label: "OpenAI 兼容（标准 /v1 接口）",
    hint: "地址可带也可不带 /v1，重复的版本段会自动去掉",
  },
  {
    value: "ark",
    label: "火山方舟（地址已含 /api/v3）",
    hint: "地址形如 https://ark.cn-beijing.volces.com/api/v3，路径不再带版本号",
  },
  {
    value: "custom",
    label: "自定义路径",
    hint: "自己填 generations 路径（必须以 / 开头）",
  },
];

interface ProviderModalProps {
  /** 已注册的来源名（用于前端预判重名，服务端仍会再拦） */
  registeredNames: string[];
  onClose: () => void;
  /** 创建成功后的回调：上层据此刷新 /api/config 与角标 */
  onCreated: (result: ProviderCreateResult) => void;
}

/** 新增第三方来源：填地址与密钥，写 providers.local.json + .env。
 *
 *  与「生图 API 配置」弹窗的分工（docs/config-editor-ui-design.md）：
 *  那个是**选择器**（在已有来源里选），这个是**添加器**（造一个新来源）。
 *  合成一个弹窗会让「保存」同时意味着「改值」和「建条目」，两种心智模型混在
 *  一个按钮上迟早误操作，所以宁可多一个入口。
 */
export function ProviderModal({ registeredNames, onClose, onCreated }: ProviderModalProps) {
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [protocol, setProtocol] = useState<ProviderDraft["protocol"]>("openai");
  const [generationsPath, setGenerationsPath] = useState("");
  const [editsPath, setEditsPath] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [activate, setActivate] = useState(false);

  const [probing, setProbing] = useState(false);
  const [probed, setProbed] = useState<string[] | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  /** 模型字段的呈现方式：探到清单后默认走下拉，用户可切回手填。
   *  两种都要保留 —— 下拉解决「探到 7 个却看不见」，手填解决「清单外的 ID」，
   *  后者是 docs/config-editor-ui-design.md 第 0 节明确不许剥夺的合法场景。 */
  const [manualModel, setManualModel] = useState(true);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameRef = useRef<HTMLInputElement>(null);

  /** 前端预判（只为即时反馈）：空、格式错、与已有来源重名 */
  const nameIssue = useMemo(() => {
    const value = name.trim();
    if (!value) return null;
    if (!NAME_RE.test(value)) return "只能小写字母开头，后接小写字母 / 数字 / 下划线 / 连字符，最长 32 位";
    if (registeredNames.includes(value)) return "这个 ID 已被占用";
    return null;
  }, [name, registeredNames]);

  const urlIssue = useMemo(() => {
    const value = baseUrl.trim();
    if (!value) return null;
    return /^https?:\/\/[^/\s]+/i.test(value) ? null : "需要以 http:// 或 https:// 开头的完整地址";
  }, [baseUrl]);

  const pathIssue = useMemo(() => {
    if (protocol !== "custom") return null;
    const value = generationsPath.trim();
    if (!value) return "自定义协议必须填 generations 路径";
    return value.startsWith("/") ? null : "路径必须以 / 开头";
  }, [protocol, generationsPath]);

  const canSubmit =
    name.trim() !== "" &&
    baseUrl.trim() !== "" &&
    nameIssue === null &&
    urlIssue === null &&
    pathIssue === null &&
    !busy;

  /** 探到的模型清单 → Select 的选项 */
  const modelOptions = useMemo(
    () => (probed ?? []).map((id) => ({ value: id, label: id })),
    [probed],
  );

  /** 有清单且用户没主动切回手填时用下拉 */
  const showSelect = modelOptions.length > 0 && !manualModel;

  const toggleManualModel = () => {
    setManualModel((prev) => {
      // 切到下拉时，若当前值是手填的、不在清单里，Select 会显示「请选择」——
      // 这种情况下把值清掉，避免「显示请选择但其实有值」的错觉。
      if (!prev && model.trim() !== "" && !(probed ?? []).includes(model.trim())) {
        setModel("");
      }
      return !prev;
    });
  };

  const modelHint = (() => {
    if (!probed) return "模型清单可留空 —— 之后在生图 API 配置里手填 ID 也能用";
    if (probed.length === 0) return "该地址没报出任何模型，可以手填模型 ID";
    if (showSelect) return `探到 ${probed.length} 个模型，从下拉里选一个`;
    return `探到 ${probed.length} 个模型，点「从清单选」用下拉挑，或直接手填`;
  })();

  const probe = async () => {
    setProbing(true);
    setProbeError(null);
    setProbed(null);
    try {
      const result = await probeProviderModels({
        baseUrl: baseUrl.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      setProbed(result.models.map((m) => m.id));
      if (result.models.length === 0) {
        setProbeError("该地址没报出任何模型，可以直接手填模型 ID");
      } else {
        // 探到清单 → 切到下拉呈现（用户仍可点「手填」切回）
        setManualModel(false);
        if (!model.trim()) {
          // 还没填过 → 顺手填第一个，省一次输入
          setModel(result.models[0]!.id);
        }
      }
    } catch (err) {
      setProbeError(errMessage(err));
    } finally {
      setProbing(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const draft: ProviderDraft = {
        name: name.trim(),
        label: label.trim(),
        baseUrl: baseUrl.trim(),
        protocol,
        model: model.trim(),
        activate,
        ...(protocol === "custom"
          ? {
              generationsPath: generationsPath.trim(),
              ...(editsPath.trim() ? { editsPath: editsPath.trim() } : {}),
            }
          : {}),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      };
      const result = await createProvider(draft);
      onCreated(result);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell
      title="添加第三方供应商"
      onClose={onClose}
      initialFocusRef={nameRef}
      className="modal-panel--md"
      testId="provider-modal"
    >
      <header className="modal-header">
        <h3 className="modal-title">添加第三方供应商</h3>
        <p className="modal-subtitle">
          连接中转站或自部署的 OpenAI 兼容接口。地址与模型写 providers.local.json，密钥写 .env。
        </p>
      </header>

      <div className="modal-body">
        {/* ID 与显示名称并排：两个都是短标识，竖着排会让整列超出可视高度，
            逼用户滚动才能看到底部的「创建后立即切换」。 */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="field-label mb-2" htmlFor="pv-name">
              Provider ID
            </label>
            <input
              id="pv-name"
              ref={nameRef}
              className="field-control text-sm font-mono"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="acme-gateway"
              aria-invalid={nameIssue !== null}
              aria-describedby="pv-name-hint"
            />
            <p id="pv-name-hint" className={`text-caption mt-2 ${nameIssue ? "text-red-600" : ""}`}>
              {nameIssue ?? ".env 里键名是 API_KEY_<ID 大写>"}
            </p>
          </div>
          <div>
            <label className="field-label mb-2" htmlFor="pv-label">
              显示名称
            </label>
            <input
              id="pv-label"
              className="field-control text-sm"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="留空则用 Provider ID"
            />
            <p className="text-caption mt-2">只影响界面显示</p>
          </div>
        </div>

        <div className="mt-4">
          <label className="field-label mb-2" htmlFor="pv-url">
            API 地址
          </label>
          <input
            id="pv-url"
            className="field-control text-sm font-mono"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://gateway.example/v1"
            aria-invalid={urlIssue !== null}
          />
          <p className={`text-caption mt-2 ${urlIssue ? "text-red-600" : ""}`}>
            {urlIssue ?? "末尾斜杠会被自动去掉"}
          </p>
        </div>

        <div className="mt-4">
          <label className="field-label mb-2" htmlFor="pv-protocol">
            API 协议
          </label>
          <Select
            id="pv-protocol"
            options={PROTOCOLS.map((item) => ({ value: item.value, label: item.label }))}
            value={protocol}
            onChange={(value) => setProtocol(value as ProviderDraft["protocol"])}
          />
          <p className="text-caption mt-2">
            {PROTOCOLS.find((item) => item.value === protocol)?.hint}
          </p>
        </div>

        {protocol === "custom" && (
          <div className="mt-4 grid grid-cols-2 gap-3">
            <div>
              <label className="field-label mb-2" htmlFor="pv-gen">
                生成路径
              </label>
              <input
                id="pv-gen"
                className="field-control text-sm font-mono"
                value={generationsPath}
                onChange={(event) => setGenerationsPath(event.target.value)}
                placeholder="/v1/images/generations"
                aria-invalid={pathIssue !== null}
              />
            </div>
            <div>
              <label className="field-label mb-2" htmlFor="pv-edits">
                图生图路径
              </label>
              <input
                id="pv-edits"
                className="field-control text-sm font-mono"
                value={editsPath}
                onChange={(event) => setEditsPath(event.target.value)}
                placeholder="留空则同生成路径"
              />
            </div>
            {pathIssue && <p className="text-caption col-span-2 text-red-600">{pathIssue}</p>}
          </div>
        )}

        <div className="mt-4">
          <label className="field-label mb-2" htmlFor="pv-key">
            API 密钥
          </label>
          <input
            id="pv-key"
            type="password"
            className="field-control text-sm font-mono"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="sk-...（可留空，稍后写 .env）"
            autoComplete="off"
          />
          <p className="text-caption mt-2">只写 .env，不进版本库</p>
        </div>

        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between gap-3">
            <label className="field-label" htmlFor="pv-model">
              默认模型
            </label>
            <div className="flex items-center gap-1">
              {modelOptions.length > 0 && (
                <button
                  type="button"
                  className="btn-ghost btn-xs"
                  onClick={toggleManualModel}
                >
                  {showSelect ? "手填" : "从清单选"}
                </button>
              )}
              <button
                type="button"
                className="btn-ghost btn-xs"
                disabled={probing || baseUrl.trim() === "" || urlIssue !== null}
                onClick={() => void probe()}
              >
                {probing ? "获取中…" : "获取可用模型"}
              </button>
            </div>
          </div>
          {showSelect ? (
            <Select id="pv-model" options={modelOptions} value={model} onChange={setModel} />
          ) : (
            <input
              id="pv-model"
              className="field-control text-sm font-mono"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder="gpt-image-2.5（可留空，稍后在生图 API 配置里填）"
            />
          )}
          <p className={`text-caption mt-2 ${probeError ? "text-amber-700" : ""}`}>
            {probeError ?? modelHint}
          </p>
        </div>

        {error && (
          <div role="status" className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}
      </div>

      {/* 「创建后立即切换」放在 modal-body **外面**：它决定这次提交的语义（写不写
          ACTIVE_PROFILE），和底部按钮是一组决策，跟着内容一起滚走会让人漏看。 */}
      <label className="mt-3 flex items-start gap-2 text-xs text-neutral-600">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={activate}
          onChange={(event) => setActivate(event.target.checked)}
        />
        <span>
          创建后立即切换为这个来源
          <span className="text-caption mt-0.5 block">不勾选则只加入目录，当前来源保持不变</span>
        </span>
      </label>

      <footer className="modal-footer">
        <button type="button" className="btn-ghost btn-sm" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="btn-primary btn-sm"
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          {busy ? "创建中…" : "创建供应商"}
        </button>
      </footer>
    </ModalShell>
  );
}

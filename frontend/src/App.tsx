import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { generationHistory, getConfig, getHealthDetails, isHttpError, openFolder, rememberOutputDir, writeConfig } from "./api";
import { useGenerationTask } from "./useGenerationTask";
import { Palette } from "lucide-react";
import { accentForWindow, accentFromHue, hueForWindow, readAccentHue, saveAccentHue } from "./accent";
import { clearWallpaperImage, purgeLegacyWallpaperSettings, readWallpaperImage, saveWallpaperImage } from "./wallpaperStore";
import { readCanvasBounds, saveCanvasBounds } from "./canvasBounds";
import {
  BACKGROUND_PRESETS,
  readBackgroundPreset,
  saveBackgroundPreset,
  type BackgroundPresetId,
} from "./backgroundPreset";
import {
  SURFACE_TRANSPARENCY_LIMITS,
  readSurfaceTransparency,
  saveSurfaceTransparency,
  surfaceTokens,
  surfaceVarList,
} from "./surface";
import {
  WALLPAPER_BLUR_LIMITS,
  WALLPAPER_BRIGHTNESS_LIMITS,
  readWallpaperBlur,
  readWallpaperBrightness,
  saveWallpaperBlur,
  saveWallpaperBrightness,
  wallpaperFilter,
} from "./wallpaperAdjust";
import type { AppConfig, ConfigFileState, GenerationTaskStatus, RefItem, ResultItem } from "./types";
import { errMessage, generatingLabel } from "./format";
import { clearInheritedState, readInheritedState, saveInheritedState } from "./windowInherit";
import { pickRecentPrompts } from "./recentPrompts";
import { findProvider as findCatalogProvider, qualityAppliesTo, resolveSizes } from "./apiCatalog";
import { BRAND_LOGO_PATH, BRAND_LOGO_VIEWBOX, brandLogoSvg } from "./brand/logo";
import { UploadZone } from "./components/UploadZone";
import { FolderPicker } from "./components/FolderPicker";
import { ResultPanel } from "./components/ResultPanel";
import { LogLine } from "./components/LogLine";
import { ModalShell } from "./components/ModalShell";
import { Select } from "./components/Select";
import { CanvasPage } from "./components/CanvasPage";

const WIN_KEY = "aig-win";

/** 读取本标签页记忆的窗口号（window.name 跨刷新保留；复制标签页不继承） */
function readStoredWindowId(): number | null {
  const m = window.name.match(new RegExp(`^${WIN_KEY}-(\\d+)$`));
  return m ? Number(m[1]) : null;
}

/** 解析窗口号：URL ?win= 优先 > window.name 记忆 > null（交给服务端分配） */
function resolveWindowId(): number | null {
  const param = new URLSearchParams(window.location.search).get("win");
  const n = param ? Number(param) : NaN;
  if (Number.isInteger(n) && n > 0) return n;
  return readStoredWindowId();
}

/** 把窗口号记忆到本标签页（跨刷新保留编号） */
function storeWindowId(id: number) {
  window.name = `${WIN_KEY}-${id}`;
}

/** 开新窗口：去掉 win 参数，让新标签自动领下一个编号 */
function openNewWindow() {
  const url = new URL(window.location.href);
  url.searchParams.delete("win");
  window.open(url.pathname + url.search, "_blank");
}

/** 个人 API 设置弹窗。
 *  默认值全部来自 /api/config（后端配置中心）——前端不硬编码中转站 / 模型 / 接口路径，
 *  改 config.json 即全局生效（唯一真相源）；用户填过则用用户自己的配置覆盖。 */
/**
 * 外观弹窗：主体色 / 我的壁纸 / 画布边界（三件都是「整页观感」，一处调完）。
 * 与「生图 API 设置」分开：接口配置配一次就不动，外观是高频调节，
 * 两者访问频率不同，因此各自有顶栏入口，不挤在同一个弹窗里。
 */
/** 弹窗内要展示的壁纸现状（由 App 持有真实状态，弹窗只读不算） */
interface WallpaperView {
  /** 是否已存下一张壁纸图 */
  hasImage: boolean;
  /** 正在读图 / 落库 */
  busy: boolean;
  /** 需要用户知道的一句话（如存储不可用），没有则不显示 */
  notice: string | null;
}


function AppearanceModal({
  accentHue,
  onAccentHueChange,
  wallpaper,
  onWallpaperFile,
  onWallpaperClear,
  backgroundPreset,
  onBackgroundPresetChange,
  surfaceTransparency,
  onSurfaceTransparencyChange,
  wallpaperBlur,
  onWallpaperBlurChange,
  wallpaperBrightness,
  onWallpaperBrightnessChange,
  canvasBounds,
  onCanvasBoundsChange,
  onClose,
}: {
  /** 自定义主体色相；null 表示未自定义（回到按窗口自动配色） */
  accentHue: number | null;
  /** 改主体色：传 null 恢复自动配色 */
  onAccentHueChange: (hue: number | null) => void;
  /** 壁纸现状：图有无 + 参数 + 忙碌 / 提示 */
  wallpaper: WallpaperView;
  /** 选好一张图（App 负责落 IndexedDB 并铺底） */
  onWallpaperFile: (file: File) => void;
  /** 删除壁纸 */
  onWallpaperClear: () => void;
  /** 当前背景材质预设 */
  backgroundPreset: BackgroundPresetId;
  /** 改背景材质预设 */
  onBackgroundPresetChange: (id: BackgroundPresetId) => void;
  /** 卡片/面板/输入框通透度 0-1 */
  surfaceTransparency: number;
  /** 改通透度 */
  onSurfaceTransparencyChange: (value: number) => void;
  /** 壁纸模糊半径 px（0 = 原图） */
  wallpaperBlur: number;
  /** 改壁纸模糊 */
  onWallpaperBlurChange: (value: number) => void;
  /** 壁纸明暗（1 = 原样，>1 提亮，<1 压暗） */
  wallpaperBrightness: number;
  /** 改壁纸明暗 */
  onWallpaperBrightnessChange: (value: number) => void;
  /** 画布是否显示自己的边界（边框 + 底色） */
  canvasBounds: boolean;
  onCanvasBoundsChange: (visible: boolean) => void;
  onClose: () => void;
}) {
  /** Esc 关闭（与图片预览弹窗同一套行为：模态开了就该能用 Esc 退出来） */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <ModalShell title="外观" onClose={onClose} className="modal-panel--md corner-rings">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">外观</h2>
          <button type="button" className="btn-ghost btn-sm" onClick={onClose}>
            关闭
          </button>
        </div>

        {/* 内容区走 .modal-body：加了壁纸与画布开关后内容变高，超出时自己滚动并预留滚动条位 */}
        <div className="modal-body space-y-4">
          {/* 主体色：只有一条色相滑杆，排版与下面的「卡片通透度」逐行对齐。
              九色预设方块已移除（2026-10-03）：滑杆本身就能到任意色相，方块是重复入口；
              而且方块行 + 「色相微调」行说的是同一件事，两行并列反而让人不确定以哪个为准。
              原「当前 / 生效范围」两张只读行也一并删去——值已经在滑杆右侧，范围写进下面一句说明。 */}
          <div>
            <label className="field-label mb-2" htmlFor="accent-hue">
              主体色
            </label>
            <div className="flex items-center gap-3">
              <input
                id="accent-hue"
                type="range"
                min={0}
                max={359}
                value={accentHue ?? 0}
                onChange={(e) => onAccentHueChange(Number(e.target.value))}
                className="accent-hue flex-1"
              />
              <span className="text-muted w-16 text-right text-xs">
                {accentHue === null ? "自动" : `${Math.round(accentHue)}°`}
              </span>
            </div>
            <p className="text-caption mt-2">
              {accentHue === null
                ? "当前按窗口编号自动配色；拖动滑杆即改为自定义，对所有窗口生效。"
                : "按钮、角标、选中态与聚焦环都跟随这个色相，对所有窗口生效。"}
            </p>
            {accentHue !== null && (
              <button type="button" className="btn-ghost btn-sm mt-2" onClick={() => onAccentHueChange(null)}>
                恢复自动配色
              </button>
            )}
          </div>

          {/* 背景底色：只有两项预置（跟随主体色 / 纯白）。与下面的「我的壁纸」互斥——
              壁纸铺在整页最底层，材质底色会被它整个盖掉，两者并存等于「看着能选、实际无效」，
              所以壁纸生效时这一栏直接禁用，并把原因写在下面。 */}
          <div className="border-t border-neutral-200/80 pt-4">
            <div className="mb-2 flex items-baseline justify-between">
              <p className="field-label">背景材质</p>
              {wallpaper.hasImage && <span className="text-caption">已被壁纸取代</span>}
            </div>
            <div className={`bg-swatches ${wallpaper.hasImage ? "opacity-45" : ""}`}>
              {BACKGROUND_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  disabled={wallpaper.hasImage}
                  title={wallpaper.hasImage ? "有壁纸时改不了背景材质" : preset.hint}
                  aria-label={preset.label}
                  aria-pressed={backgroundPreset === preset.id && !wallpaper.hasImage}
                  className={`bg-swatch bg-swatch--${preset.id} ${
                    backgroundPreset === preset.id && !wallpaper.hasImage ? "is-on" : ""
                  }`}
                  onClick={() => onBackgroundPresetChange(preset.id)}
                />
              ))}
            </div>

            <p className="text-caption mt-2">
              {wallpaper.hasImage
                ? "删掉下面的壁纸后，这里就能重新选了。"
                : (BACKGROUND_PRESETS.find((preset) => preset.id === backgroundPreset)?.hint ?? "")}
            </p>
          </div>

          {/* 我的壁纸：按原图直接铺满，不缩放、不模糊、不压暗（图本体存 IndexedDB，只在本机） */}
          <div className="border-t border-neutral-200/80 pt-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="field-label">我的壁纸</p>
              <span className="text-caption">{wallpaper.hasImage ? "已设置" : "未设置"}</span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {/* 原生 file input 由 label 触发：按钮仍是 btn-ghost btn-sm 体系，不另造一套 */}
              <label className={`btn-ghost btn-sm ${wallpaper.busy ? "opacity-50" : "cursor-pointer"}`}>
                {wallpaper.busy ? "处理中…" : wallpaper.hasImage ? "换一张" : "选择图片"}
                <input
                  type="file"
                  accept="image/*"
                  className="sr-only"
                  aria-label="选择壁纸图片"
                  disabled={wallpaper.busy}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    // 先清空 value：同一张图连选两次也要能触发 change
                    e.target.value = "";
                    if (file) onWallpaperFile(file);
                  }}
                />
              </label>
              {wallpaper.hasImage && (
                <button type="button" className="btn-ghost btn-sm btn-danger" onClick={onWallpaperClear}>
                  删除壁纸
                </button>
              )}
            </div>

            {/* 模糊 / 明暗：壁纸自身的显式属性，与「卡片通透度」互不影响。
                默认 0 与 1 即原图——用户自己权衡可读性，系统不替他决定。 */}
            <div className="mt-4 flex flex-col gap-4">
              <div>
                <label className="field-label mb-2" htmlFor="wallpaper-blur">
                  壁纸模糊
                </label>
                <div className="flex items-center gap-3">
                  <input
                    id="wallpaper-blur"
                    type="range"
                    className="range-field flex-1"
                    min={WALLPAPER_BLUR_LIMITS.min}
                    max={WALLPAPER_BLUR_LIMITS.max}
                    step={0.5}
                    value={wallpaperBlur}
                    onChange={(e) => onWallpaperBlurChange(Number(e.target.value))}
                  />
                  <span className="text-muted w-14 text-right text-xs">
                    {wallpaperBlur.toFixed(1)}px
                  </span>
                </div>
              </div>
              <div>
                <label className="field-label mb-2" htmlFor="wallpaper-brightness">
                  壁纸明暗
                </label>
                <div className="flex items-center gap-3">
                  <input
                    id="wallpaper-brightness"
                    type="range"
                    className="range-field flex-1"
                    min={WALLPAPER_BRIGHTNESS_LIMITS.min}
                    max={WALLPAPER_BRIGHTNESS_LIMITS.max}
                    step={0.05}
                    value={wallpaperBrightness}
                    onChange={(e) => onWallpaperBrightnessChange(Number(e.target.value))}
                  />
                  <span className="text-muted w-14 text-right text-xs">
                    {wallpaperBrightness.toFixed(2)}
                  </span>
                </div>
              </div>
            </div>

            <p className="text-caption mt-2">
              选一张本地图片当整页背景，只存本机、不上传。模糊与明暗只改壁纸本身，不影响卡片通透度；
              默认 0 与 1 即原图。
              壁纸与上面的背景材质只能二选一：设了壁纸，材质就停用；删掉壁纸，材质自动恢复。
            </p>
            {wallpaper.notice !== null && <p className="text-caption mt-1">{wallpaper.notice}</p>}
          </div>

          {/* 卡片通透度：材质字符串在 JS 里按此值算出后内联注入（不在 CSS 里嵌 var，压缩器会丢） */}
          <div className="border-t border-neutral-200/80 pt-4">
            <label className="field-label mb-2" htmlFor="surface-transparency">
              卡片通透度
            </label>
            <div className="flex items-center gap-3">
              <input
                id="surface-transparency"
                type="range"
                className="range-field flex-1"
                min={SURFACE_TRANSPARENCY_LIMITS.min}
                max={SURFACE_TRANSPARENCY_LIMITS.max}
                step={0.05}
                value={surfaceTransparency}
                onChange={(e) => onSurfaceTransparencyChange(Number(e.target.value))}
              />
              <span className="text-muted w-16 text-right text-xs">
                {Math.round(surfaceTransparency * 100)}%
              </span>
            </div>
            <p className="text-caption mt-2">越大卡片越透，越能看清背后的壁纸。拉到 100% 卡片完全让开，壁纸按原样清晰铺满（不做模糊）。</p>
          </div>

          {/* 画布边界：纯外观开关（容器边框 + 底色），不碰画布任何交互 */}
          <div className="flex items-start justify-between gap-4 border-t border-neutral-200/80 pt-4">
            <div>
              <p className="field-label">画布边界</p>
              <p className="text-caption mt-0.5">关闭后画布不显示边框与底色，与页面背景融为一体</p>
            </div>
            <input
              type="checkbox"
              className="switch mt-1"
              checked={canvasBounds}
              onChange={(e) => onCanvasBoundsChange(e.target.checked)}
              aria-label="显示画布边界"
            />
          </div>
        </div>
      </ModalShell>
  );
}

/** 配置切换 —— 在两份已知清单里**选**，不在这里**写**配置。
 *
 * 需要的功能只有两件：换来源（profile）、换该来源下的模型。两者都是从清单里挑，
 * 适合 UI；而接口地址 / 接口路径 / 密钥是「这个来源**是什么**」的定义性内容，
 * 写一次就不动，用文本编辑器改更直接（也符合已定的分层：config.json = 出厂目录、
 * .env = 本机覆盖）。把「选择」和「编辑」混在一个弹窗里，正是旧版让人别扭的根因。
 *
 * 其余要点（详见 docs/config-editor-ui-design.md）：
 * - 保存按钮 = 与磁盘值有差异才亮（与文本编辑器 Ctrl+S 同构）；保存**不关窗**
 * - 待重启：写进文件但进程未重载，标 pending；顶栏另有汇总
 * - 并发：写前带 expectedMtimes，服务端发现文件被外部改过就 409，绝不静默覆盖
 */
function ConfigEditorModal({
  config,
  onClose,
  onFileState,
}: {
  config: AppConfig;
  onClose: () => void;
  /** 写入成功后把新的 fileState 交回上层（顶栏 pending 角标要用） */
  onFileState: (next: ConfigFileState) => void;
}) {
  const fileState = config.fileState;
  /** 当前**生效**的 profile（进程正在用的那套） */
  const activeProfile = fileState?.profile ?? config.activeProfile ?? "";

  /** 选项都来自服务端下发的清单，前端不硬编码 */
  const profileOptions = (fileState?.registeredProfiles ?? []).map((name) => ({
    value: name,
    label: name,
  }));
  const providerOf = (name: string) => (config.providers ?? []).find((p) => p.name === name);

  /** 磁盘基线：文件里选的是哪个 profile、哪个模型。这是「有没有改动」的比较基准。 */
  const fileProfile = fileState?.fileProfile ?? activeProfile;
  const fileModel = fileState?.fields.model.fileValue ?? config.defaultModel ?? "";

  const [pickedProfile, setPickedProfile] = useState(fileProfile);
  const [pickedModel, setPickedModel] = useState(fileModel);
  const [baseline, setBaseline] = useState({ profile: fileProfile, model: fileModel });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "err" | "conflict"; text: string } | null>(null);
  const [pending, setPending] = useState<string[]>(fileState?.pending ?? []);
  /** 保存成功后的短暂反馈：2 秒后回到无变化态 */
  const [justSaved, setJustSaved] = useState(false);
  const savedTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
  }, []);

  /** 选中来源的模型清单：必须跟着**选中**的 profile 走。
   *  用 config.models（当前生效 profile 的）会出现「选着 wanwu、下拉里列的是 volc 的模型」。 */
  const pickedProvider = providerOf(pickedProfile);
  const modelOptions = (pickedProvider?.models ?? []).map((m) => ({ value: m.id, label: m.label }));
  const activeProvider = providerOf(activeProfile);

  /** 切来源时把模型一起带到该来源的默认值：否则模型还停在上一个来源的 id，
   *  保存下去就是一个「新来源 + 旧模型」的无效组合。 */
  const changeProfile = (name: string) => {
    setPickedProfile(name);
    const next = providerOf(name);
    if (next) setPickedModel(next.defaultModel);
  };

  const changed = useMemo(() => {
    const out: string[] = [];
    if (pickedProfile !== baseline.profile) out.push("profile");
    if (pickedModel !== baseline.model) out.push("model");
    return out;
  }, [pickedProfile, pickedModel, baseline]);

  const canSave = changed.length > 0 && !busy;

  const save = async (opts?: { force?: boolean }) => {
    setBusy(true);
    setNotice(null);
    try {
      const changes: Record<string, string> = {};
      for (const field of changed) {
        changes[field] = field === "profile" ? pickedProfile : pickedModel;
      }
      const result = await writeConfig({
        profile: activeProfile,
        changes,
        // force = 用户看过冲突提示后选择「仍然覆盖」：不带 mtime，服务端不再拦
        ...(opts?.force ? {} : { expectedMtimes: fileState?.mtimes ?? {} }),
      });
      setPending(result.pending);
      onFileState(result.fileState);
      // 写完把基线推进到刚写下的值，按钮立刻回灰（Ctrl+S 心智）
      const nextProfile = result.fileState.fileProfile ?? pickedProfile;
      const nextModel = result.fileState.fields.model.fileValue ?? pickedModel;
      setBaseline({ profile: nextProfile, model: nextModel });
      setJustSaved(true);
      if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
      savedTimer.current = window.setTimeout(() => setJustSaved(false), 2000);
    } catch (err) {
      if (isHttpError(err) && err.status === 409) {
        setNotice({ kind: "conflict", text: "文件已被外部修改，你的修改尚未写入" });
      } else {
        setNotice({ kind: "err", text: errMessage(err) });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell title="生图 API 配置" onClose={onClose} testId="config-editor">
      <header className="modal-header">
        <h3 className="modal-title">生图 API 配置</h3>
        <p className="modal-subtitle">选一套来源与模型。地址与密钥等改文件即可。</p>
      </header>

      {/* 内容区走 .modal-body：面板是 overflow:hidden 的 flex 列，不包这一层的话
          内容超出时会被静默裁掉且滚不动。 */}
      <div className="modal-body">
        {profileOptions.length > 0 && (
          <div>
            <label className="field-label mb-2" htmlFor="cfg-profile">配置来源</label>
            <Select
              id="cfg-profile"
              options={profileOptions}
              value={pickedProfile}
              onChange={changeProfile}
            />
            <p className="text-caption mt-2">
              {pickedProvider?.label && pickedProvider.label !== pickedProfile
                ? pickedProvider.label
                : "换来源 = 换地址、模型与尺寸价目表"}
            </p>
          </div>
        )}

        <div className="mt-4">
          <label className="field-label mb-2" htmlFor="cfg-model">默认模型</label>
          {modelOptions.length > 0 ? (
            <Select id="cfg-model" options={modelOptions} value={pickedModel} onChange={setPickedModel} />
          ) : (
            <input
              id="cfg-model"
              className="field-control text-sm"
              value={pickedModel}
              onChange={(e) => setPickedModel(e.target.value)}
            />
          )}
          <p className="text-caption mt-2">
            {pickedModel && pickedProvider?.models.find((m) => m.id === pickedModel)?.note
              ? pickedProvider.models.find((m) => m.id === pickedModel)?.note
              : "该来源下的可选模型"}
          </p>
        </div>

        {/* 生效中：只读事实。改文件才动它，这里只用来对照「保存后会不会变」 */}
        <div className="mt-5 border-t border-neutral-200/80 pt-4">
          <p className="field-label mb-2">生效中</p>
          <div className="spec-list">
            <div className="spec-list__row">
              <span className="spec-list__key">来源</span>
              <span className="spec-list__val">{activeProfile || "—"}</span>
            </div>
            <div className="spec-list__row">
              <span className="spec-list__key">模型</span>
              <span className="spec-list__val truncate">{config.defaultModel || "—"}</span>
            </div>
            <div className="spec-list__row">
              <span className="spec-list__key">API Key</span>
              <span className="spec-list__val">
                {fileState?.fields.apiKey.configured ? "● 已设置" : "○ 未配置"}
              </span>
            </div>
            {activeProvider?.baseUrl && (
              <div className="spec-list__row">
                <span className="spec-list__key">接口地址</span>
                <span className="spec-list__val truncate font-mono text-xs">{activeProvider.baseUrl}</span>
              </div>
            )}
          </div>
        </div>

        {pending.length > 0 && (
          <p className="mt-4 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
            <span className="chip chip--sm chip--pending">待重启</span>
            <span>{pending.map(labelOfField).join(" / ")} 已写入文件，重启工作台后生效</span>
          </p>
        )}

        {notice && (
          <div
            role="status"
            className={`mt-4 rounded-lg px-3 py-2 text-xs ${
              notice.kind === "ok"
                ? "bg-neutral-100 text-neutral-700"
                : notice.kind === "conflict"
                  ? "bg-amber-50 text-amber-800"
                  : "bg-red-50 text-red-700"
            }`}
          >
            <p>{notice.text}</p>
            {notice.kind === "conflict" && (
              <div className="mt-2 flex gap-2">
                <button type="button" className="btn-ghost btn-xs" onClick={onClose}>
                  放弃我的修改
                </button>
                <button
                  type="button"
                  className="btn-danger btn-xs"
                  disabled={busy}
                  onClick={() => void save({ force: true })}
                >
                  仍然覆盖
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="mt-5 flex items-center justify-between gap-3 border-t border-neutral-200/80 pt-4">
        <span className="text-caption min-w-0 truncate">
          {fileState?.envPath ? "config.json · .env" : ""}
        </span>
        <div className="flex shrink-0 items-center gap-3">
          <button type="button" className="btn-ghost btn-sm" onClick={onClose}>取消</button>
          <button
            type="button"
            className="btn-primary btn-sm"
            disabled={!canSave}
            onClick={() => void save()}
          >
            {busy ? "写入中…" : justSaved ? "✓ 已保存" : "保存"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

/** 字段 key → 界面用词（「待重启」提示文案里用） */
function labelOfField(key: string): string {
  return { profile: "配置来源", model: "默认模型" }[key] ?? key;
}


/** 顶部标题区：logo + 标题 + 窗口徽章 + 状态徽章（未配置 API Key / 自检问题 / 当前 profile·模型）+ 模式切换 + 新窗口按钮 */
function TitleBar({
  windowId,
  onNewWindow,
  mode,
  onModeChange,
  activeProfile,
  defaultModel,
  healthIssues,
  onOpenApi,
  pendingCount,
  onOpenAppearance,
}: {
  windowId: number | null;
  onNewWindow: () => void;
  mode: "classic" | "canvas";
  onModeChange: (m: "classic" | "canvas") => void;
  /** 当前生效的 config.json profile 名（config.json 多 profile，换中转站后可在此确认） */
  activeProfile?: string | undefined;
  /** 当前 profile 的默认模型 */
  defaultModel?: string | undefined;
  /** 启动自检问题（未配置 API Key / 前端未构建 / 输出不可写 / 自检失败）——状态徽章的数据源 */
  healthIssues: string[];
  onOpenApi: () => void;
  /** 待重启生效的配置项数（配置编辑器写入后由 fileState 提供；0 = 无） */
  pendingCount: number;
  /** 打开外观弹窗（主体色 / 我的壁纸 / 画布边界） */
  onOpenAppearance: () => void;
}) {
  /** 品牌区使用单层 Logo，悬停只改变高光与阴影，避免透视挤出造成重影。 */
  const brandRootRef = useRef<HTMLAnchorElement | null>(null);

  /* 状态徽章的取值顺序：没配 Key 时「模型 ID」这个槽位本身没有意义（生图根本不可用），
     于是直接改说原因，模型名让位；其余自检问题没有各自的入口，聚合在这个槽位里。 */
  const apiKeyMissing = healthIssues.some((issue) => issue.includes("未配置 API Key"));
  const otherIssues = healthIssues.filter((issue) => !issue.includes("未配置 API Key"));

  /* 「当前在用什么接口」角标 = 状态 + 入口（点它开配置编辑器）。
     顶栏只留这一个控件：正常显示模型名，异常时改说原因，待重启时追加计数。
     文字一律走主题色，状态由角标底色区分。 */
  const apiChipLabel = apiKeyMissing
    ? "未配置 API Key"
    : otherIssues.length > 0
      ? `自检 ${otherIssues.length} 项`
      : defaultModel || activeProfile || "未选择模型";
  const apiChipTitle = apiKeyMissing
    ? "未配置 API Key，生图任务暂不可用 —— 点击配置"
    : otherIssues.length > 0
      ? otherIssues.join("；")
      : `当前生效：${activeProfile ? `profile「${activeProfile}」` : ""}${defaultModel ? ` · 模型 ${defaultModel}` : ""} —— 点击配置`;
  /* 待重启是这个界面最有辨识度的状态：改了文件但进程没重载。
     顶栏承担「跳出弹窗也能看到」的提醒责任。 */
  const chipPending = pendingCount > 0;

  return (
    <header className="studio-header enter-up mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
      <a
        href="https://github.com/zlZayn/imagora"
        target="_blank"
        rel="noreferrer"
        ref={brandRootRef}
        className="brand-swing"
        title="打开远程仓库（GitHub）"
      >
        <span className="brand-swing__face">
          <svg width="30" height="30" viewBox={BRAND_LOGO_VIEWBOX} fill="var(--color-brand)" aria-hidden="true">
            <path d={BRAND_LOGO_PATH} />
          </svg>
          <h1 className="text-lg font-semibold tracking-wide">Imagora</h1>
        </span>
      </a>
      {windowId !== null && <span className="chip chip--brand window-chip">⌘{String(windowId).padStart(2, "0")}</span>}

      {/* 模式切换：胶囊分段控件（高度/圆角/字号统一由 .mode-switch 提供，与顶栏其它控件等高）。
          它是「我在哪个工作区」，属于身份的一部分，所以留在左侧紧跟窗口号，
          不与右侧的设置类控件混在一起。 */}
      <div className="mode-switch">
        <button
          type="button"
          onClick={() => onModeChange("classic")}
          className={`mode-switch__item transition-colors ${
            mode === "classic" ? "bg-brand/10 font-medium" : "hover:bg-neutral-50"
          }`}
        >
          经典表单
        </button>
        <button
          type="button"
          onClick={() => onModeChange("canvas")}
          className={`mode-switch__item transition-colors ${
            mode === "canvas" ? "bg-brand/10 font-medium" : "hover:bg-neutral-50"
          }`}
        >
          无限画布
        </button>
      </div>
      {/* 右侧只有两件事：开新窗口（动作），以及两项设置（接口 / 外观）。
          动作排最左，设置项按「多久调一次」从低频到高频：接口配一次就不动，外观最常调。 */}
      <button type="button" onClick={onNewWindow} className="btn-ghost ml-auto">
        ＋ 新窗口
      </button>
      {/* 状态 + 入口二合一：角标本身显示当前接口，点它开设置弹窗。
          保留 api-settings-trigger 类名作为稳定的自动化选择器（scripts/smoke_api_modal.py 依赖它）。 */}
      <button
        type="button"
        onClick={onOpenApi}
        className={`api-settings-trigger chip chip--quiet profile-chip cursor-pointer transition-colors hover:text-brand ${
          chipPending ? "is-pending" : ""
        }`}
        title={chipPending ? `${apiChipTitle}\n（${pendingCount} 项待重启生效）` : apiChipTitle}
      >
        {apiChipLabel}
        {chipPending && <span className="ml-1.5">· {pendingCount} 项待重启</span>}
      </button>
      {/* 外观独立入口：接口配置配一次就不动，外观是高频调节，分开才容易发现 */}
      <button type="button" onClick={onOpenAppearance} className="btn-ghost" title="外观" aria-label="外观">
        <Palette size={15} aria-hidden="true" />
      </button>
      {/* 右下镜像小字：与其它角落装饰同一套排版，对比度最低 */}
      <span className="corner-note">Image Workspace</span>
    </header>
  );
}

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [windowId, setWindowId] = useState<number | null>(null);
  /** 自定义主体色相；null = 未自定义，回到按窗口编号自动配色（对所有窗口统一生效） */
  const [accentHue, setAccentHue] = useState<number | null>(() => readAccentHue());
  /** 当前生效的主体色：自定义优先，否则按窗口编号 */
  const accent = accentHue === null ? accentForWindow(windowId) : accentFromHue(accentHue);
  /** 归一后的色相：写页面底色变量用（负色相在 CSS 里虽合法，但归一后更直观） */
  const backgroundHue = (() => {
    const raw = accentHue === null ? hueForWindow(windowId) : accentHue;
    return ((raw % 360) + 360) % 360;
  })();
  const handleAccentHueChange = (hue: number | null) => {
    setAccentHue(hue);
    saveAccentHue(hue);
  };
  /** 配置编辑器写入后刷新的文件状态（顶栏 pending 角标读它）；null = 还没写过 */
  const [fileState, setFileState] = useState<ConfigFileState | null>(null);
  const [showApiSettings, setShowApiSettings] = useState(false);
  /** 外观弹窗（主体色 / 我的壁纸 / 画布边界）：与接口配置分开，顶栏有独立入口 */
  const [showAppearance, setShowAppearance] = useState(false);
  /** 壁纸图本体（启动时从 IndexedDB 取回）；null = 没有壁纸 */
  const [wallpaperBlob, setWallpaperBlob] = useState<Blob | null>(null);
  /** 铺底用的 object URL：直接指向原图；null = 不铺底 */
  const [wallpaperUrl, setWallpaperUrl] = useState<string | null>(null);
  /** 壁纸自身的模糊半径 px（0 = 原图）与明暗（1 = 原样）；只存本机浏览器 */
  const [wallpaperBlur, setWallpaperBlur] = useState<number>(() => readWallpaperBlur());
  const [wallpaperBrightness, setWallpaperBrightness] = useState<number>(() => readWallpaperBrightness());
  const [wallpaperBusy, setWallpaperBusy] = useState(false);
  /** 需要用户知道的一句话（如本地存储不可用）；null = 不显示 */
  const [wallpaperNotice, setWallpaperNotice] = useState<string | null>(null);
  /** 画布是否显示自己的边界（边框 + 底色）；默认开，保持既有观感 */
  const [canvasBounds, setCanvasBounds] = useState<boolean>(() => readCanvasBounds());
  /** 背景材质预设；默认「跟随主体色」（= 改动前的既有观感） */
  const [backgroundPreset, setBackgroundPreset] = useState<BackgroundPresetId>(() => readBackgroundPreset());
  /** 卡片/面板通透度 0-1；越大越透。材质字符串由 surfaceTokens 在 JS 里产出后内联注入 */
  const [surfaceTransparency, setSurfaceTransparency] = useState<number>(() => readSurfaceTransparency());
  /** 有自选图才算「设置了我的壁纸」（只影响外观弹窗里那句话与「删除壁纸」按钮） */
  const wallpaperActive = wallpaperBlob !== null;

  /** 启动时取回壁纸图：IndexedDB 不可用 / 读失败 = 没有壁纸（静默降级，不影响生图主流程） */
  useEffect(() => {
    let alive = true;
    // 顺手清掉旧版壁纸参数键（模糊/压暗/缩放那版已删，键是遗留垃圾）；
    // 待老用户都升过一次后，这行与 purgeLegacyWallpaperSettings 可一起删。
    purgeLegacyWallpaperSettings();
    void readWallpaperImage().then((blob) => {
      if (alive && blob) setWallpaperBlob(blob);
    });
    return () => {
      alive = false;
    };
  }, []);

  /** 铺底图 URL：**直接用原图 Blob 的 object URL，不做任何处理**（不缩放、不模糊、不重编码）。
   *  object URL 在切换 / 卸载时必须 revoke，否则内存泄漏。 */
  useEffect(() => {
    if (wallpaperBlob === null) {
      setWallpaperUrl(null);
      return undefined;
    }
    let created: string | null = null;
    try {
      created = URL.createObjectURL(wallpaperBlob);
      setWallpaperUrl(created);
    } catch {
      setWallpaperUrl(null);
    }
    return () => {
      if (created !== null) URL.revokeObjectURL(created);
    };
  }, [wallpaperBlob]);

  /** 铺在整页底下的那张图：只剩「我的壁纸」这一条来源（内置预设壁纸已移除）。
   *  按原图 cover 铺底 + 降噪滤镜，可读性处理全在 index.css 的 .imagora-wallpaper 一层里。 */
  const pageWallpaperUrl = wallpaperUrl;
  const pageWallpaperActive = pageWallpaperUrl !== null;

  /** 有壁纸（预设或自选）时：页面底色让位于壁纸（CSS 读 html[data-wallpaper]），前景元素照旧跟随主体色。
   *  颜色与观感全在 index.css，这里只翻一个属性，不在 JS 里算颜色。 */
  useEffect(() => {
    const root = document.documentElement;
    if (pageWallpaperActive) root.dataset.wallpaper = "on";
    else delete root.dataset.wallpaper;
  }, [pageWallpaperActive]);

  /** 背景材质：写到根元素，index.css 按 html[data-bg] 出对应材质变量 */
  useEffect(() => {
    document.documentElement.dataset.bg = backgroundPreset;
  }, [backgroundPreset]);

  /** 画布边界开关：写到根元素，样式由 index.css 的 html[data-canvas-bounds] 接管 */
  useEffect(() => {
    document.documentElement.dataset.canvasBounds = canvasBounds ? "on" : "off";
  }, [canvasBounds]);

  const handleBackgroundPresetChange = (id: BackgroundPresetId) => {
    setBackgroundPreset(id);
    saveBackgroundPreset(id);
  };

  /** 选图：直接落 IndexedDB，原图铺底，不做任何处理。
   *  存不进去（IndexedDB 不可用）就当没设置，只留一句说明，不抛错、不影响生图。 */
  const handleWallpaperFile = async (file: File) => {
    setWallpaperBusy(true);
    setWallpaperNotice(null);
    try {
      const saved = await saveWallpaperImage(file);
      if (!saved) {
        setWallpaperNotice("当前浏览器无法本地保存图片（IndexedDB 不可用），壁纸未设置");
        return;
      }
      setWallpaperBlob(file);
    } finally {
      setWallpaperBusy(false);
    }
  };

  /** 删壁纸：图与铺底图一起清 */
  const handleWallpaperClear = () => {
    setWallpaperBlob(null);
    setWallpaperUrl(null);
    setWallpaperNotice(null);
    void clearWallpaperImage();
  };

  /** 画布边界开关：纯外观偏好，不碰画布交互 */
  const handleCanvasBoundsChange = (visible: boolean) => {
    setCanvasBounds(visible);
    saveCanvasBounds(visible);
  };

  /** 卡片/面板/输入框的表面材质：按主色相 + 通透度在 JS 里算出字面量再内联注入。
   *  不在 CSS 里写 `hsl(… / calc(0.66 * var(--x)))`——压缩器会丢弃「函数内嵌 var()」的声明。 */
  const surface = surfaceTokens(backgroundHue, surfaceTransparency);
  const handleSurfaceTransparencyChange = (value: number) => {
    setSurfaceTransparency(value);
    saveSurfaceTransparency(value);
  };

  /** 动态 favicon：标签页图标跟随窗口主体色（与顶栏 logo / 菜单边框同色），多开一眼可辨 */
useEffect(() => {
  const svg = brandLogoSvg(accent.brand);
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]') ?? document.createElement("link");
  link.rel = "icon";
  link.type = "image/svg+xml";
  link.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  if (!link.parentElement) document.head.appendChild(link);
  // 依赖 accent.brand（字符串）而非 accent 对象：换主体色时图标跟着变，且不会每渲染都重跑
}, [windowId, accent.brand]);

/** 页面底色跟随主体色：把归一后的色相写到根元素，index.css 的 body 底色读它 */
useEffect(() => {
  document.documentElement.style.setProperty("--accent-hue", String(backgroundHue));
}, [backgroundHue]);

/** 运行时 token 同样写到根元素：弹窗经 createPortal 挂在 body 上，落在 .imagora-app 之外，
 *  只写在 .imagora-app 内联样式里的话，弹窗内一律退化成 @theme 兜底值——表现为
 *  弹窗外是主题色、弹窗内却是石板灰 #475569，卡片表面与通透度也一并失效。
 *  .imagora-app 那份保留：它在首帧就生效，避免刷新时先闪一下兜底灰。两处取值同源，不会漂。 */
useEffect(() => {
  const root = document.documentElement.style;
  root.setProperty("--color-brand", accent.brand);
  root.setProperty("--color-brand-dark", accent.brandDark);
  // 遍历 surfaceVarList：新增角色时 .imagora-app 与根元素两处一起生效，不会漏一处
  // （弹窗走 Portal 挂在 body 下，读不到 .imagora-app 上的变量 —— 见 ARCHITECTURE 9.4 第 9 条）
  for (const [name, value] of surfaceVarList(surface)) {
    root.setProperty(name, value);
  }
}, [accent.brand, accent.brandDark, surface]);
  /** 界面模式：经典表单 / 无限画布（?mode=canvas 直达画布） */
  const [mode, setMode] = useState<"classic" | "canvas">(() =>
    new URLSearchParams(window.location.search).get("mode") === "canvas" ? "canvas" : "classic",
  );
  /** 画布是否已挂载：首次进入画布后保持常驻（切换模式不销毁，内容保留；退出窗口才清空） */
  const [canvasMounted, setCanvasMounted] = useState(() => mode === "canvas");
  const switchMode = (m: "classic" | "canvas") => {
    if (m === "canvas") setCanvasMounted(true);
    setMode(m);
  };
  const [prompt, setPrompt] = useState("");
  const [refs, setRefs] = useState<RefItem[]>([]);
  const [size, setSize] = useState("");
  const [quality, setQuality] = useState("high");
  const [outputDir, setOutputDir] = useState("");
  /** 生成任务：submit 返回 taskId，订阅回调按 activeTaskId 驱动状态 */
  const generationTask = useGenerationTask();
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [taskStatus, setTaskStatus] = useState<GenerationTaskStatus | null>(null);
  /** 最近一次生成失败的原因（结果区失败面板展示；完整错误仍进日志） */
  const [taskError, setTaskError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const startedAtRef = useRef(0);
  /** 输出路径防抖上报定时器（用户改路径 300ms 后记住到服务端） */
  const outputDirTimerRef = useRef<number | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [results, setResults] = useState<ResultItem[]>([]);
  /** 最近一次成功生成的提交 id（后端落盘提交图快照，可整图导入画布） */
  const [lastSubmissionId, setLastSubmissionId] = useState<string | null>(null);
  /** 待导入画布的提交 id（传给 CanvasPage 触发整图导入，完成后清空） */
  const [pendingSubmissionImport, setPendingSubmissionImport] = useState<string | null>(null);
  const [healthIssues, setHealthIssues] = useState<string[]>([]);
  /** 最近用过的提示词（结果区空态展示，点一条填回输入框）；取不到就为空数组，不影响主流程 */
  const [recentPrompts, setRecentPrompts] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  // 日志更新后自动滚动到底部，配合逐行淡入
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  useEffect(() => {
    const known = resolveWindowId();
    getConfig(known ?? undefined)
      .then((cfg) => {
        setConfig(cfg);
        setWindowId(cfg.windowId);
        // 服务端新分配的编号记住到本标签页，刷新后编号不变
        if (known === null) storeWindowId(cfg.windowId);
        document.title = cfg.windowId > 0 ? `Imagora · 窗口 #${cfg.windowId}` : "Imagora";
        setSize(cfg.sizes[0]?.value ?? "");
        setOutputDir(cfg.defaultOutputDir);
        // 继承上一窗口的状态（仅「＋ 新窗口」按钮写入；命令行打开无此键，保持全新）
        const inherited = readInheritedState();
        if (inherited) {
          clearInheritedState();
          if (inherited.size && cfg.sizes.some((s) => s.value === inherited.size)) {
            setSize(inherited.size);
          }
          if (inherited.quality && cfg.qualities.includes(inherited.quality)) {
            setQuality(inherited.quality);
          }
          if (inherited.outputDir) setOutputDir(inherited.outputDir);
          // 参考图本体已在服务端，只还原元信息，直接渲染 URL
          if (inherited.refs.length) {
            setRefs(
              inherited.refs.map((r) => ({
                id: r.path,
                path: r.path,
                url: `/api/image?path=${encodeURIComponent(r.path)}`,
                name: r.name,
                size: r.size,
                ext: r.ext,
                mime: "",
                synced: true,
              })),
            );
          }
          // 继承提示（如部分图片未上传成功）显示在新窗口的日志区
          if (inherited.notice) setLogs([inherited.notice]);
        }
      })
      .catch((err) => setLogs([`初始化失败：${errMessage(err)}`]));
  }, []);

  useEffect(() => {
    getHealthDetails()
      .then((health) => setHealthIssues(health.issues))
      .catch((err) => setHealthIssues([`启动自检失败：${errMessage(err)}`]));
  }, []);

  // 最近用过的提示词：只读生成历史的前若干条，失败静默（空态退化为纯文字引导）
  useEffect(() => {
    generationHistory({ limit: 30 })
      .then((res) => setRecentPrompts(pickRecentPrompts(res.items)))
      .catch(() => setRecentPrompts([]));
  }, []);

  // 尺寸 / 质量下拉选项。尺寸表必须跟着「使用中的接口 + 模型」走：价目表按来源分家
  // （火山官方 0.2/0.3 元，中转站 0.05/0.1 元），沿用 default_profile 那张表就会出现
  // 「用着中转站的接口、显示豆包的价」，还会列出该模型不支持的档位。解析见 apiCatalog.ts。
  const providerCatalog = config?.providers;
  // 配置只有一份（在文件里，服务端读），前端不再有覆盖层
  const activeApiBaseUrl = config?.baseUrl ?? "";
  const activeModelId = config?.defaultModel ?? "";
  const activeProvider = useMemo(
    () => findCatalogProvider(providerCatalog, activeApiBaseUrl),
    [providerCatalog, activeApiBaseUrl],
  );
  const activeSizes = useMemo(
    () =>
      resolveSizes({
        providers: providerCatalog,
        baseUrl: activeApiBaseUrl,
        modelId: activeModelId,
        // 兜底：自定义地址未在 config.json 登记时，沿用后端 profile 的尺寸表
        fallbackSizes: config?.sizes,
      }),
    [providerCatalog, activeApiBaseUrl, activeModelId, config],
  );
  const sizeOptions = useMemo(
    () => activeSizes.map((s) => ({ value: s.value, label: `${s.label}（${s.cost}元）` })),
    [activeSizes],
  );
  /** 质量档位对当前模型是否真的生效。
   *  豆包 Seedream 的图片接口没有 quality 参数（火山官方参数表里就没有），发了被静默忽略 ——
   *  三档出图完全一样，那就不该给用户一个骗人的选项：为真才渲染这一栏。
   *  中转站（GPT Image）认 quality，决定输出 token 数与耗时；按张计费所以不变贵。 */
  const qualityEffective = qualityAppliesTo(activeModelId, activeApiBaseUrl);
  const qualityOptions = useMemo(
    () => (config?.qualities ?? []).map((q) => ({ value: q, label: q })),
    [config],
  );

  /** 换了接口 / 模型 → 尺寸表整体换掉：旧尺寸不在新表里就落到首项，
   *  否则会把 A 家的尺寸（如 1728x2304）发给 B 家的模型，上游直接报错。 */
  useEffect(() => {
    if (activeSizes.length && !activeSizes.some((s) => s.value === size)) {
      setSize(activeSizes[0]!.value);
    }
  }, [activeSizes, size]);

  /** 生效配置：把「按使用中的 API 解析出的尺寸表 / 模型清单」并回 config，
   *  供画布等下游组件共用同一套价格口径（不必各自再写一份解析）。 */
  const effectiveConfig = useMemo<AppConfig | undefined>(() => {
    if (!config) return undefined;
    return {
      ...config,
      sizes: activeSizes.length ? activeSizes : config.sizes,
      // 命中来源才替换来源相关字段（exactOptionalPropertyTypes 下不能显式写 undefined）
      ...(activeProvider
        ? {
            models: activeProvider.models,
            profileLabel: activeProvider.label,
            activeProfile: activeProvider.name,
          }
        : {}),
    };
  }, [config, activeSizes, activeProvider]);

  // 配置只有一份（在文件里），不再有浏览器覆盖层，自检问题原样呈现
  const visibleHealthIssues = healthIssues;

  /** 待重启生效的项数：配置编辑器写入后由 fileState 提供；
   *  首屏也从 /api/config 的 fileState 读（进程启动后文件被外部改过时同样要提示）。 */
  const pendingCount = (fileState ?? config?.fileState)?.pending.length ?? 0;

  /** 订阅当前任务状态：queued/running 驱动按钮，终态落结果 / 日志 / 结果区状态面板。
   *  过程状态（排队/生成中）由右栏 ResultPanel 呈现，日志区只收终态与操作反馈——不写过程行。 */
  useEffect(() => {
    return generationTask.subscribe((taskId, view) => {
      if (taskId !== activeTaskId) return;
      if (view.status === "queued") {
        setTaskStatus("queued");
        setElapsed(0);
        setTaskError(null);
      } else if (view.status === "running") {
        setTaskStatus("running");
        setElapsed(view.elapsed);
      } else if (view.status === "done") {
        setTaskStatus("done");
        setResults(view.results ?? []);
        setLastSubmissionId(view.submissionId ?? null);
        setTaskError(null);
        setLogs([
          ...(view.messages ?? []),
          `总用时 ${((Date.now() - startedAtRef.current) / 1000).toFixed(1)} 秒`,
        ]);
      } else if (view.status === "failed") {
        setTaskStatus("failed");
        setResults([]);
        setTaskError(view.error ?? "未知错误");
        setLogs([`生成失败：${view.error ?? "未知错误"}`]);
      } else if (view.status === "cancelled") {
        setTaskStatus("cancelled");
        setLogs(["生成已取消"]);
      }
    });
  // 与 CanvasPage 同约定：只依赖稳定的 subscribe，避免每次任务状态刷新重建订阅
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generationTask.subscribe, activeTaskId]);

  const handleGenerate = async () => {
    if (!prompt.trim()) {
      setLogs(["请先输入提示词"]);
      return;
    }
    startedAtRef.current = Date.now();
    setResults([]);
    setElapsed(0);
    setTaskStatus("queued");
    setTaskError(null);
    try {
      // 已上传的走 ref_paths 复用服务端文件；未上传成功的本地兜底走 multipart
      const syncedRefs = refs.filter((r) => r.synced);
      const pendingFiles = refs.filter((r) => !r.synced).flatMap((r) => (r.file ? [r.file] : []));
      const taskId = await generationTask.submit({
        prompt,
        refPaths: syncedRefs.map((r) => r.path),
        files: pendingFiles,
        size,
        quality,
        outputDir,
        win: windowId ?? 0,
      });
      setActiveTaskId(taskId);
    } catch (err) {
      setTaskStatus(null);
      setLogs([`提交失败：${errMessage(err)}`]);
    }
  };

  /** 把最近一次经典提交整图导入画布：切到画布模式并下发 importSubmissionId */
  const handleImportToCanvas = () => {
    if (!lastSubmissionId) {
      setLogs(["当前结果无提交快照（旧历史不完整），无法整图导入"]);
      return;
    }
    setPendingSubmissionImport(lastSubmissionId);
    setCanvasMounted(true);
    switchMode("canvas");
  };

  /** 生成中（排队或执行）时禁用表单操作 */
  const busy = taskStatus === "queued" || taskStatus === "running";

  const handleOpenFolder = async () => {
    const res = await openFolder(outputDir);
    if (!res.ok) {
      setLogs(["打开文件夹失败"]);
    }
  };

  /** 输出路径变更：本地更新 + 防抖上报服务端记住（挂载/继承的默认值不走这里，避免覆盖记录） */
  const handleOutputDirChange = (path: string) => {
    setOutputDir(path);
    if (outputDirTimerRef.current) {
      window.clearTimeout(outputDirTimerRef.current);
    }
    outputDirTimerRef.current = window.setTimeout(() => {
      rememberOutputDir(path).catch(() => {
        // 尽力而为：记录失败不影响界面
      });
    }, 300);
  };

  /** 新窗口：参考图已存服务端，只把元信息 + 参数写入 sessionStorage 后开窗（提示词不保留）。
   *  继承失败的提示随状态带到新窗口，显示在新窗口的日志区（而非原窗口）。 */
  const handleNewWindow = () => {
    const syncedRefs = refs.filter((r) => r.synced);
    let notice: string | undefined;
    if (refs.length > 0 && syncedRefs.length === 0) {
      notice = "参考图上传失败，新窗口未继承图片";
    } else if (syncedRefs.length < refs.length) {
      notice = `${refs.length - syncedRefs.length} 张参考图上传失败，新窗口未继承`;
    }
    const saved = saveInheritedState(
      syncedRefs.map(({ path, name, size, ext }) => ({ path, name, size, ext })),
      size,
      quality,
      outputDir,
      notice,
    );
    if (!saved.ok) {
      // sessionStorage 整体不可用（极少见）：新窗口从默认设置开始
      setLogs(["无法保存状态到新窗口，新窗口使用默认设置"]);
    }
    openNewWindow();
  };

  return (
    <div
      className="imagora-app mx-auto max-w-[1500px] px-6 py-4"
      style={
        {
          "--color-brand": accent.brand,
          "--color-brand-dark": accent.brandDark,
          ...Object.fromEntries(surfaceVarList(surface)),
        } as CSSProperties
      }
    >
      {/* 整页壁纸（内置预设图或我的自选图）：原图铺满、置于内容之下、不接收事件（只是背景，不挡任何交互）。
          降噪滤镜（去饱和 + 微压对比）只为让前景文字读得清，不遮挡、不压暗、不改尺寸。
          两者共用这一层，因此观感完全一致——别为预设图另开一层，否则可读性处理会分叉。 */}
      {pageWallpaperUrl !== null && (
        <div className="imagora-wallpaper" aria-hidden="true">
          <div
            className="imagora-wallpaper__image"
            style={{
              backgroundImage: `url("${pageWallpaperUrl}")`,
              // 整条 filter 由 JS 拼好再注入：CSS 里嵌 var() 会被构建期压缩器丢弃
              filter: wallpaperFilter(wallpaperBlur, wallpaperBrightness),
            }}
          />
        </div>
      )}
      <TitleBar
        windowId={windowId}
        onNewWindow={handleNewWindow}
        mode={mode}
        onModeChange={switchMode}
        activeProfile={activeProvider?.name ?? config?.activeProfile}
        defaultModel={activeModelId || config?.defaultModel}
        onOpenApi={() => setShowApiSettings(true)}

        healthIssues={visibleHealthIssues}
        pendingCount={pendingCount}
        onOpenAppearance={() => setShowAppearance(true)}
      />
      {showAppearance && (
        <AppearanceModal
          accentHue={accentHue}
          onAccentHueChange={handleAccentHueChange}
          wallpaper={{ hasImage: wallpaperActive, busy: wallpaperBusy, notice: wallpaperNotice }}
          wallpaperBlur={wallpaperBlur}
          onWallpaperBlurChange={(value) => {
            setWallpaperBlur(value);
            saveWallpaperBlur(value);
          }}
          wallpaperBrightness={wallpaperBrightness}
          onWallpaperBrightnessChange={(value) => {
            setWallpaperBrightness(value);
            saveWallpaperBrightness(value);
          }}
          onWallpaperFile={(file) => void handleWallpaperFile(file)}
          onWallpaperClear={handleWallpaperClear}
          backgroundPreset={backgroundPreset}
          onBackgroundPresetChange={handleBackgroundPresetChange}
          surfaceTransparency={surfaceTransparency}
          onSurfaceTransparencyChange={handleSurfaceTransparencyChange}
          canvasBounds={canvasBounds}
          onCanvasBoundsChange={handleCanvasBoundsChange}
          onClose={() => setShowAppearance(false)}
        />
      )}
      {showApiSettings && effectiveConfig && (
        <ConfigEditorModal
          config={effectiveConfig}
          onFileState={setFileState}
          onClose={() => setShowApiSettings(false)}
        />
      )}

      {/* 无限画布：首次进入后保持挂载，切换模式仅显隐（内容保留，退出窗口才清空） */}
      {canvasMounted && effectiveConfig && (
        <div className={mode === "canvas" ? "block" : "hidden"}>
          <CanvasPage
            config={effectiveConfig}
            qualityEffective={qualityEffective}
            importSubmissionId={pendingSubmissionImport}
            onSubmissionImported={() => setPendingSubmissionImport(null)}
          />
        </div>
      )}
      {/* 经典表单：始终挂载（状态在 App），按模式显隐 */}
      <main
        className={
          mode === "canvas"
            ? "hidden"
            : "classic-main grid grid-cols-[6fr_4fr] items-start gap-5"
        }
      >
        {/* 左栏：输入面板。卡片只保留中文标题，不再印编号水印。 */}
        <section className="classic-input-column">
          <div className="space-y-4">
            <div className="panel-card enter-up space-y-3">
              <label className="field-label" htmlFor="prompt">
                提示词
              </label>
              <textarea
                id="prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={4}
                placeholder="英文优先，减少歧义。例如：a red apple on white background, product photo"
                className="field-control resize-y"
              />
              <UploadZone refs={refs} onChange={setRefs} />
            </div>

            <div className="panel-card enter-up enter-delay-1 relative z-30">
              {/* 质量栏按当前模型显隐：豆包没有质量参数，留着只会让人以为能调 */}
              <div className={qualityEffective ? "grid grid-cols-2 gap-3" : "grid grid-cols-1 gap-3"}>
                <div>
                  <label className="field-label" htmlFor="size-select">
                    尺寸
                  </label>
                  <Select
                    id="size-select"
                    options={sizeOptions}
                    value={size}
                    onChange={setSize}
                    className="mt-1"
                  />
                </div>
                {qualityEffective && (
                  <div>
                    <label className="field-label" htmlFor="quality-select">
                      质量
                    </label>
                    <Select
                      id="quality-select"
                      options={qualityOptions}
                      value={quality}
                      onChange={setQuality}
                      className="mt-1"
                    />
                  </div>
                )}
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-neutral-400">
                {qualityEffective
                  ? "low 最快最省 / medium 均衡 / high 最细（细节与文字更稳，只是更慢；按张计费，价格不变）"
                  : "豆包 Seedream 接口没有质量参数，这一栏已隐藏 —— 它出图不区分 low / medium / high"}
              </p>
            </div>

            <div className="panel-card enter-up enter-delay-2 space-y-3">
              <label className="field-label" htmlFor="output-dir">
                输出路径
              </label>
              <FolderPicker value={outputDir} onChange={handleOutputDirChange} />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleGenerate}
                  disabled={busy}
                  className={`btn-primary flex-1 ${busy ? "btn-busy" : ""}`}
                >
                  {busy ? (taskStatus === "queued" ? "排队中…" : generatingLabel(elapsed)) : "生成图片"}
                </button>
                <button
                  type="button"
                  onClick={handleOpenFolder}
                  disabled={busy}
                  className="btn-ghost"
                >
                  打开文件夹
                </button>
              </div>
              <div ref={logRef} className="log-box text-log max-h-40 overflow-auto">
                {logs.map((line, i) => (
                  <LogLine key={i} text={line} />
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* 右栏：结果画廊，保留轻量角落装饰。 */}
        <section className="classic-output-column">
          <section className="classic-result-panel corner-rings corner-deco panel-card enter-up enter-delay-3 min-h-[560px]">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="field-label mb-0">生成结果</span>
              {lastSubmissionId && (
                <button type="button" onClick={handleImportToCanvas} className="btn-ghost text-xs">
                  导入画布
                </button>
              )}
            </div>
            <ResultPanel
              status={taskStatus}
              elapsed={elapsed}
              meta={{ refCount: refs.length, size, quality, outputDir }}
              error={taskError}
              results={results}
              recentPrompts={recentPrompts}
              onPickPrompt={setPrompt}
            />
          </section>
        </section>
      </main>
    </div>
  );
}

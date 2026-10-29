import { useState } from "react";
import { formatBytes } from "../format";
import { imagePathFromUrl } from "../imagePath";
import type { ResultItem } from "../types";
import { useImageZoom } from "../useImageZoom";
import { ZoomModal } from "./WorkflowModals";

interface GalleryProps {
  items: ResultItem[];
  /** 最近用过的提示词（空态展示，点一条填回输入框） */
  recentPrompts?: string[] | undefined;
  onPickPrompt?: ((prompt: string) => void) | undefined;
}

/**
 * 单图展示：自动包裹图片实际边缘。
 * 图片 `w-full h-auto`，高度由自身比例决定——不设固定占位比例、不 object-cover 裁切，
 * 加载完成前显示主体色浅调占位，图片就位后淡入（img-reveal），无比例跳变。
 * hover 由父级 group 驱动：图片轻微放大 + 阴影加深 + 整块上浮（transform 留给 transition，
 * 与入场 animation 互不干扰）。cursor-zoom-in 提示双击放大（与画布预览同款交互）。
 */
function AspectImage({ url, alt }: { url: string; alt: string }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <div className="relative w-full cursor-zoom-in overflow-hidden rounded-xl border border-neutral-200 bg-brand/5 shadow-sm transition-shadow duration-300 group-hover:shadow-md">
      {/* 加载中占位：图片就位后让位给实际比例 */}
      {!loaded && <div className="h-80 w-full" aria-hidden="true" />}
      <img
        src={url}
        alt={alt}
        onLoad={() => setLoaded(true)}
        className={`block h-auto w-full transition-transform duration-300 group-hover:scale-[1.03] ${
          loaded ? "img-reveal" : "opacity-0"
        }`}
      />
    </div>
  );
}

/**
 * 结果画廊：成功生成的图片网格展示。
 * **单击不跳转**，双击打开放大预览（ZoomModal 与画布/生产历史同组件、同注册表 URL），
 * 复制图片 / 复制路径 / 新标签打开都在预览弹窗里（见 useImageZoom 的交互契约）。
 */
export function Gallery({ items, recentPrompts, onPickPrompt }: GalleryProps) {
  const images = items.filter((item): item is ResultItem & { url: string } => Boolean(item.url));
  const { zoom, openZoom, closeZoom } = useImageZoom();

  if (images.length === 0) {
    const recents = recentPrompts ?? [];
    return (
      <div className="flex h-full min-h-[520px] flex-col items-center justify-center gap-2 text-neutral-400">
        <svg
          width="40"
          height="40"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
          <circle cx="9" cy="9" r="2" />
          <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
        </svg>
        <p className="text-sm font-medium text-neutral-500">还没有结果</p>
        <p className="max-w-[320px] text-center text-xs leading-relaxed text-neutral-400">
          写好提示词，点「生成图片」，第一张就会出现在这里。
        </p>
        {/* 最近用过的提示词：点一条填回输入框，省去重新寻找那条长提示词。
            没有历史（或接口失败）时整块不出现，空态退化为纯文字引导。 */}
        {recents.length > 0 && onPickPrompt && (
          <div className="mt-6 w-full max-w-[420px]">
            <p className="mb-2 text-center text-[11px] tracking-wide text-neutral-400">最近用过的提示词</p>
            <div className="flex flex-col gap-1.5">
              {recents.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => onPickPrompt(p)}
                  title={p}
                  className="recent-prompt"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <div className="result-gallery grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] items-start gap-3">
        {images.map((item, i) => (
          <div
            key={`${item.url}-${i}`}
            className="group block enter-up"
            style={{ animationDelay: `${i * 70}ms` }}
            title="双击放大预览"
          >
            <div
              className="transition-transform duration-300 group-hover:-translate-y-0.5"
              onDoubleClick={() =>
                openZoom({
                  url: item.url,
                  name: item.message,
                  path: imagePathFromUrl(item.url),
                })
              }
            >
              <AspectImage url={item.url} alt={item.message} />
              <p className="text-caption mt-1 text-center">
                {item.size ? `${item.size}` : ""}
                {item.ext ? ` · ${item.ext.toUpperCase()}` : ""}
                {item.fileSize !== undefined ? ` · ${formatBytes(item.fileSize)}` : ""}
                {item.cost !== undefined ? ` · ${item.cost}元` : ""}
              </p>
            </div>
          </div>
        ))}
      </div>
      {zoom && (
        <ZoomModal
          imageUrl={zoom.url}
          name={zoom.name}
          {...(zoom.path ? { copyPath: zoom.path } : {})}
          onClose={closeZoom}
        />
      )}
    </>
  );
}

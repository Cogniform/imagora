import { useEffect, useRef, useState } from "react";

import { pendingLabel, pendingMessage, pendingProgressScale } from "../generationPending";

/**
 * 生成中占位卡：给「已经提交、结果还没回来」的节点占住结果位。
 *
 * 结构移植自 basketikun/infinite-canvas（MIT）的 `image-generation-pending.tsx`，
 * 两处刻意不同：
 * 1. 底色一律走 `var(--surface-*)` token（`surfaceAudit.test.ts` 禁止组件里写死颜色）；
 * 2. 进度条只动 `transform: scaleX()`，不给 width 做动画（宽度动画会触发布局，且卡顿）。
 *
 * 计时从挂载那一刻算 0s：所以父组件**必须**在开始生成时再挂载它（`{running && <GenerationPending/>}`），
 * 常驻挂载会让秒数从页面打开就开始跑。
 */
export type GenerationPendingProps = {
  /** 覆盖秒数：不传则自己每秒走表；传了就以它为准（父组件已有可观测耗时，免重复计时）*/
  elapsed?: number | undefined;
  /** 覆盖整行文案：不传则由秒数推导（`生成中 8s · 正在构图…`）*/
  label?: string | undefined;
  /** 附加类名（节点里用来定尺寸/留白）*/
  className?: string | undefined;
  testId?: string | undefined;
};

const TICK_MS = 1000;

export function GenerationPending({ elapsed, label, className, testId }: GenerationPendingProps) {
  const [seconds, setSeconds] = useState(0);
  const controlled = typeof elapsed === "number" && Number.isFinite(elapsed);
  // 父组件给了 elapsed 时自己不再走表，避免两套时钟互相打架
  const selfTicking = !controlled;
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    if (!selfTicking) return () => { mounted.current = false; };
    const timer = setInterval(() => {
      if (mounted.current) setSeconds((s) => s + 1);
    }, TICK_MS);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [selfTicking]);

  const ticks = controlled ? (elapsed as number) : seconds;
  const scale = pendingProgressScale(ticks);
  const text = label ?? pendingLabel(ticks);

  return (
    <div
      className={`generation-pending surface-inset ${className ?? ""}`.trim()}
      data-testid={testId ?? "generation-pending"}
      // 无角色的「进展」区域：屏幕阅读器读一次整行文案即可，读屏不该被每秒 tick 打断
      role="status"
      aria-live="polite"
      aria-label={text}
    >
      <div className="generation-pending__label" title={text}>
        {text}
      </div>
      <div className="generation-pending__track" aria-hidden="true">
        <div
          className="generation-pending__bar"
          data-testid="generation-pending-bar"
          style={{ transform: `scaleX(${scale.toFixed(4)})` }}
        />
      </div>
      {/* 读屏文本与轮播文案分开：轮播只影响视觉，无障碍读的是整行 */}
      <span className="sr-only">{pendingMessage(ticks)}</span>
    </div>
  );
}

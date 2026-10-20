import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { popPopup, pushPopup } from "../popupLayer";

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
  id?: string;
}

/**
 * 自定义下拉框：提供标准 listbox 语义、完整键盘导航和稳定的关闭行为。
 *
 * 展开列表走 **createPortal 到 body**，不是就地 absolute 定位。
 * 原因：列表贴在触发器下方，而触发器的祖先里到处是「滚动容器 + overflow:hidden」
 * （弹窗 `.modal-panel` / `.modal-body`、画布节点卡片）。就地绝对定位会被最近的
 * 滚动容器裁掉——表现为「下拉展开后底部几项看不见」，而且 `max-h-60` 只约束自身高度，
 * 约束不了「还剩多少空间可见」。挂到 body 后不受任何祖先裁切。
 *
 * 坐标按触发器 rect 现算，并在展开期间跟随滚动 / 尺寸变化重算（见下方 effect）。
 */
export function Select({ options, value, onChange, className = "", id }: SelectProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  /** 列表相对视口的定位（挂到 body 后 fixed 定位，用视口坐标） */
  const [rect, setRect] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const reactId = useId();
  const listboxId = `${id ?? `select-${reactId}`}-listbox`;

  const selectedIndex = options.findIndex((option) => option.value === value);
  const current = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const optionId = (index: number) => `${listboxId}-option-${index}`;

  const openList = (preferredIndex = selectedIndex >= 0 ? selectedIndex : 0) => {
    if (!options.length) return;
    setActiveIndex(Math.min(Math.max(preferredIndex, 0), options.length - 1));
    setOpen(true);
  };

  const closeList = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) window.setTimeout(() => triggerRef.current?.focus(), 0);
  };

  const choose = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    closeList(true);
  };

  /** 按触发器位置算列表坐标：下方空间不够就翻到上方，并据此限制高度（永不溢出视口） */
  const measure = () => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const r = trigger.getBoundingClientRect();
    const gap = 4;
    const margin = 8;
    const below = window.innerHeight - r.bottom - gap - margin;
    const above = r.top - gap - margin;
    const flip = below < 160 && above > below;
    const maxHeight = Math.max(120, Math.min(240, flip ? above : below));
    setRect({
      left: r.left,
      top: flip ? Math.max(margin, r.top - gap - maxHeight) : r.bottom + gap,
      width: r.width,
      maxHeight,
    });
  };

  // 展开期间登记为「有浮层」：否则按 Esc 时弹窗会抢先关掉（见 popupLayer 的说明）
  useEffect(() => {
    if (!open) return;
    pushPopup();
    return () => popPopup();
  }, [open]);

  // 展开时量一次；展开期间滚动 / 改变窗口尺寸要重算（否则列表会与触发器错位）
  useLayoutEffect(() => {
    if (!open) return;
    measure();
    const onScroll = () => measure();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
    // measure 只读 DOM，无需进依赖
     
  }, [open]);

  useEffect(() => {
    if (!options.length && open) {
      setOpen(false);
      setActiveIndex(-1);
    }
  }, [open, options.length]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      // 列表已挂到 body，不再是 root 的后代：两处都要判
      if (rootRef.current?.contains(target)) return;
      if (document.getElementById(listboxId)?.contains(target)) return;
      closeList();
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [listboxId]);

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Tab") {
      closeList();
      return;
    }
    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        closeList(true);
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        openList();
        return;
      }
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((index) => (index + delta + options.length) % options.length);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      if (!options.length) return;
      event.preventDefault();
      if (!open) setOpen(true);
      setActiveIndex(event.key === "Home" ? 0 : options.length - 1);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) choose(activeIndex);
      else openList();
    }
  };

  return (
    <div ref={rootRef} className={`select-root relative ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        onClick={() => (open ? closeList() : openList())}
        onKeyDown={handleKeyDown}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={listboxId}
        aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        className="field-control select-trigger flex items-center justify-between gap-2 text-left"
      >
        <span className="min-w-0 truncate">{current?.label ?? "请选择"}</span>
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className={`shrink-0 text-neutral-400 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open &&
        rect &&
        createPortal(
          <ul
            id={listboxId}
            role="listbox"
            className="select-list fixed z-[70] overflow-auto"
            style={{ left: rect.left, top: rect.top, width: rect.width, maxHeight: rect.maxHeight }}
          >
            {options.map((option, index) => {
              const selected = option.value === value;
              const active = index === activeIndex;
              return (
                <li
                  key={option.value}
                  id={optionId(index)}
                  role="option"
                  aria-selected={selected}
                  className={`select-option ${selected ? "is-selected" : ""} ${active ? "is-active" : ""}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(index)}
                >
                  <span className="truncate">{option.label}</span>
                  {selected && (
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                      className="shrink-0"
                    >
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  )}
                </li>
              );
            })}
          </ul>,
          document.body,
        )}
    </div>
  );
}

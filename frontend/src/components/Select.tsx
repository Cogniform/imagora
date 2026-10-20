import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";

import { groupOptions, type GroupedOption } from "../optionGroups";
import { popPopup, pushPopup } from "../popupLayer";
import { rankByName } from "../rankByName";

export interface SelectOption {
  value: string;
  label: string;
  /** 分组信息（缺省 = 不分组）。同 id 的选项归到一组，组间按首次出现顺序。 */
  group?: { id: string; label: string };
}

interface SelectProps {
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
  id?: string;
  /** 列表顶部出搜索框。选项超过一屏时用它，否则用户只能滚。 */
  searchable?: boolean;
  /** 搜索无结果时的提示文案 */
  emptyLabel?: string;
  /** 由 Field 通过 cloneElement 注入，转发到触发器按钮上（按钮才是 label 的控件） */
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}

/**
 * 自定义下拉框：标准 listbox 语义、完整键盘导航、稳定关闭行为、可选搜索与分组。
 *
 * 展开列表走 **createPortal 到 body**，不是就地 absolute 定位。
 * 原因：列表贴在触发器下方，而触发器的祖先里到处是「滚动容器 + overflow:hidden」
 * （弹窗 `.modal-panel` / `.modal-body`、画布节点卡片）。就地绝对定位会被最近的
 * 滚动容器裁掉——表现为「下拉展开后底部几项看不见」，而且 `max-h-60` 只约束自身高度，
 * 约束不了「还剩多少空间可见」。挂到 body 后不受任何祖先裁切。
 *
 * 坐标按触发器 rect 现算，并在展开期间跟随滚动 / 尺寸变化重算（见下方 effect）。
 * 尺寸变化同时监听 window.resize 与触发器的 ResizeObserver —— 后者覆盖「窗口没变、
 * 但布局把触发器挤窄了」的情况（侧栏展开、弹窗换列数），只靠 resize 事件会漏。
 *
 * ## 搜索（searchable）
 *
 * 搜索框放在列表**内部**顶部，而不是替换触发器。理由：触发器要保持「显示当前值」的
 * 职责，把输入框塞进触发器会让「已选值」和「搜索词」共用一块区域，关闭时还得决定
 * 该留哪个。放进列表则天然跟着列表生灭。
 *
 * 过滤用 `rankByName`（有序子序列 + 前缀优先），不是简单 substring ——
 * 模型 ID 动辄 `gpt-image-2.5-flare`，用户打 `flare` 或 `gi25` 都该命中。
 *
 * ## 分组（option.group）
 *
 * 分组只影响渲染，不影响键盘导航：activeIndex 始终是**扁平可见列表**的下标，
 * 组标题不参与导航。这样上下键跨越组边界是连续的，不会卡在标题上。
 */
export function Select({
  options,
  value,
  onChange,
  className = "",
  id,
  searchable = false,
  emptyLabel = "没有匹配项",
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [query, setQuery] = useState("");
  /** 列表相对视口的定位（挂到 body 后 fixed 定位，用视口坐标） */
  const [rect, setRect] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(
    null,
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const reactId = useId();
  const listboxId = `${id ?? `select-${reactId}`}-listbox`;
  const searchId = `${listboxId}-search`;

  /** 过滤后的可见选项。空 query 时 rankByName 原样返回，零开销。 */
  const visible = useMemo<SelectOption[]>(() => {
    if (query.trim() === "") return options;
    // name 用 value（模型 ID 之类真正要匹配的标识），label 作第二搜索键（中文显示名）
    const keyed = options.map((option) => ({ name: option.value, label: option.label, option }));
    return rankByName(keyed, query).map((entry) => entry.option);
  }, [options, query]);

  const selectedIndex = visible.findIndex((option) => option.value === value);
  const current = options.find((option) => option.value === value);
  const optionId = (index: number) => `${listboxId}-option-${index}`;

  const openList = (preferredIndex = selectedIndex >= 0 ? selectedIndex : 0) => {
    if (!options.length) return;
    setActiveIndex(Math.min(Math.max(preferredIndex, 0), options.length - 1));
    setOpen(true);
  };

  const closeList = (restoreFocus = false) => {
    setOpen(false);
    setQuery("");
    if (restoreFocus) window.setTimeout(() => triggerRef.current?.focus(), 0);
  };

  const choose = (index: number) => {
    const option = visible[index];
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
    // 窗口尺寸没变但触发器被布局挤窄（侧栏展开、弹窗换列数）时 resize 事件不会触发，
    // 列表宽度会停在旧值上跟触发器对不齐 —— 用 ResizeObserver 补上这条路径。
    // jsdom 没有 ResizeObserver，故做存在性守卫：测试环境退化为只靠 resize 事件。
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onScroll);
    if (triggerRef.current) observer?.observe(triggerRef.current);
    return () => {
      observer?.disconnect();
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
    // measure 只读 DOM，无需进依赖
     
  }, [open]);

  // 可搜索时把焦点交给搜索框：用户展开就想打字，不该再点一下。
  // 依赖里必须有 rect —— 搜索框只在 rect 算出来后才渲染，首帧 searchRef 还是 null；
  // 只依赖 open/searchable 的话这个 effect 早跑完就再也不会重跑，焦点永远落不上去。
  useEffect(() => {
    if (open && searchable && rect) searchRef.current?.focus();
  }, [open, searchable, rect]);

  // 过滤结果变了要夹住 activeIndex，否则上下键会落到不存在的下标上
  useEffect(() => {
    if (!open) return;
    setActiveIndex((index) => (visible.length === 0 ? -1 : Math.min(Math.max(index, 0), visible.length - 1)));
  }, [open, visible.length]);

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
    // closeList 只读 state setter，无需进依赖
     
  }, [listboxId]);

  /**
   * 键盘处理。触发器与搜索框共用，但语义有两处不同：
   * - 搜索框里空格是**输入字符**，不能当「选中」
   * - 搜索框里方向键仍要移动活动项，且不能把光标挪走
   */
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>, fromInput: boolean) => {
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
      if (visible.length === 0) return;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((index) => (index + delta + visible.length) % visible.length);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      if (visible.length === 0) return;
      event.preventDefault();
      if (!open) setOpen(true);
      setActiveIndex(event.key === "Home" ? 0 : visible.length - 1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (open) choose(activeIndex);
      else openList();
      return;
    }
    if (!fromInput && event.key === " ") {
      event.preventDefault();
      if (open) choose(activeIndex);
      else openList();
    }
  };

  const groups = useMemo(() => groupOptions(visible), [visible]);
  /** 扁平下标查表：分组渲染时要知道每行在 visible 里的位置 */
  const indexOf = useMemo(() => {
    const map = new Map<SelectOption, number>();
    visible.forEach((option, index) => map.set(option, index));
    return map;
  }, [visible]);

  return (
    <div ref={rootRef} className={`select-root relative ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        onClick={() => (open ? closeList() : openList())}
        onKeyDown={(event) => handleKeyDown(event, false)}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={listboxId}
        aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        aria-describedby={describedBy}
        aria-invalid={invalid}
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
          <div
            id={listboxId}
            data-portal="select-list"
            className="select-list fixed z-[70] flex flex-col overflow-hidden"
            style={{ left: rect.left, top: rect.top, width: rect.width, maxHeight: rect.maxHeight }}
          >
            {searchable && (
              <div className="select-search">
                <input
                  ref={searchRef}
                  id={searchId}
                  type="text"
                  className="select-search__input"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => handleKeyDown(event, true)}
                  placeholder="输入关键词筛选"
                  autoComplete="off"
                  aria-label="筛选选项"
                  aria-controls={listboxId}
                  aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
                />
              </div>
            )}
            <ul
              role="listbox"
              aria-labelledby={searchable ? searchId : undefined}
              className="min-h-0 flex-1 overflow-auto"
            >
              {visible.length === 0 && (
                <li role="presentation" className="select-empty">
                  {emptyLabel}
                </li>
              )}
              {groups.map((group) => (
                <li key={group.id || "__ungrouped"} role="presentation" className="select-group">
                  {group.label !== "" && (
                    <div className="select-group__title" role="presentation">
                      {group.label}
                    </div>
                  )}
                  <ul role="presentation" className="select-group__rows">
                    {group.rows.map((option) => {
                      const index = indexOf.get(option) ?? -1;
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
                  </ul>
                </li>
              ))}
            </ul>
          </div>,
          document.body,
        )}
    </div>
  );
}

/** 供 optionGroups 复用的类型（避免调用方重复声明） */
export type { GroupedOption };

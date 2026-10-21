import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { validateCustomValue } from "../customValue";
import { groupOptions, type GroupedOption } from "../optionGroups";
import { popPopup, pushPopup } from "../popupLayer";
import { rankByName } from "../rankByName";

/** 选项数超过这个值才自动出搜索框（`searchable="auto"` 的判据）。 */
export const SELECT_SEARCH_THRESHOLD = 4;

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
  /** 列表顶部是否出搜索框。
   *  缺省（等同于 `"auto"`）按选项数自动决定：超过 `SELECT_SEARCH_THRESHOLD` 才出 ——
   *  同一个「尺寸」下拉在经典表单（3~4 项）与画布节点（十几项）里因此表现一致。
   *  `true` / `false` 是强制显示 / 强制隐藏，用于少数确定要或确定不要的场合。 */
  searchable?: boolean | "auto" | undefined;
  /** 搜索无结果时的提示文案 */
  emptyLabel?: string;
  /** 允许提交清单外的自由输入值（画布尺寸想填 `1280x720`、模型想填配置里还没有的 ID）。
   *  **只在搜索框真的出现时生效**（见 `searchable`）：没有搜索框就没有打字入口，
   *  单开这个开关只会让人困惑。 */
  allowCustom?: boolean | undefined;
  /** 自由输入被确认时回调，收到的是归一化后的值（见 `customValue.ts`）。
   *  开了 `allowCustom` 就要传它，否则「使用 “…”」那行点了没有下文。 */
  onCreateCustom?: ((value: string) => void) | undefined;
  /** 由 Field 通过 cloneElement 注入，转发到触发器按钮上（按钮才是 label 的控件） */
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  /** 在选项文字**前面**插一段自定义内容（如尺寸下拉的比例图标）。
   *  只影响列表行的渲染，不参与搜索过滤与键盘导航；不传则保持纯文字。 */
  renderOption?: ((option: SelectOption) => ReactNode) | undefined;
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
 * **出不出搜索框按选项数自动决定**（`searchable` 缺省 = `"auto"`）：超过
 * `SELECT_SEARCH_THRESHOLD` 才出。此前由各调用点自己传 `searchable`，导致同一个
 * 「尺寸」下拉在经典表单里没有搜索框、在画布节点里有，用户看到的是两套控件行为。
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
  // 不设默认值：`undefined` 与 `"auto"` 同义，统一交给下面的 searchEnabled 解析，
  // 免得「默认值」和「解析式」两处各写一份判据、日后只改一处就分叉。
  searchable,
  emptyLabel = "没有匹配项",
  allowCustom = false,
  onCreateCustom,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
  renderOption,
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

  /** 本次渲染到底出不出搜索框：`undefined`/`"auto"` 按选项数判，`true`/`false` 照办。
   *  只解析一次，下面所有判断都用它 —— 直接读 `searchable` 会漏掉 `"auto"` 这个真值。 */
  const searchEnabled =
    searchable === undefined || searchable === "auto"
      ? options.length > SELECT_SEARCH_THRESHOLD
      : searchable;

  const selectedIndex = visible.findIndex((option) => option.value === value);
  const current = options.find((option) => option.value === value);
  const optionId = (index: number) => `${listboxId}-option-${index}`;

  /** 自由输入只在「能打字 + 调用方允许」时成立：没有搜索框就没有输入入口。 */
  const customEnabled = searchEnabled && allowCustom === true;

  /** 输入是否**精确**命中了某个可见选项（值或显示名都算，精确比对、大小写敏感）。 */
  const exactMatch = useMemo<SelectOption | undefined>(() => {
    const needle = query.trim();
    if (needle === "") return undefined;
    return visible.find((option) => option.value === needle || option.label === needle);
  }, [visible, query]);

  /**
   * 待创建的自由输入值。四个条件同时成立才有值（否则 `null`）：
   * 开关打开、输入非空、没有精确匹配、校验通过。
   * 校验只挡「空」与「太长」，不做格式校验 —— 理由见 `customValue.ts` 文件头。
   */
  const customCandidate = useMemo<string | null>(() => {
    if (!customEnabled || exactMatch !== undefined) return null;
    const result = validateCustomValue(query);
    return result.ok ? result.value : null;
  }, [customEnabled, exactMatch, query]);

  const openList = (preferredIndex = selectedIndex >= 0 ? selectedIndex : 0) => {
    // 没选项又没自由输入入口时不必展开；有入口时**清单为空也要能展开** ——
    // 「一个选项都没有」正是最需要手填的场景（新供应商还没配模型）。
    if (!options.length && !customEnabled) return;
    // 清单为空时没有可高亮的项，activeIndex 保持 -1（Enter 会走自由输入分支）
    setActiveIndex(options.length === 0 ? -1 : Math.min(Math.max(preferredIndex, 0), options.length - 1));
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

  /** 提交自由输入：交给调用方落库，然后收起列表（与 `choose` 同一套收尾动作）。 */
  const createCustom = (custom: string) => {
    onCreateCustom?.(custom);
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
  // 只依赖 open/searchEnabled 的话这个 effect 早跑完就再也不会重跑，焦点永远落不上去。
  // 依赖里也必须有 searchEnabled：它由选项数算出，清单从 3 项变 5 项时要重新聚焦。
  useEffect(() => {
    if (open && searchEnabled && rect) searchRef.current?.focus();
  }, [open, searchEnabled, rect]);

  // 过滤结果变了要夹住 activeIndex，否则上下键会落到不存在的下标上
  useEffect(() => {
    if (!open) return;
    setActiveIndex((index) => (visible.length === 0 ? -1 : Math.min(Math.max(index, 0), visible.length - 1)));
  }, [open, visible.length]);

  useEffect(() => {
    // 清单为空时收起列表（避免一个空浮层飘着）。例外：开了自由输入就必须能展开 ——
    // 「一个选项都没有」正是最需要手填的场景（新供应商还没配模型）。
    if (!options.length && !customEnabled && open) {
      setOpen(false);
      setActiveIndex(-1);
    }
  }, [open, options.length, customEnabled]);

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
      if (!open) {
        openList();
        return;
      }
      // 自由输入的三段判定（只在 searchEnabled && allowCustom 时成立）：
      // ① 输入**精确**命中某个可见项 → 走正常选中（`gpt-image-2.5` 打全了就该选它，
      //    而不是造一个同名的新值）；
      // ② 没精确命中且校验通过 → 提交自由输入；
      // ③ 没精确命中但校验不过（超长）→ **什么都不做**，不回落到 `choose(activeIndex)`。
      //    理由：此时用户的意图明确是「用我打的这串」，退化成选中某个模糊命中的行
      //    等于悄悄改掉他要的值 —— 停在这里、让输入框留着让他改，是更小的错。
      if (customEnabled && query.trim() !== "") {
        if (exactMatch !== undefined) {
          onChange(exactMatch.value);
          closeList(true);
        } else if (customCandidate !== null) {
          createCustom(customCandidate);
        }
        return;
      }
      choose(activeIndex);
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
        {renderOption && current ? (
          <span className="flex min-w-0 items-center gap-2">
            {renderOption(current)}
            <span className="truncate">{current.label}</span>
          </span>
        ) : (
          <span className="min-w-0 truncate">{current?.label ?? "请选择"}</span>
        )}
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
            {searchEnabled && (
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
              aria-labelledby={searchEnabled ? searchId : undefined}
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
                          {renderOption ? (
                            <span className="flex min-w-0 items-center gap-2">
                              {renderOption(option)}
                              <span className="truncate">{option.label}</span>
                            </span>
                          ) : (
                            <span className="truncate">{option.label}</span>
                          )}
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
            {/* 自由输入行：**放在 listbox 外面**，且是 role="button" 而不是 role="option"。
                理由：`aria-activedescendant` 指向的是 listbox 内的 option 编号，这一行若
                也算 option，要么得挤进 optionId 编号（上下键会停在它上面，用户以为能选），
                要么就会被指到一个不存在的 id。它是「动作」不是「选项」，语义上就该分开。
                也正因如此，`getAllByRole("option")` 的数量不受它影响。
                固定在滚动区之外（`shrink-0`）：列表很长时它依然可见，不用滚到底才能手填。 */}
            {customCandidate !== null && (
              <div className="mt-1 shrink-0 border-t border-dashed border-neutral-200 pt-1">
                <button
                  type="button"
                  role="button"
                  data-testid="select-custom-option"
                  className="select-option w-full"
                  // 不抢焦点：搜索框保持聚焦，用户点错了还能接着改输入
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => createCustom(customCandidate)}
                >
                  <span className="truncate">使用 “{customCandidate}”</span>
                </button>
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}

/** 供 optionGroups 复用的类型（避免调用方重复声明） */
export type { GroupedOption };

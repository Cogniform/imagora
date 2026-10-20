import {
  useEffect,
  useId,
  useRef,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import { hasOpenPopup } from "../popupLayer";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const modalStack: Array<{ id: string; nested: boolean }> = [];

function isTopModal(id: string) {
  for (let index = modalStack.length - 1; index >= 0; index -= 1) {
    const entry = modalStack[index];
    if (entry?.nested) return entry.id === id;
  }
  return modalStack[modalStack.length - 1]?.id === id;
}

interface ModalShellProps {
  title: string;
  children: ReactNode;
  onClose: () => void;
  className?: string;
  overlayClassName?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
  closeOnBackdrop?: boolean;
  nested?: boolean;
  testId?: string;
}

/** 全站普通弹窗基座：统一 Portal、语义、Esc、遮罩点击与焦点生命周期。 */
export function ModalShell({
  title,
  children,
  onClose,
  className = "",
  overlayClassName = "",
  initialFocusRef,
  closeOnBackdrop = true,
  nested = false,
  testId,
}: ModalShellProps) {
  const reactId = useId();
  const instanceIdRef = useRef(`modal-${reactId}`);
  const titleId = `${instanceIdRef.current}-title`;
  const panelRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const instanceId = instanceIdRef.current;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    modalStack.push({ id: instanceId, nested });

    const panel = panelRef.current;
    const focusTarget = initialFocusRef?.current ?? panel?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? panel;
    focusTarget?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isTopModal(instanceId)) return;
      if (event.key === "Escape") {
        // 有浮层（展开的下拉等）先让给它：本监听挂在 capture 阶段，比浮层自己的
        // onKeyDown 先跑，不拦的话按一下 Esc 会连弹窗一起关掉 —— 用户的手感是
        // 「我只想收起下拉，结果正在填的窗口没了」。因此这里需要第二次 Esc 才关窗。
        if (hasOpenPopup()) return;
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !panel) return;

      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (element) => !element.hidden && element.getAttribute("aria-hidden") !== "true",
      );
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      let index = -1;
      for (let cursor = modalStack.length - 1; cursor >= 0; cursor -= 1) {
        if (modalStack[cursor]?.id === instanceId) {
          index = cursor;
          break;
        }
      }
      if (index >= 0) modalStack.splice(index, 1);
      const returnTarget = returnFocusRef.current;
      window.setTimeout(() => returnTarget?.focus(), 0);
    };
  }, [initialFocusRef, nested]);

  const handleBackdrop = (event: MouseEvent<HTMLDivElement>) => {
    if (closeOnBackdrop && event.target === event.currentTarget && isTopModal(instanceIdRef.current)) {
      onClose();
    }
  };

  return createPortal(
    <div
      className={`modal-shell studio-modal-overlay ${nested ? "modal-shell--nested" : ""} ${overlayClassName}`}
      onMouseDown={handleBackdrop}
      data-modal-overlay
    >
      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid={testId}
        className={`modal-panel studio-modal ${className}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id={titleId} className="sr-only">
          {title}
        </h2>
        {children}
      </section>
    </div>,
    document.body,
  );
}

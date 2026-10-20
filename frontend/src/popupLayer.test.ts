import { beforeEach, describe, expect, it } from "vitest";

import { hasOpenPopup, popPopup, pushPopup, resetPopupCount } from "./popupLayer";

describe("popupLayer 浮层计数", () => {
  beforeEach(() => resetPopupCount());

  it("初始没有浮层", () => {
    expect(hasOpenPopup()).toBe(false);
  });

  it("push 后报告有浮层，pop 后恢复", () => {
    pushPopup();
    expect(hasOpenPopup()).toBe(true);
    popPopup();
    expect(hasOpenPopup()).toBe(false);
  });

  it("多层嵌套：全部 pop 完才算没有浮层", () => {
    pushPopup();
    pushPopup();
    expect(hasOpenPopup()).toBe(true);
    popPopup();
    expect(hasOpenPopup()).toBe(true); // 还剩一层
    popPopup();
    expect(hasOpenPopup()).toBe(false);
  });

  it("多余的 pop 不会把计数弄成负数（否则 hasOpenPopup 永远是 true）", () => {
    popPopup();
    popPopup();
    expect(hasOpenPopup()).toBe(false);
    pushPopup();
    expect(hasOpenPopup()).toBe(true);
    popPopup();
    expect(hasOpenPopup()).toBe(false);
  });

  it("resetPopupCount 清空计数", () => {
    pushPopup();
    pushPopup();
    resetPopupCount();
    expect(hasOpenPopup()).toBe(false);
  });
});

// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  CROP_MIN_SIZE,
  MAX_UPSCALE_LONG_EDGE,
  centeredSquareCrop,
  clamp,
  clampCrop,
  fitCropToRatio,
  gcd,
  gcdRatio,
  moveCrop,
  resizeCrop,
  resolveUpscaleSize,
  type CropHandle,
  type CropRect,
} from "./imageOps";

// A 层纯几何数学的单测；B 层 canvas I/O（loadImage / readImageSize /
// cropDataUrl / upscaleDataUrl）依赖 2D context，jsdom 没有，不测。

/** 裁剪框映射到像素后的宽高比（判定"锁比例裁出的是不是目标像素比例"的唯一口径） */
function pixelRatio(rect: CropRect, box: { width: number; height: number }): number {
  return (rect.width * box.width) / (rect.height * box.height);
}

describe("clamp", () => {
  it("落在区间内原样返回，越界夹回边界", () => {
    expect(clamp(0.5, 0, 1)).toBe(0.5);
    expect(clamp(-1, 0, 1)).toBe(0);
    expect(clamp(2, 0, 1)).toBe(1);
  });

  it("min > max 时自动交换（不产生反向区间）", () => {
    expect(clamp(0.5, 1, 0)).toBe(0.5);
    expect(clamp(-5, 1, 0)).toBe(0);
    expect(clamp(5, 1, 0)).toBe(1);
  });

  it("NaN 按下限处理，不抛错也不传染 NaN", () => {
    expect(clamp(Number.NaN, 0, 1)).toBe(0);
  });
});

describe("centeredSquareCrop", () => {
  it("默认框是 0.76 居中正方形", () => {
    expect(centeredSquareCrop()).toEqual({ x: 0.12, y: 0.12, width: 0.76, height: 0.76 });
  });

  it("四边留白对称，恰好铺满 1", () => {
    const rect = centeredSquareCrop();
    expect(rect.x + rect.width + rect.x).toBeCloseTo(1, 12);
    expect(rect.y + rect.height + rect.y).toBeCloseTo(1, 12);
  });
});

describe("clampCrop", () => {
  it("宽高超界夹到 1，左上角夹回图内", () => {
    expect(clampCrop({ x: -0.2, y: 0.9, width: 1.4, height: 0.5 })).toEqual({
      x: 0,
      y: 0.5,
      width: 1,
      height: 0.5,
    });
  });

  it("宽高低于最小尺寸抬到 minSize", () => {
    const rect = clampCrop({ x: 0.5, y: 0.5, width: 0.01, height: 0 });
    expect(rect.width).toBe(CROP_MIN_SIZE);
    expect(rect.height).toBe(CROP_MIN_SIZE);
  });

  it("x + width 恰好 1 时 x 被夹到 0，右缘不出界", () => {
    expect(clampCrop({ x: 0.3, y: 0, width: 1, height: 0.2 })).toEqual({ x: 0, y: 0, width: 1, height: 0.2 });
  });

  it("自定义 minSize 生效", () => {
    expect(clampCrop({ x: 0, y: 0, width: 0.001, height: 0.001 }, 0.2)).toEqual({
      x: 0,
      y: 0,
      width: 0.2,
      height: 0.2,
    });
  });
});

describe("moveCrop", () => {
  const base: CropRect = { x: 0.2, y: 0.2, width: 0.3, height: 0.3 };

  it("正常移动不变形", () => {
    const moved = moveCrop(base, 0.1, -0.05);
    expect(moved.x).toBeCloseTo(0.3, 12);
    expect(moved.y).toBeCloseTo(0.15, 12);
    expect(moved.width).toBe(0.3);
    expect(moved.height).toBe(0.3);
  });

  it("拖出右/下边界时贴边停住", () => {
    const moved = moveCrop(base, 1, 1);
    expect(moved.x).toBeCloseTo(0.7, 12);
    expect(moved.y).toBeCloseTo(0.7, 12);
  });

  it("拖出左/上边界时贴边停住", () => {
    const moved = moveCrop(base, -1, -1);
    expect(moved).toEqual({ ...base, x: 0, y: 0 });
  });

  it("全图裁剪框不可移动（无处可去）", () => {
    const full: CropRect = { x: 0, y: 0, width: 1, height: 1 };
    expect(moveCrop(full, 0.5, -0.5)).toEqual(full);
  });
});

describe("resizeCrop（自由模式）", () => {
  const base: CropRect = { x: 0.2, y: 0.2, width: 0.3, height: 0.3 };
  const squareBox = { width: 600, height: 600 };

  it.each<CropHandle>(["se", "sw", "ne", "nw", "n", "s", "e", "w"])(
    "手柄 %s 拖拽后框仍落在 [0,1]² 内",
    (handle) => {
      const rect = resizeCrop(base, 5, -7, handle, null, squareBox);
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(1 + 1e-12);
      expect(rect.y + rect.height).toBeLessThanOrEqual(1 + 1e-12);
      expect(rect.width).toBeGreaterThanOrEqual(CROP_MIN_SIZE);
      expect(rect.height).toBeGreaterThanOrEqual(CROP_MIN_SIZE);
    },
  );

  it("拖 se 只改宽高，x/y 不动", () => {
    expect(resizeCrop(base, 0.1, 0.1, "se", null, squareBox)).toEqual({ x: 0.2, y: 0.2, width: 0.4, height: 0.4 });
  });

  it("拖 nw 时 x/y 随之移动，对侧边固定", () => {
    const rect = resizeCrop(base, -0.1, 0.05, "nw", null, squareBox);
    expect(rect.x).toBeCloseTo(0.1, 12);
    expect(rect.y).toBeCloseTo(0.25, 12);
    expect(rect.width).toBeCloseTo(0.4, 12);
    expect(rect.height).toBeCloseTo(0.25, 12);
    // 对侧边（右缘 / 下缘）不动
    expect(rect.x + rect.width).toBeCloseTo(0.5, 12);
    expect(rect.y + rect.height).toBeCloseTo(0.5, 12);
  });

  it("拖 w 越过对侧边时宽度兜底到最小尺寸（右缘位置交给 x 夹紧）", () => {
    // dx=+0.5：左缘拖到 0.7，宽 0.3-0.5=-0.2 → 兜到 minSize；x 夹回 [0, 1-0.06]
    const rect = resizeCrop(base, 0.5, 0, "w", null, squareBox);
    expect(rect.width).toBe(CROP_MIN_SIZE);
    expect(rect.x).toBeCloseTo(0.7, 12);
    expect(rect.y).toBeCloseTo(0.2, 12);
    expect(rect.height).toBeCloseTo(0.3, 12);
  });

  it("拖出右边界时宽先夹到 1、再把 x 夹回 0", () => {
    const rect = resizeCrop({ x: 0.2, y: 0.2, width: 0.7, height: 0.3 }, 0.5, 0, "se", null, squareBox);
    expect(rect.width).toBe(1);
    expect(rect.x).toBe(0);
    expect(rect.y).toBeCloseTo(0.2, 12);
    expect(rect.height).toBeCloseTo(0.3, 12);
  });
});

describe("resizeCrop（锁比例：像素比例 → 归一化比例换算）", () => {
  it("boxAspect=0.5、aspectRatio=1：像素正方形 ⇒ 归一化 h/w=2（w/h=0.5）", () => {
    // 显示盒 600x300（boxAspect=0.5）。normalizedRatio = 1 * 0.5 = 0.5，
    // 归一化高是宽的 2 倍——像素上 (w*600) : (h*300) = 1:1。
    // （h/w=2 与 w/h=0.5 等价；任务文案「w/h≈2」是把分子分母写反了，
    //  公式、参考实现、像素守恒三方一致指向 h/w=2，以像素正方形为准。）
    const base: CropRect = { x: 0.25, y: 0.25, width: 0.25, height: 0.5 };
    const box = { width: 600, height: 300 };
    const rect = resizeCrop(base, 0.1, 0, "se", 1, box);
    expect(rect.width).toBeCloseTo(0.35, 12);
    expect(rect.height).toBeCloseTo(0.7, 12);
    expect(rect.height / rect.width).toBeCloseTo(2, 9);
    expect(rect.width / rect.height).toBeCloseTo(0.5, 9);
    // 像素正方形（真正的验收口径：1:1 不能裁出长方形）
    expect(pixelRatio(rect, box)).toBeCloseTo(1, 9);
  });

  it("反方向验证：boxAspect=2、aspectRatio=1 ⇒ 归一化 w/h=2（w/h=1/boxAspect）", () => {
    const box = { width: 300, height: 600 };
    const rect = resizeCrop({ x: 0.1, y: 0.1, width: 0.4, height: 0.2 }, 0, 0.1, "s", 1, box);
    expect(rect.width).toBeCloseTo(0.6, 12);
    expect(rect.height).toBeCloseTo(0.3, 12);
    expect(rect.width / rect.height).toBeCloseTo(2, 9);
    expect(pixelRatio(rect, box)).toBeCloseTo(1, 9);
  });

  it("正方形显示盒（boxAspect=1）锁 1:1 得归一化正方形", () => {
    const rect = resizeCrop({ x: 0.2, y: 0.2, width: 0.3, height: 0.3 }, 0.1, 0.1, "se", 1, {
      width: 600,
      height: 600,
    });
    expect(rect.width).toBeCloseTo(rect.height, 12);
  });

  it("锁 4:3（aspectRatio=4/3）在正方形盒里 w/h = 4/3", () => {
    const rect = resizeCrop({ x: 0.2, y: 0.2, width: 0.4, height: 0.3 }, 0.2, 0, "se", 4 / 3, {
      width: 600,
      height: 600,
    });
    expect(rect.width / rect.height).toBeCloseTo(4 / 3, 9);
  });

  it("拖角手柄时以像素位移更大的轴为主导轴（宽主导）", () => {
    const box = { width: 600, height: 300 };
    // |dx*600|=60px > |dy*300|=6px → 以宽为准
    const rect = resizeCrop({ x: 0.1, y: 0.05, width: 0.3, height: 0.15 }, 0.1, 0.02, "se", 1, box);
    expect(rect.width).toBeCloseTo(0.4, 12);
    expect(rect.height).toBeCloseTo(0.8, 12);
    expect(pixelRatio(rect, box)).toBeCloseTo(1, 9);
  });

  it("拖角手柄时以像素位移更大的轴为主导轴（高主导）", () => {
    const box = { width: 600, height: 300 };
    // |dx*600|=6px < |dy*300|=30px → 以高为准
    const rect = resizeCrop({ x: 0.1, y: 0.05, width: 0.3, height: 0.15 }, 0.01, 0.1, "se", 1, box);
    expect(rect.height).toBeCloseTo(0.25, 12);
    expect(rect.width).toBeCloseTo(0.125, 12);
    expect(pixelRatio(rect, box)).toBeCloseTo(1, 9);
  });

  it("拖 w 手柄时右缘固定（x 由锁比例反推）", () => {
    const box = { width: 600, height: 300 };
    const rect = resizeCrop({ x: 0.6, y: 0.1, width: 0.3, height: 0.15 }, 0.1, 0, "w", 1, box);
    expect(rect.x).toBeCloseTo(0.7, 12);
    expect(rect.width).toBeCloseTo(0.2, 12);
    expect(rect.height).toBeCloseTo(0.4, 12);
    // 右缘 0.9 固定不动
    expect(rect.x + rect.width).toBeCloseTo(0.9, 9);
    expect(rect.y).toBeCloseTo(0.1, 12);
  });

  it("拖 n 手柄时下缘固定（y 由锁比例反推）", () => {
    const box = { width: 600, height: 300 };
    const rect = resizeCrop({ x: 0.1, y: 0.6, width: 0.3, height: 0.15 }, 0, -0.05, "n", 1, box);
    expect(rect.y).toBeCloseTo(0.55, 12);
    expect(rect.height).toBeCloseTo(0.2, 12);
    expect(rect.width).toBeCloseTo(0.1, 12);
    // 下缘 0.75 固定不动
    expect(rect.y + rect.height).toBeCloseTo(0.75, 9);
    expect(rect.x).toBeCloseTo(0.1, 12);
  });

  it("锁比例下超界被等比缩回（两轮夹紧不破比例）", () => {
    const box = { width: 600, height: 300 };
    const rect = resizeCrop({ x: 0.1, y: 0.3, width: 0.5, height: 0.25 }, 0.6, 0.3, "se", 1, box);
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.y).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.width).toBeLessThanOrEqual(1 + 1e-9);
    expect(rect.y + rect.height).toBeLessThanOrEqual(1 + 1e-9);
    expect(rect.width / rect.height).toBeCloseTo(0.5, 6);
    expect(pixelRatio(rect, box)).toBeCloseTo(1, 6);
    expect(rect.width).toBeGreaterThanOrEqual(CROP_MIN_SIZE);
    expect(rect.height).toBeGreaterThanOrEqual(CROP_MIN_SIZE);
  });

  it("aspectRatio 非法（0 / 负数）时按自由模式处理", () => {
    const args = { x: 0.2, y: 0.2, width: 0.3, height: 0.3 } as const;
    const free = resizeCrop(args, 0.1, 0, "se", null, { width: 600, height: 600 });
    expect(resizeCrop(args, 0.1, 0, "se", 0, { width: 600, height: 600 })).toEqual(free);
    expect(resizeCrop(args, 0.1, 0, "se", -2, { width: 600, height: 600 })).toEqual(free);
  });
});

describe("fitCropToRatio", () => {
  it("正方形盒里切 1:1 保持中心收缩成正方形", () => {
    const rect = fitCropToRatio({ x: 0.3, y: 0.2, width: 0.5, height: 0.3 }, 1, { width: 600, height: 600 });
    expect(rect.width).toBeCloseTo(rect.height, 12);
    expect(rect.x + rect.width / 2).toBeCloseTo(0.55, 9);
    expect(rect.y + rect.height / 2).toBeCloseTo(0.35, 9);
    // 取的是能放下的最大尺寸
    expect(rect.height).toBeCloseTo(0.3, 12);
    expect(rect.width).toBeCloseTo(0.3, 12);
  });

  it("横图（600x300）上切 1:1：归一化高是宽的 2 倍（像素正方形）", () => {
    // normalizedRatio = 1 * (300/600) = 0.5：0.8 宽需要 1.6 高 > 0.4 → 收缩到 0.2 x 0.4
    const image = { width: 600, height: 300 };
    const rect = fitCropToRatio({ x: 0.1, y: 0.3, width: 0.8, height: 0.4 }, 1, image);
    expect(rect.width).toBeCloseTo(0.2, 12);
    expect(rect.height).toBeCloseTo(0.4, 12);
    expect(rect.width / rect.height).toBeCloseTo(0.5, 9);
    // 像素正方形：0.2*600 = 0.4*300 = 120
    expect(rect.width * image.width).toBeCloseTo(rect.height * image.height, 9);
    // 中心保持
    expect(rect.x + rect.width / 2).toBeCloseTo(0.5, 9);
    expect(rect.y + rect.height / 2).toBeCloseTo(0.5, 9);
  });

  it("竖图（300x600）上切 16:9：现有宽放得下就按宽收缩", () => {
    // normalizedRatio = (16/9) * 2 = 32/9 ≈ 3.556；0.8 宽 → 0.225 高 ≤ 0.4，不触顶
    const image = { width: 300, height: 600 };
    const rect = fitCropToRatio({ x: 0, y: 0.2, width: 0.8, height: 0.4 }, 16 / 9, image);
    expect(rect.width).toBeCloseTo(0.8, 12);
    expect(rect.height).toBeCloseTo(0.8 * (9 / 32), 12);
    expect(rect.width / rect.height).toBeCloseTo(32 / 9, 9);
    // 像素比例 16:9：0.8*300 : (0.8*9/32)*600 = 240 : 135
    expect(pixelRatio(rect, image)).toBeCloseTo(16 / 9, 9);
  });

  it("中心保持在原框中心（clamp 前提下）", () => {
    const rect = fitCropToRatio({ x: 0.1, y: 0.1, width: 0.8, height: 0.2 }, 1, { width: 600, height: 600 });
    expect(rect.x + rect.width / 2).toBeCloseTo(0.5, 9);
    expect(rect.y + rect.height / 2).toBeCloseTo(0.2, 9);
    expect(rect.width).toBeCloseTo(0.2, 12);
  });

  it("已符合比例的框保持不变（尺寸与位置）", () => {
    const rect = fitCropToRatio({ x: 0.2, y: 0.2, width: 0.5, height: 0.5 }, 1, { width: 400, height: 400 });
    expect(rect.width).toBeCloseTo(0.5, 12);
    expect(rect.height).toBeCloseTo(0.5, 12);
    expect(rect.x).toBeCloseTo(0.2, 12);
    expect(rect.y).toBeCloseTo(0.2, 12);
  });
});

describe("resolveUpscaleSize", () => {
  it("按长边等比放大并取整", () => {
    expect(resolveUpscaleSize(800, 600, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(resolveUpscaleSize(600, 800, 1600)).toEqual({ width: 1200, height: 1600 });
  });

  it("非整数目标长边四舍五入", () => {
    expect(resolveUpscaleSize(100, 40, 100.4)).toEqual({ width: 100, height: 40 });
    expect(resolveUpscaleSize(100, 40, 100.6)).toEqual({ width: 101, height: 40 });
  });

  it("目标低于 1 或为 NaN 时抬到 1，不产生 0/负尺寸", () => {
    expect(resolveUpscaleSize(100, 50, 0)).toEqual({ width: 1, height: 1 });
    expect(resolveUpscaleSize(100, 50, -5)).toEqual({ width: 1, height: 1 });
    expect(resolveUpscaleSize(100, 50, Number.NaN)).toEqual({ width: 1, height: 1 });
  });

  it("超过 MAX_UPSCALE_LONG_EDGE 时夹到上限", () => {
    expect(resolveUpscaleSize(1000, 500, 99999)).toEqual({
      width: MAX_UPSCALE_LONG_EDGE,
      height: MAX_UPSCALE_LONG_EDGE / 2,
    });
  });

  it("目标小于当前长边时是缩小而不是放大（resolve 只管几何）", () => {
    expect(resolveUpscaleSize(2000, 1000, 1000)).toEqual({ width: 1000, height: 500 });
  });
});

describe("gcd / gcdRatio", () => {
  it("gcd 基本用例（gcd(a,0)=a，gcd(0,0)=1 防除零）", () => {
    expect(gcd(1920, 1080)).toBe(120);
    expect(gcd(16, 9)).toBe(1);
    expect(gcd(7, 0)).toBe(7);
    expect(gcd(0, 0)).toBe(1);
  });

  it("gcd 非整数输入先取整再算，不抛错", () => {
    expect(gcd(1919.9, 1079.5)).toBe(gcd(1920, 1080));
  });

  it("gcdRatio 约分到最简整数比", () => {
    expect(gcdRatio(1920, 1080)).toBe("16:9");
    expect(gcdRatio(1024, 1024)).toBe("1:1");
    expect(gcdRatio(3840, 2160)).toBe("16:9");
  });

  it("gcdRatio 对互质的尺寸保留原比（1024 与 999 互质）", () => {
    expect(gcdRatio(1024, 999)).toBe("1024:999");
  });
});

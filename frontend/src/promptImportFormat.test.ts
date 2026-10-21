import { describe, expect, it } from "vitest";

import {
  IMPORT_CARD_COLUMN_PITCH,
  IMPORT_CARD_HEIGHT,
  IMPORT_CARD_ROW_PITCH,
  IMPORT_CARD_WIDTH,
  buildPromptNodes,
  importCardPositions,
  parsePromptImportFormat,
  resolveCardSize,
} from "./promptImportFormat";

/** 构造一块导入格式文本（标题 + ```text 围栏 + ratio 行 + 正文） */
/** noUncheckedIndexedAccess 守卫：越界即失败，不把断言弱化为可选链 */
function indexed<T>(items: ArrayLike<T>, at: number): T {
  const item = items[at];
  if (item === undefined) throw new Error(`indexed: 长度 ${items.length} 越界下标 ${at}`);
  return item;
}

function block(title: string, ratio: string, prompt: string): string {
  return `=== ${title} ===\n\`\`\`text\nratio: ${ratio}\n\n${prompt}\n\`\`\`\n`;
}

const SAMPLE_10 = [
  block("轮播图1", "1:1", "product bottle on clean mint background, centered, studio light"),
  block("轮播图2", "1:1", "close-up of bottle cap texture, soft shadow, pastel tones"),
  block("轮播图3", "1:1", "bottle with water splash, high contrast, product hero shot"),
  block("轮播图4", "1:1", "bottle on marble surface, top view, minimalist composition"),
  block("轮播图5", "1:1", "bottle with brand logo facing camera, golden hour light"),
  block("详情图1", "9:16", "vertical poster, full product, brand name top, clean gradient background"),
  block("详情图2", "9:16", "info card layout, product name and net weight text, soft card background"),
  block("详情图3", "9:16", "bottle in bathroom scene, tile wall, towel nearby"),
  block("详情图4", "9:16", "hand pressing pump dispenser, cropped below neck, skincare action"),
  block("详情图5", "9:16", "closing shot, bottle centered with brand slogan, vertical banner"),
].join("\n");

describe("parsePromptImportFormat", () => {
  it("解析标准 10 块：全部进 cards，标题/ratio/正文正确，无 issues", () => {
    const result = parsePromptImportFormat(SAMPLE_10);
    expect(result.cards).toHaveLength(10);
    expect(result.issues).toHaveLength(0);
    expect(result.skippedText).toEqual([]);
    expect(result.cards[0]).toEqual({
      title: "轮播图1",
      ratio: "1:1",
      prompt: "product bottle on clean mint background, centered, studio light",
    });
    expect(indexed(result.cards, 5).title).toBe("详情图1");
    expect(indexed(result.cards, 5).ratio).toBe("9:16");
    expect(indexed(result.cards, 9).title).toBe("详情图5");
  });

  it("单块最小合法性", () => {
    const result = parsePromptImportFormat(block("轮播图1", "1:1", "a bottle"));
    expect(result.cards).toEqual([{ title: "轮播图1", ratio: "1:1", prompt: "a bottle" }]);
  });

  it("缺 ratio 行 → missing-ratio，块不进 cards", () => {
    const text = `=== 轮播图1 ===\n\`\`\`text\nsome prompt without ratio\n\`\`\`\n`;
    const result = parsePromptImportFormat(text);
    expect(result.cards).toHaveLength(0);
    expect(indexed(result.issues, 0).code).toBe("missing-ratio");
    expect(indexed(result.issues, 0).title).toBe("轮播图1");
  });

  it("ratio 行格式非法（abc / 1）→ bad-ratio", () => {
    const bad1 = `=== 轮播图1 ===\n\`\`\`text\nratio: abc\n\nbody\n\`\`\`\n`;
    const bad2 = `=== 轮播图1 ===\n\`\`\`text\nratio: 1\n\nbody\n\`\`\`\n`;
    expect(indexed(parsePromptImportFormat(bad1).issues, 0).code).toBe("bad-ratio");
    expect(indexed(parsePromptImportFormat(bad2).issues, 0).code).toBe("bad-ratio");
  });

  it("ratio 冒号后无空格也能解析（容错）", () => {
    const text = `=== 轮播图1 ===\n\`\`\`text\nratio:1:1\n\nbody\n\`\`\`\n`;
    const result = parsePromptImportFormat(text);
    expect(indexed(result.cards, 0).ratio).toBe("1:1");
  });

  it("正文为空 → empty-prompt", () => {
    const text = `=== 轮播图1 ===\n\`\`\`text\nratio: 1:1\n\n\`\`\`\n`;
    const result = parsePromptImportFormat(text);
    expect(result.cards).toHaveLength(0);
    expect(indexed(result.issues, 0).code).toBe("empty-prompt");
  });

  it("标题重复 → duplicate-title，保留首个、排除后续", () => {
    const text = `${block("轮播图1", "1:1", "first")}${block("轮播图1", "1:1", "second")}`;
    const result = parsePromptImportFormat(text);
    expect(result.cards).toHaveLength(1);
    expect(indexed(result.cards, 0).prompt).toBe("first");
    expect(result.issues.some((i) => i.code === "duplicate-title")).toBe(true);
  });

  it("有标题无围栏 → missing-fence", () => {
    const text = `=== 轮播图1 ===\nplain text without fence\n`;
    const result = parsePromptImportFormat(text);
    expect(result.cards).toHaveLength(0);
    expect(indexed(result.issues, 0).code).toBe("missing-fence");
  });

  it("全文无标题但存在围栏 → missing-header", () => {
    const text = "some intro\n```text\nratio: 1:1\n\nbody\n```\n";
    const result = parsePromptImportFormat(text);
    expect(result.cards).toHaveLength(0);
    expect(indexed(result.issues, 0).code).toBe("missing-header");
  });

  it("块前解说文字 → 进 skippedText，块不受影响", () => {
    const text = `以下是 10 条提示词：\n${block("轮播图1", "1:1", "a bottle")}`;
    const result = parsePromptImportFormat(text);
    expect(result.cards).toHaveLength(1);
    expect(result.skippedText.some((s) => s.includes("以下是"))).toBe(true);
  });

  it("CRLF + BOM 混合输入 → 正常解析", () => {
    const crlf = block("轮播图1", "1:1", "a bottle").replace(/\n/g, "\r\n");
    const text = `\uFEFF${crlf}`;
    const result = parsePromptImportFormat(text);
    expect(result.cards).toHaveLength(1);
    expect(indexed(result.cards, 0).prompt).toBe("a bottle");
  });

  it("``` 与 ```text 围栏混合均接受", () => {
    const text =
      `=== 轮播图1 ===\n\`\`\`\nratio: 1:1\n\nbody A\n\`\`\`\n` +
      `=== 轮播图2 ===\n\`\`\`text\nratio: 1:1\n\nbody B\n\`\`\`\n`;
    const result = parsePromptImportFormat(text);
    expect(result.cards).toHaveLength(2);
    expect(result.cards.map((c) => c.prompt)).toEqual(["body A", "body B"]);
  });

  it("正文内嵌三反引号 → 取最后一个围栏闭合，正文保留", () => {
    const text = `=== 轮播图1 ===\n\`\`\`text\nratio: 1:1\n\nline with \`\`\` inside\nlast line\n\`\`\`\n`;
    const result = parsePromptImportFormat(text);
    expect(result.cards).toHaveLength(1);
    expect(indexed(result.cards, 0).prompt).toContain("inside");
    expect(indexed(result.cards, 0).prompt).toContain("last line");
  });
});

describe("resolveCardSize", () => {
  // label 形如后端 config.sizes： "1024x1024 (1:1 1K)"
  const sizes = [
    { value: "1024x1024", label: "1024x1024 (1:1 1K)", cost: 0.05 },
    { value: "1152x2048", label: "1152x2048 (9:16 竖版长图)", cost: 0.1 },
  ];

  it("按 label 匹配比例", () => {
    expect(resolveCardSize("1:1", sizes)).toEqual({ value: "1024x1024", fallback: false });
    expect(resolveCardSize("9:16", sizes)).toEqual({ value: "1152x2048", fallback: false });
  });

  it("无匹配比例 → 回退 sizes[0] 且 fallback=true", () => {
    const r = resolveCardSize("4:3", sizes);
    expect(r).toEqual({ value: "1024x1024", fallback: true });
  });

  it("sizes 为空 → 内置 1024x1024 且 fallback=true", () => {
    const r = resolveCardSize("1:1", []);
    expect(r).toEqual({ value: "1024x1024", fallback: true });
  });

  it("ratio 格式非法 → fallback", () => {
    const r = resolveCardSize("abc", sizes);
    expect(r.fallback).toBe(true);
  });
});

describe("buildPromptNodes", () => {
  const config = {
    sizes: [
      { value: "1024x1024", label: "1024x1024 (1:1 1K)", cost: 0.05 },
      { value: "1152x2048", label: "1152x2048 (9:16 竖版长图)", cost: 0.1 },
    ],
    defaultQuality: "high",
    defaultOutputDir: "imgs",
  };

  it("每卡片一个节点，携带标题与正确尺寸", () => {
    const nodes = buildPromptNodes(
      [
        { title: "轮播图1", ratio: "1:1", prompt: "a bottle" },
        { title: "详情图1", ratio: "9:16", prompt: "vertical poster" },
      ],
      config,
      { x: 100, y: 50 },
    );
    expect(nodes).toHaveLength(2);
    expect(indexed(nodes, 0).id).toMatch(/^prompt-\d+-0$/);
    expect(indexed(nodes, 0).type).toBe("prompt");
    expect(indexed(nodes, 0).data.title).toBe("轮播图1");
    expect(indexed(nodes, 0).data.size).toBe("1024x1024");
    expect(indexed(nodes, 0).data.quality).toBe("high");
    expect(indexed(nodes, 0).data.outputDir).toBe("imgs");
    expect(indexed(nodes, 1).data.title).toBe("详情图1");
    expect(indexed(nodes, 1).data.size).toBe("1152x2048");
  });

  it("位置按卡片真实尺寸铺开：列距 420，整行以 origin 为中心", () => {
    const nodes = buildPromptNodes(
      Array.from({ length: 3 }, (_, i) => ({ title: `图${i}`, ratio: "1:1", prompt: "p" })),
      config,
      { x: 100, y: 50 },
    );
    // 3 张一行宽 380*3 + 40*2 = 1220，中心落在 origin.x → 首张 -320
    expect(indexed(nodes, 0).position).toEqual({ x: -320, y: 50 });
    expect(indexed(nodes, 1).position).toEqual({ x: 100, y: 50 });
    expect(indexed(nodes, 2).position).toEqual({ x: 520, y: 50 });
  });
});

describe("importCardPositions", () => {
  it("单张卡仍落在 origin（与新建一张卡的落点一致）", () => {
    expect(importCardPositions({ x: 100, y: 50 }, 1)).toEqual([{ x: 100, y: 50 }]);
  });

  it("三列铺开：第 4 张换行，列距 420 / 行距 400", () => {
    const positions = importCardPositions({ x: 1000, y: 200 }, 4);
    // 第一行三张以 origin 为中心：1000-420 / 1000 / 1000+420
    expect(indexed(positions, 0)).toEqual({ x: 580, y: 200 });
    expect(indexed(positions, 1)).toEqual({ x: 1000, y: 200 });
    expect(indexed(positions, 2)).toEqual({ x: 1420, y: 200 });
    // 第 4 张换到下一行，最后一行居中 → 回到 origin.x
    expect(indexed(positions, 3)).toEqual({ x: 1000, y: 200 + IMPORT_CARD_ROW_PITCH });
  });

  it("8 张卡两两不重叠（列距 ≥ 卡宽 + 间距，行距 ≥ 卡高）", () => {
    const positions = importCardPositions({ x: 0, y: 0 }, 8);
    expect(positions).toHaveLength(8);
    expect(IMPORT_CARD_COLUMN_PITCH).toBeGreaterThanOrEqual(400);
    expect(IMPORT_CARD_ROW_PITCH).toBeGreaterThanOrEqual(IMPORT_CARD_HEIGHT);
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        const a = indexed(positions, i);
        const b = indexed(positions, j);
        const dx = Math.abs(a.x - b.x);
        const dy = Math.abs(a.y - b.y);
        // 矩形不重叠：只要有一个轴的距离 ≥ 卡宽 / 卡高，两张卡就不交叠
        expect(dx >= IMPORT_CARD_WIDTH || dy >= IMPORT_CARD_HEIGHT, `第 ${i} 与 ${j} 张重叠`).toBe(
          true,
        );
      }
    }
    // 坐标必须彼此不同，不能整批叠在同一个点
    expect(new Set(positions.map((p) => `${p.x},${p.y}`)).size).toBe(8);
  });

  it("数量非法 / 为 0 时返回空数组，且不修改 origin", () => {
    expect(importCardPositions({ x: 1, y: 2 }, 0)).toEqual([]);
    expect(importCardPositions({ x: 1, y: 2 }, -3)).toEqual([]);
    expect(importCardPositions({ x: 1, y: 2 }, Number.NaN)).toEqual([]);
    const origin = { x: 7, y: 9 };
    importCardPositions(origin, 5);
    expect(origin).toEqual({ x: 7, y: 9 });
  });
});
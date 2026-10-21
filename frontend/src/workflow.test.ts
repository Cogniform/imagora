import { describe, expect, it } from "vitest";

import type { WorkflowEdge, WorkflowNode } from "./types";
import { autoConnect, autoConnectSelection, buildGroupNode, buildPromptNode, canConnect, collectIncomingImages, collectPromptRefImages, computeCounts, extractAnimClasses, isImageFile, mergeSubmissionGraph, snapshotIncomingAbsPaths, staggerCreatePosition, updatePromptNode, updateSelectedPromptOutputDirs, withEnterAnim, workflowToCanvas } from "./workflow";

/** noUncheckedIndexedAccess 守卫：越界即失败，不把断言弱化为可选链 */
function indexed<T>(items: ArrayLike<T>, at: number): T {
  const item = items[at];
  if (item === undefined) throw new Error(`indexed: 长度 ${items.length} 越界下标 ${at}`);
  return item;
}

function promptNode(id: string, y = 0): WorkflowNode {
  return {
    id,
    type: "prompt",
    position: { x: 0, y },
    data: {
      prompt: id,
      size: "1024x1024",
      quality: "high",
      outputDir: "output",
      status: "idle",
    },
  } as WorkflowNode;
}

function imageNode(id: string, y = 0): WorkflowNode {
  return {
    id,
    type: "image",
    position: { x: 0, y },
    data: {
      registryId: id,
      name: `${id}.png`,
      url: `/api/image?path=${id}`,
      size: 10,
      ext: "png",
      refCount: 0,
      absPath: `C:\\output\\${id}.png`,
    },
  } as WorkflowNode;
}

function edge(source: string, target: string): WorkflowEdge {
  return { id: `${source}->${target}`, source, target };
}

function groupNode(id: string): WorkflowNode {
  return {
    id,
    type: "group",
    position: { x: 0, y: 0 },
    data: { name: id, imageCount: 0, totalSize: 0 },
  } as WorkflowNode;
}

/** 旧版本持久化节点可能缺字段（如 quality）：刻意构造 schema 外数据，验证加载期兜底 */
function legacyPromptNode(id: string): WorkflowNode {
  return {
    id,
    type: "prompt",
    position: { x: 0, y: 0 },
    data: {
      prompt: "product photo",
      size: "1024x1024",
      outputDir: "output",
      status: "idle",
    },
  } as WorkflowNode;
}

describe("workflow defaults", () => {
  it("uses high for a legacy prompt without quality", () => {
    const legacyPrompt = legacyPromptNode("p1");

    const result = workflowToCanvas([legacyPrompt], [], []);
    const prompt = indexed(result.nodes, 0);

    expect(prompt.type === "prompt" && prompt.data.quality).toBe("high");
  });
});

describe("prompt node updates", () => {
  it("returns the original array when the patch matches current data (idempotent)", () => {
    const node = promptNode("p1");
    const nodes = [node];

    const same = updatePromptNode(nodes, "p1", { status: "idle", startedAtMs: undefined });
    expect(same).toBe(nodes);
  });

  it("updates the prompt node on real changes and leaves other nodes untouched", () => {
    const prompt = promptNode("p1");
    const image = imageNode("img1");
    const nodes = [prompt, image];

    const changed = updatePromptNode(nodes, "p1", { status: "running", startedAtMs: 1000 });
    expect(changed).not.toBe(nodes);
    expect(changed[0]).not.toBe(prompt);
    expect(indexed(changed, 0).data.status).toBe("running");
    expect(indexed(changed, 0).data.startedAtMs).toBe(1000);
    expect(changed[1]).toBe(image);
  });

  it("keeps the original array for unknown ids (no update)", () => {
    const nodes = [promptNode("p1")];
    expect(updatePromptNode(nodes, "missing", { status: "running" })).toBe(nodes);
  });
});

describe("prompt output directory updates", () => {
  it("updates only selected prompt nodes in a mixed selection", () => {
    const selectedPrompt = promptNode("selected-prompt");
    const untouchedPrompt = promptNode("untouched-prompt");
    const selectedImage = imageNode("selected-image");
    const group = {
      id: "selected-group",
      type: "group",
      position: { x: 0, y: 0 },
      data: { name: "group", imageCount: 0, totalSize: 0 },
    } as WorkflowNode;
    const nodes = [selectedPrompt, untouchedPrompt, selectedImage, group];

    const result = updateSelectedPromptOutputDirs(
      nodes,
      new Set(["selected-prompt", "selected-image", "selected-group"]),
      "D:\\outputs\\campaign",
    );

    expect(result.changedCount).toBe(1);
    expect(result.nodes.find((node) => node.id === "selected-prompt")!.data.outputDir).toBe("D:\\outputs\\campaign");
    expect(result.nodes.find((node) => node.id === "untouched-prompt")).toBe(untouchedPrompt);
    expect(result.nodes.find((node) => node.id === "selected-image")).toBe(selectedImage);
    expect(result.nodes.find((node) => node.id === "selected-group")).toBe(group);
  });

  it("returns the original node array when no selected prompt changes", () => {
    const nodes = [promptNode("prompt"), imageNode("image")];

    const result = updateSelectedPromptOutputDirs(nodes, new Set(["image"]), "D:\\outputs");

    expect(result).toEqual({ nodes, changedCount: 0 });
    expect(result.nodes).toBe(nodes);
  });
});

describe("auto connect", () => {
  it("uses vertical position to distinguish references from generated results", () => {
    const topImage = { ...imageNode("top-image"), position: { x: 0, y: 0 } } as WorkflowNode;
    const prompt = { ...promptNode("prompt"), position: { x: 0, y: 400 } } as WorkflowNode;
    const bottomImage = { ...imageNode("bottom-image"), position: { x: 0, y: 900 } } as WorkflowNode;

    expect(autoConnect([topImage, prompt, bottomImage], [])).toEqual([
      edge("top-image", "prompt"),
      edge("prompt", "bottom-image"),
    ]);
  });

  it("keeps a result image connected from its prompt even when a lower group is closer", () => {
    const prompt = { ...promptNode("prompt"), position: { x: 0, y: 300 } } as WorkflowNode;
    const resultImage = { ...imageNode("result"), position: { x: 0, y: 700 } } as WorkflowNode;
    const lowerGroup = {
      id: "lower-group",
      type: "group",
      position: { x: 0, y: 720 },
      data: { name: "group", imageCount: 0, totalSize: 0 },
    } as WorkflowNode;

    expect(autoConnect([prompt, resultImage, lowerGroup], [])).toEqual([
      edge("prompt", "result"),
      edge("lower-group", "prompt"),
    ]);
  });

  it("connects orphan images to a group even when there is no prompt node", () => {
    const image = { ...imageNode("image"), position: { x: 0, y: 0 } } as WorkflowNode;
    const group = {
      id: "group",
      type: "group",
      position: { x: 200, y: 0 },
      data: { name: "group", imageCount: 0, totalSize: 0 },
    } as WorkflowNode;

    expect(autoConnect([image, group], [])).toEqual([edge("image", "group")]);
  });

  it("connects orphan images by top/bottom position and groups to the nearest prompt", () => {
    const top = { ...imageNode("top"), position: { x: 0, y: 0 } } as WorkflowNode;
    const bottom = { ...imageNode("bottom"), position: { x: 700, y: 900 } } as WorkflowNode;
    const group = {
      id: "group",
      type: "group",
      position: { x: 100, y: 600 },
      data: { name: "group", imageCount: 0, totalSize: 0 },
    } as WorkflowNode;
    const prompt = { ...promptNode("prompt"), position: { x: 350, y: 300 } } as WorkflowNode;

    expect(autoConnect([top, bottom, group, prompt], [])).toEqual([
      edge("top", "prompt"),
      edge("prompt", "bottom"),
      edge("group", "prompt"),
    ]);
  });

  it("keeps existing edges and does not reconnect nodes that already participate", () => {
    const left = { ...imageNode("left"), position: { x: 0, y: 0 } } as WorkflowNode;
    const prompt = { ...promptNode("prompt"), position: { x: 350, y: 0 } } as WorkflowNode;
    const existing = edge("left", "prompt");

    expect(autoConnect([left, prompt], [existing])).toEqual([existing]);
  });

  it("completes a group that already has images but is not connected to a prompt", () => {
    const image = { ...imageNode("image"), position: { x: 0, y: 0 } } as WorkflowNode;
    const group = {
      id: "group",
      type: "group",
      position: { x: 200, y: 0 },
      data: { name: "group", imageCount: 1, totalSize: 10 },
    } as WorkflowNode;
    const prompt = { ...promptNode("prompt"), position: { x: 500, y: 0 } } as WorkflowNode;
    const existing = edge("image", "group");

    expect(autoConnect([image, group, prompt], [existing])).toEqual([
      existing,
      edge("group", "prompt"),
    ]);
  });

  it("connects newly added prompt cards to an already used populated group", () => {
    const image = { ...imageNode("image"), position: { x: 0, y: 0 } } as WorkflowNode;
    const group = {
      id: "group",
      type: "group",
      position: { x: 200, y: 0 },
      data: { name: "group", imageCount: 1, totalSize: 10 },
    } as WorkflowNode;
    const firstPrompt = { ...promptNode("p1"), position: { x: 500, y: 0 } } as WorkflowNode;
    const newPrompt = { ...promptNode("p2"), position: { x: 500, y: 500 } } as WorkflowNode;
    const existing = [edge("image", "group"), edge("group", "p1")];

    expect(autoConnect([image, group, firstPrompt, newPrompt], existing)).toEqual([
      ...existing,
      edge("group", "p2"),
    ]);
  });
});

describe("auto connect selection", () => {
  it("connects only selected orphan nodes, leaving unselected nodes untouched", () => {
    const orphanA = { ...imageNode("a"), position: { x: 0, y: 0 } } as WorkflowNode;
    const promptB = { ...promptNode("b"), position: { x: 200, y: 400 } } as WorkflowNode;
    const unselected = { ...imageNode("unselected"), position: { x: 900, y: 0 } } as WorkflowNode;

    const result = autoConnectSelection(
      [orphanA, promptB, unselected],
      [],
      new Set(["a", "b"]),
    );

    expect(result).toEqual([edge("a", "b")]);
  });

  it("connects nothing when the selection cannot form a pair", () => {
    const image = { ...imageNode("image"), position: { x: 0, y: 0 } } as WorkflowNode;

    const result = autoConnectSelection([image], [], new Set(["image"]));

    expect(result).toEqual([]);
  });

  it("reuses existing edges and never adds edges touching unselected nodes", () => {
    const image = { ...imageNode("image"), position: { x: 0, y: 0 } } as WorkflowNode;
    const group = {
      id: "group",
      type: "group",
      position: { x: 0, y: 200 },
      data: { name: "group", imageCount: 1, totalSize: 10 },
    } as WorkflowNode;
    const prompt = { ...promptNode("prompt"), position: { x: 0, y: 400 } } as WorkflowNode;
    const existing = edge("image", "group");

    // 选中 group + prompt：group 已有未选中图片入边，只补 group -> prompt
    const result = autoConnectSelection(
      [image, group, prompt],
      [existing],
      new Set(["group", "prompt"]),
    );

    expect(result).toEqual([existing, edge("group", "prompt")]);
  });

  it("returns edges unchanged when nothing is selected", () => {
    const image = { ...imageNode("image"), position: { x: 0, y: 0 } } as WorkflowNode;
    const prompt = { ...promptNode("prompt"), position: { x: 0, y: 400 } } as WorkflowNode;
    const existing = edge("image", "prompt");

    expect(autoConnectSelection([image, prompt], [existing], new Set())).toEqual([existing]);
  });
});

describe("incoming reference images", () => {
  it("collects direct and group-expanded images for a prompt", () => {
    const image = imageNode("img1");
    const group = {
      id: "group",
      type: "group",
      position: { x: 0, y: 0 },
      data: { name: "group", imageCount: 2, totalSize: 20 },
    } as WorkflowNode;
    const groupImage = imageNode("img2");
    const prompt = promptNode("p1");

    const images = collectIncomingImages(
      [image, group, groupImage, prompt],
      [edge("img1", "group"), edge("img2", "group"), edge("group", "p1")],
      "p1",
    );

    expect(images.map((n) => n.id).sort()).toEqual(["img1", "img2"]);
  });

  it("dedupes on cycles (image reachable via two paths is collected once)", () => {
    const image = imageNode("img1");
    const prompt = promptNode("p1");

    const images = collectIncomingImages(
      [image, prompt],
      [edge("img1", "p1"), edge("p1", "img1")],
      "p1",
    );

    expect(images.map((n) => n.id)).toEqual(["img1"]);
  });

  it("snapshot skips images without absPath (missing) instead of pushing undefined", () => {
    const present = imageNode("ok");
    const missing = {
      ...imageNode("gone"),
      data: { ...imageNode("gone").data, absPath: undefined },
    } as WorkflowNode;
    const prompt = promptNode("p1");

    const paths = snapshotIncomingAbsPaths(
      [present, missing, prompt],
      [edge("ok", "p1"), edge("gone", "p1")],
      "p1",
    );

    expect(paths).toEqual([`C:\\output\\ok.png`]);
  });

  it("expands nested group chains (group → group → images) for a prompt", () => {
    const groupA = groupNode("gA");
    const groupB = groupNode("gB");
    const groupC = groupNode("gC");
    const nodes = [
      imageNode("img1"), imageNode("img2"), groupA,
      imageNode("img3"), groupB, imageNode("img4"), imageNode("img5"), groupC,
      promptNode("p1"),
    ];
    const edges = [
      edge("img1", "gA"), edge("img2", "gA"),
      edge("gA", "gB"), edge("img3", "gB"),
      edge("gB", "gC"), edge("img4", "gC"), edge("img5", "gC"),
      edge("gC", "p1"),
    ];

    const images = collectIncomingImages(nodes, edges, "p1");

    expect(images.map((n) => n.id).sort()).toEqual(["img1", "img2", "img3", "img4", "img5"]);
  });
});

describe("connection rules", () => {
  it("allows image → prompt / group and prompt → image (output edge)", () => {
    const nodes = [imageNode("img"), groupNode("g"), promptNode("p")];
    expect(canConnect(nodes, [], { source: "img", target: "p" })).toBe(true);
    expect(canConnect(nodes, [], { source: "img", target: "g" })).toBe(true);
    expect(canConnect(nodes, [], { source: "p", target: "img" })).toBe(true);
  });

  it("allows group → prompt and group → group (middle aggregation), multiple in-edges for groups", () => {
    const nodes = [groupNode("g1"), groupNode("g2"), groupNode("g3"), promptNode("p")];
    expect(canConnect(nodes, [], { source: "g1", target: "p" })).toBe(true);
    expect(canConnect(nodes, [], { source: "g1", target: "g2" })).toBe(true);
    // 组可多方聚合：已有入边不阻止新组连入（2张图组 + 3张图组 → 同一组 = 5张）
    const existing = [edge("g1", "g3")];
    expect(canConnect(nodes, existing, { source: "g2", target: "g3" })).toBe(true);
  });

  it("keeps the single-in-edge cap on prompt targets (both image and group sources)", () => {
    const nodes = [imageNode("img"), groupNode("g"), promptNode("p")];
    expect(canConnect(nodes, [edge("img", "p")], { source: "g", target: "p" })).toBe(false);
    expect(canConnect(nodes, [edge("g", "p")], { source: "img", target: "p" })).toBe(false);
  });

  it("rejects wrong-type pairs and self-loops", () => {
    const nodes = [imageNode("img1"), imageNode("img2"), groupNode("g"), promptNode("p")];
    expect(canConnect(nodes, [], { source: "img1", target: "img2" })).toBe(false);
    expect(canConnect(nodes, [], { source: "g", target: "img1" })).toBe(false);
    expect(canConnect(nodes, [], { source: "p", target: "p" })).toBe(false);
    expect(canConnect(nodes, [], { source: "g", target: "g" })).toBe(false);
    expect(canConnect(nodes, [], { source: "img1", target: "img1" })).toBe(false);
  });
});

describe("group chain counts", () => {
  it("merges nested groups transitively (two groups into one = sum of images and sizes)", () => {
    const imgA1 = imageNode("a1");
    const imgA2 = imageNode("a2");
    const imgB1 = imageNode("b1");
    const imgB2 = imageNode("b2");
    const imgB3 = imageNode("b3");
    const groupA = groupNode("gA");
    const groupB = groupNode("gB");
    const groupC = groupNode("gC");
    const nodes = [imgA1, imgA2, groupA, imgB1, imgB2, imgB3, groupB, groupC];
    const edges = [
      edge("a1", "gA"), edge("a2", "gA"),
      edge("b1", "gB"), edge("b2", "gB"), edge("b3", "gB"),
      edge("gA", "gC"), edge("gB", "gC"),
    ];

    const { groupCounts, groupSizes, groupDups } = computeCounts(nodes, edges);

    expect(groupCounts.get("gA")).toBe(2);
    expect(groupCounts.get("gB")).toBe(3);
    expect(groupCounts.get("gC")).toBe(5);
    expect(groupSizes.get("gC")).toBe(50); // 每张图 size=10
    expect(groupDups.get("gA")).toBe(0);
    expect(groupDups.get("gB")).toBe(0);
    expect(groupDups.get("gC")).toBe(0);
  });

  it("reports duplicates when the same image reaches a group via multiple paths", () => {
    const shared = imageNode("shared");
    const onlyA = imageNode("onlyA");
    const onlyB = imageNode("onlyB");
    const groupA = groupNode("gA");
    const groupB = groupNode("gB");
    const groupC = groupNode("gC");
    const nodes = [shared, onlyA, onlyB, groupA, groupB, groupC];
    // shared 同时进 gA 与 gB，两组合并进 gC：条目 4、唯一 3、重复 1
    const edges = [
      edge("shared", "gA"), edge("onlyA", "gA"),
      edge("shared", "gB"), edge("onlyB", "gB"),
      edge("gA", "gC"), edge("gB", "gC"),
    ];

    const { groupCounts, groupDups } = computeCounts(nodes, edges);

    // 去重口径：gC 计数为唯一张数（3），重复 1 张由 groupDups 报告
    expect(groupCounts.get("gC")).toBe(3);
    expect(groupDups.get("gC")).toBe(1);
    // 上游组各自内部无重复（shared 的重复只在合并后的 gC 暴露）
    expect(groupCounts.get("gA")).toBe(2);
    expect(groupDups.get("gA")).toBe(0);
    expect(groupCounts.get("gB")).toBe(2);
    expect(groupDups.get("gB")).toBe(0);
  });

  it("detects direct plus transitively duplicated images in one group", () => {
    const shared = imageNode("shared");
    const nodes = [shared, groupNode("gSub"), groupNode("gTop")];
    // shared 既直接进 gTop，又经 gSub 进 gTop：原始条目 2、去重后 1、重复 1
    const edges = [edge("shared", "gTop"), edge("shared", "gSub"), edge("gSub", "gTop")];

    const { groupCounts, groupDups } = computeCounts(nodes, edges);

    expect(groupCounts.get("gTop")).toBe(1);
    expect(groupDups.get("gTop")).toBe(1);
  });

  it("counts direct images plus nested group images in a mixed group", () => {
    const nodes = [imageNode("in1"), imageNode("in2"), groupNode("gSub"), imageNode("direct"), groupNode("gTop")];
    const edges = [edge("in1", "gSub"), edge("in2", "gSub"), edge("gSub", "gTop"), edge("direct", "gTop")];

    const { groupCounts } = computeCounts(nodes, edges);

    expect(groupCounts.get("gTop")).toBe(3);
  });

  it("cuts group cycles without double counting and without hanging", () => {
    const nodes = [imageNode("x1"), imageNode("x2"), groupNode("gA"), groupNode("gB"), groupNode("gC")];
    const edges = [
      edge("x1", "gA"), edge("x2", "gA"),
      edge("gA", "gB"), edge("gB", "gA"), // A ↔ B 成环
      edge("gB", "gC"),
    ];

    const { groupCounts, groupDups } = computeCounts(nodes, edges);

    expect(groupCounts.get("gA")).toBe(2);
    expect(groupCounts.get("gB")).toBe(2);
    expect(groupCounts.get("gC")).toBe(2);
    // 环剪枝不引入重复口径（x1/x2 每个组只计一次）
    expect(groupDups.get("gA")).toBe(0);
    expect(groupDups.get("gB")).toBe(0);
    expect(groupDups.get("gC")).toBe(0);
  });
});

describe("image reference tracing", () => {
  it("counts only prompts the image data ultimately flows to (group chains included)", () => {
    const a1 = imageNode("a1");
    const b1 = imageNode("b1");
    const c1 = imageNode("c1");
    const d1 = imageNode("d1");
    const gA = groupNode("gA");
    const gB = groupNode("gB");
    const gC = groupNode("gC");
    const gD = groupNode("gD");
    const nodes = [a1, b1, c1, d1, gA, gB, gC, gD, promptNode("p1"), promptNode("p2")];
    const edges = [
      edge("a1", "gA"), edge("gA", "p1"),                  // a1 经组到达 p1 → 引用
      edge("b1", "gB"),                                     // b1 只进组、组未接提示词 → 不引用
      edge("c1", "p1"),                                     // c1 直接引用 p1
      edge("d1", "gC"), edge("gC", "gD"), edge("gD", "p2"), // d1 经两级组链到达 p2 → 引用
    ];

    const { refCounts } = computeCounts(nodes, edges);

    expect(refCounts.get("a1")).toBe(1);
    expect(refCounts.get("b1")).toBe(0);
    expect(refCounts.get("c1")).toBe(1);
    expect(refCounts.get("d1")).toBe(1);
  });

  it("dedupes one prompt reached via multiple paths and ignores output edges", () => {
    const base = imageNode("base");
    const out = imageNode("out");
    const g = groupNode("g");
    const nodes = [base, out, g, promptNode("p1")];
    // base → p1 直接 + base → g → p1：同一提示词只算一次；p1 → out 是产出边，不影响引用
    const edges = [edge("base", "p1"), edge("base", "g"), edge("g", "p1"), edge("p1", "out")];

    const { refCounts } = computeCounts(nodes, edges);

    expect(refCounts.get("base")).toBe(1);
    expect(refCounts.get("out")).toBe(0);
  });

  it("counts two references when an image feeds two prompts", () => {
    const shared = imageNode("shared");
    const nodes = [shared, promptNode("p1"), promptNode("p2")];
    const edges = [edge("shared", "p1"), edge("shared", "p2")];

    const { refCounts } = computeCounts(nodes, edges);

    expect(refCounts.get("shared")).toBe(2);
  });

  it("traces through group cycles without hanging and without cross-flow", () => {
    const w1 = imageNode("w1");
    const gA = groupNode("gA");
    const gB = groupNode("gB");
    const nodes = [w1, gA, gB, promptNode("p1")];
    // w1 → gA；gA ↔ gB 成环；gB → p1：环路剪掉后仍能正确定位 p1
    const edges = [edge("w1", "gA"), edge("gA", "gB"), edge("gB", "gA"), edge("gB", "p1")];

    const { refCounts } = computeCounts(nodes, edges);

    expect(refCounts.get("w1")).toBe(1);
  });
});

describe("animation class helpers", () => {
  it("strips runtime animation classes from node className on load", () => {
    const node = { ...imageNode("a"), className: "node-enter enter-delay-2 node-related" } as WorkflowNode;
    const result = workflowToCanvas([node], [], []);
    expect(indexed(result.nodes, 0).className).toBe("node-related");
  });

  it("removes the exit marker so a restored workflow never lingers in fade-out", () => {
    const node = { ...imageNode("b"), className: "node-exiting" } as WorkflowNode;
    const result = workflowToCanvas([node], [], []);
    expect(indexed(result.nodes, 0).className).toBeUndefined();
  });

  it("extracts only animation classes for highlight merging", () => {
    expect(extractAnimClasses("node-enter enter-delay-1 node-related")).toBe("node-enter enter-delay-1");
    expect(extractAnimClasses("node-related")).toBe("");
    expect(extractAnimClasses(undefined)).toBe("");
  });

  it("adds staggered enter classes by index", () => {
    const first = withEnterAnim(imageNode("a"), 0);
    const second = withEnterAnim(imageNode("b"), 2);
    expect(first.className).toContain("node-enter");
    expect(first.className).toContain("enter-delay-1");
    expect(second.className).toContain("enter-delay-3");
  });
});

describe("create position stagger", () => {
  const center = { x: 659, y: 334.5 };

  it("uses the viewport center when there is no previous position", () => {
    expect(staggerCreatePosition(center, null)).toEqual({ position: center, next: center });
  });

  it("stacks +30px when the viewport barely moved (consecutive creates)", () => {
    const first = staggerCreatePosition(center, null);
    const second = staggerCreatePosition(center, first.next);
    expect(second.position).toEqual({ x: center.x + 30, y: center.y + 30 });
    const third = staggerCreatePosition(center, second.next);
    expect(third.position).toEqual({ x: center.x + 60, y: center.y + 60 });
  });

  it("returns to the center after the viewport moved far away", () => {
    const last = { x: center.x + 30, y: center.y + 30 };
    const farCenter = { x: center.x + 3000, y: center.y - 2000 };
    expect(staggerCreatePosition(farCenter, last)).toEqual({ position: farCenter, next: farCenter });
  });

  it("never drifts with node count (no modulo-of-total cascade)", () => {
    // 模拟画布已有 23 个节点时创建：落点仍以中心为基准，而不是 150px 偏移
    const last = { x: center.x + 30, y: center.y + 30 };
    const result = staggerCreatePosition(center, last);
    expect(Math.abs(result.position.x - center.x)).toBeLessThanOrEqual(60);
    expect(Math.abs(result.position.y - center.y)).toBeLessThanOrEqual(60);
  });
});

describe("image file detection", () => {
  const file = (name: string, type: string) => new File([""], name, { type });

  it("accepts files with an image MIME type", () => {
    expect(isImageFile(file("photo.png", "image/png"))).toBe(true);
    expect(isImageFile(file("photo", "image/webp"))).toBe(true);
  });

  it("falls back to the extension when the MIME type is missing", () => {
    // 部分系统拖拽/粘贴不携带 MIME 类型，此时按扩展名兜底识别
    expect(isImageFile(file("photo.JPG", ""))).toBe(true);
    expect(isImageFile(file("photo.jpeg", ""))).toBe(true);
    expect(isImageFile(file("photo.webp", ""))).toBe(true);
    expect(isImageFile(file("photo.gif", ""))).toBe(true);
    expect(isImageFile(file("photo.bmp", ""))).toBe(true);
  });

  it("rejects non-image files even with a MIME-like type", () => {
    expect(isImageFile(file("notes.txt", "text/plain"))).toBe(false);
    expect(isImageFile(file("notes.txt", ""))).toBe(false);
    expect(isImageFile(file("archive.png.zip", "application/zip"))).toBe(false);
  });
});

describe("canvas node builders", () => {
  it("builds a prompt node with the given defaults at the position", () => {
    const node = buildPromptNode(
      { x: 10, y: 20 },
      { size: "1024x1024", quality: "high", outputDir: "output" },
    );
    expect(node.type).toBe("prompt");
    expect(node.position).toEqual({ x: 10, y: 20 });
    expect(node.data).toMatchObject({
      prompt: "",
      size: "1024x1024",
      quality: "high",
      outputDir: "output",
      status: "idle",
    });
  });

  it("builds a group node at the position with default counters", () => {
    const node = buildGroupNode({ x: 30, y: 40 });
    expect(node.type).toBe("group");
    expect(node.position).toEqual({ x: 30, y: 40 });
    expect(node.data).toMatchObject({ name: "图片组", imageCount: 0, totalSize: 0 });
  });
});

describe("mergeSubmissionGraph", () => {
  const subPrompt: WorkflowNode = {
    id: "prompt-sub-1", type: "prompt", position: { x: 0, y: 0 },
    data: { prompt: "p", size: "s", quality: "q", outputDir: "o", status: "idle" },
  } as WorkflowNode;
  const subImg: WorkflowNode = {
    id: "img-aaa", type: "image", position: { x: 0, y: 0 },
    data: { registryId: "aaa", name: "aaa.png", size: 1, ext: "png", refCount: 0 },
  } as WorkflowNode;
  const subResult: WorkflowNode = {
    id: "img-bbb", type: "image", position: { x: 0, y: 0 },
    data: { registryId: "bbb", name: "bbb.png", size: 1, ext: "png", refCount: 0 },
  } as WorkflowNode;
  const subEdges: WorkflowEdge[] = [
    { id: "prompt-sub-1->img-bbb", source: "prompt-sub-1", target: "img-bbb" },
  ];

  it("appends new nodes, maps edges, and reuses image nodes already present", () => {
    // 画布已存在同 registryId 的图片节点 bbb
    const existingImg: WorkflowNode = {
      id: "img-bbb", type: "image", position: { x: 0, y: 0 },
      data: { registryId: "bbb", name: "old.png", size: 1, ext: "png", refCount: 0 },
    } as WorkflowNode;
    const existingEdges: WorkflowEdge[] = [];
    const out = mergeSubmissionGraph([subPrompt, subImg, subResult], subEdges, [existingImg], existingEdges, "sub-1");
    // 已有 bbb 复用，不新增；新增 prompt + aaa
    const imageIds = out.nodes.filter((n) => n.type === "image").map((n) => n.data.registryId);
    expect(imageIds).toContain("bbb");
    expect(imageIds).toContain("aaa");
    const bbbCount = out.nodes.filter((n) => n.type === "image" && n.data.registryId === "bbb").length;
    expect(bbbCount).toBe(1); // 去重
    // prompt 用命名空间 id
    const promptIds = out.nodes.filter((n) => n.type === "prompt").map((n) => n.id);
    expect(promptIds).toEqual(["prompt-sub-1-import-sub-1"]);
    // 边映射到复用/新增节点，源为实际落点
    const edge = out.edges.find((e) => e.target === "img-bbb")!;
    expect(edge).toBeTruthy();
    expect(edge.source).toBe("prompt-sub-1-import-sub-1");
  });
});

describe("collectPromptRefImages", () => {
  // 提示词 p 的入边：img-a、img-b、img-c（图片组 g 里套 img-c，验证组递归仍算候选池）
  const nodes = [promptNode("p"), imageNode("img-a"), imageNode("img-b"), imageNode("img-c"), groupNode("g")];
  const edges = [edge("img-a", "p"), edge("img-b", "p"), edge("img-c", "g"), edge("g", "p")];

  function names(list: WorkflowNode[]): string[] {
    return list.map((n) => (n.type === "image" ? n.data.name : "?"));
  }

  it("mode all: a prompt without any reference keeps the old collect-all behaviour", () => {
    const result = collectPromptRefImages(nodes, edges, "p", "product photo, studio light");
    expect(result.mode).toBe("all");
    expect(result.unknown).toEqual([]);
    expect(names(result.images).sort()).toEqual(["img-a.png", "img-b.png", "img-c.png"]);
  });

  it("mode all: an email address alone does not switch the run to explicit", () => {
    const result = collectPromptRefImages(nodes, edges, "p", "contact user@example.com");
    expect(result.mode).toBe("all");
    expect(result.images).toHaveLength(3);
  });

  it("mode all: an escaped trigger does not switch the run to explicit", () => {
    const result = collectPromptRefImages(nodes, edges, "p", "@@img-a.png is literal");
    expect(result.mode).toBe("all");
    expect(result.images).toHaveLength(3);
  });

  it("mode explicit: only the referenced images are kept", () => {
    const result = collectPromptRefImages(nodes, edges, "p", "use @img-b.png only");
    expect(result.mode).toBe("explicit");
    expect(result.unknown).toEqual([]);
    expect(names(result.images)).toEqual(["img-b.png"]);
  });

  it("mode explicit: keeps reference order and dedupes repeats", () => {
    const result = collectPromptRefImages(nodes, edges, "p", "@img-b.png then @img-a.png then @img-b.png");
    expect(result.mode).toBe("explicit");
    expect(names(result.images)).toEqual(["img-b.png", "img-a.png"]);
  });

  it("mode explicit: images reached through a group edge are referenceable", () => {
    const result = collectPromptRefImages(nodes, edges, "p", "@{img-c.png}");
    expect(result.mode).toBe("explicit");
    expect(names(result.images)).toEqual(["img-c.png"]);
  });

  it("mode invalid: an unknown name is reported and the matched ones are still returned", () => {
    const result = collectPromptRefImages(nodes, edges, "p", "@img-a.png and @nope.png");
    expect(result.mode).toBe("invalid");
    expect(result.unknown).toEqual(["nope.png"]);
    expect(names(result.images)).toEqual(["img-a.png"]);
  });

  it("mode invalid: every reference unknown yields no images instead of falling back to all", () => {
    const result = collectPromptRefImages(nodes, edges, "p", "@x.png @y.png");
    expect(result.mode).toBe("invalid");
    expect(result.unknown).toEqual(["x.png", "y.png"]);
    expect(result.images).toEqual([]);
  });

  it("mode invalid: an image not wired to the prompt is not referenceable", () => {
    const detached = [...nodes, imageNode("img-z")];
    const result = collectPromptRefImages(detached, edges, "p", "@img-z.png");
    expect(result.mode).toBe("invalid");
    expect(result.unknown).toEqual(["img-z.png"]);
    expect(result.images).toEqual([]);
  });

  it("mode all: a prompt with no incoming edges stays empty (unchanged legacy path)", () => {
    const result = collectPromptRefImages([promptNode("p")], [], "p", "plain");
    expect(result.mode).toBe("all");
    expect(result.images).toEqual([]);
  });
});

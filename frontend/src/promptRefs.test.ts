import { describe, expect, it } from "vitest";

import {
  PROMPT_REF_TRIGGER,
  parsePromptRefs,
  promptRefInsertion,
  resolvePromptRefs,
  stripPromptRefs,
} from "./promptRefs";

/** noUncheckedIndexedAccess 守卫：越界即失败，不把断言弱化为可选链 */
function indexed<T>(items: ArrayLike<T>, at: number): T {
  const item = items[at];
  if (item === undefined) throw new Error(`indexed: 长度 ${items.length} 越界下标 ${at}`);
  return item;
}

describe("parsePromptRefs — 简单形式与花括号形式", () => {
  it("parses a simple reference and records its span", () => {
    const tokens = parsePromptRefs("use @cat.png please");
    expect(tokens).toHaveLength(1);
    expect(indexed(tokens, 0)).toEqual({ name: "cat.png", start: 4, end: 12 });
  });

  it("parses a braced reference containing spaces", () => {
    const tokens = parsePromptRefs("use @{my cat.png} please");
    expect(tokens).toHaveLength(1);
    expect(indexed(tokens, 0)).toEqual({ name: "my cat.png", start: 4, end: 17 });
  });

  it("stops the simple form at the first space (so spaces need braces)", () => {
    const tokens = parsePromptRefs("@my cat.png");
    expect(tokens).toHaveLength(1);
    expect(indexed(tokens, 0).name).toBe("my");
  });

  it("parses Chinese names", () => {
    const tokens = parsePromptRefs("用 @猫猫.png 和 @{黑白 小猫}");
    expect(tokens.map((t) => t.name)).toEqual(["猫猫.png", "黑白 小猫"]);
  });

  it("parses names with dots and dashes", () => {
    const tokens = parsePromptRefs("@my-image.v2.png");
    expect(indexed(tokens, 0).name).toBe("my-image.v2.png");
  });

  it("ignores an unclosed brace instead of inventing a token", () => {
    expect(parsePromptRefs("@{cat.png")).toEqual([]);
    expect(parsePromptRefs("keep going @{")).toEqual([]);
  });

  it("ignores empty braces", () => {
    expect(parsePromptRefs("@{}")).toEqual([]);
    expect(parsePromptRefs("@{   }")).toEqual([]);
  });
});

describe("parsePromptRefs — 转义与边界", () => {
  it("treats a double trigger as a literal escape, not a reference", () => {
    expect(parsePromptRefs("@@cat.png")).toEqual([]);
    const tokens = parsePromptRefs("@@cat.png and @dog.png");
    expect(tokens.map((t) => t.name)).toEqual(["dog.png"]);
  });

  it("does not treat an email address as a reference", () => {
    expect(parsePromptRefs("mail me at user@example.com")).toEqual([]);
    // 只挡「紧贴字母数字」的 @；同一个邮箱后面另起的引用仍然有效
    const tokens = parsePromptRefs("user@example.com 用 @cat.png");
    expect(tokens.map((t) => t.name)).toEqual(["cat.png"]);
  });

  it("accepts a reference at the start of a line", () => {
    const tokens = parsePromptRefs("@cat.png\n@dog.png");
    expect(tokens.map((t) => t.name)).toEqual(["cat.png", "dog.png"]);
  });

  it("accepts a reference after whitespace and punctuation", () => {
    for (const text of ["a @cat.png", "a\t@cat.png", "a\n@cat.png", "(@cat.png)", "，@cat.png", "a-@cat.png"]) {
      expect(parsePromptRefs(text).map((t) => t.name), text).toEqual(["cat.png"]);
    }
  });

  it("rejects a reference glued to a letter or digit", () => {
    for (const text of ["cat@cat.png", "1@cat.png", "猫@cat.png"]) {
      expect(parsePromptRefs(text), text).toEqual([]);
    }
  });

  it("returns nothing for empty text", () => {
    expect(parsePromptRefs("")).toEqual([]);
    expect(parsePromptRefs("   ")).toEqual([]);
  });

  it("ignores a bare trigger with no name", () => {
    expect(parsePromptRefs("@")).toEqual([]);
    expect(parsePromptRefs("@ hello")).toEqual([]);
    expect(parsePromptRefs("a @ b")).toEqual([]);
  });

  it("records multiple references in appearance order", () => {
    const tokens = parsePromptRefs("@b.png then @a.png then @{c c.png}");
    expect(tokens.map((t) => t.name)).toEqual(["b.png", "a.png", "c c.png"]);
  });

  it("exposes the trigger constant", () => {
    expect(PROMPT_REF_TRIGGER).toBe("@");
  });
});

describe("resolvePromptRefs", () => {
  const candidates = [
    { id: "img-a", name: "a.png" },
    { id: "img-b", name: "b.png" },
    { id: "img-c", name: "c.png" },
  ];

  it("returns mode all when there is no reference at all", () => {
    expect(resolvePromptRefs("a plain prompt", candidates)).toEqual({
      mode: "all",
      ids: [],
      unknown: [],
    });
  });

  it("returns mode all for text whose only trigger is an email", () => {
    expect(resolvePromptRefs("contact user@example.com", candidates).mode).toBe("all");
  });

  it("returns explicit ids deduped in appearance order", () => {
    const result = resolvePromptRefs("@b.png and @a.png and @b.png", candidates);
    expect(result).toEqual({ mode: "explicit", ids: ["img-b", "img-a"], unknown: [] });
  });

  it("keeps appearance order for three distinct references", () => {
    const result = resolvePromptRefs("@c.png @a.png @b.png", candidates);
    expect(result.mode).toBe("explicit");
    expect(result.ids).toEqual(["img-c", "img-a", "img-b"]);
  });

  it("prefers the longest matching candidate name", () => {
    const both = [
      { id: "short", name: "cat.png" },
      { id: "long", name: "cat.png.bak" },
    ];
    expect(resolvePromptRefs("@cat.png.bak", both).ids).toEqual(["long"]);
    expect(resolvePromptRefs("@cat.png", both).ids).toEqual(["short"]);
  });

  it("returns invalid with the unknown names when some references miss", () => {
    const result = resolvePromptRefs("@a.png and @nope.png", candidates);
    expect(result).toEqual({ mode: "invalid", ids: ["img-a"], unknown: ["nope.png"] });
  });

  it("returns invalid when every reference misses (never silently falls back)", () => {
    const result = resolvePromptRefs("@x.png @y.png", candidates);
    expect(result).toEqual({ mode: "invalid", ids: [], unknown: ["x.png", "y.png"] });
  });

  it("matches names case-sensitively", () => {
    const mixed = [{ id: "img-upper", name: "Cat.png" }];
    expect(resolvePromptRefs("@Cat.png", mixed).mode).toBe("explicit");
    expect(resolvePromptRefs("@cat.png", mixed)).toEqual({
      mode: "invalid",
      ids: [],
      unknown: ["cat.png"],
    });
  });

  it("trims and folds whitespace on both sides before comparing", () => {
    const spaced = [{ id: "img-spaced", name: "  my  cat.png " }];
    expect(resolvePromptRefs("@{my cat.png}", spaced).ids).toEqual(["img-spaced"]);
    expect(resolvePromptRefs("@{  my   cat.png  }", spaced).ids).toEqual(["img-spaced"]);
  });

  it("maps two same-named candidates to both ids instead of dropping one", () => {
    const dup = [
      { id: "img-1", name: "same.png" },
      { id: "img-2", name: "same.png" },
    ];
    expect(resolvePromptRefs("@same.png", dup).ids).toEqual(["img-1", "img-2"]);
  });

  it("resolves against an empty candidate pool as invalid (not all)", () => {
    expect(resolvePromptRefs("@cat.png", [])).toEqual({
      mode: "invalid",
      ids: [],
      unknown: ["cat.png"],
    });
  });
});

describe("promptRefInsertion", () => {
  it("uses the simple form for names the simple form can match", () => {
    expect(promptRefInsertion("cat.png")).toBe("@cat.png");
    expect(promptRefInsertion("猫猫-2.v3.png")).toBe("@猫猫-2.v3.png");
  });

  it("uses the braced form for names with spaces or other characters", () => {
    expect(promptRefInsertion("my cat.png")).toBe("@{my cat.png}");
    expect(promptRefInsertion("a b/c.png")).toBe("@{a b/c.png}");
    expect(promptRefInsertion("  padded.png  ")).toBe("@padded.png");
  });
});

describe("stripPromptRefs", () => {
  it("drops the braces from a braced reference", () => {
    expect(stripPromptRefs("use @{my cat.png} please")).toBe("use @my cat.png please");
  });

  it("restores a double trigger to a single one", () => {
    expect(stripPromptRefs("@@cat.png")).toBe("@cat.png");
    expect(stripPromptRefs("a @@b and @@c")).toBe("a @b and @c");
  });

  it("leaves a simple reference untouched", () => {
    expect(stripPromptRefs("use @cat.png please")).toBe("use @cat.png please");
  });

  it("leaves text without references untouched", () => {
    expect(stripPromptRefs("")).toBe("");
    expect(stripPromptRefs("plain prompt")).toBe("plain prompt");
    expect(stripPromptRefs("user@example.com")).toBe("user@example.com");
    expect(stripPromptRefs("a @ b")).toBe("a @ b");
  });

  it("handles escapes and references in the same text", () => {
    expect(stripPromptRefs("@@x and @{a b} and @c.png")).toBe("@x and @a b and @c.png");
  });
});

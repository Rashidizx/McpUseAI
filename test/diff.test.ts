import { describe, expect, it } from "vitest";

import { diffLines, fileDiff, splitLines } from "../src/agent/diff.js";

const apply = (lines: ReturnType<typeof diffLines>) => ({
  before: lines.filter((l) => l.type !== "+").map((l) => l.text),
  after: lines.filter((l) => l.type !== "-").map((l) => l.text),
});

describe("diffLines", () => {
  it("reproduces both sides exactly", () => {
    const a = ["a", "b", "c", "d", "e", "f"];
    const b = ["a", "x", "c", "d", "f", "g"];
    expect(apply(diffLines(a, b))).toEqual({ before: a, after: b });
  });

  it("finds the minimal change", () => {
    const lines = diffLines(["a", "b", "c"], ["a", "B", "c"]);
    expect(lines.map((l) => l.type + l.text)).toEqual([" a", "-b", "+B", " c"]);
  });

  it("numbers lines on both sides", () => {
    const lines = diffLines(["a", "b"], ["z", "a", "b"]);
    expect(lines[0]).toMatchObject({ type: "+", text: "z", new: 1 });
    expect(lines[1]).toMatchObject({ type: " ", old: 1, new: 2 });
  });

  it("handles random edits", () => {
    for (let round = 0; round < 50; round++) {
      const a = Array.from({ length: 30 }, (_, i) => `l${i % 7}`);
      const b = a.filter(() => Math.random() > 0.3).concat(["new"]);
      expect(apply(diffLines(a, b))).toEqual({ before: a, after: b });
    }
  });
});

describe("fileDiff", () => {
  it("counts added and removed lines, ignoring line endings", () => {
    const diff = fileDiff("a.ts", "one\r\ntwo\r\nthree\r\n", "one\nTWO\nthree\nfour\n");
    expect(diff).toMatchObject({ added: 2, removed: 1, created: false });
  });

  it("marks a new file", () => {
    expect(fileDiff("n.txt", null, "x\ny\n")).toMatchObject({ added: 2, removed: 0, created: true });
  });

  it("keeps three lines of context and splits distant changes into hunks", () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const after = before.map((l, i) => (i === 5 || i === 30 ? `${l} changed` : l));
    const diff = fileDiff("f", before.join("\n"), after.join("\n"));
    expect(diff.hunks).toHaveLength(2);
    expect(diff.hunks[0]!.lines.filter((l) => l.type === " ")).toHaveLength(6);
    expect(diff.hunks[1]!.oldStart).toBe(28);
  });

  it("splitLines treats a final newline as the end, not an empty line", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("")).toEqual([]);
  });
});

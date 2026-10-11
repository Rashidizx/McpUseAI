import { describe, expect, it } from "vitest";

import {
  RESULTS_HEADER,
  buildPrimer,
  fencedBlocks,
  formatParseErrors,
  formatResults,
  parseCalls,
  renderData,
} from "../src/agent/protocol.js";

const known = new Set(["fs_read", "fs_write"]);

describe("parseCalls", () => {
  it("reads a zx block", () => {
    const text = 'Let me look.\n```zx\n{"tool":"fs_read","arguments":{"file_path":"a.txt"}}\n```';
    expect(parseCalls(text, known)).toEqual({ calls: [{ tool: "fs_read", arguments: { file_path: "a.txt" } }], errors: [] });
  });

  it("reads several blocks and arrays, in order", () => {
    const text = [
      "```zx",
      '[{"tool":"fs_read","arguments":{"file_path":"a"}},{"tool":"fs_read","arguments":{"file_path":"b"}}]',
      "```",
      "```",
      '{"tool":"fs_write","arguments":{"file_path":"c","content":"x"}}',
      "```",
    ].join("\n");
    expect(parseCalls(text, known).calls.map((c) => c.arguments.file_path)).toEqual(["a", "b", "c"]);
  });

  it("accepts untagged and json blocks, because some sites drop the tag", () => {
    expect(parseCalls('```json\n{"tool":"fs_read","arguments":{}}\n```', known).calls).toHaveLength(1);
    expect(parseCalls('```\n{"tool":"fs_read"}\n```', known).calls).toEqual([{ tool: "fs_read", arguments: {} }]);
  });

  it("never runs code shown in another language", () => {
    expect(parseCalls('```js\n{"tool":"fs_read","arguments":{}}\n```', known).calls).toEqual([]);
  });

  it("treats a reply with no block as the final answer", () => {
    expect(parseCalls('The file says {"tool":"fs_read"} in prose.', known)).toEqual({ calls: [], errors: [] });
  });

  it("reports broken zx blocks but stays quiet about other blocks", () => {
    expect(parseCalls("```zx\n{not json}\n```", known).errors[0]).toMatch(/not valid JSON/);
    expect(parseCalls('```zx\n{"tool":"rm_rf"}\n```', known).errors[0]).toMatch(/unknown tool "rm_rf"/);
    expect(parseCalls("```json\n{not json}\n```", known).errors).toEqual([]);
    expect(parseCalls('```\n{"tool":"rm_rf"}\n```', known)).toEqual({ calls: [], errors: [] });
  });

  it("repairs raw line breaks inside strings and trailing commas", () => {
    const text = '```zx\n{"tool":"fs_write","arguments":{"file_path":"a","content":"line 1\nline\t2 \\"q\\"\n",},}\n```';
    expect(parseCalls(text, known).calls).toEqual([
      { tool: "fs_write", arguments: { file_path: "a", content: 'line 1\nline\t2 "q"\n' } },
    ]);
  });

  it("takes fs_write content from the next code block, verbatim", () => {
    const text = [
      "Here it is.",
      "```zx",
      '{"tool":"fs_write","arguments":{"file_path":"index.html"}}',
      "```",
      "html",
      "Copy",
      "```html",
      '<p class="x">"quoted" \\ back</p>',
      "```",
    ].join("\n");
    expect(parseCalls(text, known).calls).toEqual([
      { tool: "fs_write", arguments: { file_path: "index.html", content: '<p class="x">"quoted" \\ back</p>\n' } },
    ]);
  });

  it("sends an fs_write with nothing to write back to the model with instructions", () => {
    const text = ["```zx", '{"tool":"fs_write","arguments":{"file_path":"todo.html"}}', "```"].join("\n");
    const { calls, errors } = parseCalls(text, known);
    expect(calls).toEqual([]);
    expect(errors[0]).toMatch(/todo\.html has no content/);
  });

  it("takes a content block even when the site labelled it zx by mistake", () => {
    const text = ["```zx", '{"tool":"fs_write","arguments":{"file_path":"a.html"}}', "```", "```zx", "<!doctype html>", "```"].join("\n");
    expect(parseCalls(text, known)).toEqual({
      calls: [{ tool: "fs_write", arguments: { file_path: "a.html", content: "<!doctype html>\n" } }],
      errors: [],
    });
  });

  it("does not take the next block when content is given, or when it is another call", () => {
    const text = [
      "```zx",
      '{"tool":"fs_write","arguments":{"file_path":"a","content":"x"}}',
      "```",
      "```zx",
      '{"tool":"fs_read","arguments":{"file_path":"a"}}',
      "```",
    ].join("\n");
    expect(parseCalls(text, known).calls.map((c) => c.tool)).toEqual(["fs_write", "fs_read"]);
  });

  it("does not end a block at a shorter fence inside it", () => {
    const blocks = fencedBlocks("````zx\nline\n```\nstill inside\n````\nafter");
    expect(blocks).toEqual([{ lang: "zx", body: "line\n```\nstill inside", closed: true }]);
  });

  it("marks a block the reply ended inside", () => {
    expect(fencedBlocks("```js\nhalf")).toEqual([{ lang: "js", body: "half", closed: false }]);
  });

  it("never writes a file from a cut-off content block", () => {
    const text = '```zx\n{"tool":"fs_write","arguments":{"file_path":"a.txt"}}\n```\n```\nhalf a fi';
    const { calls, errors } = parseCalls(text, new Set(["fs_write"]));
    expect(calls).toEqual([]);
    expect(errors.join()).toMatch(/cut off/);
  });

  it("ignores calls after results the model made up", () => {
    const text = '```zx\n{"tool":"fs_read","arguments":{}}\n```\nZX RESULTS\n```zx\n{"tool":"fs_read","arguments":{}}\n```';
    expect(parseCalls(text, new Set(["fs_read"])).calls).toHaveLength(1);
  });
});

describe("formatResults", () => {
  it("starts with the header and labels each result", () => {
    const text = formatResults(
      [
        { tool: "fs_read", summary: "read a", ok: true, text: "hello" },
        { tool: "fs_write", summary: "write b", ok: false, text: "APPROVAL_DENIED: no" },
      ],
      30_000,
    );
    expect(text.startsWith(RESULTS_HEADER)).toBe(true);
    expect(text).toContain("### 1. fs_read: read a (ok)");
    expect(text).toContain("### 2. fs_write: write b (error)");
  });

  it("cuts long output and says so", () => {
    const text = formatResults([{ tool: "fs_read", summary: "read big", ok: true, text: "x".repeat(50_000) }], 5000);
    expect(text.length).toBeLessThan(6000);
    expect(text).toMatch(/more characters cut/);
  });

  it("uses a longer fence when the output contains backticks", () => {
    const text = formatResults([{ tool: "fs_read", summary: "r", ok: true, text: "a\n```\nb" }], 30_000);
    expect(text).toContain("````\na\n```\nb\n````");
  });
});

describe("renderData", () => {
  it("puts file text raw after its metadata", () => {
    expect(renderData({ text: "body", total_lines: 1 }, "s")).toBe('{"total_lines":1}\nbody');
  });
  it("shows exec output streams", () => {
    expect(renderData({ exit_code: 0, stdout: "out", stderr: "" }, "s")).toContain("--- stdout ---\nout");
  });
  it("falls back to the summary", () => {
    expect(renderData(undefined, "done")).toBe("done");
  });
});

describe("primer", () => {
  it("lists every tool and ends ready for the request", () => {
    const primer = buildPrimer(
      [
        { name: "fs_read", opClass: "read", description: "{file_path} Read." },
        { name: "exec", opClass: "exec", description: "{command, args} Run." },
      ],
      "project",
    );
    expect(primer).toContain("- fs_read [read] {file_path} Read.");
    expect(primer).toContain("- exec [exec]");
    expect(primer).toContain("Workspace folder: project.");
    expect(primer.endsWith("USER REQUEST:\n")).toBe(true);
  });

  it("parse errors are sent as a results message", () => {
    expect(formatParseErrors(["bad"]).startsWith(RESULTS_HEADER)).toBe(true);
  });
});

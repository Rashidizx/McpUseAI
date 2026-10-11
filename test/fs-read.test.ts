import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createFsRead } from "../src/tools/fs-read.js";
import { PathGuard } from "../src/core/path-guard.js";
import { makeTempWorkspace, cleanupTempDirs } from "./helpers.js";

afterEach(cleanupTempDirs);

function workspaceWith(file: string, content: string | Buffer): {
  guard: PathGuard;
  read: ReturnType<typeof createFsRead>;
  /** Reads `result.data` as the caller's chosen shape. */
  data: <T>(result: { data?: unknown }) => T;
} {
  const root = makeTempWorkspace();
  writeFileSync(join(root, file), content);
  const guard = new PathGuard(root);
  const read = createFsRead(guard);
  return { guard, read, data: <T,>(r: { data?: unknown }) => r.data as T };
}

describe("fs_read — content", () => {
  it("reads a file and returns its text", async () => {
    const { read, data } = workspaceWith("a.txt", "one\ntwo\n");
    const result = await read.run({ file_path: "a.txt" });
    expect(data<{ text: string; total_lines: number }>(result)).toMatchObject({
      text: "one\ntwo\n",
      total_lines: 2,
    });
  });

  it("reads an empty file without inventing a line", async () => {
    const { read, data } = workspaceWith("empty.txt", "");
    const result = await read.run({ file_path: "empty.txt" });
    expect(data<{ text: string; total_lines: number }>(result)).toMatchObject({
      text: "",
      total_lines: 0,
    });
  });

  it("does not count a trailing newline as an extra line", async () => {
    // The failure this catches: a naive split makes "a\nb\n" three lines, which
    // then gets written back as a blank final line.
    const { read, data } = workspaceWith("a.txt", "a\nb\n");
    const result = await read.run({ file_path: "a.txt" });
    expect(data<{ total_lines: number }>(result).total_lines).toBe(2);
  });

  it("keeps a genuine trailing blank line", async () => {
    const { read, data } = workspaceWith("a.txt", "a\nb\n\n");
    const result = await read.run({ file_path: "a.txt" });
    expect(data<{ total_lines: number; text: string }>(result)).toMatchObject({
      total_lines: 3,
      text: "a\nb\n\n",
    });
  });

  it("reads a file with no trailing newline as-is", async () => {
    const { read, data } = workspaceWith("a.txt", "only line");
    const result = await read.run({ file_path: "a.txt" });
    expect(data<{ text: string; total_lines: number }>(result)).toMatchObject({
      text: "only line",
      total_lines: 1,
    });
  });

  it("preserves CRLF and reports it", async () => {
    const { read, data } = workspaceWith("win.txt", "a\r\nb\r\n");
    const result = await read.run({ file_path: "win.txt" });
    expect(data<{ eol: string; text: string }>(result)).toMatchObject({
      eol: "\r\n",
      text: "a\r\nb\r\n",
    });
  });

  it("reports and strips a BOM", async () => {
    const { read, data } = workspaceWith(
      "bom.txt",
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hi\n", "utf8")]),
    );
    const result = await read.run({ file_path: "bom.txt" });
    expect(data<{ had_bom: boolean; text: string }>(result)).toMatchObject({
      had_bom: true,
      text: "hi\n",
    });
  });

  it("reads non-ASCII content without mangling it", async () => {
    const { read, data } = workspaceWith("fa.txt", "سلام\nदुनिया\n");
    const result = await read.run({ file_path: "fa.txt" });
    expect(data<{ text: string }>(result).text).toBe("سلام\nदुनिया\n");
  });
});

describe("fs_read — pagination", () => {
  const five = "l1\nl2\nl3\nl4\nl5\n";

  it("pages with start_line and line_count", async () => {
    const { read, data } = workspaceWith("a.txt", five);
    const result = await read.run({ file_path: "a.txt", start_line: 2, line_count: 2 });
    expect(data<{ text: string; total_lines: number }>(result)).toMatchObject({
      text: "l2\nl3\n",
      total_lines: 5,
    });
  });

  it("reports where the page started and how much came back", async () => {
    const { read, data } = workspaceWith("a.txt", five);
    const result = await read.run({ file_path: "a.txt", start_line: 4, line_count: 1 });
    expect(data<Record<string, number | boolean>>(result)).toMatchObject({
      start_line: 4,
      returned_lines: 1,
      total_lines: 5,
      has_more: true,
    });
  });

  it("sets has_more false on the final page", async () => {
    const { read, data } = workspaceWith("a.txt", five);
    const result = await read.run({ file_path: "a.txt", start_line: 5, line_count: 1 });
    expect(data<{ has_more: boolean; text: string }>(result)).toMatchObject({
      has_more: false,
      text: "l5\n",
    });
  });

  it("returns an empty page past the end rather than throwing", async () => {
    const { read, data } = workspaceWith("a.txt", five);
    const result = await read.run({ file_path: "a.txt", start_line: 99 });
    expect(data<{ returned_lines: number }>(result).returned_lines).toBe(0);
  });

  it("preserves CRLF inside a page", async () => {
    const { read, data } = workspaceWith("a.txt", "l1\r\nl2\r\nl3\r\n");
    const result = await read.run({ file_path: "a.txt", start_line: 2, line_count: 1 });
    expect(data<{ text: string }>(result).text).toBe("l2\r\n");
  });

  it("never returns more lines than the file has", async () => {
    const { read, data } = workspaceWith("a.txt", "only\n");
    const result = await read.run({ file_path: "a.txt", line_count: 5000 });
    expect(data<{ returned_lines: number; total_lines: number }>(result)).toMatchObject({
      returned_lines: 1,
      total_lines: 1,
    });
  });
});

describe("fs_read — sandbox and errors", () => {
  it("refuses a path that escapes the workspace", async () => {
    const { read } = workspaceWith("a.txt", "x\n");
    await expect(read.run({ file_path: "../../outside.txt" })).rejects.toThrow(
      /traversal/i,
    );
  });

  it("reports a missing file as FILE_NOT_FOUND", async () => {
    const { read } = workspaceWith("a.txt", "x\n");
    await expect(read.run({ file_path: "missing.txt" })).rejects.toThrow(
      /no such file/,
    );
  });

  it("reports a directory as NOT_A_DIRECTORY (F2-7)", async () => {
    const root = makeTempWorkspace();
    mkdirSync(join(root, "sub"));
    const read = createFsRead(new PathGuard(root));
    // Reading a directory is platform-dependent: some return EISDIR, macOS
    // returns its listing as file content. Refusing it keeps the behaviour
    // identical everywhere.
    await expect(read.run({ file_path: "sub" })).rejects.toThrow(/is a directory/);
  });

  it("refuses a non-string file_path", () => {
    const { read } = workspaceWith("a.txt", "x\n");
    expect(() => read.parseArgs({ file_path: 42 })).toThrow(/file_path/);
  });

  it("refuses a non-integer start_line instead of ignoring it", () => {
    // Silently ignoring a bad page number means the model believes it read the
    // lines it asked for.
    const { read } = workspaceWith("a.txt", "x\n");
    expect(() => read.parseArgs({ file_path: "a.txt", start_line: "2" })).toThrow(
      /start_line/,
    );
  });

  it("refuses a zero or negative line_count", () => {
    const { read } = workspaceWith("a.txt", "x\n");
    expect(() => read.parseArgs({ file_path: "a.txt", line_count: 0 })).toThrow(
      /line_count/,
    );
  });

  it("refuses arguments that are not an object", () => {
    const { read } = workspaceWith("a.txt", "x\n");
    expect(() => read.parseArgs("a.txt")).toThrow(/object of arguments/);
  });
});

describe("fs_read — classification", () => {
  it("is a read, so it never needs approval", () => {
    const root = makeTempWorkspace();
    expect(createFsRead(new PathGuard(root)).opClass).toBe("read");
  });

  it("summarises the path it was given", () => {
    const root = makeTempWorkspace();
    const read = createFsRead(new PathGuard(root));
    expect(read.summarize({ file_path: "src/index.ts" })).toBe(
      "read src/index.ts",
    );
  });
});
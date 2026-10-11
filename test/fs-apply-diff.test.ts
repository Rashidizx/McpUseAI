import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createFsApplyDiff } from "../src/tools/fs-apply-diff.js";
import { STAGING_SUFFIX } from "../src/tools/fs-errors.js";
import { ZxError } from "../src/core/errors.js";
import { PathGuard } from "../src/core/path-guard.js";
import { makeTempWorkspace, cleanupTempDirs } from "./helpers.js";

afterEach(cleanupTempDirs);

function withFile(
  content: string | Buffer,
  name = "a.ts",
): { root: string; apply: ReturnType<typeof createFsApplyDiff>; read: () => string } {
  const root = makeTempWorkspace();
  writeFileSync(join(root, name), content);
  const apply = createFsApplyDiff(new PathGuard(root));
  return { root, apply, read: () => readFileSync(join(root, name), "utf8") };
}

describe("fs_apply_diff — applying an edit", () => {
  it("replaces a single occurrence", async () => {
    const { apply, read } = withFile("const a = 1;\nconst b = 2;\n");
    const result = await apply.run({
      file_path: "a.ts",
      old_text: "const b = 2;",
      new_text: "const b = 3;",
    });
    expect(read()).toBe("const a = 1;\nconst b = 3;\n");
    expect(result.data).toMatchObject({ replacements: 1 });
  });

  it("leaves the rest of the file untouched", async () => {
    const { apply, read } = withFile("one\ntwo\nthree\nfour\n");
    await apply.run({ file_path: "a.ts", old_text: "two", new_text: "TWO" });
    expect(read()).toBe("one\nTWO\nthree\nfour\n");
  });

  it("replaces every occurrence when all is true", async () => {
    const { apply, read } = withFile("x = 1;\nx = 1;\n");
    await apply.run({ file_path: "a.ts", old_text: "x = 1;", new_text: "x = 2;", all: true });
    expect(read()).toBe("x = 2;\nx = 2;\n");
  });

  it("can insert text without deleting any", async () => {
    const { apply, read } = withFile("start\nend\n");
    await apply.run({ file_path: "a.ts", old_text: "start", new_text: "start\nmiddle" });
    expect(read()).toBe("start\nmiddle\nend\n");
  });
});

describe("fs_apply_diff — refuses rather than guesses", () => {
  it("refuses an ambiguous match and does not modify the file", async () => {
    // The failure this prevents: "first occurrence" silently edits one of two
    // identical bodies, and the result still looks plausible.
    const { apply, read } = withFile("function f() { return 1; }\nfunction f() { return 1; }\n");
    await expect(
      apply.run({
        file_path: "a.ts",
        old_text: "return 1;",
        new_text: "return 2;",
      }),
    ).rejects.toThrow(/appears 2 times/);
    expect(read()).toBe("function f() { return 1; }\nfunction f() { return 1; }\n");
  });

  it("reports how many occurrences it found", async () => {
    const { apply } = withFile("a\na\na\n");
    const error = await apply
      .run({ file_path: "a.ts", old_text: "a", new_text: "b" })
      .then(() => undefined)
      .catch((e: unknown) => e as ZxError);
    expect((error as ZxError).code).toBe("DIFF_NO_MATCH");
    expect((error as ZxError).detail?.occurrences).toBe(3);
  });

  it("refuses text that is not present and leaves the file alone", async () => {
    const { apply, read } = withFile("original\n");
    await expect(
      apply.run({ file_path: "a.ts", old_text: "nowhere", new_text: "x" }),
    ).rejects.toThrow(/does not appear/);
    expect(read()).toBe("original\n");
  });

  it("refuses a missing file rather than creating it", async () => {
    const root = makeTempWorkspace();
    const apply = createFsApplyDiff(new PathGuard(root));
    await expect(
      apply.run({ file_path: "nope.ts", old_text: "a", new_text: "b" }),
    ).rejects.toThrow(/does not exist/);
  });

  it("rejects the create_if_missing escape hatch", () => {
    const root = makeTempWorkspace();
    const apply = createFsApplyDiff(new PathGuard(root));
    expect(() =>
      apply.parseArgs({ file_path: "a.ts", old_text: "a", new_text: "b", create_if_missing: true }),
    ).toThrow(/never creates a file/);
  });

  it("refuses an empty old_text instead of rewriting everything", async () => {
    const { apply, read } = withFile("keep me\n");
    await expect(
      apply.run({ file_path: "a.ts", old_text: "", new_text: "clobber" }),
    ).rejects.toThrow(/does not appear/);
    expect(read()).toBe("keep me\n");
  });
});

describe("fs_apply_diff — never leaves a partial write", () => {
  it("leaves no temp file when the edit fails", async () => {
    const { root, apply } = withFile("a\na\n");
    await apply
      .run({ file_path: "a.ts", old_text: "a", new_text: "b" })
      .catch(() => undefined);
    expect(readdirSync(root)).toEqual(["a.ts"]);
  });

  it("leaves no temp file when the edit succeeds", async () => {
    const { root, apply } = withFile("a\n");
    await apply.run({ file_path: "a.ts", old_text: "a", new_text: "b" });
    expect(readdirSync(root)).toEqual(["a.ts"]);
  });

  it("leaves the original intact when the write cannot be staged", async () => {
    // The test that actually discriminates atomicity. A directory squatting on
    // the staging name makes the staging write fail; if the tool wrote straight
    // to the target instead, this edit would succeed and clobber the file. So a
    // failure here is the proof that the write goes through a staging file first.
    const { root, apply, read } = withFile("original\n");
    // A directory where the staging file goes, so staging fails. This name has to
    // match the one `fs-apply-diff` actually builds. When the two drifted, the
    // staging succeeded, the write went through, and this test passed for the
    // wrong reason - it was no longer testing "leaves the original intact" at
    // all. Asserting against the constant is what keeps that from recurring.
    mkdirSync(join(root, `${"a.ts"}${STAGING_SUFFIX}`));
    await expect(
      apply.run({ file_path: "a.ts", old_text: "original", new_text: "clobbered" }),
    ).rejects.toThrow();
    expect(read()).toBe("original\n");
  });
});

describe("fs_apply_diff — encoding is preserved", () => {
  it("does not convert a CRLF file to LF", async () => {
    const { apply, read } = withFile("a\r\nold\r\n", "win.txt");
    await apply.run({ file_path: "win.txt", old_text: "old", new_text: "new" });
    expect(read()).toBe("a\r\nnew\r\n");
  });

  it("keeps a BOM", async () => {
    const root = makeTempWorkspace();
    writeFileSync(
      join(root, "bom.txt"),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("old\n", "utf8")]),
    );
    const apply = createFsApplyDiff(new PathGuard(root));
    await apply.run({ file_path: "bom.txt", old_text: "old", new_text: "new" });
    const written = readFileSync(join(root, "bom.txt"));
    expect(written.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(written.subarray(3).toString("utf8")).toBe("new\n");
  });
});

describe("fs_apply_diff — sandbox and validation", () => {
  it("refuses a path that escapes the workspace", async () => {
    const { apply } = withFile("a\n");
    await expect(
      apply.run({ file_path: "../outside.ts", old_text: "a", new_text: "b" }),
    ).rejects.toThrow(/traversal/i);
  });

  it("reports a directory target as NOT_A_DIRECTORY", async () => {
    const root = makeTempWorkspace();
    mkdirSync(join(root, "adir"));
    const apply = createFsApplyDiff(new PathGuard(root));
    const error = await apply
      .run({ file_path: "adir", old_text: "a", new_text: "b" })
      .then(() => undefined)
      .catch((e: unknown) => e as ZxError);
    expect((error as ZxError).code).toBe("NOT_A_DIRECTORY");
  });

  it("requires both old_text and new_text to be strings", () => {
    const root = makeTempWorkspace();
    const apply = createFsApplyDiff(new PathGuard(root));
    expect(() => apply.parseArgs({ file_path: "a.ts", new_text: "b" })).toThrow(
      /old_text/,
    );
    expect(() => apply.parseArgs({ file_path: "a.ts", old_text: "a" })).toThrow(
      /new_text/,
    );
  });
});

describe("fs_apply_diff — classification", () => {
  it("is a write, so it asks before changing a file", () => {
    const root = makeTempWorkspace();
    expect(createFsApplyDiff(new PathGuard(root)).opClass).toBe("write");
  });
});
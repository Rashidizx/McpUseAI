import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createFsGrep } from "../src/tools/fs-grep.js";
import { PathGuard } from "../src/core/path-guard.js";
import { ZxError } from "../src/core/errors.js";
import { makeTempWorkspace, cleanupTempDirs } from "./helpers.js";

afterEach(cleanupTempDirs);

/**
 * `fs_grep`, through the same guard every other tool uses.
 *
 * ## What is being defended
 *
 * A search reaches further than a read: it opens every candidate file in a
 * subtree, so an escape that a read would refuse could here scan the whole disk.
 * The sandbox tests below are therefore not a formality - they are the reason
 * this tool is safe to hand to a model.
 *
 * The other half is honesty about partial results. A search that stops at a cap
 * must say so, or a model concludes "this symbol appears in these two files" when
 * it appears in two hundred.
 */

function setup(): { guard: PathGuard; root: string } {
  const root = makeTempWorkspace();
  const guard = new PathGuard(root);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "node_modules", "junk"), { recursive: true });
  writeFileSync(join(root, "src", "alpha.ts"), "export function alpha() {}\nconst x = 1;\n");
  writeFileSync(join(root, "src", "beta.ts"), "export function beta() {}\n// alpha is mentioned here\n");
  writeFileSync(join(root, "notes.md"), "alpha lives in src/alpha.ts\n");
  writeFileSync(join(root, "node_modules", "junk", "index.ts"), "function alpha() {}\n");
  writeFileSync(join(root, "image.png"), "not really a png");
  return { guard, root };
}

const grep = (guard: PathGuard) => createFsGrep(guard);

describe("finding a symbol", () => {
  it("returns the file and a 1-based line number", async () => {
    const { guard } = setup();
    const tool = grep(guard);
    const result = await tool.run(tool.parseArgs({ pattern: "export function alpha" }));

    const data = result.data as { matches: { path: string; line: number }[] };
    expect(data.matches.length).toBe(1);
    expect(data.matches[0]?.path).toBe("src/alpha.ts");
    // 1-based, because that is what an editor and a stack trace both use; a
    // 0-based number here would send every later read to the wrong place.
    expect(data.matches[0]?.line).toBe(1);
  });

  it("finds every file mentioning it, not only the first", async () => {
    const { guard } = setup();
    const tool = grep(guard);
    const result = await tool.run(tool.parseArgs({ pattern: "alpha" }));
    const data = result.data as { matches: { path: string }[] };

    expect(data.matches.map((m) => m.path).sort()).toContain("src/alpha.ts");
    expect(data.matches.map((m) => m.path).sort()).toContain("src/beta.ts");
    expect(data.matches.map((m) => m.path).sort()).toContain("notes.md");
  });

  it("treats the pattern as a regular expression, which is why it is useful", async () => {
    // A plain substring search cannot answer "which of these is it", and that is
    // precisely the question worth asking a codebase.
    const { guard } = setup();
    const tool = grep(guard);
    const result = await tool.run(tool.parseArgs({ pattern: "export function (alpha|beta)" }));
    const data = result.data as { matches: { path: string }[] };

    expect(data.matches.map((m) => m.path).sort()).toEqual(["src/alpha.ts", "src/beta.ts"]);
  });

  it("finds a match on the second line, which a sticky regex would skip", async () => {
    // The classic bug: a `g` regex carries `lastIndex` between `test` calls, so
    // once a line matches, the next `test` starts mid-string and a *later* line is
    // missed even though the first matched.
    //
    // The fixture is built for exactly that: `beta.ts` mentions `alpha` on line 2
    // only, and a file above it in the walk already matched, so a regex that did
    // not reset would come back empty here.
    const { guard } = setup();
    const tool = grep(guard);
    const result = await tool.run(
      tool.parseArgs({ pattern: "alpha", path: "src", match_path: false }),
    );
    const data = result.data as { matches: { path: string; line: number }[] };

    const inBeta = data.matches.filter((m) => m.path === "src/beta.ts");
    expect(inBeta.length).toBeGreaterThan(0);
    expect(inBeta.map((m) => m.line)).toContain(2);
  });

  it("can search a single named file", async () => {
    const { guard } = setup();
    const tool = grep(guard);
    const result = await tool.run(tool.parseArgs({ pattern: "alpha", path: "src/alpha.ts" }));
    const data = result.data as { matches: { path: string }[]; files_searched: number };

    expect(data.matches.every((m) => m.path === "src/alpha.ts")).toBe(true);
    expect(data.files_searched).toBe(1);
  });

  it("skips node_modules, which is where a substring search always goes to die", async () => {
    const { guard } = setup();
    const tool = grep(guard);
    const result = await tool.run(tool.parseArgs({ pattern: "alpha" }));
    const data = result.data as { matches: { path: string }[] };

    expect(data.matches.some((m) => m.path.includes("node_modules"))).toBe(false);
  });

  it("honours a case-sensitive search", async () => {
    const { guard } = setup();
    const tool = grep(guard);

    const insensitive = await tool.run(tool.parseArgs({ pattern: "ALPHA" }));
    expect((insensitive.data as { matches: unknown[] }).matches.length).toBeGreaterThan(0);

    const sensitive = await tool.run(
      tool.parseArgs({ pattern: "ALPHA", case_sensitive: true }),
    );
    expect((sensitive.data as { matches: unknown[] }).matches.length).toBe(0);
  });

  it("can match file names instead of contents", async () => {
    const { guard } = setup();
    const tool = grep(guard);
    const result = await tool.run(tool.parseArgs({ pattern: "beta", match_path: true }));
    const data = result.data as { matches: { path: string; line: number }[] };

    expect(data.matches.some((m) => m.path === "src/beta.ts")).toBe(true);
    expect(data.matches.every((m) => m.line === 0)).toBe(true);
  });

  it("limits matches per file, and says so", async () => {
    const { guard } = setup();
    writeFileSync(join(guard.workspaceRoot, "many.txt"), "hit\nhit\nhit\nhit\n");
    const tool = grep(guard);
    const result = await tool.run(
      tool.parseArgs({ pattern: "hit", path: "many.txt", max_matches_per_file: 2 }),
    );
    const data = result.data as { matches: unknown[]; complete: boolean };

    expect(data.matches.length).toBe(2);
    // Per-file truncation is not incompleteness of the *search*: every file was
    // searched. Reporting `complete: false` here would be a lie of the other kind.
    expect(data.complete).toBe(true);
  });
});

describe("the sandbox", () => {
  it("refuses a `..` escape before anything is read", async () => {
    const { guard } = setup();
    const tool = grep(guard);
    // The failure this catches is the ordering: a guard applied inside `run` would
    // still refuse, but only after the user had been asked to approve a search
    // that was never going to happen.
    expect(() => tool.parseArgs({ pattern: "x", path: "../.." })).toThrow(ZxError);
  });

  it("refuses an absolute path outside the workspace", () => {
    const { guard } = setup();
    const tool = grep(guard);
    expect(() => tool.parseArgs({ pattern: "x", path: "C:/Windows" })).toThrow(ZxError);
  });

  it("refuses a path that escapes through a subdirectory", () => {
    const { guard } = setup();
    const tool = grep(guard);
    expect(() => tool.parseArgs({ pattern: "x", path: "src/../../.." })).toThrow(ZxError);
  });
});

describe("arguments that cannot work", () => {
  it("rejects a missing or empty pattern", () => {
    const { guard } = setup();
    const tool = grep(guard);
    expect(() => tool.parseArgs({})).toThrow(/pattern/);
    expect(() => tool.parseArgs({ pattern: "" })).toThrow(/pattern/);
  });

  it("rejects an invalid regular expression, and says which part failed", () => {
    const { guard } = setup();
    const tool = grep(guard);
    // An invalid pattern must be a message the model can act on, not an empty
    // result that reads as "that symbol does not exist".
    expect(() => tool.parseArgs({ pattern: "([unclosed" })).toThrow(/regular expression/);
  });

  it("rejects argument types that do not make sense", () => {
    const { guard } = setup();
    const tool = grep(guard);
    expect(() => tool.parseArgs({ pattern: "x", case_sensitive: "yes" })).toThrow(/case_sensitive/);
    expect(() => tool.parseArgs({ pattern: "x", extensions: [1, 2] })).toThrow(/extensions/);
    expect(() => tool.parseArgs({ pattern: "x", max_matches_per_file: 0 })).toThrow(
      /max_matches_per_file/,
    );
    expect(() => tool.parseArgs("not an object")).toThrow(/object/);
  });
});

describe("the tool's contract with the gate", () => {
  it("is a read, so a search never asks the user for approval", () => {
    // The reason this tool can exist at all. `exec rg` would be an operation with
    // unbounded reach behind one approval prompt, and every search would pay for
    // it.
    expect(grep(new PathGuard(makeTempWorkspace())).opClass).toBe("read");
  });

  it("describes itself so a model knows to reach for it before reading", () => {
    const tool = grep(new PathGuard(makeTempWorkspace()));
    const described = tool.describe();
    expect(described).toMatch(/search/i);
    expect(described).toMatch(/line number/i);
  });

  it("summarises a rejected attempt by its pattern", () => {
    // The audit row has to answer "what was this bridge trying to touch?", so the
    // fallback summary still names the pattern.
    const tool = grep(new PathGuard(makeTempWorkspace()));
    expect(tool.summarizeRaw?.({ pattern: "needle" })).toMatch(/needle/);
    expect(tool.summarizeRaw?.({})).toMatch(/no pattern/);
  });
});
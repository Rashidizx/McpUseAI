import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { createFsGrep } from "../src/tools/fs-grep.js";
import { PathGuard } from "../src/core/path-guard.js";
import { makeTempWorkspace, cleanupTempDirs } from "./helpers.js";

afterEach(cleanupTempDirs);

/**
 * The caps, measured rather than assumed.
 *
 * ## Why these are numbers and not assertions about a flag
 *
 * `fs_grep` is a `read`, so its result is sent to the model **automatically** -
 * there is no human deciding each one. That makes the size of a single answer a
 * property of the whole system rather than of one tool: a search that returns
 * megabytes does not just waste context, it pushes everything after it out.
 *
 * So these tests build the adversarial case on purpose - many files, every one
 * matching - and check both halves: the size stayed bounded, *and* the result said
 * it was truncated. A cap that silently returned a prefix is the failure this
 * whole project keeps refusing to accept, and a search is exactly where it would
 * appear.
 */

describe("a search cannot flood the conversation", () => {
  it("caps total matches and admits it stopped", async () => {
    const root = makeTempWorkspace();
    // 60 files × 40 matches = 2400 candidates against a 200 cap.
    for (let i = 0; i < 60; i++) {
      writeFileSync(
        join(root, `file${i}.ts`),
        Array.from({ length: 40 }, () => "needle").join("\n"),
      );
    }
    const tool = createFsGrep(new PathGuard(root));
    const result = await tool.run(tool.parseArgs({ pattern: "needle" }));
    const data = result.data as {
      matches: unknown[];
      complete: boolean;
      stopped_because?: string;
    };

    expect(data.matches.length).toBe(200);
    // The part that matters: the caller is told, so a model does not conclude the
    // symbol appears in exactly these places.
    expect(data.complete).toBe(false);
    expect(data.stopped_because).toBe("matches");
  });

  it("keeps a bounded answer bounded in bytes, not only in count", async () => {
    const root = makeTempWorkspace();
    // Every match is as long as one is allowed to be, so a count-only cap would
    // still let the payload grow. This is what stops the message from pushing the
    // rest of the conversation out of the model's window.
    const long = `needle ${"x".repeat(400)}`;
    for (let i = 0; i < 60; i++) {
      writeFileSync(join(root, `long${i}.ts`), Array.from({ length: 40 }, () => long).join("\n"));
    }
    const tool = createFsGrep(new PathGuard(root));
    const result = await tool.run(tool.parseArgs({ pattern: "needle" }));
    const payload = JSON.stringify(result.data);

    expect(payload.length).toBeLessThan(120_000);
    // And each line is visibly truncated rather than whole, with the marker so the
    // model does not read a half-line as the full one.
    expect(payload).toContain("…");
  });

  it("reports complete when nothing was cut off", async () => {
    const root = makeTempWorkspace();
    writeFileSync(join(root, "a.ts"), "needle\n");
    const tool = createFsGrep(new PathGuard(root));
    const result = await tool.run(tool.parseArgs({ pattern: "needle" }));

    // The other half of the contract. A tool that always said `complete: false`
    // would train a model to ignore the flag, which is worse than never setting it.
    expect((result.data as { complete: boolean }).complete).toBe(true);
    expect((result.data as { stopped_because?: string }).stopped_because).toBeUndefined();
  });

  it("skips an oversized file rather than reading half of it", async () => {
    const root = makeTempWorkspace();
    // Over the 2 MB per-file ceiling - counted, not guessed. An earlier version of
    // this test used 240k lines of "filler\n", which is 1.6 MB: under the ceiling,
    // so the file *was* searched and the assertion was wrong about the code.
    //
    // The content puts the only needle at the very end, which is what makes this
    // worth testing: reading a prefix and reporting the search complete would be
    // the silent-shortening failure `fs_read` avoids with `has_more`.
    const filler = "filler\n".repeat(320_000);
    expect(filler.length).toBeGreaterThan(2 * 1024 * 1024);
    writeFileSync(join(root, "huge.ts"), `${filler}needle\n`);

    const tool = createFsGrep(new PathGuard(root));
    const result = await tool.run(tool.parseArgs({ pattern: "needle" }));
    const data = result.data as { matches: unknown[]; files_searched: number };

    expect(data.matches.length).toBe(0);
    expect(data.files_searched).toBe(0);
  });

  it("does not hang on a file with no line breaks", async () => {
    const root = makeTempWorkspace();
    // A minified bundle is one enormous line. Splitting naively would produce a
    // single multi-megabyte "line" and the per-file cap would still have to carry
    // the whole thing.
    writeFileSync(join(root, "bundle.js"), `var a=${"1,".repeat(400_000)};needle;`);
    const tool = createFsGrep(new PathGuard(root));

    const started = Date.now();
    const result = await tool.run(tool.parseArgs({ pattern: "needle" }));
    const data = result.data as { matches: { text: string }[] };

    expect(data.matches.length).toBe(1);
    // Truncated, so the answer does not carry the whole bundle.
    expect(data.matches[0]?.text.length).toBeLessThanOrEqual(301);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("says which cap stopped it, so the two limits are never confused", async () => {
    const root = makeTempWorkspace();
    // 60 files × 40 matches against the 200 global cap. Found while writing the
    // speed test above: 300 single-match files tripped the match cap at 200, and
    // the failure read as "expected 200 to be 300" - which looks like a missing
    // result rather than a reported one.
    //
    // The two caps are different questions and a caller needs to tell them apart:
    // `matches` means "there are more hits, narrow your pattern";
    // `files` would mean "there are more files, narrow your path". Both are honest,
    // but they send the model somewhere different.
    for (let i = 0; i < 60; i++) {
      writeFileSync(
        join(root, `many${i}.ts`),
        Array.from({ length: 40 }, () => "needle").join("\n"),
      );
    }
    const tool = createFsGrep(new PathGuard(root));
    const result = await tool.run(tool.parseArgs({ pattern: "needle" }));
    const data = result.data as { complete: boolean; stopped_because?: string };

    expect(data.complete).toBe(false);
    expect(data.stopped_because).toBe("matches");
  });

  it("respects a per-file cap without calling the whole search incomplete", async () => {
    const root = makeTempWorkspace();
    writeFileSync(join(root, "many.ts"), Array.from({ length: 50 }, () => "needle").join("\n"));
    const tool = createFsGrep(new PathGuard(root));
    const result = await tool.run(
      tool.parseArgs({ pattern: "needle", max_matches_per_file: 3 }),
    );
    const data = result.data as { matches: unknown[]; complete: boolean };

    expect(data.matches.length).toBe(3);
    // Every file was searched, so the *search* was complete. Reporting otherwise
    // would be a lie of the other kind, and would train the model to re-run.
    expect(data.complete).toBe(true);
  });
});

describe("the tool stays fast enough to be used", () => {
  it("searches a few hundred files in well under a second", async () => {
    const root = makeTempWorkspace();
    const body = Array.from({ length: 200 }, (_, n) => `const value${n} = ${n};`).join("\n");
    // 120 files, one match each: 120 matches, comfortably under the 200 cap so this
    // measures *speed* rather than truncation. The first version of this test used
    // 300 files against a 200-match cap and so measured the cap instead, failing
    // with "expected 200 to be 300" for a reason that had nothing to do with time.
    for (let i = 0; i < 120; i++) writeFileSync(join(root, `m${i}.ts`), body);

    const tool = createFsGrep(new PathGuard(root));
    const started = Date.now();
    const result = await tool.run(tool.parseArgs({ pattern: "const value199 =" }));
    const elapsed = Date.now() - started;

    // 120 files × 200 lines. Not a benchmark - a ceiling, so a change that turns a
    // linear scan into something quadratic fails here rather than in a user's
    // browser, where a tool that takes ten seconds is indistinguishable from one
    // that has hung.
    expect(elapsed).toBeLessThan(5_000);
    expect((result.data as { matches: unknown[] }).matches.length).toBe(120);
  });
});
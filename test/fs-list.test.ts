import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createFsList } from "../src/tools/fs-list.js";
import { ZxError } from "../src/core/errors.js";
import { PathGuard } from "../src/core/path-guard.js";
import { makeTempWorkspace, cleanupTempDirs } from "./helpers.js";

afterEach(cleanupTempDirs);

type Listed = {
  entries: { path: string; type: "file" | "directory"; size: number | null }[];
  complete: boolean;
  examined: number;
};

function listIn(root: string) {
  return createFsList(new PathGuard(root)).run({}).then((r) => r.data as Listed);
}

describe("fs_list — listing a directory", () => {
  it("lists files and directories with their sizes", async () => {
    const root = makeTempWorkspace();
    writeFileSync(join(root, "a.txt"), "12345");
    mkdirSync(join(root, "sub"));
    const data = await listIn(root);
    expect(data.entries).toEqual(
      expect.arrayContaining([
        { path: "a.txt", type: "file", size: 5 },
        { path: "sub", type: "directory", size: null },
      ]),
    );
  });

  it("reports a complete listing of a small directory", async () => {
    const root = makeTempWorkspace();
    writeFileSync(join(root, "a.txt"), "x");
    const data = await listIn(root);
    expect(data.complete).toBe(true);
  });

  it("hides dotfiles by default", async () => {
    const root = makeTempWorkspace();
    writeFileSync(join(root, ".hidden"), "x");
    writeFileSync(join(root, "shown.txt"), "x");
    const data = await listIn(root);
    expect(data.entries.map((e) => e.path)).toEqual(["shown.txt"]);
  });

  it("includes dotfiles when asked", async () => {
    const root = makeTempWorkspace();
    writeFileSync(join(root, ".env"), "SECRET=1");
    const data = await (await createFsList(new PathGuard(root)).run({
      include_hidden: true,
    })).data as Listed;
    expect(data.entries.map((e) => e.path)).toContain(".env");
  });

  it("returns an empty listing for an empty directory", async () => {
    const root = makeTempWorkspace();
    expect((await listIn(root)).entries).toEqual([]);
  });
});

describe("fs_list — depth", () => {
  it("stays in the top directory by default", async () => {
    const root = makeTempWorkspace();
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "deep.txt"), "x");
    const data = await listIn(root);
    expect(data.entries.map((e) => e.path)).toEqual(["sub"]);
  });

  it("descends when depth allows it", async () => {
    const root = makeTempWorkspace();
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "deep.txt"), "x");
    const data = await (await createFsList(new PathGuard(root)).run({ depth: 1 }))
      .data as Listed;
    expect(data.entries.map((e) => e.path).sort()).toEqual(["sub", "sub/deep.txt"]);
  });

  it("never descends into .git or node_modules", async () => {
    const root = makeTempWorkspace();
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, ".git", "HEAD"), "ref");
    writeFileSync(join(root, "node_modules", "pkg.json"), "{}");
    const data = await (await createFsList(new PathGuard(root)).run({
      depth: 3,
      include_hidden: true,
    })).data as Listed;
    // The directories themselves are listed; nothing inside them is walked, so a
    // listing of a repo root stays small instead of returning every object file.
    expect(data.entries.map((e) => e.path).sort()).toEqual([".git", "node_modules"]);
  });

  it("hides .git entirely unless hidden files are requested", async () => {
    const root = makeTempWorkspace();
    mkdirSync(join(root, ".git"));
    const visible = await listIn(root);
    expect(visible.entries).toEqual([]);
  });

  it("caps depth so a deep tree cannot walk forever", async () => {
    const root = makeTempWorkspace();
    let current = root;
    for (let i = 0; i < 12; i++) {
      current = join(current, `d${i}`);
      mkdirSync(current);
    }
    const data = await (await createFsList(new PathGuard(root)).run({ depth: 1000 }))
      .data as Listed;
    // Whatever the cap, the walk terminates and says whether it finished.
    expect(data.entries.length).toBeGreaterThan(0);
    expect(typeof data.complete).toBe("boolean");
  });
});

describe("fs_list — never misrepresents what it saw", () => {
  it("says complete: true only when it finished", async () => {
    const root = makeTempWorkspace();
    for (let i = 0; i < 5; i++) writeFileSync(join(root, `f${i}.txt`), "x");
    const data = await listIn(root);
    expect(data.complete).toBe(true);
    expect(data.examined).toBe(data.entries.length);
  });

  it("summarises how many entries it returned", async () => {
    const root = makeTempWorkspace();
    writeFileSync(join(root, "only.txt"), "x");
    const result = await createFsList(new PathGuard(root)).run({});
    expect(result.summary).toBe("listed .: 1 entry");
  });
});

describe("fs_list — sandbox and errors", () => {
  it("refuses a path that escapes the workspace", async () => {
    const root = makeTempWorkspace();
    await expect(
      createFsList(new PathGuard(root)).run({ dir_path: "../.." }),
    ).rejects.toThrow(/traversal/i);
  });

  it("reports a file as NOT_A_DIRECTORY", async () => {
    const root = makeTempWorkspace();
    writeFileSync(join(root, "a.txt"), "x");
    const error = await createFsList(new PathGuard(root))
      .run({ dir_path: "a.txt" })
      .then(() => undefined)
      .catch((e: unknown) => e as ZxError);
    expect((error as ZxError).code).toBe("NOT_A_DIRECTORY");
  });

  it("reports a missing directory as FILE_NOT_FOUND", async () => {
    const root = makeTempWorkspace();
    const error = await createFsList(new PathGuard(root))
      .run({ dir_path: "nope" })
      .then(() => undefined)
      .catch((e: unknown) => e as ZxError);
    expect((error as ZxError).code).toBe("FILE_NOT_FOUND");
  });

  it("never lists anything outside the workspace root", async () => {
    const root = makeTempWorkspace();
    writeFileSync(join(root, "inside.txt"), "x");
    const data = await listIn(root);
    for (const entry of data.entries) {
      // Relative by construction, and free of both separators' parent forms.
      expect(entry.path).not.toContain("..");
      expect(entry.path.startsWith("/")).toBe(false);
    }
  });
});

describe("fs_list — classification", () => {
  it("is a read, so it needs no approval", () => {
    const root = makeTempWorkspace();
    expect(createFsList(new PathGuard(root)).opClass).toBe("read");
  });

  it("rejects a negative depth", () => {
    const root = makeTempWorkspace();
    expect(() => createFsList(new PathGuard(root)).parseArgs({ depth: -1 })).toThrow(
      /depth/,
    );
  });
});
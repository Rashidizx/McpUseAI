import { describe, it, expect, afterEach } from "vitest";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTempDirs,
  makeTempDir,
  makeTempWorkspace,
  realPathOf,
} from "./helpers.js";

afterEach(cleanupTempDirs);

describe("toolchain", () => {
  it("runs TypeScript tests", () => {
    const value: number = 1 + 1;
    expect(value).toBe(2);
  });

  it("creates a real temp directory on Windows", () => {
    const dir = makeTempWorkspace();
    expect(dir.length).toBeGreaterThan(0);
    expect(existsSync(dir)).toBe(true);
  });
});

describe("makeTempDir", () => {
  it("gives every call a distinct directory", () => {
    const first = makeTempDir("zx-a-");
    const second = makeTempDir("zx-a-");
    expect(first).not.toBe(second);
    expect(existsSync(second)).toBe(true);
  });

  it("deletes what it created on cleanup", () => {
    const dir = makeTempDir("zx-cleanup-");
    writeFileSync(join(dir, "f.txt"), "x");
    expect(existsSync(dir)).toBe(true);
    cleanupTempDirs();
    expect(existsSync(dir)).toBe(false);
  });
});

describe("realPathOf", () => {
  it("reports the real location of a temp directory", () => {
    const dir = makeTempWorkspace();
    expect(realPathOf(dir)).toBe(realPathOf(dir));
    expect(existsSync(realPathOf(dir))).toBe(true);
  });
});

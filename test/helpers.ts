import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Temp-directory bookkeeping shared by every test file.
 *
 * This lives in a plain module rather than in `test/helpers.test.ts` because the
 * `afterEach` that deletes these directories must be registered in the test file
 * that *creates* them. A hook registered inside `helpers.test.ts` is scoped to that
 * one file, so a `helpers.test.ts` that both exported `makeTempWorkspace` and
 * cleaned up would leave every directory created by `path-guard.test.ts` on disk
 * forever. Each test file therefore calls `afterEach(cleanupTempDirs)` itself.
 */
const created: string[] = [];

/** Create a real directory under the OS temp dir and schedule it for deletion. */
export function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/** A temp directory to be used as a workspace sandbox root. */
export function makeTempWorkspace(): string {
  return makeTempDir("zx-workspace-");
}

/** Delete every directory handed out by this module. */
export function cleanupTempDirs(): void {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The path the OS actually uses, with real casing and 8.3 names expanded.
 *
 * `os.tmpdir()` hands back `C:\Users\MRRASH~1.E\...` while the true path is
 * `C:\Users\Mr.Rashidi.E\...`, so any expectation written against the raw
 * `mkdtempSync` string would fail against a guard that correctly returns the
 * real path.
 */
export function realPathOf(dir: string): string {
  return realpathSync.native(dir);
}

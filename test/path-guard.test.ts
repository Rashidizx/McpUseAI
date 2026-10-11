import { describe, it, expect, afterEach } from "vitest";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ZxError, type ZxErrorCode } from "../src/core/errors.js";
import { PathGuard } from "../src/core/path-guard.js";
import {
  cleanupTempDirs,
  makeTempDir,
  makeTempWorkspace,
  realPathOf,
} from "./helpers.js";

const PATH_GUARD_SOURCE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "core",
  "path-guard.ts",
);

afterEach(cleanupTempDirs);

const onWindows = process.platform === "win32";

/** Run `run`, require it to throw a `ZxError`, and return its code. */
function codeOf(run: () => unknown): ZxErrorCode {
  try {
    run();
  } catch (error) {
    if (error instanceof ZxError) return error.code;
    throw new Error(`expected a ZxError, got: ${String(error)}`);
  }
  throw new Error("expected the call to throw, but it returned normally");
}

/** Run `run`, require it to throw a `ZxError` with `code`, and return it. */
function zxErrorOf(run: () => unknown, code: ZxErrorCode): ZxError {
  try {
    run();
  } catch (error) {
    if (error instanceof ZxError) {
      expect(error.code).toBe(code);
      return error;
    }
    throw new Error(`expected a ZxError, got: ${String(error)}`);
  }
  throw new Error("expected the call to throw, but it returned normally");
}

/**
 * Windows refuses to create a non-junction symlink without an elevated token or
 * Developer Mode, so the file-symlink case is only asserted where the platform
 * actually allows it. Probed by doing it, rather than assumed from the platform
 * name, so a machine with Developer Mode off reports the truth.
 */
const fileSymlinksSupported = ((): boolean => {
  const dir = makeTempDir("zx-symlink-probe-");
  try {
    writeFileSync(join(dir, "target.txt"), "x");
    symlinkSync(join(dir, "target.txt"), join(dir, "link.txt"), "file");
    return true;
  } catch {
    return false;
  }
})();

describe("PathGuard: accepted paths", () => {
  it("resolves a relative file inside the root to an absolute path", () => {
    const root = makeTempWorkspace();
    const guard = new PathGuard(root);
    expect(guard.resolve("src/index.ts")).toBe(
      join(guard.workspaceRoot, "src", "index.ts"),
    );
  });

  it("anchors the sandbox on the real root, not the configured one", () => {
    const root = makeTempWorkspace();
    const guard = new PathGuard(root);
    expect(guard.workspaceRoot).toBe(realPathOf(root));
  });

  it("normalises duplicated separators", () => {
    const root = makeTempWorkspace();
    const guard = new PathGuard(root);
    const result = guard.resolve("src//deep///file.ts");
    expect(result).toBe(join(guard.workspaceRoot, "src", "deep", "file.ts"));
    expect(result).not.toMatch(/[\\/]{2,}/);
  });

  it("accepts a nested path that exists on disk", () => {
    const root = makeTempWorkspace();
    mkdirSync(join(root, "a", "b"), { recursive: true });
    writeFileSync(join(root, "a", "b", "f.txt"), "x");
    const guard = new PathGuard(root);
    expect(guard.resolve("a/b/f.txt")).toBe(
      join(guard.workspaceRoot, "a", "b", "f.txt"),
    );
  });

  it("accepts a not-yet-existing file, which is how fs_write creates files", () => {
    const root = makeTempWorkspace();
    const guard = new PathGuard(root);
    expect(guard.resolve("new/deep/created.txt")).toBe(
      join(guard.workspaceRoot, "new", "deep", "created.txt"),
    );
  });

  it("accepts a trailing separator on a directory", () => {
    const root = makeTempWorkspace();
    const guard = new PathGuard(root);
    expect(guard.resolve("src/")).toBe(join(guard.workspaceRoot, "src"));
  });

  it("accepts '.' segments", () => {
    const root = makeTempWorkspace();
    const guard = new PathGuard(root);
    expect(guard.resolve("./src/./index.ts")).toBe(
      join(guard.workspaceRoot, "src", "index.ts"),
    );
  });

  it("accepts '..' that stays inside the root", () => {
    const root = makeTempWorkspace();
    const guard = new PathGuard(root);
    expect(guard.resolve("src/../other.txt")).toBe(
      join(guard.workspaceRoot, "other.txt"),
    );
  });

  it("accepts the root itself", () => {
    const root = makeTempWorkspace();
    const guard = new PathGuard(root);
    expect(guard.resolve(".")).toBe(guard.workspaceRoot);
  });

  it("returns the real path when handed the configured path", () => {
    const root = makeTempWorkspace();
    const guard = new PathGuard(root);
    // `root` may carry an 8.3 name (C:\Users\MRRASH~1.E\...); the guard must
    // answer with the path the OS really uses.
    expect(guard.resolve(root)).toBe(realPathOf(root));
  });

  it("accepts an absolute path already inside the root", () => {
    const root = makeTempWorkspace();
    const guard = new PathGuard(root);
    const inside = join(guard.workspaceRoot, "src", "file.ts");
    expect(guard.resolve(inside)).toBe(inside);
  });

  it("returns the on-disk casing rather than the caller's casing", () => {
    const root = makeTempWorkspace();
    writeFileSync(join(root, "MixedCase.TXT"), "x");
    const guard = new PathGuard(root);
    expect(basename(guard.resolve("mixedcase.txt"))).toBe("MixedCase.TXT");
  });

  it("keeps the caller's casing for a file that does not exist yet", () => {
    const root = makeTempWorkspace();
    const guard = new PathGuard(root);
    expect(basename(guard.resolve("MixedCase.txt"))).toBe("MixedCase.txt");
  });

  it("accepts a name that merely contains a reserved word", () => {
    const root = makeTempWorkspace();
    const guard = new PathGuard(root);
    expect(guard.resolve("console.ts")).toBe(
      join(guard.workspaceRoot, "console.ts"),
    );
    expect(guard.resolve("src/nullptr.md")).toBe(
      join(guard.workspaceRoot, "src", "nullptr.md"),
    );
    expect(guard.resolve("com10.txt")).toBe(
      join(guard.workspaceRoot, "com10.txt"),
    );
  });

  it("accepts a long path that is still within the limit", () => {
    const root = makeTempWorkspace();
    const guard = new PathGuard(root);
    const long = `${"d".repeat(60)}/${"e".repeat(60)}.txt`;
    expect(guard.resolve(long)).toBe(
      join(guard.workspaceRoot, "d".repeat(60), `${"e".repeat(60)}.txt`),
    );
  });
});

describe("PathGuard: separator and case handling", () => {
  it.runIf(onWindows)("accepts backslashes as separators", () => {
    const root = makeTempWorkspace();
    const guard = new PathGuard(root);
    expect(guard.resolve("src\\index.ts")).toBe(guard.resolve("src/index.ts"));
  });

  it.runIf(!onWindows)(
    "treats a backslash as an ordinary filename character, not a separator",
    () => {
      const root = makeTempWorkspace();
      const guard = new PathGuard(root);
      expect(guard.resolve("a\\b.txt")).toBe(
        join(guard.workspaceRoot, "a\\b.txt"),
      );
    },
  );

  it.runIf(onWindows)("accepts a path that differs only in case", () => {
    const root = makeTempWorkspace();
    mkdirSync(join(root, "src"));
    const guard = new PathGuard(root);
    expect(guard.resolve("SRC/Index.ts")).toBe(
      join(guard.workspaceRoot, "src", "Index.ts"),
    );
  });

  it.runIf(onWindows)("accepts an absolute path whose case differs", () => {
    const root = makeTempWorkspace();
    const guard = new PathGuard(root);
    const shouted = join(guard.workspaceRoot, "SRC").toUpperCase();
    expect(guard.resolve(shouted)).toBe(join(guard.workspaceRoot, "SRC"));
  });
});

/**
 * Join without normalising.
 *
 * `path.join` folds `..` away, which would delete the exact spelling these cases
 * are about: the guard has to see the un-collapsed string, because folding it is
 * the guard's job.
 */
function rawJoin(...segments: readonly string[]): string {
  return segments.join(sep);
}

describe("PathGuard: lexical rejections", () => {
  it("rejects '..' that escapes the root", () => {
    const root = makeTempWorkspace();
    const guard = new PathGuard(root);
    expect(codeOf(() => guard.resolve("../outside.txt"))).toBe("PATH_TRAVERSAL");
  });

  it("rejects traversal hidden mid-path", () => {
    const root = makeTempWorkspace();
    const guard = new PathGuard(root);
    expect(codeOf(() => guard.resolve("src/../../outside.txt"))).toBe(
      "PATH_TRAVERSAL",
    );
    expect(codeOf(() => guard.resolve("a/b/../../../x"))).toBe("PATH_TRAVERSAL");
  });

  it("rejects a bare '..'", () => {
    const root = makeTempWorkspace();
    const guard = new PathGuard(root);
    expect(codeOf(() => guard.resolve(".."))).toBe("PATH_TRAVERSAL");
  });

  it("rejects an absolute path outside the root", () => {
    const root = makeTempWorkspace();
    const guard = new PathGuard(root);
    const outside = join(dirname(realPathOf(root)), "outside.txt");
    expect(codeOf(() => guard.resolve(outside))).toBe("PATH_OUTSIDE_SANDBOX");
  });

  it.runIf(onWindows)("rejects a well-known absolute system path", () => {
    const root = makeTempWorkspace();
    const guard = new PathGuard(root);
    expect(codeOf(() => guard.resolve("C:/Windows/System32/config"))).toBe(
      "PATH_OUTSIDE_SANDBOX",
    );
  });

  it("rejects tilde expansion", () => {
    const root = makeTempWorkspace();
    const guard = new PathGuard(root);
    expect(codeOf(() => guard.resolve("~/.ssh/id_rsa"))).toBe("PATH_TRAVERSAL");
  });

  it("rejects a NUL byte, which truncates the path in the Win32 API", () => {
    const root = makeTempWorkspace();
    const guard = new PathGuard(root);
    expect(codeOf(() => guard.resolve("a\u0000b.txt"))).toBe("PATH_TRAVERSAL");
  });

  it("rejects other ASCII control characters", () => {
    const root = makeTempWorkspace();
    const guard = new PathGuard(root);
    expect(codeOf(() => guard.resolve("a\nb.txt"))).toBe("PATH_TRAVERSAL");
    expect(codeOf(() => guard.resolve("a\u001Fb.txt"))).toBe("PATH_TRAVERSAL");
    expect(codeOf(() => guard.resolve("a\u0009b.txt"))).toBe("PATH_TRAVERSAL");
  });

  it("rejects a backslash UNC path", () => {
    const root = makeTempWorkspace();
    const guard = new PathGuard(root);
    expect(codeOf(() => guard.resolve("\\\\server\\share\\x.txt"))).toBe(
      "PATH_OUTSIDE_SANDBOX",
    );
  });

  it("rejects a forward-slash UNC path", () => {
    const root = makeTempWorkspace();
    const guard = new PathGuard(root);
    expect(codeOf(() => guard.resolve("//server/share/x.txt"))).toBe(
      "PATH_OUTSIDE_SANDBOX",
    );
  });

  it("rejects Win32 device and extended-length prefixes", () => {
    const root = makeTempWorkspace();
    const guard = new PathGuard(root);
    expect(codeOf(() => guard.resolve("\\\\?\\C:\\Windows"))).toBe(
      "PATH_OUTSIDE_SANDBOX",
    );
    expect(codeOf(() => guard.resolve("\\\\.\\NUL"))).toBe(
      "PATH_OUTSIDE_SANDBOX",
    );
  });

  it("rejects an alternate data stream, which no directory listing shows", () => {
    const root = makeTempWorkspace();
    const guard = new PathGuard(root);
    expect(codeOf(() => guard.resolve("file.txt:hidden"))).toBe(
      "PATH_TRAVERSAL",
    );
    expect(codeOf(() => guard.resolve("file.txt::$DATA"))).toBe("PATH_TRAVERSAL");
    expect(codeOf(() => guard.resolve("dir:stream/file.txt"))).toBe(
      "PATH_TRAVERSAL",
    );
  });

  it.runIf(onWindows)("rejects a drive-relative path", () => {
    const root = makeTempWorkspace();
    const guard = new PathGuard(root);
    expect(codeOf(() => guard.resolve("C:Windows\\System32\\config"))).toBe(
      "PATH_TRAVERSAL",
    );
  });

  it.runIf(onWindows)("rejects a bare drive reference", () => {
    const root = makeTempWorkspace();
    const guard = new PathGuard(root);
    // `C:` on its own is a drive-relative reference to that drive's current
    // directory, not the sandbox, and it must not slip through as a filename.
    expect(codeOf(() => guard.resolve("C:"))).toBe("PATH_TRAVERSAL");
  });

  it("rejects a root-relative absolute path", () => {
    const root = makeTempWorkspace();
    const guard = new PathGuard(root);
    expect(codeOf(() => guard.resolve("/etc/passwd"))).toBe(
      "PATH_OUTSIDE_SANDBOX",
    );
  });

  it("rejects reserved device names in any segment", () => {
    const root = makeTempWorkspace();
    const guard = new PathGuard(root);
    for (const input of [
      "NUL",
      "con",
      "AUX",
      "prn.txt",
      "data/COM1.log",
      "LPT9",
      "a/b/nul",
      "CoN",
    ]) {
      expect(codeOf(() => guard.resolve(input))).toBe("RESERVED_DEVICE_NAME");
    }
  });

  it("rejects a reserved name hidden behind trailing spaces", () => {
    const root = makeTempWorkspace();
    const guard = new PathGuard(root);
    expect(codeOf(() => guard.resolve("CON "))).toBe("RESERVED_DEVICE_NAME");
    expect(codeOf(() => guard.resolve("nul.txt "))).toBe("RESERVED_DEVICE_NAME");
  });

  it("rejects a path over the length limit", () => {
    const root = makeTempWorkspace();
    const guard = new PathGuard(root);
    const tooLong = Array.from({ length: 60 }, () => "d".repeat(100)).join("/");
    expect(codeOf(() => guard.resolve(tooLong))).toBe("PATH_TOO_LONG");
  });

  it("rejects the empty string, but still accepts '.' and './' as the root", () => {
    const root = makeTempWorkspace();
    const guard = new PathGuard(root);
    // The empty string is not a path: resolving it would hand back the root and
    // turn a caller bug into an EISDIR from deep inside a tool. `.` and `./` are
    // legitimate ways to name the root — `fs_list` needs them — so they must keep
    // working.
    expect(codeOf(() => guard.resolve(""))).toBe("PATH_TRAVERSAL");
    expect(guard.resolve(".")).toBe(guard.workspaceRoot);
    expect(guard.resolve("./")).toBe(guard.workspaceRoot);
  });

  it("puts the offending input in the error detail", () => {
    const root = makeTempWorkspace();
    const guard = new PathGuard(root);
    const error = zxErrorOf(() => guard.resolve("../x"), "PATH_TRAVERSAL");
    expect(error.detail).toMatchObject({ input: "../x" });
  });
});

describe("PathGuard: filesystem verification", () => {
  it("rejects a junction inside the root that points outside it", () => {
    const root = makeTempWorkspace();
    const outside = makeTempDir("zx-outside-");
    writeFileSync(join(outside, "secret.txt"), "TOP SECRET\n");
    symlinkSync(outside, join(root, "escape"), "junction");
    const guard = new PathGuard(root);
    expect(codeOf(() => guard.resolve("escape/secret.txt"))).toBe(
      "PATH_OUTSIDE_SANDBOX",
    );
  });

  it("rejects a new file under an escaping junction", () => {
    const root = makeTempWorkspace();
    const outside = makeTempDir("zx-outside-");
    symlinkSync(outside, join(root, "escape"), "junction");
    const guard = new PathGuard(root);
    expect(codeOf(() => guard.resolve("escape/planted.txt"))).toBe(
      "PATH_OUTSIDE_SANDBOX",
    );
  });

  it("rejects the escaping junction directory itself", () => {
    const root = makeTempWorkspace();
    const outside = makeTempDir("zx-outside-");
    symlinkSync(outside, join(root, "escape"), "junction");
    const guard = new PathGuard(root);
    expect(codeOf(() => guard.resolve("escape"))).toBe("PATH_OUTSIDE_SANDBOX");
  });

  it.runIf(fileSymlinksSupported)(
    "rejects a file symlink inside the root that points outside it",
    () => {
      const root = makeTempWorkspace();
      const outside = makeTempDir("zx-outside-");
      writeFileSync(join(outside, "secret.txt"), "TOP SECRET\n");
      symlinkSync(join(outside, "secret.txt"), join(root, "leak.txt"), "file");
      const guard = new PathGuard(root);
      expect(codeOf(() => guard.resolve("leak.txt"))).toBe(
        "PATH_OUTSIDE_SANDBOX",
      );
    },
  );

  it("accepts a junction inside the root that points back inside it", () => {
    const root = makeTempWorkspace();
    mkdirSync(join(root, "data"), { recursive: true });
    writeFileSync(join(root, "data", "f.txt"), "x");
    symlinkSync(join(root, "data"), join(root, "inner"), "junction");
    const guard = new PathGuard(root);
    expect(guard.resolve("inner/f.txt")).toBe(
      join(guard.workspaceRoot, "data", "f.txt"),
    );
  });

  it("accepts a new file under a junction that stays inside the root", () => {
    const root = makeTempWorkspace();
    mkdirSync(join(root, "data"), { recursive: true });
    symlinkSync(join(root, "data"), join(root, "inner"), "junction");
    const guard = new PathGuard(root);
    expect(guard.resolve("inner/new.txt")).toBe(
      join(guard.workspaceRoot, "data", "new.txt"),
    );
  });

  it("honours a sandbox root that is itself a junction", () => {
    const root = makeTempDir("zx-real-");
    const outside = makeTempDir("zx-outside-");
    writeFileSync(join(root, "f.txt"), "x");
    const linked = join(outside, "workspace");
    symlinkSync(root, linked, "junction");
    const guard = new PathGuard(linked);
    expect(guard.workspaceRoot).toBe(realPathOf(root));
    expect(guard.resolve("f.txt")).toBe(join(realPathOf(root), "f.txt"));
  });

  it("rejects a sibling directory whose name merely starts with the root's name", () => {
    const base = makeTempDir("zx-prefix-");
    const root = join(base, "repo");
    const sibling = join(base, "repository");
    mkdirSync(root);
    mkdirSync(sibling);
    writeFileSync(join(sibling, "x.txt"), "x");
    const guard = new PathGuard(root);
    expect(guard.isInside(sibling)).toBe(false);
    expect(guard.isInside(join(sibling, "x.txt"))).toBe(false);
    expect(codeOf(() => guard.resolve(join(sibling, "x.txt")))).toBe(
      "PATH_OUTSIDE_SANDBOX",
    );
  });

  it("rejects a sibling reached by traversal from the root", () => {
    const base = makeTempDir("zx-prefix-");
    const root = join(base, "repo");
    mkdirSync(root);
    mkdirSync(join(base, "repository"));
    const guard = new PathGuard(root);
    expect(codeOf(() => guard.resolve("../repository/x.txt"))).toBe(
      "PATH_TRAVERSAL",
    );
  });

  it("rejects a junction chain that only escapes at the second hop", () => {
    const root = makeTempWorkspace();
    const outside = makeTempDir("zx-outside-");
    mkdirSync(join(root, "inner"), { recursive: true });
    symlinkSync(outside, join(root, "inner", "hop2"), "junction");
    symlinkSync(join(root, "inner"), join(root, "hop1"), "junction");
    const guard = new PathGuard(root);
    expect(codeOf(() => guard.resolve("hop1/hop2/secret.txt"))).toBe(
      "PATH_OUTSIDE_SANDBOX",
    );
  });

  it("rejects a directory in the middle of the chain escaping via a junction", () => {
    const root = makeTempWorkspace();
    const outside = makeTempDir("zx-outside-");
    symlinkSync(outside, join(root, "escape"), "junction");
    const guard = new PathGuard(root);
    expect(codeOf(() => guard.resolve("escape/nested/deep/f.txt"))).toBe(
      "PATH_OUTSIDE_SANDBOX",
    );
  });
});

describe("PathGuard: isInside and assertInside", () => {
  it("reports the root as inside", () => {
    const root = makeTempWorkspace();
    const guard = new PathGuard(root);
    expect(guard.isInside(guard.workspaceRoot)).toBe(true);
  });

  it("reports a path inside the root as inside, even if missing", () => {
    const root = makeTempWorkspace();
    const guard = new PathGuard(root);
    expect(guard.isInside(join(guard.workspaceRoot, "not", "there.txt"))).toBe(
      true,
    );
  });

  it("reports a path outside the root as outside", () => {
    const root = makeTempWorkspace();
    const guard = new PathGuard(root);
    const sibling = `${root}-evil`;
    expect(guard.isInside(sibling)).toBe(false);
    expect(guard.isInside(join(sibling, "x.txt"))).toBe(false);
  });

  it("reports an escaping junction as outside", () => {
    const root = makeTempWorkspace();
    const outside = makeTempDir("zx-outside-");
    symlinkSync(outside, join(root, "escape"), "junction");
    const guard = new PathGuard(root);
    expect(guard.isInside(join(guard.workspaceRoot, "escape", "secret.txt"))).toBe(
      false,
    );
  });

  it("asserts nothing for a path inside the root", () => {
    const root = makeTempWorkspace();
    const guard = new PathGuard(root);
    expect(() => guard.assertInside(join(guard.workspaceRoot, "a.txt"))).not.toThrow();
  });

  it("throws PATH_OUTSIDE_SANDBOX for a path outside the root", () => {
    const root = makeTempWorkspace();
    const guard = new PathGuard(root);
    const outside = join(dirname(realPathOf(root)), "outside.txt");
    const error = zxErrorOf(
      () => guard.assertInside(outside),
      "PATH_OUTSIDE_SANDBOX",
    );
    expect(error.detail).toMatchObject({ input: outside, root: guard.workspaceRoot });
  });

  it("asserts on an escaping junction too", () => {
    const root = makeTempWorkspace();
    const outside = makeTempDir("zx-outside-");
    symlinkSync(outside, join(root, "escape"), "junction");
    const guard = new PathGuard(root);
    zxErrorOf(
      () => guard.assertInside(join(guard.workspaceRoot, "escape", "secret.txt")),
      "PATH_OUTSIDE_SANDBOX",
    );
  });
});

describe("PathGuard: segment names Win32 does not accept consistently", () => {
  // A segment ending in a space or a dot is not a name the layers agree on:
  // `node:fs` refuses `.. ` with ENOENT, while `cmd.exe` accepts `inside.txt.` and
  // opens the real file. Today the guard certifies such a string and safety lives
  // in the callee returning an error — which is exactly the layer that a future
  // `git_*` or `exec` tool does not sit behind, because those resolve names
  // natively.
  it("rejects a '..' segment that carries a trailing space", () => {
    const base = makeTempDir("zx-parent-");
    const root = join(base, "repo");
    mkdirSync(root);
    // A real junction one level above the root: stripping the single space from
    // the accepted string turns it into a read of this file.
    const outside = makeTempDir("zx-outside-");
    writeFileSync(join(outside, "secret.txt"), "TOP SECRET\n");
    symlinkSync(outside, join(base, "escape"), "junction");
    const guard = new PathGuard(root);
    expect(codeOf(() => guard.resolve(".. /escape/secret.txt"))).toBe(
      "PATH_TRAVERSAL",
    );
    expect(codeOf(() => guard.resolve(".. /"))).toBe("PATH_TRAVERSAL");
    expect(codeOf(() => guard.resolve("dir. /file.txt"))).toBe(
      "PATH_TRAVERSAL",
    );
  });

  it("rejects a segment ending in a dot", () => {
    const root = makeTempWorkspace();
    writeFileSync(join(root, "inside.txt"), "INSIDE\n");
    const guard = new PathGuard(root);
    expect(codeOf(() => guard.resolve("inside.txt."))).toBe("PATH_TRAVERSAL");
    expect(codeOf(() => guard.resolve("dir./file.txt"))).toBe("PATH_TRAVERSAL");
    expect(codeOf(() => guard.resolve(join(root, "inside.txt.")))).toBe(
      "PATH_TRAVERSAL",
    );
  });

  it("still accepts '.' and '..' as the plain self and parent segments", () => {
    const root = makeTempWorkspace();
    mkdirSync(join(root, "src"));
    const guard = new PathGuard(root);
    expect(guard.resolve(".")).toBe(guard.workspaceRoot);
    expect(guard.resolve("src/..")).toBe(guard.workspaceRoot);
    expect(guard.resolve("src/../other.txt")).toBe(
      join(guard.workspaceRoot, "other.txt"),
    );
    // A bare '..' still escapes and is still reported as traversal.
    expect(codeOf(() => guard.resolve(".."))).toBe("PATH_TRAVERSAL");
  });

  it("does not certify a path whose '..' hop climbs out of the root", () => {
    const base = makeTempDir("zx-parent-");
    const root = join(base, "repo");
    mkdirSync(root);
    const outside = makeTempDir("zx-outside-");
    writeFileSync(join(outside, "secret.txt"), "TOP SECRET\n");
    symlinkSync(outside, join(base, "escape"), "junction");
    const guard = new PathGuard(root);
    // The un-collapsed spelling of a real outside read, through a real junction.
    const viaParentHop = rawJoin(root, "..", "escape", "secret.txt");
    expect(
      execFileSync("cmd.exe", ["/c", "type", viaParentHop], {
        encoding: "utf8",
      }),
    ).toBe("TOP SECRET\n");
    // A parent hop must never leave a string certified as inside. `P.resolve`
    // folds the `..` before `verify` ever sees it today, and `isWithin` folds it
    // again; this pins the outcome rather than either mechanism.
    expect(guard.isInside(viaParentHop)).toBe(false);
    expect(codeOf(() => guard.assertInside(viaParentHop))).toBe(
      "PATH_OUTSIDE_SANDBOX",
    );
  });

  it.runIf(onWindows)(
    "agrees with itself about a trailing dot, whatever the callee does",
    () => {
      // Pins the premise behind the check rather than the check itself. A future
      // Windows build on which `cmd.exe` stops aliasing a trailing dot does not
      // weaken the guard, but it does mean the justification in the source needs
      // re-measuring instead of being carried forward as folklore.
      const root = makeTempWorkspace();
      writeFileSync(join(root, "inside.txt"), "INSIDE\n");
      const dotted = rawJoin(root, "inside.txt.");
      expect(() => readFileSync(dotted)).toThrow();
      expect(execFileSync("cmd.exe", ["/c", "type", dotted], {
        encoding: "utf8",
      })).toBe("INSIDE\n");
    },
  );
});

describe("PathGuard: assertInside runs the same lexical chain as resolve", () => {
  // `assertInside` is public and its JSDoc invites use for paths the bridge
  // produced, so it is an entry point a hostile string can reach. It used to run
  // only the control-character, UNC and filesystem checks, which left every
  // lexical check below open through it.
  it("rejects an alternate data stream, which no directory listing shows", () => {
    const root = makeTempWorkspace();
    writeFileSync(join(root, "a.txt"), "base\n");
    writeFileSync(join(root, "a.txt:hidden"), "hidden\r\n");
    const guard = new PathGuard(root);
    const ads = join(guard.workspaceRoot, "a.txt:hidden");
    // The stream is real and readable, so this is a live input, not a hypothesis.
    expect(readFileSync(ads, "utf8")).toBe("hidden\r\n");
    expect(codeOf(() => guard.assertInside(ads))).toBe("PATH_TRAVERSAL");
    expect(codeOf(() => guard.isInside(ads))).toBe("PATH_TRAVERSAL");
  });

  it("rejects a reserved device name", () => {
    const root = makeTempWorkspace();
    const guard = new PathGuard(root);
    expect(codeOf(() => guard.assertInside(join(root, "NUL")))).toBe(
      "RESERVED_DEVICE_NAME",
    );
    expect(codeOf(() => guard.assertInside(join(root, "com1.log")))).toBe(
      "RESERVED_DEVICE_NAME",
    );
  });

  it("rejects a segment with a trailing space or dot", () => {
    const root = makeTempWorkspace();
    const guard = new PathGuard(root);
    expect(codeOf(() => guard.assertInside(rawJoin(root, ".. ")))).toBe(
      "PATH_TRAVERSAL",
    );
    expect(codeOf(() => guard.assertInside(rawJoin(root, "a.txt.")))).toBe(
      "PATH_TRAVERSAL",
    );
  });

  it("rejects tilde expansion", () => {
    const root = makeTempWorkspace();
    const guard = new PathGuard(root);
    // The tilde check is about a leading `~`; the point here is only that
    // `assertInside` now runs it at all.
    expect(codeOf(() => guard.assertInside("~/.ssh/id_rsa"))).toBe(
      "PATH_TRAVERSAL",
    );
  });

  it("rejects the empty string", () => {
    const root = makeTempWorkspace();
    const guard = new PathGuard(root);
    expect(codeOf(() => guard.assertInside(""))).toBe("PATH_TRAVERSAL");
  });

  it("rejects a path over the length limit", () => {
    const root = makeTempWorkspace();
    const guard = new PathGuard(root);
    const long = rawJoin(
      guard.workspaceRoot,
      Array.from({ length: 8 }, () => "d".repeat(60)).join(sep),
    );
    expect(long.length).toBeGreaterThan(260);
    expect(codeOf(() => guard.assertInside(long))).toBe("PATH_TOO_LONG");
  });

  it("still accepts a plain path inside the root", () => {
    const root = makeTempWorkspace();
    writeFileSync(join(root, "a.txt"), "x");
    const guard = new PathGuard(root);
    expect(() =>
      guard.assertInside(join(guard.workspaceRoot, "a.txt")),
    ).not.toThrow();
  });
});

describe("PathGuard: error rendering", () => {
  it("escapes bidi and line-separator controls, so an approval prompt cannot be rewritten", () => {
    const root = makeTempWorkspace();
    const guard = new PathGuard(root);
    // Containment is not at stake here; the human reading the approval prompt is.
    // U+202E renders the rest of the string right-to-left, so a path shown as
    // `src/notes.txt` can be made to display as something else entirely.
    const controls: ReadonlyArray<readonly [string, string]> = [
      ["\u202E", "\\u202e"],
      ["\u202C", "\\u202c"],
      ["\u2028", "\\u2028"],
      ["\u2029", "\\u2029"],
      ["\u0085", "\\x85"],
    ];
    for (const [raw, escaped] of controls) {
      const error = zxErrorOf(
        () => guard.resolve(`../${raw}gnp.exe`),
        "PATH_TRAVERSAL",
      );
      const rendered = String(error.detail?.input);
      expect(rendered).not.toContain(raw);
      expect(rendered).toContain(escaped);
    }
  });

  it("still escapes NUL and newline", () => {
    const root = makeTempWorkspace();
    const guard = new PathGuard(root);
    const error = zxErrorOf(
      () => guard.resolve("../a\u0000b"),
      "PATH_TRAVERSAL",
    );
    expect(String(error.detail?.input)).toContain("\\x00");
  });
});

describe("PathGuard: constructor", () => {
  it("throws a ZxError, not a raw errno, when the root does not exist", () => {
    const root = makeTempWorkspace();
    const missing = join(root, "no-such-dir");
    const error = zxErrorOf(() => new PathGuard(missing), "INTERNAL");
    expect(String(error.detail?.root)).toContain("no-such-dir");
  });

  it.runIf(onWindows)(
    "throws a ZxError when the root cannot be read",
    () => {
      zxErrorOf(() => new PathGuard("C:/Windows/System32/config"), "INTERNAL");
    },
  );
});

describe("PathGuard: documented downstream contract", () => {
  // The one finding here that is prose rather than behaviour, so it is the one
  // that can only be pinned by reading the source. It is pinned because the
  // failure it prevents — a caller re-joining the resolved string — is invisible
  // to every runtime test, and a JSDoc tidy-up is exactly how it would come back.
  it("tells callers never to re-join the resolved path", () => {
    const source = readFileSync(PATH_GUARD_SOURCE, "utf8");
    expect(jsdocAbove(source, "resolve(relativeOrAbsolutePath")).toMatch(
      /never re-join/i,
    );
    expect(jsdocAbove(source, "get workspaceRoot")).toMatch(/never re-join/i);
  });
});

/** The `/** ... *\/` block immediately above the line containing `anchor`. */
function jsdocAbove(source: string, anchor: string): string {
  const at = source.indexOf(anchor);
  if (at === -1) throw new Error(`anchor not found in source: ${anchor}`);
  const before = source.slice(0, at);
  const open = before.lastIndexOf("/**");
  const close = before.lastIndexOf("*/");
  if (open === -1 || close === -1 || close < open) {
    throw new Error(`no JSDoc block above: ${anchor}`);
  }
  return before.slice(open, close + 2);
}

describe("PathGuard: reparse point detection", () => {
  // Pins the platform fact the implementation relies on: if a future Node or a
  // different Windows build stops reporting a junction through
  // `lstat().isSymbolicLink()`, the per-segment link check silently stops
  // firing and this test fails first.
  it("reports a Windows junction through lstat().isSymbolicLink()", () => {
    const root = makeTempWorkspace();
    const target = makeTempDir("zx-junction-target-");
    const link = join(root, "link");
    symlinkSync(target, link, "junction");
    const stats = lstatSync(link);
    expect(stats.isSymbolicLink()).toBe(true);
    expect(stats.isDirectory()).toBe(false);
  });
});

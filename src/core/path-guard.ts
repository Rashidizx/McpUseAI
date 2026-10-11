import { lstatSync, realpathSync, type Stats } from "node:fs";
import { posix, win32, type PlatformPath } from "node:path";
import { ZxError } from "./errors.js";

const IS_WINDOWS = process.platform === "win32";

/** `path.win32` on Windows, `path.posix` elsewhere. */
const P: PlatformPath = IS_WINDOWS ? win32 : posix;

/**
 * Maximum length of a path this module will hand to the OS.
 *
 * The classic un-extended Win32 limit is `MAX_PATH` = 260 characters; the
 * extended limit reachable through a `\\?\` prefix is 32767. This module
 * deliberately enforces 260 on Windows and `PATH_MAX` = 4096 elsewhere, and
 * rejects anything longer with `PATH_TOO_LONG`, because:
 *
 *   - The guard never emits a `\\?\`-prefixed path. That prefix is the only way
 *     to legitimately address a path longer than 260 through Win32, and it also
 *     switches off the path normalisation the checks above depend on, so
 *     `\\?\GLOBALROOT\Device\...` would become a legal input. Refusing long
 *     paths outright removes that whole class instead of trying to police it.
 *   - A predictable, named failure is far easier to act on than the
 *     `ENAMETOOLONG`/`ENOENT` the OS would otherwise raise deep inside a
 *     tool, sometimes on a different path than the one the caller supplied.
 *
 * Note this machine has `HKLM\...\FileSystem\LongPathsEnabled = 1`, so the OS
 * itself would tolerate longer paths. The cap is therefore a deliberate,
 * self-imposed limit rather than a mirror of what the kernel enforces; a
 * deployment that needs deeper trees can raise this constant deliberately
 * rather than discovering the boundary through an opaque syscall failure.
 */
const MAX_PATH_LENGTH = IS_WINDOWS ? 260 : 4096;

/** ASCII control characters, `0x00`–`0x1F`. A NUL byte truncates a path in the Win32 API. */
const CONTROL_CHARACTERS = /[\u0000-\u001f]/;

const RESERVED_DEVICE_NAMES: ReadonlySet<string> = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

/**
 * Separator run, on either platform.
 *
 * A backslash is a separator on Windows and an ordinary filename character on
 * POSIX, so splitting on both everywhere would quietly turn the POSIX file
 * `a\b.txt` into two segments. Backslashes are therefore folded onto forward
 * slashes on Windows only, where both spellings already mean the same thing.
 */
const SEPARATORS = IS_WINDOWS ? /[\\/]+/ : /\/+/;

/** Trailing spaces and dots, which Win32 silently strips from a name. */
const TRAILING_NOISE = /[ .]+$/;

/** Node error codes that mean "this path does not exist", as opposed to "this failed". */
const MISSING_CODES: ReadonlySet<string> = new Set([
  "ENOENT",
  "ENOTDIR",
  "ENAMETOOLONG",
]);

/**
 * Render a caller-supplied path for an error message or a log record.
 *
 * Control characters are escaped rather than echoed, so a NUL byte or a newline
 * cannot truncate or forge a log line, and the result is truncated so a
 * multi-kilobyte path cannot flood the audit log.
 *
 * The escape set is wider than "printable" on purpose. It includes `U+2028` and
 * `U+2029`, which are line terminators to a JavaScript renderer but not to
 * `JSON.stringify`, and `U+202E`/`U+202C`, the bidi override pair. Containment is
 * not at stake in a bidi control: it is the human reading the approval prompt
 * that is, because a path shown as `src/notes.txt` can be made to display as
 * something else entirely while the guard logs and compares the real thing.
 */
function describePath(input: string): string {
  const escaped = input.replace(
    /[\u0000-\u001f\u007f\u0085\u2028-\u202e]/g,
    (char) => {
      const code = char.charCodeAt(0);
      const hex = code.toString(16).padStart(2, "0");
      return code > 0xff ? `\\u${hex}` : `\\x${hex}`;
    },
  );
  return escaped.length > 200 ? `${escaped.slice(0, 200)}…` : escaped;
}

function splitSegments(value: string): string[] {
  return value.split(SEPARATORS).filter((segment) => segment.length > 0);
}

/** Windows compares path components case-insensitively; POSIX does not. */
function sameSegment(left: string, right: string): boolean {
  return IS_WINDOWS
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/**
 * Is `candidate` the root itself, or somewhere beneath it?
 *
 * Compared component by component, not with `startsWith`: a prefix comparison
 * cannot tell `C:\repo` from `C:\repository`, so a sibling directory whose name
 * merely begins with the sandbox name would pass. Component comparison also
 * makes the case-insensitive rule fall out for free instead of being bolted on.
 *
 * The candidate is folded first, so a `..` that is still written out in the
 * string cannot masquerade as a shared prefix. `C:\repo\..\outside` shares its
 * first two components with `C:\repo` and is nonetheless outside it. Every caller
 * today happens to hand this function an already-collapsed path, so folding is
 * currently the second line rather than the only one — which is the point: the
 * boundary predicate should not depend on each caller having remembered.
 */
function isWithin(root: string, candidate: string): boolean {
  const rootSegments = splitSegments(root);
  const candidateSegments = collapseSegments(
    splitSegments(candidate),
  ).segments;
  if (candidateSegments.length < rootSegments.length) return false;
  for (let index = 0; index < rootSegments.length; index += 1) {
    if (!sameSegment(rootSegments[index] ?? "", candidateSegments[index] ?? "")) {
      return false;
    }
  }
  return true;
}

function isMissingError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code !== undefined && MISSING_CODES.has(code);
}

function messageOf(error: unknown): string {
  return (error as NodeJS.ErrnoException | null)?.message ?? String(error);
}

// ---------------------------------------------------------------------------
// Phase 1 — cheap lexical rejections, in order, before any filesystem access.
//
// A path rejected here costs a few string scans and causes no filesystem traffic
// whatsoever. Phase 2 does consult path metadata — but only metadata, never file
// contents — because on this platform a lexical check cannot see a junction.
// ---------------------------------------------------------------------------

/** NUL bytes and the other ASCII control characters. */
function assertNoControlCharacters(input: string): void {
  if (!CONTROL_CHARACTERS.test(input)) return;
  throw new ZxError(
    "PATH_TRAVERSAL",
    "path contains an ASCII control character, which truncates or forges a path in the Win32 API",
    { input: describePath(input) },
  );
}

/**
 * UNC paths, and the `\\?\` / `\\.\` device prefixes.
 *
 * `\\server\share` reaches a share on another machine and `\\.\NUL` reaches a
 * device; the sandbox root is always a local directory, so neither can be inside
 * it. Both spellings are caught because separators are compared after folding
 * backslashes onto forward slashes.
 */
function assertNotUnc(input: string): void {
  if (!input.replace(/\\/g, "/").startsWith("//")) return;
  throw new ZxError(
    "PATH_OUTSIDE_SANDBOX",
    "UNC and device paths cannot be inside a local sandbox",
    { input: describePath(input) },
  );
}

/**
 * Alternate data streams.
 *
 * `file.txt:hidden.exe` is invisible to every directory listing yet fully
 * readable and writable, so on Windows it is a real containment escape rather
 * than a curiosity. The only `:` that is not an ADS designator is the drive
 * letter colon of an absolute path, which is the one case allowed through — and
 * only on Windows, where such a path can denote the sandbox at all. A separator
 * must follow that colon, so a bare `C:` (a drive-relative reference to that
 * drive's current directory) is rejected rather than being treated as a name.
 */
function assertNoAlternateDataStream(input: string): void {
  const colon = input.indexOf(":");
  if (colon === -1) return;
  const isDriveLetter =
    IS_WINDOWS &&
    colon === 1 &&
    /[A-Za-z]/.test(input.charAt(0)) &&
    (input.charAt(2) === "/" || input.charAt(2) === "\\") &&
    !input.includes(":", 2);
  if (isDriveLetter) return;
  throw new ZxError(
    "PATH_TRAVERSAL",
    "path contains an alternate data stream designator",
    { input: describePath(input) },
  );
}

/**
 * `~` at the start of a path.
 *
 * A tool call reaching this module is not a shell, so `~` is never expanded
 * into a home directory — it would silently become a directory literally named
 * `~` inside the sandbox, and the caller would read that as their SSH key.
 */
function assertNoTilde(input: string): void {
  if (!input.startsWith("~")) return;
  throw new ZxError(
    "PATH_TRAVERSAL",
    "home directory expansion is not permitted in the sandbox",
    { input: describePath(input) },
  );
}

/**
 * Reserved Win32 device names, in any segment, with or without an extension.
 *
 * `CON` is the console device whatever directory it is named in, so writing to
 * `root\CON` does not write a file called `CON` — it writes to the console. The
 * check runs against the part of the segment before the first `.`, which is how
 * Win32 decides, so `CON` and `con.txt` are both rejected while `console.ts` is
 * not. Trailing spaces and dots are stripped first because Win32 strips them
 * before matching, which would otherwise turn `CON ` back into `CON`.
 */
function assertNoReservedDeviceNames(segments: readonly string[]): void {
  for (const segment of segments) {
    if (segment === "." || segment === "..") continue;
    const stem = (segment.split(".")[0] ?? "").replace(TRAILING_NOISE, "");
    const name = stem.toLowerCase();
    if (!RESERVED_DEVICE_NAMES.has(name)) continue;
    throw new ZxError(
      "RESERVED_DEVICE_NAME",
      `path uses the reserved device name: ${describePath(segment)}`,
      { segment: describePath(segment) },
    );
  }
}

/**
 * Segments ending in a space or a dot.
 *
 * Such a segment is not a name the platform agrees on, so no layer downstream can
 * be relied on to fail closed on it. Measured on this machine: `node:fs` refuses
 * `root\.. ` with `ENOENT`, while `cmd.exe` accepts `root\inside.txt.` and opens
 * the real file. The guard therefore cannot treat the callee's error as the
 * safety net — a `git_*` or `exec` tool resolves names natively and would not
 * produce one. Rejecting the segment is correct rather than merely defensive: a
 * name with trailing space or dot is not a legal Win32 name, so no legitimate
 * caller can be relying on it.
 *
 * The plain segments `.` and `..` are exempt, because they are how a caller spells
 * "here" and "up", not a name with noise on the end.
 */
function assertNoTrailingSpaceOrDot(segments: readonly string[]): void {
  for (const segment of segments) {
    if (segment === "." || segment === "..") continue;
    if (!TRAILING_NOISE.test(segment)) continue;
    throw new ZxError(
      "PATH_TRAVERSAL",
      `path segment ends in a space or a dot, which is not a name the platform resolves consistently: ${describePath(segment)}`,
      { segment: describePath(segment) },
    );
  }
}

/**
 * The empty string.
 *
 * `resolve("")` would otherwise return the root, which converts a caller bug into
 * an `EISDIR` raised deep inside a tool that has no idea the path was empty. `.`
 * and `./` remain valid ways of naming the root — `fs_list` needs them — so the
 * rejection is on emptiness alone, not on "resolves to the root".
 *
 * `PATH_TRAVERSAL` is the code because this module already uses it for every
 * input that is malformed rather than merely wrong: a NUL byte, an ADS
 * designator, and a leading `~` all report it, and an empty path belongs to that
 * family. No existing code names "this is not a path at all" more precisely, and
 * inventing one is out of scope for this module.
 */
function assertNotEmpty(input: string): void {
  if (input.length > 0) return;
  throw new ZxError(
    "PATH_TRAVERSAL",
    "path is the empty string, which is not a path; use '.' for the sandbox root",
    { input: "" },
  );
}

function assertNotTooLong(input: string, candidate: string): void {
  if (input.length <= MAX_PATH_LENGTH && candidate.length <= MAX_PATH_LENGTH) {
    return;
  }
  throw new ZxError(
    "PATH_TOO_LONG",
    `path exceeds the ${MAX_PATH_LENGTH}-character limit`,
    {
      limit: MAX_PATH_LENGTH,
      input_length: input.length,
      candidate_length: candidate.length,
    },
  );
}

// ---------------------------------------------------------------------------

/**
 * The sandbox boundary for every `fs_*` tool.
 *
 * The threat is a prompt-injected web chat, so path strings arrive from a
 * remote untrusted party and every one of them is hostile. Lexical checks alone
 * are not enough: on Windows a directory inside the workspace can be a junction
 * pointing anywhere on the disk, and a junction is invisible to string analysis.
 * `resolve` therefore does three things in order — reject the input
 * lexically, walk the real filesystem to see where the path actually lands, and
 * only then hand back a canonical absolute path.
 *
 * Every rejection is a `ZxError` carrying the code that names the actual
 * failure; no new codes are invented for this module.
 */
export class PathGuard {
  /**
   * The sandbox root as the filesystem reports it.
   *
   * The root is resolved once with `realpathSync.native`, because the configured
   * root may not name the real location: a workspace configured as `C:\ws` that
   * is really a junction to `D:\real-ws` must be compared against
   * `D:\real-ws`, or every later comparison is against a path that does not
   * describe the files being opened. The same call expands an 8.3 short name
   * (`C:\Users\MRRASH~1.E\…`) into the long form, so the root is the one path
   * this module can compare without guessing.
   */
  private readonly realRoot: string;

  constructor(workspaceRoot: string) {
    // A root that cannot be resolved is a host-configuration fault, and letting a
    // raw `ENOENT`/`EACCES` escape here would break the promise this module makes
    // to every caller above it: everything that leaves PathGuard is a ZxError.
    try {
      this.realRoot = realpathSync.native(P.resolve(workspaceRoot));
    } catch (error) {
      throw new ZxError(
        "INTERNAL",
        `could not resolve the workspace root: ${messageOf(error)}`,
        { root: describePath(workspaceRoot), cause: messageOf(error) },
      );
    }
  }

  /**
   * The true, canonical location of the sandbox root.
   *
   * ## Contract: never re-join this with a caller-supplied name.
   *
   * The obvious downstream shape — validate a directory, then
   * `join(guard.workspaceRoot, dir, name)` and write — silently discards every
   * check this module performs. The joined string was never seen by
   * {@link resolve}, so nothing about it has been verified: a `name` containing
   * `..`, a trailing space, or an ADS designator walks straight back out of the
   * sandbox, and the guard's name lends the result an authority it has not earned.
   *
   * Resolving the whole path is the only supported way to address a file:
   * `guard.resolve(join(relativeDir, name))`, which applies the full chain to
   * the finished string. This getter exists for the rare case of addressing the
   * root directory itself — and for building the input to {@link resolve}, not the
   * output of it.
   */
  get workspaceRoot(): string {
    return this.realRoot;
  }

  /** True when `absolutePath` resolves to the root or something beneath it. */
  isInside(absolutePath: string): boolean {
    try {
      this.assertInside(absolutePath);
      return true;
    } catch (error) {
      // Only a genuine "not in the sandbox" verdict becomes `false`. A malformed
      // path (NUL byte, reserved name) is a caller bug and keeps propagating
      // rather than being reported as "not inside".
      if (error instanceof ZxError && error.code === "PATH_OUTSIDE_SANDBOX") {
        return false;
      }
      throw error;
    }
  }

  /**
   * Throw unless `absolutePath` is inside the sandbox, links included.
   *
   * This is the check for paths the bridge itself produced, so it performs the
   * same filesystem verification as {@link resolve} rather than trusting the
   * string it was handed — and the same Phase 1 lexical chain, through
   * {@link checkLexical}. The two entry points used to differ, and the gap was
   * reachable: an alternate data stream no directory listing shows, or a reserved
   * device name, passed straight through here while {@link resolve} rejected it.
   *
   * It is a public method whose JSDoc invites use on a string the bridge produced,
   * which makes it exactly as much an untrusted-input surface as {@link resolve}.
   * Sharing one chain is what keeps it that way; a guard whose two doors validate
   * differently is a defect waiting to be found.
   */
  assertInside(absolutePath: string): void {
    this.checkLexical(absolutePath);
    const candidate = P.resolve(absolutePath);
    assertNotTooLong(absolutePath, candidate);
    this.verify(candidate, absolutePath);
  }

  /**
   * Phase 1, the lexical chain, shared by both entry points.
   *
   * Ordered cheapest-first, and every rejection here costs a few string scans and
   * no filesystem traffic at all. Returns the input's segments so {@link resolve}
   * can collapse them without splitting a second time.
   */
  private checkLexical(input: string): string[] {
    assertNotEmpty(input);
    assertNoControlCharacters(input);
    assertNotUnc(input);
    assertNoAlternateDataStream(input);
    assertNoTilde(input);

    const segments = splitSegments(input);
    // Device names first, because `CON ` is genuinely a reserved name and
    // RESERVED_DEVICE_NAME names that more precisely than the trailing-noise
    // check below, which would otherwise report it as PATH_TRAVERSAL.
    assertNoReservedDeviceNames(segments);
    assertNoTrailingSpaceOrDot(segments);
    return segments;
  }

  /**
   * Resolve a caller-supplied path to a canonical absolute path inside the
   * sandbox, or throw.
   *
   * The caller supplies a path relative to the workspace. An absolute one is
   * accepted only when it is genuinely inside the sandbox, which is what lets a
   * tool round-trip a path it was itself handed; anything else is either a bug
   * or an attempt to address the disk directly. A not-yet-existing file is
   * legitimate — that is how `fs_write` creates a file — so the filesystem walk
   * resolves the deepest existing ancestor and re-attaches the remainder rather
   * than failing.
   *
   * ## Contract: hand this exact string to the OS. Never re-join it.
   *
   * The value is the *checked* path. Re-joining it with anything —
   * `join(result, name)`, `resolve(result, "..")`, string concatenation, a
   * `shell: true` spawn — discards every check this module performed, because
   * the checks applied to the string that was handed in and not to whatever you
   * build afterwards. That is the most likely way this guard gets defeated in
   * practice, and it defeats itself: the result still *looks* like a verified
   * path because it came out of here.
   *
   * To address a file, resolve that file. If you must combine a verified
   * directory with a name, resolve the joined path and let the guard check the
   * whole thing.
   */
  resolve(relativeOrAbsolutePath: string): string {
    const input = relativeOrAbsolutePath;

    // Phase 1: lexical. Nothing here touches the filesystem.
    const rawSegments = this.checkLexical(input);

    if (P.isAbsolute(input)) {
      const candidate = P.resolve(input);
      assertNotTooLong(input, candidate);
      // Deliberately no *textual* containment pre-check here. The configured
      // root routinely arrives in its 8.3 short form (`C:\Users\MRRASH~1.E\…`)
      // while `realRoot` is the long form, so comparing the strings would reject
      // the sandbox's own root. `verify` consults the filesystem, which is the
      // only thing that can tell an alias of the root from a path that really is
      // somewhere else.
      return this.verify(candidate, input);
    }

    // `..` is collapsed here, against the segment stack rather than against the
    // filesystem, and every `..` is consumed before the walk begins. A `..` that
    // would climb above the root is recorded rather than thrown immediately, so
    // the length check still runs first and the reported code names the more
    // specific problem.
    const { segments, escaped } = collapseSegments(rawSegments);
    const candidate = P.join(this.realRoot, ...segments);
    assertNotTooLong(input, candidate);

    if (escaped) {
      throw new ZxError(
        "PATH_TRAVERSAL",
        "parent directory traversal escapes the sandbox",
        { input: describePath(input) },
      );
    }

    // Phase 2: the filesystem, which is where a lexical check has no say.
    return this.verify(candidate, input);
  }

  /**
   * Phase 2: follow the links, then confirm the real location is still inside
   * the real root.
   */
  private verify(candidate: string, input: string): string {
    this.assertNoEscapingLink(candidate, input);
    let resolved: string;
    try {
      resolved = this.realPathOfDeepestExisting(candidate);
    } catch (error) {
      // The filesystem refused to say where this path is — `EPERM` on a
      // protected system directory such as `C:\Windows\System32\config`, for
      // instance. That refusal must not be reported as an internal fault: if the
      // path is not even textually inside the root, the boundary answer does not
      // depend on the filesystem at all. Only a path that claims to be inside and
      // then cannot be verified is a genuine internal failure.
      if (!isWithin(this.realRoot, candidate)) {
        throw this.outsideSandbox(candidate, input);
      }
      throw this.filesystemFailure(candidate, error);
    }
    if (!isWithin(this.realRoot, resolved)) {
      throw this.outsideSandbox(resolved, input);
    }
    return resolved;
  }

  private outsideSandbox(resolved: string, input: string): ZxError {
    return new ZxError(
      "PATH_OUTSIDE_SANDBOX",
      `path resolves outside the workspace sandbox: ${describePath(input)}`,
      {
        root: this.realRoot,
        input: describePath(input),
        resolved,
      },
    );
  }

  /**
   * Refuse any existing path segment that is a link escaping the sandbox.
   *
   * On this Node version `lstat` reports a Windows junction through
   * `isSymbolicLink() === true` (and `isDirectory() === false`, so the directory
   * predicate must not be used to spot one). Each existing prefix is stat'ed
   * without following it, and a link is only accepted if its own target is still
   * inside the real root.
   *
   * The final containment check in {@link resolve} would also catch an escaping
   * junction, because `realpathSync` follows every reparse point in the
   * existing prefix. This walk is kept as an independent check: it names the
   * offending segment instead of only the final location, and it does not depend
   * on `realpathSync` behaving as documented.
   */
  private assertNoEscapingLink(candidate: string, input: string): void {
    // Only a candidate that is textually under the root can be walked relative to
    // it. For anything else the relative path would be a chain of `..` climbing
    // out of the sandbox, and inspecting those segments would mean stat'ing paths
    // outside the boundary — and could reject a legitimate 8.3 alias of the root
    // just because some parent directory up the chain happens to be a link. The
    // realpath check below is what decides those cases.
    if (!isWithin(this.realRoot, candidate)) return;
    const relative = P.relative(this.realRoot, candidate);
    let current = this.realRoot;
    for (const segment of splitSegments(relative)) {
      current = P.join(current, segment);
      let stats: Stats | undefined;
      try {
        stats = lstatSync(current, { throwIfNoEntry: false });
      } catch {
        // This segment cannot be inspected (permissions, a broken mount). Giving
        // up on the walk is safe because the authoritative check is the realpath
        // in `verify`: it either proves the path lands inside the root or the
        // operation fails. A skipped `lstat` cannot turn an outside path into an
        // accepted one.
        return;
      }
      if (stats === undefined) return;
      if (!stats.isSymbolicLink()) continue;
      let target: string;
      try {
        target = realpathSync.native(current);
      } catch {
        // A link whose target does not exist — or cannot be read — escapes
        // nothing that the realpath below would not catch, and the operation
        // itself will fail. Defer rather than guess.
        return;
      }
      if (isWithin(this.realRoot, target)) continue;
      throw new ZxError(
        "PATH_OUTSIDE_SANDBOX",
        `path segment is a link that escapes the workspace sandbox: ${describePath(segment)}`,
        {
          root: this.realRoot,
          input: describePath(input),
          segment: describePath(segment),
          link: current,
          target,
        },
      );
    }
  }

  /**
   * The real path of `target`, resolving the deepest ancestor that exists and
   * re-attaching the part that does not.
   *
   * `realpathSync` on a missing path throws, but a path that does not exist yet
   * is exactly the normal case for `fs_write`, so the missing tail is carried
   * along instead of being treated as a failure. Any other failure propagates
   * for {@link verify} to classify.
   */
  private realPathOfDeepestExisting(target: string): string {
    const missing: string[] = [];
    let current = target;
    for (;;) {
      try {
        const real = realpathSync.native(current);
        return missing.length === 0 ? real : P.join(real, ...missing);
      } catch (error) {
        if (!isMissingError(error)) throw error;
        const parent = P.dirname(current);
        const base = P.basename(current);
        if (
          parent === current ||
          base.length === 0 ||
          base === "." ||
          base === ".."
        ) {
          return current;
        }
        missing.unshift(base);
        current = parent;
      }
    }
  }

  private filesystemFailure(path: string, error: unknown): ZxError {
    return new ZxError(
      "INTERNAL",
      `could not verify path against the sandbox: ${messageOf(error)}`,
      { path, cause: messageOf(error) },
    );
  }
}

/**
 * Fold `.` and `..` away into a stack of real segments.
 *
 * Collapsing `..` against the stack rather than the filesystem is deliberate: a
 * `..` that trails a junction is resolved by the OS against the *link's* target,
 * not against the link's parent, which is a long-standing way to make a path that
 * looks contained behave otherwise. Collapsing first leaves the walk with a
 * `..`-free segment list, so the two can never disagree.
 */
function collapseSegments(segments: readonly string[]): {
  segments: string[];
  escaped: boolean;
} {
  const stack: string[] = [];
  let escaped = false;
  for (const segment of segments) {
    if (segment === ".") continue;
    if (segment === "..") {
      if (stack.length === 0) {
        escaped = true;
        continue;
      }
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return { segments: stack, escaped };
}

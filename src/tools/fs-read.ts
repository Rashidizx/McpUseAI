import { statSync, readFileSync } from "node:fs";

import { ZxError } from "../core/errors.js";
import { asZxError } from "./fs-errors.js";
import { decodeFile, type Eol } from "../core/text-io.js";
import type { PathGuard } from "../core/path-guard.js";
import type { ToolDefinition } from "../core/tool-registry.js";

export type FsReadArgs = {
  /** Path relative to the workspace root. Never absolute-from-caller. */
  file_path: string;

  /** 1-based line to start from. Defaults to the first line. */
  start_line?: number;

  /** How many lines to return. Defaults to a bounded page. */
  line_count?: number;
};

/** What `fs_read` gives back. */
export type FsReadData = {
  /** The requested slice, with the file's own line endings preserved. */
  text: string;

  /** Lines in the whole file, so a caller can page without re-reading. */
  total_lines: number;

  /** The line ending this file uses, so a later write reproduces it. */
  eol: Eol;

  /** Whether the file starts with a UTF-8 BOM. */
  had_bom: boolean;

  /** Echo of what was actually returned, after clamping. */
  start_line: number;
  returned_lines: number;

  /**
   * Whether more lines follow. A model that pages through a file needs to know
   * to ask again, and without this it will silently believe it read the whole
   * thing - which is how a truncated file gets edited from the model's point of
   * view and corrupted on disk.
   */
  has_more: boolean;
};

/**
 * Default page size.
 *
 * Bounded because the alternative is a model asking for a 400 MB file and
 * pushing all of it through the chat window in one turn. A page large enough to
 * be useful, small enough to be survivable.
 */
const DEFAULT_LINE_COUNT = 2_000;

/**
 * Largest file this will read at all.
 *
 * A log or a bundled asset can be gigabytes, and the point of refusing is not
 * that reading is dangerous - it is that the *result* would not fit anywhere
 * useful. Beyond this the user is better served by `exec` running a filter,
 * which they approve explicitly and which returns something small.
 */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

/**
 * Read a file from inside the sandbox, with pagination.
 *
 * ## The rule that must not be broken: use what `resolve()` returned
 *
 * This tool hands `guard.resolve()`'s output **directly** to the filesystem. It
 * must never re-join the path against the workspace root, and it must never
 * accept a second, caller-supplied root. That is not a style preference: the
 * string `resolve()` returns is the last point where containment was decided,
 * and any string surgery after it is a chance to rebuild a path that was just
 * refused. This is the F2-2 constraint, and it is why there is no `join` and no
 * second `PathGuard` call in this file.
 *
 * ## Why a directory is a different error
 *
 * Reading a directory raises `EISDIR` on some platforms and hands back a
 * directory listing as content on others - macOS returns its entries when a file
 * is read as text. That inconsistency would surface as "a file" containing names
 * the model then reasons over, so it is refused up front as `NOT_A_DIRECTORY`.
 *
 * ## Why the page is never silently short
 *
 * Every response reports `total_lines` and `has_more`. A tool that returned the
 * first 2000 lines of a 20000-line file with no signal would let the model edit a
 * file on the belief that it had seen all of it.
 */
export function createFsRead(guard: PathGuard): ToolDefinition<FsReadArgs> {
  /**
   * Reject a path the sandbox will not allow, *before* anyone is asked to approve.
   *
   * Without this, `../../../Windows/System32` gets as far as the approval prompt
   * and is only refused afterwards, so the user is asked to consent to an
   * operation that cannot happen. That is worse than a wasted click: a prompt the
   * user learns to approve without reading is exactly the habit a prompt-injected
   * page is trying to buy, and spending it on impossible requests spends it early.
   *
   * The resolved path is discarded. `run` resolves again and that second result
   * is what reaches the filesystem, so containment is decided as late as possible
   * rather than being frozen here one layer earlier.
   */
  const validatePath = (filePath: string): string => {
    guard.resolve(filePath);
    return filePath;
  };

  return {
    name: "fs_read",
    opClass: "read",

    describe: () =>
      "{file_path, start_line?, line_count?} Read a text file from inside the workspace. Supports paging with " +
      "start_line and line_count, and reports the total line count so a large " +
      "file can be read in pieces. Preserves the file's own line endings and BOM.",

    parseArgs: (raw) => parseReadArgs(raw, validatePath),

    summarize: (args) => `read ${args.file_path}`,

    // Names the attempted path even when the sandbox refused it, so the audit
    // trail records what was tried rather than only that arguments failed.
    summarizeRaw: (raw) => {
      const candidate =
        raw !== null && typeof raw === "object"
          ? (raw as Record<string, unknown>).file_path
          : undefined;
      return typeof candidate === "string" && candidate !== ""
        ? `read ${candidate}`
        : "read <no file_path>";
    },

    run: async (args) => {
      // F2-2: this exact string goes to the filesystem. No join, no re-resolve.
      const absolute = guard.resolve(args.file_path);

      // Every filesystem call below is wrapped: `statSync` and `readFileSync`
      // throw raw `Error`s carrying an `errno`, which would leave this module
      // violating its promise that everything leaving it is a `ZxError`.
      let stats: ReturnType<typeof statSync> | undefined;
      try {
        stats = statSync(absolute, { throwIfNoEntry: false });
      } catch (error) {
        throw asZxError(error, { action: "read", file_path: args.file_path });
      }
      if (stats === undefined) {
        throw new ZxError(
          "FILE_NOT_FOUND",
          `no such file in the workspace: ${args.file_path}`,
          { file_path: args.file_path },
        );
      }
      // F2-7: a directory is not a file, and reading one is platform-dependent.
      if (stats.isDirectory()) {
        throw new ZxError(
          "NOT_A_DIRECTORY",
          `${args.file_path} is a directory, not a file`,
          { file_path: args.file_path },
        );
      }
      if (!stats.isFile()) {
        throw new ZxError(
          "FILE_NOT_FOUND",
          `${args.file_path} is not a regular file`,
          { file_path: args.file_path },
        );
      }
      if (stats.size > MAX_FILE_BYTES) {
        throw new ZxError(
          "BUDGET_EXCEEDED",
          `${args.file_path} is ${stats.size} bytes, above the ${MAX_FILE_BYTES}-byte read limit; use exec with a filter to read part of it`,
          { file_path: args.file_path, size: stats.size, limit: MAX_FILE_BYTES },
        );
      }

      let buffer: Buffer;
      try {
        buffer = readFileSync(absolute);
      } catch (error) {
        // Reachable between the stat and the read: the file can be deleted, or
        // locked by another process, in exactly that window.
        throw asZxError(error, { action: "read", file_path: args.file_path });
      }
      const decoded = decodeFile(buffer);
      const lines = splitLines(decoded.text, decoded.eol);

      const startLine = args.start_line ?? 1;
      const requested = args.line_count ?? DEFAULT_LINE_COUNT;
      // Only the lower bound is clamped. Clamping the upper one - so that
      // `start_line: 99` on a five-line file quietly returns the last line -
      // would answer a different question than the one asked, which is the same
      // silent-wrong-answer this tool refuses to do everywhere else. Past the end
      // means an empty page, and `returned_lines: 0` says so.
      const start = Math.max(startLine, 1);
      const slice = lines.slice(start - 1, start - 1 + requested);

      const hadTrailingEol = decoded.text.endsWith(decoded.eol);
      const data: FsReadData = {
        text: slice.join(decoded.eol) + (hadTrailingEol ? decoded.eol : ""),
        total_lines: lines.length,
        eol: decoded.eol,
        had_bom: decoded.hadBom,
        start_line: start,
        returned_lines: slice.length,
        has_more: start - 1 + slice.length < lines.length,
      };

      const window =
        data.total_lines > data.returned_lines
          ? ` lines ${data.start_line}-${data.start_line + data.returned_lines - 1} of ${data.total_lines}`
          : "";
      return { summary: `read ${args.file_path} (${data.returned_lines}${window})`, data };
    },
  };
}

/**
 * Split into lines without inventing a trailing empty one.
 *
 * `"a\nb\n"` is two lines, not three. A naive `split` yields a trailing `""` that
 * would be counted, paginated and returned as a blank final line - and then
 * written back into the file by `fs_write`.
 *
 * A file that genuinely ends in two newlines keeps its real trailing blank line,
 * because the last element is dropped only when it is the *only* empty one.
 */
function splitLines(text: string, eol: Eol): string[] {
  if (text === "") return [];
  const parts = text.split(eol);
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/**
 * Validate the arguments a model sent.
 *
 * Strict on purpose. `start_line: "2"` would otherwise arrive at `slice()` and
 * quietly do nothing, and a silent no-op on a page request means the model
 * believes it read the lines it asked for. The message names the field and what
 * arrived so the model can correct itself in the next turn.
 */
function parseReadArgs(
  raw: unknown,
  validatePath: (filePath: string) => string,
): FsReadArgs {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ZxError(
      "INTERNAL",
      `fs_read expects an object of arguments, got ${describe(raw)}`,
    );
  }
  const input = raw as Record<string, unknown>;

  const filePath = input.file_path;
  if (typeof filePath !== "string" || filePath === "") {
    throw new ZxError(
      "INTERNAL",
      `fs_read needs a non-empty file_path string, got ${describe(filePath)}`,
      { file_path: filePath },
    );
  }

  // Refuses an escaping or reserved path here, which is before the approval gate.
  validatePath(filePath);

  return {
    file_path: filePath,
    start_line: optionalPositiveInteger(input.start_line, "start_line"),
    line_count: optionalPositiveInteger(input.line_count, "line_count"),
  };
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ZxError(
      "INTERNAL",
      `fs_read needs ${field} to be a positive whole number, got ${describe(value)}`,
      { [field]: value },
    );
  }
  return value;
}

function describe(value: unknown): string {
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === "string" ? encoded : String(value);
  } catch {
    return "[unrenderable value]";
  }
}
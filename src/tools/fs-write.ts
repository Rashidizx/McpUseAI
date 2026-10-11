import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { ZxError } from "../core/errors.js";
import { asZxError, STAGING_SUFFIX } from "./fs-errors.js";
import { decodeFile, encodeFile } from "../core/text-io.js";
import type { PathGuard } from "../core/path-guard.js";
import type { ToolDefinition } from "../core/tool-registry.js";

export type FsWriteArgs = {
  /** Path relative to the workspace root. */
  file_path: string;

  /** The full new content of the file. */
  content: string;

  /**
   * Refuse to touch an existing file unless this is true.
   *
   * Off by default for a *new* file, which is the common case. For an existing
   * file the default is to overwrite, because this is an edit tool and refusing
   * every edit would mean every edit is a read followed by a write - but the
   * refusal is one flag away for a caller that wants create-only semantics.
   */
  create_only?: boolean;
};

export type FsWriteData = {
  file_path: string;

  /** Whether the file existed before this call. */
  created: boolean;

  bytes_written: number;

  /** The line ending now in the file, which is the pre-existing one if any. */
  eol: string;

  /** Whether the file carries a BOM, again preserved from before. */
  had_bom: boolean;
};

/**
 * Write a file inside the sandbox.
 *
 * ## Atomicity
 *
 * The write goes to a temporary file in the **same directory** and is then
 * renamed over the target. Same directory matters: `rename` is only atomic within
 * a volume, and a temp file in `%TEMP%` on a different volume would degrade into
 * a copy that can be interrupted halfway.
 *
 * The reason to bother: `fs_write` is the step where a disk-full or a crash
 * turns into a truncated source file. A user who loses the tail of their file to a
 * full disk will not trust the tool again, and rightly so.
 *
 * ## Encoding is the file's business, not ours
 *
 * A file that already exists keeps its line ending and its BOM. Writing LF into a
 * CRLF file produces a diff touching every line, and writing a BOM into a file
 * that had none produces an invisible first-character change that shows up in
 * every future diff of that file. Both are "correct" writes that wreck a review,
 * so both are avoided by reading the target's own convention first.
 *
 * As with `fs_read`, the string `guard.resolve()` returned is what reaches the
 * filesystem - F2-2.
 */
export function createFsWrite(guard: PathGuard): ToolDefinition<FsWriteArgs> {
  /**
   * Refuse an unusable path before the approval gate is reached.
   *
   * A write is the prompt the user is most likely to approve on reflex, so asking
   * them to consent to `../../../Windows/System32` - and only then refusing it -
   * spends exactly the attention this system exists to protect. Validation lives
   * in `parseArgs` because `ToolRegistry` parses before it prompts.
   *
   * The resolved path is thrown away on purpose: `run` resolves again, and that
   * second value is the one handed to the filesystem.
   */
  const validatePath = (filePath: string): string => {
    guard.resolve(filePath);
    return filePath;
  };

  return {
    name: "fs_write",
    opClass: "write",

    describe: () =>
      "{file_path, content, create_only?} Write a text file inside the workspace, creating parent directories as " +
      "needed. Preserves the existing file's line endings and BOM. Set " +
      "create_only to refuse overwriting an existing file.",

    parseArgs: (raw) => parseWriteArgs(raw, validatePath),

    summarize: (args) =>
      `${args.create_only === true ? "create" : "write"} ${args.file_path}`,

    // Describes the attempt even when the path was refused, so the audit row
    // names what was attempted instead of saying only that arguments failed.
    summarizeRaw: (raw) => {
      const candidate =
        raw !== null && typeof raw === "object"
          ? (raw as Record<string, unknown>).file_path
          : undefined;
      return typeof candidate === "string" && candidate !== ""
        ? `write ${candidate}`
        : "write <no file_path>";
    },

    run: async (args) => {
      // F2-2: this exact string goes to the filesystem.
      const absolute = guard.resolve(args.file_path);
      const existed = existsSync(absolute);

      if (existed && args.create_only === true) {
        throw new ZxError(
          "FILE_EXISTS",
          `${args.file_path} already exists and create_only was set`,
          { file_path: args.file_path },
        );
      }

      // The target's own convention, if it has one. A new file gets UTF-8
      // without BOM and LF, which is what git and every editor default to.
      let eol: "\n" | "\r\n" = "\n";
      let hadBom = false;
      if (existed) {
        // Reading the target is what fails when the target is a directory or a
        // locked file - both of which arrive as raw `EISDIR`/`EPERM` errors, so
        // they are translated here rather than escaping the module.
        try {
          const decoded = decodeFile(readFileSync(absolute));
          eol = decoded.eol;
          hadBom = decoded.hadBom;
        } catch (error) {
          throw asZxError(error, { action: "write", file_path: args.file_path });
        }
      }

      const payload = encodeFile(args.content, { eol, bom: hadBom });

      try {
        mkdirSync(dirname(absolute), { recursive: true });
      } catch (error) {
        throw asZxError(error, { action: "write", file_path: args.file_path });
      }

      // Same directory as the target, so the rename stays on one volume.
      const temporary = `${absolute}${STAGING_SUFFIX}`;
      try {
        writeFileSync(temporary, payload);
        renameSync(temporary, absolute);
      } catch (error) {
        // Leave nothing behind on failure. A stray staging file in the user's
        // source tree is worse than a failed write: it is a file they did not
        // create, with a name they will not recognise.
        try {
          rmSync(temporary, { force: true });
        } catch {
          // If the cleanup itself fails the original error is the one worth
          // reporting; a leftover temp file is visible and recoverable, a
          // masked root cause is neither.
        }
        throw asZxError(error, { action: "write", file_path: args.file_path });
      }

      return {
        summary: `${existed ? "wrote" : "created"} ${args.file_path} (${payload.length} bytes)`,
        data: {
          file_path: args.file_path,
          created: !existed,
          bytes_written: payload.length,
          eol,
          had_bom: hadBom,
        } satisfies FsWriteData,
      };
    },
  };
}

/**
 * Validate the arguments a model sent.
 *
 * `content` is checked for being a string and nothing else: an empty file is a
 * legitimate thing to write, and a `create_empty` flag to express "make an empty
 * file" would be a worse API than allowing `content: ""`.
 */
function parseWriteArgs(
  raw: unknown,
  validatePath: (filePath: string) => string,
): FsWriteArgs {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ZxError(
      "INTERNAL",
      `fs_write expects an object of arguments, got ${describe(raw)}`,
    );
  }
  const input = raw as Record<string, unknown>;

  const filePath = input.file_path;
  if (typeof filePath !== "string" || filePath === "") {
    throw new ZxError(
      "INTERNAL",
      `fs_write needs a non-empty file_path string, got ${describe(filePath)}`,
      { file_path: filePath },
    );
  }

  const content = input.content;
  if (typeof content !== "string") {
    throw new ZxError(
      "INTERNAL",
      `fs_write needs content to be a string, got ${describe(content)}`,
      { file_path: filePath },
    );
  }

  // Refuses an escaping or reserved path here, which is before the approval gate.
  validatePath(filePath);

  let createOnly: boolean | undefined;
  if (input.create_only !== undefined) {
    if (typeof input.create_only !== "boolean") {
      throw new ZxError(
        "INTERNAL",
        `fs_write needs create_only to be a boolean, got ${describe(input.create_only)}`,
        { file_path: filePath },
      );
    }
    createOnly = input.create_only;
  }

  return { file_path: filePath, content, ...(createOnly === undefined ? {} : { create_only: createOnly }) };
}

function describe(value: unknown): string {
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === "string" ? encoded : String(value);
  } catch {
    return "[unrenderable value]";
  }
}
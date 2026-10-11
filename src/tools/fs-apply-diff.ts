import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

import { ZxError } from "../core/errors.js";
import { decodeFile, encodeFile, type Eol } from "../core/text-io.js";
import { asZxError, STAGING_SUFFIX } from "./fs-errors.js";
import type { PathGuard } from "../core/path-guard.js";
import type { ToolDefinition } from "../core/tool-registry.js";

export type FsApplyDiffArgs = {
  /** File to patch, relative to the workspace root. */
  file_path: string;

  /**
   * The text to find. Must appear exactly, byte for byte.
   *
   * Exact matching rather than fuzzy is the point of this tool: a diff that
   * guesses which occurrence was meant is how an automated edit lands in the
   * wrong place, and the user reviewing the result has no way to tell.
   */
  old_text: string;

  /** What replaces it. */
  new_text: string;

  /**
   * Replace the single occurrence only.
   *
   * Default, and refusing an ambiguous match rather than picking one. When
   * `old_text` appears more than once the tool stops with `DIFF_NO_MATCH` and
   * reports how many occurrences it found, so the caller can widen the context.
   */
  all?: boolean;

  /**
   * Refuse to apply unless the file already contains `old_text`.
   *
   * Always true; there is no way to turn it off. A create is `fs_write`'s job,
   * and having two tools that both create means two places to get atomicity and
   * encoding right.
   */
  create_if_missing?: never;
};

export type FsApplyDiffData = {
  file_path: string;
  /** Occurrences replaced. */
  replacements: number;
  bytes_written: number;
  eol: string;
  had_bom: boolean;
};

/**
 * Apply an exact-match edit to a file, atomically.
 *
 * ## The atomicity is the feature
 *
 * Every check - does the file exist, does the text appear, is the match unique -
 * happens *before* a single byte is written, and the write itself goes through a
 * temporary file and a rename. There is no path where a failed or ambiguous diff
 * leaves a half-edited file behind.
 *
 * That matters more here than anywhere else in the project. `fs_write` replaces a
 * file's whole content, so a failure costs the operation, not the work. This tool
 * edits a file *in place*, and the thing it edits is the user's source. A tool
 * that truncates a file and then fails to find its match has destroyed the user's
 * work to accomplish nothing.
 *
 * ## Refusing rather than guessing
 *
 * An ambiguous `old_text` is an error, not a choice. `replace first occurrence` is
 * the kind of default that puts a function body in the wrong class half the time,
 * and the resulting file still compiles and still looks plausible.
 */
export function createFsApplyDiff(guard: PathGuard): ToolDefinition<FsApplyDiffArgs> {
  const validatePath = (filePath: string): string => {
    guard.resolve(filePath);
    return filePath;
  };

  return {
    name: "fs_apply_diff",
    opClass: "write",

    describe: () =>
      "{file_path, old_text, new_text, all?} Replace an exact snippet in an existing file. The old text must appear " +
      "exactly, and an ambiguous match is refused rather than guessed. The file " +
      "is left untouched if the edit does not apply, and its line endings and " +
      "BOM are preserved.",

    parseArgs: (raw) => {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new ZxError("INTERNAL", "fs_apply_diff expects an object of arguments");
      }
      const input = raw as Record<string, unknown>;

      const filePath = input.file_path;
      if (typeof filePath !== "string" || filePath === "") {
        throw new ZxError(
          "INTERNAL",
          "fs_apply_diff needs a non-empty file_path string",
        );
      }
      if (typeof input.old_text !== "string") {
        throw new ZxError("INTERNAL", "fs_apply_diff needs old_text to be a string");
      }
      if (typeof input.new_text !== "string") {
        throw new ZxError("INTERNAL", "fs_apply_diff needs new_text to be a string");
      }
      if (input.all !== undefined && typeof input.all !== "boolean") {
        throw new ZxError("INTERNAL", "fs_apply_diff needs all to be a boolean");
      }
      if (input.create_if_missing !== undefined) {
        throw new ZxError(
          "INTERNAL",
          "fs_apply_diff never creates a file; use fs_write to create one",
        );
      }
      validatePath(filePath);

      return {
        file_path: filePath,
        old_text: input.old_text,
        new_text: input.new_text,
        ...(input.all === undefined ? {} : { all: input.all }),
      };
    },

    summarize: (args) => {
      const verb = args.all === true ? "replace all occurrences in" : "replace in";
      return `${verb} ${args.file_path}`;
    },

    summarizeRaw: (raw) => {
      const candidate =
        raw !== null && typeof raw === "object"
          ? (raw as Record<string, unknown>).file_path
          : undefined;
      return typeof candidate === "string" && candidate !== ""
        ? `replace in ${candidate}`
        : "replace in <no file_path>";
    },

    run: async (args) => {
      // F2-2: this exact string goes to the filesystem.
      const absolute = guard.resolve(args.file_path);

      if (!existsSync(absolute)) {
        throw new ZxError(
          "FILE_NOT_FOUND",
          `${args.file_path} does not exist; use fs_write to create it`,
          { file_path: args.file_path },
        );
      }

      let decoded;
      try {
        decoded = decodeFile(readFileSync(absolute));
      } catch (error) {
        throw asZxError(error, { action: "apply diff to", file_path: args.file_path });
      }

      const occurrences = countOccurrences(decoded.text, args.old_text);
      if (occurrences === 0) {
        throw new ZxError(
          "DIFF_NO_MATCH",
          `the text to replace does not appear in ${args.file_path}; the file was not modified. Re-read the file and copy the exact text, including its whitespace and line endings`,
          { file_path: args.file_path, occurrences: 0 },
        );
      }
      if (occurrences > 1 && args.all !== true) {
        // Refused rather than resolved. `first occurrence` is a default that
        // silently edits the wrong one of two identical function bodies.
        throw new ZxError(
          "DIFF_NO_MATCH",
          `the text to replace appears ${occurrences} times in ${args.file_path}; include more surrounding context to identify which one, or set all=true to replace every occurrence. The file was not modified`,
          { file_path: args.file_path, occurrences },
        );
      }

      const updated =
        args.all === true
          ? decoded.text.split(args.old_text).join(args.new_text)
          : decoded.text.replace(args.old_text, args.new_text);

      // Written through the target's own encoding, so an edit does not
      // reformat the lines it did not touch.
      const payload = encodeFile(updated, {
        eol: decoded.eol as Eol,
        bom: decoded.hadBom,
      });

      const temporary = `${absolute}${STAGING_SUFFIX}`;
      try {
        writeFileSync(temporary, payload);
        renameSync(temporary, absolute);
      } catch (error) {
        try {
          rmSync(temporary, { force: true });
        } catch {
          // A leftover temp file is visible and recoverable; masking the root
          // cause is neither.
        }
        throw asZxError(error, { action: "apply diff to", file_path: args.file_path });
      }

      const replacements = occurrences === 0 ? 0 : args.all === true ? occurrences : 1;
      return {
        summary: `replaced ${replacements} occurrence${replacements === 1 ? "" : "s"} in ${args.file_path}`,
        data: {
          file_path: args.file_path,
          replacements,
          bytes_written: payload.length,
          eol: decoded.eol,
          had_bom: decoded.hadBom,
        } satisfies FsApplyDiffData,
      };
    },
  };
}

/**
 * Count non-overlapping occurrences.
 *
 * `split` would be shorter but counts an empty needle as `length + 1` and
 * behaves oddly on overlapping text; the guard below also stops an empty
 * `old_text` from matching everywhere, which would rewrite the entire file.
 */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}
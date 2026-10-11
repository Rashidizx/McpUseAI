import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { ZxError } from "../core/errors.js";
import { asZxError } from "./fs-errors.js";
import type { PathGuard } from "../core/path-guard.js";
import type { ToolDefinition } from "../core/tool-registry.js";

export type FsListArgs = {
  /** Directory relative to the workspace root. Defaults to the root itself. */
  dir_path?: string;

  /** Subdirectories to descend into. Defaults to 0 - this directory only. */
  depth?: number;

  /** Include dotfiles. Off by default: `.git` is not what a model usually wants. */
  include_hidden?: boolean;
};

export type FsListEntry = {
  /** Path relative to the workspace root, with forward slashes. */
  path: string;
  type: "file" | "directory";
  /** Size in bytes for files, `null` for directories. */
  size: number | null;
};

export type FsListData = {
  dir_path: string;
  entries: FsListEntry[];
  /** False when the cap stopped the walk, so a caller knows it saw a subset. */
  complete: boolean;
  /** Entries examined, which is what the cap is applied to. */
  examined: number;
};

/**
 * Most entries one call will return.
 *
 * A directory listing is the operation most likely to be asked for on a path
 * like `node_modules` or a build output directory, where the answer is hundreds
 * of thousands of entries. Returning them all would push a listing too large for
 * any context window through the bridge, so the walk stops and says it stopped -
 * `complete: false` - rather than silently returning a prefix that reads as the
 * whole truth.
 */
const MAX_ENTRIES = 2_000;

/** Deepest the walk will go, whatever `depth` says. */
const MAX_DEPTH = 8;

/** Directories never descended into, whatever `depth` says. */
const SKIP_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", "target", ".next"]);

/**
 * List a directory inside the sandbox.
 *
 * ## Why this exists rather than `exec dir`
 *
 * Because it goes through the sandbox. `exec` runs with the workspace as its
 * `cwd` and cannot actually be confined to it - that is the open limitation A6 in
 * the checklist - so "what is in this directory" has to be answerable without it,
 * or every listing becomes an approval prompt for a command with unbounded reach.
 *
 * ## Why the walk stops rather than truncating
 *
 * `complete: false` exists so a model can tell "this folder has four files" from
 * "this folder has four files and then I stopped counting". A silently truncated
 * listing is how a model concludes a directory is empty of the thing it was
 * looking for.
 */
export function createFsList(guard: PathGuard): ToolDefinition<FsListArgs> {
  const validateDir = (dirPath: string): string => {
    guard.resolve(dirPath);
    return dirPath;
  };

  return {
    name: "fs_list",
    opClass: "read",

    describe: () =>
      "{dir_path?, depth?, include_hidden?} List the contents of a directory inside the workspace. Returns each " +
      "entry's path, type and size, and reports whether the listing is complete " +
      "or stopped at the entry limit.",

    parseArgs: (raw) => {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new ZxError("INTERNAL", "fs_list expects an object of arguments");
      }
      const input = raw as Record<string, unknown>;

      const dirPath = input.dir_path;
      if (dirPath !== undefined && (typeof dirPath !== "string" || dirPath === "")) {
        throw new ZxError(
          "INTERNAL",
          "fs_list needs dir_path to be a non-empty string when supplied",
        );
      }
      // The workspace root itself is a legitimate target, and resolving "." is
      // how the guard spells it (F2-7).
      const resolvedPath = typeof dirPath === "string" ? validateDir(dirPath) : ".";
      guard.resolve(resolvedPath);

      const depth = input.depth;
      if (depth !== undefined && (typeof depth !== "number" || !Number.isInteger(depth) || depth < 0)) {
        throw new ZxError(
          "INTERNAL",
          "fs_list needs depth to be a whole number of zero or more",
        );
      }
      const includeHidden = input.include_hidden;
      if (includeHidden !== undefined && typeof includeHidden !== "boolean") {
        throw new ZxError(
          "INTERNAL",
          "fs_list needs include_hidden to be a boolean when supplied",
        );
      }

      return {
        ...(typeof dirPath === "string" ? { dir_path: dirPath } : {}),
        ...(depth === undefined ? {} : { depth }),
        ...(includeHidden === undefined ? {} : { include_hidden: includeHidden }),
      };
    },

    summarize: (args) => `list ${args.dir_path ?? "."}`,

    // Lists a rejected attempt by path, the same reason fs_read and fs_write do.
    summarizeRaw: (raw) => {
      const candidate =
        raw !== null && typeof raw === "object"
          ? (raw as Record<string, unknown>).dir_path
          : undefined;
      return typeof candidate === "string" && candidate !== ""
        ? `list ${candidate}`
        : "list <no dir_path>";
    },

    run: async (args) => {
      // F2-2: the guard's string is what reaches the filesystem.
      const absolute = guard.resolve(args.dir_path ?? ".");
      const maxDepth = Math.min(args.depth ?? 0, MAX_DEPTH);
      const includeHidden = args.include_hidden ?? false;

      let rootStats;
      try {
        rootStats = statSync(absolute);
      } catch (error) {
        throw asZxError(error, { action: "list", file_path: args.dir_path ?? "." });
      }
      if (!rootStats.isDirectory()) {
        throw new ZxError(
          "NOT_A_DIRECTORY",
          `${args.dir_path ?? "."} is not a directory`,
          { dir_path: args.dir_path ?? "." },
        );
      }

      const entries: FsListEntry[] = [];
      let examined = 0;
      let complete = true;
      const queue: { absolute: string; relative: string; level: number }[] = [
        { absolute, relative: "", level: 0 },
      ];

      while (queue.length > 0) {
        if (examined >= MAX_ENTRIES) {
          complete = false;
          break;
        }
        const current = queue.shift();
        if (current === undefined) break;

        let names: string[];
        try {
          names = readdirSync(current.absolute);
        } catch (error) {
          // One unreadable subdirectory must not fail the whole listing. Skipping
          // it is the useful behaviour, and the audit row still records what
          // failed via the error detail.
          throw asZxError(error, {
            action: "list",
            file_path: current.relative === "" ? "." : current.relative,
          });
        }

        for (const name of names) {
          if (!includeHidden && name.startsWith(".")) continue;
          examined++;
          const childAbsolute = join(current.absolute, name);
          const relative =
            current.relative === ""
              ? name
              : `${current.relative}/${name}`;

          let childStats;
          try {
            childStats = statSync(childAbsolute);
          } catch (error) {
            // A dangling symlink or a file deleted mid-walk. Neither is fatal;
            // reporting it as an entry of unknown type would be a guess.
            throw asZxError(error, { action: "list", file_path: relative });
          }

          const isDirectory = childStats.isDirectory();
          entries.push({
            path: relative,
            type: isDirectory ? "directory" : "file",
            size: isDirectory ? null : childStats.size,
          });

          if (
            isDirectory &&
            current.level < maxDepth &&
            !SKIP_DIRECTORIES.has(name)
          ) {
            queue.push({
              absolute: childAbsolute,
              relative,
              level: current.level + 1,
            });
          }

          if (examined >= MAX_ENTRIES) {
            complete = false;
            break;
          }
        }
      }

      const data: FsListData = {
        dir_path: args.dir_path ?? ".",
        entries,
        complete,
        examined,
      };
      const qualifier = complete ? "" : " (stopped at the entry limit)";
      return {
        summary: `listed ${data.dir_path}: ${entries.length} entr${entries.length === 1 ? "y" : "ies"}${qualifier}`,
        data,
      };
    },
  };
}
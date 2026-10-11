import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { ZxError } from "../core/errors.js";
import { asZxError } from "./fs-errors.js";
import type { PathGuard } from "../core/path-guard.js";
import type { ToolDefinition } from "../core/tool-registry.js";

export type FsGrepArgs = {
  /** The pattern to find. Treated as a regular expression. */
  pattern: string;
  /** Restrict the search to this file or directory. Defaults to the whole tree. */
  path?: string;
  /** Match case-sensitively. Off by default, because a symbol is often capitalised in only one place. */
  case_sensitive?: boolean;
  /** Also search file names rather than their contents. */
  match_path?: boolean;
  /** Only search files whose name ends with one of these, e.g. [".ts", ".js"]. */
  extensions?: string[];
  /** How many matching lines to return per file. Defaults to 5. */
  max_matches_per_file?: number;
};

export type FsGrepMatch = {
  /** Workspace-relative path, forward slashes. */
  path: string;
  /** 1-based line number, as an editor shows it. */
  line: number;
  /** The matching line, trimmed and length-capped. */
  text: string;
};

export type FsGrepData = {
  pattern: string;
  matches: FsGrepMatch[];
  /** Files whose contents were searched. */
  files_searched: number;
  /** False when a cap stopped the search, so a caller knows it saw a subset. */
  complete: boolean;
  /** Why it stopped, when it did. */
  stopped_because?: "matches" | "files";
};

/**
 * Most matching lines one call returns.
 *
 * A search across a project tree matches far more than any context window can
 * hold - searching for a common word in a large repository is thousands of hits.
 * The cap is what makes the result usable, and `complete: false` is what stops it
 * from being read as "these are all of them".
 */
const MAX_MATCHES = 200;

/** Deepest the walk goes, whatever the caller asks for. */
const MAX_DEPTH = 12;

/** Most bytes read from one file, so one huge file cannot stall a search. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Longest matching line returned, so a minified file cannot flood the result. */
const MAX_LINE_LENGTH = 300;

/** Directories never descended into. */
const SKIP_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", "target", ".next", "coverage"]);

/** Extensions treated as text when no filter is given. */
const DEFAULT_EXTENSIONS = [
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".txt",
  ".css", ".html", ".yml", ".yaml", ".toml", ".sh", ".py", ".rs", ".go", ".sql",
];

/**
 * Whether a file is worth opening at all.
 *
 * Decided from the extension rather than by sniffing content, because sniffing
 * means reading the file - which is the expensive part, and it would pull every
 * image in the tree through a read for no reason. A caller with a project full of
 * unusual extensions passes `extensions` and gets what they asked for.
 */
function isSearchable(relative: string, extensions: ReadonlySet<string>): boolean {
  const dot = relative.lastIndexOf(".");
  // No extension at all: skipped, because it is usually a binary or a licence
  // file, and a file the caller can name is one `fs_read` can fetch directly.
  if (dot <= 0) return false;
  return extensions.has(relative.slice(dot).toLowerCase());
}

/**
 * Find a pattern across the workspace.
 *
 * ## Why this exists rather than `exec rg`
 *
 * Two reasons, and the first is the one that matters.
 *
 * `cwd` does not confine a process - that is the open limitation A6 - so a shell
 * search would be an operation the user cannot reason about, with unbounded reach
 * for the cost of one approval prompt. Everything here resolves through
 * `PathGuard`, so the search cannot leave the workspace by construction rather
 * than by policy.
 *
 * And a search is what makes the tools usable as a pair: without it, "where is
 * this function defined" costs one read per candidate file, which on a real project
 * is dozens of round trips through a bridge and a human approving each one.
 *
 * ## Why `pattern` is a regular expression
 *
 * Because that is what makes a symbol findable. A plain substring search cannot
 * match `createFs(Read|Write)` or `fs_\w+_args`, and those are precisely the
 * questions worth asking a codebase. The trade is that an invalid pattern is a
 * model error rather than an empty result, which is the useful outcome.
 */
export function createFsGrep(guard: PathGuard): ToolDefinition<FsGrepArgs> {
  return {
    name: "fs_grep",
    opClass: "read",

    describe: () =>
      "{pattern, path?, case_sensitive?, extensions?} Search the workspace for a regular expression and return matching lines " +
      "with their file and line number. Use this to find where something is " +
      "defined before reading a file. Reports whether the search was complete.",

    parseArgs: (raw) => {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new ZxError("INTERNAL", "fs_grep expects an object of arguments");
      }
      const input = raw as Record<string, unknown>;

      const pattern = input.pattern;
      if (typeof pattern !== "string" || pattern === "") {
        throw new ZxError(
          "INTERNAL",
          "fs_grep needs pattern to be a non-empty regular expression string",
        );
      }

      const target = input.path;
      if (target !== undefined && (typeof target !== "string" || target === "")) {
        throw new ZxError("INTERNAL", "fs_grep needs path to be a non-empty string when supplied");
      }
      // Resolved here, in parseArgs, so an escape attempt is refused *before* the
      // user is ever asked to approve anything. That ordering is the whole point
      // of the guard being applied at the boundary rather than inside `run`.
      const resolvedPath = typeof target === "string" ? target : ".";
      guard.resolve(resolvedPath);

      const caseSensitive = input.case_sensitive;
      if (caseSensitive !== undefined && typeof caseSensitive !== "boolean") {
        throw new ZxError("INTERNAL", "fs_grep needs case_sensitive to be a boolean when supplied");
      }

      const matchPath = input.match_path;
      if (matchPath !== undefined && typeof matchPath !== "boolean") {
        throw new ZxError("INTERNAL", "fs_grep needs match_path to be a boolean when supplied");
      }

      const extensions = input.extensions;
      if (extensions !== undefined) {
        if (!Array.isArray(extensions) || extensions.some((e) => typeof e !== "string" || e === "")) {
          throw new ZxError(
            "INTERNAL",
            "fs_grep needs extensions to be an array of non-empty strings",
          );
        }
      }

      const perFile = input.max_matches_per_file;
      if (perFile !== undefined && (typeof perFile !== "number" || !Number.isInteger(perFile) || perFile < 1)) {
        throw new ZxError(
          "INTERNAL",
          "fs_grep needs max_matches_per_file to be a whole number of 1 or more",
        );
      }

      // Compiled during validation so a bad pattern is a parse error - reported
      // before an approval prompt, and recorded in the audit row as a rejected
      // attempt rather than as a search that found nothing.
      compilePattern(pattern, caseSensitive === true);

      return {
        pattern,
        path: resolvedPath,
        ...(caseSensitive === undefined ? {} : { case_sensitive: caseSensitive }),
        ...(matchPath === undefined ? {} : { match_path: matchPath }),
        ...(extensions === undefined ? {} : { extensions: extensions as string[] }),
        ...(perFile === undefined ? {} : { max_matches_per_file: perFile }),
      };
    },

    summarize: (args) => `search for ${args.pattern} in ${args.path ?? "."}`,

    summarizeRaw: (raw) => {
      const candidate =
        raw !== null && typeof raw === "object"
          ? (raw as Record<string, unknown>).pattern
          : undefined;
      return typeof candidate === "string" && candidate !== ""
        ? `search for ${candidate}`
        : "search for <no pattern>";
    },

    run: async (args) => {
      const absolute = guard.resolve(args.path ?? ".");
      const regex = compilePattern(args.pattern, args.case_sensitive === true);
      const extensions = new Set(
        (args.extensions ?? DEFAULT_EXTENSIONS).map((e) =>
          e.startsWith(".") ? e.toLowerCase() : `.${e.toLowerCase()}`,
        ),
      );
      const perFile = Math.min(args.max_matches_per_file ?? 5, 50);
      const matchPathOnly = args.match_path === true;

      let rootStats;
      try {
        rootStats = statSync(absolute);
      } catch (error) {
        throw asZxError(error, { action: "search", file_path: args.path ?? "." });
      }

      const matches: FsGrepMatch[] = [];
      let filesSearched = 0;
      let complete = true;
      let stoppedBecause: "matches" | "files" | undefined;

      const accept = (path: string, line: number, text: string): boolean => {
        if (matches.length >= MAX_MATCHES) {
          complete = false;
          stoppedBecause = "matches";
          return false;
        }
        matches.push({
          path,
          line,
          text: text.length > MAX_LINE_LENGTH ? `${text.slice(0, MAX_LINE_LENGTH)}…` : text,
        });
        return true;
      };

      // A single file, or one file named directly - the common case of "I know
      // roughly where this is, confirm it".
      if (!rootStats.isDirectory()) {
        filesSearched = 1;
        if (!matchPathOnly && isSearchable(args.path ?? "", extensions)) {
          searchOneFile(absolute, args.path ?? "", regex, perFile, accept);
        }
        return {
          summary: `${matches.length} match${matches.length === 1 ? "" : "es"} in ${args.path ?? "."}`,
          data: {
            pattern: args.pattern,
            matches,
            files_searched: filesSearched,
            complete,
            ...(stoppedBecause === undefined ? {} : { stopped_because: stoppedBecause }),
          },
        };
      }

      const rootRelative = stripLeadingDot(args.path ?? ".");
      const queue: { absolute: string; relative: string; level: number }[] = [
        // Normalised to "" so every emitted path is workspace-relative and bare.
        // Prefixing with "./" looks harmless but breaks the one thing a caller
        // does with a search result: feed the path straight back to `fs_read`,
        // which wants the same relative spelling.
        //
        // Tested against `"."` rather than `undefined`, because `parseArgs`
        // always writes a `path` - it defaults to the root - so an
        // `undefined` check would never be true and every result would carry the
        // prefix.
        { absolute, relative: rootRelative, level: 0 },
      ];

      while (queue.length > 0 && complete) {
        const current = queue.shift();
        if (current === undefined) break;

        let names: string[];
        try {
          names = readdirSync(current.absolute);
        } catch (error) {
          // An unreadable directory is a fact about the search, not a reason to
          // fail it: the caller still wants the files that were readable.
          throw asZxError(error, { action: "search", file_path: current.relative || "." });
        }

        for (const name of names) {
          if (name.startsWith(".")) continue;
          const childAbsolute = join(current.absolute, name);
          const relative =
            current.relative === "" ? name : `${current.relative}/${name}`;

          let childStats;
          try {
            childStats = statSync(childAbsolute);
          } catch {
            // A dangling symlink or a file deleted mid-walk. Not an error worth
            // reporting a guessed entry for.
            continue;
          }

          if (childStats.isDirectory()) {
            if (current.level < MAX_DEPTH && !SKIP_DIRECTORIES.has(name)) {
              queue.push({
                absolute: childAbsolute,
                relative,
                level: current.level + 1,
              });
            }
            continue;
          }

          if (matchPathOnly) {
            if (regex.test(relative)) accept(relative, 0, relative);
            if (!complete) break;
            continue;
          }

          if (!isSearchable(relative, extensions)) continue;

          // An oversized file is skipped and counted, never truncated: reading
          // half a file and reporting the matches as if they were the file's would
          // be the silent-shortening failure `fs_read` explicitly avoids with its
          // `has_more`.
          if (childStats.size > MAX_FILE_BYTES) continue;

          filesSearched++;
          if (!searchOneFile(childAbsolute, relative, regex, perFile, accept)) break;
        }
      }

      const qualifier = complete ? "" : " (stopped at a limit; this is a subset)";
      return {
        summary:
          `${matches.length} match${matches.length === 1 ? "" : "es"} for ${args.pattern} ` +
          `in ${filesSearched} file${filesSearched === 1 ? "" : "s"}${qualifier}`,
        data: {
          pattern: args.pattern,
          matches,
          files_searched: filesSearched,
          complete,
          ...(stoppedBecause === undefined ? {} : { stopped_because: stoppedBecause }),
        },
      };
    },
  };
}

/**
 * Turn ".", "./src" or "src/" into the bare relative spelling.
 *
 * The workspace root is the case worth naming: `"."` has no `./` prefix, so a
 * routine that only stripped prefixes would hand the walk a root of `"."` and
 * every emitted path would come back as `./src/alpha.ts`. That looks harmless and
 * breaks the one thing a caller does with a search result - feed the path back to
 * `fs_read`, which wants the bare spelling and would report FILE_NOT_FOUND.
 */
function stripLeadingDot(relative: string): string {
  let out = relative.replace(/\\/g, "/");
  if (out === ".") return "";
  while (out.startsWith("./")) out = out.slice(2);
  return out.replace(/\/+$/, "");
}

/** Compile, or throw a message written for a model to act on. */
function compilePattern(pattern: string, caseSensitive: boolean): RegExp {
  try {
    return new RegExp(pattern, caseSensitive ? "g" : "gi");
  } catch (error) {
    throw new ZxError(
      "INTERNAL",
      `fs_grep could not compile ${JSON.stringify(pattern)} as a regular expression: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      { pattern },
    );
  }
}

/**
 * Search one file's lines.
 *
 * Returns false once the global cap is hit, so the caller stops walking. Line
 * numbers are 1-based because that is what an editor and a stack trace both use,
 * and a 0-based line number here would send every later read to the wrong place.
 */
function searchOneFile(
  absolute: string,
  relative: string,
  regex: RegExp,
  perFile: number,
  accept: (path: string, line: number, text: string) => boolean,
): boolean {
  let contents: string;
  try {
    contents = readFileSync(absolute, "utf8");
  } catch {
    // Unreadable, or binary despite the extension. Either way there is nothing to
    // report and nothing worth failing the whole search for.
    return true;
  }

  // A file with no newline at all is one enormous line - a minified bundle, or a
  // data file that happens to end in `.js`. Splitting it would produce one
  // gigabyte-long "line", so it is treated as a single line and the accept()
  // cap truncates its text.
  const lines = contents.split(/\r?\n/);
  let found = 0;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line === undefined) continue;

    // `lastIndex` is stateful on a global regex, so it is reset per line. Missing
    // that is the classic reason a second line is skipped even though the first
    // matched.
    regex.lastIndex = 0;
    if (!regex.test(line)) continue;

    if (!accept(relative, index + 1, line.trim())) return false;
    found++;
    if (found >= perFile) break;
  }
  return true;
}
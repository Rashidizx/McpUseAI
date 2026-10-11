import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { delimiter } from "node:path";

import { ZxError } from "../core/errors.js";
import type { PathGuard } from "../core/path-guard.js";
import type { ToolDefinition } from "../core/tool-registry.js";

/**
 * Running a program inside the workspace, with a human in the loop.
 *
 * ## Why this exists at all
 *
 * Without it the bridge can read and edit files but cannot *run* anything, so
 * "add a test for this function" stops at writing the test file. The gap
 * between "it edits my files" and "it develops my project" is here.
 *
 * ## Why it is the most dangerous tool in the project
 *
 * Every other tool's reach is bounded by `PathGuard`, which resolves every path
 * it is given and refuses anything landing outside the workspace. A process has
 * no such property: `cwd` is a starting directory, not a jail. `rm -rf /` run
 * with the workspace as its working directory deletes the disk.
 *
 * So the containment here is *not* the guard. It is four other things, and any
 * one of them failing is a containment hole:
 *
 *  1. **A fixed allowlist of programs.** `command` is looked up in a table and
 *     an unknown name is refused. There is no path, no glob, no "anything".
 *  2. **No shell, ever.** `spawn` is called with an argv array and
 *     `shell: false`. A shell would make `;`, `&&`, `|` and backticks part of
 *     the grammar, at which point the allowlist names a program that is free to
 *     run any other one.
 *  3. **A human, every time.** `opClass` is `"exec"`, which the approval gate
 *     never auto-approves by default. The prompt shows the *whole* argv,
 *     untruncated — approving a shortened rendering is approving a different
 *     command.
 *  4. **A fixed environment with the workspace scrubbed out of `PATH`.** The
 *     child gets a named set of variables, not a copy of the bridge's, so
 *     nothing the operator has in their environment leaks into a process a
 *     web page influenced. And any `PATH` entry *inside* the workspace is
 *     dropped before the child sees it, because otherwise a file an injected
 *     page managed to get written into the project (`git.exe`, `npm.cmd`) would
 *     be found before the real one.
 *
 * ## What this tool does not promise
 *
 * It does not confine the process. An allowlisted program can still write
 * anywhere it has permission to, and two of the three allowed ones can execute
 * project code (`node anything.js`, `npm run <script>`), as can `git diff`
 * through a configured `diff.external` or `textconv`. The guarantee is that a
 * human saw the exact command and said yes — not that the command was harmless.
 *
 * That is why `--auto-approve exec` exists as a flag and why this file's
 * neighbours never set it.
 */

export type ExecArgs = {
  /** An allowlisted program name. Never a path. */
  command: string;
  /** Arguments, passed to the program as an argv array. Never parsed. */
  args: string[];
  /** Working directory, relative to the workspace root. Defaults to the root. */
  cwd: string;
  /** How long the program may run before it is killed. */
  timeout_ms: number;
};

/** Everything a caller needs to judge what happened. */
export type ExecData = {
  command: string;
  args: string[];
  cwd: string;
  /** The program's exit status, or null when it was killed by a signal. */
  exit_code: number | null;
  signal: string | null;
  /** True when the timeout fired and the program was killed. */
  timed_out: boolean;
  duration_ms: number;
  stdout: string;
  stderr: string;
  /** True when a stream hit the output cap and the text is a prefix. */
  stdout_truncated: boolean;
  stderr_truncated: boolean;
};

// ---------------------------------------------------------------------------
// The allowlist.
//
// Deliberately short. Every entry here is a way to run arbitrary project code,
// so the question for each is "is this worth the surface", not "is this
// convenient". Extending it is a one-line change, and a change that has to be
// made deliberately.
// ---------------------------------------------------------------------------

type AllowlistEntry = {
  /** The name a caller writes. Looked up exactly; never assembled from parts. */
  readonly command: string;
  /**
   * The binary actually spawned.
   *
   * `node` is `process.execPath` rather than the string `"node"` on purpose: the
   * bridge is running a specific Node, and resolving the name through `PATH`
   * would let anything earlier on that path decide which interpreter the user's
   * project runs under.
   */
  readonly executable: (platform: NodeJS.Platform) => string;
  /** One line for the model's tool list. */
  readonly summary: string;
  /** The only first arguments this program accepts. */
  readonly subcommands?: ReadonlySet<string>;
  /** Refused regardless of approval, because they defeat containment. */
  readonly forbiddenArgs?: readonly RegExp[];
  /**
   * Present but not offered, and why.
   *
   * Kept in the table rather than deleted so the reason survives in the code
   * instead of in a commit message nobody will read. A name with `enabled:
   * false` is not reachable: the map that `parseArgs` looks in is built from the
   * filtered list, so the comment cannot drift away from the behaviour - if
   * someone re-enables the entry, it is one edit and a failing test.
   */
  readonly enabled?: boolean;
};

const GIT_READ_ONLY_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "status",
  "log",
  "diff",
  "show",
  "rev-parse",
  "ls-files",
  "blame",
  "describe",
  "shortlog",
  "cat-file",
]);

const NPM_SUBCOMMANDS: ReadonlySet<string> = new Set(["ls", "run", "test"]);

/**
 * `npm` is deliberately **not** on the allowlist, and this is the reason.
 *
 * On Windows `npm` is a batch shim, and since the fix for CVE-2024-27980 Node
 * refuses to spawn a `.cmd` or `.bat` without a shell. Measured on this
 * machine, Node v24.18:
 *
 *     spawnSync("npm",     ...) -> ENOENT   (not a real executable)
 *     spawnSync("npm.cmd", ...) -> EINVAL   (refused without a shell)
 *
 * So the only way to run npm here is `cmd.exe /c npm ...`, and that would make
 * the shell the program being allowlisted - at which point every rule above it
 * is decorative, because the shell's grammar contains every command the
 * allowlist excludes.
 *
 * This was not a judgement call made in advance. `npm` was on the list, the
 * tests caught `spawn EINVAL`, and the entry was removed rather than the
 * `shell: false` weakened. `npm run build` is reachable another way: `node` is
 * allowlisted, and `node node_modules/.bin/tsc` runs the same binary.
 */

/**
 * Flags that break the boundaries this tool relies on, whatever approves them.
 *
 *   `-c`, `--config-env`, `--exec-path`, `--git-dir`, `--work-tree`, `-C`
 *       `git -C /elsewhere` moves the working directory out of the sandbox
 *       entirely, and `git -c core.pager=<command>` executes an arbitrary
 *       program. Neither is visible in a subcommand list.
 *
 *   `--output`, `-o`, `--ext-diff`, `--textconv`
 *       `git diff -o file` writes a file, which is a `write` operation wearing
 *       an `exec` label - and so it skips the gate's class entirely. The
 *       external-diff flags run programs named in repository config.
 *
 *   `--prefix`, `--global`, `-g`, `--registry`
 *       Each of these moves npm's target outside the workspace or changes where
 *       packages come from.
 *
 * Refused in `parseArgs`, which means the user is never asked about them at all.
 */
const GIT_FORBIDDEN_ARGS: readonly RegExp[] = [
  /^--?(c|config-env|exec-path|git-dir|work-tree|namespace|C)\b/,
  /^--?(output|ext-diff|textconv)\b/,
  /^-o$/,
];

const NPM_FORBIDDEN_ARGS: readonly RegExp[] = [];

const ALLOWLIST: readonly AllowlistEntry[] = [
  {
    command: "node",
    // The exact interpreter running the bridge, not a name on PATH.
    executable: () => process.execPath,
    summary: "Run a Node script or a -e expression inside the workspace.",
  },
  {
    command: "git",
    // `git.exe` rather than `git`: on Windows a bare name is resolved through
    // PATHEXT, and naming the file is one less lookup between here and a
    // binary nobody has reviewed.
    executable: (platform) => (platform === "win32" ? "git.exe" : "git"),
    summary: "Inspect a repository: status, log, diff, show and other read-only commands.",
    subcommands: GIT_READ_ONLY_SUBCOMMANDS,
    forbiddenArgs: GIT_FORBIDDEN_ARGS,
  },
  {
    command: "npm",
    enabled: false,
    // See the block comment above: unreachable on Windows without a shell, and
    // the entry is kept out rather than quietly making `shell` optional.
    executable: (platform) => (platform === "win32" ? "npm.cmd" : "npm"),
    summary: "List, run or test the project's own npm scripts.",
    subcommands: NPM_SUBCOMMANDS,
    forbiddenArgs: NPM_FORBIDDEN_ARGS,
  },
];

const ALLOWLIST_BY_COMMAND: ReadonlyMap<string, AllowlistEntry> = new Map(
  ALLOWLIST
    .filter((entry) => entry.enabled !== false)
    .map((entry) => [entry.command, entry]),
);

/** The allowlisted program names, sorted. Used by tests and by error messages. */
export function execAllowlistNames(): string[] {
  return [...ALLOWLIST_BY_COMMAND.keys()].sort();
}

// ---------------------------------------------------------------------------
// Limits.
//
// Every one of these is a bound on what a single approved call can cost. They
// are caps rather than defaults where a larger value is never a real need, so
// asking for more returns an error the model can act on instead of a surprise.
// ---------------------------------------------------------------------------

/** Most arguments one call may pass. */
const MAX_ARGS = 64;

/** Longest single argument. Long enough for a path, short enough for a log row. */
const MAX_ARG_LENGTH = 4_096;

/** How long a program may run when the caller does not say. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** The hard ceiling, whatever the caller asks for. */
const MAX_TIMEOUT_MS = 120_000;


/** Bytes kept per stream. A program that prints without bound stops the model. */
const MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * Environment variables handed to the child.
 *
 * An allowlist rather than a copy of `process.env`, so the child cannot read —
 * and a command the user approved cannot be shown — anything the bridge happens
 * to hold. The one variable that gets special treatment is the path, below.
 */
const PASSTHROUGH_ENV: readonly string[] = [
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "SystemDrive",
  "COMSPEC",
  "ComSpec",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LC_ALL",
  "TZ",
  "OS",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
];

/**
 * Run an allowlisted program inside the workspace.
 *
 * `parseArgs` does all the refusal work — allowlist, subcommand, forbidden
 * flags, argument shape, directory, timeout — so a request that could not
 * possibly be honoured is refused *before* the user is prompted for it. The
 * approval gate is for asking about things that could go wrong, not for
 * collecting consent to a malformed call.
 */
export function createExec(guard: PathGuard): ToolDefinition<ExecArgs> {
  return {
    name: "exec",
    opClass: "exec",

    describe: () =>
      "{command, args, cwd?, timeout_ms?} Run one of the allowlisted programs (" +
      execAllowlistNames().join(", ") +
      ") inside the workspace and return its exit code and output. " +
      "Arguments are passed as a list, never as a shell string, and the working " +
      "directory is always inside the workspace. Always requires the user to " +
      "approve. " +
      "Note: an allowlisted program can still run code from the project and " +
      "write outside the workspace, so prefer reading before running anything.",

    parseArgs: (raw) => {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new ZxError("INTERNAL", "exec expects an object of arguments");
      }
      const input = raw as Record<string, unknown>;

      const command = input.command;
      if (typeof command !== "string" || command === "") {
        throw new ZxError(
          "INTERNAL",
          "exec needs command to be a non-empty string",
        );
      }

      // The lookup is the allowlist. A name that has to be *reached* by string
      // surgery to match would defeat it, so the check below exists to produce a
      // useful message rather than to widen anything: `C:\...\cmd.exe`,
      // `../../evil` and `node;rm` are all simply not in the table.
      const entry = ALLOWLIST_BY_COMMAND.get(command);
      if (entry === undefined) {
        throw new ZxError(
          "INTERNAL",
          `exec cannot run ${JSON.stringify(command)}: only ${execAllowlistNames().join(", ")} ` +
            "are allowed, and only by their bare name — not by path, and not through a shell. " +
            "There is no shell here, so `&&`, `|` and `;` are not operators.",
          { command },
        );
      }

      const args = parseArgumentList(input.args, command);

      // Forbidden flags before subcommands. Both refuse, so the order is about
      // the message rather than about safety - but the message is what tells a
      // model what to do differently next time. `git -c core.pager=x log`
      // otherwise reads as "the subcommand `core.pager=x` is not allowed",
      // which names the wrong thing entirely: the problem is the flag, and the
      // fact that the real subcommand was `log` is exactly what is dangerous
      // about it.
      for (const pattern of entry.forbiddenArgs ?? []) {
        const offender = args.find((arg) => pattern.test(arg));
        if (offender !== undefined) {
          throw new ZxError(
            "INTERNAL",
            `exec ${command} does not allow the argument ${JSON.stringify(offender)}. ` +
              "It would move the working directory outside the workspace, run an " +
              "unreviewed program, or write a file outside this tool's operation class.",
            { command, argument: offender },
          );
        }
      }

      if (entry.subcommands !== undefined) {
        const subcommand = firstNonFlagArgument(args);
        if (subcommand === undefined) {
          throw new ZxError(
            "INTERNAL",
            `exec ${command} needs one of these subcommands: ${[...entry.subcommands].sort().join(", ")}`,
            { command },
          );
        }
        if (!entry.subcommands.has(subcommand)) {
          throw new ZxError(
            "INTERNAL",
            `exec ${command} does not allow the subcommand ${JSON.stringify(subcommand)}. ` +
              `Allowed: ${[...entry.subcommands].sort().join(", ")}`,
            { command, subcommand },
          );
        }
      }

      // Resolved here, not in `run`, for the same reason every other tool does
      // it that way: an escape attempt must be refused before a human is asked
      // to consent to anything.
      const cwd = input.cwd === undefined ? "." : input.cwd;
      if (typeof cwd !== "string" || cwd === "") {
        throw new ZxError("INTERNAL", "exec needs cwd to be a non-empty string when supplied");
      }
      const cwdAbsolute = guard.resolve(cwd);
      if (!isDirectory(cwdAbsolute)) {
        throw new ZxError(
          "NOT_A_DIRECTORY",
          `exec needs cwd to name a directory, and ${JSON.stringify(cwd)} is not one`,
          { cwd },
        );
      }

      const timeout = parseTimeout(input.timeout_ms);

      return { command, args, cwd, timeout_ms: timeout };
    },

    summarize: (args) => renderInvocation(args.command, args.args),

    summarizeRaw: (raw) => {
      const candidate =
        raw !== null && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : {};
      const command = candidate.command;
      return typeof command === "string" && command !== ""
        ? renderInvocation(command, renderRawArguments(candidate.args))
        : "run <no command>";
    },

    run: async (args, signal) => {
      const entry = ALLOWLIST_BY_COMMAND.get(args.command);
      // Unreachable through the registry, which only ever calls `run` with what
      // `parseArgs` returned. Checked anyway: `run` is reachable directly from
      // tests, and an unknown name must not fall through to "spawn whatever".
      if (entry === undefined) {
        throw new ZxError(
          "INTERNAL",
          `exec cannot run ${JSON.stringify(args.command)}: it is not on the allowlist`,
          { command: args.command },
        );
      }

      // Re-resolved rather than trusted: the value arrived as a string in a
      // frozen object, and the guard is the only thing in the project entitled
      // to say a path is inside the sandbox.
      const cwdAbsolute = guard.resolve(args.cwd);

      const data = await runProcess({
        executable: entry.executable(process.platform),
        command: args.command,
        args: args.args,
        cwd: cwdAbsolute,
        timeoutMs: args.timeout_ms,
        env: buildChildEnv(guard.workspaceRoot),
        ...(signal === undefined ? {} : { signal }),
      });

      return { summary: renderOutcome(data), data };
    },
  };
}

// ---------------------------------------------------------------------------
// Execution.
// ---------------------------------------------------------------------------

type RunProcessInput = {
  executable: string;
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  env: Record<string, string>;
  /** The user stopped the run: the program is killed, not waited for. */
  signal?: AbortSignal;
};

function runProcess(input: RunProcessInput): Promise<ExecData> {
  const startedAt = Date.now();

  return new Promise<ExecData>((resolvePromise, rejectPromise) => {
    let child: ChildProcess;
    try {
      child = spawn(input.executable, input.args, {
        cwd: input.cwd,
        env: input.env,
        // The single most important line in this file. `shell: true` would make
        // the shell the program being allowlisted, and the shell's grammar
        // includes everything the allowlist exists to exclude.
        shell: false,
        windowsHide: true,
        // No stdin. A program that reads stdin gets EOF immediately rather than
        // hanging until the timeout — `npm test` asking a question it cannot ask.
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      rejectPromise(
        new ZxError(
          "COMMAND_FAILED",
          `could not start ${input.command}: ${messageOf(error)}`,
          { command: input.command },
        ),
      );
      return;
    }

    const stdout = new OutputCollector(MAX_OUTPUT_BYTES);
    const stderr = new OutputCollector(MAX_OUTPUT_BYTES);
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, input.timeoutMs);
    let stopped = false;
    const onStop = () => {
      stopped = true;
      killProcessTree(child);
    };
    if (input.signal?.aborted) onStop();
    else input.signal?.addEventListener("abort", onStop, { once: true });

    // `once`, not `on`, and guarded: `close` and `error` can both fire, and a
    // second settle on an already-resolved promise is the kind of thing that
    // turns one killed process into an unhandled rejection.
    child.stdout?.on("data", (chunk: Buffer) => stdout.add(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.add(chunk));

    child.once("error", (error) => {
      input.signal?.removeEventListener("abort", onStop);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(
        new ZxError(
          "COMMAND_FAILED",
          `could not start ${input.command}: ${messageOf(error)}. ` +
            "If it is on the allowlist it may simply not be installed on this machine.",
          { command: input.command, cwd: input.cwd },
        ),
      );
    });

    child.once("close", (code, signal) => {
      input.signal?.removeEventListener("abort", onStop);
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (stopped) {
        rejectPromise(new ZxError("COMMAND_FAILED", `${input.command} was stopped by the user`, { command: input.command }));
        return;
      }

      // A timeout is reported as a timeout rather than as a non-zero exit. The
      // difference is the difference between "this program failed" and "this
      // program was still going and we stopped it", and a model that cannot tell
      // them apart will retry a command that was never going to finish.
      if (timedOut) {
        rejectPromise(
          new ZxError(
            "TIMEOUT",
            `${input.command} was killed after ${input.timeoutMs}ms without finishing`,
            {
              command: input.command,
              timeout_ms: input.timeoutMs,
              stdout_bytes: stdout.bytes,
              stderr_bytes: stderr.bytes,
            },
          ),
        );
        return;
      }

      resolvePromise({
        command: input.command,
        args: input.args,
        // The caller's spelling, not the resolved one: the resolved path carries
        // this machine's 8.3 names and long drive paths, which the model would
        // then try to feed back in.
        cwd: input.cwd,
        exit_code: code,
        signal: signal ?? null,
        timed_out: false,
        duration_ms: Date.now() - startedAt,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdout_truncated: stdout.truncated,
        stderr_truncated: stderr.truncated,
      });
    });
  });
}

/**
 * Kill a process, and on Windows its descendants too.
 *
 * `child.kill()` terminates the process that was spawned and nothing else. On
 * Windows that is not sufficient in practice: `npm run` starts `node`, `npm run`
 * starts a shell, and the grandchild survives the timeout holding the port the
 * next call is about to ask for. `taskkill /T` walks the tree; the argv is
 * fixed, so there is nothing here for a caller to influence.
 *
 * `taskkill` failing is not interesting — it means the process already exited,
 * which is the outcome that was wanted anyway. `spawnSync` reports `ENOENT`
 * through `result.error` rather than throwing, so a machine without it lands in
 * the same branch and still gets the direct kill.
 */
function killProcessTree(child: ChildProcess): void {
  if (process.platform === "win32" && typeof child.pid === "number") {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 5_000,
      });
    } catch {
      // Falls through to the direct kill below, which is the one that matters.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // Already gone. Nothing to report: the timeout has been honoured.
  }
}

/**
 * Accumulate a stream up to a byte cap, then stop.
 *
 * Not `maxBuffer` — that is a different mechanism for a different API, and it
 * kills the process rather than truncating the output. Truncating and *saying
 * so* is what lets the model tell the difference between a short answer and a
 * cut-off one, which is the same rule `fs_read`'s `has_more` and `fs_grep`'s
 * `complete: false` already follow.
 */
class OutputCollector {
  readonly #cap: number;
  readonly #chunks: Buffer[] = [];
  #bytes = 0;
  #truncated = false;

  constructor(cap: number) {
    this.#cap = cap;
  }

  add(chunk: Buffer): void {
    if (this.#bytes >= this.#cap) {
      this.#truncated = true;
      return;
    }
    const room = this.#cap - this.#bytes;
    if (chunk.length > room) {
      this.#chunks.push(chunk.subarray(0, room));
      this.#bytes = this.#cap;
      this.#truncated = true;
      return;
    }
    this.#chunks.push(chunk);
    this.#bytes += chunk.length;
  }

  text(): string {
    return Buffer.concat(this.#chunks).toString("utf8");
  }

  get truncated(): boolean {
    return this.#truncated;
  }

  get bytes(): number {
    return this.#bytes;
  }
}

// ---------------------------------------------------------------------------
// Argument handling.
// ---------------------------------------------------------------------------

/**
 * Validate the argument list.
 *
 * An empty list is legitimate — `git status` is mostly flags, and `node --version`
 * is nothing — so the default is `[]` rather than an error. What is refused is
 * anything that is not a plain string: an argument that is an object, a number
 * or `null` is a caller bug, and `spawn` would stringify it into the argv in a
 * way nobody reviewed.
 */
function parseArgumentList(raw: unknown, command: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new ZxError(
      "INTERNAL",
      "exec needs args to be an array of strings, passed as a list and never as a shell string",
      { command },
    );
  }
  if (raw.length > MAX_ARGS) {
    throw new ZxError(
      "INTERNAL",
      `exec accepts at most ${MAX_ARGS} arguments, got ${raw.length}`,
      { command, count: raw.length },
    );
  }

  const args: string[] = [];
  for (const [index, value] of raw.entries()) {
    if (typeof value !== "string") {
      throw new ZxError(
        "INTERNAL",
        `exec argument ${index} must be a string, got ${typeof value}`,
        { command, index },
      );
    }
    // A NUL byte truncates the argument in the Win32 API, so `git\0 push` would
    // arrive as `git` — a different command from the one the user approved.
    if (value.includes("\u0000")) {
      throw new ZxError(
        "INTERNAL",
        `exec argument ${index} contains a NUL byte, which truncates it in the operating system`,
        { command, index },
      );
    }
    if (value.length > MAX_ARG_LENGTH) {
      throw new ZxError(
        "INTERNAL",
        `exec argument ${index} is longer than ${MAX_ARG_LENGTH} characters`,
        { command, index, length: value.length },
      );
    }
    args.push(value);
  }
  return args;
}

/**
 * The first argument that is not a flag, which is where a subcommand lives.
 *
 * `git --no-pager status` still runs `status`, so scanning past the leading
 * flags is what makes the subcommand allowlist usable at all. Stopping at the
 * first flag instead would make `git -c core.pager=x status` pass the subcommand
 * check by having no subcommand — and `-c` is refused separately, but only
 * because someone thought of it.
 */
function firstNonFlagArgument(args: readonly string[]): string | undefined {
  for (const arg of args) {
    if (arg === "--") break;
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return undefined;
}

/**
 * Validate the timeout.
 *
 * `Number.isFinite` before the comparisons, because `NaN >= MAX` is false: a
 * caller sending `timeout_ms: "30_000"` as a string would otherwise get a
 * timeout that is never `NaN`-checked downstream and a process that is never
 * killed. The same guard as `auto-send`'s counter, for the same reason.
 */
function parseTimeout(raw: unknown): number {
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw) || raw < 1) {
    throw new ZxError(
      "INTERNAL",
      `exec needs timeout_ms to be a whole number of milliseconds between 1 and ${MAX_TIMEOUT_MS}`,
      { timeout_ms: raw },
    );
  }
  if (raw > MAX_TIMEOUT_MS) {
    throw new ZxError(
      "INTERNAL",
      `exec will not run a program for more than ${MAX_TIMEOUT_MS}ms, and asked for ${raw}`,
      { timeout_ms: raw, limit: MAX_TIMEOUT_MS },
    );
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------

/**
 * The line the user reads before approving.
 *
 * The **whole** argv, never shortened. Truncation is routine and usually kind,
 * and here it would mean the human consents to `git status` while `git push
 * --force` runs — so the cap that exists everywhere else in this project does
 * not exist here. An over-long command line is a thing to scroll through.
 */
function renderInvocation(command: string, args: readonly string[]): string {
  return `run \`${[command, ...args].join(" ")}\``;
}

/**
 * Describe an argument list that never became one.
 *
 * The array is the normal shape and is rendered in full, because a refusal has
 * to be able to say *what* was refused — an audit row reading `run <malformed
 * arguments>` for a `git push --force` is useless in exactly the triage it
 * exists for. Anything else (a string, a number, a missing key) is named as
 * malformed instead of being coerced, so a caller that sent
 * `args: "rm -rf /"` is never shown back a rendering that looks valid.
 */
function renderRawArguments(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((value): value is string => typeof value === "string");
  }
  return ["<malformed arguments>"];
}

/**
 * The line recorded in the audit log, and shown to the model.
 *
 * The exit code is in it. A command that ran and returned 1 is not a failure of
 * the bridge — `grep` finds nothing, `git diff --quiet` reports a difference,
 * `npm test` reports a failing test — and a summary that said only "ran git
 * diff" would leave a model to guess whether to retry.
 */
function renderOutcome(data: ExecData): string {
  const status =
    data.exit_code === null ? `killed by ${data.signal ?? "a signal"}` : `exit ${data.exit_code}`;
  const truncated = data.stdout_truncated || data.stderr_truncated ? ", output truncated" : "";
  return `${data.command} ${status} in ${data.cwd} (${data.duration_ms}ms${truncated})`;
}

// ---------------------------------------------------------------------------
// Environment.
// ---------------------------------------------------------------------------

/**
 * Build the child's environment: a fixed set of variables, and a `PATH` with
 * the workspace taken out of it.
 *
 * The `PATH` scrub is the part worth explaining. Without it, the child's search
 * order includes every directory on the machine's path — and if the workspace is
 * on that path, or if a file named `git.exe` or `npm.cmd` has been written into
 * the project (which is exactly what a prompt injection asks for, and exactly
 * what `fs_write` will happily create), that file is found before the real
 * binary. The allowlist would still have approved the name; only the scrub
 * stops the name being a lie.
 *
 * The comparison is textual, so it catches the workspace root and its children
 * as spelled. A directory reached only through a junction is not caught, and is
 * named as a limitation rather than claimed as covered.
 */
function buildChildEnv(workspaceRoot: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH_ENV) {
    const value = process.env[key];
    if (typeof value === "string") env[key] = value;
  }

  // Found by scan rather than read as `PATH`, because on Windows the variable is
  // spelled `Path` and `process.env.PATH` is simply `undefined` there.
  const pathKey =
    Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const rawPath = process.env[pathKey];
  if (typeof rawPath === "string") {
    env[pathKey] = scrubWorkspaceFromPath(rawPath, workspaceRoot);
  }

  // Colour codes in a captured stream are noise the model pays context for.
  env.NO_COLOR = "1";
  return env;
}

function scrubWorkspaceFromPath(rawPath: string, workspaceRoot: string): string {
  const root = trimTrailingSeparators(workspaceRoot);
  const kept = rawPath.split(delimiter).filter((entry) => {
    const trimmed = trimTrailingSeparators(entry.trim());
    if (trimmed === "") return false;
    return !isWithinTextually(trimmed, root);
  });
  return kept.join(delimiter);
}

function trimTrailingSeparators(value: string): string {
  return value.replace(/[\\/]+$/, "");
}

/** Windows compares path text case-insensitively; POSIX does not. */
function isWithinTextually(candidate: string, root: string): boolean {
  const normalise = (value: string): string => {
    const folded = process.platform === "win32" ? value.toLowerCase() : value;
    return folded.replace(/\\/g, "/").replace(/\/+$/, "");
  };
  const a = normalise(candidate);
  const b = normalise(root);
  return a === b || a.startsWith(`${b}/`);
}

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    // A path that cannot be stat'ed is not a directory, and the caller is about
    // to be told so — but as the sandbox's own error rather than a bare ENOENT
    // from deep inside a spawn.
    return false;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
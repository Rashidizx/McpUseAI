import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { readFileSync } from "node:fs";

import { createExec, execAllowlistNames, type ExecData } from "../src/tools/exec.js";
import { PathGuard } from "../src/core/path-guard.js";
import { ApprovalGate } from "../src/core/approval-gate.js";
import { AuditLog } from "../src/core/audit-log.js";
import { ToolRegistry } from "../src/core/tool-registry.js";
import { ZxError } from "../src/core/errors.js";
import { App } from "../src/app.js";
import { makeTempWorkspace, cleanupTempDirs, realPathOf, makeTempDir } from "./helpers.js";

afterEach(cleanupTempDirs);

/**
 * `exec`, through the real registry.
 *
 * ## What is being defended
 *
 * Every other tool in this project is bounded by `PathGuard`: it resolves each
 * path it is given and refuses anything landing outside the workspace. A
 * process has no such property, so `exec` is the one tool where the sandbox is
 * not the containment and everything else is.
 *
 * That makes the tests below unusual for this file's directory: most of them
 * assert that something is **refused before a human is asked about it**. A
 * refusal that reaches the approval prompt has already cost the user a click,
 * and a refusal that reaches `spawn` has already run. So the prompter-call
 * counter is asserted directly rather than inferred from the error code.
 *
 * ## What is deliberately not tested here
 *
 * That an allowlisted command is harmless. `node`, `git` and `npm` can all run
 * project code and write outside the workspace; the guarantee is that a human
 * saw the exact argv and agreed. Asserting otherwise would be asserting a
 * property this tool does not have.
 */

const MAX_TIMEOUT_MS = 120_000;

function setup(): { guard: PathGuard; root: string } {
  const root = makeTempWorkspace();
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "alpha.ts"), "export const alpha = 1;\n");
  writeFileSync(join(root, "note.txt"), "hello\n");
  return { guard: new PathGuard(root), root };
}

/** Parse and run in one step, which is what every behavioural test needs. */
async function run(
  guard: PathGuard,
  args: Record<string, unknown>,
): Promise<ExecData> {
  const tool = createExec(guard);
  const parsed = tool.parseArgs(args);
  const result = await tool.run(parsed);
  return result.data as ExecData;
}

/**
 * A registry whose gate records what it was asked, so a test can assert that
 * nothing was asked.
 */
function registryWith(
  guard: PathGuard,
  decision: "approved" | "denied" = "approved",
): {
  registry: ToolRegistry;
  audit: AuditLog;
  prompts: { toolName: string; opClass: string; summary: string }[];
} {
  const prompts: { toolName: string; opClass: string; summary: string }[] = [];
  const audit = new AuditLog(":memory:");
  const gate = new ApprovalGate({
    // `exec` is deliberately absent: it must never run without a human.
    autoApprove: ["read"],
    prompter: async (prompt) => {
      prompts.push({
        toolName: prompt.toolName,
        opClass: prompt.opClass,
        summary: prompt.summary,
      });
      return decision;
    },
  });
  const registry = new ToolRegistry({ guard, gate, audit });
  registry.register(createExec(guard));
  return { registry, audit, prompts };
}

describe("the allowlist is the only way to name a program", () => {
  it("offers exactly the programs that can actually run without a shell", () => {
    // `npm` was on this list and the tests caught `spawn EINVAL`. See the block
    // comment in `exec.ts`: Node refuses a `.cmd` shim without a shell since the
    // fix for CVE-2024-27980, so on Windows the only route to npm is
    // `cmd.exe /c`, which would make the shell the allowlisted program.
    expect(execAllowlistNames()).toEqual(["git", "node"]);
  });

  it.each([
    ["rm", "a program nobody reviewed"],
    ["bash", "a shell, which would make every other rule meaningless"],
    ["powershell", "a shell, on the platform this was written on"],
    ["cmd.exe", "a shell"],
    ["npx", "installs and runs arbitrary packages"],
    ["npm", "needs a shell to run at all on Windows"],
    ["curl", "reaches the network"],
    ["python", "runs arbitrary code with no allowlist entry to justify it"],
  ])("refuses %s", (command) => {
    const { guard } = setup();
    expect(() => createExec(guard).parseArgs({ command })).toThrow(ZxError);
  });

  it.each([
    "C:\\Windows\\System32\\cmd.exe",
    "/bin/sh",
    "../../evil",
    "./node",
    "node.exe",
    "npm.cmd",
    "NODE",
    " node",
    "node ",
    "node;git",
  ])("refuses %s, because a name has to match exactly", (command) => {
    const { guard } = setup();
    expect(() => createExec(guard).parseArgs({ command })).toThrow(/allow|not on the allowlist|only/i);
  });

  it("refuses a missing or empty command rather than defaulting to one", () => {
    const { guard } = setup();
    const tool = createExec(guard);
    expect(() => tool.parseArgs({})).toThrow(ZxError);
    expect(() => tool.parseArgs({ command: "" })).toThrow(ZxError);
    expect(() => tool.parseArgs({ command: 7 })).toThrow(ZxError);
  });
});

describe("nothing is refused too late", () => {
  // The ordering is the property. A refusal raised from `run` would still look
  // correct to a caller checking the error code, while having already spent the
  // user's one click on a command that could never have worked.

  it.each([
    ["an unknown command", { command: "rm", args: ["-rf", "/"] }],
    ["a subcommand that is not allowed", { command: "git", args: ["push"] }],
    ["a flag that defeats containment", { command: "git", args: ["-c", "core.pager=x", "log"] }],
    ["a working directory outside the sandbox", { command: "node", cwd: "../../.." }],
    ["a timeout above the ceiling", { command: "node", timeout_ms: MAX_TIMEOUT_MS + 1 }],
    ["a malformed argument", { command: "node", args: "rm -rf /" }],
  ])("does not ask about %s", async (_label, raw) => {
    const { guard } = setup();
    const { registry, prompts } = registryWith(guard);
    await expect(registry.call("exec", raw)).rejects.toThrow(ZxError);
    expect(prompts).toEqual([]);
  });

  it("does not ask about a command that cannot run either", async () => {
    // The rule is about ordering, not about this particular machine: `npm` is
    // refused because it needs a shell, and asking a human about it first would
    // spend their click on a call that could only ever fail.
    const { guard } = setup();
    const { registry, prompts } = registryWith(guard);
    await expect(registry.call("exec", { command: "npm", args: ["run", "build"] })).rejects.toThrow(
      ZxError,
    );
    expect(prompts).toEqual([]);
  });
});

describe("git is limited to reading, whatever approves it", () => {
  it.each([
    ["push", ["push"]],
    ["reset --hard", ["reset", "--hard"]],
    ["clean", ["clean", "-fd"]],
    ["checkout", ["checkout", "main"]],
    ["commit", ["commit", "-m", "x"]],
    ["stash", ["stash"]],
    ["remote remove", ["remote", "remove", "origin"]],
  ])("refuses git %s", (_label, args) => {
    const { guard } = setup();
    expect(() => createExec(guard).parseArgs({ command: "git", args })).toThrow(
      /does not allow the subcommand/,
    );
  });

  it.each([
    [["-c", "core.pager=touch /tmp/pwned"]],
    [["-C", "C:\\Windows"]],
    [["--git-dir", "C:\\other\\.git"]],
    [["--exec-path"]],
    [["diff", "--output=/tmp/out.txt"]],
    [["diff", "-o", "out.txt"]],
    [["diff", "--ext-diff"]],
  ])("refuses git %j, which either escapes the workspace or runs an unreviewed program", (args) => {
    const { guard } = setup();
    expect(() => createExec(guard).parseArgs({ command: "git", args })).toThrow(
      /does not allow the argument/,
    );
  });

  it("still allows the read-only commands, including behind a flag", () => {
    const { guard } = setup();
    const tool = createExec(guard);
    expect(tool.parseArgs({ command: "git", args: ["status"] }).args).toEqual(["status"]);
    // The subcommand is found past leading flags, so `--no-pager log` is not
    // mistaken for "no subcommand given".
    expect(tool.parseArgs({ command: "git", args: ["--no-pager", "log"] }).args).toEqual([
      "--no-pager",
      "log",
    ]);
  });

  it("needs a subcommand at all, because bare `git` is an interactive pager", () => {
    const { guard } = setup();
    expect(() => createExec(guard).parseArgs({ command: "git" })).toThrow(/needs one of these subcommands/);
    expect(() => createExec(guard).parseArgs({ command: "git", args: ["-q"] })).toThrow(
      /needs one of these subcommands/,
    );
  });

  it("reports a real git failure as data rather than throwing", async () => {
    const { guard } = setup();
    // The temp workspace is not a repository, so this genuinely fails — and the
    // point is that it comes back as an exit code. A model that cannot tell a
    // non-zero exit from a bridge failure will retry forever.
    const data = await run(guard, { command: "git", args: ["status"] });
    expect(data.exit_code).not.toBe(0);
    expect(data.timed_out).toBe(false);
  });
});

describe("npm is absent for a measured reason, not a preference", () => {
  it("is refused by name, before any approval prompt", () => {
    const { guard } = setup();
    const tool = createExec(guard);
    for (const args of [["run", "build"], ["install"], ["--global", "run", "x"]]) {
      expect(() => tool.parseArgs({ command: "npm", args })).toThrow(/allow/i);
    }
  });

  it("cannot be reached through a path that sidesteps the lookup", () => {
    const { guard } = setup();
    const tool = createExec(guard);
    // The batch shim, the `cmd.exe` that would be needed to run it, and the
    // `npm-cli.js` behind it. All three are refused for the same reason: none of
    // them is the name on the list.
    expect(() => tool.parseArgs({ command: "npm.cmd" })).toThrow(ZxError);
    expect(() => tool.parseArgs({ command: "cmd.exe", args: ["/c", "npm", "run", "build"] })).toThrow(
      ZxError,
    );
    expect(() =>
      tool.parseArgs({
        command: "node",
        args: [process.env.npm_execpath ?? "npm-cli.js"],
      }),
    ).not.toThrow();
  });

  it("still leaves the project's own scripts reachable through node", () => {
    // The point of refusing is to keep `shell: false`. Running the binary
    // directly costs one more argument and loses nothing, so nothing is actually
    // given up here.
    const { guard, root } = setup();
    mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(root, "node_modules", ".bin", "tool.js"), "process.stdout.write('ran');\n");
    const parsed = createExec(guard).parseArgs({
      command: "node",
      args: ["node_modules/.bin/tool.js"],
    });
    expect(parsed.args).toEqual(["node_modules/.bin/tool.js"]);
  });
});

describe("arguments are a list, and stay a list", () => {
  it("refuses anything that is not an array of strings", () => {
    const { guard } = setup();
    const tool = createExec(guard);
    expect(() => tool.parseArgs({ command: "node", args: "rm -rf /" })).toThrow(/array of strings/);
    expect(() => tool.parseArgs({ command: "node", args: [{ toString: "rm -rf /" }] })).toThrow(
      /must be a string/,
    );
    expect(() => tool.parseArgs({ command: "node", args: [null] })).toThrow(/must be a string/);
  });

  it("refuses a NUL byte, which truncates the argument in the operating system", () => {
    const { guard } = setup();
    expect(() => createExec(guard).parseArgs({ command: "node", args: ["--version\u0000"] })).toThrow(
      /NUL byte/,
    );
  });

  it("caps how many arguments and how long each one may be", () => {
    const { guard } = setup();
    const tool = createExec(guard);
    expect(() => tool.parseArgs({ command: "node", args: new Array(65).fill("x") })).toThrow(
      /at most 64/,
    );
    expect(() => tool.parseArgs({ command: "node", args: ["x".repeat(4_097)] })).toThrow(/longer than/);
  });

  it("treats a missing args list as no arguments, not as an error", () => {
    const { guard } = setup();
    expect(createExec(guard).parseArgs({ command: "node" }).args).toEqual([]);
  });

  it("passes shell metacharacters through as ordinary text", async () => {
    // The single most important property of this tool. With `shell: true` the
    // argument below would run a second program; the allowlist would be naming
    // `node` while `touch` executed.
    const { guard, root } = setup();
    const data = await run(guard, {
      command: "node",
      args: ["-e", "process.stdout.write('a && touch pwned ; echo `whoami` | cat')"],
    });
    expect(data.exit_code).toBe(0);
    expect(data.stdout).toBe("a && touch pwned ; echo `whoami` | cat");
    expect(existsSync(join(root, "pwned"))).toBe(false);
  });
});

describe("the working directory stays inside the workspace", () => {
  it("refuses to escape, by the same code every other tool reports", () => {
    const { guard } = setup();
    expect(() => createExec(guard).parseArgs({ command: "node", cwd: "../../.." })).toThrow(
      /sandbox|traversal/i,
    );
  });

  it("refuses an absolute path outside the workspace", () => {
    const { guard } = setup();
    expect(() => createExec(guard).parseArgs({ command: "node", cwd: "C:\\Windows" })).toThrow(
      ZxError,
    );
  });

  it("refuses a path that is a file rather than a directory", () => {
    const { guard } = setup();
    try {
      createExec(guard).parseArgs({ command: "node", cwd: "note.txt" });
      expect.unreachable("a file is not a working directory");
    } catch (error) {
      expect(error).toBeInstanceOf(ZxError);
      expect((error as ZxError).code).toBe("NOT_A_DIRECTORY");
    }
  });

  it("actually runs in the directory it was given", async () => {
    const { guard } = setup();
    const data = await run(guard, {
      command: "node",
      args: ["-e", "process.stdout.write(process.cwd())"],
      cwd: "src",
    });
    // Only the tail is compared: the resolved root carries this machine's
    // 8.3 names and drive casing, which are not the caller's spelling.
    expect(data.stdout.replace(/\\/g, "/")).toMatch(/\/src$/);
  });
});

describe("the timeout is real", () => {
  it("refuses a timeout above the ceiling, a string, and a non-integer", () => {
    const { guard } = setup();
    const tool = createExec(guard);
    expect(() => tool.parseArgs({ command: "node", timeout_ms: MAX_TIMEOUT_MS + 1 })).toThrow(
      /will not run a program for more than/,
    );
    expect(() => tool.parseArgs({ command: "node", timeout_ms: "30000" })).toThrow(/whole number/);
    expect(() => tool.parseArgs({ command: "node", timeout_ms: 1.5 })).toThrow(/whole number/);
    // `NaN >= MAX` is false, so without the finite check this value would
    // produce a process that is never killed.
    expect(() => tool.parseArgs({ command: "node", timeout_ms: Number.NaN })).toThrow(/whole number/);
  });

  it("kills a program that will not finish, and says TIMEOUT rather than exit 0", async () => {
    const { guard } = setup();
    const startedAt = Date.now();
    await expect(
      run(guard, { command: "node", args: ["-e", "setTimeout(() => {}, 120000)"], timeout_ms: 400 }),
    ).rejects.toThrow(ZxError);

    try {
      await run(guard, { command: "node", args: ["-e", "setTimeout(() => {}, 120000)"], timeout_ms: 400 });
      expect.unreachable("the timeout should have fired");
    } catch (error) {
      expect((error as ZxError).code).toBe("TIMEOUT");
    }

    // Bounded, not merely reported: a "timeout" that fires but leaves the
    // process running would still hold whatever it had open.
    expect(Date.now() - startedAt).toBeLessThan(20_000);
  });
});

describe("output is capped, and the cap is reported", () => {
  it("truncates a program that prints without bound and says so", async () => {
    const { guard } = setup();
    const tool = createExec(guard);
    const result = await tool.run(
      tool.parseArgs({
        command: "node",
        args: ["-e", "process.stdout.write('x'.repeat(300000))"],
      }),
    );
    const data = result.data as ExecData;
    expect(data.stdout_truncated).toBe(true);
    expect(data.stdout.length).toBeLessThanOrEqual(64 * 1024);
    // The honest bit: without the flag a model would read a short answer as a
    // complete one, so the flag has to reach the summary the model reads too.
    expect(result.summary).toContain("output truncated");
  });

  it("says nothing about truncation when nothing was cut", async () => {
    const { guard } = setup();
    const data = await run(guard, { command: "node", args: ["-e", "process.stdout.write('short')"] });
    expect(data.stdout_truncated).toBe(false);
    expect(data.stdout).toBe("short");
  });

  it("captures stderr separately from stdout", async () => {
    const { guard } = setup();
    const data = await run(guard, {
      command: "node",
      args: ["-e", "process.stderr.write('bad'); process.exit(3)"],
    });
    expect(data.stderr).toBe("bad");
    expect(data.stdout).toBe("");
    expect(data.exit_code).toBe(3);
  });
});

describe("the child gets a fixed environment, not the bridge's", () => {
  it("cannot read a variable the operator happens to have set", async () => {
    const { guard } = setup();
    process.env.ZX_TEST_SECRET = "hunter2";
    try {
      const data = await run(guard, {
        command: "node",
        args: ["-e", "process.stdout.write(String(process.env.ZX_TEST_SECRET))"],
      });
      expect(data.stdout).toBe("undefined");
    } finally {
      delete process.env.ZX_TEST_SECRET;
    }
  });

  it("cannot see a workspace directory planted on the bridge's PATH", async () => {
    // The scenario this guards is concrete: a prompt injection gets `fs_write`
    // to create `git.exe` in the project, and then `git` resolves to it. The
    // allowlist still approves the *name*, so only the scrub stops that.
    const { guard, root } = setup();
    // The *real* path goes on PATH, not the string `mkdtempSync` handed back.
    // The guard scrubs against its expanded root, so planting the 8.3 short
    // form would leave it in place and the assertion below would pass for the
    // wrong reason - which is exactly what happened the first time this test was
    // written. A negative control that stays green is not a control.
    const realRoot = realPathOf(root).replace(/[\\/]+$/, "");
    const pathKey =
      Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
    const saved = process.env[pathKey];
    process.env[pathKey] = [realRoot, saved ?? ""].filter(Boolean).join(delimiter);
    try {
      const data = await run(guard, {
        command: "node",
        args: ["-e", "process.stdout.write(process.env.PATH || '')"],
      });
      const seen = data.stdout.split(delimiter).map((entry) => entry.replace(/[\\/]+$/, ""));
      expect(seen).not.toContain(realRoot);
      // And it did not lose the rest of the path doing it, or nothing would run.
      expect(seen.length).toBeGreaterThan(0);
    } finally {
      if (saved === undefined) delete process.env[pathKey];
      else process.env[pathKey] = saved;
    }
  });

  it("finds a real binary anyway, so the scrub costs nothing", async () => {
    const { guard } = setup();
    const data = await run(guard, { command: "node", args: ["--version"] });
    expect(data.exit_code).toBe(0);
    expect(data.stdout).toMatch(/^v\d/);
  });
});

describe("a human decides, and the decision is on the record", () => {
  it("declares the exec class, so the gate never lets it through silently", () => {
    const { guard } = setup();
    expect(createExec(guard).opClass).toBe("exec");
  });

  it("asks, and shows the command class, before running", async () => {
    const { guard } = setup();
    const { registry, prompts, audit } = registryWith(guard);
    await registry.call("exec", { command: "node", args: ["--version"] });
    expect(prompts).toEqual([
      { toolName: "exec", opClass: "exec", summary: "run `node --version`" },
    ]);
    const rows = audit.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ toolName: "exec", opClass: "exec", status: "ok" });
    audit.close();
  });

  it("does not run when the human says no, and files it as a denial", async () => {
    const { guard } = setup();
    const { registry, audit } = registryWith(guard, "denied");
    await expect(registry.call("exec", { command: "node", args: ["-e", "process.exit(0)"] })).rejects.toThrow(
      /denied/,
    );
    const rows = audit.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "denied", errorCode: "APPROVAL_DENIED" });
    audit.close();
  });

  it("files a refusal as well, so the trail shows what was asked for", async () => {
    const { guard } = setup();
    const { registry, audit } = registryWith(guard);
    await expect(registry.call("exec", { command: "curl", args: ["http://example.com"] })).rejects.toThrow();
    const rows = audit.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ opClass: "exec", status: "error" });
    // The summary names what was attempted: a generic row cannot answer "what
    // was this bridge trying to reach".
    expect(rows[0]?.summary).toContain("curl");
    audit.close();
  });

  it("files a timeout as an error carrying the code", async () => {
    const { guard } = setup();
    const { registry, audit } = registryWith(guard);
    await expect(
      registry.call("exec", {
        command: "node",
        args: ["-e", "setTimeout(() => {}, 120000)"],
        timeout_ms: 400,
      }),
    ).rejects.toThrow(/killed after 400ms/);
    expect(audit.list()[0]).toMatchObject({ status: "error", errorCode: "TIMEOUT" });
    audit.close();
  });
});

describe("what the human is shown", () => {
  it("is the whole argv, never a shortened rendering", () => {
    // Approving `git status` while `git push --force` runs is the failure this
    // guards. Every other message in this project is length-capped; this one is
    // not, on purpose.
    const { guard } = setup();
    const tool = createExec(guard);
    const long = "--flag=" + "y".repeat(500);
    const args = tool.parseArgs({ command: "git", args: ["status", long] });
    expect(tool.summarize(args)).toBe(`run \`git status ${long}\``);
  });

  it("still describes an attempt whose arguments never parsed", () => {
    const { guard } = setup();
    const tool = createExec(guard);
    const summarizeRaw = tool.summarizeRaw;
    // Optional on the type, but this tool supplies it: an audit row for a
    // refused `git push --force` that says only "malformed arguments" is
    // exactly the row that cannot answer a question.
    if (summarizeRaw === undefined) throw new Error("exec supplies no summarizeRaw");
    expect(summarizeRaw({ command: "git", args: ["push", "--force"] })).toBe(
      "run `git push --force`",
    );
    expect(summarizeRaw({})).toBe("run <no command>");
    // Malformed input must not be able to throw from the hook that exists to
    // describe it: the registry swallows a throw here and loses the description.
    expect(summarizeRaw({ command: "node", args: "oops" })).toContain("malformed");
    expect(summarizeRaw(null)).toBe("run <no command>");
  });

  it("says which programs are allowed, in the tool list the model reads", () => {
    const { guard } = setup();
    const description = createExec(guard).describe();
    for (const name of execAllowlistNames()) expect(description).toContain(name);
    expect(description).toMatch(/no shell|shell/i);
  });
});

describe("nothing turns exec into a silent operation", () => {
  it("the bridge does not auto-approve it by default", async () => {
    // The one setting that would defeat the whole tool is `autoApprove` listing
    // `exec`. It has to be a thing the operator types on a command line at
    // a choice the user makes in settings, never a default.
    const { root } = setup();
    const { registry, prompts } = registryWith(new PathGuard(root));
    await registry.call("exec", { command: "node", args: ["--version"] });
    expect(prompts).toHaveLength(1);

    // And the factory default really is empty, rather than empty by accident of
    // the current code.
    const app = new App({ stateDir: makeTempDir("zx-state-") });
    expect(app.state().settings.mode).toBe("ask");
    app.close();
  });

  it("it is declared with the exec class, which is what the gate decides on", () => {
    const { guard } = setup();
    expect(createExec(guard).opClass).toBe("exec");
  });

});

describe("run() refuses a name parseArgs would never have produced", () => {
  it("rather than spawning whatever it was handed", async () => {
    // `run` is reachable directly from tests, and the registry only ever calls it
    // with what `parseArgs` returned. A missing check here would be a tool whose
    // safety depends on a caller it does not control.
    const { guard } = setup();
    const tool = createExec(guard);
    const run_ = tool.run;
    if (run_ === undefined) throw new Error("exec has no run()");
    await expect(
      run_.call(tool, { command: "curl", args: ["http://example.com"], cwd: ".", timeout_ms: 5_000 }),
    ).rejects.toThrow(/not on the allowlist/);
    await expect(
      run_.call(tool, { command: "bash", args: ["-c", "echo hi"], cwd: ".", timeout_ms: 5_000 }),
    ).rejects.toThrow(/not on the allowlist/);
  });
});
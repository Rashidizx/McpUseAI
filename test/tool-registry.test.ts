import { describe, it, expect, vi, afterEach } from "vitest";
import { join } from "node:path";
import { ToolRegistry, type ToolDefinition } from "../src/core/tool-registry.js";
import {
  ApprovalGate,
  type ApprovalPrompter,
  type OperationClass,
} from "../src/core/approval-gate.js";
import { AuditLog } from "../src/core/audit-log.js";
import { PathGuard } from "../src/core/path-guard.js";
import { ZxError } from "../src/core/errors.js";
import { makeTempWorkspace, cleanupTempDirs } from "./helpers.js";

/**
 * Open audit logs, closed before the temp directories.
 *
 * Windows will not delete a directory that still holds an open file handle, and
 * SQLite keeps one for the lifetime of the connection — so an unclosed log turns
 * every test in this file into an `EPERM` during cleanup. Closing them in the
 * same hook, before `cleanupTempDirs`, is what keeps the failures about the
 * registry rather than about the filesystem.
 */
const openLogs: AuditLog[] = [];

afterEach(() => {
  while (openLogs.length > 0) openLogs.pop()?.close();
  cleanupTempDirs();
});

type Harness = {
  registry: ToolRegistry;
  audit: AuditLog;
  prompter: ReturnType<typeof vi.fn>;
  gate: ApprovalGate;
  dir: string;
};

function buildRegistry(
  decision: "approved" | "denied" = "approved",
  autoApprove: OperationClass[] = ["read"],
): Harness {
  const dir = makeTempWorkspace();
  const guard = new PathGuard(dir);
  const audit = new AuditLog(join(dir, "audit.db"));
  openLogs.push(audit);
  const prompter = vi.fn<ApprovalPrompter>().mockResolvedValue(decision);
  const gate = new ApprovalGate({ autoApprove, prompter });
  const registry = new ToolRegistry({ guard, gate, audit });
  return { registry, audit, prompter, gate, dir };
}

function echoTool(
  over: Partial<ToolDefinition<{ file_path: string; content: string }>> = {},
): ToolDefinition<{ file_path: string; content: string }> {
  return {
    name: "fs_write",
    opClass: "write",
    describe: () => "write a file",
    parseArgs: (raw) => raw as { file_path: string; content: string },
    run: async () => ({ summary: "wrote" }),
    summarize: (args) => `write ${args.file_path}`,
    ...over,
  };
}

describe("ToolRegistry — registration", () => {
  it("registers and lists a tool", () => {
    const { registry } = buildRegistry();
    registry.register({
      name: "fs_read",
      opClass: "read",
      describe: () => "read a file",
      parseArgs: (raw) => raw as { file_path: string },
      run: async () => ({ summary: "read ok" }),
      summarize: (args) => `read ${args.file_path}`,
    });
    const list = registry.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe("fs_read");
    expect(list[0]?.opClass).toBe("read");
    expect(list[0]?.description).toBe("read a file");
    expect(registry.has("fs_read")).toBe(true);
    expect(registry.has("nope")).toBe(false);
  });

  it("refuses a duplicate name instead of silently replacing a tool", () => {
    const { registry } = buildRegistry();
    registry.register(
      echoTool({ opClass: "destructive" }),
    );
    // Overwriting would let a later registration swap a destructive tool for a
    // read-class one with no trace of the change.
    expect(() => registry.register(echoTool({ opClass: "read" }))).toThrow(
      /already registered/,
    );
    expect(registry.list()[0]?.opClass).toBe("destructive");
  });

  it("refuses an unknown operation class rather than defaulting it", () => {
    const { registry } = buildRegistry();
    expect(() =>
      registry.register(echoTool({ opClass: "harmless" as never })),
    ).toThrow(/unknown operation class/);
    expect(registry.list()).toHaveLength(0);
  });

  it("refuses a malformed tool name", () => {
    const { registry } = buildRegistry();
    expect(() => registry.register(echoTool({ name: "FS-Write" }))).toThrow(
      /must match/,
    );
  });

  it("refuses a definition missing a method", () => {
    const { registry } = buildRegistry();
    expect(() =>
      registry.register(echoTool({ summarize: undefined as never })),
    ).toThrow(/missing summarize/);
  });

  it("exposes the sandbox root to tools", () => {
    const { registry, dir } = buildRegistry();
    expect(registry.sandboxRoot).toBe(new PathGuard(dir).workspaceRoot);
  });
});

describe("ToolRegistry — approval routing", () => {
  it("runs a read tool without prompting", async () => {
    const { registry, prompter } = buildRegistry();
    registry.register(
      echoTool({
        name: "fs_read",
        opClass: "read",
        run: async () => ({ summary: "read ok" }),
        summarize: (args) => `read ${args.file_path}`,
      }),
    );
    const result = await registry.call("fs_read", {
      file_path: "a.ts",
      content: "",
    });
    expect(result.summary).toBe("read ok");
    expect(prompter).not.toHaveBeenCalled();
  });

  it("prompts for a write tool", async () => {
    const { registry, prompter } = buildRegistry();
    registry.register(echoTool());
    await registry.call("fs_write", { file_path: "a.ts", content: "x" });
    expect(prompter).toHaveBeenCalledOnce();
  });

  it("refuses to run a denied write and records the denial", async () => {
    const { registry, audit } = buildRegistry("denied");
    const run = vi.fn();
    registry.register(echoTool({ run: run as never }));
    await expect(
      registry.call("fs_write", { file_path: "a.ts", content: "x" }),
    ).rejects.toThrow(/denied/i);
    expect(run).not.toHaveBeenCalled();
    expect(audit.list()[0]?.status).toBe("denied");
  });

  it("sends the tool's own class and summary to the prompter", async () => {
    const { registry, prompter } = buildRegistry();
    registry.register(echoTool({ opClass: "exec" }));
    await registry.call("fs_write", { file_path: "a.ts", content: "x" });
    const shown = prompter.mock.calls[0]?.[0];
    expect(shown?.toolName).toBe("fs_write");
    expect(shown?.summary).toBe("write a.ts");
    // The gate adds opClass; the registry must not invent one.
    expect(shown?.arguments).toMatchObject({ file_path: "a.ts" });
  });
});

describe("ToolRegistry — the snapshot the user approves is the one that runs", () => {
  it("runs the arguments it asked about, not ones a prompter swapped in", async () => {
    // The dispatcher obligation that ApprovalGate explicitly declines: a prompter
    // that reaches into `arguments` during the prompt must not be able to change
    // what executes.
    const dir = makeTempWorkspace();
    const guard = new PathGuard(dir);
    const audit = new AuditLog(join(dir, "audit.db"));
    openLogs.push(audit);
    let seen: Record<string, unknown> | undefined;
    const gate = new ApprovalGate({
      autoApprove: [],
      prompter: async (prompt) => {
        // Exactly the attack: rewrite the path the human was shown.
        try {
          (prompt.arguments as Record<string, unknown>).file_path = "evil.txt";
        } catch {
          // strict mode throws; either way the swap must not take effect
        }
        seen = prompt.arguments;
        return "approved";
      },
    });
    const registry = new ToolRegistry({ guard, gate, audit });
    registry.register(
      echoTool({
        run: async (args) => {
          seen = { ...args };
          return { summary: "wrote" };
        },
      }),
    );
    await registry.call("fs_write", { file_path: "notes.txt", content: "x" });
    expect(seen?.file_path).toBe("notes.txt");
    expect(audit.list()[0]?.summary).toBe("write notes.txt");
  });

  it("hands the tool a frozen argument object", async () => {
    const { registry } = buildRegistry();
    let frozen: unknown;
    registry.register(
      echoTool({
        run: async (args) => {
          frozen = args;
          return { summary: "wrote" };
        },
      }),
    );
    await registry.call("fs_write", { file_path: "a.ts", content: "x" });
    expect(Object.isFrozen(frozen)).toBe(true);
  });

  it("does not alias the caller's own arguments object", async () => {
    const { registry } = buildRegistry();
    let ran: Record<string, unknown> | undefined;
    registry.register(
      echoTool({
        run: async (args) => {
          ran = { ...args };
          return { summary: "wrote" };
        },
      }),
    );
    const args = { file_path: "notes.txt", content: "x" };
    await registry.call("fs_write", args);
    args.file_path = "changed-afterwards.txt";
    expect(ran?.file_path).toBe("notes.txt");
  });

  it("records the summary of the snapshot, not of a later mutation", async () => {
    const { registry, audit } = buildRegistry();
    registry.register(echoTool());
    await registry.call("fs_write", { file_path: "notes.txt", content: "x" });
    expect(audit.list()[0]?.summary).toBe("write notes.txt");
  });
});

describe("ToolRegistry — audit covers every exit", () => {
  it("records a successful call", async () => {
    const { registry, audit } = buildRegistry();
    registry.register(
      echoTool({
        name: "fs_read",
        opClass: "read",
        run: async () => ({ summary: "read ok" }),
      }),
    );
    await registry.call("fs_read", { file_path: "a.ts", content: "" });
    const row = audit.list()[0];
    expect(row?.toolName).toBe("fs_read");
    expect(row?.status).toBe("ok");
    expect(row?.errorCode).toBeNull();
    expect(row?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("records an error and rethrows it", async () => {
    const { registry, audit } = buildRegistry();
    registry.register(
      echoTool({
        name: "fs_read",
        opClass: "read",
        run: async () => {
          throw new ZxError("FILE_NOT_FOUND", "missing");
        },
      }),
    );
    await expect(
      registry.call("fs_read", { file_path: "a.ts", content: "" }),
    ).rejects.toThrow(/missing/);
    const row = audit.list()[0];
    expect(row?.status).toBe("error");
    expect(row?.errorCode).toBe("FILE_NOT_FOUND");
  });

  it("stores the error message and stack, not just the code (F2-1)", async () => {
    const { registry, audit } = buildRegistry();
    registry.register(
      echoTool({
        name: "fs_read",
        opClass: "read",
        run: async () => {
          throw new ZxError("FILE_NOT_FOUND", "no such file: a.ts");
        },
      }),
    );
    await registry
      .call("fs_read", { file_path: "a.ts", content: "" })
      .catch(() => undefined);
    const row = audit.get(audit.list()[0]!.id);
    expect(row?.errorMessage).toBe("no such file: a.ts");
    expect(row?.errorStack).toContain("ZxError");
  });

  it("records a tool that never ran because its arguments were rejected", async () => {
    const { registry, audit } = buildRegistry();
    registry.register(
      echoTool({
        parseArgs: () => {
          throw new ZxError("INTERNAL", "file_path must be a string");
        },
      }),
    );
    await expect(
      registry.call("fs_write", { file_path: 42, content: "x" }),
    ).rejects.toThrow(/must be a string/);
    const row = audit.list()[0];
    expect(row?.status).toBe("error");
    expect(row?.toolName).toBe("fs_write");
  });

  it("names the attempted path when a tool supplies summarizeRaw", async () => {
    // Without this, every rejected attempt reads "could not prepare arguments",
    // and a list of those rows cannot answer what the bridge was trying to touch.
    const { registry, audit } = buildRegistry();
    registry.register(
      echoTool({
        parseArgs: () => {
          throw new ZxError("PATH_TRAVERSAL", "escaped the sandbox");
        },
        summarizeRaw: (raw) =>
          `write ${(raw as { file_path: string }).file_path}`,
      }),
    );
    await registry
      .call("fs_write", { file_path: "../../escape.txt", content: "x" })
      .catch(() => undefined);
    expect(audit.list()[0]?.summary).toBe("write ../../escape.txt (arguments rejected)");
  });

  it("still records the attempt when summarizeRaw itself throws", async () => {
    const { registry, audit } = buildRegistry();
    registry.register(
      echoTool({
        parseArgs: () => {
          throw new ZxError("INTERNAL", "bad args");
        },
        summarizeRaw: () => {
          throw new Error("summary hook is broken");
        },
      }),
    );
    await registry.call("fs_write", { file_path: "a.ts", content: "x" }).catch(() => undefined);
    const row = audit.list()[0];
    // A broken summary hook must never mask the error it is describing.
    expect(row?.status).toBe("error");
    expect(audit.get(row!.id)?.errorMessage).toBe("bad args");
  });

  it("audits an unknown tool name rather than passing it over in silence", async () => {
    const { registry, audit } = buildRegistry();
    await expect(registry.call("nope", {})).rejects.toThrow(/unknown tool/i);
    const row = audit.list()[0];
    expect(row?.toolName).toBe("nope");
    expect(row?.errorCode).toBe("INTERNAL");
  });

  it("never leaves a call unaudited, denied or not", async () => {
    for (const decision of ["approved", "denied"] as const) {
      const { registry, audit } = buildRegistry(decision);
      registry.register(
        echoTool({
          run: async () => {
            if (decision === "denied") throw new Error("should not run");
            return { summary: "wrote" };
          },
        }),
      );
      await registry
        .call("fs_write", { file_path: "a.ts", content: "x" })
        .catch(() => undefined);
      expect(audit.count()).toBe(1);
    }
  });
});

describe("ToolRegistry — nothing escapes without a ZxError code", () => {
  it("translates a raw error thrown by a tool", async () => {
    // The promise the whole error mapping rests on: `tool-registry` maps
    // `ZxErrorCode` onto MCP responses, so a raw `Error` reaching a client
    // means the caller has no code to branch on.
    const { registry } = buildRegistry();
    registry.register(
      echoTool({
        name: "fs_read",
        opClass: "read",
        run: async () => {
          throw new TypeError("cannot read properties of undefined");
        },
      }),
    );
    const error = await registry
      .call("fs_read", { file_path: "a.ts", content: "" })
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ZxError);
    expect((error as ZxError).code).toBe("INTERNAL");
    // The original text is kept so nothing is lost in translation.
    expect((error as ZxError).message).toContain("cannot read properties");
  });

  it("keeps a real ZxError's own code rather than relabelling it", async () => {
    const { registry } = buildRegistry();
    registry.register(
      echoTool({
        name: "fs_read",
        opClass: "read",
        run: async () => {
          throw new ZxError("PATH_TRAVERSAL", "escaped");
        },
      }),
    );
    const error = await registry
      .call("fs_read", { file_path: "a.ts", content: "" })
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect((error as ZxError).code).toBe("PATH_TRAVERSAL");
  });

  it("translates a raw error from parseArgs too", async () => {
    const { registry } = buildRegistry();
    registry.register(
      echoTool({
        parseArgs: () => {
          throw new RangeError("index out of range");
        },
      }),
    );
    const error = await registry
      .call("fs_write", { file_path: "a.ts", content: "x" })
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ZxError);
  });

  it("translates a raw error thrown by the approval gate", async () => {
    const dir = makeTempWorkspace();
    const audit = new AuditLog(join(dir, "audit.db"));
    openLogs.push(audit);
    const gate = new ApprovalGate({
      autoApprove: [],
      prompter: () => Promise.reject(new Error("the approval UI crashed")),
    });
    const built = new ToolRegistry({ guard: new PathGuard(dir), gate, audit });
    built.register(echoTool());
    const error = await built
      .call("fs_write", { file_path: "a.ts", content: "x" })
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ZxError);
    expect((error as ZxError).code).toBe("INTERNAL");
  });
});

describe("ToolRegistry — construction", () => {
  it("refuses to be built without the pieces it promises to use", () => {
    expect(
      () =>
        new ToolRegistry({
          guard: new PathGuard(makeTempWorkspace()),
        } as never),
    ).toThrow(/needs a gate, an audit log and a path guard/);
  });
});
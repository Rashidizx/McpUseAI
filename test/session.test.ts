import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ApprovalGate } from "../src/core/approval-gate.js";
import { ApprovalQueue } from "../src/core/approval-queue.js";
import { AuditLog } from "../src/core/audit-log.js";
import { PathGuard } from "../src/core/path-guard.js";
import { ToolRegistry } from "../src/core/tool-registry.js";
import { createFsRead } from "../src/tools/fs-read.js";
import { createFsWrite } from "../src/tools/fs-write.js";
import { LinkError, type AskOptions } from "../src/agent/link.js";
import { Session } from "../src/agent/session.js";
import { cleanupTempDirs, makeTempWorkspace } from "./helpers.js";

afterEach(cleanupTempDirs);

const call = (tool: string, args: Record<string, unknown>) => "```zx\n" + JSON.stringify({ tool, arguments: args }) + "\n```";

function setup(reply: (text: string, index: number, options: AskOptions) => Promise<string> | string, maxSteps = 5) {
  const root = makeTempWorkspace();
  writeFileSync(join(root, "a.txt"), "hello from a");
  const queue = new ApprovalQueue();
  const audit = new AuditLog(":memory:");
  const guard = new PathGuard(root);
  const gate = new ApprovalGate({ autoApprove: [], prompter: (p) => queue.request(p) });
  const registry = new ToolRegistry({ guard, gate, audit });
  registry.register(createFsRead(guard));
  registry.register(createFsWrite(guard));

  const sent: { text: string; options: AskOptions }[] = [];
  const session = new Session({
    ask: async (text, options) => {
      sent.push({ text, options });
      return { text: await reply(text, sent.length - 1, options), url: "https://chat.example/c/42?x=1" };
    },
    tools: () => ({
      registry,
      list: registry.list(),
      workspace: root,
      resolve: (p: string) => guard.resolve(p),
      peek: (p: string) => {
        try {
          return readFileSync(guard.resolve(p), "utf8");
        } catch {
          return null;
        }
      },
    }),
    limits: () => ({ maxSteps, maxChars: 30_000 }),
    cancelApprovals: () => queue.rejectAll("stopped"),
  });
  return { root, queue, session, sent };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
};

describe("Session loop", () => {
  it("runs a read, sends the result back, and stops at the answer", async () => {
    const { session, sent } = setup((_, i) => (i === 0 ? call("fs_read", { file_path: "a.txt" }) : "It says hello."));
    await session.send("what is in a.txt?");

    expect(sent).toHaveLength(2);
    expect(sent[0]!.text).toBe("what is in a.txt?");
    expect(sent[1]!.text.startsWith("ZX RESULTS")).toBe(true);
    expect(sent[1]!.text).toContain("hello from a");
    expect(session.items.map((i) => i.kind)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(session.items[2]).toMatchObject({ kind: "tool", status: "ok", summary: "read a.txt (1)" });
    expect(session.busy).toBe(false);
  });

  it("passes the primer and remembers which conversation was primed", async () => {
    const { session, sent } = setup((_, i) => (i === 0 ? call("fs_read", { file_path: "a.txt" }) : "done"));
    await session.send("go");
    expect(sent[0]!.options.primer).toContain("USER REQUEST:");
    expect(sent[0]!.options.primedUrl).toBeNull();
    expect(sent[1]!.options.primedUrl).toBe("https://chat.example/c/42");

    session.newChat();
    expect(session.items).toEqual([]);
    await session.send("again");
    expect(sent[2]!.options).toMatchObject({ newChat: true, primedUrl: null });
  });

  it("waits for approval before writing", async () => {
    const { session, queue, root } = setup((_, i) => (i === 0 ? call("fs_write", { file_path: "b.txt", content: "new" }) : "written"));
    const run = session.send("make b.txt");
    await until(() => queue.pending().length === 1);
    expect(existsSync(join(root, "b.txt"))).toBe(false);
    expect(queue.pending()[0]).toMatchObject({ toolName: "fs_write", opClass: "write" });

    queue.resolve(queue.pending()[0]!.id, "approved");
    await run;
    expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("new");
  });

  it("reports a denial to the model as an error result", async () => {
    const { session, queue, sent } = setup((_, i) => (i === 0 ? call("fs_write", { file_path: "b.txt", content: "x" }) : "ok, not writing"));
    const run = session.send("make b.txt");
    await until(() => queue.pending().length === 1);
    queue.resolve(queue.pending()[0]!.id, "denied");
    await run;
    expect(sent[1]!.text).toContain("APPROVAL_DENIED");
    expect(session.items.find((i) => i.kind === "tool")).toMatchObject({ status: "error" });
  });

  it("stop refuses a pending approval and ends the run without writing", async () => {
    const { session, queue, root } = setup(() => call("fs_write", { file_path: "b.txt", content: "x" }));
    const run = session.send("make b.txt");
    await until(() => queue.pending().length === 1);
    session.stop();
    await run;
    expect(existsSync(join(root, "b.txt"))).toBe(false);
    expect(session.items.at(-1)).toMatchObject({ kind: "notice", text: "متوقف شد.", retry: true });
    expect(session.busy).toBe(false);
  });

  it("stops at the step limit", async () => {
    const { session, sent } = setup(() => call("fs_read", { file_path: "a.txt" }), 3);
    await session.send("loop");
    expect(sent).toHaveLength(3);
    expect(session.items.at(-1)).toMatchObject({ kind: "notice", level: "info" });
  });

  it("gives the model a chance to fix a broken block, then gives up", async () => {
    const { session, sent } = setup(() => "```zx\n{oops}\n```");
    await session.send("x");
    expect(sent).toHaveLength(3);
    expect(sent[1]!.text).toMatch(/None of your tool calls ran/);
    expect(session.items.at(-1)).toMatchObject({ kind: "notice", level: "error" });
  });

  it("shows a link failure with a hint, keeping partial text", async () => {
    const { session } = setup(() => {
      throw new LinkError("no-reply", "no answer appeared", "half an ans");
    });
    await session.send("x");
    expect(session.items.find((i) => i.kind === "assistant")).toMatchObject({ text: "half an ans", streaming: false });
    expect(session.items.at(-1)).toMatchObject({ kind: "notice", level: "error" });
    expect((session.items.at(-1) as { text: string }).text).toMatch(/پاسخی نیامد/);
  });

  it("refuses to run without a workspace", async () => {
    const session = new Session({
      ask: async () => ({ text: "", url: "" }),
      tools: () => null,
      limits: () => ({ maxSteps: 5, maxChars: 30_000 }),
      cancelApprovals: () => undefined,
    });
    await session.send("hi");
    expect(session.items.at(-1)).toMatchObject({ kind: "notice", level: "error" });
  });

  it("refuses a second run while one is going", async () => {
    let release!: (text: string) => void;
    const { session } = setup(() => new Promise<string>((r) => (release = r)));
    const first = session.send("one");
    await until(() => release !== undefined);
    await expect(session.send("two")).rejects.toThrow(/in progress/);
    release("done");
    await first;
  });
});

describe("Session retry", () => {
  it("resends by itself when the message provably was not sent", async () => {
    const { session, sent } = setup((_, i) => {
      if (i === 0) throw new LinkError("send-failed", "would not send");
      return "done";
    });
    await session.send("hi");
    expect(sent.map((s) => s.text)).toEqual(["hi", "hi"]);
    expect(session.items.map((i) => i.kind)).toEqual(["user", "notice", "assistant"]);
    expect((session.items[1] as { text: string }).text).toMatch(/ارسال 2/);
    expect(session.attempts).toBe(2);
    expect(session.status.phase).toBe("done");
    expect(session.canRetry).toBe(false);
  });

  it("gives up after two automatic retries and offers a manual one", async () => {
    const { session, sent } = setup(() => {
      throw new LinkError("send-failed", "would not send");
    });
    await session.send("hi");
    expect(sent).toHaveLength(3);
    expect(session.attempts).toBe(3);
    expect(session.canRetry).toBe(true);
    expect(session.items.at(-1)).toMatchObject({ kind: "notice", level: "error", retry: true });
  });

  it("never resends by itself after a failure that may have reached the site", async () => {
    const { session, sent } = setup(() => {
      throw new LinkError("no-reply", "no answer appeared");
    });
    await session.send("hi");
    expect(sent).toHaveLength(1);
    expect(session.canRetry).toBe(true);
  });

  it("retry resends the message that failed and carries on, counting attempts", async () => {
    let fail = true;
    const { session, sent } = setup((_, i) => {
      if (i === 0) return call("fs_read", { file_path: "a.txt" });
      if (fail) throw new LinkError("timeout", "too slow");
      return "It says hello.";
    });
    await session.send("read a");
    expect(session.canRetry).toBe(true);
    expect(session.attempts).toBe(1);

    await session.retry();
    expect(session.attempts).toBe(2);
    expect(sent[2]!.text).toBe(sent[1]!.text);
    expect(sent[2]!.text.startsWith("ZX RESULTS")).toBe(true);
    expect(session.items.filter((i) => i.kind === "notice" && i.retry)).toHaveLength(1);

    fail = false;
    await session.retry();
    expect(session.items.at(-1)).toMatchObject({ kind: "assistant", text: "It says hello." });
    expect(session.canRetry).toBe(false);
    expect(session.items.some((i) => i.kind === "notice" && i.retry)).toBe(false);
  });

  it("refuses to retry when nothing failed", async () => {
    const { session } = setup(() => "ok");
    await session.send("hi");
    await expect(session.retry()).rejects.toThrow(/nothing to retry/);
  });
});

describe("Session status, restart and file changes", () => {
  it("records what a write changed, with added and removed counts", async () => {
    const { session, queue } = setup((_, i) =>
      i === 0 ? call("fs_write", { file_path: "a.txt", content: "hello from b\nsecond line\n" }) : "done",
    );
    const run = session.send("rewrite a.txt");
    await until(() => queue.pending().length === 1);
    queue.resolve(queue.pending()[0]!.id, "approved");
    await run;
    const tool = session.items.find((i) => i.kind === "tool") as { change?: { added: number; removed: number; created: boolean } };
    expect(tool.change).toMatchObject({ added: 2, removed: 1, created: false });
  });

  it("restart sends the original request again and counts it", async () => {
    const { session, sent } = setup(() => "answer");
    await session.send("the request");
    expect(session.canRestart).toBe(true);
    await session.restart();
    expect(sent.map((s) => s.text)).toEqual(["the request", "the request"]);
    expect(session.items[0]).toMatchObject({ kind: "user", sends: 2, turn: 1 });
    expect(session.items.every((i) => i.turn === 1)).toBe(true);
  });

  it("reports phases from the extension and its own steps", async () => {
    const phases: string[] = [];
    const { session } = setup(async (_, i, options) => {
      options.onStatus?.("typing");
      options.onStatus?.("waiting");
      options.onProgress?.("partial");
      return i === 0 ? call("fs_read", { file_path: "a.txt" }) : "done";
    });
    session.on("change", () => {
      if (phases.at(-1) !== session.status.phase) phases.push(session.status.phase);
    });
    await session.send("go");
    expect(phases).toEqual(["idle", "sending", "typing", "waiting", "receiving", "tool", "sending", "typing", "waiting", "receiving", "done"]);
  });

  it("ends in error with a short label when sending fails", async () => {
    const { session } = setup(() => {
      throw new LinkError("no-reply", "nothing");
    });
    await session.send("go");
    expect(session.status).toEqual({ phase: "error", detail: "پاسخی نیامد" });
  });
});

describe("stopping and limits keep what already happened", () => {
  it("a stop in the middle of a tool batch retries with the results, not the calls", async () => {
    const { session, sent, queue } = setup((_, i) =>
      i === 0 ? `${call("fs_read", { file_path: "a.txt" })}\n${call("fs_write", { file_path: "b.txt", content: "x" })}` : "done",
    );
    const run = session.send("go");
    // The write waits for approval; stop there.
    await until(() => queue.pending().length === 1);
    session.stop();
    await run;
    expect(session.canRetry).toBe(true);

    await session.retry();
    const retried = sent.at(-1)!.text;
    expect(retried.startsWith("ZX RESULTS")).toBe(true);
    expect(retried).toContain("hello from a");
  });

  it("the step limit keeps the last results for the retry button", async () => {
    const { session, sent } = setup(() => call("fs_read", { file_path: "a.txt" }), 1);
    await session.send("go");
    expect(sent).toHaveLength(1);
    expect(session.canRetry).toBe(true);
    await session.retry();
    expect(sent[1]!.text.startsWith("ZX RESULTS")).toBe(true);
  });
});

import { describe, it, expect, vi } from "vitest";
import {
  ApprovalQueue,


} from "../src/core/approval-queue.js";
import type { ApprovalPrompt } from "../src/core/approval-gate.js";

const prompt = (over: Partial<ApprovalPrompt> = {}): ApprovalPrompt => ({
  toolName: "exec",
  summary: "run npm install",
  arguments: { command: "npm", cwd: "/repo" },
  opClass: "exec",
  ...over,
});

describe("ApprovalQueue — the plan's baseline contract", () => {
  it("resolves the promise when a decision arrives", async () => {
    const queue = new ApprovalQueue();
    const promise = queue.request(prompt());
    const id = queue.pending()[0]?.id as string;
    queue.resolve(id, "approved");
    await expect(promise).resolves.toBe("approved");
  });

  it("returns denied when the decision is denied", async () => {
    const queue = new ApprovalQueue();
    const promise = queue.request(prompt());
    queue.resolve(queue.pending()[0]?.id as string, "denied");
    await expect(promise).resolves.toBe("denied");
  });

  it("assigns a unique id to each request", async () => {
    const queue = new ApprovalQueue();
    const a = queue.request(prompt({ summary: "a" }));
    const b = queue.request(prompt({ summary: "b" }));
    const ids = queue.pending().map((p) => p.id);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) queue.resolve(id, "approved");
    await Promise.all([a, b]);
  });

  it("removes a request from pending once resolved", async () => {
    const queue = new ApprovalQueue();
    const promise = queue.request(prompt());
    queue.resolve(queue.pending()[0]?.id as string, "approved");
    await promise;
    expect(queue.pending()).toHaveLength(0);
  });

  it("notifies subscribers when a request arrives", () => {
    const queue = new ApprovalQueue();
    const listener = vi.fn();
    queue.subscribe(listener);
    listener.mockClear();
    void queue.request(prompt());
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]?.[0]).toHaveLength(1);
  });

  it("notifies subscribers when a request is removed", async () => {
    const queue = new ApprovalQueue();
    const promise = queue.request(prompt());
    const listener = vi.fn();
    queue.subscribe(listener);
    listener.mockClear();
    queue.resolve(queue.pending()[0]?.id as string, "approved");
    await promise;
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]).toHaveLength(0);
  });

  it("unsubscribes cleanly", async () => {
    const queue = new ApprovalQueue();
    const listener = vi.fn();
    const off = queue.subscribe(listener);
    off();
    listener.mockClear();
    const promise = queue.request(prompt());
    queue.resolve(queue.pending()[0]?.id as string, "approved");
    await promise;
    expect(listener).not.toHaveBeenCalled();
  });

  it("returns false when resolving an unknown id", () => {
    const queue = new ApprovalQueue();
    expect(queue.resolve("nope", "approved")).toBe(false);
  });

  it("denies everything on rejectAll", async () => {
    const queue = new ApprovalQueue();
    const a = queue.request(prompt({ summary: "a" }));
    const b = queue.request(prompt({ summary: "b" }));
    queue.rejectAll("shutting down");
    await expect(a).resolves.toBe("denied");
    await expect(b).resolves.toBe("denied");
    expect(queue.pending()).toHaveLength(0);
  });

  it("carries the summary through to the pending view", () => {
    const queue = new ApprovalQueue();
    void queue.request(prompt());
    expect(queue.pending()[0]?.summary).toBe("run npm install");
  });
});

describe("ApprovalQueue — hole 1: the snapshot the user approves is the one that runs", () => {
  it("does not alias the caller's arguments object", () => {
    const queue = new ApprovalQueue();
    const args = { command: "npm", cwd: "/repo" };
    void queue.request(prompt({ arguments: args }));
    args.cwd = "/etc";
    expect(queue.pending()[0]?.arguments.cwd).toBe("/repo");
  });

  it("ignores a caller rewriting a nested field after queuing", () => {
    const queue = new ApprovalQueue();
    const args: Record<string, unknown> = { file_path: "notes.txt" };
    void queue.request(
      prompt({ toolName: "fs_write", arguments: args, opClass: "write" }),
    );
    // The exact mutation a prompt-injected renderer would attempt: swap the
    // path the user read for one they never saw.
    args.file_path = "C:\\Windows\\System32\\config\\SAM";
    expect(queue.pending()[0]?.arguments.file_path).toBe("notes.txt");
  });

  it("freezes the stored snapshot deeply", () => {
    const queue = new ApprovalQueue();
    void queue.request(prompt());
    const item = queue.pending()[0]!;
    expect(Object.isFrozen(item)).toBe(true);
    // One level down is the field that matters; a shallow freeze would miss it.
    expect(Object.isFrozen(item.arguments)).toBe(true);
    expect(() => {
      (item.arguments as Record<string, unknown>).cwd = "/etc";
    }).toThrow();
  });

  it("refuses a renderer that rewrites the summary it was shown", () => {
    const queue = new ApprovalQueue();
    void queue.request(prompt());
    const item = queue.pending()[0]!;
    expect(() => {
      (item as { summary: string }).summary = "safe: just listing files";
    }).toThrow();
    expect(queue.snapshot(item.id)?.summary).toBe("run npm install");
  });

  it("hands each pending() caller its own array", () => {
    const queue = new ApprovalQueue();
    void queue.request(prompt());
    const first = queue.pending();
    first.length = 0;
    expect(queue.pending()).toHaveLength(1);
  });

  it("snapshots a cyclic arguments object instead of hanging", () => {
    const queue = new ApprovalQueue();
    const args: Record<string, unknown> = { command: "npm" };
    args.self = args;
    void queue.request(prompt({ arguments: args }));
    expect(queue.pending()[0]?.arguments.command).toBe("npm");
  });

  it("refuses arguments that cannot be snapshotted rather than aliasing them", () => {
    const queue = new ApprovalQueue();
    const args = { command: "npm", onDone: (): void => {} };
    expect(() =>
      queue.request(prompt({ arguments: args as unknown as Record<string, unknown> })),
    ).toThrow(/cannot be snapshotted/);
    // Fail-closed: nothing entered the queue, so there is no pending entry that
    // could be approved by accident later.
    expect(queue.pending()).toHaveLength(0);
  });
});

describe("ApprovalQueue — hole 2: opClass reaches every renderer", () => {
  it("carries opClass into the pending view", () => {
    const queue = new ApprovalQueue();
    void queue.request(prompt({ opClass: "destructive" }));
    expect(queue.pending()[0]?.opClass).toBe("destructive");
  });

  it("carries opClass into the snapshot the dispatcher executes", () => {
    const queue = new ApprovalQueue();
    const promise = queue.request(prompt({ opClass: "destructive" }));
    const id = queue.pending()[0]!.id;
    expect(queue.snapshot(id)?.opClass).toBe("destructive");
    queue.resolve(id, "approved");
    void promise;
  });

  it("refuses to queue a prompt with no usable opClass", () => {
    const queue = new ApprovalQueue();
    const bad = prompt({ opClass: "totally-safe" as never });
    expect(() => queue.request(bad)).toThrow(/no valid opClass/);
    expect(queue.pending()).toHaveLength(0);
  });

  it("refuses to queue a prompt with a missing opClass at runtime", () => {
    // A value that crossed the process boundary is past the compiler, so the
    // runtime check is the one that has to hold.
    const queue = new ApprovalQueue();
    const stripped = { ...prompt() } as Record<string, unknown>;
    delete stripped.opClass;
    expect(() => queue.request(stripped as unknown as ApprovalPrompt)).toThrow(
      /no valid opClass/,
    );
  });
});

describe("ApprovalQueue — decision handling is strict", () => {
  it("throws rather than treating an unrecognised decision as consent", async () => {
    const queue = new ApprovalQueue();
    const promise = queue.request(prompt());
    const id = queue.pending()[0]!.id;
    expect(() => queue.resolve(id, "yes" as never)).toThrow(
      /not a decision this queue recognises/,
    );
    // Still pending, so the human's actual intent is not silently discarded.
    expect(queue.pending()).toHaveLength(1);
    queue.resolve(id, "denied");
    await expect(promise).resolves.toBe("denied");
  });

  it("settles only the entry that was answered", async () => {
    const queue = new ApprovalQueue();
    const a = queue.request(prompt({ summary: "a" }));
    const b = queue.request(prompt({ summary: "b" }));
    queue.resolve(queue.pending()[0]!.id, "approved");
    await expect(a).resolves.toBe("approved");
    expect(queue.pending()).toHaveLength(1);
    queue.resolve(queue.pending()[0]!.id, "denied");
    await expect(b).resolves.toBe("denied");
  });

  it("returns false for a double answer", async () => {
    const queue = new ApprovalQueue();
    const promise = queue.request(prompt());
    const id = queue.pending()[0]!.id;
    expect(queue.resolve(id, "approved")).toBe(true);
    expect(queue.resolve(id, "approved")).toBe(false);
    await promise;
  });

  it("refuses a duplicate id from a broken factory instead of stranding a promise", () => {
    const queue = new ApprovalQueue({ newId: () => "always-the-same" });
    void queue.request(prompt());
    expect(() => queue.request(prompt())).toThrow(/duplicate id/);
    expect(queue.pending()).toHaveLength(1);
  });
});

describe("ApprovalQueue — subscriber ordering and dispatch", () => {
  it("fires once immediately with the current queue", () => {
    const queue = new ApprovalQueue();
    const listener = vi.fn();
    queue.subscribe(listener);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]?.[0]).toHaveLength(0);
  });

  it("survives a listener that unsubscribes itself mid-notification", async () => {
    const queue = new ApprovalQueue();
    const seen: number[] = [];
    let detach = (): void => {};
    // The pattern this exists for: an overlay that unmounts once its prompt is
    // answered. It detaches from inside the notification it is being sent.
    detach = queue.subscribe((p) => {
      seen.push(p.length);
      if (p.length === 1) detach();
    });
    const promise = queue.request(prompt());
    queue.resolve(queue.pending()[0]!.id, "approved");
    await promise;
    expect(seen).toEqual([0, 1]);
  });

  it("orders pending oldest first", () => {
    let tick = 1_000;
    const queue = new ApprovalQueue({
      now: () => tick++,
      newId: (() => {
        let n = 0;
        return () => `id-${n++}`;
      })(),
    });
    void queue.request(prompt({ summary: "first" }));
    void queue.request(prompt({ summary: "second" }));
    void queue.request(prompt({ summary: "third" }));
    expect(queue.pending().map((p) => p.summary)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("keeps insertion order when two requests land in the same millisecond", () => {
    // Ids deliberately sort the opposite way round, so an id-based tiebreak
    // would visibly reorder the queue. A user reading two prompts by position
    // must get the one they read.
    const ids = ["zzz-first", "aaa-second"];
    let counter = 0;
    const queue = new ApprovalQueue({ now: () => 5_000, newId: () => ids[counter++]! });
    void queue.request(prompt({ summary: "first" }));
    void queue.request(prompt({ summary: "second" }));
    expect(queue.pending().map((p) => p.summary)).toEqual(["first", "second"]);
  });
});
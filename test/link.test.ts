import { describe, expect, it } from "vitest";

import { ExtensionLink, LinkError } from "../src/agent/link.js";
import { DEFAULT_SITES } from "../src/agent/sites.js";

const site = DEFAULT_SITES[0]!;

function fakeSocket() {
  const sent: Record<string, unknown>[] = [];
  return { sent, closed: false, send: (d: string) => sent.push(JSON.parse(d)), close() { this.closed = true; } };
}

function connected() {
  const link = new ExtensionLink();
  const socket = fakeSocket();
  link.attach(socket);
  link.receive(socket, JSON.stringify({ type: "hello", version: "0.2.0" }));
  return { link, socket };
}

const opts = { newChat: false, primer: "P", primedUrl: null };

describe("ExtensionLink", () => {
  it("refuses to ask before the extension says hello", async () => {
    const link = new ExtensionLink(() => null, 30_000, 0);
    await expect(link.ask(site, "hi", opts)).rejects.toMatchObject({ code: "disconnected" });
    link.attach(fakeSocket());
    expect(link.connected).toBe(false);
  });

  it("sends an ask and resolves on done, streaming progress", async () => {
    const { link, socket } = connected();
    const progress: string[] = [];
    const reply = link.ask(site, "hi", { ...opts, onProgress: (t) => progress.push(t) });
    const ask = socket.sent[0] as { type: string; jobId: string; text: string; primer: string };
    expect(ask).toMatchObject({ type: "ask", text: "hi", primer: "P" });

    link.receive(socket, JSON.stringify({ type: "progress", jobId: ask.jobId, text: "hel" }));
    link.receive(socket, JSON.stringify({ type: "done", jobId: ask.jobId, text: "hello", url: "u" }));
    await expect(reply).resolves.toEqual({ text: "hello", url: "u" });
    expect(progress).toEqual(["hel"]);
  });

  it("ignores replies for unknown jobs and from a replaced socket", async () => {
    const { link, socket } = connected();
    const reply = link.ask(site, "hi", opts);
    const { jobId } = socket.sent[0] as { jobId: string };
    link.receive(socket, JSON.stringify({ type: "done", jobId: "other", text: "x", url: "" }));
    link.receive(fakeSocket(), JSON.stringify({ type: "done", jobId, text: "x", url: "" }));
    link.receive(socket, JSON.stringify({ type: "done", jobId, text: "real", url: "" }));
    await expect(reply).resolves.toMatchObject({ text: "real" });
  });

  it("turns a failure into a LinkError with its code and partial text", async () => {
    const { link, socket } = connected();
    const reply = link.ask(site, "hi", opts);
    const { jobId } = socket.sent[0] as { jobId: string };
    link.receive(socket, JSON.stringify({ type: "failed", jobId, code: "no-composer", message: "m", text: "part" }));
    const error = await reply.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LinkError);
    expect(error).toMatchObject({ code: "no-composer", partial: "part" });
  });

  it("fails every job when the extension does not come back in time", async () => {
    const link = new ExtensionLink(() => null, 20);
    const socket = fakeSocket();
    link.attach(socket);
    link.receive(socket, JSON.stringify({ type: "hello", version: "x" }));
    const reply = link.ask(site, "hi", opts);
    link.detach(socket);
    expect(link.connected).toBe(false);
    expect(link.reconnecting).toBe(true);
    await expect(reply).rejects.toMatchObject({ code: "disconnected" });
    expect(link.reconnecting).toBe(false);
  });

  it("resumes a reply when the extension comes back", async () => {
    const { link, socket } = connected();
    const reply = link.ask(site, "hi", opts);
    const { jobId } = socket.sent[0] as { jobId: string };
    link.detach(socket);

    const again = fakeSocket();
    link.attach(again);
    link.receive(again, JSON.stringify({ type: "hello", version: "0.2.0" }));
    expect(again.sent[0]).toMatchObject({ type: "resume", jobId });
    link.receive(again, JSON.stringify({ type: "done", jobId, text: "back", url: "" }));
    await expect(reply).resolves.toMatchObject({ text: "back" });
  });

  it("never asks for a reload while a reply is being watched", () => {
    const link = new ExtensionLink(() => "new");
    const socket = fakeSocket();
    link.attach(socket);
    link.receive(socket, JSON.stringify({ type: "hello", version: "x", build: "new" }));
    void link.ask(site, "hi", opts).catch(() => undefined);
    const again = fakeSocket();
    link.attach(again);
    link.receive(again, JSON.stringify({ type: "hello", version: "x", build: "old" }));
    expect(again.sent.some((m) => m.type === "reload")).toBe(false);
  });

  it("keeps the extension's log lines", () => {
    const { link, socket } = connected();
    link.receive(socket, JSON.stringify({ type: "log", level: "error", message: "boom" }));
    expect(link.log.at(-1)).toContain("[error] boom");
  });

  it("cancels on abort and tells the extension", async () => {
    const { link, socket } = connected();
    const abort = new AbortController();
    const reply = link.ask(site, "hi", { ...opts, signal: abort.signal });
    abort.abort();
    await expect(reply).rejects.toMatchObject({ code: "cancelled" });
    expect(socket.sent[1]).toMatchObject({ type: "cancel" });
  });

  it("times out", async () => {
    const { link } = connected();
    await expect(link.ask(site, "hi", { ...opts, timeoutMs: 20 })).rejects.toMatchObject({ code: "timeout" });
  });

  it("answers pings", () => {
    const { link, socket } = connected();
    link.receive(socket, JSON.stringify({ type: "ping" }));
    expect(socket.sent.at(-1)).toEqual({ type: "pong" });
  });
});

describe("ExtensionLink status and reload", () => {
  it("forwards status phases to the ask", async () => {
    const { link, socket } = connected();
    const phases: string[] = [];
    const reply = link.ask(site, "hi", { ...opts, onStatus: (p) => phases.push(p) });
    const { jobId } = socket.sent[0] as { jobId: string };
    link.receive(socket, JSON.stringify({ type: "status", jobId, phase: "typing" }));
    link.receive(socket, JSON.stringify({ type: "done", jobId, text: "x", url: "" }));
    await reply;
    expect(phases).toEqual(["typing"]);
  });

  it("asks an outdated extension to reload, once", () => {
    const link = new ExtensionLink(() => "0.2.0 new");
    const socket = fakeSocket();
    link.attach(socket);
    link.receive(socket, JSON.stringify({ type: "hello", version: "0.2.0", build: "0.2.0 old" }));
    link.receive(socket, JSON.stringify({ type: "hello", version: "0.2.0", build: "0.2.0 old" }));
    expect(socket.sent.filter((m) => m.type === "reload")).toHaveLength(1);
  });

  it("leaves a current extension alone", () => {
    const link = new ExtensionLink(() => "0.2.0 same");
    const socket = fakeSocket();
    link.attach(socket);
    link.receive(socket, JSON.stringify({ type: "hello", version: "0.2.0", build: "0.2.0 same" }));
    expect(socket.sent).toEqual([]);
  });
});

describe("ZX enabled in two browsers", () => {
  function closable() {
    const socket = fakeSocket() as ReturnType<typeof fakeSocket> & { code?: number; close(code?: number): void };
    socket.close = function (code?: number) {
      this.closed = true;
      this.code = code;
    };
    return socket;
  }

  it("keeps the first one; the second is turned away instead of knocking it off", () => {
    const link = new ExtensionLink();
    const brave = closable();
    expect(link.attach(brave, { id: "a", browser: "Brave" })).toBe(true);
    link.receive(brave, JSON.stringify({ type: "hello", version: "1" }));

    const chrome = closable();
    expect(link.attach(chrome, { id: "b", browser: "Chrome" })).toBe(false);
    expect(brave.closed).toBe(false);
    expect(link.connected).toBe(true);
    expect(link.browser).toBe("Brave");
    expect(link.rival).toBe("Chrome");
  });

  it("the same install reconnecting still replaces its old socket", () => {
    const link = new ExtensionLink();
    const first = closable();
    link.attach(first, { id: "a" });
    const again = closable();
    expect(link.attach(again, { id: "a" })).toBe(true);
    expect(first.closed).toBe(true);
    expect(first.code).toBeUndefined();
  });

  it("moves to the other browser when the user asks there, and tells the old one", () => {
    const link = new ExtensionLink();
    const brave = closable();
    link.attach(brave, { id: "a", browser: "Brave" });
    const chrome = closable();
    expect(link.attach(chrome, { id: "b", browser: "Chrome", claim: true })).toBe(true);
    expect(brave.code).toBe(4001);
    expect(link.browser).toBe("Chrome");
  });
});

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

import type {
  BridgeToExtension,
  ExtensionToBridge,
  FailCode,
  Phase,
  ProbeReport,
  Site,
} from "../shared/protocol.js";

/** The part of a WebSocket this file uses, so a test can pass a fake. */
export type Socket = { send(data: string): void; close(code?: number, reason?: string): void };

/**
 * Who is on the other end: one extension install (`id`, kept in its storage)
 * in one browser. `claim` is the user asking to move ZX to this browser.
 */
export type Peer = { id?: string; browser?: string; claim?: boolean };

/** Close code for "another browser holds ZX": the extension backs off instead of retrying at once. */
export const CLOSE_BUSY = 4001;

export class LinkError extends Error {
  constructor(
    readonly code: FailCode | "disconnected",
    message: string,
    /** Whatever reply text existed when it failed. */
    readonly partial?: string,
  ) {
    super(message);
    this.name = "LinkError";
  }
}

export type Reply = { text: string; url: string };

export type AskOptions = {
  newChat: boolean;
  primer: string;
  primedUrl: string | null;
  onProgress?: (text: string) => void;
  onStatus?: (phase: Phase) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
};

type Job = {
  /** What was sent, so it can be resumed or resent after a reconnect. */
  message: BridgeToExtension;
  resolve: (value: never) => void;
  reject: (error: LinkError) => void;
  onProgress?: ((text: string) => void) | undefined;
  onStatus?: ((phase: Phase) => void) | undefined;
  timer: ReturnType<typeof setTimeout>;
  /** Removed when the job settles: one signal spans a whole run of many jobs. */
  unlisten: () => void;
};

/**
 * The bridge's handle on the browser extension.
 *
 * One extension connection at a time: a reconnect (the service worker restarted,
 * the extension was reloaded) replaces the old socket. Every request is a job
 * with its own id, so replies can never be matched to the wrong question, and a
 * lost connection fails every job at once instead of leaving them hanging.
 *
 * Emits `change` whenever the connection state changes.
 */
export class ExtensionLink extends EventEmitter {
  #socket: Socket | null = null;
  #peer: Peer = {};
  /** The last browser turned away because another one held ZX, and when. */
  #rival: { browser: string; at: number } | null = null;
  #version: string | null = null;
  readonly #jobs = new Map<string, Job>();
  readonly #expectedBuild: () => string | null;
  #lastReload = 0;
  #build: string | null = null;
  #grace: ReturnType<typeof setTimeout> | null = null;
  readonly #graceMs: number;
  readonly #connectWaitMs: number;
  /** The build on disk, read when the extension says hello rather than on every state push. */
  #expected: string | null | undefined;
  /** The ZX page's address (with its token), handed to the extension's side panel. */
  uiUrl: string | null = null;
  /** Recent log lines from the extension, newest last. */
  readonly log: string[] = [];

  /** `expectedBuild` reads the build id of the extension on disk, if known. */
  /**
   * `connectWaitMs`: how long a request waits for an extension that is not
   * connected yet (an idle service worker takes a few seconds to come back).
   */
  constructor(expectedBuild: () => string | null = () => null, graceMs = 30_000, connectWaitMs = 10_000) {
    super();
    this.#expectedBuild = expectedBuild;
    this.#graceMs = graceMs;
    this.#connectWaitMs = connectWaitMs;
  }

  /** Requests are waiting for the extension to come back. */
  get reconnecting(): boolean {
    return !this.connected && this.#grace !== null;
  }

  /** Connected and introduced. */
  get connected(): boolean {
    return this.#socket !== null && this.#version !== null;
  }

  get version(): string | null {
    return this.#version;
  }

  /** The connected browser's name, as its extension reported it. */
  get browser(): string | null {
    return this.#socket === null ? null : (this.#peer.browser ?? null);
  }

  /** Another browser with ZX enabled that was turned away in the last two minutes. */
  get rival(): string | null {
    if (this.#rival === null || Date.now() - this.#rival.at > 120_000) return null;
    return this.#rival.browser;
  }

  /** False when the extension running in Chrome is older than the one on disk. */
  get current(): boolean {
    if (this.#expected === undefined) this.#expected = this.#expectedBuild();
    return this.#expected === null || this.#build === this.#expected;
  }

  /**
   * Take a new extension connection. Returns false when it is turned away.
   *
   * The same install reconnecting (its service worker restarted) replaces the
   * old socket. A different install, i.e. ZX enabled in a second browser, is
   * turned away while the first is connected: two browsers that each knocked
   * the other off made the connection flicker on and off every few seconds.
   * The user moves ZX to the other browser explicitly (`claim`).
   */
  attach(socket: Socket, peer: Peer = {}): boolean {
    const current = this.#socket;
    if (current !== null && current !== socket && this.#peer.id !== peer.id) {
      if (!peer.claim) {
        this.#rival = { browser: peer.browser ?? "another browser", at: Date.now() };
        this.emit("change");
        return false;
      }
      // Moved on purpose: the old browser is told so, and backs off too.
      this.#rival = null;
      current.close(CLOSE_BUSY, (peer.browser ?? "another browser").slice(0, 60));
    } else if (current !== null && current !== socket) {
      // Requests in flight are not failed here: once the new connection says
      // hello they are resumed, because the chat tab still holds their state.
      current.close();
    }
    this.#socket = socket;
    this.#peer = peer;
    this.#version = null;
    this.emit("change");
    return true;
  }

  detach(socket: Socket): void {
    if (socket !== this.#socket) return;
    this.#socket = null;
    this.#version = null;
    if (this.#jobs.size > 0 && this.#grace === null) {
      // A service worker restart is routine; give it time to come back.
      this.#grace = setTimeout(() => {
        this.#grace = null;
        this.#failAll("disconnected", "the browser extension disconnected and did not come back");
        this.emit("change");
      }, this.#graceMs);
    }
    this.emit("change");
  }

  receive(socket: Socket, raw: string): void {
    if (socket !== this.#socket) return;
    let message: ExtensionToBridge;
    try {
      message = JSON.parse(raw) as ExtensionToBridge;
    } catch {
      return;
    }
    switch (message.type) {
      case "hello": {
        this.#version = typeof message.version === "string" ? message.version : "?";
        this.#build = typeof message.build === "string" ? message.build : null;
        // An extension older than the one on disk reloads itself, so a rebuild
        // needs no trip to chrome://extensions. Rate-limited so a mismatch that
        // a reload cannot fix never becomes a loop.
        const expected = this.#expectedBuild();
        this.#expected = expected;
        // Never mid-request: a reload would throw away the reply being watched.
        if (expected !== null && message.build !== expected && this.#jobs.size === 0 && Date.now() - this.#lastReload > 60_000) {
          this.#lastReload = Date.now();
          this.#send({ type: "reload" });
        }
        if (this.#grace !== null) {
          clearTimeout(this.#grace);
          this.#grace = null;
        }
        if (this.uiUrl !== null) this.#send({ type: "ui", url: this.uiUrl });
        for (const [jobId, job] of this.#jobs) {
          const m = job.message;
          if (m.type === "ask") this.#send({ type: "resume", jobId, site: m.site });
          else this.#send(m);
        }
        this.emit("change");
        return;
      }
      case "log": {
        const line = `${new Date().toISOString().slice(11, 19)} [${message.level}] ${String(message.message).slice(0, 500)}`;
        this.log.push(line);
        if (this.log.length > 30) this.log.shift();
        this.emit("log", line);
        this.emit("change");
        return;
      }
      case "status":
        this.#jobs.get(message.jobId)?.onStatus?.(message.phase);
        return;
      case "ping":
        this.#send({ type: "pong" });
        return;
      case "progress":
        this.#jobs.get(message.jobId)?.onProgress?.(String(message.text ?? ""));
        return;
      case "done":
        this.#settle(message.jobId, (job) => job.resolve({ text: String(message.text ?? ""), url: String(message.url ?? "") } as never));
        return;
      case "probed":
        this.#settle(message.jobId, (job) => job.resolve(message.report as never));
        return;
      case "failed":
        this.#settle(message.jobId, (job) =>
          job.reject(new LinkError(message.code ?? "internal", String(message.message ?? "failed"), message.text)),
        );
        return;
    }
  }

  /** Type `text` into the site's chat and resolve with the full reply. */
  ask(site: Site, text: string, options: AskOptions): Promise<Reply> {
    const jobId = randomUUID();
    return this.#start<Reply>(
      jobId,
      {
        type: "ask",
        jobId,
        site,
        text,
        newChat: options.newChat,
        primer: options.primer,
        primedUrl: options.primedUrl,
      },
      options.timeoutMs ?? 10 * 60_000,
      options.onProgress,
      options.signal,
      options.onStatus,
    );
  }

  /** Report which of the site's selectors match on its open tab. */
  probe(site: Site): Promise<ProbeReport> {
    const jobId = randomUUID();
    return this.#start<ProbeReport>(jobId, { type: "probe", jobId, site }, 30_000);
  }

  /** Ask the extension to restart the whole app through its native host. */
  restartApp(): boolean {
    if (!this.connected) return false;
    this.#send({ type: "restart-app" });
    return true;
  }

  /** Bring the site's tab to the front. */
  show(site: Site): void {
    this.#send({ type: "show", site });
  }

  #start<T>(
    jobId: string,
    message: BridgeToExtension,
    timeoutMs: number,
    onProgress?: (text: string) => void,
    signal?: AbortSignal,
    onStatus?: (phase: Phase) => void,
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(new LinkError("cancelled", "stopped"));
    if (!this.connected) {
      return this.#whenConnected(signal).then((connected) => {
        if (signal?.aborted) throw new LinkError("cancelled", "stopped");
        if (!connected) throw new LinkError("disconnected", "the browser extension is not connected; is Chrome open with ZX AI enabled?");
        return this.#start<T>(jobId, message, timeoutMs, onProgress, signal, onStatus);
      });
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#send({ type: "cancel", jobId });
        this.#settle(jobId, (job) => job.reject(new LinkError("timeout", "no complete reply in time")));
      }, timeoutMs);
      const onAbort = () => {
        this.#send({ type: "cancel", jobId });
        this.#settle(jobId, (job) => job.reject(new LinkError("cancelled", "stopped")));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const unlisten = () => signal?.removeEventListener("abort", onAbort);
      this.#jobs.set(jobId, { message, resolve: resolve as (v: never) => void, reject, onProgress, onStatus, timer, unlisten });
      this.#send(message);
    });
  }

  /** Wait a little for the extension to (re)connect. */
  #whenConnected(signal?: AbortSignal): Promise<boolean> {
    if (this.#connectWaitMs <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const finish = (value: boolean) => {
        clearTimeout(timer);
        this.off("change", check);
        signal?.removeEventListener("abort", stop);
        resolve(value);
      };
      const check = () => {
        if (this.connected) finish(true);
      };
      const stop = () => finish(false);
      const timer = setTimeout(stop, this.#connectWaitMs);
      this.on("change", check);
      signal?.addEventListener("abort", stop, { once: true });
    });
  }

  #settle(jobId: string, action: (job: Job) => void): void {
    const job = this.#jobs.get(jobId);
    if (job === undefined) return;
    this.#jobs.delete(jobId);
    clearTimeout(job.timer);
    job.unlisten();
    action(job);
  }

  #failAll(code: "disconnected", message: string): void {
    if (this.#grace !== null) {
      clearTimeout(this.#grace);
      this.#grace = null;
    }
    for (const jobId of [...this.#jobs.keys()]) {
      this.#settle(jobId, (job) => job.reject(new LinkError(code, message)));
    }
  }

  #send(message: BridgeToExtension): void {
    try {
      this.#socket?.send(JSON.stringify(message));
    } catch {
      // A socket closing under us; `detach` will follow and fail the jobs.
    }
  }
}

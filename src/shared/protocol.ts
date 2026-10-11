/**
 * The contract between the bridge (Node) and the browser extension.
 *
 * Pure types and constants, no runtime dependencies, so both sides import this
 * one file: the bridge from `src/`, the extension through esbuild. A field
 * renamed here is a compile error on both sides instead of a silent mismatch.
 */

/** The launcher the extension asks to start and stop ZX (host/zx-launcher.mjs). */
export const LAUNCHER_URL = "http://127.0.0.1:39270";

/** Default port. The extension connects here unless its options say otherwise. */
export const DEFAULT_PORT = 39271;

/**
 * The extension's fixed ID, derived from the `key` in `extension/manifest.json`.
 *
 * The bridge accepts a WebSocket only from `chrome-extension://<this id>`. A web
 * page cannot forge that Origin, so the extension needs no token and there is
 * nothing to paste. `test/protocol.test.ts` checks it still matches the key.
 */
export const EXTENSION_ID = "fcpgbikgfnfapkcfgfbkjfdjdemagdkp";

/**
 * How to drive one chat site, as data. Every list is tried in order and the
 * first selector that matches wins, so a stale selector can be fixed from the
 * UI by putting a working one in front of it.
 */
export type Site = {
  id: string;
  label: string;
  /** Where a fresh conversation starts. */
  url: string;
  /** Chrome match patterns for tabs that belong to this site. */
  match: string[];
  /** The message box: a textarea or a contenteditable. */
  composer: string[];
  /** The send button. Enter is the fallback when none matches. */
  send: string[];
  /** Anything visible only while the model is still writing. */
  stop: string[];
  /** Every assistant reply on the page; the last one is the newest. */
  reply: string[];
};

export type FailCode =
  | "no-tab"
  | "no-permission"
  | "no-composer"
  | "send-failed"
  | "no-reply"
  | "timeout"
  | "cancelled"
  | "page-lost"
  | "internal";

/** Where an ask is, as the extension sees it. */
export type Phase = "opening" | "typing" | "sending" | "waiting" | "hidden";

export type ProbeReport = {
  url: string;
  composer: string | null;
  send: string | null;
  stop: string | null;
  reply: string | null;
  replies: number;
  /** Where the probe's search text was found: element trails, innermost first. */
  found?: string[][];
  /** The end of the page's visible text. */
  tail?: string;
  /** Clickable things around the composer, to find a working send selector. */
  buttons?: { tag: string; label: string; testid: string | null; classes: string; enabled: boolean; toggle: boolean; svg: boolean }[];
};

export type BridgeToExtension =
  | {
      type: "ask";
      jobId: string;
      site: Site;
      text: string;
      /** Navigate to `site.url` first. */
      newChat: boolean;
      /**
       * Sent before `text` unless the tab is already on `primedUrl`.
       * The extension decides because only it knows where the tab is right now.
       */
      primer: string;
      primedUrl: string | null;
    }
  | { type: "cancel"; jobId: string }
  | { type: "probe"; jobId: string; site: Site }
  | { type: "show"; site: Site }
  /** Stop and start the ZX app through the native host. */
  | { type: "restart-app" }
  /** The ZX page's address, for the side panel. */
  | { type: "ui"; url: string }
  /** The extension restarted mid-reply: keep watching that tab for it. */
  | { type: "resume"; jobId: string; site: Site }
  /** The extension on disk is newer than the one running: reload it. */
  | { type: "reload" }
  | { type: "pong" };

export type ExtensionToBridge =
  | { type: "hello"; version: string; build?: string }
  | { type: "status"; jobId: string; phase: Phase }
  /** Something went wrong inside the extension, reported so it shows up next to the bridge's own log. */
  | { type: "log"; level: "error" | "warn" | "info"; message: string }
  | { type: "progress"; jobId: string; text: string }
  | { type: "done"; jobId: string; text: string; url: string }
  | { type: "failed"; jobId: string; code: FailCode; message: string; text?: string }
  | { type: "probed"; jobId: string; report: ProbeReport }
  | { type: "ping" };

/** A tab URL without query or hash, which is what identifies a conversation. */
export function conversationKey(url: string): string {
  const cut = url.search(/[?#]/);
  return (cut === -1 ? url : url.slice(0, cut)).replace(/\/+$/, "");
}

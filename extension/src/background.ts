import {
  DEFAULT_PORT,
  LAUNCHER_URL,
  conversationKey,
  type BridgeToExtension,
  type ExtensionToBridge,
  type FailCode,
  type Phase,
  type Site,
} from "../../src/shared/protocol.js";
import type { StartResult, TickResult } from "./page.js";
import { ACTIVATION_KEY } from "./activation.js";

/**
 * The extension's only long-lived part: one WebSocket to the bridge.
 *
 * Chrome keeps a service worker alive while its WebSocket is active (Chrome
 * 116+), so a ping every 20 seconds holds it up for as long as the bridge runs.
 * When the bridge is down, an alarm wakes the worker every 30 seconds to try
 * again, so starting the bridge later needs no click here.
 */

const VERSION = chrome.runtime.getManifest().version;
const TICK_MS = 700;
const ASK_LIMIT_MS = 10 * 60_000;
const HIDDEN_STALL_MS = 45_000;

type Job = { cancelled: boolean; tabId?: number; last: string };

let socket: WebSocket | null = null;
let connecting = false;
/** Another browser holds ZX: do not knock it off by reconnecting until then. */
let backOffUntil = 0;
const CLOSE_BUSY = 4001;

/** This browser's name, for the bridge to tell the user which browser is connected. */
function browserName(): string {
  const brands = (navigator as unknown as { userAgentData?: { brands?: { brand: string }[] } }).userAgentData?.brands ?? [];
  const named = brands.map((b) => b.brand).find((b) => !/chromium|not.?a.?brand/i.test(b));
  if (named) return named.replace(/^Google /, "");
  return /Edg\//.test(navigator.userAgent) ? "Edge" : "Chrome";
}

/** One id per install, so the bridge can tell a restarted worker from a second browser. */
async function instanceId(): Promise<string> {
  const { instance } = await chrome.storage.local.get("instance");
  if (typeof instance === "string") return instance;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ instance: id });
  return id;
}
const jobs = new Map<string, Job>();

async function bridgePort(): Promise<number> {
  const { port } = await chrome.storage.local.get("port");
  return typeof port === "number" ? port : DEFAULT_PORT;
}

async function connect(claim = false): Promise<void> {
  // Startup, install, the alarm and the first call all land here at once; one socket only.
  if (connecting || (socket !== null && socket.readyState <= WebSocket.OPEN)) return;
  if (!claim && Date.now() < backOffUntil) return;
  connecting = true;
  try {
    // Not activated in this browser yet: the side panel asks for the author's number first.
    if ((await chrome.storage.local.get(ACTIVATION_KEY))[ACTIVATION_KEY] !== true) return;
    open(await bridgePort(), await instanceId(), claim);
  } finally {
    connecting = false;
  }
}

function open(port: number, id: string, claim: boolean): void {
  const query = new URLSearchParams({ id, browser: browserName(), ...(claim ? { claim: "1" } : {}) });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?${query}`);
  socket = ws;
  let keepAlive: ReturnType<typeof setInterval> | null = null;
  ws.onopen = () => {
    backOffUntil = 0;
    void chrome.storage.local.set({ busyWith: null });
    send({ type: "hello", version: VERSION, build: chrome.runtime.getManifest().version_name ?? "" });
    keepAlive = setInterval(() => send({ type: "ping" }), 20_000);
  };
  ws.onmessage = (event) => {
    try {
      void handle(JSON.parse(String(event.data)) as BridgeToExtension);
    } catch {
      // Not JSON; ignore.
    }
  };
  ws.onclose = (event) => {
    if (keepAlive !== null) clearInterval(keepAlive);
    if (socket !== ws) return;
    socket = null;
    if (event.code === CLOSE_BUSY) {
      // ZX is used from another browser. Wait quietly; the side panel offers to move it here.
      backOffUntil = Date.now() + 60_000;
      void chrome.storage.local.set({ uiUrl: null, busyWith: event.reason || "another browser" });
      setTimeout(() => void connect(), 61_000);
      return;
    }
    void chrome.storage.local.set({ uiUrl: null, busyWith: null });
    // Running jobs keep going: the bridge asks to resume them after reconnecting,
    // and what they send meanwhile is dropped by send().
    setTimeout(() => void connect(), 5000);
  };
}

function send(message: ExtensionToBridge): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

async function handle(message: BridgeToExtension): Promise<void> {
  switch (message.type) {
    case "ask":
      return ask(message);
    case "cancel": {
      const job = jobs.get(message.jobId);
      if (job === undefined) return;
      job.cancelled = true;
      if (job.tabId !== undefined) await run(job.tabId, () => (globalThis as any).__zx?.stop(), []).catch(() => undefined);
      return;
    }
    case "probe":
      try {
        const tab = await siteTab(message.site, false);
        await inject(tab.id);
        const report = await run(tab.id, (s: Site) => (globalThis as any).__zx.probe(s), [message.site]);
        send({ type: "probed", jobId: message.jobId, report });
      } catch (error) {
        send({ type: "failed", jobId: message.jobId, ...describe(error) });
      }
      return;
    case "show": {
      const tab = await siteTab(message.site, false).catch(() => null);
      if (tab === null) return;
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return;
    }
    case "ui":
      await chrome.storage.local.set({ uiUrl: message.url });
      return;
    case "resume":
      return resume(message);
    case "restart-app":
      // The launcher does both halves; this worker loses its connection halfway.
      await fetch(`${LAUNCHER_URL}/restart`, { method: "POST" }).catch((error: unknown) => log("error", `launcher: ${String(error)}`));
      return;
    case "reload":
      chrome.runtime.reload();
      return;
    case "pong":
      return;
  }
}

async function ask(m: Extract<BridgeToExtension, { type: "ask" }>): Promise<void> {
  const job: Job = { cancelled: false, last: "" };
  jobs.set(m.jobId, job);
  const phase = (p: Phase) => send({ type: "status", jobId: m.jobId, phase: p });
  try {
    phase("opening");
    const tab = await siteTab(m.site, m.newChat);
    await claim(m.jobId, job, tab.id);
    // The primer goes first unless this tab is already in the conversation
    // the bridge primed. Only here is it known where the tab is right now.
    const primed = !m.newChat && m.primedUrl !== null && conversationKey(tab.url ?? "") === m.primedUrl;
    const text = primed ? m.text : m.primer + m.text;

    await inject(tab.id);
    phase("typing");
    const typed = (await run(tab.id, (s: Site, t: string) => (globalThis as any).__zx.prepare(s, t), [m.site, text])) as StartResult;
    if (!typed.ok) return send({ type: "failed", jobId: m.jobId, code: typed.code, message: typed.message });
    if (job.cancelled) return;
    phase("sending");
    const started = (await run(tab.id, () => (globalThis as any).__zx.submit(), [])) as StartResult;
    if (!started.ok) return send({ type: "failed", jobId: m.jobId, code: started.code, message: started.message });
    phase("waiting");
    await follow(m.jobId, job, tab);
  } catch (error) {
    send({ type: "failed", jobId: m.jobId, ...describe(error), text: job.last });
  } finally {
    await release(m.jobId, job);
  }
}

/**
 * Tie a job to its tab: kept for a restarted worker to resume on the same tab,
 * and the tab is not discarded to save memory while the reply is written.
 */
async function claim(jobId: string, job: Job, tabId: number): Promise<void> {
  job.tabId = tabId;
  await chrome.storage.session.set({ [`job:${jobId}`]: tabId }).catch(() => undefined);
  await chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => undefined);
}

async function release(jobId: string, job: Job): Promise<void> {
  if (jobs.get(jobId) === job) jobs.delete(jobId);
  await chrome.storage.session.remove(`job:${jobId}`).catch(() => undefined);
  if (job.tabId !== undefined) await chrome.tabs.update(job.tabId, { autoDiscardable: true }).catch(() => undefined);
}

/** Pick up a reply this worker was watching before it restarted. */
async function resume(m: Extract<BridgeToExtension, { type: "resume" }>): Promise<void> {
  // Still running in this worker (only the socket dropped): it reports to the new socket by itself.
  if (jobs.has(m.jobId)) return;
  const job: Job = { cancelled: false, last: "" };
  jobs.set(m.jobId, job);
  try {
    // The tab the job was started on, not whichever chat tab is in front now.
    const key = `job:${m.jobId}`;
    const saved = (await chrome.storage.session.get(key).catch((): Record<string, unknown> => ({})))[key];
    const tab = typeof saved === "number" ? await tabById(saved) : await siteTab(m.site, false);
    await claim(m.jobId, job, tab.id);
    log("info", `resuming a reply on ${m.site.label}`);
    await follow(m.jobId, job, tab);
  } catch (error) {
    send({ type: "failed", jobId: m.jobId, ...describe(error), text: job.last });
  } finally {
    await release(m.jobId, job);
  }
}

async function tabById(id: number): Promise<Tab> {
  const tab = await chrome.tabs.get(id).catch(() => null);
  if (tab?.id === undefined) throw new Error("No tab: the chat tab was closed");
  return { id: tab.id, windowId: tab.windowId, ...(tab.url === undefined ? {} : { url: tab.url }) };
}

/** Poll the page until the reply is finished, forwarding progress. */
async function follow(jobId: string, job: Job, tab: Tab): Promise<void> {
  const m = { jobId };
  {
    const deadline = Date.now() + ASK_LIMIT_MS;
    let moved = Date.now();
    let surfaced = false;
    let hidden = false;
    while (!job.cancelled) {
      await new Promise((resolve) => setTimeout(resolve, TICK_MS));
      if (job.cancelled) return;
      if (Date.now() > deadline) return send({ type: "failed", jobId: m.jobId, code: "timeout", message: "no complete reply in 10 minutes", text: job.last });

      const result = (await run(tab.id, () => (globalThis as any).__zx?.tick() ?? null, [])) as TickResult | null;
      // A reload wipes the page script and the reply being watched.
      if (result === null || result === undefined) {
        return send({ type: "failed", jobId: m.jobId, code: "page-lost", message: "the chat page was reloaded", text: job.last });
      }
      hidden = result.state === "running" && result.hidden === true;
      if (result.state === "running") {
        if (result.text !== job.last) {
          job.last = result.text;
          moved = Date.now();
          send({ type: "progress", jobId: m.jobId, text: job.last });
        }
        // Still nothing after a while in the background: say so once, so the
        // user can show the tab. The tab is never brought forward by itself.
        if (hidden && !surfaced && Date.now() - moved > HIDDEN_STALL_MS) {
          surfaced = true;
          send({ type: "status", jobId: m.jobId, phase: "hidden" });
        }
        continue;
      }
      if (result.state === "done") return send({ type: "done", jobId: m.jobId, text: result.text, url: result.url });
      return send({ type: "failed", jobId: m.jobId, code: result.code, message: result.message, text: result.text ?? job.last });
    }
  }
}

function log(level: "error" | "warn" | "info", message: string): void {
  send({ type: "log", level, message });
}

// Errors that would otherwise only show on chrome://extensions go to the bridge's log.
self.addEventListener("error", (event) => log("error", `${(event as ErrorEvent).message} at ${(event as ErrorEvent).filename}:${(event as ErrorEvent).lineno}`));
self.addEventListener("unhandledrejection", (event) => {
  const reason = (event as PromiseRejectionEvent).reason;
  log("error", `unhandled: ${reason instanceof Error ? `${reason.message}\n${reason.stack ?? ""}` : String(reason)}`);
});

type Tab = { id: number; windowId: number; url?: string };

/**
 * The tab to use for a site: the one in view, else the most recently used,
 * else a new background tab. It is never switched to, focused or restored:
 * the user keeps what they are looking at. awake.ts keeps a background tab
 * drawing; if a site still draws nothing, the status says so after a while
 * and "Show tab" is the user's choice.
 */
async function siteTab(site: Site, newChat: boolean): Promise<Tab> {
  const tabs = (await chrome.tabs.query({ url: site.match })).filter((t) => t.id !== undefined);
  let tab = tabs.find((t) => t.active) ?? tabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];

  if (tab === undefined) {
    // No chat tab yet: open one behind the user's tab, or, with no browser
    // window open at all, in a minimized window.
    const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
    const host = windows.find((w) => w.focused) ?? windows[0];
    tab =
      host?.id !== undefined
        ? await chrome.tabs.create({ url: site.url, active: false, windowId: host.id })
        : (await chrome.windows.create({ url: site.url, focused: false, state: "minimized" })).tabs?.[0];
    if (tab?.id === undefined) throw new Error("No tab could be opened");
    await loaded(tab.id);
  } else if (newChat) {
    await chrome.tabs.update(tab.id!, { url: site.url });
    await loaded(tab.id!);
  }

  const fresh = await chrome.tabs.get(tab.id!);
  return { id: fresh.id!, windowId: fresh.windowId, ...(fresh.url === undefined ? {} : { url: fresh.url }) };
}

async function loaded(tabId: number): Promise<void> {
  // Right after a navigation starts the tab can still report the old page as
  // complete; wait for it to start loading first.
  for (let i = 0; i < 10 && (await chrome.tabs.get(tabId)).status === "complete"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  for (let i = 0; i < 60; i++) {
    if ((await chrome.tabs.get(tabId)).status === "complete") return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function inject(tabId: number): Promise<void> {
  // Tabs opened before the extension was (re)loaded have no awake.js yet.
  await chrome.scripting.executeScript({ target: { tabId }, files: ["awake.js"], world: "MAIN" }).catch(() => undefined);
  await chrome.scripting.executeScript({ target: { tabId }, files: ["page.js"] });
}

async function run<A extends unknown[]>(tabId: number, func: (...args: A) => unknown, args: A, world: "ISOLATED" | "MAIN" = "ISOLATED"): Promise<any> {
  const [first] = await chrome.scripting.executeScript({ target: { tabId }, func, args, world });
  return first?.result;
}

function describe(error: unknown): { code: FailCode; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (/No tab could be opened/.test(message)) return { code: "no-tab", message };
  if (/Cannot access|host permission|permission to access/i.test(message)) return { code: "no-permission", message };
  if (/No tab|tab was closed|Frame with ID|was removed|navigat/i.test(message)) return { code: "page-lost", message };
  return { code: "internal", message };
}

// Options page: is the bridge connected?
chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  const type = (message as { type?: string })?.type;
  if (type === "status") reply({ connected: socket?.readyState === WebSocket.OPEN });
  // The side panel's "use ZX in this browser".
  if (type === "claim") {
    backOffUntil = 0;
    void connect(true);
    reply({ ok: true });
  }
  return false;
});

chrome.storage.onChanged.addListener((changes) => {
  if ("port" in changes) socket?.close();
  if (ACTIVATION_KEY in changes) void connect();
});

// The toolbar icon opens ZX in the side panel, next to the chat tab.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);

chrome.alarms.create("connect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => void connect());
chrome.runtime.onStartup.addListener(() => void connect());
chrome.runtime.onInstalled.addListener(() => void connect());
void connect();

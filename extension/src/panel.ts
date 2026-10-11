/**
 * The side panel: the ZX page itself, next to the chat tab. Keeping the chat
 * tab visible is what lets sites like DeepSeek draw the reply at all.
 *
 * The bridge hands the extension the page's address (with its per-launch
 * token) once it connects; this panel follows it across bridge restarts.
 */
const frame = document.getElementById("ui") as HTMLIFrameElement;
const off = document.getElementById("off") as HTMLElement;
const busy = document.getElementById("busy") as HTMLElement;
let busyWith: unknown = null;

function show(url: unknown): void {
  lastUrl = url;
  form.hidden = activated;
  if (!activated) {
    frame.hidden = true;
    off.hidden = true;
    busy.hidden = true;
    return;
  }
  const connected = typeof url === "string" && url.startsWith("http://127.0.0.1:");
  if (connected && frame.src !== url) frame.src = url;
  frame.hidden = !connected;
  // ZX is running but held by another browser: not "off", and no start button.
  busy.hidden = connected || typeof busyWith !== "string";
  off.hidden = connected || !busy.hidden;
  (document.getElementById("busyWith") as HTMLElement).textContent = typeof busyWith === "string" ? ` (${busyWith})` : "";
}

const claim = document.getElementById("claim") as HTMLButtonElement;
claim.addEventListener("click", async () => {
  claim.disabled = true;
  (document.getElementById("claimNote") as HTMLElement).textContent = "در حال اتصال…";
  await chrome.runtime.sendMessage({ type: "claim" }).catch(() => undefined);
  setTimeout(() => (claim.disabled = false), 3000);
});

import { LAUNCHER_URL } from "../../src/shared/protocol.js";
import { ACTIVATION_KEY, isAuthorNumber } from "./activation.js";

const form = document.getElementById("activate") as HTMLFormElement;
const activateNote = document.getElementById("activateNote") as HTMLElement;
let activated = false;
let lastUrl: unknown = null;

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const value = (document.getElementById("mobile") as HTMLInputElement).value;
  if (await isAuthorNumber(value)) {
    await chrome.storage.local.set({ [ACTIVATION_KEY]: true });
    activateNote.textContent = "فعال شد.";
  } else {
    activateNote.textContent = "شماره درست نیست.";
  }
});

/** Ask the launcher (a small process started by start.cmd) to start or stop ZX. */
async function launcher(action: "start" | "stop"): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${LAUNCHER_URL}/${action}`, { method: "POST" });
    return (await res.json()) as { ok: boolean; error?: string };
  } catch {
    return { ok: false, error: "راه‌انداز ZX اجرا نیست. یک بار start.cmd را اجرا کنید (بعد از هر بار روشن کردن ویندوز)." };
  }
}

const startButton = document.getElementById("start") as HTMLButtonElement;
const note = document.getElementById("note") as HTMLElement;
startButton.addEventListener("click", async () => {
  startButton.disabled = true;
  note.textContent = "در حال روشن شدن…";
  const reply = await launcher("start");
  note.textContent = reply.ok ? "روشن شد؛ در حال اتصال…" : `روشن نشد: ${reply.error}`;
  startButton.disabled = false;
});

void chrome.storage.local.get(["uiUrl", "busyWith", ACTIVATION_KEY]).then((stored) => {
  activated = stored[ACTIVATION_KEY] === true;
  busyWith = stored.busyWith ?? null;
  show(stored.uiUrl);
});
chrome.storage.onChanged.addListener((changes) => {
  if (ACTIVATION_KEY in changes) {
    activated = (changes[ACTIVATION_KEY] as { newValue?: unknown }).newValue === true;
    show(lastUrl);
  }
  const held = changes.busyWith as { newValue?: unknown } | undefined;
  if (held !== undefined) {
    busyWith = held.newValue ?? null;
    show(lastUrl);
  }
  const change = changes.uiUrl as { newValue?: unknown } | undefined;
  if (change !== undefined) show(change.newValue);
});

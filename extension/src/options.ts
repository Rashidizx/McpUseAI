import { DEFAULT_PORT, LAUNCHER_URL } from "../../src/shared/protocol.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function refresh(): Promise<void> {
  const status = $("status");
  try {
    const { connected } = (await chrome.runtime.sendMessage({ type: "status" })) as { connected: boolean };
    status.textContent = connected ? "وصل" : "وصل نیست";
    status.className = connected ? "ok" : "bad";
  } catch {
    status.textContent = "نامشخص";
  }
}

async function load(): Promise<void> {
  const { port } = await chrome.storage.local.get("port");
  $<HTMLInputElement>("port").value = String(typeof port === "number" ? port : DEFAULT_PORT);
}

$("save").addEventListener("click", async () => {
  const port = Number($<HTMLInputElement>("port").value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return;
  await chrome.storage.local.set({ port });
  setTimeout(() => void refresh(), 1500);
});

$("allow").addEventListener("click", async () => {
  const host = $<HTMLInputElement>("host").value.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const note = $("allowed");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) {
    note.textContent = "نام سایت درست نیست";
    return;
  }
  const granted = await chrome.permissions.request({ origins: [`https://${host}/*`] });
  note.textContent = granted
    ? `اجازه داده شد. حالا سایت را در تنظیمات برنامه اضافه کنید (match: https://${host}/*).`
    : "اجازه داده نشد.";
});

async function service(action: "start" | "stop"): Promise<void> {
  const out = $("svc");
  out.textContent = action === "start" ? "در حال روشن شدن…" : "در حال خاموش شدن…";
  let reply: { ok: boolean; error?: string };
  try {
    reply = (await (await fetch(`${LAUNCHER_URL}/${action}`, { method: "POST" })).json()) as { ok: boolean; error?: string };
  } catch {
    reply = { ok: false, error: "راه‌انداز ZX اجرا نیست. یک بار start.cmd را اجرا کنید." };
  }
  out.textContent = reply.ok ? (action === "start" ? "روشن شد." : "خاموش شد.") : `نشد: ${reply.error}`;
  setTimeout(() => void refresh(), 1500);
}
$("on").addEventListener("click", () => void service("start"));
$("off").addEventListener("click", () => void service("stop"));

void load();
void refresh();
setInterval(() => void refresh(), 3000);

// About: the version the browser is running.
const versionSlot = document.getElementById("version");
if (versionSlot) versionSlot.textContent = chrome.runtime.getManifest().version;

#!/usr/bin/env node
/**
 * Bring ZX up or down from a terminal or start.cmd.
 *
 *   node scripts/launcher.mjs            start the launcher (if needed) and ZX, open the page
 *   node scripts/launcher.mjs --no-open  same, without opening the browser
 *   node scripts/launcher.mjs --stop     stop ZX and the launcher
 *
 * The launcher (host/zx-launcher.mjs) is the small background process the
 * browser extension asks to start and stop ZX. It does not start with Windows
 * on its own: run start.cmd after logging in.
 *
 * Earlier builds registered a Chrome native messaging host instead. Chrome
 * reported it "not found" on this machine, so that registration is removed.
 */
import { execFileSync, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LAUNCHER = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "host", "zx-launcher.mjs");
const URL_LAUNCHER = "http://127.0.0.1:39270";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (path, method = "POST") =>
  fetch(`${URL_LAUNCHER}${path}`, { method, signal: AbortSignal.timeout(30_000) }).then((r) => r.json()).catch(() => null);

if (process.platform === "win32") {
  try {
    execFileSync("reg", ["delete", "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.zxai.host", "/f"], { stdio: "ignore" });
  } catch {
    // Not registered.
  }
  rmSync(join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "zx-ai", "host"), { recursive: true, force: true });
}

// No process.exit() anywhere below: forcing an exit right after fetch() trips
// libuv on Windows ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"),
// because fetch's parser is still being compiled on a background thread. The
// script ends by itself once its work is done.
if (process.argv.includes("--stop")) {
  await call("/stop");
  await call("/quit");
  console.log("ZX and its launcher are stopped.");
} else {
  if ((await call("/status", "GET")) === null) {
    spawn(process.execPath, [LAUNCHER], { detached: true, windowsHide: true, stdio: "ignore" }).unref();
    for (let i = 0; i < 25 && (await call("/status", "GET")) === null; i++) await sleep(200);
  }
  const started = await call("/start");
  if (!started?.ok) {
    console.error(`ZX did not start: ${started?.error ?? "the launcher did not answer"}`);
    process.exitCode = 1;
  } else {
    console.log("ZX is running: http://127.0.0.1:39271/  (stop: npm run down, or the Stop button in ZX)");
    if (!process.argv.includes("--no-open") && process.platform === "win32") {
      spawn("explorer.exe", ["http://127.0.0.1:39271/"], { detached: true, stdio: "ignore" }).unref();
    }
  }
}

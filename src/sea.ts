/**
 * Entry point of the packaged single file (ZX-AI-Setup.exe). One program,
 * three roles, chosen by its arguments:
 *
 *   (none)       setup: install into %LOCALAPPDATA%\ZX-AI, start ZX, show the
 *                remaining Chrome steps. Running it again updates and starts.
 *   --launcher   the small background process the extension asks to start/stop ZX
 *   --server     ZX itself
 *
 * Installed layout, which the server's relative paths rely on:
 *   ZX-AI\bin\zx-ai.exe   ZX-AI\ui\index.html   ZX-AI\extension\dist\...
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

import { startLauncher } from "../host/launcher-core.mjs";
import { VERSION } from "./shared/version.js";

declare const require: (id: string) => any;

const ROOT = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "ZX-AI");
const EXE = join(ROOT, "bin", "zx-ai.exe");
const LAUNCHER = "http://127.0.0.1:39270";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const call = (path: string, method = "POST") =>
  fetch(`${LAUNCHER}${path}`, { method, signal: AbortSignal.timeout(30_000) }).then((r) => r.json() as Promise<{ ok?: boolean; error?: string }>).catch(() => null);

async function setup(): Promise<void> {
  console.log(`\n  ZX AI ${VERSION} — نصب\n`);

  // A running copy holds bin\zx-ai.exe open; stop it before replacing it,
  // with or without its launcher.
  if ((await call("/status", "GET")) !== null) {
    await call("/stop");
    await call("/quit");
  } else {
    await fetch("http://127.0.0.1:39271/api/shutdown", { method: "POST", signal: AbortSignal.timeout(3000) }).catch(() => undefined);
  }
  await sleep(800);

  const sea = require("node:sea");
  const files: string[] = JSON.parse(sea.getAsset("files.json", "utf8"));
  for (const name of files) {
    const target = join(ROOT, ...name.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(sea.getAsset(name)));
  }
  mkdirSync(dirname(EXE), { recursive: true });
  if (process.execPath.toLowerCase() !== EXE.toLowerCase()) {
    // The old copy may take a moment to let go of the file.
    for (let attempt = 1; ; attempt++) {
      try {
        copyFileSync(process.execPath, EXE);
        break;
      } catch (error) {
        if (attempt >= 15) throw new Error(`could not replace ${EXE}; close ZX AI and run setup again (${(error as Error).message})`);
        await sleep(400);
      }
    }
  }

  spawn(EXE, ["--launcher"], { detached: true, windowsHide: true, stdio: "ignore" }).unref();
  for (let i = 0; i < 40 && (await call("/status", "GET")) === null; i++) await sleep(250);
  const started = await call("/start");

  const extension = join(ROOT, "extension", "dist");
  console.log(started?.ok ? "  ZX روشن شد: http://127.0.0.1:39271/\n" : `  ZX روشن نشد: ${started?.error ?? "راه‌انداز جواب نداد"}\n`);
  console.log("  فقط بار اول، در Chrome:");
  console.log("   1. به chrome://extensions بروید و Developer mode را روشن کنید.");
  console.log("   2. Load unpacked را بزنید و این پوشه را انتخاب کنید (الان باز شد):");
  console.log(`      ${extension}`);
  console.log("   3. روی آیکون ZX AI بزنید و شماره موبایل نویسنده را وارد کنید.\n");
  console.log("  بعد از هر بار روشن کردن ویندوز، برای روشن کردن ZX این فایل را اجرا کنید:");
  console.log(`      ${EXE}\n`);

  if (process.env.ZX_NO_OPEN !== "1") {
    spawn("explorer.exe", [extension], { detached: true, stdio: "ignore" }).unref();
    if (started?.ok) spawn("explorer.exe", ["http://127.0.0.1:39271/"], { detached: true, stdio: "ignore" }).unref();
  }

  // Wait for Enter (or the end of input), then let the process end by itself:
  // forcing an exit while the console handle is closing trips libuv on Windows.
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>((done) => {
    rl.question("  Enter را بزنید تا بسته شود… ", () => done());
    rl.on("close", () => done());
  });
  rl.close();
  process.stdin.unref();
}

/** Start ZX when this copy is the installed one, or install when it is the setup file. */
async function startInstalled(): Promise<void> {
  if (!existsSync(join(ROOT, "ui", "index.html")) || process.execPath.toLowerCase() !== EXE.toLowerCase()) return setup();
  if ((await call("/status", "GET")) === null) {
    spawn(EXE, ["--launcher"], { detached: true, windowsHide: true, stdio: "ignore" }).unref();
    for (let i = 0; i < 40 && (await call("/status", "GET")) === null; i++) await sleep(250);
  }
  const started = await call("/start");
  console.log(started?.ok ? "ZX AI is running: http://127.0.0.1:39271/" : `ZX AI did not start: ${started?.error ?? "no answer"}`);
  if (started?.ok) spawn("explorer.exe", ["http://127.0.0.1:39271/"], { detached: true, stdio: "ignore" }).unref();
}

// The bundle is CommonJS (what a single executable runs), so no top-level await.
void (async () => {
  if (process.argv.includes("--version")) {
    console.log(VERSION);
  } else if (process.argv.includes("--server")) {
    await import("./main.js");
  } else if (process.argv.includes("--launcher")) {
    startLauncher({ file: process.execPath, args: ["--server", "--no-open"], cwd: dirname(process.execPath) });
  } else {
    await startInstalled();
  }
})().catch((error: unknown) => {
  console.error(`\n  ZX AI: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

#!/usr/bin/env node
/**
 * The ZX launcher: a tiny resident process that starts and stops the ZX app
 * for the browser extension, and does nothing else. `startLauncher` is
 * shared by the development entry (host/zx-launcher.mjs) and the packaged
 * single-file build (src/sea.ts); each says how to start the server.
 *
 *   GET  /status   -> { running }
 *   POST /start    -> starts ZX if it is not running, waits until it answers
 *   POST /stop     -> asks ZX to stop, then ends its process if it will not
 *   POST /restart  -> stop, then start
 *   POST /quit     -> ends this launcher (used by uninstall)
 *
 * Who may call it: 127.0.0.1 only, and a browser caller only if it is the ZX
 * extension. Another site's script carries its own Origin and is refused, so
 * a web page cannot start or stop anything. No dependencies.
 */
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE = join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "zx-ai");
const PORT = Number(process.env.ZX_LAUNCHER_PORT ?? 39270);
const APP = `http://127.0.0.1:${Number(process.env.ZX_PORT ?? 39271)}`;
const EXTENSION = "chrome-extension://fcpgbikgfnfapkcfgfbkjfdjdemagdkp";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function trace(line) {
  try {
    mkdirSync(STATE, { recursive: true });
    appendFileSync(join(STATE, "launcher.log"), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Logging never breaks a request.
  }
}

/** The running server's pid, or null when it does not answer. */
async function ping() {
  try {
    const res = await fetch(`${APP}/api/ping`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const body = await res.json().catch(() => ({}));
    return typeof body.pid === "number" ? body.pid : 0;
  } catch {
    return null;
  }
}

async function running() {
  return (await ping()) !== null;
}

async function until(up, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if ((await running()) === up) return true;
    await sleep(400);
  }
  return false;
}

/** How to start the server: a command and its arguments, run from `cwd`. */
let serverCommand = { file: process.execPath, args: [], cwd: process.cwd() };

async function start() {
  if (await running()) return { ok: true, running: true };
  mkdirSync(STATE, { recursive: true });
  const log = openSync(join(STATE, "server.log"), "a");
  try {
    spawn(serverCommand.file, serverCommand.args, {
      cwd: serverCommand.cwd,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", log, log],
    }).unref();
  } finally {
    // The child has its own handle; keeping ours open leaks one per start.
    closeSync(log);
  }
  trace("start requested");
  return (await until(true, 25_000)) ? { ok: true, running: true } : { ok: false, running: false, error: `ZX did not start; see ${join(STATE, "server.log")}` };
}

async function stop() {
  // The pid of the server that answers now, not one recorded by some earlier run.
  const pid = await ping();
  if (pid === null) return { ok: true, running: false };
  await fetch(`${APP}/api/shutdown`, { method: "POST", signal: AbortSignal.timeout(3000) }).catch(() => undefined);
  if (!(await until(false, 6000)) && pid > 0) {
    try {
      process.kill(pid);
    } catch {
      // Already gone.
    }
    await until(false, 3000);
  }
  trace("stop requested");
  const still = await running();
  return { ok: !still, running: still };
}

/** One start, stop or restart at a time: two clicks must not start two servers. */
let chain = Promise.resolve();
const serial = (job) => (chain = chain.then(job, job));

export function startLauncher(command) {
serverCommand = command;
const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  const hostOk = req.headers.host === `127.0.0.1:${PORT}` || req.headers.host === `localhost:${PORT}`;
  const originOk = origin === undefined || origin === EXTENSION;
  const headers = { "content-type": "application/json", "cache-control": "no-store", ...(origin === EXTENSION ? { "access-control-allow-origin": EXTENSION } : {}) };
  if (!hostOk || !originOk) {
    res.writeHead(403, headers).end(JSON.stringify({ ok: false, error: "not allowed" }));
    return;
  }
  const route = `${req.method} ${new URL(req.url ?? "/", "http://x").pathname}`;
  let body;
  try {
    if (route === "GET /status") body = { ok: true, running: await running() };
    else if (route === "POST /start") body = await serial(start);
    else if (route === "POST /stop") body = await serial(stop);
    else if (route === "POST /restart") {
      body = await serial(async () => {
        const stopped = await stop();
        return stopped.ok ? start() : { ...stopped, error: "ZX did not stop" };
      });
    } else if (route === "POST /quit") {
      res.writeHead(200, headers).end(JSON.stringify({ ok: true }), () => {
        // Let the process end by itself (see scripts/launcher.mjs); force it only if something hangs on.
        server.close();
        server.closeAllConnections();
        setTimeout(() => process.exit(0), 3000).unref();
      });
      return;
    } else {
      res.writeHead(404, headers).end(JSON.stringify({ ok: false, error: "not found" }));
      return;
    }
  } catch (error) {
    body = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  res.writeHead(200, headers).end(JSON.stringify(body));
});

server.on("error", (error) => {
  // Another launcher already owns the port: that one does the job.
  trace(`not started: ${error.message}`);
  process.exit(0);
});
server.listen(PORT, "127.0.0.1", () => trace(`listening on ${PORT}`));
}

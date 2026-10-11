import { spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { App, stateDir } from "./app.js";
import { startServer } from "./server/http.js";
import { DEFAULT_PORT, EXTENSION_ID } from "./shared/protocol.js";
import { VERSION } from "./shared/version.js";

const USAGE = `ZX AI ${VERSION}

  npm start [-- options]

  --workspace, -w <dir>   project folder the tools may touch (can also be chosen in the UI)
  --port, -p <number>     port (default ${DEFAULT_PORT}; the extension must use the same)
  --no-open               do not open the browser`;

function parseArgs(argv: readonly string[]): { workspace?: string; port: number; open: boolean } {
  const out: { workspace?: string; port: number; open: boolean } = { port: DEFAULT_PORT, open: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--workspace" || arg === "-w") out.workspace = value();
    else if (arg === "--port" || arg === "-p") {
      const port = Number(value());
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port needs a number from 1 to 65535");
      out.port = port;
    } else if (arg === "--no-open") out.open = false;
    else if (arg === "--server") continue; // the packaged build's mode flag
    else if (arg === "--version" || arg === "-v") {
      console.log(VERSION);
      process.exit(0);
    } else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}\n\n${USAGE}`);
  }
  return out;
}

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "win32" ? ["explorer.exe", [url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(command, args as string[], { detached: true, stdio: "ignore" }).on("error", () => undefined).unref();
  } catch {
    // The printed link is enough.
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const app = new App({ stateDir: stateDir(), workspace: args.workspace });
  const uiHtml = readFileSync(new URL("../ui/index.html", import.meta.url), "utf8");

  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    server = await startServer({ app, port: args.port, extensionId: EXTENSION_ID, uiHtml, onShutdown: () => void shutdown() });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new Error(`port ${args.port} is busy. Is ZX AI already running? Close it, or use --port.`);
    }
    throw error;
  }

  const link = `${server.url}/`;
  // Read by the start/stop helper the extension launches.
  const record = join(stateDir(), "server.json");
  writeFileSync(record, JSON.stringify({ pid: process.pid, port: server.port, url: link, startedAt: new Date().toISOString() }));
  app.link.uiUrl = link;
  console.log(`\n  ZX AI ${VERSION} is running\n\n  open      ${link}\n  data      ${stateDir()}\n  workspace ${app.state().workspace ?? "(choose one in the UI)"}\n\n  Ctrl+C to stop.\n`);
  if (args.open) openBrowser(link);

  let closing = false;
  async function shutdown(): Promise<void> {
    if (closing) return;
    closing = true;
    console.log("  ZX AI stopped.");
    rmSync(record, { force: true });
    // The run first (it may be waiting on the user or a program), then the listener.
    app.close();
    await server?.close();
    process.exit(0);
  }
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((error: unknown) => {
  console.error(`ZX AI: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

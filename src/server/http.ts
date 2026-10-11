import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer } from "ws";

import type { App } from "../app.js";
import { CLOSE_BUSY } from "../agent/link.js";
import { checkExtension, checkUi } from "./request-guard.js";
import { VERSION } from "../shared/version.js";

export type ServerOptions = {
  app: App;
  /** Called when the UI or the extension asks the bridge to stop. */
  onShutdown?: () => void;
  port: number;
  extensionId: string;
  /** The UI page, served at `/`. */
  uiHtml: string;
};

export type RunningServer = { port: number; url: string; close(): Promise<void> };

const MAX_BODY = 2 * 1024 * 1024;

/**
 * One listener for everything: the UI page, its JSON API, its event stream,
 * and the extension's WebSocket. Every route is authenticated before routing.
 */
export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const { app } = options;

  let port = options.port;
  const streams = new Set<ServerResponse>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  // A service worker can vanish without closing its socket, which would leave
  // "connected" on screen for a connection that is gone. Every 15 seconds each
  // socket must answer a ping, or it is dropped.
  const alive = new WeakMap<object, boolean>();
  const beat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        console.log(`[extension] no answer to ping; dropping the connection`);
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, 15_000);

  // State pushed to every open UI. Coalesced so a streaming reply does not
  // become hundreds of writes a second.
  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  const push = () => {
    if (pushTimer !== null) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      const frame = `data: ${JSON.stringify(app.state())}\n\n`;
      // A page that stopped reading (a sleeping tab) is skipped, not buffered
      // without limit; the next frame carries the whole state anyway.
      for (const res of streams) if (res.writableLength < 4 * 1024 * 1024) res.write(frame);
    }, 100);
  };
  app.on("change", push);
  const heartbeat = setInterval(() => {
    for (const res of streams) res.write(": keep-alive\n\n");
  }, 15_000);

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const verdict = checkUi({ host: req.headers.host, origin: req.headers.origin }, { port, extensionId: options.extensionId });
    if (!verdict.ok) return text(res, verdict.status, verdict.reason);

    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case "GET /":
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'",
          "referrer-policy": "no-referrer",
        });
        res.end(options.uiHtml);
        return;

      case "GET /api/events":
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(`data: ${JSON.stringify(app.state())}\n\n`);
        streams.add(res);
        req.on("close", () => streams.delete(res));
        return;

      case "GET /api/state":
        return json(res, 200, app.state());

      case "GET /api/ping":
        return json(res, 200, { ok: true, pid: process.pid, version: VERSION });

      case "GET /api/audit":
        return json(res, 200, app.recentAudit(clamp(Number(url.searchParams.get("limit") ?? 100), 1, 500)));
    }

    if (req.method !== "POST") return text(res, 404, "not found");
    try {
      const body = await readBody(req);
      switch (url.pathname) {
        case "/api/send":
          if (typeof body.text !== "string" || body.text.trim() === "") return json(res, 400, { error: "empty message" });
          if (app.session.busy) return json(res, 409, { error: "a run is already in progress" });
          app.send(body.text);
          return json(res, 200, { ok: true });
        case "/api/restart-app":
          if (!app.link.restartApp()) return json(res, 409, { error: "the extension is not connected, so it cannot start ZX again" });
          return json(res, 200, { ok: true });
        case "/api/shutdown":
          json(res, 200, { ok: true });
          setTimeout(() => options.onShutdown?.(), 100);
          return;
        case "/api/open-file":
          if (typeof body.path !== "string") return json(res, 400, { error: "no path" });
          app.openFile(body.path, body.reveal === true);
          return json(res, 200, { ok: true });
        case "/api/open-folder":
          app.openFolder();
          return json(res, 200, { ok: true });
        case "/api/pick-folder":
          return json(res, 200, { path: await app.pickFolder() });
        case "/api/restart":
          app.restart();
          return json(res, 200, { ok: true });
        case "/api/retry":
          app.retry();
          return json(res, 200, { ok: true });
        case "/api/stop":
          app.session.stop();
          return json(res, 200, { ok: true });
        case "/api/new-chat":
          app.newChat();
          return json(res, 200, { ok: true });
        case "/api/approve": {
          const decision = body.decision === "approved" ? "approved" : body.decision === "always" ? "always" : "denied";
          if (typeof body.id !== "string") return json(res, 400, { error: "no id" });
          return json(res, 200, { applied: app.approve(body.id, decision) });
        }
        case "/api/workspace":
          app.setWorkspace(String(body.path ?? ""));
          return json(res, 200, { ok: true });
        case "/api/settings":
          app.update(body);
          return json(res, 200, { ok: true });
        case "/api/probe":
          return json(res, 200, await app.probe(typeof body.needle === "string" && body.needle.trim() !== "" ? body.needle.trim() : undefined));
        case "/api/show":
          app.show();
          return json(res, 200, { ok: true });
      }
    } catch (error) {
      return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return text(res, 404, "not found");
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) text(res, 500, `internal error: ${error instanceof Error ? error.message : String(error)}`);
      else res.end();
    });
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const verdict =
      url.pathname === "/ws"
        ? checkExtension({ host: req.headers.host, origin: req.headers.origin }, { port, extensionId: options.extensionId })
        : ({ ok: false, status: 403, reason: "not found" } as const);
    if (!verdict.ok) {
      socket.end(`HTTP/1.1 ${verdict.status} Forbidden\r\nContent-Type: text/plain\r\n\r\n${verdict.reason}`);
      return;
    }
    const peer = {
      id: url.searchParams.get("id") ?? undefined,
      browser: (url.searchParams.get("browser") ?? "").slice(0, 40) || undefined,
      claim: url.searchParams.get("claim") === "1",
    };
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!app.link.attach(ws, peer)) {
        // An extension too old to send its id cannot back off; it reloads into the new build first.
        if (peer.id === undefined) ws.send(JSON.stringify({ type: "reload" }));
        // ZX is in use from another browser; this one is told who, and waits.
        ws.close(CLOSE_BUSY, (app.link.browser ?? "another browser").slice(0, 60));
        return;
      }
      alive.set(ws, true);
      console.log(`[extension] connected${peer.browser ? ` (${peer.browser})` : ""}`);
      ws.on("pong", () => alive.set(ws, true));
      ws.on("message", (data) => {
        alive.set(ws, true);
        app.link.receive(ws, data.toString());
      });
      ws.on("close", (code, reason) => {
        console.log(`[extension] disconnected (code ${code}${reason.length ? `, ${reason.toString()}` : ""})`);
        app.link.detach(ws);
      });
      ws.on("error", () => ws.close());
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  port = typeof address === "object" && address !== null ? address.port : options.port;

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      clearInterval(heartbeat);
      clearInterval(beat);
      if (pushTimer !== null) clearTimeout(pushTimer);
      app.off("change", push);
      for (const res of streams) res.end();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      // Requests that wait on the user (the folder dialog) must not hold up the exit.
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    },
  };
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function text(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(message);
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : min;
}

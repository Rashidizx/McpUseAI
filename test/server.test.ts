import { request } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { App, resolveWorkspaceRoot } from "../src/app.js";
import { startServer, type RunningServer } from "../src/server/http.js";
import { EXTENSION_ID, conversationKey } from "../src/shared/protocol.js";
import { cleanupTempDirs, makeTempDir, makeTempWorkspace } from "./helpers.js";

const opened: { app: App; server: RunningServer }[] = [];

afterEach(async () => {
  for (const { app, server } of opened.splice(0)) {
    await server.close();
    app.close();
  }
  cleanupTempDirs();
});

async function boot() {
  const workspace = makeTempWorkspace();
  writeFileSync(join(workspace, "notes.txt"), "the answer is 42");
  const app = new App({ stateDir: makeTempDir("zx-state-"), workspace });
  const server = await startServer({ app, port: 0, extensionId: EXTENSION_ID, uiHtml: "<h1>ui</h1>" });
  opened.push({ app, server });
  return { app, server, workspace };
}

function get(server: RunningServer, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.port, path, headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

const post = (server: RunningServer, path: string, body: unknown) =>
  fetch(`${server.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

function fakeExtension(server: RunningServer, origin = `chrome-extension://${EXTENSION_ID}`) {
  return new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { origin });
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 300 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
};

describe("HTTP surface", () => {
  it("serves the UI with no token at all", async () => {
    const { server } = await boot();
    const page = await get(server, "/");
    expect(page).toMatchObject({ status: 200, body: "<h1>ui</h1>" });
  });

  it("refuses a rebinding Host and a foreign Origin", async () => {
    const { server } = await boot();
    expect((await get(server, "/", { host: "evil.example" })).status).toBe(403);
    expect((await get(server, "/api/state", { origin: "https://evil.example" })).status).toBe(403);
  });

  it("reports validation errors as 400 with a message", async () => {
    const { server } = await boot();
    const res = await post(server, "/api/settings", { maxSteps: 0 });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/maxSteps/);
  });
});

describe("extension WebSocket", () => {
  it("rejects any origin but the pinned extension", async () => {
    const { server } = await boot();
    const ws = fakeExtension(server, "https://evil.example");
    const status = await new Promise<number>((resolve) => ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0)));
    expect(status).toBe(403);
  });

  it("runs a full turn: ask, tool call, result, answer", async () => {
    const { app, server } = await boot();
    const ws = fakeExtension(server);
    const asks: { jobId: string; text: string; primer: string }[] = [];
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== "ask") return;
      asks.push(message);
      const text =
        asks.length === 1
          ? 'Reading.\n```zx\n{"tool":"fs_read","arguments":{"file_path":"notes.txt"}}\n```'
          : "The answer is 42.";
      ws.send(JSON.stringify({ type: "done", jobId: message.jobId, text, url: "https://chatgpt.com/c/abc" }));
    });
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "hello", version: "test" }));
    await until(() => app.state().extension.connected);

    const res = await post(server, "/api/send", { text: "what is in notes.txt?" });
    expect(res.status).toBe(200);
    await until(() => !app.state().busy && app.state().items.length === 4);

    expect(asks[0]!.primer).toContain("fs_read");
    expect(asks[1]!.text).toContain("the answer is 42");
    expect(app.state().items.at(-1)).toMatchObject({ kind: "assistant", text: "The answer is 42." });
    ws.close();
  });
});

describe("App settings and workspace", () => {
  it("refuses a workspace that contains its own settings", () => {
    const outer = makeTempDir("zx-outer-");
    expect(() => resolveWorkspaceRoot(outer, join(outer, "state"))).toThrow(/contains the bridge's own settings/);
  });

  it("keeps settings across restarts and validates site edits", () => {
    const state = makeTempDir("zx-state-");
    const first = new App({ stateDir: state, workspace: makeTempWorkspace() });
    first.update({ siteId: "claude", mode: "edits" });
    expect(() => first.update({ site: { id: "mine", value: { url: "http://insecure" } } })).toThrow();
    first.update({
      site: {
        id: "mine",
        value: { label: "Mine", url: "https://mine.example/", match: ["https://mine.example/*"], composer: ["textarea"], send: [], stop: [], reply: [".answer"] },
      },
    });
    first.close();

    const second = new App({ stateDir: state });
    expect(second.state()).toMatchObject({ siteId: "claude", settings: { mode: "edits" } });
    expect(second.state().sites.map((s) => s.id)).toContain("mine");
    expect(JSON.parse(readFileSync(join(state, "settings.json"), "utf8")).workspace).toBe(second.state().workspace);
    second.close();
  });
});

describe("shared protocol", () => {
  it("EXTENSION_ID is the id Chrome derives from the manifest key", async () => {
    const { createHash } = await import("node:crypto");
    const manifest = JSON.parse(readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));
    const hex = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32);
    expect([...hex].map((h) => String.fromCharCode(97 + parseInt(h, 16))).join("")).toBe(EXTENSION_ID);
  });

  it("conversationKey drops query, hash and trailing slash", () => {
    expect(conversationKey("https://chatgpt.com/c/1?model=x#y")).toBe("https://chatgpt.com/c/1");
    expect(conversationKey("https://chatgpt.com/")).toBe("https://chatgpt.com");
  });
});

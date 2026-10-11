import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EXTENSION_ID } from "../src/shared/protocol.js";

const PORT = 39_280;
const BASE = `http://127.0.0.1:${PORT}`;
let launcher: ChildProcess;

beforeAll(async () => {
  // ZX_PORT points at nothing, so ZX counts as "not running" and nothing real is touched.
  launcher = spawn(process.execPath, ["host/zx-launcher.mjs"], {
    env: { ...process.env, ZX_LAUNCHER_PORT: String(PORT), ZX_PORT: "39998" },
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${BASE}/status`).then(() => true).catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("launcher did not start");
});

afterAll(async () => {
  await fetch(`${BASE}/quit`, { method: "POST" }).catch(() => undefined);
  launcher.kill();
});

describe("ZX launcher", () => {
  it("reports status", async () => {
    expect(await (await fetch(`${BASE}/status`)).json()).toEqual({ ok: true, running: false });
  });

  it("treats stop on a stopped app as done", async () => {
    expect(await (await fetch(`${BASE}/stop`, { method: "POST" })).json()).toEqual({ ok: true, running: false });
  });

  it("answers the ZX extension, with the CORS header its pages need", async () => {
    const res = await fetch(`${BASE}/status`, { headers: { origin: `chrome-extension://${EXTENSION_ID}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(`chrome-extension://${EXTENSION_ID}`);
  });

  it("refuses any other site, so a web page cannot start or stop ZX", async () => {
    const res = await fetch(`${BASE}/start`, { method: "POST", headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });
});

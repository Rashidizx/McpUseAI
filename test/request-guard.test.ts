import { describe, expect, it } from "vitest";

import { checkExtension, checkUi } from "../src/server/request-guard.js";

const extensionId = "abcdefghijklmnopabcdefghijklmnop";
const ui = (over: Partial<{ host: string; origin: string }> = {}) =>
  checkUi({ host: "127.0.0.1:4000", origin: undefined, ...over }, { port: 4000, extensionId });

describe("UI requests", () => {
  it("accepts the page itself, the extension, and callers that send no Origin", () => {
    expect(ui()).toEqual({ ok: true });
    expect(ui({ host: "localhost:4000", origin: "http://localhost:4000" })).toEqual({ ok: true });
    expect(ui({ origin: `chrome-extension://${extensionId}` })).toEqual({ ok: true });
  });

  it("refuses a foreign host (DNS rebinding)", () => {
    expect(ui({ host: "evil.example:4000" })).toMatchObject({ ok: false, status: 403 });
    expect(ui({ host: "127.0.0.1:4001" })).toMatchObject({ ok: false, status: 403 });
  });

  it("refuses another site's script and other extensions", () => {
    expect(ui({ origin: "https://evil.example" })).toMatchObject({ ok: false, status: 403 });
    expect(ui({ origin: "http://127.0.0.1:5000" })).toMatchObject({ ok: false, status: 403 });
    expect(ui({ origin: "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba" })).toMatchObject({ ok: false });
  });
});

describe("extension upgrades", () => {
  const ext = (origin: string | undefined, host = "127.0.0.1:4000") => checkExtension({ host, origin }, { port: 4000, extensionId });

  it("accepts only the pinned extension origin", () => {
    expect(ext(`chrome-extension://${extensionId}`)).toEqual({ ok: true });
  });

  it("refuses other extensions, pages, and no origin", () => {
    expect(ext("chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba")).toMatchObject({ ok: false, status: 403 });
    expect(ext("http://127.0.0.1:4000")).toMatchObject({ ok: false });
    expect(ext(undefined)).toMatchObject({ ok: false });
  });

  it("refuses a foreign host", () => {
    expect(ext(`chrome-extension://${extensionId}`, "evil.example:4000")).toMatchObject({ ok: false });
  });
});

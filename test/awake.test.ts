import { describe, it, expect, vi, afterEach } from "vitest";

/** A page whose real frames never come while hidden, like a background tab's. */
function fakePage() {
  const listeners: [string, (event: unknown) => void][] = [];
  class FakeDocument {
    really = false;
    get hidden() {
      return this.really;
    }
    addEventListener(type: string, cb: (event: unknown) => void) {
      listeners.push([type, cb]);
    }
  }
  const doc = new FakeDocument();
  const nativeFrames = new Map<number, FrameRequestCallback>();
  let nativeId = 0;
  const win: Record<string, unknown> = {
    requestAnimationFrame: (cb: FrameRequestCallback) => (nativeFrames.set(++nativeId, cb), nativeId),
    cancelAnimationFrame: (id: number) => nativeFrames.delete(id),
    addEventListener: (type: string, cb: (event: unknown) => void) => listeners.push([type, cb]),
  };
  vi.stubGlobal("Document", FakeDocument);
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  const fire = (type: string) => {
    let stopped = false;
    const event = { stopImmediatePropagation: () => (stopped = true) };
    for (const [t, cb] of listeners) if (t === type && !stopped) cb(event);
    return stopped;
  };
  return {
    win: win as unknown as Window & { __zxAwake?: () => void },
    doc,
    nativeFrames,
    fire,
    setHidden(value: boolean) {
      doc.really = value;
      return fire("visibilitychange");
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetModules();
});

describe("awake: a background chat tab keeps drawing", () => {
  it("visible tabs use the browser's frames; hidden ones a timer and ZX's poll", async () => {
    vi.useFakeTimers();
    const page = fakePage();
    await import("../extension/src/awake.js");
    const seen: string[] = [];

    page.win.requestAnimationFrame(() => seen.push("visible"));
    expect(page.nativeFrames.size).toBe(1);

    // Going hidden moves the waiting frame onto the timer, and the page never hears of it.
    expect(page.setHidden(true)).toBe(true);
    expect(page.doc.hidden).toBe(false);
    expect(page.nativeFrames.size).toBe(0);
    vi.advanceTimersByTime(20);
    expect(seen).toEqual(["visible"]);

    // A frame asked for while hidden runs on ZX's poll, once.
    const id = page.win.requestAnimationFrame(() => seen.push("woken"));
    page.fire("zx-wake");
    page.fire("zx-wake");
    expect(seen).toEqual(["visible", "woken"]);

    // And a cancelled one never runs.
    const gone = page.win.requestAnimationFrame(() => seen.push("cancelled"));
    page.win.cancelAnimationFrame(gone);
    vi.advanceTimersByTime(20);
    expect(seen).toEqual(["visible", "woken"]);
    expect(id).toBeGreaterThanOrEqual(1_000_000);
  });

  it("runs once per page", async () => {
    const page = fakePage();
    await import("../extension/src/awake.js");
    const first = page.win.__zxAwake;
    vi.resetModules();
    await import("../extension/src/awake.js");
    expect(page.win.__zxAwake).toBe(first);
  });
});

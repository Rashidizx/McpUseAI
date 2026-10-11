import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { App } from "../src/app.js";
import type { ApprovalPrompt } from "../src/core/approval-gate.js";
import { cleanupTempDirs, makeTempDir } from "./helpers.js";

afterEach(cleanupTempDirs);

const prompt = (toolName: string, opClass: ApprovalPrompt["opClass"]) =>
  ({ toolName, opClass, summary: toolName, arguments: {} }) as ApprovalPrompt;

const settle = async (p: Promise<unknown>) => Promise.race([p, new Promise((r) => setTimeout(() => r("waiting"), 20))]);

describe("approval modes", () => {
  it("ask waits; edits passes writes only; all passes everything; readonly refuses", async () => {
    const app = new App({ stateDir: makeTempDir("zx-state-") });
    expect(await settle(app.decide(prompt("fs_write", "write")))).toBe("waiting");

    app.update({ mode: "edits" });
    // the waiting write is settled by the new mode
    expect(app.queue.pending()).toHaveLength(0);
    expect(await app.decide(prompt("fs_write", "write"))).toBe("approved");
    expect(await settle(app.decide(prompt("exec", "exec")))).toBe("waiting");

    app.update({ mode: "all" });
    expect(await app.decide(prompt("exec", "exec"))).toBe("approved");

    app.update({ mode: "readonly" });
    expect(await app.decide(prompt("fs_write", "write"))).toBe("denied");
    expect(() => app.update({ mode: "yolo" })).toThrow(/mode/);
    app.close();
  });

  it("always allows that tool for this chat only", async () => {
    const app = new App({ stateDir: makeTempDir("zx-state-") });
    const first = app.decide(prompt("exec", "exec"));
    const [pending] = app.queue.pending();
    expect(app.approve(pending!.id, "always")).toBe(true);
    expect(await first).toBe("approved");
    expect(await app.decide(prompt("exec", "exec"))).toBe("approved");
    expect(app.state().allowed).toEqual(["exec"]);
    // other tools still ask
    expect(await settle(app.decide(prompt("fs_write", "write")))).toBe("waiting");

    app.newChat();
    expect(app.state().allowed).toEqual([]);
    expect(await settle(app.decide(prompt("exec", "exec")))).toBe("waiting");
    app.close();
  });

  it("reads the older autoApprove setting", () => {
    const dir = makeTempDir("zx-state-");
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ autoApprove: ["write"] }));
    const app = new App({ stateDir: dir });
    expect(app.state().settings.mode).toBe("edits");
    app.close();
  });
});

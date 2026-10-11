import { describe, expect, it } from "vitest";

import {
  QUIET_AFTER_BUSY_MS,
  QUIET_WITHOUT_BUSY_MS,
  REPLY_GRACE_MS,
  REPLY_GRACE_HIDDEN_MS,
  SEND_GRACE_MS,
  newWatch,
  step,
} from "../extension/src/settle.js";

const sample = (now: number, over: Partial<{ fresh: boolean; text: string; busy: boolean; composerHasText: boolean; incomplete: boolean; hidden: boolean }> = {}) => ({
  now,
  fresh: true,
  text: "",
  busy: false,
  composerHasText: false,
  ...over,
});

describe("when is a reply finished", () => {
  it("waits for a new reply to appear", () => {
    const watch = newWatch(0);
    expect(step(watch, sample(1000, { fresh: false }))).toEqual({ state: "running", text: "" });
  });

  it("finishes quickly after the stop button goes away", () => {
    const watch = newWatch(0);
    expect(step(watch, sample(100, { text: "Hel", busy: true })).state).toBe("running");
    expect(step(watch, sample(200, { text: "Hello" })).state).toBe("running");
    expect(step(watch, sample(200 + QUIET_AFTER_BUSY_MS, { text: "Hello" }))).toEqual({ state: "done", text: "Hello" });
  });

  it("needs a longer silence when no stop button was ever seen", () => {
    const watch = newWatch(0);
    step(watch, sample(100, { text: "Thinking" }));
    expect(step(watch, sample(100 + QUIET_AFTER_BUSY_MS, { text: "Thinking" })).state).toBe("running");
    expect(step(watch, sample(100 + QUIET_WITHOUT_BUSY_MS, { text: "Thinking" })).state).toBe("done");
  });

  it("never finishes while busy, however long the text is still", () => {
    const watch = newWatch(0);
    step(watch, sample(100, { text: "x", busy: true }));
    expect(step(watch, sample(100_000, { text: "x", busy: true })).state).toBe("running");
  });

  it("restarts the silence whenever the text changes", () => {
    const watch = newWatch(0);
    step(watch, sample(0, { text: "a", busy: true }));
    step(watch, sample(1000, { text: "ab" }));
    expect(step(watch, sample(2000, { text: "abc" })).state).toBe("running");
    expect(step(watch, sample(2000 + QUIET_AFTER_BUSY_MS, { text: "abc" })).state).toBe("done");
  });

  it("reports a message that was typed but never sent", () => {
    const watch = newWatch(0);
    expect(step(watch, sample(SEND_GRACE_MS + 1, { fresh: false, composerHasText: true }))).toMatchObject({ state: "failed", code: "send-failed" });
  });

  it("reports when no reply ever comes", () => {
    const watch = newWatch(0);
    expect(step(watch, sample(REPLY_GRACE_MS + 1, { fresh: false }))).toMatchObject({ state: "failed", code: "no-reply" });
  });

  it("keeps waiting without a reply while the site says it is working", () => {
    const watch = newWatch(0);
    expect(step(watch, sample(REPLY_GRACE_MS * 2, { fresh: false, busy: true })).state).toBe("running");
  });
});

describe("a reply that looks cut off", () => {
  it("is not finished after the usual silence", async () => {
    const { QUIET_INCOMPLETE_MS } = await import("../extension/src/settle.js");
    const watch = newWatch(0);
    step(watch, sample(0, { text: '{"tool":"fs_write"', incomplete: true }));
    expect(step(watch, sample(QUIET_WITHOUT_BUSY_MS + 1, { text: '{"tool":"fs_write"', incomplete: true })).state).toBe("running");
    expect(step(watch, sample(QUIET_INCOMPLETE_MS, { text: '{"tool":"fs_write"', incomplete: true })).state).toBe("done");
  });
});

describe("a hidden chat tab", () => {
  it("gets longer to start answering, but not forever", () => {
    const watch = newWatch(0);
    expect(step(watch, sample(REPLY_GRACE_MS * 2, { fresh: false, hidden: true })).state).toBe("running");
    expect(step(watch, sample(REPLY_GRACE_HIDDEN_MS + 1, { fresh: false, hidden: true })).state).toBe("failed");
  });
});

describe("a pause in a hidden tab", () => {
  it("is not taken for the end as quickly", () => {
    const watch = newWatch(0);
    step(watch, sample(1000, { fresh: true, busy: true, text: "a", hidden: true }));
    expect(step(watch, sample(3000, { fresh: true, text: "a", hidden: true })).state).toBe("running");
    expect(step(watch, sample(7000, { fresh: true, text: "a", hidden: true })).state).toBe("done");
  });
});

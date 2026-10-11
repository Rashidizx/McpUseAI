/**
 * Deciding when the model has finished answering. No DOM here, so Node tests it.
 *
 * A reply is finished when a new reply exists, nothing on the page says the
 * model is still writing, and the text has stopped changing for a quiet
 * period. The quiet period is short when a "stop" control was seen (the site
 * told us when it finished) and long when it never was (the selector may be
 * stale, so silence has to be more convincing).
 */

export type Watch = {
  sentAt: number;
  lastText: string;
  lastChange: number;
  sawBusy: boolean;
};

export type Sample = {
  now: number;
  /**
   * The newest reply is not the one that was newest before sending. Counting
   * replies is not enough: some sites unmount old messages as a chat grows.
   */
  fresh: boolean;
  /** Text of the newest reply. */
  text: string;
  /** A stop button or streaming marker is visible. */
  busy: boolean;
  /** The composer still holds text, which after a send means it never left. */
  composerHasText: boolean;
  /** The reply ends in a code block that is visibly cut off, e.g. JSON without its closing brace. */
  incomplete?: boolean;
  /** The chat tab is hidden; some sites draw nothing until it is shown. */
  hidden?: boolean;
};

export type Verdict =
  | { state: "running"; text: string }
  | { state: "done"; text: string }
  | { state: "failed"; code: "send-failed" | "no-reply"; message: string };

export const QUIET_AFTER_BUSY_MS = 1500;
export const QUIET_WITHOUT_BUSY_MS = 5000;
/** Silence needed before accepting a reply that looks cut off. */
export const QUIET_INCOMPLETE_MS = 30_000;
export const SEND_GRACE_MS = 15_000;
export const REPLY_GRACE_MS = 120_000;
/** A hidden tab may draw late, but not never: a site that says nothing still ends. */
export const REPLY_GRACE_HIDDEN_MS = 300_000;

export function newWatch(now: number): Watch {
  return { sentAt: now, lastText: "", lastChange: now, sawBusy: false };
}

/** Advance the watch by one sample. Mutates `watch`. */
export function step(watch: Watch, sample: Sample): Verdict {
  if (sample.busy) watch.sawBusy = true;
  const waited = sample.now - watch.sentAt;

  if (!sample.fresh) {
    if (!sample.busy && !watch.sawBusy && sample.composerHasText && waited > SEND_GRACE_MS) {
      return { state: "failed", code: "send-failed", message: "the message was typed but never sent" };
    }
    if (!sample.busy && waited > (sample.hidden ? REPLY_GRACE_HIDDEN_MS : REPLY_GRACE_MS)) {
      return { state: "failed", code: "no-reply", message: "no answer appeared" };
    }
    return { state: "running", text: "" };
  }

  if (sample.text !== watch.lastText) {
    watch.lastText = sample.text;
    watch.lastChange = sample.now;
  }
  let quiet = sample.incomplete ? QUIET_INCOMPLETE_MS : watch.sawBusy ? QUIET_AFTER_BUSY_MS : QUIET_WITHOUT_BUSY_MS;
  // A hidden tab draws in bursts (frames come from ZX's own poll), and a pause
  // there is not the end: half a file written to disk was the cost of trusting it.
  if (sample.hidden) quiet = Math.max(quiet, QUIET_WITHOUT_BUSY_MS);
  if (!sample.busy && sample.text.trim() !== "" && sample.now - watch.lastChange >= quiet) {
    return { state: "done", text: sample.text };
  }
  return { state: "running", text: sample.text };
}

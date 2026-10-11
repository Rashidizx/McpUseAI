import { EventEmitter } from "node:events";
import { basename } from "node:path";

import { ZxError } from "../core/errors.js";
import type { ToolDescription, ToolRegistry } from "../core/tool-registry.js";
import { conversationKey, type Phase } from "../shared/protocol.js";
import { fileDiff, type FileDiff } from "./diff.js";
import { LinkError, type AskOptions, type Reply } from "./link.js";
import {
  buildPrimer,
  formatParseErrors,
  formatResults,
  parseCalls,
  renderData,
  type CallResult,
  type ToolCall,
} from "./protocol.js";

/** Every item belongs to a turn: one request from the user and everything it caused. */
export type Item =
  | { id: number; turn: number; kind: "user"; text: string; /** Times this request was sent, retries included. */ sends: number }
  | { id: number; turn: number; kind: "assistant"; text: string; streaming: boolean }
  | {
      id: number;
      turn: number;
      kind: "tool";
      tool: string;
      args: Record<string, unknown>;
      status: "running" | "ok" | "error";
      summary: string;
      /** A preview for the UI. The model gets the full text. */
      output: string;
      /** Set for a successful write: what changed in the file. */
      change?: FileDiff;
    }
  | { id: number; turn: number; kind: "notice"; level: "info" | "error"; text: string; retry?: boolean };

/** What the run is doing right now, for the status line. */
export type Status = {
  phase: Phase | "idle" | "receiving" | "tool" | "approval" | "retrying" | "done" | "error" | "stopped";
  detail: string;
};

export type Tools = {
  registry: ToolRegistry;
  list: ToolDescription[];
  workspace: string;
  /** A file's text inside the workspace, or null when it does not exist. */
  peek(path: string): string | null;
  /** The absolute path of a workspace file; throws outside the sandbox. */
  resolve(path: string): string;
};

export type SessionDeps = {
  ask(text: string, options: AskOptions): Promise<Reply>;
  /** The current workspace's tools, or null when no workspace is chosen. */
  tools(): Tools | null;
  limits(): { maxSteps: number; maxChars: number };
  /** Refuse every approval still waiting, so a stopped run cannot hang. */
  cancelApprovals(): void;
};

const PREVIEW_CHARS = 4000;
/** Failures where the message provably never left, so resending is safe. */
const NOT_SENT: ReadonlySet<string> = new Set(["send-failed", "no-composer"]);
const AUTO_RETRIES = 2;
const AUTO_RETRY_DELAY_MS = 1500;
const MAX_PARSE_ERRORS_IN_ROW = 3;

type UserItem = Extract<Item, { kind: "user" }>;
type AssistantItem = Extract<Item, { kind: "assistant" }>;

/**
 * One conversation with the model on a chat site, and the loop that drives it.
 *
 * `send` runs a turn: the user's text goes to the chat, each reply is scanned
 * for tool calls, the calls run through the registry (sandbox, approval, audit),
 * the results go back, and this repeats until a reply has no call in it. That
 * reply is the answer. `retry` resends the message that failed; `restart`
 * sends the whole request again from the beginning.
 *
 * Emits `change` on every visible change, which the UI streams.
 */
export class Session extends EventEmitter {
  items: Item[] = [];
  busy = false;
  status: Status = { phase: "idle", detail: "" };

  readonly #deps: SessionDeps;
  #abort: AbortController | null = null;
  #primedUrl: string | null = null;
  #newChat = false;
  #nextId = 1;
  #turn: UserItem | null = null;
  /** The message to send again after a failure, or null. */
  #retryMessage: string | null = null;

  constructor(deps: SessionDeps) {
    super();
    this.#deps = deps;
  }

  /** Times the current request has been sent. */
  get attempts(): number {
    return this.#turn?.sends ?? 0;
  }

  /** Whether the last run failed and its message can be sent again. */
  get canRetry(): boolean {
    return !this.busy && this.#retryMessage !== null;
  }

  /** Whether the latest request can be sent again from the beginning. */
  get canRestart(): boolean {
    return !this.busy && this.#turn !== null && this.#deps.tools() !== null;
  }

  /** Forget this conversation; the next message opens a new chat on the site. */
  newChat(): void {
    if (this.busy) throw new Error("stop the current run first");
    this.items = [];
    this.#turn = null;
    this.#retryMessage = null;
    this.#primedUrl = null;
    this.#newChat = true;
    this.#setStatus("idle");
  }

  stop(): void {
    this.#abort?.abort();
    this.#deps.cancelApprovals();
  }

  async send(text: string): Promise<void> {
    if (this.busy) throw new Error("a run is already in progress");
    if (text.trim() === "") return;

    const turn = (this.#turn?.turn ?? 0) + 1;
    this.#retryMessage = null;
    this.#turn = this.#push({ kind: "user", turn, text, sends: 1 });
    if (this.#deps.tools() === null) {
      this.#push({ kind: "notice", turn, level: "error", text: "اول پوشه‌ی کاری را انتخاب کنید." });
      return;
    }
    await this.#loop(text);
  }

  /** Send the message that failed again, and carry on from there. */
  async retry(): Promise<void> {
    if (this.busy) throw new Error("a run is already in progress");
    const message = this.#retryMessage;
    if (message === null || this.#turn === null) throw new Error("nothing to retry");
    this.#turn.sends++;
    this.#note("info", `تلاش دوباره، ارسال ${this.#turn.sends}`);
    await this.#loop(message);
  }

  /** Send the latest request again from the beginning. */
  async restart(): Promise<void> {
    if (this.busy) throw new Error("a run is already in progress");
    if (this.#turn === null) throw new Error("nothing to send again");
    this.#turn.sends++;
    this.#note("info", `ارسال دوباره‌ی درخواست از اول، ارسال ${this.#turn.sends}`);
    await this.#loop(this.#turn.text);
  }

  async #loop(first: string): Promise<void> {
    const tools = this.#deps.tools();
    const turnItem = this.#turn;
    if (tools === null || turnItem === null) return;
    const turn = turnItem.turn;

    this.busy = true;
    this.#retryMessage = null;
    for (const item of this.items) if (item.kind === "notice" && item.retry) item.retry = false;
    const abort = new AbortController();
    this.#abort = abort;
    this.#setStatus("sending");

    const known = new Set(tools.list.map((t) => t.name));
    // Only the folder name goes to the chat site, not the full path with the user name in it.
    const primer = buildPrimer(tools.list, basename(tools.workspace));
    const { maxSteps, maxChars } = this.#deps.limits();
    let message = first;
    // A tool batch in progress: if the run stops halfway, the model still has
    // to hear what ran, or a retry would run it all again.
    let batch: { calls: ToolCall[]; results: CallResult[] } | null = null;
    let parseErrorsInRow = 0;
    let autoRetries = 0;
    let current: AssistantItem | null = null;

    try {
      for (let step = 1; ; step++) {
        if (step > maxSteps) {
          // The last results have not been sent yet; "تلاش دوباره" sends them and carries on.
          this.#retryMessage = message;
          this.#push({ kind: "notice", turn, level: "info", text: `بعد از ${maxSteps} گام متوقف شد. برای ادامه «تلاش دوباره» را بزنید.`, retry: true });
          this.#setStatus("done", `بعد از ${maxSteps} گام`);
          return;
        }

        current = this.#push({ kind: "assistant", turn, text: "", streaming: true });
        const item = current;
        let reply: Reply;
        try {
          reply = await this.#deps.ask(message, {
            newChat: this.#newChat,
            primer,
            primedUrl: this.#primedUrl,
            signal: abort.signal,
            onStatus: (phase) => this.#setStatus(phase),
            onProgress: (partial) => {
              item.text = partial;
              if (partial !== "" && this.status.phase !== "receiving") this.#setStatus("receiving");
              else this.#changed();
            },
          });
        } catch (error) {
          // Nothing reached the site, so sending again cannot duplicate it.
          if (error instanceof LinkError && NOT_SENT.has(error.code) && autoRetries < AUTO_RETRIES && !abort.signal.aborted) {
            autoRetries++;
            turnItem.sends++;
            this.items = this.items.filter((i) => i !== item);
            current = null;
            this.#note("info", `ارسال نشد (${error.message}). تلاش دوباره، ارسال ${turnItem.sends}`);
            this.#setStatus("retrying", `ارسال ${turnItem.sends}`);
            await sleepUnlessAborted(AUTO_RETRY_DELAY_MS, abort.signal);
            step--;
            continue;
          }
          throw error;
        }
        autoRetries = 0;
        this.#newChat = false;
        this.#primedUrl = conversationKey(reply.url);
        item.text = reply.text;
        item.streaming = false;
        current = null;
        this.#changed();

        const { calls, errors } = parseCalls(reply.text, known);
        if (calls.length === 0 && errors.length === 0) {
          this.#setStatus("done");
          break;
        }

        if (calls.length === 0) {
          if (++parseErrorsInRow >= MAX_PARSE_ERRORS_IN_ROW) {
            this.#note("error", `مدل چند بار پشت سر هم فراخوانی خراب نوشت: ${errors.join("; ")}`);
            this.#setStatus("error", "فراخوانی خراب");
            break;
          }
          this.#note("info", `فراخوانی ابزار خراب بود؛ از مدل خواستم درستش کند. (${errors.join("; ")})`);
          message = formatParseErrors(errors);
          this.#setStatus("sending");
          continue;
        }
        parseErrorsInRow = 0;

        const results: CallResult[] = [];
        batch = { calls, results };
        for (const call of calls) {
          if (abort.signal.aborted) throw new LinkError("cancelled", "stopped");
          this.#setStatus("tool", call.tool);
          results.push(await this.#run(tools, call, turn, abort.signal));
        }
        if (abort.signal.aborted) throw new LinkError("cancelled", "stopped");
        for (const error of errors) results.push({ tool: "zx", summary: "invalid block", ok: false, text: error });
        message = formatResults(results, maxChars);
        batch = null;
        this.#setStatus("sending");
      }
    } catch (error) {
      if (current !== null) {
        current.streaming = false;
        if (error instanceof LinkError && error.partial) current.text = error.partial;
        if (current.text === "") this.items = this.items.filter((i) => i !== current);
      }
      this.#retryMessage =
        batch === null
          ? message
          : formatResults(
              [
                ...batch.results,
                ...batch.calls.slice(batch.results.length).map((call) => ({ tool: call.tool, summary: shortArgs(call), ok: false, text: "not run: the user stopped the run" })),
              ],
              maxChars,
            );
      const cancelled = (error instanceof LinkError && error.code === "cancelled") || abort.signal.aborted;
      this.#push({
        kind: "notice",
        turn,
        level: cancelled ? "info" : "error",
        text: cancelled ? "متوقف شد." : describe(error),
        retry: true,
      });
      this.#setStatus(cancelled ? "stopped" : "error", cancelled ? "" : failureLabel(error));
    } finally {
      this.busy = false;
      this.#abort = null;
      this.#changed();
    }
  }

  async #run(tools: Tools, call: ToolCall, turn: number, signal: AbortSignal): Promise<CallResult> {
    const item = this.#push({
      kind: "tool",
      turn,
      tool: call.tool,
      args: call.arguments,
      status: "running",
      summary: call.tool,
      output: "",
    });

    // A write's before and after, so the UI can show what changed.
    const writes = tools.list.find((t) => t.name === call.tool)?.opClass === "write";
    const path = typeof call.arguments.file_path === "string" ? call.arguments.file_path : null;
    const before = writes && path !== null ? tools.peek(path) : null;

    let result: CallResult;
    try {
      const done = await tools.registry.call(call.tool, call.arguments, { signal });
      const text = renderData(done.data, done.summary);
      result = { tool: call.tool, summary: done.summary, ok: true, text };
      item.status = "ok";
      item.summary = done.summary;
      item.output = preview(text);
      if (writes && path !== null) {
        const after = tools.peek(path);
        if (after !== null) item.change = fileDiff(path, before, after);
      }
    } catch (error) {
      const text = error instanceof ZxError ? `${error.code}: ${error.message}` : String(error);
      result = { tool: call.tool, summary: shortArgs(call), ok: false, text };
      item.status = "error";
      item.summary = shortArgs(call);
      item.output = preview(text);
    }
    this.#changed();
    return result;
  }

  #note(level: "info" | "error", text: string): void {
    this.#push({ kind: "notice", turn: this.#turn?.turn ?? 0, level, text });
  }

  #setStatus(phase: Status["phase"], detail = ""): void {
    this.status = { phase, detail };
    this.#changed();
  }

  #push<K extends Item["kind"]>(item: Omit<Extract<Item, { kind: K }>, "id"> & { kind: K }): Extract<Item, { kind: K }> {
    const full = { ...item, id: this.#nextId++ } as Extract<Item, { kind: K }>;
    this.items.push(full);
    this.#changed();
    return full;
  }

  #changed(): void {
    this.emit("change");
  }
}

function preview(text: string): string {
  return text.length <= PREVIEW_CHARS ? text : `${text.slice(0, PREVIEW_CHARS)}\n… (${text.length - PREVIEW_CHARS} more characters)`;
}

function shortArgs(call: ToolCall): string {
  const args = JSON.stringify(call.arguments);
  return `${call.tool} ${args.length > 120 ? `${args.slice(0, 120)}…` : args}`;
}

function failureLabel(error: unknown): string {
  if (!(error instanceof LinkError)) return "خطا";
  const labels: Partial<Record<LinkError["code"], string>> = {
    disconnected: "افزونه وصل نیست",
    "no-permission": "اجازه‌ی سایت نیست",
    "no-composer": "جعبه‌ی پیام پیدا نشد",
    "send-failed": "خطا در ارسال",
    "no-reply": "پاسخی نیامد",
    timeout: "پاسخ طول کشید",
    "page-lost": "تب چت از دست رفت",
  };
  return labels[error.code] ?? "خطا";
}

function describe(error: unknown): string {
  if (error instanceof LinkError) {
    const hints: Partial<Record<LinkError["code"], string>> = {
      disconnected: "Chrome را باز کنید و مطمئن شوید افزونه‌ی ZX AI روشن است.",
      "no-permission": "در صفحه‌ی تنظیمات افزونه به این سایت اجازه بدهید.",
      "no-composer": "سایت چت را باز کنید و وارد شوید، بعد در تنظیمات «بررسی سایت» را بزنید.",
      "send-failed": "پیام نوشته شد ولی ارسال نشد. در تنظیمات «بررسی سایت» را بزنید تا دکمه‌ی ارسال پیدا شود.",
      "no-reply": "پاسخی نیامد. شاید سایت ورود یا تأیید می‌خواهد.",
      timeout: "پاسخ بیش از حد طول کشید.",
      "page-lost": "تب چت وسط پاسخ بسته یا دوباره بارگذاری شد.",
    };
    return `${error.message}. ${hints[error.code] ?? ""}`.trim();
  }
  return error instanceof Error ? error.message : String(error);
}

function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

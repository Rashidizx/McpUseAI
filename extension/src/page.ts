import { conversationKey, type FailCode, type ProbeReport, type Site } from "../../src/shared/protocol.js";
import { newWatch, step, type Watch } from "./settle.js";

/**
 * Runs inside the chat tab, injected by the service worker on demand.
 *
 * It holds no secret and talks to nothing: the service worker calls `start`
 * once per message and then `tick` until the reply is finished. Polling from
 * the service worker, instead of timers here, keeps working when the chat tab
 * is in the background and the page's own timers are throttled.
 */

export type StartResult = { ok: true } | { ok: false; code: FailCode; message: string };
export type TickResult =
  | { state: "running"; text: string; hidden?: boolean }
  | { state: "done"; text: string; url: string }
  | { state: "failed"; code: FailCode; message: string; text?: string };

type Api = {
  prepare(site: Site, text: string): Promise<StartResult>;
  submit(): Promise<StartResult>;
  start(site: Site, text: string): Promise<StartResult>;
  tick(): TickResult;
  stop(): void;
  probe(site: Site): ProbeReport;
};

type State = {
  site: Site | null;
  watch: Watch | null;
  pending: { box: HTMLElement; text: string; before: Baseline } | null;
  baseline: Baseline | null;
  sendControl: { el: HTMLElement; icon: string } | null;
  /** Once the new reply has appeared it stays new; no need to compare again. */
  fresh: boolean;
  /** The conversation the reply belongs to, once the site has settled its address. */
  chat: string | null;
};
/**
 * State of the reply being watched, kept on the page rather than in this
 * script: the script is injected again for every message and every "check
 * site", and a fresh copy must not wipe a reply that is still in progress.
 */
const S: State = ((globalThis as unknown as { __zxState?: State }).__zxState ??= {
  site: null,
  watch: null,
  pending: null,
  baseline: null,
  sendControl: null,
  fresh: false,
  chat: null,
});
type Baseline = { last: Element | null; text: string };

/** The newest reply right now, to compare against after sending. */
function newest(s: Site): Baseline {
  const last = findAll(s.reply).list.at(-1) ?? null;
  return { last, text: last === null ? "" : extract(last) };
}

/** Whether the newest reply is a different one from `before`. */
function isFresh(s: Site, before: Baseline, last: Element | undefined = findAll(s.reply).list.at(-1)): boolean {
  if (last === undefined || last === before.last) return false;
  if (before.last === null || before.last.isConnected) return true;
  // The old reply was unmounted (virtualized lists): only the text can tell.
  return extract(last) !== before.text;
}
/**
 * The send control and its icon at the moment of sending. Many sites turn
 * that same control into a stop button while the model writes, so a changed
 * icon means "still writing" even when no stop selector matches.
 */

const sleep = (ms: number): Promise<void> => {
  if (!document.hidden) return new Promise((resolve) => setTimeout(resolve, ms));
  // A background tab's timers fire at most once a second (once a minute after
  // a while); message events are not throttled.
  const end = performance.now() + ms;
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      if (performance.now() >= end) {
        channel.port1.close();
        resolve();
      } else channel.port2.postMessage(0);
    };
    channel.port2.postMessage(0);
  });
};

function visible(el: Element): boolean {
  if (el.getClientRects().length === 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none";
}

/** First element of the first selector that has a visible match. */
function find(selectors: readonly string[]): { el: HTMLElement; selector: string } | null {
  for (const selector of selectors) {
    try {
      for (const el of document.querySelectorAll<HTMLElement>(selector)) {
        if (visible(el)) return { el, selector };
      }
    } catch {
      // A broken selector from settings must not stop the rest being tried.
    }
  }
  return null;
}

/** All matches of the first selector that matches anything. */
function findAll(selectors: readonly string[]): { list: Element[]; selector: string | null } {
  for (const selector of selectors) {
    try {
      const list = [...document.querySelectorAll(selector)];
      if (list.length > 0) return { list, selector };
    } catch {
      continue;
    }
  }
  return { list: [], selector: null };
}

function editable(el: HTMLElement): boolean {
  return el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement || el.isContentEditable;
}

function composer(s: Site): HTMLElement | null {
  const hit = find(s.composer);
  return hit !== null && editable(hit.el) ? hit.el : null;
}

function composerText(el: HTMLElement | null): string {
  if (el === null) return "";
  return (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement ? el.value : el.innerText).trim();
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

function holds(el: HTMLElement, text: string): boolean {
  const have = squash(composerText(el));
  const want = squash(text);
  return have.includes(want.slice(0, 40)) && have.includes(want.slice(-40));
}

/**
 * Put text in the composer so the site's framework sees it.
 *
 * Setting `value` or `textContent` directly changes the DOM but not the
 * framework's state, so the site sends nothing. A textarea gets the native
 * setter plus an input event (what React listens to); a rich editor gets a
 * paste event first (ProseMirror reads its clipboardData) and
 * `execCommand('insertText')` as the fallback (native editing, which every
 * editor observes).
 */
async function typeInto(el: HTMLElement, text: string): Promise<boolean> {
  el.focus();
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(50);
    return holds(el, text);
  }

  const selectAll = () => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  };

  selectAll();
  const data = new DataTransfer();
  data.setData("text/plain", text);
  el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  await sleep(150);
  if (holds(el, text)) return true;

  selectAll();
  document.execCommand("insertText", false, text);
  await sleep(150);
  return holds(el, text);
}

const BUTTONISH = "button, [role='button']";

function enabled(el: HTMLElement): boolean {
  return !(el as HTMLButtonElement).disabled && el.getAttribute("aria-disabled") !== "true";
}

/**
 * A switch, not an action: "DeepThink", "Search", a model picker. Clicking one
 * of these instead of send flips a setting and sends nothing, which is the
 * failure this check exists for.
 */
function isToggle(el: HTMLElement): boolean {
  return (
    el.hasAttribute("aria-pressed") ||
    el.hasAttribute("aria-checked") ||
    el.hasAttribute("aria-haspopup") ||
    el.getAttribute("role") === "switch" ||
    el.getAttribute("role") === "checkbox" ||
    el.querySelector("input[type='file']") !== null ||
    (el.textContent ?? "").trim().length > 2
  );
}

/** Clickable things in the composer's own area, nearest container first. */
function buttonsNear(box: HTMLElement): HTMLElement[] {
  let container: HTMLElement | null = box.parentElement;
  for (let depth = 0; container !== null && depth < 6; depth++, container = container.parentElement) {
    const found = [...container.querySelectorAll<HTMLElement>(BUTTONISH)].filter((el) => !el.contains(box) && visible(el));
    if (found.length > 0) return found;
  }
  return [];
}

function describeButton(el: HTMLElement) {
  return {
    tag: el.tagName.toLowerCase(),
    label: el.getAttribute("aria-label") ?? el.getAttribute("title") ?? (el.textContent ?? "").trim().slice(0, 30),
    testid: el.getAttribute("data-testid"),
    classes: [...el.classList].slice(0, 3).join(" "),
    enabled: enabled(el),
    toggle: isToggle(el),
    svg: el.querySelector("svg") !== null,
  };
}

function pressEnter(box: HTMLElement): void {
  box.focus();
  for (const type of ["keydown", "keypress", "keyup"]) {
    box.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
  }
}

/**
 * Send the typed message, and prove it left.
 *
 * Proof is any of: the composer emptied, a new reply appeared, or the site
 * shows its "stop" control. Each way of sending is tried only while no proof
 * exists, so the message is never sent twice: first the site's configured
 * send button, then Enter, then the last plain icon button beside the
 * composer. Toggles are never clicked.
 */
async function send(s: Site, box: HTMLElement, text: string, before: Baseline): Promise<{ ok: boolean; tried: string[] }> {
  const tried: string[] = [];
  const startUrl = location.href;
  const left = () => {
    const now = composer(s);
    return (
      location.href !== startUrl ||
      (now !== null && !holds(now, text)) ||
      (now === box && !holds(box, text)) ||
      isFresh(s, before) ||
      busy(s)
    );
  };
  const confirm = async () => {
    for (let i = 0; i < 12; i++) {
      await sleep(250);
      if (left()) return true;
    }
    return false;
  };

  // The configured button, given a moment to become enabled after typing.
  for (let i = 0; i < 10; i++) {
    const button = s.send
      .flatMap((selector) => {
        try {
          return [...document.querySelectorAll<HTMLElement>(selector)];
        } catch {
          return [];
        }
      })
      .find((el) => visible(el) && enabled(el) && !isToggle(el));
    if (button !== undefined) {
      tried.push("send button");
      button.click();
      if (await confirm()) return { ok: true, tried };
      break;
    }
    await sleep(200);
  }

  tried.push("Enter");
  pressEnter(box);
  if (await confirm()) return { ok: true, tried };

  const icon = buttonsNear(box).filter((el) => enabled(el) && !isToggle(el) && el.querySelector("svg") !== null).at(-1);
  if (icon !== undefined) {
    tried.push(`icon button "${describeButton(icon).label || describeButton(icon).classes}"`);
    icon.click();
    if (await confirm()) return { ok: true, tried };
  }
  return { ok: false, tried };
}

function busy(s: Site): boolean {
  if (find(s.stop) !== null) return true;
  return S.sendControl !== null && S.sendControl.el.isConnected && visible(S.sendControl.el) && S.sendControl.el.innerHTML !== S.sendControl.icon;
}

const SKIP = new Set(["BUTTON", "SVG", "STYLE", "SCRIPT", "NOSCRIPT", "TEMPLATE"]);
const BLOCK = new Set(["P", "DIV", "LI", "UL", "OL", "H1", "H2", "H3", "H4", "H5", "H6", "TABLE", "TR", "BLOCKQUOTE", "SECTION", "ARTICLE", "HR"]);

/** Words a code block header shows that are controls, not a language. */
const HEADER_WORDS = new Set(["copy", "code", "download", "run", "edit", "content_copy", "preview", "expand", "collapse"]);

/** The language of a code block: from its class, or a "zx" label rendered beside it. */
function language(pre: Element): string {
  const code = pre.querySelector("code") ?? pre;
  const tagged = /language-([\w+#.-]+)/.exec(`${code.className} ${pre.className}`);
  if (tagged) return tagged[1]!.toLowerCase();
  let container: Element | null = pre.parentElement;
  for (let depth = 0; container !== null && depth < 3; depth++, container = container.parentElement) {
    // Stop at a container shared with another code block: its label belongs to that block.
    if (container.querySelectorAll("pre").length > 1) break;
    // The block's own header: the first short word that is not a button label.
    for (const el of container.querySelectorAll("*")) {
      if (pre.contains(el) || el.children.length > 0 || el.closest("button, [role='button']")) continue;
      const word = (el.textContent ?? "").trim().toLowerCase();
      if (/^[a-z0-9+#.-]{1,15}$/.test(word) && !HEADER_WORDS.has(word)) return word;
    }
  }
  return "";
}

/**
 * The reply as text, with code blocks turned back into fences.
 *
 * Rendering throws the markdown away, and the fences are what the bridge
 * looks for, so each `<pre>` is written back as a fenced block with its
 * language. Buttons ("Copy code") are skipped.
 */
function extract(root: Element): string {
  let out = "";
  const newline = () => {
    if (out !== "" && !out.endsWith("\n")) out += "\n";
  };
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.nodeValue ?? "";
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tag = el.tagName.toUpperCase();
    if (SKIP.has(tag) || el.getAttribute("role") === "button" || el.hasAttribute("data-message-attribution") || el.classList.contains("sr-only")) return;
    if (tag === "BR") {
      out += "\n";
      return;
    }
    // KaTeX draws each formula twice (MathML for readers, HTML for the eye): keep the TeX once.
    if (el.classList.contains("katex-html")) return;
    if (el.classList.contains("katex-mathml")) {
      const tex = el.querySelector("annotation")?.textContent;
      if (tex) out += el.closest(".katex-display") ? `\n$$${tex}$$\n` : `$${tex}$`;
      return;
    }
    if (tag === "CODE" && el.closest("pre") === null) {
      out += "`" + (el.textContent ?? "") + "`";
      return;
    }
    if (tag === "LI") {
      newline();
      const parent = el.parentElement;
      out += parent?.tagName === "OL" ? `${[...parent.children].indexOf(el) + ((parent as HTMLOListElement).start || 1)}. ` : "- ";
      for (const child of el.childNodes) walk(child);
      newline();
      return;
    }
    if ((tag === "TD" || tag === "TH") && el.previousElementSibling !== null) out += " | ";
    if (tag === "PRE") {
      const body = ((el.querySelector("code") ?? el).textContent ?? "").replace(/\n$/, "");
      const lang = language(el);
      newline();
      // The code block's own header (its language, "Copy", "Download") was
      // just written as text; it belongs to the page, not to the reply.
      const chrome = new Set([lang, "copy", "copy code", "download", "run", "edit", "کپی"]);
      const lines = out.split("\n");
      for (let i = 0; i < 4 && lines.length > 1 && chrome.has((lines[lines.length - 2] ?? "").trim().toLowerCase()); i++) {
        lines.splice(lines.length - 2, 1);
      }
      out = lines.join("\n");
      // A fence longer than any backtick run inside, so a file holding ``` stays whole.
      const fence = "`".repeat(Math.max(3, ...(body.match(/`+/g) ?? []).map((run) => run.length + 1)));
      out += fence + lang + "\n" + body + "\n" + fence + "\n";
      return;
    }
    const block = BLOCK.has(tag);
    if (block) newline();
    for (const child of el.childNodes) walk(child);
    if (block) newline();
  };
  walk(root);
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/** Visible text of the conversation column: around the last reply, else around the composer. */
function conversationText(s: Site): string {
  const anchor = findAll(s.reply).list.at(-1) ?? composer(s);
  let el: Element | null = anchor ?? null;
  for (let i = 0; el !== null && i < 3; i++) el = el.parentElement;
  return el instanceof HTMLElement ? el.innerText : "";
}

/** A compact name for an element: tag, id, role, data attributes and a few classes. */
function label(el: Element): string {
  const data = [...el.attributes].filter((a) => a.name.startsWith("data-")).map((a) => `[${a.name}${a.value.length < 20 ? `="${a.value}"` : ""}]`).join("");
  const role = el.getAttribute("role") ? `[role="${el.getAttribute("role")}"]` : "";
  const classes = [...el.classList].slice(0, 4).map((c) => `.${c}`).join("");
  return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${classes}${role}${data}`;
}

/** For each innermost element containing `needle`, its trail up to <body>. */
function whereIs(needle: string): string[][] {
  const hits: Element[] = [];
  for (const el of document.body.querySelectorAll("*")) {
    if (!(el.textContent ?? "").includes(needle)) continue;
    if ([...el.children].some((child) => (child.textContent ?? "").includes(needle))) continue;
    hits.push(el);
    if (hits.length >= 5) break;
  }
  return hits.map((hit) => {
    const trail: string[] = [];
    for (let el: Element | null = hit; el !== null && el !== document.body && trail.length < 12; el = el.parentElement) trail.push(label(el));
    return trail;
  });
}

/** The reply's last code block is JSON that has not been closed yet. */
function cutOff(reply: Element): boolean {
  const blocks = reply.querySelectorAll("pre");
  const code = (blocks[blocks.length - 1]?.textContent ?? "").trim();
  if (!/^[\[{]/.test(code)) return false;
  return !/[\]}]$/.test(code);
}

async function waitFor<T>(get: () => T | null, ms: number): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const value = get();
    if (value !== null || Date.now() > end) return value;
    await sleep(250);
  }
}

const api: Api = {
  async start(s, text) {
    const typed = await api.prepare(s, text);
    return typed.ok ? api.submit() : typed;
  },

  async prepare(s, text) {
    S.site = s;
    S.watch = null;
    S.pending = null;
    const box = await waitFor(() => composer(s), 20_000);
    if (box === null) {
      const check = /just a moment|attention required|verify|captcha|log ?in|sign ?in/i.test(document.title);
      return {
        ok: false,
        code: "no-composer",
        message: check
          ? `${s.label} is asking for a sign-in or a human check ("${document.title}"); open its tab and finish it`
          : `could not find the ${s.label} message box (signed out?)`,
      };
    }

    const before = newest(s);
    if (!(await typeInto(box, text))) {
      return { ok: false, code: "no-composer", message: `could not type into the ${s.label} message box` };
    }
    S.pending = { box, text, before };
    return { ok: true };
  },

  async submit() {
    const s = S.site;
    if (s === null || S.pending === null) return { ok: false, code: "page-lost", message: "the chat page was reloaded" };
    const { box, text, before } = S.pending;
    S.pending = null;
    await sleep(250);
    const control = find(s.send)?.el ?? null;
    S.sendControl = control === null ? null : { el: control, icon: control.innerHTML };
    const sent = await send(s, box, text, before);
    if (!sent.ok) {
      return {
        ok: false,
        code: "send-failed",
        message: `typed into ${s.label} but it would not send (tried: ${sent.tried.join(", ")})`,
      };
    }
    S.baseline = before;
    S.fresh = false;
    S.chat = null;
    S.watch = newWatch(Date.now());
    return { ok: true };
  },

  tick() {
    if (S.site === null || S.watch === null) return { state: "failed", code: "page-lost", message: "the chat page was reloaded" };
    // Run the animation frames a background tab is not given (awake.ts).
    document.dispatchEvent(new Event("zx-wake"));
    const last = findAll(S.site.reply).list.at(-1);
    S.fresh ||= S.baseline !== null && isFresh(S.site, S.baseline, last);
    if (S.fresh) {
      // The address settles (/ to /c/id) once the reply has started; after that
      // a different conversation means the user went elsewhere.
      const chat = conversationKey(location.href);
      // A start page ("/", "/new", "/app") turns into the conversation's own
      // address once; only a move after that is the user's.
      const home = (url: string) => new URL(url).pathname.split("/").filter(Boolean).length <= 1;
      if (S.chat === null || (S.chat !== chat && home(S.chat) && !home(chat))) S.chat = chat;
      if (chat !== S.chat) {
        S.watch = null;
        return { state: "failed", code: "page-lost", message: "the chat tab moved to another conversation" };
      }
    }
    const verdict = step(S.watch, {
      now: Date.now(),
      fresh: S.fresh,
      text: last === undefined ? "" : extract(last),
      busy: busy(S.site),
      composerHasText: composerText(composer(S.site)) !== "",
      incomplete: last !== undefined && cutOff(last),
      hidden: document.hidden,
    });
    if (verdict.state === "done") {
      S.watch = null;
      return { state: "done", text: verdict.text, url: location.href };
    }
    if (verdict.state === "failed") return { ...verdict, text: S.watch.lastText };
    return { ...verdict, hidden: document.hidden };
  },

  stop() {
    if (S.site !== null) find(S.site.stop)?.el.click();
    S.watch = null;
  },

  probe(s) {
    const needle = (s as Site & { needle?: string }).needle;
    return {
      found: needle ? whereIs(needle) : undefined,
      tail: conversationText(s).slice(-1500),
      url: location.href,
      composer: find(s.composer)?.selector ?? null,
      send: find(s.send)?.selector ?? null,
      stop: find(s.stop)?.selector ?? null,
      reply: findAll(s.reply).selector,
      replies: findAll(s.reply).list.length,
      buttons: (() => {
        const box = composer(s);
        return box === null ? [] : buttonsNear(box).map(describeButton);
      })(),
    };
  },
};

(globalThis as unknown as { __zx: Api }).__zx = api;

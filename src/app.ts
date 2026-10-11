import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { VERSION } from "./shared/version.js";
import { ApprovalGate, type ApprovalDecision, type ApprovalPrompt, type OperationClass } from "./core/approval-gate.js";
import { ApprovalQueue, type PendingApproval } from "./core/approval-queue.js";
import { AuditLog, type AuditEntry } from "./core/audit-log.js";
import { PathGuard } from "./core/path-guard.js";
import { ToolRegistry } from "./core/tool-registry.js";
import { createExec } from "./tools/exec.js";
import { createFsApplyDiff } from "./tools/fs-apply-diff.js";
import { createFsGrep } from "./tools/fs-grep.js";
import { createFsList } from "./tools/fs-list.js";
import { createFsRead } from "./tools/fs-read.js";
import { createFsWrite } from "./tools/fs-write.js";
import { ExtensionLink } from "./agent/link.js";
import { Session, type Item, type Status, type Tools } from "./agent/session.js";
import { fileDiff, type FileDiff } from "./agent/diff.js";
import { isCompleteSite, mergeSites } from "./agent/sites.js";
import type { ProbeReport, Site } from "./shared/protocol.js";

/**
 * How approvals are handled:
 *   ask       every write and every program run waits for the user (default)
 *   edits     file writes go ahead; running programs still asks
 *   all       nothing asks
 *   readonly  every write and run is refused without asking; reads still work
 */
export type Mode = "ask" | "edits" | "all" | "readonly";
const MODES: readonly Mode[] = ["ask", "edits", "all", "readonly"];

export type Settings = {
  workspace: string | null;
  siteId: string;
  mode: Mode;
  maxSteps: number;
  maxChars: number;
  /** Per-site overrides; an unknown id adds a site. */
  sites: Record<string, Partial<Site>>;
};

const DEFAULTS: Settings = {
  workspace: null,
  siteId: "chatgpt",
  mode: "ask",
  maxSteps: 25,
  maxChars: 30_000,
  sites: {},
};

export type AppState = {
  version: string;
  workspace: string | null;
  siteId: string;
  sites: Site[];
  extension: {
    connected: boolean;
    reconnecting: boolean;
    version: string | null;
    current: boolean;
    log: string[];
    /** The connected browser, and another one with ZX enabled that was turned away. */
    browser: string | null;
    rival: string | null;
  };
  busy: boolean;
  status: Status;
  canRetry: boolean;
  canRestart: boolean;
  attempts: number;
  items: Item[];
  /** Waiting approvals; a file write carries the change it would make. */
  pending: (PendingApproval & { diff?: FileDiff })[];
  settings: Pick<Settings, "mode" | "maxSteps" | "maxChars">;
  /** Tools the user allowed for the rest of this chat. */
  allowed: string[];
};

/** Where settings and the audit log live: outside every workspace. */
export function stateDir(): string {
  const base =
    process.platform === "win32"
      ? (process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"))
      : (process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"));
  return join(base, "zx-ai");
}

/**
 * The whole bridge minus HTTP.
 *
 * Owns the settings, the chosen workspace and its tools, the approval queue,
 * the audit log, the extension link and the conversation. Emits `change`
 * whenever anything the UI shows has changed.
 */
export class App extends EventEmitter {
  readonly audit: AuditLog;
  readonly queue = new ApprovalQueue();
  readonly link = new ExtensionLink(extensionBuildOnDisk);
  readonly session: Session;

  readonly #settingsPath: string;
  readonly #stateDir: string;
  #settings: Settings;
  #tools: Tools | null = null;
  /** Tools allowed "always" for the current chat; cleared by a new chat. */
  readonly #allowed = new Set<string>();
  readonly #previews = new Map<string, FileDiff | null>();

  constructor(options: { stateDir: string; workspace?: string | undefined }) {
    super();
    this.#stateDir = options.stateDir;
    mkdirSync(this.#stateDir, { recursive: true });
    this.#settingsPath = join(this.#stateDir, "settings.json");
    this.#settings = loadSettings(this.#settingsPath);
    this.audit = new AuditLog(join(this.#stateDir, "audit.db"));

    this.session = new Session({
      ask: (text, opts) => this.link.ask(this.site(), text, opts),
      tools: () => this.#tools,
      limits: () => ({ maxSteps: this.#settings.maxSteps, maxChars: this.#settings.maxChars }),
      cancelApprovals: () => this.queue.rejectAll("stopped"),
    });

    const changed = () => this.emit("change");
    this.session.on("change", changed);
    this.link.on("change", changed);
    this.link.on("log", (line: string) => console.log(`[extension] ${line}`));
    this.queue.subscribe(changed);

    const initial = options.workspace ?? this.#settings.workspace;
    if (initial !== null) {
      try {
        this.setWorkspace(initial);
      } catch (error) {
        // A folder that has since been moved is not fatal; the UI asks for another.
        if (options.workspace !== undefined) throw error;
      }
    }
  }

  state(): AppState {
    return {
      version: VERSION,
      workspace: this.#tools?.workspace ?? null,
      siteId: this.site().id,
      sites: this.sites(),
      extension: {
        connected: this.link.connected,
        reconnecting: this.link.reconnecting,
        version: this.link.version,
        current: this.link.current,
        log: this.link.log,
        browser: this.link.browser,
        rival: this.link.rival,
      },
      busy: this.session.busy,
      // A run blocked on the user says so, whatever the loop last reported.
      status: this.queue.pending().length > 0 ? ({ phase: "approval", detail: "" } satisfies Status) : this.session.status,
      canRetry: this.session.canRetry,
      canRestart: this.session.canRestart,
      attempts: this.session.attempts,
      items: this.session.items.map((item) => (item.kind === "tool" ? { ...item, args: slimArgs(item.args) } : item)),
      pending: this.#withPreviews(),
      settings: {
        mode: this.#settings.mode,
        maxSteps: this.#settings.maxSteps,
        maxChars: this.#settings.maxChars,
      },
      allowed: [...this.#allowed],
    };
  }

  sites(): Site[] {
    return mergeSites(this.#settings.sites);
  }

  site(): Site {
    const all = this.sites();
    return all.find((s) => s.id === this.#settings.siteId) ?? all[0]!;
  }

  setWorkspace(candidate: string): void {
    if (this.session.busy) throw new Error("stop the current run first");
    const root = resolveWorkspaceRoot(candidate, this.#stateDir);
    const moved = this.#tools !== null && this.#tools.workspace !== root;
    this.#tools = buildTools(root, (prompt) => this.decide(prompt), this.audit);
    this.#save({ workspace: root });
    // The model was told the old folder, and "always" was given for it: start over.
    if (moved) this.newChat();
  }

  /** Apply a settings change from the UI. Validates everything it is given. */
  update(patch: Record<string, unknown>): void {
    // The approval mode may change mid-run (that is often when it is wanted);
    // everything else waits for the run to end.
    if (this.session.busy && Object.keys(patch).some((key) => key !== "mode")) throw new Error("stop the current run first");
    const next: Partial<Settings> = {};

    if (patch.mode !== undefined) {
      if (!MODES.includes(patch.mode as Mode)) throw new Error(`mode must be one of ${MODES.join(", ")}`);
      next.mode = patch.mode as Mode;
    }

    if (patch.siteId !== undefined) {
      if (!this.sites().some((s) => s.id === patch.siteId)) throw new Error(`unknown site: ${String(patch.siteId)}`);
      next.siteId = patch.siteId as string;
    }
    for (const [key, min, max] of [["maxSteps", 1, 200], ["maxChars", 2000, 200_000]] as const) {
      if (patch[key] === undefined) continue;
      const value = patch[key];
      if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
        throw new Error(`${key} must be a whole number from ${min} to ${max}`);
      }
      next[key] = value;
    }
    if (patch.site !== undefined) {
      // A whole site definition from the settings editor: an override of a
      // built-in, or a new site. Null removes the override.
      const { id, value } = patch.site as { id?: unknown; value?: unknown };
      if (typeof id !== "string" || !/^[a-z0-9-]{1,32}$/.test(id)) throw new Error("site id must be lowercase letters, digits or dashes");
      const sites = { ...this.#settings.sites };
      if (value === null) delete sites[id];
      else if (isCompleteSite({ ...(value as object), id })) sites[id] = { ...(value as Site), id };
      else throw new Error("the site needs https url, match, composer and reply selectors");
      next.sites = sites;
    }

    const siteChanged = next.siteId !== undefined && next.siteId !== this.#settings.siteId;
    this.#save(next);
    // Another site is another conversation; this one's history and permissions do not carry over.
    if (siteChanged) this.newChat();
    // Requests already waiting are settled by the new mode, as if they had just arrived.
    if (next.mode !== undefined) {
      for (const pending of this.queue.pending()) {
        const verdict = this.#byMode(pending);
        if (verdict !== null) this.queue.resolve(pending.id, verdict);
      }
    }
    this.emit("change");
  }

  send(text: string): void {
    // The run outlives the HTTP request. A rejection here would be unhandled
    // and take the process down, so it is caught; the session shows its own errors.
    this.session.send(text).catch(() => undefined);
  }

  restart(): void {
    if (!this.session.canRestart) throw new Error("nothing to send again");
    this.session.restart().catch(() => undefined);
  }

  retry(): void {
    if (!this.session.canRetry) throw new Error("nothing to retry");
    this.session.retry().catch(() => undefined);
  }

  /**
   * Decide an approval: by the mode, then by what the user allowed for this
   * chat, and otherwise by asking. Checked at each request, so a mode change
   * applies at once.
   */
  decide(prompt: ApprovalPrompt): Promise<ApprovalDecision> {
    const verdict = this.#byMode(prompt);
    if (verdict !== null) return Promise.resolve(verdict);
    if (this.#allowed.has(prompt.toolName)) return Promise.resolve("approved");
    return this.queue.request(prompt);
  }

  #byMode(prompt: { opClass: OperationClass }): ApprovalDecision | null {
    const mode = this.#settings.mode;
    if (mode === "readonly") return "denied";
    if (mode === "all") return "approved";
    if (mode === "edits" && prompt.opClass === "write") return "approved";
    return null;
  }

  /** Forget this conversation, and what was allowed during it. */
  newChat(): void {
    this.session.newChat();
    this.#allowed.clear();
    this.emit("change");
  }

  approve(id: string, decision: "approved" | "denied" | "always"): boolean {
    if (decision === "always") {
      const pending = this.queue.snapshot(id);
      if (pending === undefined) return false;
      this.#allowed.add(pending.toolName);
      return this.queue.resolve(id, "approved");
    }
    return this.queue.resolve(id, decision);
  }

  probe(needle?: string): Promise<ProbeReport> {
    return this.link.probe(needle ? ({ ...this.site(), needle } as Site) : this.site());
  }

  show(): void {
    this.link.show(this.site());
  }

  /** Show the workspace in Explorer (or the platform's file manager). */
  openFolder(): void {
    const root = this.#tools?.workspace;
    if (root === undefined) throw new Error("no folder chosen yet");
    const opener = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
    spawn(opener, [root], { detached: true, stdio: "ignore" }).on("error", () => undefined).unref();
  }

  /**
   * Open a workspace file with its default app, or show it in Explorer.
   *
   * Only inside the workspace (the path goes through the sandbox), and a file a
   * model could have written that would *run* when opened is only revealed,
   * never opened: one click on a .bat must not execute it.
   */
  openFile(path: string, reveal = false): void {
    if (this.#tools === null) throw new Error("no folder chosen yet");
    const real = this.#tools.resolve(path);
    const runs = /\.(exe|bat|cmd|com|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|msi|msp|scr|lnk|jar|reg|cpl|pif|application)$/i.test(real);
    if (process.platform === "win32") {
      const args = reveal || runs ? [`/select,${real}`] : [real];
      spawn("explorer.exe", args, { detached: true, stdio: "ignore" }).on("error", () => undefined).unref();
    } else {
      spawn(process.platform === "darwin" ? "open" : "xdg-open", [reveal || runs ? dirname(real) : real], { detached: true, stdio: "ignore" })
        .on("error", () => undefined)
        .unref();
    }
  }

  /** Ask for a folder with the system's own dialog, then switch to it. Windows only. */
  pickFolder(): Promise<string | null> {
    if (process.platform !== "win32") return Promise.reject(new Error("the folder dialog is only available on Windows; type the path in settings"));
    const script = [
      "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
      "Add-Type -AssemblyName System.Windows.Forms",
      "$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$dialog.Description = 'ZX AI - project folder'",
      // A PowerShell single-quoted string: only ' needs escaping (as ''); nothing in it runs.
      `$dialog.SelectedPath = '${(this.#tools?.workspace ?? "").replace(/'/g, "''")}'`,
      "if ($dialog.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($dialog.SelectedPath) }",
    ].join("; ");
    return new Promise((resolve, reject) => {
      execFile("powershell.exe", ["-NoProfile", "-STA", "-Command", script], { timeout: 10 * 60_000, windowsHide: true }, (error, stdout) => {
        if (error) return reject(new Error(`the folder dialog failed: ${error.message}`));
        const chosen = stdout.trim();
        if (chosen === "") return resolve(null);
        try {
          this.setWorkspace(chosen);
          resolve(this.#tools?.workspace ?? chosen);
        } catch (failure) {
          reject(failure);
        }
      });
    });
  }

  recentAudit(limit: number): AuditEntry[] {
    return this.audit.list(limit);
  }

  close(): void {
    this.session.stop();
    this.audit.close();
  }

  /** The diff each waiting write would make, computed once per request. */
  #withPreviews(): AppState["pending"] {
    const pending = this.queue.pending();
    for (const id of this.#previews.keys()) if (!pending.some((p) => p.id === id)) this.#previews.delete(id);
    return pending.map((p) => {
      if (!this.#previews.has(p.id)) this.#previews.set(p.id, this.#preview(p));
      const diff = this.#previews.get(p.id);
      return diff ? { ...p, diff } : p;
    });
  }

  #preview(p: PendingApproval): FileDiff | null {
    const args = p.arguments as Record<string, unknown>;
    const path = args.file_path;
    if (this.#tools === null || typeof path !== "string") return null;
    const before = this.#tools.peek(path);
    if (p.toolName === "fs_write" && typeof args.content === "string") return fileDiff(path, before, args.content);
    if (p.toolName === "fs_apply_diff" && before !== null && typeof args.old_text === "string" && typeof args.new_text === "string") {
      const parts = before.split(args.old_text);
      if (parts.length < 2) return null;
      const after = args.all === true ? parts.join(args.new_text) : parts[0] + args.new_text + parts.slice(1).join(args.old_text);
      return fileDiff(path, before, after);
    }
    return null;
  }

  #save(patch: Partial<Settings>): void {
    this.#settings = { ...this.#settings, ...patch };
    const temp = `${this.#settingsPath}.tmp`;
    writeFileSync(temp, JSON.stringify(this.#settings, null, 2));
    renameSync(temp, this.#settingsPath);
    this.emit("change");
  }
}

function buildTools(root: string, prompter: (prompt: ApprovalPrompt) => Promise<ApprovalDecision>, audit: AuditLog): Tools {
  const guard = new PathGuard(root);
  // Nothing is auto-approved by the gate itself: the prompter applies the mode.
  const gate = new ApprovalGate({ autoApprove: [], prompter });
  const registry = new ToolRegistry({ guard, gate, audit });
  registry.register(createFsRead(guard));
  registry.register(createFsList(guard));
  registry.register(createFsGrep(guard));
  registry.register(createFsWrite(guard));
  registry.register(createFsApplyDiff(guard));
  registry.register(createExec(guard));
  const peek = (path: string): string | null => {
    try {
      return readFileSync(guard.resolve(path), "utf8");
    } catch {
      return null;
    }
  };
  return { registry, list: registry.list(), workspace: root, peek, resolve: (path: string) => guard.resolve(path) };
}

/**
 * Validate and canonicalise a workspace folder.
 *
 * `realpath` so `C:\Users\MRRASH~1.E` and the long spelling are one folder. A
 * folder that contains the bridge's own state directory is refused: tools could
 * otherwise be asked to edit the settings that decide what needs approval. That
 * one rule also rules out a home folder or a drive root as a workspace.
 */
export function resolveWorkspaceRoot(candidate: string, stateDirectory: string): string {
  if (typeof candidate !== "string" || candidate.trim() === "") throw new Error("choose a folder");
  let real: string;
  try {
    real = realpathSync.native(resolve(candidate.trim()));
  } catch {
    throw new Error(`folder not found: ${candidate}`);
  }
  if (!statSync(real).isDirectory()) throw new Error(`not a folder: ${real}`);

  const state = realOrResolved(stateDirectory);
  const inside = relative(real, state);
  if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))) {
    throw new Error(`${real} contains the bridge's own settings (${state}); choose a project folder inside it instead`);
  }
  return real;
}

/**
 * The canonical spelling of a path that may not exist yet: the nearest existing
 * ancestor through `realpath`, plus the rest. Without this a short 8.3 name and
 * its long form would compare as different folders.
 */
function realOrResolved(path: string): string {
  const absolute = resolve(path);
  let existing = absolute;
  while (true) {
    try {
      return join(realpathSync.native(existing), relative(existing, absolute));
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return absolute;
      existing = parent;
    }
  }
}

/** The build id stamped into the built extension, or null when it is not built. */
function extensionBuildOnDisk(): string | null {
  try {
    const manifest = JSON.parse(readFileSync(new URL("../extension/dist/manifest.json", import.meta.url), "utf8"));
    return typeof manifest.version_name === "string" ? manifest.version_name : null;
  } catch {
    return null;
  }
}

/** The mode from settings, or from the older autoApprove list. */
function legacyMode(raw: Partial<Settings> & { autoApprove?: unknown }): Mode {
  if (MODES.includes(raw.mode as Mode)) return raw.mode as Mode;
  const old = Array.isArray(raw.autoApprove) ? raw.autoApprove : [];
  return old.includes("exec") ? "all" : old.includes("write") ? "edits" : "ask";
}

function loadSettings(path: string): Settings {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { ...DEFAULTS };
  }
  try {
    const raw = JSON.parse(text) as Partial<Settings>;
    const whole = (v: unknown, fallback: number) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : fallback);
    return {
      workspace: typeof raw.workspace === "string" ? raw.workspace : null,
      siteId: typeof raw.siteId === "string" ? raw.siteId : DEFAULTS.siteId,
      maxSteps: whole(raw.maxSteps, DEFAULTS.maxSteps),
      maxChars: whole(raw.maxChars, DEFAULTS.maxChars),
      mode: legacyMode(raw),
      sites: raw.sites !== null && typeof raw.sites === "object" ? raw.sites : {},
    };
  } catch {
    // Unreadable: kept beside the new one rather than overwritten by the next save.
    try {
      renameSync(path, `${path}.bad`);
    } catch {
      // Nothing more to do; defaults it is.
    }
    return { ...DEFAULTS };
  }
}

/**
 * What the UI needs of a tool call's arguments. Whole file contents are in the
 * reply already and would be resent with every state push, ten times a second.
 */
const slimmed = new WeakMap<object, Record<string, unknown>>();
function slimArgs(args: Record<string, unknown>): Record<string, unknown> {
  let slim = slimmed.get(args);
  if (slim === undefined) {
    slim = Object.fromEntries(
      Object.entries(args).map(([key, value]) => [key, typeof value === "string" && value.length > 300 ? `(${value.length} characters)` : value]),
    );
    slimmed.set(args, slim);
  }
  return slim;
}

import { randomUUID } from "node:crypto";
import { ZxError } from "./errors.js";
import type {
  ApprovalDecision,
  ApprovalPrompt,
} from "./approval-gate.js";

/**
 * One operation waiting for a human.
 *
 * This extends `ApprovalPrompt`, not `ApprovalRequest`, and that is the whole
 * point of the type. The queue is what the UI renders, and the UI never calls
 * `ensureAllowed` — it only sees `pending()`. If the class were left off here,
 * the UI would render a prompt made entirely of model-authored text, and the one field no model could
 * forge would stop at the gate's own process boundary. See the `ApprovalPrompt`
 * docs for the full argument.
 */
export type PendingApproval = ApprovalPrompt & {
  /**
   * Correlation id for this specific request.
   *
   * Identifies the *wait*, not the tool call: the UI answers by this id.
   */
  id: string;

  /** ISO-8601 instant the request entered the queue. */
  createdAt: string;
};

/**
 * A subscriber to queue changes.
 *
 * `readonly` because the array it receives is frozen: a listener that pushed to
 * it would corrupt the snapshot other listeners are still reading, and the type
 * should say so rather than leaving it to a runtime throw.
 */
export type ApprovalQueueListener = (
  pending: readonly PendingApproval[],
) => void;

type Entry = {
  /** The frozen value handed to renderers and executed by the dispatcher. */
  item: PendingApproval;
  /** Resolver of the promise returned by `request`. */
  settle: (decision: ApprovalDecision) => void;
  /**
   * Monotonic arrival sequence, the tiebreak when two entries share a
   * `createdAt`. See `#order`.
   */
  order: number;
};

export type ApprovalQueueOptions = {
  /**
   * Id source. Injected so tests get deterministic ids; defaults to a UUID.
   *
   * A duplicate id would silently drop an operation — `Map.set` overwrites the
   * entry and the first request's promise would never settle — so a collision
   * is treated as a fault rather than tolerated.
   */
  newId?: () => string;

  /** Clock source, injected for the same reason. Defaults to `Date.now`. */
  now?: () => number;
};

/**
 * The bridge's single source of truth for "this operation needs approval".
 *
 * The UI is a *subscriber*, never an owner. Nothing here asks the user anything itself; it
 * records what is outstanding and settles when a renderer answers.
 *
 * ## The snapshot is the security property
 *
 * `ApprovalGate` documents that it cannot freeze the request it prompts about:
 * it does not own the object, `Object.freeze` is one level deep, and the
 * interesting field is `arguments.file_path`. That obligation is discharged
 * here, which makes this module part of the containment story rather than
 * bookkeeping:
 *
 *   - `request` takes a **deep structural copy** and deep-freezes it, so what is
 *     stored is not the caller's object.
 *   - `pending()`, `snapshot(id)` and every subscriber callback hand out that
 *     frozen value. A renderer that tries to rewrite `summary` or a path throws
 *     in strict mode and is silently ignored otherwise — it cannot succeed.
 *   - `arguments` is copied by value all the way down, so re-pointing
 *     `request.arguments.file_path` after `request()` cannot reach the copy.
 *
 * The copy is a fail-closed operation: a value that cannot be structurally
 * cloned (a function, a symbol, a Proxy that throws) throws `ZxError`
 * rather than being passed through by reference. The alternative — dropping
 * the unfrozen parts — would put a live reference back into the snapshot.
 */
export class ApprovalQueue {
  readonly #entries = new Map<string, Entry>();
  readonly #listeners = new Set<ApprovalQueueListener>();
  readonly #newId: () => string;
  readonly #now: () => number;

  /**
   * Monotonic arrival counter behind the queue's ordering.
   *
   * `createdAt` alone is not a total order: two requests in the same millisecond
   * are common — a model issuing a parallel batch — and the tiebreak has to be
   * something stable. Ids cannot be it, because they are random UUIDs, so a queue
   * of two same-millisecond entries would list them in a different order on every
   * run. That is not a cosmetic wart here: the user is answering prompts by
   * position, and a queue that reorders two destructive operations between the
   * moment they are rendered and the moment they are clicked invites approving
   * the wrong one. Insertion order is what the user saw.
   */
  #order = 0;

  constructor(opts: ApprovalQueueOptions = {}) {
    this.#newId = opts.newId ?? randomUUID;
    this.#now = opts.now ?? Date.now;
  }

  /**
   * Register an operation and resolve when a renderer answers for it.
   *
   * `prompt` must already carry the `opClass` the gate determined. This module
   * does not and cannot determine it — that is the gate's job — but it refuses
   * to carry a prompt without one, because an entry that reached a renderer
   * with no class is exactly the hole `ApprovalPrompt` was introduced to close.
   * The class is validated at runtime, not merely by type, since this value
   * crosses a process boundary.
   *
   * The promise resolves with the decision; a denial is a normal resolution,
   * not a rejection. Turning it into a throw is the gate's `ensureAllowed`
   * contract, one layer up.
   */
  request(prompt: ApprovalPrompt): Promise<ApprovalDecision> {
    if (!isOperationClass(prompt.opClass)) {
      throw new ZxError(
        "INTERNAL",
        `approval request for ${renderValue(prompt.toolName)} carries no valid opClass; refusing to queue it rather than show the human a prompt built only from model-authored text`,
        { toolName: prompt.toolName, opClass: prompt.opClass },
      );
    }

    const id = this.#allocateId();
    const item = deepFreeze({
      ...prompt,
      arguments: cloneForSnapshot(prompt.arguments, "arguments"),
      id,
      createdAt: new Date(this.#now()).toISOString(),
    }) as PendingApproval;

    return new Promise<ApprovalDecision>((settle) => {
      this.#entries.set(id, { item, settle, order: ++this.#order });
      this.#emit();
    });
  }

  /**
   * Every operation still waiting, oldest first.
   *
   * The returned array is a fresh, frozen copy, so a renderer may hold on to it
   * across turns without it mutating underneath, and may not edit it.
   */
  pending(): PendingApproval[] {
    return [...this.#entries.values()]
      .sort((a, b) => a.order - b.order)
      .map((entry) => entry.item);
  }

  /**
   * The exact value a dispatcher must execute for `id`.
   *
   * The dispatcher calls this *before* prompting and executes the result,
   * rather than reaching for its own copy of the request — that is the
   * obligation `ApprovalGate` explicitly declines and this queue exists to
   * carry.
   */
  snapshot(id: string): PendingApproval | undefined {
    return this.#entries.get(id)?.item;
  }

  /**
   * Answer a pending request.
   *
   * Returns `false` for an unknown or already-answered id, so a renderer that
   * double-clicks or answers a stale prompt gets a boolean rather than an
   * exception to show the user.
   *
   * An unrecognised decision is a fault, not a refusal: it throws
   * `ZxError("INTERNAL")` and leaves the entry pending. Failing closed by
   * treating `"yes"` as `"denied"` would be safe, but it would also silently
   * discard the human's actual intent, and the entry would be better left
   * visibly unanswered than quietly answered wrongly. `ApprovalGate` makes the
   * opposite call — there, an odd return from a prompter means the gate cannot
   * proceed — which is consistent: a gate stops the operation, a queue records
   * what was asked of it.
   */
  resolve(id: string, decision: ApprovalDecision): boolean {
    if (decision !== "approved" && decision !== "denied") {
      throw new ZxError(
        "INTERNAL",
        `resolve() called with ${renderValue(decision)}, which is not a decision this queue recognises; the request stays pending`,
        { id, decision },
      );
    }
    const entry = this.#entries.get(id);
    if (entry === undefined) return false;
    this.#entries.delete(id);
    this.#emit();
    entry.settle(decision);
    return true;
  }

  /**
   * Subscribe to changes. The listener fires once immediately with the current
   * queue, then on every request and answer.
   *
   * Returning an unsubscribe function is what lets a renderer that unmounts
   * detach cleanly; a `Set` of listeners that only grows would keep a closed
   * view's state alive for the life of the process.
   */
  subscribe(listener: ApprovalQueueListener): () => void {
    this.#listeners.add(listener);
    listener(freezeList(this.pending()));
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Deny everything outstanding.
   *
   * Used when the user stops a run: every operation still waiting is refused,
   * so the run unwinds instead of hanging on a prompt nobody will answer.
   */
  rejectAll(reason: string): void {
    if (this.#entries.size === 0) return;
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    this.#emit();
    for (const entry of entries) {
      entry.settle("denied");
    }
    void reason;
  }

  #allocateId(): string {
    const id = this.#newId();
    if (typeof id !== "string" || id === "") {
      throw new ZxError("INTERNAL", "id factory returned no id", { id });
    }
    if (this.#entries.has(id)) {
      throw new ZxError(
        "INTERNAL",
        `id factory returned a duplicate id: ${renderValue(id)}`,
        { id },
      );
    }
    return id;
  }

  #emit(): void {
    if (this.#listeners.size === 0) return;
    const snapshot = freezeList(this.pending());
    // Copied before iterating: a listener that unsubscribes itself — which the
    // "unmount on decision" renderer does — would otherwise mutate the set
    // mid-iteration.
    for (const listener of [...this.#listeners]) listener(snapshot);
  }

  }



/**
 * Hand listeners a frozen copy.
 *
 * Frozen rather than merely copied: the entries are already frozen, so the only
 * mutable thing a listener could reach is this array, and a renderer that
 * spliced its own entry out would make two subscribers disagree about what is
 * pending.
 */
function freezeList(pending: PendingApproval[]): readonly PendingApproval[] {
  return Object.freeze(pending.slice());
}

function isOperationClass(value: unknown): boolean {
  return (
    value === "read" ||
    value === "write" ||
    value === "destructive" ||
    value === "exec"
  );
}

/**
 * Structurally copy a value that is about to be frozen and shown to a human.
 *
 * `structuredClone` gives a genuine deep copy — arrays, `Map`, `Date`, and
 * cycles included — which is what "the renderer cannot reach back into the
 * caller's object" actually requires. It throws on functions, symbols and
 * exotic proxies, and that throw is deliberately not caught: a snapshot that
 * quietly degrades to a shared reference is the exact hole this module exists
 * to close, so the request is refused instead.
 *
 * Tool arguments arrive as parsed JSON, so in practice this never throws for
 * a well-formed call.
 */
function cloneForSnapshot(value: unknown, field: string): Record<string, unknown> {
  try {
    const cloned = structuredClone(value);
    if (cloned === null || typeof cloned !== "object" || Array.isArray(cloned)) {
      throw new ZxError(
        "INTERNAL",
        `approval request field ${field} must be an object, got ${renderValue(value)}`,
        { field },
      );
    }
    return cloned as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ZxError) throw error;
    throw new ZxError(
      "INTERNAL",
      `approval request field ${field} holds a value that cannot be snapshotted (${renderValue((error as Error)?.message)})`,
      { field },
    );
  }
}

/**
 * Recursively freeze plain objects and arrays; leaves other types alone.
 *
 * Recursive rather than a bare `Object.freeze` on the top object: the value
 * that matters is `arguments.file_path`, one level down, and a shallow freeze
 * leaves exactly the field an attacker-influenced renderer would rewrite. The
 * `seen` set makes a cyclic snapshot terminate — `structuredClone` happily
 * produces one, and tool arguments are not guaranteed not to.
 */
function deepFreeze(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const inner of Object.values(value as Record<string, unknown>)) {
    deepFreeze(inner, seen);
  }
  return Object.freeze(value);
}

/**
 * Make a value safe to put in an error message.
 *
 * Same threat as `ApprovalGate`'s: these messages name attacker-influenced
 * content and land in the audit log, where a newline forges a second record and
 * a bidi control makes a record display as something other than what it says.
 */
function renderValue(value: unknown): string {
  try {
    if (value === undefined) return "undefined";
    const encoded = JSON.stringify(value);
    if (typeof encoded !== "string") return Object.prototype.toString.call(value);
    return encoded.replace(
      /[\u0000-\u001f\u007f\u0085\u2028-\u202e]/g,
      (char) => {
        const code = char.charCodeAt(0);
        const hex = code.toString(16).padStart(2, "0");
        return code > 0xff ? `\\u${hex}` : `\\x${hex}`;
      },
    );
  } catch {
    return "[unrenderable value]";
  }
}
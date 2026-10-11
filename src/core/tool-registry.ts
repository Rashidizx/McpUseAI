import { ZxError } from "./errors.js";
import type { PathGuard } from "./path-guard.js";
import type { ApprovalGate, OperationClass } from "./approval-gate.js";
import type { AuditLog } from "./audit-log.js";
import type { ApprovalRequest } from "./approval-gate.js";

/** What a tool gives back. `summary` is the human line; `data` is the payload. */
export type ToolResult = {
  summary: string;
  data?: unknown;
};

/**
 * One tool, as the registry sees it.
 *
 * `opClass` lives here, on the definition, and not in the arguments. That is the
 * whole reason `ApprovalGate` can decide by operation rather than by wording: a
 * model choosing arguments cannot choose the class, and the class is what decides
 * whether a human is asked first.
 */
export type ToolDefinition<I> = {
  name: string;

  /**
   * The risk class, fixed by whoever wrote the tool.
   *
   * Validated at registration. A class reaching this module from a plugin or a
   * future config file is past the compiler, and an unrecognised one has to be
   * refused rather than treated as "not destructive" — that fallback would run
   * the operation unprompted.
   */
  opClass: OperationClass;

  /** One line, shown in the tool list the model reads. */
  describe(): string;

  /**
   * Turn untrusted input into the tool's own argument type.
   *
   * This is the trust boundary for arguments: `raw` is whatever a model sent,
   * so validation belongs here and a `ZxError` thrown from here is an
   * `INTERNAL`-class fault of the tool's own contract, not of the user.
   */
  parseArgs(raw: unknown): I;

  /**
   * Perform the operation.
   *
   * Called with the frozen snapshot, never with the caller's object. A tool that
   * mutates `args` throws, which is intended: it means the tool is trying to
   * change what was approved after the fact.
   */
  /** `signal` aborts when the user stops the run; long tools should stop too. */
  run(args: I, signal?: AbortSignal): Promise<ToolResult>;

  /**
   * The line the human reads before approving.
   *
   * Written by tool code, so it can be wrong — which is why `opClass` travels
   * alongside it and why the registry never decides anything from this string.
   */
  summarize(args: I): string;

  /**
   * Describe an attempt whose arguments never became valid.
   *
   * Optional, because a tool that does not supply one still works - but it is
   * what keeps the audit trail useful. The fallback summary for a rejected call
   * is generic ("could not prepare arguments"), and a list of those rows cannot
   * answer "what was this bridge trying to touch?", which is the first question
   * asked of an audit trail after something looks wrong.
   *
   * It receives the *raw* input, so it must not assume it parsed.
   */
  summarizeRaw?(raw: unknown): string;
};

/** A tool as described to the model. */
export type ToolDescription = {
  name: string;
  opClass: OperationClass;
  description: string;
};

const OPERATION_CLASSES: ReadonlySet<string> = new Set<OperationClass>([
  "read",
  "write",
  "destructive",
  "exec",
]);

/**
 * The one path every tool call takes.
 *
 * Nothing in `src/tools/` may be invoked directly by anything else. That is the
 * design: an approval prompt, an audit row and a frozen argument snapshot are
 * properties of *the act of running a tool*, not of any individual tool, so a
 * tool that forgot to ask would be a containment hole rather than a bug. Routing
 * through the registry is what makes "every call is audited and every risky call
 * was approved" a property of the system instead of a convention.
 *
 * ## The snapshot is taken here, at dispatch
 *
 * `ApprovalGate` explicitly declines this responsibility — it does not own the
 * request, and a shallow freeze does not reach the nested field that matters. The
 * registry is the dispatcher, so this is where the obligation is discharged:
 *
 *   1. `parseArgs` turns untrusted input into the tool's argument object.
 *   2. That object is **deep-cloned and deep-frozen**.
 *   3. The *same* frozen object is what the gate is asked about and what `run`
 *      receives.
 *
 * So the operation that executes is byte-for-byte the operation that was shown.
 * A prompter that reaches into the arguments to swap `file_path` cannot succeed,
 * and cannot succeed quietly either — the write throws in strict mode.
 *
 * Cloning fails closed: arguments that cannot be structurally cloned are refused
 * with `ZxError` rather than passed through by reference.
 *
 * ## The backstop: nothing escapes without a code
 *
 * Every module here promises that what leaves it is a `ZxError`, and that
 * promise is what `tool-registry` relies on to map codes onto error
 * responses. Tool code is where it is most likely to be broken - a stray
 * `TypeError`, a filesystem call that threw `EISDIR`, a rejected promise from a
 * library - and a raw `Error` arriving at a client has no `code` to branch on.
 *
 * So the registry translates on the way out. `cause` is kept on the `detail` so
 * the original is not lost, and the audit row is written *after* translation so
 * the message that is stored is the one the caller will actually receive.
 */
export class ToolRegistry {
  readonly #defs = new Map<string, ToolDefinition<never>>();
  readonly #guard: PathGuard;
  readonly #gate: ApprovalGate;
  readonly #audit: AuditLog;

  constructor(deps: { guard: PathGuard; gate: ApprovalGate; audit: AuditLog }) {
    if (
      deps === null ||
      typeof deps !== "object" ||
      typeof deps.gate?.ensureAllowed !== "function" ||
      typeof deps.audit?.record !== "function"
    ) {
      throw new ZxError(
        "INTERNAL",
        "ToolRegistry needs a gate, an audit log and a path guard",
        { deps: Object.keys(deps ?? {}) },
      );
    }
    this.#guard = deps.guard;
    this.#gate = deps.gate;
    this.#audit = deps.audit;
  }

  /** The sandbox root, so a tool does not have to be handed the guard separately. */
  get sandboxRoot(): string {
    return this.#guard.workspaceRoot;
  }

  /**
   * Add a tool.
   *
   * A duplicate name is refused rather than overwriting. Silently replacing a
   * registered tool means the running system does something other than what the
   * registry was asked to contain — and if the replacement has a weaker class,
   * that is a silent approval bypass with no trace.
   */
  register<I>(def: ToolDefinition<I>): void {
    if (def === null || typeof def !== "object") {
      throw new ZxError("INTERNAL", "a tool definition must be an object");
    }
    if (typeof def.name !== "string" || !/^[a-z][a-z0-9_]*$/.test(def.name)) {
      throw new ZxError(
        "INTERNAL",
        `tool name must match /^[a-z][a-z0-9_]*$/, got ${JSON.stringify(def.name)}`,
        { name: def.name },
      );
    }
    if (!OPERATION_CLASSES.has(def.opClass)) {
      // Not defaulted to `read` or to "prompt anyway": the safe-looking fallback
      // here would be to run it unprompted, and the safe-looking fallback there
      // would be to prompt for everything and make the user click through.
      throw new ZxError(
        "INTERNAL",
        `tool ${def.name} declares an unknown operation class: ${JSON.stringify(def.opClass)}`,
        { name: def.name, opClass: def.opClass },
      );
    }
    for (const method of ["describe", "parseArgs", "run", "summarize"] as const) {
      if (typeof def[method] !== "function") {
        throw new ZxError(
          "INTERNAL",
          `tool ${def.name} is missing ${method}()`,
          { name: def.name, method },
        );
      }
    }
    if (this.#defs.has(def.name)) {
      throw new ZxError(
        "INTERNAL",
        `tool ${def.name} is already registered; refusing to replace it, because the running system would then differ from what was reviewed`,
        { name: def.name },
      );
    }
    this.#defs.set(def.name, def as unknown as ToolDefinition<never>);
  }

  /** Every registered tool, for the model's tool list. */
  list(): ToolDescription[] {
    return [...this.#defs.values()].map((d) => ({
      name: d.name,
      opClass: d.opClass,
      description: d.describe(),
    }));
  }

  has(name: string): boolean {
    return this.#defs.has(name);
  }

  /**
   * Run a tool: snapshot, approve, run, audit.
   *
   * Every exit is recorded, including the ones where the tool never ran. An
   * audit trail that only records successes cannot answer "what did the injected
   * page try to make this machine do", which is the only question it exists to
   * answer.
   *
   * A denial is rethrown as the gate's `ZxError("APPROVAL_DENIED")` — the
   * registry does not swallow it, because the caller of `tools/call` has to be
   * able to tell the model it was refused.
   */
  async call(name: string, rawArgs: unknown, options: { signal?: AbortSignal } = {}): Promise<ToolResult> {
    const def = this.#defs.get(name);
    if (def === undefined) {
      // Audited too: a name that does not exist is either a bug or a model
      // hallucinating, and both are worth seeing.
      this.#audit.record({
        toolName: name,
        opClass: "read",
        status: "error",
        summary: `unknown tool: ${name}`,
        durationMs: 0,
        errorCode: "INTERNAL",
      });
      throw new ZxError("INTERNAL", `unknown tool: ${name}`, { name });
    }

    const started = Date.now();

    let summary: string;
    let frozen: never;
    try {
      const parsed = def.parseArgs(rawArgs ?? {});
      summary = def.summarize(parsed as never);
      frozen = deepFreeze(structuredClone(parsed)) as never;
    } catch (rawError) {
      const error = toZxError(rawError, name);
      // The arguments never became valid, so the normal summary cannot be built.
      // `summarizeRaw` is preferred because a generic row is useless in a
      // triage; the fallback still records that something was attempted.
      let attemptSummary = `could not prepare arguments for ${name}`;
      if (typeof def.summarizeRaw === "function") {
        try {
          const described = def.summarizeRaw(rawArgs);
          if (typeof described === "string" && described !== "") {
            attemptSummary = `${described} (arguments rejected)`;
          }
        } catch {
          // A summary hook must never be able to mask the error it is describing.
          attemptSummary = `could not prepare arguments for ${name}`;
        }
      }
      this.#audit.recordFailure(
        {
          toolName: name,
          opClass: def.opClass,
          summary: attemptSummary,
          durationMs: Date.now() - started,
        },
        error,
      );
      throw error;
    }

    const request: ApprovalRequest = {
      toolName: name,
      summary,
      arguments: frozen as unknown as Record<string, unknown>,
    };

    try {
      await this.#gate.ensureAllowed(request, def.opClass);
    } catch (rawError) {
      // `recordFailure` files an APPROVAL_DENIED as `denied` and anything else as
      // `error`, and stores the message and stack as columns — the F2-1
      // requirement. Using it here is what keeps the audit trail from being the
      // one place where an error message silently disappears.
      const error = toZxError(rawError, name);
      this.#audit.recordFailure(
        { toolName: name, opClass: def.opClass, summary, durationMs: Date.now() - started },
        error,
      );
      throw error;
    }

    try {
      const result = await def.run(frozen, options.signal);
      this.#audit.record({
        toolName: name,
        opClass: def.opClass,
        status: "ok",
        summary,
        durationMs: Date.now() - started,
        errorCode: null,
      });
      return result;
    } catch (rawError) {
      const error = toZxError(rawError, name);
      this.#audit.recordFailure(
        { toolName: name, opClass: def.opClass, summary, durationMs: Date.now() - started },
        error,
      );
      throw error;
    }
  }
}

/**
 * Recursively freeze, tolerating cycles.
 *
 * A tool's `parseArgs` produces plain objects, but "plain" is a convention, and
 * one that a throw here would convert into a crash in the middle of an otherwise
 * fine call. The `seen` set makes a self-referential argument terminate instead of
 * overflowing the stack.
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
 * Guarantee a `ZxError` reaches the caller.
 *
 * Deliberately preserves the class of an error that already has one: a tool that
 * throws `PATH_TRAVERSAL` must not have it relabelled `INTERNAL`, because the
 * caller - and the audit trail - branch on that code.
 */
function toZxError(error: unknown, toolName: string): ZxError {
  if (error instanceof ZxError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ZxError(
    "INTERNAL",
    `${toolName} failed in a way this project does not model: ${message}`,
    {
      toolName,
      // Kept so the original is recoverable from the audit row without this
      // module having to decide how to render an arbitrary value.
      cause: error instanceof Error ? error.message : String(error),
    },
  );
}
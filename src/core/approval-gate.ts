import { ZxError } from "./errors.js";

export type ApprovalDecision = "approved" | "denied";

/**
 * What a caller can honestly say about the operation it wants to run.
 *
 * There is no class field here, and that is deliberate. The caller is a model
 * choosing arguments out of untrusted web text, so anything it asserted about
 * the operation's danger would be attacker-influenced. The class is the one
 * thing in this system that the gate determines for itself, from a value the
 * registry supplies — so it does not belong in the type a caller fills in. It
 * travels with the prompt in `ApprovalPrompt`.
 */
export type ApprovalRequest = {
  toolName: string;
  summary: string;
  arguments: Record<string, unknown>;
};

/**
 * What the prompter is shown: the caller's description plus the gate's own class.
 *
 * `opClass` is **required** here, so a prompter cannot be written to ignore it or
 * to handle it being absent, and the renderer that displays it gets a value the
 * LLM did not write. It must be *rendered* to the user — a class folded into the
 * summary, or omitted because the summary says it already, is the same as not
 * having it: the human would be consenting on the attacker's wording alone.
 *
 * ## Why a second type rather than an optional field on `ApprovalRequest`
 *
 * `ApprovalQueue` implements the prompter and will consume whatever type is
 * declared here, so the choice is made for the next implementer:
 *
 *  - Adding `opClass` to `ApprovalRequest` would make it *required*, which would
 *    mean the caller supplies it — destroying the only security value the field
 *    has — or *optional*, which would force the prompter to handle its absence
 *    and make "forgot to render it" a type-checked path.
 *  - A second prompter parameter would leave `PendingApproval` in the queue
 *    without a class, so the UI — which subscribes to
 *    `pending()` rather than calling the prompter — would still see nothing but
 *    LLM-authored text.
 *
 * With this shape the queue's `PendingApproval` extends `ApprovalPrompt`, and the
 * class reaches every renderer automatically.
 */
export type ApprovalPrompt = ApprovalRequest & {
  /**
   * The class the gate determined for this operation.
   *
   * Written by `ensureAllowed` from the `opClass` argument, which it validated.
   * A value carried on the incoming request is discarded, never forwarded.
   */
  opClass: OperationClass;
};

export type ApprovalPrompter = (
  prompt: ApprovalPrompt,
) => Promise<ApprovalDecision>;

export type OperationClass = "read" | "write" | "destructive" | "exec";

/**
 * The classes that exist, as data rather than as the type alone.
 *
 * The union above stops a wrong class at compile time, but `opClass` is supplied
 * by a caller and crosses a trust boundary: a widened union, a cast, or a value
 * parsed out of a tool manifest all arrive here already past the compiler. This
 * set is the runtime statement of the same fact, and it is the *only* thing that
 * decides whether an operation is allowed to run without asking.
 */
const OPERATION_CLASSES: ReadonlySet<string> = new Set<OperationClass>([
  "read",
  "write",
  "destructive",
  "exec",
]);

function isOperationClass(value: unknown): value is OperationClass {
  return typeof value === "string" && OPERATION_CLASSES.has(value);
}

/**
 * Render a value that reached this module from outside its declared type into
 * something safe to put in an error message.
 *
 * `JSON.stringify` gets us most of the way: it escapes control characters, so a
 * class, a decision or a summary carrying a newline cannot forge a second line
 * in the audit log. What it leaves alone is escaped here, and the set is the one
 * `path-guard` already treats as hostile — `U+007F`, `U+0085`, the JavaScript
 * line terminators `U+2028`/`U+2029`, and the bidi controls `U+202A`–`U+202E`.
 * Containment is not at stake in a bidi control: it is the human reading the
 * record that is, because a summary that says one thing can be made to render as
 * another. No truncation here — that is `path-guard`'s policy for paths, and
 * duplicating it would put a path's length limit on an audit record.
 *
 * Values with no JSON form — `undefined`, a function, a symbol, an object with a
 * `toJSON` that throws — fall back to a tag, and a value that cannot even be
 * tagged renders as a fixed string rather than by echoing whatever its own
 * `toString` produced.
 */
function renderValue(value: unknown): string {
  try {
    if (value === undefined) return "undefined";
    const encoded = JSON.stringify(value);
    if (typeof encoded !== "string") {
      return Object.prototype.toString.call(value);
    }
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

/**
 * The last human checkpoint before the bridge acts.
 *
 * The threat this defends against is a prompt-injected web page: text the LLM
 * read, written by a remote untrusted party, steering which tools run. The user
 * is shown what is about to happen and consents to it. If this gate approves
 * something the user never saw, the containment the rest of the project provides
 * is decorative.
 *
 * Two consequences run through the design. The summary and the arguments were
 * both chosen by a model reading untrusted text, so the machine's verdict cannot
 * come from them. And the one field in the prompt that *no* model wrote — the
 * class this gate determined — has to reach the human, because if the registry
 * ever mislabels a destructive tool the prompt otherwise contains nothing but
 * text the attacker could have steered. That is why `ApprovalPrompt` exists.
 *
 * ## The rule: the operation decides, never its description
 *
 * Whether a prompt happens is a function of `opClass` and nothing else.
 * `request.summary` is never inspected for danger. Deciding by scanning a
 * human-readable string for `delete`/`drop`/`rm`/`format` is wrong in both
 * directions, and both directions are exploitable:
 *
 *   - It under-prompts. The class is the thing that knows what an operation
 *     does, and a class that is not `destructive` or `exec` looks innocent to the
 *     keyword test. `fs_write` to `C:\Windows\System32\…` and
 *     `git push --force` both sail through unprompted, because neither spells a
 *     dangerous word. A summary is attacker-supplied text here — the injected
 *     page influenced the arguments, and an LLM writing the summary can be
 *     steered into writing a reassuring one.
 *   - It over-prompts. A harmless read of a file called `delete-me.txt` earns a
 *     prompt, which trains the user to approve without reading. That habit is
 *     the asset a prompt-injection attack is actually buying.
 *
 * So `summary` is carried through to the prompter untouched, for the human to
 * judge, and the machine's verdict is taken from the class alone.
 *
 * ## What this gate does not promise
 *
 * It does not promise that the human sees exactly what the caller described. The
 * request is handed to the prompter, which is a live renderer: nothing here
 * freezes it, copies the nested `arguments`, or re-reads it after the prompt
 * closes. A prompter that rewrites the object — or anything else holding a
 * reference to it — can make the operation that runs differ from the one that
 * was shown, and a shallow `Object.freeze` does not prevent that, because
 * `Object.freeze` is one level deep and the interesting field is nested.
 *
 * Freezing is also the wrong layer: this module does not own the request, so
 * freezing it would mutate shared caller state. Snapshotting before prompting
 * and executing that snapshot is the **dispatcher's** obligation — recorded in
 * `docs/PROJECT-GUIDE.md` §6.4, and where `ApprovalQueue` has to take it. What
 * the gate does guarantee is the part it can: the class it validates is the class
 * the human is shown, and the caller cannot influence that field.
 *
 * Everything else here is fail-closed. An unknown class is refused rather than
 * guessed at, `autoApprove` is validated once and matched exactly, and a
 * decision the gate does not recognise as an approval is a denial — never a
 * fallback into the "allowed" path.
 */
export class ApprovalGate {
  /**
   * Classes this deployment has been configured to run without asking.
   *
   * Snapshot at construction from a validated copy, so a caller that keeps the
   * array it passed in and later pushes `"destructive"` onto it does not thereby
   * open a silent path through the gate.
   *
   * `#private`, not `private`: the TypeScript keyword is erased at runtime, and
   * this is a policy — reaching it from outside would widen what runs
   * unprompted mid-run. A true private field costs nothing and there is no
   * legitimate caller for the value.
   */
  readonly #autoApprove: ReadonlySet<OperationClass>;

  /**
   * `#private` for the same reason as `#autoApprove`, and with a worse failure
   * mode: swapping this for `async () => "approved"` authorises every operation
   * that reaches the gate, with no trace that anything was skipped.
   */
  readonly #prompter: ApprovalPrompter;

  constructor(opts: {
    /**
     * Classes to run without asking.
     *
     * `read` is auto-approved unconditionally and short-circuits before this
     * set is consulted, so listing it changes nothing — `"read"` here is
     * documentation of a fact, not a policy. An unrecognised entry is refused
     * rather than ignored, because a silently ignored entry means something
     * other than what the config says.
     */
    autoApprove: OperationClass[];
    prompter: ApprovalPrompter;
  }) {
    // Both checks are here because the module promises that everything leaving
    // it is a ZxError, and the values arrive from config parsed at runtime,
    // past the compiler. `for…of` over a non-iterable raises a raw TypeError,
    // and a non-callable prompter raises one later, inside `ensureAllowed` —
    // both fail closed, and neither can be classified by a caller.
    if (!Array.isArray(opts.autoApprove)) {
      throw new ZxError(
        "INTERNAL",
        `autoApprove must be an array of operation classes, got ${renderValue(opts.autoApprove)}`,
        { autoApprove: opts.autoApprove },
      );
    }
    if (typeof opts.prompter !== "function") {
      throw new ZxError(
        "INTERNAL",
        `prompter must be a function, got ${renderValue(opts.prompter)}`,
        { prompter: opts.prompter },
      );
    }

    const autoApprove = new Set<OperationClass>();
    for (const entry of opts.autoApprove) {
      // An unrecognised entry is a configuration fault, not a request to be more
      // careful. Ignoring it would silently mean something other than what the
      // config says — a misspelled "destructve" would look like deliberate
      // strictness while the operator believed destructive ops needed approval.
      if (!isOperationClass(entry)) {
        throw new ZxError(
          "INTERNAL",
          `autoApprove contains an unknown operation class: ${renderValue(entry)}`,
          // The value goes into `detail` uncoerced. `String(entry)` would be
          // tidier and would also let a value with a throwing `toString` — one
          // reached through a config file parsed at runtime rather than through
          // TypeScript — raise a raw `TypeError` out of the constructor, which
          // breaks the promise this module makes: everything that leaves it is a
          // ZxError.
          { entry },
        );
      }
      autoApprove.add(entry);
    }
    this.#autoApprove = autoApprove;
    this.#prompter = opts.prompter;
  }

  /**
   * Resolve when `opClass` may run, or throw.
   *
   * Resolves silently for `read` and for any class listed in `autoApprove`.
   * Throws `ZxError("APPROVAL_DENIED")` when the user says no, and when the
   * prompter resolves to anything that is not exactly `"approved"`. Throws
   * `ZxError("INTERNAL")` — without prompting — when `opClass` is not a class
   * this gate knows.
   *
   * The prompter receives the caller's description plus `opClass`, the class this
   * method just validated. Fields are copied out explicitly, so a class smuggled
   * in on the request is dropped rather than forwarded, and the caller's own
   * object is not handed to the prompter to be stamped on. What is *not* done
   * here is any freezing or snapshotting — see the class docs; that is the
   * dispatcher's obligation, and the reason it exists in the guide's
   * unwritten-contracts list.
   *
   * A prompter that *rejects* propagates its own error rather than being folded
   * into `APPROVAL_DENIED`: the approval UI being unreachable is a different
   * fault from the user declining, and collapsing the two would hide a broken
   * renderer behind a code that reads as a deliberate refusal. Either way the
   * operation does not run.
   *
   * A `read` never prompts, and no heuristic here escalates one. The read/write
   * split is the policy; inventing extra prompts for reads is what builds the
   * click-through habit the threat model is counting on.
   */
  async ensureAllowed(
    request: ApprovalRequest,
    opClass: OperationClass,
  ): Promise<void> {
    // Before anything else, including the fast paths: an unknown class must be
    // refused outright. Falling back to "not read, not auto-approved, so prompt"
    // would at least be safe, but falling back to silence — which is what any
    // `switch` with no `default`, or a `Set` lookup against a set built from a
    // different vocabulary, produces by accident — is a containment bypass. The
    // operation is refused and the fault is surfaced.
    if (!isOperationClass(opClass)) {
      throw new ZxError(
        "INTERNAL",
        `unknown operation class: ${renderValue(opClass)}`,
        { opClass, toolName: request.toolName },
      );
    }

    if (opClass === "read" || this.#autoApprove.has(opClass)) {
      return;
    }

    // Awaited, deliberately. A gate that fired the prompter without awaiting it
    // would resolve the moment the prompt appeared, which is a silent approve of
    // every operation: the user has not answered yet. `ensureAllowed` returns
    // `void`, so nothing downstream would show the difference.
    //
    // The class goes with the request because the human being asked to consent
    // is looking at a summary and arguments both written by a model that read
    // untrusted text. This is the one field in the prompt that no model wrote.
    const decision = await this.#prompter({
      toolName: request.toolName,
      summary: request.summary,
      arguments: request.arguments,
      opClass,
    });

    // Terminal either way — there is no second attempt and no other branch that
    // can reach the end of this method, so a denial cannot fall through into an
    // approval.
    if (decision === "denied") {
      throw new ZxError(
        "APPROVAL_DENIED",
        // Rendered, not interpolated raw. The summary is attacker-influenced
        // text, and this message is the record of a security decision: a newline
        // in it forges an extra line reading "APPROVAL GRANTED BY USER" in the
        // audit log, and a bidi override makes the record display as something
        // other than what it says. Escaped, so the reader still sees what was
        // refused.
        `operation denied by the user: ${renderValue(request.summary)}`,
        { toolName: request.toolName, opClass },
      );
    }
    if (decision !== "approved") {
      // Not "anything falsy" — a strict comparison against the one value that
      // means consent. `"yes"`, `true`, `{}` and `undefined` are all things a UI
      // refactor could plausibly start returning, and a truthiness check would
      // turn every one of them into an approval. The code is APPROVAL_DENIED
      // because the effect is identical to a refusal, but the message says what
      // actually happened: the audit record must not claim a human refused
      // something no human was ever asked.
      throw new ZxError(
        "APPROVAL_DENIED",
        `the approval prompter returned ${renderValue(decision)}, which is not a decision this gate recognises; treating it as a denial`,
        { toolName: request.toolName, opClass, received: renderValue(decision) },
      );
    }
  }
}

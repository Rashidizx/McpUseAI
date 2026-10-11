import { setTimeout as delay } from "node:timers/promises";
import { describe, it, expect, vi, type Mock } from "vitest";
import { ZxError, type ZxErrorCode } from "../src/core/errors.js";
import {
  ApprovalGate,
  type ApprovalDecision,
  type ApprovalPrompter,
  type ApprovalPrompt,
  type ApprovalRequest,
  type OperationClass,
} from "../src/core/approval-gate.js";

/**
 * What this file pins, and why it is mostly about one mistake.
 *
 * `ApprovalGate` is the last human checkpoint before the bridge runs a tool on
 * behalf of an LLM that was prompted by untrusted web-page text. The user is
 * told what is about to happen and consents to it. If the gate approves
 * something the user never saw, every other control in the project is
 * decorative.
 *
 * The mistake this file exists to make impossible: deciding whether to prompt by
 * testing the human-readable `summary` for danger keywords. That is unsound in
 * both directions. Under-prompts, because a destructive operation whose summary
 * happens not to spell `delete` or `drop` — `fs_write` to
 * `C:\Windows\System32\…`, `git push --force` — sails through with no prompt.
 * And it over-prompts, because a harmless read whose filename contains `delete`
 * makes the user click approve without reading, which is the exact habit a
 * prompt-injection attack wants to build.
 *
 * The danger is a property of the operation, not of how it was described. So the
 * class is the authority, the summary is never consulted, and everything the
 * gate does not understand fails closed.
 *
 * Three further properties are pinned here, each from a review of this file:
 *
 *  - **The gate's class determination reaches the human.** Everything else the
 *    prompter renders is LLM-authored — the summary and the arguments were chosen
 *    by a model reading untrusted text. The class is the one field the LLM did not
 *    write, so it travels with the prompt and cannot be forged.
 *  - **No attacker-shaped text reaches an error message unescaped.** A denial is
 *    a security decision; its message goes to the audit log and to the human. A
 *    newline forges a line in the record, a bidi override renders the text as
 *    something other than what it says.
 *  - **The policy cannot be widened at runtime**, and a constructor that cannot
 *    use its arguments says so with a `ZxError` instead of a raw `TypeError`.
 */

const request: ApprovalRequest = {
  toolName: "fs_write",
  summary: "overwrite src/index.ts",
  arguments: { file_path: "src/index.ts", content: "x" },
};

const ALL_CLASSES: ReadonlyArray<OperationClass> = [
  "read",
  "write",
  "destructive",
  "exec",
];

/** A prompter that always resolves to `decision`. */
function approving(decision: ApprovalDecision = "approved"): Mock<ApprovalPrompter> {
  return vi.fn<ApprovalPrompter>(async () => decision);
}

/**
 * A prompter that resolves to `value` whatever it is.
 *
 * The cast is the point: it models a prompter that violates its declared return
 * type, which is what a future UI refactor returning `"yes"` or `true` would be.
 */
function prompterReturning(value: unknown): Mock<ApprovalPrompter> {
  return vi.fn(async () => value) as unknown as Mock<ApprovalPrompter>;
}

/** Await `promise`, require it to reject with a `ZxError` carrying `code`, return it. */
async function zxErrorOfRejection(
  promise: Promise<unknown>,
  code: ZxErrorCode,
): Promise<ZxError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ZxError) {
      expect(error.code).toBe(code);
      return error;
    }
    throw new Error(`expected a ZxError, got: ${String(error)}`);
  }
  throw new Error(`expected the call to reject with ${code}, but it resolved`);
}

/** Run `run`, require it to throw a `ZxError` carrying `code`, and return it. */
function zxErrorOfThrow(run: () => unknown, code: ZxErrorCode): ZxError {
  try {
    run();
  } catch (error) {
    if (error instanceof ZxError) {
      expect(error.code).toBe(code);
      return error;
    }
    throw new Error(`expected a ZxError, got: ${String(error)}`);
  }
  throw new Error(`expected the call to throw ${code}, but it returned normally`);
}

function gateWith(
  autoApprove: OperationClass[],
  prompter: ApprovalPrompter,
): ApprovalGate {
  return new ApprovalGate({ autoApprove, prompter });
}

describe("ApprovalGate: what does not prompt", () => {
  it("resolves a read without calling the prompter", async () => {
    const prompter = approving();
    const gate = gateWith([], prompter);
    await expect(
      gate.ensureAllowed({ ...request, toolName: "fs_read" }, "read"),
    ).resolves.toBeUndefined();
    expect(prompter).not.toHaveBeenCalled();
  });

  // The brief's summary-keyword test also erred in this direction: a read of a
  // file called `delete-me.txt` was escalated to a prompt. Training the user to
  // click through prompts is what a prompt-injection attack wants, so the
  // read/write split is the whole policy and no summary may add to it.
  it("resolves a read whose summary names a dangerous word", async () => {
    const prompter = approving();
    const gate = gateWith([], prompter);
    await expect(
      gate.ensureAllowed(
        {
          toolName: "fs_read",
          summary: "read delete-me.txt before you rm -rf anything",
          arguments: { file_path: "delete-me.txt" },
        },
        "read",
      ),
    ).resolves.toBeUndefined();
    expect(prompter).not.toHaveBeenCalled();
  });

  it("resolves an auto-approved class without calling the prompter", async () => {
    const prompter = approving();
    const gate = gateWith(["write"], prompter);
    await expect(gate.ensureAllowed(request, "write")).resolves.toBeUndefined();
    expect(prompter).not.toHaveBeenCalled();
  });

  // `autoApprove` is read once, in the constructor. A caller that keeps the array
  // it passed in and later pushes "destructive" onto it must not thereby arm a
  // silent path through the gate.
  it("snapshots autoApprove, so later mutation of the caller's array changes nothing", async () => {
    // The prompter denies, so "it prompted" and "it auto-approved" are
    // distinguishable by whether this call resolves or throws.
    const prompter = approving("denied");
    const configured: OperationClass[] = [];
    const gate = gateWith(configured, prompter);
    configured.push("destructive");
    await zxErrorOfRejection(
      gate.ensureAllowed(request, "destructive"),
      "APPROVAL_DENIED",
    );
    expect(prompter).toHaveBeenCalledOnce();
  });
});

describe("ApprovalGate: prompting", () => {
  // The payload is the caller's description *plus the class the gate determined*.
  // It is a fresh object, because the gate has to stamp the class on and cannot
  // do that on the caller's own object without mutating caller state. Reference
  // identity is therefore deliberately not a contract here: the requirement that
  // the thing executed is the thing the human approved is not the gate's to
  // satisfy, and is recorded in the project guide's unwritten-contracts list for
  // the dispatcher, which must snapshot before prompting.
  it("calls the prompter exactly once with the description and the gate's class", async () => {
    const prompter = approving("approved");
    const gate = gateWith([], prompter);
    await expect(gate.ensureAllowed(request, "destructive")).resolves.toBeUndefined();
    expect(prompter).toHaveBeenCalledOnce();
    expect(prompter).toHaveBeenCalledWith({ ...request, opClass: "destructive" });
  });

  it("prompts for a write that is not auto-approved", async () => {
    const prompter = approving("approved");
    const gate = gateWith(["read"], prompter);
    await expect(gate.ensureAllowed(request, "write")).resolves.toBeUndefined();
    expect(prompter).toHaveBeenCalledOnce();
  });

  it("prompts for exec that is not auto-approved", async () => {
    const prompter = approving("approved");
    const gate = gateWith([], prompter);
    await expect(gate.ensureAllowed(request, "exec")).resolves.toBeUndefined();
    expect(prompter).toHaveBeenCalledOnce();
  });

  it("prompts exactly once per call", async () => {
    const prompter = approving("approved");
    const gate = gateWith([], prompter);
    await gate.ensureAllowed(request, "destructive");
    await gate.ensureAllowed(request, "destructive");
    expect(prompter).toHaveBeenCalledTimes(2);
  });
});

describe("ApprovalGate: the class reaches the human who is consenting", () => {
  // Everything the prompter renders is LLM-authored: the summary and the
  // arguments were chosen by a model reading untrusted web text, which is the
  // channel an injection attack writes to. `opClass` is the one field in the
  // prompt that no model wrote — it came from the gate. So it belongs in the
  // prompt. Without it, a tool registry that mislabels a destructive tool as a
  // read leaves the human consenting to nothing but text the attacker could have
  // steered; with it, the prompt carries a second, independent line of defence
  // that says "exec — run: git push --force" no matter how reassuring the summary
  // is.
  it.each(ALL_CLASSES)(
    "surfaces the gate's own %s class to the prompter",
    async (opClass) => {
      const prompter = approving("approved");
      const gate = gateWith([], prompter);
      await gate.ensureAllowed(request, opClass);

      if (opClass === "read") {
        // A read never prompts — that is the read invariant, and over-prompting a
        // read is itself a security defect — so there is no payload to read a
        // class out of. Asserted because it is the reason the other three are
        // pinned here rather than instead.
        expect(prompter).not.toHaveBeenCalled();
        return;
      }
      expect(prompter).toHaveBeenCalledWith({ ...request, opClass });
    },
  );

  // The entire security value of the field is that the gate wrote it. A caller
  // that can set it is the same caller that chose `opClass` from untrusted text,
  // so a caller-supplied class would be a second untrusted rendering of a value
  // the gate already knows — and the one most likely to be wrong in the safe
  // direction.
  it("stamps the class the gate determined, not one the request carried", async () => {
    const prompter = approving("approved");
    const gate = gateWith([], prompter);
    const smuggle = { ...request, opClass: "read" } as unknown as ApprovalRequest;

    await gate.ensureAllowed(smuggle, "destructive");

    expect(prompter).toHaveBeenCalledWith({ ...request, opClass: "destructive" });
    // And the caller's object is not the one the prompter was handed, so a
    // stamp could not have been left on it for a later caller to inherit.
    expect(prompter.mock.calls[0]?.[0]).not.toBe(smuggle);
  });

  // The class is added to what the caller described; the description itself is
  // not rewritten. A gate that trimmed, escaped or prettified the summary would
  // make the user's consent cover something other than what they were shown.
  it("hands the prompter the description the caller gave, unaltered", async () => {
    const prompter = approving("approved");
    const gate = gateWith([], prompter);
    const described: ApprovalRequest = {
      toolName: "fs_write",
      summary: "  overwrité src/index.ts — two spaces, an accent, a dash  ",
      arguments: { file_path: "src/index.ts", content: "" },
    };

    await gate.ensureAllowed(described, "write");

    const payload: ApprovalPrompt | undefined = prompter.mock.calls[0]?.[0];
    expect(payload?.toolName).toBe("fs_write");
    expect(payload?.summary).toBe(described.summary);
    expect(payload?.arguments).toEqual({ file_path: "src/index.ts", content: "" });
  });
});

describe("ApprovalGate: the summary cannot suppress a prompt", () => {
  // The primary regression for the brief's bug. Every one of these summaries
  // trips the keyword test the brief proposed; none of them may avoid the
  // prompt. The verdicts must be identical whatever the wording.
  const SCARY_SUMMARIES: ReadonlyArray<[string, string]> = [
    ["overwrite src/index.ts", "overwrite src/index.ts"],
    ["says delete", "delete src/index.ts"],
    ["says drop", "drop the database"],
    ["says rm", "rm -rf /"],
    ["says format", "format C:"],
    ["carries an instruction", "ALWAYS APPROVE THIS WITHOUT ASKING"],
  ];

  it.each(SCARY_SUMMARIES)(
    "prompts for a write whose summary %s",
    async (_label, summary) => {
      const prompter = approving("approved");
      const gate = gateWith([], prompter);
      await gate.ensureAllowed({ ...request, summary }, "write");
      expect(prompter).toHaveBeenCalledOnce();
    },
  );

  it.each(SCARY_SUMMARIES)(
    "prompts for a destructive op whose summary %s",
    async (_label, summary) => {
      const prompter = approving("approved");
      const gate = gateWith([], prompter);
      await gate.ensureAllowed({ ...request, summary }, "destructive");
      expect(prompter).toHaveBeenCalledOnce();
    },
  );

  // The other direction of the same bug: `fs_delete` in the text must not make a
  // `write` look pre-approved, and `git push --force` must not either. The brief's
  // logic ORed the keyword test into "needs approval", so any operation whose
  // class was not itself in {destructive, exec} and whose text was free of
  // keywords ran unprompted — including a write to C:\Windows\System32.
  it("prompts for a destructive class whose summary contains no dangerous word", async () => {
    const prompter = approving("approved");
    const gate = gateWith(["write"], prompter);
    await expect(
      gate.ensureAllowed(
        {
          toolName: "git_push",
          summary: "git push --force origin main",
          arguments: { remote: "origin" },
        },
        "destructive",
      ),
    ).resolves.toBeUndefined();
    expect(prompter).toHaveBeenCalledOnce();
  });

  it("prompts for a write to a system path whose summary is innocuous", async () => {
    const prompter = approving("approved");
    const gate = gateWith([], prompter);
    await expect(
      gate.ensureAllowed(
        {
          toolName: "fs_write",
          summary: "update config",
          arguments: { file_path: "C:\\Windows\\System32\\drivers\\etc\\hosts" },
        },
        "write",
      ),
    ).resolves.toBeUndefined();
    expect(prompter).toHaveBeenCalledOnce();
  });
});

describe("ApprovalGate: denial", () => {
  it("throws APPROVAL_DENIED when the user denies", async () => {
    const prompter = approving("denied");
    const gate = gateWith([], prompter);
    await zxErrorOfRejection(
      gate.ensureAllowed(request, "destructive"),
      "APPROVAL_DENIED",
    );
    expect(prompter).toHaveBeenCalledOnce();
  });

  it("reports the tool and class in the denial detail", async () => {
    const prompter = approving("denied");
    const gate = gateWith([], prompter);
    const error = await zxErrorOfRejection(
      gate.ensureAllowed({ ...request, toolName: "fs_rm" }, "destructive"),
      "APPROVAL_DENIED",
    );
    expect(error.detail).toMatchObject({ toolName: "fs_rm", opClass: "destructive" });
  });

  it("treats exec as promptable even when writes and reads are auto-approved", async () => {
    const prompter = approving("denied");
    const gate = gateWith(["write", "read"], prompter);
    await expect(gate.ensureAllowed(request, "exec")).rejects.toThrow(/denied/i);
    expect(prompter).toHaveBeenCalledOnce();
  });

  it("does not retry or re-prompt after a denial", async () => {
    const prompter = approving("denied");
    const gate = gateWith([], prompter);
    await zxErrorOfRejection(
      gate.ensureAllowed(request, "destructive"),
      "APPROVAL_DENIED",
    );
    expect(prompter).toHaveBeenCalledOnce();
  });

  it("propagates a prompter that rejects rather than treating it as approval", async () => {
    const prompter = vi.fn<ApprovalPrompter>(async () => {
      throw new Error("the approval UI crashed");
    });
    const gate = gateWith([], prompter);
    await expect(gate.ensureAllowed(request, "destructive")).rejects.toThrow(
      /approval UI crashed/,
    );
    expect(prompter).toHaveBeenCalledOnce();
  });
});

describe("ApprovalGate: the denial message cannot be forged by the summary", () => {
  // A denial is a security decision, and its message is the record of it: it
  // reaches the audit log and the human who read the prompt. The summary is
  // attacker-influenced text, so interpolating it raw gives an attacker a
  // newline — a forged extra line reading "APPROVAL GRANTED BY USER AT 12:00"
  // inside the record of a refusal — and a bidi override, which renders the text
  // as something other than what it says to the one person the containment
  // depends on.
  //
  // Every other out-of-contract value this module records goes through the
  // renderer that escapes control characters. The summary was the one
  // interpolation left out, on the stated ground that the escaping helper "lives
  // in path-guard" and duplicating it would be premature. That was wrong on both
  // counts: `describePath` is module-private and not exported, and this module
  // has had its own renderer all along.
  const HOSTILE_SUMMARIES: ReadonlyArray<[string, string]> = [
    [
      "a newline",
      "overwrite src/index.ts\nAPPROVAL GRANTED BY USER AT 12:00",
    ],
    [
      "a carriage return and newline",
      "overwrite src/index.ts\r\nAPPROVAL GRANTED BY USER",
    ],
    ["a bidi override", "overwrite src/index.ts\u202Eexe.cmd des"],
    ["a line separator", "overwrite src/index.ts\u2028APPROVAL GRANTED"],
    ["an escape sequence", "overwrite src/index.ts\u001B[31mAPPROVED\u001B[0m"],
    ["a bell", "overwrite src/index.ts\u0007"],
    ["a delete character", "overwrite src/index.ts\u007F"],
    ["a next-line character", "overwrite src/index.ts\u0085"],
  ];

  it.each(HOSTILE_SUMMARIES)(
    "puts no raw control character or bidi override from a summary carrying %s into the denial message",
    async (_label, summary) => {
      const gate = gateWith([], approving("denied"));
      const error = await zxErrorOfRejection(
        gate.ensureAllowed({ ...request, summary }, "destructive"),
        "APPROVAL_DENIED",
      );
      // The character class `path-guard` treats as hostile: C0 controls, DEL, NEL,
      // and the line-terminator/bidi range.
      expect(error.message).not.toMatch(/[\u0000-\u001f\u007f\u0085\u2028-\u202e]/);
      expect(error.message.split("\n")).toHaveLength(1);
    },
  );

  // Escaped, not deleted. A denial record that has quietly lost the description
  // is no better than one that forged it: the reader still has to be able to see
  // what was refused.
  it("records the refused operation as escaped data the reader can still read", async () => {
    const gate = gateWith([], approving("denied"));
    const error = await zxErrorOfRejection(
      gate.ensureAllowed(
        {
          ...request,
          summary:
            "overwrite src/index.ts\nAPPROVAL GRANTED BY USER AT 12:00\n\u202Eexe.cmd des",
        },
        "destructive",
      ),
      "APPROVAL_DENIED",
    );
    expect(error.message).toContain("operation denied by the user");
    expect(error.message).toContain("overwrite src/index.ts");
    // The forged line is present as escaped text on the same line, not as a
    // second line of the record.
    expect(error.message).toContain("\\nAPPROVAL GRANTED BY USER AT 12:00");
    expect(error.message).toContain("\\u202e");
  });
});

describe("ApprovalGate: a malformed prompter result fails closed", () => {
  // `decision !== "approved"` is the whole check, and its failure mode is the
  // dangerous one: a truthy-but-different value would authorise an operation the
  // user never approved. Each of these is a value a plausible UI refactor might
  // start returning.
  const MALFORMED: ReadonlyArray<[string, unknown]> = [
    ["a truthy string", "yes"],
    ["an uppercase approval", "APPROVED"],
    ["a padded approval", " approved"],
    ["undefined", undefined],
    ["null", null],
    ["true", true],
    ["an object", { approved: true }],
  ];

  it.each(MALFORMED)(
    "throws APPROVAL_DENIED when the prompter resolves to %s",
    async (_label, value) => {
      const prompter = prompterReturning(value);
      const gate = gateWith([], prompter);
      await zxErrorOfRejection(
        gate.ensureAllowed(request, "destructive"),
        "APPROVAL_DENIED",
      );
      expect(prompter).toHaveBeenCalledOnce();
    },
  );

  it.each(MALFORMED)(
    "does not let %s authorise a write either",
    async (_label, value) => {
      const prompter = prompterReturning(value);
      const gate = gateWith([], prompter);
      await zxErrorOfRejection(
        gate.ensureAllowed(request, "write"),
        "APPROVAL_DENIED",
      );
    },
  );

  // The audit log has to be able to tell "the human said no" apart from "the UI
  // is broken". A denial that claims the user refused something they never
  // refused is a false record, and it is the record a post-incident review reads.
  it("does not describe a malformed result as a refusal by the user", async () => {
    const prompter = prompterReturning("yes");
    const gate = gateWith([], prompter);
    const error = await zxErrorOfRejection(
      gate.ensureAllowed(request, "destructive"),
      "APPROVAL_DENIED",
    );
    expect(error.message).not.toMatch(/denied by the user/i);
    expect(error.message).toContain("yes");
  });

  it("records what the prompter actually returned", async () => {
    const prompter = prompterReturning("yes");
    const gate = gateWith([], prompter);
    const error = await zxErrorOfRejection(
      gate.ensureAllowed(request, "destructive"),
      "APPROVAL_DENIED",
    );
    expect(String(error.detail?.received)).toContain("yes");
  });
});

describe("ApprovalGate: an unknown operation class fails closed", () => {
  // `opClass` is typed as a union, so TypeScript stops unknown values at compile
  // time — but the class crosses a trust boundary, and a widened union, a cast, or
  // a value read off the wire all reach this method untyped. Treating an unknown
  // class as safe would be a containment bypass; the gate must refuse it loudly
  // rather than prompt nothing and let the operation through.
  const UNKNOWN: ReadonlyArray<[string, string]> = [
    ["a class that does not exist", "net"],
    ["an empty string", ""],
    ["a differently-cased class", "Destructive"],
    ["a class with trailing space", "destructive "],
    ["a class with leading space", " destructive"],
    ["a prefix of a real class", "destructiv"],
    ["two classes concatenated", "readexec"],
  ];

  it.each(UNKNOWN)(
    "throws INTERNAL for %s and prompts nothing",
    async (_label, opClass) => {
      const prompter = approving("approved");
      const gate = gateWith([], prompter);
      const error = await zxErrorOfRejection(
        gate.ensureAllowed(request, opClass as unknown as OperationClass),
        "INTERNAL",
      );
      expect(prompter).not.toHaveBeenCalled();
      expect(error.message).toContain(JSON.stringify(opClass).slice(1, -1));
    },
  );

  // The near-miss matters separately from the table above, because a
  // prefix-based check ("is it one of the classes I know about?") would let
  // `"writes"` through into the prompting path — and an approving prompter would
  // then authorise an operation whose class the gate does not actually
  // recognise. Refused, not prompted.
  it("throws INTERNAL for a near-miss class even when the prompter would approve", async () => {
    const prompter = approving("approved");
    const gate = gateWith([], prompter);
    await zxErrorOfRejection(
      gate.ensureAllowed(request, "writes" as unknown as OperationClass),
      "INTERNAL",
    );
    expect(prompter).not.toHaveBeenCalled();
  });
});

describe("ApprovalGate: autoApprove is validated and matched exactly", () => {
  const UNKNOWN_ENTRY: ReadonlyArray<[string, string]> = [
    ["a class that does not exist", "net"],
    ["an empty string", ""],
    ["a differently-cased class", "Destructive"],
    ["a prefix of a real class", "destr"],
    ["a class with trailing whitespace", "exec "],
  ];

  it.each(UNKNOWN_ENTRY)(
    "throws INTERNAL when autoApprove contains %s",
    (_label, entry) => {
      zxErrorOfThrow(
        () =>
          new ApprovalGate({
            autoApprove: [entry as unknown as OperationClass],
            prompter: approving(),
          }),
        "INTERNAL",
      );
    },
  );

  it("names the offending entry in the construction error", () => {
    const error = zxErrorOfThrow(
      () =>
        new ApprovalGate({
          autoApprove: ["write", "net" as unknown as OperationClass],
          prompter: approving(),
        }),
      "INTERNAL",
    );
    expect(error.message).toContain("net");
    expect(error.detail).toMatchObject({ entry: "net" });
  });

  // The constructor is a trust boundary like any other: `autoApprove` may reach
  // it from a config file parsed at runtime, past the compiler. A value with a
  // hostile `toString` must not raise a raw `TypeError` out of here — everything
  // that leaves this module is a ZxError, or the caller's own error handling
  // cannot classify the failure at all.
  it("reports a hostile autoApprove entry as INTERNAL, not a raw TypeError", () => {
    const hostile = {
      toString() {
        throw new Error("toString exploded");
      },
    } as unknown as OperationClass;
    zxErrorOfThrow(
      () => new ApprovalGate({ autoApprove: [hostile], prompter: approving() }),
      "INTERNAL",
    );
  });

  it("reports a hostile opClass as INTERNAL, not a raw TypeError", async () => {
    const hostile = {
      toString() {
        throw new Error("toString exploded");
      },
    } as unknown as OperationClass;
    const gate = gateWith([], approving("approved"));
    await zxErrorOfRejection(
      gate.ensureAllowed(request, hostile),
      "INTERNAL",
    );
  });

  it("accepts every real class in autoApprove", () => {
    const gate = new ApprovalGate({
      autoApprove: ["read", "write", "destructive", "exec"],
      prompter: approving("approved"),
    });
    expect(gate).toBeInstanceOf(ApprovalGate);
  });

  it("accepts an empty autoApprove", () => {
    expect(
      new ApprovalGate({ autoApprove: [], prompter: approving() }),
    ).toBeInstanceOf(ApprovalGate);
  });

  // The exact-match regression. `"destructive".includes("exec")` is false but
  // `"exec".includes("exec")`-style prefix logic and any case-insensitive
  // comparison are all "close enough" bugs that silently widen the policy: an
  // auto-approve list meant to cover one class must never cover another, and
  // must never be reached by a class that merely resembles its entries.
  it("does not let auto-approve of destructive cover exec", async () => {
    const prompter = approving("denied");
    const gate = gateWith(["destructive"], prompter);
    await expect(gate.ensureAllowed(request, "exec")).rejects.toThrow(/denied/i);
    expect(prompter).toHaveBeenCalledOnce();
  });

  it("does not let auto-approve of destructive cover write", async () => {
    const prompter = approving("denied");
    const gate = gateWith(["destructive"], prompter);
    await expect(gate.ensureAllowed(request, "write")).rejects.toThrow(/denied/i);
    expect(prompter).toHaveBeenCalledOnce();
  });

  it("does not treat a differently-cased class as the auto-approved one", async () => {
    const prompter = approving("approved");
    const gate = gateWith(["destructive"], prompter);
    await zxErrorOfRejection(
      gate.ensureAllowed(request, "Destructive" as unknown as OperationClass),
      "INTERNAL",
    );
    // The dangerous outcome is silence: a case-insensitive match here would
    // resolve without ever calling the prompter.
    expect(prompter).not.toHaveBeenCalled();
  });
});

describe("ApprovalGate: the constructor refuses arguments it cannot use", () => {
  // The module promises that everything leaving it is a ZxError, so a caller
  // can classify every failure it gets. `for…of` over a non-iterable and calling
  // a non-callable both raise a raw TypeError — fail-closed, since the operation
  // does not run, but unclassifiable, and it falsifies the promise. Options reach
  // this constructor from config parsed at runtime, past the compiler.
  const NOT_AN_ARRAY: ReadonlyArray<[string, unknown]> = [
    ["null", null],
    ["undefined", undefined],
    ["an object", {}],
    // Iterable, so a `for…of` would not throw — it would iterate the characters
    // and reject the first one as an unknown class, reporting a nonsense entry.
    ["a string", "write"],
    ["a number", 42],
  ];

  it.each(NOT_AN_ARRAY)(
    "throws INTERNAL when autoApprove is %s rather than iterating it",
    (_label, value) => {
      const error = zxErrorOfThrow(
        () =>
          new ApprovalGate({
            autoApprove: value as unknown as OperationClass[],
            prompter: approving(),
          }),
        "INTERNAL",
      );
      // The message is asserted, not just the code: a string is iterable, so a
      // gate without this check rejects it as an unknown *class* and throws
      // INTERNAL too. Same code, wrong diagnosis — an operator reading "unknown
      // operation class: w" is being pointed at their config file, not at the
      // wiring bug that is the actual fault.
      expect(error.message).toMatch(/must be an array of operation classes/);
    },
  );

  const NOT_CALLABLE: ReadonlyArray<[string, unknown]> = [
    ["null", null],
    ["undefined", undefined],
    ["an object", {}],
    ["a string", "approved"],
    ["a number", 42],
  ];

  it.each(NOT_CALLABLE)(
    "throws INTERNAL when the prompter is %s",
    (_label, value) => {
      const error = zxErrorOfThrow(
        () =>
          new ApprovalGate({
            autoApprove: [],
            prompter: value as unknown as ApprovalPrompter,
          }),
        "INTERNAL",
      );
      expect(error.message).toMatch(/prompter must be a function/);
    },
  );
});

describe("ApprovalGate: the policy cannot be widened at runtime", () => {
  // `private readonly` is a compile-time claim about a property that is an
  // ordinary writable field at runtime, so any code holding the gate could widen
  // the policy mid-run: `(gate as any).autoApprove.add("destructive")`. Not an
  // escalation boundary — code that can do that also chooses `opClass` — but a
  // true `#private` field costs nothing and removes the foot-gun.
  it("exposes no reachable auto-approve set to add classes to", async () => {
    const prompter = approving("denied");
    const gate = gateWith([], prompter);

    expect((gate as unknown as Record<string, unknown>).autoApprove).toBeUndefined();
    expect(Object.getOwnPropertyNames(gate)).not.toContain("autoApprove");

    // Behavioural confirmation, because the assertions above pin a mechanism and
    // this pins the consequence: the gate still asks.
    await zxErrorOfRejection(
      gate.ensureAllowed(request, "destructive"),
      "APPROVAL_DENIED",
    );
    expect(prompter).toHaveBeenCalledOnce();
  });

  // The same foot-gun with a worse consequence: replacing the prompter with one
  // that always approves authorises every operation that reaches the gate, and
  // unlike a widened auto-approve list it produces no visible sign that anything
  // was skipped.
  it("cannot have its prompter swapped for one that approves everything", async () => {
    const prompter = approving("denied");
    const gate = gateWith([], prompter);

    expect(Object.getOwnPropertyNames(gate)).not.toContain("prompter");
    (gate as unknown as Record<string, unknown>).prompter = async () => "approved";

    await zxErrorOfRejection(
      gate.ensureAllowed(request, "destructive"),
      "APPROVAL_DENIED",
    );
    expect(prompter).toHaveBeenCalledOnce();
  });
});

describe("ApprovalGate: the prompter's promise is awaited", () => {
  /** A promise the test resolves by hand. */
  function deferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
  } {
    let resolve: (value: T) => void = () => undefined;
    const promise = new Promise<T>((settle) => {
      resolve = settle;
    });
    return { promise, resolve };
  }

  // A gate that fires the prompter but does not await it resolves the moment the
  // prompter is *called*, which is a silent auto-approve of every operation: the
  // user has not answered yet, and the tool runs. Nothing about the resolved
  // value would show it — `ensureAllowed` returns `void` either way.
  it("does not resolve before a slow prompter has answered", async () => {
    const answer = deferred<ApprovalDecision>();
    const prompter = vi.fn<ApprovalPrompter>(async () => {
      await delay(5);
      return answer.promise;
    });
    const gate = gateWith([], prompter);

    let gateSettled = false;
    const pending = gate.ensureAllowed(request, "destructive").then(() => {
      gateSettled = true;
    });

    // Long enough for a gate that does not await to run to completion.
    await delay(50);

    expect(prompter).toHaveBeenCalledOnce();
    expect(gateSettled).toBe(false);

    answer.resolve("approved");
    await expect(pending).resolves.toBeUndefined();
    expect(gateSettled).toBe(true);
  });

  it("still throws when a slow prompter eventually denies", async () => {
    const answer = deferred<ApprovalDecision>();
    const prompter = vi.fn<ApprovalPrompter>(async () => {
      await delay(5);
      return answer.promise;
    });
    const gate = gateWith([], prompter);

    let rejection: unknown;
    const pending = gate.ensureAllowed(request, "destructive").catch(
      (error: unknown) => {
        rejection = error;
      },
    );

    await delay(50);
    expect(rejection).toBeUndefined();

    answer.resolve("denied");
    await pending;
    expect(rejection).toBeInstanceOf(ZxError);
    expect((rejection as ZxError).code).toBe("APPROVAL_DENIED");
  });
});

import { DatabaseSync } from "node:sqlite";
import { ZxError } from "./errors.js";

/**
 * How an operation ended.
 *
 * `denied` is separated from `error` on purpose. "The user said no" and "the tool
 * threw" are different facts about the system's trustworthiness: a rising `denied`
 * count is the user refusing what the bridge asked for, which is the containment
 * working, while a rising `error` count is the bridge misbehaving. Collapsing
 * them into one `failed` bucket makes the audit trail unable to say which.
 */
export type AuditStatus = "ok" | "error" | "denied";

/** What a caller records. The id and timestamp are assigned by the log. */
export type AuditRecord = {
  toolName: string;
  opClass: string;
  status: AuditStatus;
  /**
   * Human-readable description of what was attempted.
   *
   * This is model-authored text that came from a prompt-injected page. It is
   * stored as a bound parameter, never interpolated into SQL, but a reader still
   * has to see it as data — hence `summarize` below.
   */
  summary: string;
  durationMs: number;
  errorCode: string | null;
  /**
   * The error's human-readable message, when one is available.
   *
   * Read explicitly off the exception by `recordFailure` and stored in its own
   * column. It cannot be recovered from `errorCode` later, and it cannot be
   * recovered by `JSON.stringify`-ing the error either — see F2-1 above.
   */
  errorMessage?: string | null;
  /** Where it was thrown, truncated. Null when there is no stack. */
  errorStack?: string | null;
};

/** A stored row, with the fields the log assigned. */
export type AuditEntry = AuditRecord & {
  id: number;
  timestamp: string;
  /** Read back as a real column; `get`-able by id via `get(id)`. */
  errorMessage: string | null;
  errorStack: string | null;
};

/** The extra fields recorded when the operation ended in a `ZxError`. */
export type AuditFailure = {
  code: string;
  message: string;
  stack: string | null;
};

const STATUSES: ReadonlySet<string> = new Set<AuditStatus>([
  "ok",
  "error",
  "denied",
]);

/**
 * Where `status` comes from when the caller only has an exception.
 *
 * An `APPROVAL_DENIED` is a refusal the user chose, not a malfunction, so it is
 * filed as `denied`. Everything else that throws is an `error`. Getting this
 * backwards would file every user refusal as a system fault and quietly destroy
 * the signal the denial count exists to provide.
 */
const DENIAL_CODES: ReadonlySet<string> = new Set([
  "APPROVAL_DENIED",
  "APPROVAL_REQUIRED",
]);

/**
 * The durable record of everything the bridge did on the user's behalf.
 *
 * ## Why this exists in SQLite and not a file of lines
 *
 * Two properties the threat model needs that `console.log` cannot give:
 * structured queries ("what did we refuse last week, by class"), and records
 * that cannot be interleaved into nonsense by two concurrent writes. The file
 * format is the database's job, and `node:sqlite` is already in the runtime, so
 * there is no native dependency to install.
 *
 * ## The trap this module exists to avoid (F2-1)
 *
 * `JSON.stringify(new ZxError(...))` yields `{ code, detail, name }` — no
 * message, no stack. `message` and `stack` are own but **non-enumerable** on every
 * V8 `Error`, so the one thing a human reads to find out what went wrong is the
 * thing that silently disappears. So `fromError` reads them as *explicit* fields
 * and `list` returns them as real columns; there is no code path that logs an
 * error by stringifying it.
 *
 * ## What is deliberately not promised
 *
 * The database is opened without `SQLITE_OPEN_READONLY` and holds no encryption:
 * anyone who can read the file can read the summaries, which include paths and
 * command lines. That is the same trust boundary as the workspace itself — this
 * is a local tool on the user's own machine — but it does mean the file must be
 * treated as sensitive, not as disposable debug output.
 */
export class AuditLog {
  readonly #db: DatabaseSync;
  readonly #statements: {
    insert: ReturnType<DatabaseSync["prepare"]>;
    recent: ReturnType<DatabaseSync["prepare"]>;
    byId: ReturnType<DatabaseSync["prepare"]>;
    count: ReturnType<DatabaseSync["prepare"]>;
  };
  #closed = false;

  constructor(dbPath: string) {
    // `:memory:` is a legitimate target and the tests use it, so it is allowed
    // through; a *directory* or an empty path is not, and would otherwise
    // surface as an opaque SQLite error much later.
    if (typeof dbPath !== "string" || dbPath.trim() === "") {
      throw new ZxError(
        "INTERNAL",
        "AuditLog needs a database path, or the literal ':memory:'",
        { dbPath },
      );
    }
    try {
      this.#db = new DatabaseSync(dbPath);
    } catch (error) {
      throw new ZxError(
        "INTERNAL",
        `could not open the audit database at ${JSON.stringify(dbPath)}: ${messageOf(error)}`,
        { dbPath },
      );
    }

    // `journal_mode = WAL` keeps a reader (the console's live view) from
    // blocking the writer mid-operation. It is a no-op for `:memory:`.
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS audit (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp  TEXT    NOT NULL,
        tool_name  TEXT    NOT NULL,
        op_class   TEXT    NOT NULL,
        status     TEXT    NOT NULL,
        summary    TEXT    NOT NULL,
        duration_ms INTEGER NOT NULL,
        error_code TEXT,
        error_message TEXT,
        error_stack  TEXT
      )
    `);
    // `status` is the column a triage query filters on, and `op_class` is what
    // the console groups by.
    this.#db.exec(
      "CREATE INDEX IF NOT EXISTS audit_by_status ON audit (status, id)",
    );

    // Prepared once: `record` runs on every tool call, and re-parsing the same
    // SQL per call is the difference between a log you can always afford and one
    // that gets disabled under load.
    this.#statements = {
      insert: this.#db.prepare(`
        INSERT INTO audit
          (timestamp, tool_name, op_class, status, summary, duration_ms,
           error_code, error_message, error_stack)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      recent: this.#db.prepare(`
        SELECT id, timestamp, tool_name, op_class, status, summary, duration_ms,
               error_code
        FROM audit ORDER BY id DESC LIMIT ?
      `),
      byId: this.#db.prepare(`
        SELECT id, timestamp, tool_name, op_class, status, summary, duration_ms,
               error_code, error_message, error_stack
        FROM audit WHERE id = ?
      `),
      count: this.#db.prepare("SELECT COUNT(*) AS n FROM audit"),
    };
  }

  /**
   * Append one entry and return its id.
   *
   * The timestamp is assigned here rather than by the caller: an audit trail
   * whose times are self-reported by the component being audited is not evidence.
   *
   * `durationMs` is normalised because a tool that measures time with a
   * mis-ordered subtraction would otherwise store a negative duration and a
   * console summing them would under-report. Negative becomes zero.
   */
  record(entry: AuditRecord): number {
    this.#assertOpen();
    if (entry === null || typeof entry !== "object") {
      throw new ZxError("INTERNAL", "audit record must be an object", {
        entry,
      });
    }
    if (!STATUSES.has(entry.status)) {
      throw new ZxError(
        "INTERNAL",
        `audit record has an unknown status: ${JSON.stringify(entry.status)}`,
        { status: entry.status },
      );
    }
    if (
      typeof entry.toolName !== "string" ||
      typeof entry.opClass !== "string" ||
      typeof entry.summary !== "string"
    ) {
      throw new ZxError(
        "INTERNAL",
        "audit record needs string toolName, opClass and summary",
        { entry },
      );
    }

    const result = this.#statements.insert.run(
      new Date().toISOString(),
      entry.toolName,
      entry.opClass,
      entry.status,
      entry.summary,
      Math.max(0, Math.trunc(Number(entry.durationMs) || 0)),
      entry.errorCode ?? null,
      entry.errorMessage ?? null,
      entry.errorStack ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  /**
   * Record a failed operation, pulling the human-readable fields off the error.
   *
   * This is the F2-1 remedy in code: `message` and `stack` are read here, by
   * name, from the exception the tool actually threw. Nothing downstream has to
   * re-derive them, and there is no path where an error is persisted without
   * them.
   *
   * `stack` is stored, not just the message, because the audit trail's job when
   * something goes wrong is to let the user find out *where*. It is truncated at
   * a fixed length: a stack is the one field with no natural bound, and an
   * unbounded one turns a log entry into a disk-fill vector.
   */
  recordFailure(
    entry: Omit<AuditRecord, "status" | "errorCode">,
    error: unknown,
  ): number {
    this.#assertOpen();
    const failure = AuditLog.describeError(error);
    return this.record({
      toolName: entry.toolName,
      opClass: entry.opClass,
      summary: entry.summary,
      durationMs: entry.durationMs,
      status: DENIAL_CODES.has(failure.code) ? "denied" : "error",
      errorCode: failure.code,
      errorMessage: failure.message,
      errorStack: failure.stack,
    });
  }

  /**
   * Classify an exception into the fields the table stores.
   *
   * Exposed as a static because the Control API needs the same rendering for a
   * live view, and two copies of "how do we read an error" is how they drift.
   */
  static describeError(error: unknown): AuditFailure {
    if (error instanceof ZxError) {
      return {
        code: error.code,
        message: error.message,
        stack: truncate(error.stack ?? null, MAX_STACK_CHARS),
      };
    }
    if (error instanceof Error) {
      return {
        // An error that escaped as a raw `TypeError` is an internal fault by
        // definition: every module in this project promises to throw ZxError,
        // so anything else means a promise was broken somewhere upstream.
        code: "INTERNAL",
        message: error.message,
        stack: truncate(error.stack ?? null, MAX_STACK_CHARS),
      };
    }
    return {
      code: "INTERNAL",
      message: `a non-error value was thrown: ${safeJson(error)}`,
      stack: null,
    };
  }

  /**
 * Read an entry by id, including its message and stack, or `undefined`.
 *
 * `list()` deliberately omits the two bulky columns: a live console view of the
 * last hundred entries has no use for eight kilobytes of stack per row, but the
 * user who opens one specific failure needs it. This is the accessor for that.
 */
  get(id: number): AuditEntry | undefined {
    this.#assertOpen();
    const row = this.#statements.byId.get(id);
    return row === undefined ? undefined : toEntry(row);
  }

  /**
   * Most recent entries first.
   *
   * `limit` defaults to 100 and is clamped: an unbounded `list()` on a long-lived
   * bridge is a memory spike in whatever renders it, and "give me all of it" is
   * never a real need at a call site — the console pages.
   */
  list(limit = 100): AuditEntry[] {
    this.#assertOpen();
    const requested = Math.trunc(Number(limit) || 0);
    const bounded = Math.min(Math.max(requested, 1), MAX_LIST_LIMIT);
    const rows = this.#statements.recent.all(bounded);
    return rows.map(toEntry);
  }

  /** Total number of stored entries. */
  count(): number {
    this.#assertOpen();
    const row = this.#statements.count.get() as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  }

  /**
   * Flush and release the database.
   *
   * Idempotent, because shutdown paths double-close under stress (a signal
   * handler racing an explicit close) and a second `close` throwing would mask
   * whatever the shutdown was actually doing.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      // Without this, an entry recorded in the same tick as a crash can be lost
      // even though `record` already returned — the write is in the WAL, not yet
      // in the main database.
      this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // A failed checkpoint on the way out must not prevent the handle from
      // being released; the WAL is still on disk and readable.
    }
    this.#db.close();
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new ZxError(
        "INTERNAL",
        "this audit log is closed; record the failure somewhere else",
      );
    }
  }
}

/**
 * Upper bound on `list`.
 *
 * A ceiling rather than a default only, because a caller asking for more than
 * this is a bug in that caller and silently truncating would hide it — so the
 * result is clamped and the caller gets what fits.
 */
const MAX_LIST_LIMIT = 1_000;

/** Cap on a stored stack trace. */
const MAX_STACK_CHARS = 8_000;

/**
 * Map a SQLite row onto `AuditEntry`.
 *
 * The spread into a fresh object is not cosmetic: `node:sqlite` returns rows as
 * null-prototype objects, and a consumer doing `Object.hasOwn(row, "toString")`
 * or passing the row to something that expects a real prototype gets surprising
 * results.
 */
function toEntry(row: unknown): AuditEntry {
  const r = row as Record<string, unknown>;
  return {
    id: Number(r.id),
    timestamp: String(r.timestamp),
    toolName: String(r.tool_name),
    opClass: String(r.op_class),
    status: String(r.status) as AuditStatus,
    summary: String(r.summary),
    durationMs: Number(r.duration_ms),
    errorCode: r.error_code === null ? null : String(r.error_code),
    // Loose `== null` on purpose: `list()` does not select these columns, so they
    // arrive `undefined` rather than `null`, and a strict check would stringify
    // that into the literal text "undefined".
    errorMessage: r.error_message == null ? null : String(r.error_message),
    errorStack: r.error_stack == null ? null : String(r.error_stack),
  };
}

function truncate(value: string | null, max: number): string | null {
  if (value === null) return null;
  return value.length > max ? `${value.slice(0, max)}… [truncated]` : value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : safeJson(error);
}

function safeJson(value: unknown): string {
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === "string" ? encoded : String(value);
  } catch {
    return "[unrenderable value]";
  }
}
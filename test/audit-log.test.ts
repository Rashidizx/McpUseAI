import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { AuditLog } from "../src/core/audit-log.js";
import { ZxError } from "../src/core/errors.js";
import { makeTempWorkspace, cleanupTempDirs } from "./helpers.js";

afterEach(cleanupTempDirs);

function dbPath(): string {
  return join(makeTempWorkspace(), "audit.db");
}

const ok = {
  toolName: "fs_read",
  opClass: "read",
  status: "ok" as const,
  summary: "read src/index.ts",
  durationMs: 3,
  errorCode: null,
};

describe("AuditLog — writing and reading", () => {
  it("records an entry and reads it back", () => {
    const log = new AuditLog(dbPath());
    const id = log.record(ok);
    expect(id).toBe(1);
    const rows = log.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.toolName).toBe("fs_read");
    expect(rows[0]?.status).toBe("ok");
    expect(rows[0]?.durationMs).toBe(3);
    log.close();
  });

  it("assigns the timestamp itself rather than trusting the caller", () => {
    const log = new AuditLog(":memory:");
    log.record(ok);
    const stamp = log.list()[0]?.timestamp ?? "";
    log.close();
    // A self-reported time is not evidence, so the field is not caller-supplied.
    expect(Number.isNaN(Date.parse(stamp))).toBe(false);
  });

  it("returns rows as plain objects, not null-prototype SQLite rows", () => {
    const log = new AuditLog(":memory:");
    log.record(ok);
    const row = log.list()[0];
    log.close();
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
  });

  it("persists across reopen", () => {
    const path = dbPath();
    const first = new AuditLog(path);
    first.record(ok);
    first.close();

    const second = new AuditLog(path);
    expect(second.count()).toBe(1);
    expect(second.list()[0]?.toolName).toBe("fs_read");
    second.close();
  });

  it("orders most recent first", () => {
    const log = new AuditLog(":memory:");
    log.record({ ...ok, summary: "first" });
    log.record({ ...ok, summary: "second" });
    expect(log.list().map((r) => r.summary)).toEqual(["second", "first"]);
    log.close();
  });

  it("honours an explicit limit", () => {
    const log = new AuditLog(":memory:");
    for (let i = 0; i < 5; i++) log.record({ ...ok, summary: `op-${i}` });
    expect(log.list(2)).toHaveLength(2);
    log.close();
  });

  it("clamps a limit above the ceiling instead of allocating it", () => {
    const log = new AuditLog(":memory:");
    log.record(ok);
    expect(log.list(10_000_000)).toHaveLength(1);
    log.close();
  });

  it("stores a summary containing quotes as data, not as SQL", () => {
    const log = new AuditLog(":memory:");
    const hostile = "read x'); DROP TABLE audit; --";
    log.record({ ...ok, summary: hostile });
    expect(log.list()[0]?.summary).toBe(hostile);
    expect(log.count()).toBe(1);
    log.close();
  });
});

describe("AuditLog — F2-1: the message survives", () => {
  it("demonstrates that JSON.stringify would have lost the message", () => {
    // The reason this whole design note exists. If this assertion ever stops
    // holding, the workaround is no longer needed; if it is removed by accident,
    // a future maintainer may reintroduce the stringify path believing it safe.
    const err = new ZxError("PATH_OUTSIDE_SANDBOX", "escape attempt");
    expect(JSON.stringify(err)).not.toContain("escape attempt");
    expect(JSON.parse(JSON.stringify(err))).not.toHaveProperty("message");
  });

  it("stores a ZxError's code, message and stack as explicit columns", () => {
    const log = new AuditLog(dbPath());
    log.recordFailure(
      { toolName: "fs_read", opClass: "read", summary: "read /etc/shadow", durationMs: 1 },
      new ZxError("PATH_OUTSIDE_SANDBOX", "escape attempt", { path: "/etc/shadow" }),
    );
    const id = log.list()[0]?.id as number;
    const row = log.get(id);
    log.close();
    expect(row?.errorCode).toBe("PATH_OUTSIDE_SANDBOX");
    expect(row?.errorMessage).toBe("escape attempt");
    expect(row?.errorStack).toContain("ZxError");
  });

  it("files a user refusal as denied, not as a system error", () => {
    const log = new AuditLog(":memory:");
    log.recordFailure(
      { toolName: "exec", opClass: "exec", summary: "rm -rf /", durationMs: 5 },
      new ZxError("APPROVAL_DENIED", "operation denied by the user"),
    );
    expect(log.list()[0]?.status).toBe("denied");
    log.close();
  });

  it("files anything else that throws as an error", () => {
    const log = new AuditLog(":memory:");
    log.recordFailure(
      { toolName: "fs_write", opClass: "write", summary: "write a.txt", durationMs: 2 },
      new ZxError("FILE_EXISTS", "a.txt already exists"),
    );
    expect(log.list()[0]?.status).toBe("error");
    log.close();
  });

  it("treats a raw TypeError as the internal fault it is", () => {
    const log = new AuditLog(":memory:");
    log.recordFailure(
      { toolName: "exec", opClass: "exec", summary: "run x", durationMs: 1 },
      new TypeError("cannot read properties of undefined"),
    );
    const row = log.get(log.list()[0]!.id);
    log.close();
    expect(row?.errorCode).toBe("INTERNAL");
    expect(row?.errorMessage).toContain("cannot read properties");
  });

  it("records a thrown non-error without throwing itself", () => {
    const log = new AuditLog(":memory:");
    log.recordFailure(
      { toolName: "exec", opClass: "exec", summary: "run x", durationMs: 1 },
      "just a string",
    );
    const row = log.get(log.list()[0]!.id);
    log.close();
    expect(row?.status).toBe("error");
    expect(row?.errorMessage).toContain("just a string");
  });

  it("truncates an unbounded stack rather than letting it fill the disk", () => {
    const log = new AuditLog(":memory:");
    const huge = new Error("x");
    huge.stack = "y".repeat(100_000);
    log.recordFailure(
      { toolName: "exec", opClass: "exec", summary: "run x", durationMs: 1 },
      huge,
    );
    const row = log.get(log.list()[0]!.id);
    log.close();
    expect(row?.errorStack?.length).toBeLessThan(10_000);
    expect(row?.errorStack).toContain("truncated");
  });

  it("omits the bulky columns from list but keeps them on get", () => {
    const log = new AuditLog(":memory:");
    log.recordFailure(
      { toolName: "exec", opClass: "exec", summary: "run x", durationMs: 1 },
      new ZxError("TIMEOUT", "took too long"),
    );
    const listed = log.list()[0];
    const fetched = log.get(listed!.id);
    log.close();
    expect(listed?.errorMessage).toBeNull();
    expect(fetched?.errorMessage).toBe("took too long");
  });
});

describe("AuditLog — refusing bad input", () => {
  it("rejects an unknown status instead of storing it", () => {
    const log = new AuditLog(":memory:");
    expect(() =>
      log.record({ ...ok, status: "probably-fine" as never }),
    ).toThrow(/unknown status/);
    expect(log.count()).toBe(0);
    log.close();
  });

  it("rejects a record with missing text fields", () => {
    const log = new AuditLog(":memory:");
    expect(() =>
      log.record({ ...ok, toolName: undefined as never }),
    ).toThrow(/needs string/);
    log.close();
  });

  it("normalises a negative or fractional duration", () => {
    const log = new AuditLog(":memory:");
    log.record({ ...ok, durationMs: -40 });
    log.record({ ...ok, durationMs: 12.9 });
    const rows = [...log.list()].reverse();
    log.close();
    expect(rows[0]?.durationMs).toBe(0);
    expect(rows[1]?.durationMs).toBe(12);
  });

  it("refuses an empty database path", () => {
    expect(() => new AuditLog("  ")).toThrow(/needs a database path/);
  });

  it("surfaces an unopenable path as a ZxError, not a raw SQLite error", () => {
    expect(() => new AuditLog(join(makeTempWorkspace(), "no", "such", "dir.db"))).toThrow(
      /could not open the audit database/,
    );
  });

  it("returns undefined for an unknown id", () => {
    const log = new AuditLog(":memory:");
    expect(log.get(9999)).toBeUndefined();
    log.close();
  });
});

describe("AuditLog — lifecycle", () => {
  it("is safe to close twice", () => {
    const log = new AuditLog(":memory:");
    log.close();
    expect(() => log.close()).not.toThrow();
  });

  it("refuses to record after close rather than throwing a driver error", () => {
    const log = new AuditLog(":memory:");
    log.close();
    expect(() => log.record(ok)).toThrow(/closed/);
  });

  it("reopens an existing database without wiping it", () => {
    const path = dbPath();
    const first = new AuditLog(path);
    first.record(ok);
    first.close();
    const second = new AuditLog(path);
    second.record({ ...ok, summary: "after reopen" });
    expect(second.count()).toBe(2);
    second.close();
  });
});
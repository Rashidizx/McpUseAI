import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createFsWrite } from "../src/tools/fs-write.js";
import { ZxError } from "../src/core/errors.js";
import { PathGuard } from "../src/core/path-guard.js";
import { ApprovalGate } from "../src/core/approval-gate.js";
import { AuditLog } from "../src/core/audit-log.js";
import { ToolRegistry } from "../src/core/tool-registry.js";
import { makeTempWorkspace, cleanupTempDirs } from "./helpers.js";

afterEach(cleanupTempDirs);

function tool(root: string): ReturnType<typeof createFsWrite> {
  return createFsWrite(new PathGuard(root));
}

function writeRegistry(root: string): {
  registry: ToolRegistry;
  prompts: () => number;
  audit: AuditLog;
} {
  const audit = new AuditLog(":memory:");
  let asked = 0;
  const gate = new ApprovalGate({
    autoApprove: [],
    prompter: async () => {
      asked++;
      return "approved";
    },
  });
  const guard = new PathGuard(root);
  const built = new ToolRegistry({ guard, gate, audit });
  built.register(createFsWrite(guard));
  return { registry: built, prompts: () => asked, audit };
}

describe("fs_write — creating", () => {
  it("creates a file and reports it", async () => {
    const root = makeTempWorkspace();
    const result = await tool(root).run({ file_path: "a.txt", content: "hello\n" });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("hello\n");
    expect(result.data).toMatchObject({ created: true, file_path: "a.txt" });
    expect(result.summary).toMatch(/^created/);
  });

  it("creates parent directories as needed", async () => {
    const root = makeTempWorkspace();
    await tool(root).run({ file_path: "deep/nested/dir/a.txt", content: "x" });
    expect(readFileSync(join(root, "deep", "nested", "dir", "a.txt"), "utf8")).toBe("x");
  });

  it("writes an empty file", async () => {
    const root = makeTempWorkspace();
    await tool(root).run({ file_path: "empty.txt", content: "" });
    expect(readFileSync(join(root, "empty.txt"), "utf8")).toBe("");
  });

  it("refuses to overwrite when create_only is set", async () => {
    const root = makeTempWorkspace();
    writeFileSync(join(root, "a.txt"), "original\n");
    await expect(
      tool(root).run({ file_path: "a.txt", content: "new\n", create_only: true }),
    ).rejects.toThrow(/already exists/);
    // The refusal must leave the original alone.
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("original\n");
  });

  it("creates normally when create_only is set and the file is new", async () => {
    const root = makeTempWorkspace();
    await tool(root).run({ file_path: "new.txt", content: "x", create_only: true });
    expect(existsSync(join(root, "new.txt"))).toBe(true);
  });
});

describe("fs_write — encoding is the file's business", () => {
  it("does not convert a CRLF file to LF", async () => {
    // The failure this prevents: a one-line edit turning into a diff that
    // touches every line of the file.
    const root = makeTempWorkspace();
    writeFileSync(join(root, "win.txt"), "a\r\nb\r\n");
    await tool(root).run({ file_path: "win.txt", content: "a\nb\nchanged\n" });
    expect(readFileSync(join(root, "win.txt"), "utf8")).toBe(
      "a\r\nb\r\nchanged\r\n",
    );
  });

  it("does not convert an LF file to CRLF", async () => {
    const root = makeTempWorkspace();
    writeFileSync(join(root, "unix.txt"), "a\nb\n");
    await tool(root).run({ file_path: "unix.txt", content: "a\nb\nc\n" });
    expect(readFileSync(join(root, "unix.txt"), "utf8")).toBe("a\nb\nc\n");
  });

  it("keeps a BOM on a file that had one", async () => {
    const root = makeTempWorkspace();
    writeFileSync(
      join(root, "bom.txt"),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a\n", "utf8")]),
    );
    await tool(root).run({ file_path: "bom.txt", content: "a\nb\n" });
    const written = readFileSync(join(root, "bom.txt"));
    expect(written.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(written.subarray(3).toString("utf8")).toBe("a\nb\n");
  });

  it("does not add a BOM to a file that had none", async () => {
    // An invisible U+FEFF appearing at the top of a file is a real diff, on the
    // first line, forever.
    const root = makeTempWorkspace();
    writeFileSync(join(root, "plain.txt"), "a\n");
    await tool(root).run({ file_path: "plain.txt", content: "a\nb\n" });
    expect(readFileSync(join(root, "plain.txt"))[0]).not.toBe(0xef);
  });

  it("writes a new file as UTF-8 without BOM and with LF", async () => {
    const root = makeTempWorkspace();
    await tool(root).run({ file_path: "new.txt", content: "a\r\nb" });
    const written = readFileSync(join(root, "new.txt"));
    expect(written[0]).not.toBe(0xef);
    expect(written.toString("utf8")).toBe("a\nb");
  });

  it("keeps the file's own convention even when the content arrives CRLF", async () => {
    // The file was LF, so LF wins even though the incoming content was CRLF.
    // "The file decides" is the whole rule: a caller that hands us CRLF text is
    // not a reason to reformat the user's file.
    const root = makeTempWorkspace();
    writeFileSync(join(root, "mixed.txt"), "a\nb\n");
    await tool(root).run({ file_path: "mixed.txt", content: "a\r\nb\r\nc\r\n" });
    const text = readFileSync(join(root, "mixed.txt"), "utf8");
    expect(text).toBe("a\nb\nc\n");
    expect(text).not.toContain("\r");
  });

  it("never leaves a file with mixed line endings", async () => {
    const root = makeTempWorkspace();
    writeFileSync(join(root, "win.txt"), "a\r\nb\r\n");
    // Content arrives with a mix of both; the file's CRLF must win throughout.
    await tool(root).run({ file_path: "win.txt", content: "a\nb\r\nc\n" });
    const text = readFileSync(join(root, "win.txt"), "utf8");
    expect(text).toBe("a\r\nb\r\nc\r\n");
  });

  it("round-trips non-ASCII content", async () => {
    const root = makeTempWorkspace();
    const content = "سلام\nदुनिया\n";
    await tool(root).run({ file_path: "fa.txt", content });
    expect(readFileSync(join(root, "fa.txt"), "utf8")).toBe(content);
  });
});

describe("fs_write — atomicity and cleanliness", () => {
  it("leaves no temporary file behind on success", async () => {
    const root = makeTempWorkspace();
    await tool(root).run({ file_path: "a.txt", content: "x\n" });
    expect(readdirSync(root)).toEqual(["a.txt"]);
  });

  it("replaces the file wholesale rather than appending", async () => {
    const root = makeTempWorkspace();
    writeFileSync(join(root, "a.txt"), "a very long original line\n");
    await tool(root).run({ file_path: "a.txt", content: "short\n" });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("short\n");
  });

  it("can shrink a file", async () => {
    const root = makeTempWorkspace();
    writeFileSync(join(root, "a.txt"), "1\n2\n3\n4\n5\n");
    await tool(root).run({ file_path: "a.txt", content: "1\n" });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("1\n");
  });
});

describe("fs_write — sandbox and validation", () => {
  it("refuses a path that escapes the workspace", async () => {
    const root = makeTempWorkspace();
    await expect(
      tool(root).run({ file_path: "../escaped.txt", content: "x" }),
    ).rejects.toThrow(/traversal/i);
    // Nothing was created outside the sandbox.
    expect(existsSync(join(root, "..", "escaped.txt"))).toBe(false);
  });

  it("refuses an absolute path outside the workspace", async () => {
    const root = makeTempWorkspace();
    await expect(
      tool(root).run({ file_path: "C:/Windows/System32/test.txt", content: "x" }),
    ).rejects.toThrow(/outside/i);
  });

  it("refuses missing or non-string content", () => {
    const root = makeTempWorkspace();
    expect(() => tool(root).parseArgs({ file_path: "a.txt" })).toThrow(/content/);
    expect(() => tool(root).parseArgs({ file_path: "a.txt", content: 7 })).toThrow(
      /content/,
    );
  });

  it("refuses a missing file_path", () => {
    const root = makeTempWorkspace();
    expect(() => tool(root).parseArgs({ content: "x" })).toThrow(/file_path/);
  });

  it("refuses a non-boolean create_only", () => {
    const root = makeTempWorkspace();
    expect(() =>
      tool(root).parseArgs({ file_path: "a.txt", content: "x", create_only: "yes" }),
    ).toThrow(/create_only/);
  });
});

describe("fs_write — refuses before it asks", () => {
  it("never prompts for a write that could never succeed", async () => {
    // The ordering that matters. A prompt the user learns to approve without
    // reading is the asset a prompt-injection attack buys; spending one on an
    // impossible request spends it early, for nothing.
    const { registry, prompts } = writeRegistry(makeTempWorkspace());
    await expect(
      registry.call("fs_write", {
        file_path: "../../escaped.txt",
        content: "x",
      }),
    ).rejects.toThrow(/traversal/i);
    expect(prompts()).toBe(0);
  });

  it("never prompts for an absolute path outside the sandbox", async () => {
    const { registry, prompts } = writeRegistry(makeTempWorkspace());
    await expect(
      registry.call("fs_write", {
        file_path: "C:/Windows/System32/x.txt",
        content: "x",
      }),
    ).rejects.toThrow(/outside/i);
    expect(prompts()).toBe(0);
  });

  it("still audits the refused attempt", async () => {
    const { registry, audit } = writeRegistry(makeTempWorkspace());
    await registry
      .call("fs_write", { file_path: "../escaped.txt", content: "x" })
      .catch(() => undefined);
    expect(audit.list()[0]?.status).toBe("error");
    audit.close();
  });

  it("does prompt for a legitimate write", async () => {
    const { registry, prompts } = writeRegistry(makeTempWorkspace());
    await registry.call("fs_write", { file_path: "fine.txt", content: "x" });
    expect(prompts()).toBe(1);
  });
});

describe("fs_write — never leaks a raw filesystem error", () => {
  it("reports a directory target as NOT_A_DIRECTORY, not a raw EISDIR", async () => {
    // Before this was translated, this threw a plain `Error` carrying
    // `code: "EISDIR"`, which the MCP error mapping cannot translate and a
    // client cannot branch on.
    const root = makeTempWorkspace();
    mkdirSync(join(root, "adir"));
    const error = await tool(root)
      .run({ file_path: "adir", content: "x" })
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ZxError);
    expect((error as ZxError).code).toBe("NOT_A_DIRECTORY");
  });

  it("keeps the original errno in the detail for the audit reader", async () => {
    const root = makeTempWorkspace();
    mkdirSync(join(root, "adir"));
    const error = await tool(root)
      .run({ file_path: "adir", content: "x" })
      .then(() => undefined)
      .catch((e: unknown) => e as ZxError);
    expect((error as ZxError).detail?.errno).toBe("EISDIR");
  });
});

describe("fs_write — classification", () => {
  it("is a write, so it asks before touching the file", () => {
    const root = makeTempWorkspace();
    expect(tool(root).opClass).toBe("write");
  });

  it("summarises honestly whether it creates or overwrites", () => {
    const root = makeTempWorkspace();
    expect(tool(root).summarize({ file_path: "a.txt", content: "x" })).toBe(
      "write a.txt",
    );
    expect(
      tool(root).summarize({ file_path: "a.txt", content: "x", create_only: true }),
    ).toBe("create a.txt");
  });
});
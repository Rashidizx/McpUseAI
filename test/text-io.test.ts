import { describe, it, expect } from "vitest";
import { detectEol, decodeFile, encodeFile } from "../src/core/text-io.js";

describe("detectEol", () => {
  it("detects LF", () => {
    expect(detectEol("a\nb\nc")).toBe("\n");
  });

  it("detects CRLF", () => {
    expect(detectEol("a\r\nb\r\nc")).toBe("\r\n");
  });

  it("defaults to LF for a single line with no terminator", () => {
    expect(detectEol("abc")).toBe("\n");
  });

  it("defaults to LF for an empty file", () => {
    expect(detectEol("")).toBe("\n");
  });

  it("returns CRLF when CRLF appears anywhere", () => {
    // Deliberate: a mostly-LF file with one stray CRLF is more likely a bad
    // paste than a genuinely mixed file, and normalising to CRLF would rewrite
    // every line of it.
    expect(detectEol("a\nb\r\nc")).toBe("\r\n");
  });
});

describe("decodeFile", () => {
  it("decodes UTF-8 without BOM", () => {
    const out = decodeFile(Buffer.from("hello\nworld\n", "utf8"));
    expect(out.text).toBe("hello\nworld\n");
    expect(out.hadBom).toBe(false);
    expect(out.eol).toBe("\n");
  });

  it("strips and reports a UTF-8 BOM", () => {
    const buf = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("hi\n", "utf8"),
    ]);
    const out = decodeFile(buf);
    expect(out.hadBom).toBe(true);
    // Stripped, not left as an invisible U+FEFF that would show up as a diff on
    // the first line of every edit.
    expect(out.text).toBe("hi\n");
  });

  it("does not mistake a short buffer for a BOM", () => {
    expect(decodeFile(Buffer.from([0xef, 0xbb])).hadBom).toBe(false);
    expect(decodeFile(Buffer.alloc(0)).hadBom).toBe(false);
  });

  it("does not treat bytes that merely start like a BOM as one", () => {
    expect(decodeFile(Buffer.from([0xef, 0xbb, 0x00])).hadBom).toBe(false);
  });

  it("preserves CRLF line endings in the text", () => {
    const out = decodeFile(Buffer.from("a\r\nb\r\n", "utf8"));
    expect(out.text).toBe("a\r\nb\r\n");
    expect(out.eol).toBe("\r\n");
  });
});

describe("encodeFile", () => {
  it("writes without a BOM by default", () => {
    expect(encodeFile("hi\n", {})[0]).not.toBe(0xef);
  });

  it("writes a BOM when requested", () => {
    const buf = encodeFile("hi\n", { bom: true });
    expect(buf.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  });

  it("normalises all line endings to the requested eol", () => {
    expect(encodeFile("a\nb\nc", { eol: "\r\n" }).toString("utf8")).toBe(
      "a\r\nb\r\nc",
    );
  });

  it("does not introduce a mixed-ending file", () => {
    const text = encodeFile("a\r\nb\nc\n", { eol: "\n" }).toString("utf8");
    expect(text).not.toContain("\r\n");
  });

  it("does not double the carriage return when normalising CRLF", () => {
    // The failure this catches: normalising CRLF before LF turns "a\r\n" into
    // "a\r\n\n", which appends a blank line on every write.
    expect(encodeFile("a\r\nb\r\n", { eol: "\r\n" }).toString("utf8")).toBe(
      "a\r\nb\r\n",
    );
  });

  it("folds a lone CR into the chosen ending", () => {
    expect(encodeFile("a\rb", { eol: "\n" }).toString("utf8")).toBe("a\nb");
  });

  it("defaults to LF when no eol is given", () => {
    expect(encodeFile("a\nb", {}).toString("utf8")).toBe("a\nb");
  });
});

describe("text-io round-trip", () => {
  it("returns CRLF content byte-identical", () => {
    const original = "line1\r\nline2\r\n";
    const decoded = decodeFile(Buffer.from(original, "utf8"));
    const reencoded = encodeFile(decoded.text, {
      eol: decoded.eol,
      bom: decoded.hadBom,
    });
    expect(reencoded.toString("utf8")).toBe(original);
  });

  it("returns a BOM + CRLF file byte-identical", () => {
    const original = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("a\r\nb\r\n", "utf8"),
    ]);
    const decoded = decodeFile(original);
    const reencoded = encodeFile(decoded.text, {
      eol: decoded.eol,
      bom: decoded.hadBom,
    });
    expect(reencoded.equals(original)).toBe(true);
  });

  it("returns a plain LF file byte-identical", () => {
    const original = "one\ntwo\n";
    const decoded = decodeFile(Buffer.from(original, "utf8"));
    expect(
      encodeFile(decoded.text, { eol: decoded.eol, bom: decoded.hadBom })
        .toString("utf8"),
    ).toBe(original);
  });

  it("survives non-ASCII content unchanged", () => {
    const original = "سلام\nदुनिया\n";
    const decoded = decodeFile(Buffer.from(original, "utf8"));
    expect(
      encodeFile(decoded.text, { eol: decoded.eol, bom: decoded.hadBom })
        .toString("utf8"),
    ).toBe(original);
  });
});
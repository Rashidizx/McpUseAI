/**
 * Reading and writing text without changing how the file looked.
 *
 * The tools in `src/tools/` edit files the user cares about, and most of the
 * damage that does is not semantic — it is a diff full of lines that changed
 * only because the bridge rewrote LF as CRLF, or because a BOM appeared or
 * vanished. That diff would then be committed, and a 400-line change to fix one
 * line is exactly what makes a user stop trusting the tool.
 *
 * So the contract here is narrow and absolute: **what is read is what is
 * written.** `decodeFile` reports the BOM and the line ending; `encodeFile`
 * restores them. Nothing in this module guesses.
 */

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export type Eol = "\n" | "\r\n";

export type DecodedFile = {
  /** The text with any BOM removed. Line endings untouched. */
  text: string;

  /**
   * The file's dominant line ending.
   *
   * Reported rather than normalised: `fs_write` passes it straight back to
   * `encodeFile`, so a file the bridge never meant to reformat keeps its own
   * convention.
   */
  eol: Eol;

  /** Whether the file started with a UTF-8 BOM, so the write can put it back. */
  hadBom: boolean;
};

export type EncodeOptions = {
  /** Defaults to LF. Pass the detected value to preserve the file. */
  eol?: Eol;

  /** Defaults to false — a BOM is only written back if the file had one. */
  bom?: boolean;
};

/**
 * Decide whether a file uses CRLF or LF.
 *
 * CRLF wins if it appears **anywhere**. That is a deliberate choice against the
 * more careful "majority wins" rule: a file that is mostly LF with one stray CRLF
 * is far more likely to be a single bad paste than a genuinely mixed file, and
 * normalising to CRLF would then rewrite every line of it. The single-line and
 * empty cases fall back to LF, which is the safer default on a platform that can
 * produce either.
 */
export function detectEol(text: string): Eol {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Decode a file, reporting the facts a later write has to reproduce.
 *
 * The BOM is stripped from `text` and recorded in `hadBom` instead of being left
 * in the string: a leading U+FEFF is invisible in most editors but is a real
 * character, and leaving it in means the first line of every subsequent diff
 * differs by an invisible glyph.
 */
export function decodeFile(buffer: Buffer): DecodedFile {
  const hadBom =
    buffer.length >= 3 &&
    buffer[0] === 0xef &&
    buffer[1] === 0xbb &&
    buffer[2] === 0xbf;
  const body = hadBom ? buffer.subarray(3) : buffer;
  const text = body.toString("utf8");
  return { text, eol: detectEol(text), hadBom };
}

/**
 * Encode text, normalising every line ending to exactly the one requested.
 *
 * Normalising is not optional, and it is not a "preserve whatever was there"
 * decision: mixed endings within one file are what makes a diff unreadable and
 * what trips linters and `.gitattributes` checks. The caller supplies the target
 * — almost always `decoded.eol` from the file being edited — so the result is
 * uniform without being arbitrary.
 *
 * Lone `\r` (classic Mac) is folded to the chosen ending too; leaving it would be
 * a third kind of line ending that no detector handles.
 */
export function encodeFile(text: string, opts: EncodeOptions = {}): Buffer {
  const eol = opts.eol ?? "\n";
  // Order matters: CRLF is normalised first, so the second pass cannot see the
  // `\r` of a CRLF and turn it into `\r\n\n`.
  const normalised = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const withEol = eol === "\n" ? normalised : normalised.replace(/\n/g, "\r\n");
  const body = Buffer.from(withEol, "utf8");
  return opts.bom ? Buffer.concat([BOM, body]) : body;
}
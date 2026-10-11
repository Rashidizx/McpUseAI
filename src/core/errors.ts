export const ZX_ERROR_CODES = [
  "PATH_OUTSIDE_SANDBOX",
  "PATH_TRAVERSAL",
  "RESERVED_DEVICE_NAME",
  "PATH_TOO_LONG",
  "APPROVAL_DENIED",
  "APPROVAL_REQUIRED",
  "FILE_NOT_FOUND",
  "FILE_EXISTS",
  "DIFF_NO_MATCH",
  "COMMAND_FAILED",
  "TIMEOUT",
  "NOT_A_DIRECTORY",
  "BUDGET_EXCEEDED",
  "INTERNAL",
] as const;

export type ZxErrorCode = (typeof ZX_ERROR_CODES)[number];

/**
 * The single error type every ZX AI module throws.
 *
 * `code` is the contract: the model sees it in every failed result, so it
 * is narrowed to `ZxErrorCode` and a literal code that is not in
 * `ZX_ERROR_CODES` is a compile error rather than a string that reaches a client.
 *
 * `detail` is left `undefined` when not supplied rather than defaulted to `{}`.
 * Callers branch on "no detail" versus "empty detail" to decide whether a
 * structured log record carries an extra payload block.
 *
 * Structured logging caveat: on every V8 `Error`, `message` and `stack` are own
 * but NON-ENUMERABLE, so `JSON.stringify(err)` yields `{ code, detail, name }` and
 * silently drops the human-readable message. A logger must read `message`/`stack`
 * as explicit fields, or add a `toJSON()` — deliberately, in the logging task.
 */
export class ZxError extends Error {
  readonly code: ZxErrorCode;
  readonly detail: Record<string, unknown> | undefined;

  constructor(
    code: ZxErrorCode,
    message: string,
    detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ZxError";
    this.code = code;
    this.detail = detail;
  }
}

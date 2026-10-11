import { ZxError } from "../core/errors.js";

/**
 * One place that turns a Node filesystem error into a `ZxError`.
 *
 * ## Why this module exists
 *
 * Every module in this project promises that everything leaving it is a
 * `ZxError`, because the model reads `ZxErrorCode` in its error
 * responses and a caller branches on `code`. A raw `Error` from `node:fs`
 * carries `errno: "EISDIR"` instead, so that mapping has nothing to match, the
 * client receives an unstructured failure, and the promise is quietly false at
 * exactly the point where the system is under stress and the error matters most.
 *
 * `statSync`, `readFileSync` and `writeFileSync` all throw this way, and none of
 * them take an error callback, so a tool cannot avoid it by choosing an async
 * API. Wrapping each call site would work and would drift: someone adds a fourth
 * call site and forgets. This function is the single mapping, so the drift is a
 * missing branch in one table rather than a raw error reaching a client.
 *
 * ## The mapping, and what it deliberately does not do
 *
 * `ENOENT` becomes `FILE_NOT_FOUND` and `EISDIR` becomes `NOT_A_DIRECTORY`,
 * because those are facts the model can act on - it can fix a typo or pick
 * another path. Everything else becomes `INTERNAL`, which is honest: an
 * `EACCES` from a Windows ACL is not a fact about the request, and reporting it
 * as one would let a model retry variations hoping to slip past.
 *
 * The original error is preserved in `detail` including its `syscall` and `path`,
 * because the human reading the audit log needs the real errno even though the
 * caller gets a coarse code.
 */
export function asZxError(error: unknown, context: { action: string; file_path: string }): ZxError {
  if (error instanceof ZxError) return error;

  const code = errnoOf(error);

  switch (code) {
    case "ENOENT":
      return new ZxError(
        "FILE_NOT_FOUND",
        `${context.action}: no such file - ${context.file_path}`,
        { file_path: context.file_path, errno: code },
      );
    case "EISDIR":
    case "ENOTDIR":
      return new ZxError(
        "NOT_A_DIRECTORY",
        `${context.action}: ${context.file_path} is not a regular file`,
        { file_path: context.file_path, errno: code },
      );
    case "EEXIST":
      return new ZxError(
        "FILE_EXISTS",
        `${context.action}: ${context.file_path} already exists`,
        { file_path: context.file_path, errno: code },
      );
    case "ENOSPC":
      return new ZxError(
        "INTERNAL",
        `${context.action}: the disk is full, so ${context.file_path} could not be written`,
        { file_path: context.file_path, errno: code },
      );
    default:
      return new ZxError(
        "INTERNAL",
        `${context.action} failed for ${context.file_path}: ${messageOf(error)}`,
        { file_path: context.file_path, errno: code ?? null },
      );
  }
}

/**
 * Pull the errno out of whatever was thrown.
 *
 * `NodeJS.ErrnoException` puts it on `code`, but a wrapped or proxied error may
 * not have it at all, and a non-error may not even be an object - so this never
 * assumes a shape it has not checked.
 */
function errnoOf(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    const encoded = JSON.stringify(error);
    return typeof encoded === "string" ? encoded : String(error);
  } catch {
    return "[unrenderable value]";
  }
}
/**
 * The suffix of the staging file a write goes through.
 *
 * ## Why it is exported
 *
 * `fs_write` and `fs_apply_diff` both write to `<target><suffix>` and then
 * rename it over the target, so the two must agree. They each spelled the suffix
 * out, and a test that needs the staging step to *fail* has to create a
 * directory at exactly that path - which meant the test hardcoded the string
 * too. When a rename changed the suffix in the tools and not in the test, the
 * staging step stopped failing, the write succeeded, and a test named "leaves
 * the original intact" quietly stopped testing that. Three copies of one string
 * is one copy too many; this is the copy both tools and the test import.
 *
 * Not a full name because the directory is chosen per call - the staging file
 * has to sit beside its target to stay on one volume, and a rename across
 * volumes is not atomic.
 */
export const STAGING_SUFFIX = ".zx-tmp";

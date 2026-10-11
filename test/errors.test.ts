import { describe, it, expect } from "vitest";
import { ZxError, ZX_ERROR_CODES } from "../src/core/errors.js";

describe("ZxError", () => {
  it("carries a code and a message", () => {
    const err = new ZxError("PATH_OUTSIDE_SANDBOX", "escaped the root");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("PATH_OUTSIDE_SANDBOX");
    expect(err.message).toBe("escaped the root");
  });

  it("exposes PATH_OUTSIDE_SANDBOX in the code list", () => {
    expect(ZX_ERROR_CODES).toContain("PATH_OUTSIDE_SANDBOX");
  });

  it("exposes APPROVAL_DENIED in the code list", () => {
    expect(ZX_ERROR_CODES).toContain("APPROVAL_DENIED");
  });

  // The first test only proves `err` is *an* Error, which any subclass satisfies
  // regardless of whether its prototype chain survived compilation. `tool-registry`
  // dispatches on `err instanceof ZxError` to map codes onto MCP error
  // responses, so a downlevel emit that broke the chain would silently route every
  // ZxError to the generic INTERNAL branch. Pin the subclass identity directly.
  it("is an instance of its own class, not just of Error", () => {
    const err = new ZxError("APPROVAL_DENIED", "user said no");
    expect(err).toBeInstanceOf(ZxError);
    expect(err).toBeInstanceOf(Error);
  });

  // `name` is what `err.stack` and `err.toString()` are built from, so leaving it
  // as the inherited "Error" makes every stack trace and audit row ambiguous about
  // which layer threw. Assert the stack survives construction too, since that is
  // what structured logging will serialise.
  it("identifies itself as ZxError in name and in the stack", () => {
    const err = new ZxError("INTERNAL", "unexpected state");
    expect(err.name).toBe("ZxError");
    expect(err.stack).toEqual(expect.any(String));
    expect(err.stack).toContain("ZxError");
  });

  it("leaves detail undefined when none is supplied", () => {
    const err = new ZxError("FILE_NOT_FOUND", "no such file");
    expect(err.detail).toBeUndefined();
  });

  // The undefined path is pinned above, but the *supplied-value* path was not, so
  // `this.detail = detail ?? {}`, a `structuredClone(detail)`, or dropping the third
  // parameter entirely would all leave every other test in this file green — while
  // silently breaking every downstream caller that branches on `detail`. Assert the
  // object actually arrived, not merely that some object is present.
  it("carries a supplied detail object through unchanged", () => {
    const detail = { path: "C:/secrets" };
    const err = new ZxError("PATH_OUTSIDE_SANDBOX", "escaped the root", detail);
    expect(err.detail).toEqual({ path: "C:/secrets" });
    expect(err.detail).not.toEqual({});
  });
});

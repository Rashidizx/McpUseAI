import { describe, expect, it } from "vitest";

import { isAuthorNumber, normalizeNumber } from "../extension/src/activation.js";

describe("activation", () => {
  it("accepts the author's number however it is typed", async () => {
    for (const input of ["09176800544", "۰۹۱۷۶۸۰۰۵۴۴", "0917 680 0544", "+989176800544", "9176800544"]) {
      expect(await isAuthorNumber(input), input).toBe(true);
    }
  });

  it("refuses anything else", async () => {
    for (const input of ["", "09176800545", "0917680054", "1234"]) {
      expect(await isAuthorNumber(input), input).toBe(false);
    }
  });

  it("normalizes digits", () => {
    expect(normalizeNumber("+98 917 680 0544")).toBe("09176800544");
  });
});

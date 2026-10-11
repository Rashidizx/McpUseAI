import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

import { VERSION } from "../src/shared/version.js";

describe("one version everywhere", () => {
  it("package.json and the extension manifest match src/shared/version.ts", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    const manifest = JSON.parse(readFileSync("extension/manifest.json", "utf8"));
    expect(pkg.version).toBe(VERSION);
    expect(manifest.version).toBe(VERSION);
  });
});

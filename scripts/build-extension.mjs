#!/usr/bin/env node
/**
 * Build the loadable extension into `extension/dist/` (the folder Chrome's
 * "Load unpacked" points at). The service worker is ESM because the manifest
 * says `"type": "module"`; the injected page script and the options page are
 * classic scripts, so their imports are inlined.
 */
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXT = join(dirname(fileURLToPath(import.meta.url)), "..", "extension");
const SRC = join(EXT, "src");
const DIST = join(EXT, "dist");

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

const common = { bundle: true, minify: false, sourcemap: true, target: ["chrome116"], logLevel: "warning" };
await build({ ...common, entryPoints: [join(SRC, "background.ts")], outfile: join(DIST, "background.js"), format: "esm" });
await build({ ...common, entryPoints: [join(SRC, "page.ts")], outfile: join(DIST, "page.js"), format: "iife" });
await build({ ...common, entryPoints: [join(SRC, "awake.ts")], outfile: join(DIST, "awake.js"), format: "iife" });
await build({ ...common, entryPoints: [join(SRC, "options.ts")], outfile: join(DIST, "options.js"), format: "iife" });
await build({ ...common, entryPoints: [join(SRC, "panel.ts")], outfile: join(DIST, "panel.js"), format: "iife" });

cpSync(join(EXT, "manifest.json"), join(DIST, "manifest.json"));
cpSync(join(SRC, "options.html"), join(DIST, "options.html"));
cpSync(join(SRC, "panel.html"), join(DIST, "panel.html"));
cpSync(join(EXT, "icons"), join(DIST, "icons"), { recursive: true });

const manifest = JSON.parse(readFileSync(join(DIST, "manifest.json"), "utf8"));
// The bridge compares this with what the running extension reports, and asks
// an outdated one to reload itself.
const hash = createHash("sha256");
for (const file of ["background.js", "page.js", "awake.js", "options.js", "options.html", "panel.js", "panel.html", "manifest.json"]) hash.update(readFileSync(join(DIST, file)));
manifest.version_name = `${manifest.version} ${hash.digest("hex").slice(0, 10)}`;
writeFileSync(join(DIST, "manifest.json"), JSON.stringify(manifest, null, 2));
const needed = [manifest.background.service_worker, "page.js", "awake.js", manifest.options_page, ...Object.values(manifest.icons)];
const missing = needed.filter((file) => !existsSync(join(DIST, file)));
if (missing.length > 0) {
  console.error(`build-extension: missing ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`extension built: ${DIST}`);

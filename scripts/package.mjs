#!/usr/bin/env node
/**
 * Build release/ZX-AI-Setup.exe: one file that carries Node, the bundled ZX
 * server, the UI and the extension. See src/sea.ts for what it does when run.
 *
 * Uses Node's single executable applications: bundle to one CommonJS file,
 * embed assets, then inject the blob into a copy of node.exe with postject.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "build", "sea");
const RELEASE = join(ROOT, "release");
const EXE = join(RELEASE, "ZX-AI-Setup.exe");
const run = (file, args) => execFileSync(file, args, { cwd: ROOT, stdio: "inherit", shell: false });

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
mkdirSync(RELEASE, { recursive: true });

// 1. The extension, freshly built.
run(process.execPath, [join(ROOT, "scripts", "build-extension.mjs")]);

// 2. The server and setup as one CommonJS file. `import.meta.url` becomes the
//    executable's own location, which the installed layout is arranged around.
await build({
  entryPoints: [join(ROOT, "src", "sea.ts")],
  outfile: join(OUT, "zx.cjs"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  external: ["bufferutil", "utf-8-validate"],
  define: { "import.meta.url": "__zxUrl" },
  banner: { js: 'const __zxUrl = require("node:url").pathToFileURL(process.execPath).href;' },
  logLevel: "warning",
});

// 3. Assets: the UI and every extension file except source maps.
const files = ["ui/index.html"];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (!name.endsWith(".map")) files.push(relative(ROOT, path).split("\\").join("/"));
  }
};
walk(join(ROOT, "extension", "dist"));
writeFileSync(join(OUT, "files.json"), JSON.stringify(files));
const assets = Object.fromEntries([["files.json", join(OUT, "files.json")], ...files.map((f) => [f, join(ROOT, f)])]);
writeFileSync(
  join(OUT, "sea-config.json"),
  JSON.stringify({ main: join(OUT, "zx.cjs"), output: join(OUT, "zx.blob"), disableExperimentalSEAWarning: true, useCodeCache: false, assets }, null, 2),
);
run(process.execPath, ["--experimental-sea-config", join(OUT, "sea-config.json")]);

// 4. Into a copy of this Node.
rmSync(EXE, { force: true });
copyFileSync(process.execPath, EXE);
const { inject } = await import("postject");
await inject(EXE, "NODE_SEA_BLOB", readFileSync(join(OUT, "zx.blob")), {
  sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
});

// 5. The extension on its own, zipped with the manifest at the root (no source
//    maps): extract and "Load unpacked", or upload to a store.
const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const ZIP = join(RELEASE, `ZX-AI-Extension-${version}.zip`);
const STAGE = join(OUT, "extension");
rmSync(ZIP, { force: true });
for (const file of files.filter((f) => f.startsWith("extension/dist/"))) {
  const target = join(STAGE, file.slice("extension/dist/".length));
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(ROOT, file), target);
}
// bsdtar (tar.exe, built into Windows 10+) writes "/" in entry names;
// Compress-Archive writes "\", which other systems and stores reject.
// By full path: a Git install puts GNU tar, which cannot write zip, earlier on PATH.
run(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), ["-a", "-c", "-f", ZIP, "-C", STAGE, ...readdirSync(STAGE)]);
console.log(`built ${relative(ROOT, EXE)} and ${relative(ROOT, ZIP)}`);


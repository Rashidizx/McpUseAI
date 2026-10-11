#!/usr/bin/env node
// Development entry for the ZX launcher: starts the server from the source tree with tsx.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startLauncher } from "./launcher-core.mjs";

startLauncher({
  file: process.execPath,
  args: ["--import", "tsx", "src/main.ts", "--no-open"],
  cwd: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
});

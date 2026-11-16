#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distPostinstall = join(here, "..", "dist", "postinstall.js");

if (existsSync(distPostinstall)) {
  await import(pathToFileURL(distPostinstall).href);
}

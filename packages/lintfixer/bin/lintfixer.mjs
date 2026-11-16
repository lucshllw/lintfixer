#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bundledMain = join(here, "..", "dist", "main.js");
const devMain = join(here, "..", "src", "cli", "main.ts");

const entry = existsSync(bundledMain) ? bundledMain : devMain;
const mod = await import(pathToFileURL(entry).href);
const code = await mod.runLintFixerCli(process.argv.slice(2));
process.exitCode = code;

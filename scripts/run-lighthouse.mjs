import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { startLintFixerDaemon } from "../packages/lintfixer/src/server/daemon.ts";

const repoRoot = resolve(import.meta.dirname, "..");
const qaDir = join(repoRoot, "qa");
mkdirSync(qaDir, { recursive: true });

function findChromeBinary() {
  const chromeCandidates = [
    join(process.env.ProgramFiles ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
    join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
  ];
  for (const c of chromeCandidates) {
    if (c && existsSync(c)) return c;
  }

  const pwBase = join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
  if (existsSync(pwBase)) {
    const dirs = readdirSync(pwBase)
      .filter((d) => d.startsWith("chromium-"))
      .sort()
      .reverse();
    for (const d of dirs) {
      const exe = join(pwBase, d, "chrome-win64", "chrome.exe");
      if (existsSync(exe)) return exe;
      const exe32 = join(pwBase, d, "chrome-win", "chrome.exe");
      if (existsSync(exe32)) return exe32;
    }
  }

  const edge = join(
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    "Microsoft",
    "Edge",
    "Application",
    "msedge.exe",
  );
  return existsSync(edge) ? edge : null;
}

async function main() {
  const chromePath = process.env.CHROME_PATH || findChromeBinary();
  if (!chromePath) {
    console.error("Chrome/Chromium binary not found for Lighthouse.");
    process.exitCode = 1;
    return;
  }

  const daemon = await startLintFixerDaemon({ cwd: repoRoot, port: 0 });
  const targetUrl = `${daemon.url}&no-intro=1`;
  const env = { ...process.env, CHROME_PATH: chromePath };

  try {
    console.log("CHROME_PATH:", chromePath);
    for (const preset of ["mobile", "desktop"]) {
      const args = [
        "--yes",
        "lighthouse",
        targetUrl,
        ...(preset === "desktop"
          ? ["--preset=desktop"]
          : ["--preset=perf", "--form-factor=mobile", "--screenEmulation.mobile"]),
        "--only-categories=performance,accessibility,best-practices,seo",
        "--blocked-url-patterns=**/api/events*",
        "--output=json",
        `--output-path=${join(qaDir, `lh-${preset}.json`)}`,
        "--quiet",
        "--chrome-flags=--headless=new",
      ];
      execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", args, {
        cwd: repoRoot,
        env,
        stdio: "inherit",
        shell: process.platform === "win32",
      });
    }
  } finally {
    await daemon.close();
  }
}

await main();

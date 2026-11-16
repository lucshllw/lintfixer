import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot, resolveCredential, resolveGitHubToken } from "@ikigai/adapters";
import { parsePolicyConfig, parseRules } from "@ikigai/core";
import type { DoctorCheckItem, DoctorReport } from "./types.ts";

async function checkBinary(
  bin: string,
  args: readonly string[] = ["--version"],
): Promise<string | null> {
  if (process.platform === "win32" && (bin === "claude" || bin === "codex")) {
    return new Promise((resolve) => {
      execFile("where.exe", [bin], { timeout: 1_500, windowsHide: true }, (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        const firstPath = (stdout.split(/\r?\n/)[0] ?? "").trim();
        resolve(firstPath ? "installed" : null);
      });
    });
  }

  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 1_500, windowsHide: true }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      resolve((stdout.split(/\r?\n/)[0] ?? "").trim() || "available");
    });
  });
}

export async function runDoctor(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DoctorReport> {
  const checks: DoctorCheckItem[] = [];
  checks.push({ name: "node", status: "OK", detail: process.version });

  const repoRoot = await findRepoRoot(cwd);
  checks.push({
    name: "git-repo",
    status: repoRoot ? "OK" : "WARN",
    detail: repoRoot ?? "Not inside a git repository",
  });

  const [gitVer, ghVer, claudeVer, codexVer] = await Promise.all([
    checkBinary("git"),
    checkBinary("gh"),
    checkBinary("claude"),
    checkBinary("codex"),
  ]);

  checks.push({
    name: "git-cli",
    status: gitVer ? "OK" : "FAIL",
    detail: gitVer ?? "git not found on PATH",
  });
  checks.push({
    name: "gh-cli",
    status: ghVer ? "OK" : "WARN",
    detail: ghVer ?? "gh not found (REST fallback requires GITHUB_TOKEN)",
  });
  checks.push({
    name: "local-clis",
    status: claudeVer || codexVer ? "OK" : "WARN",
    detail: `claude=${claudeVer ?? "missing"}, codex=${codexVer ?? "missing"}`,
  });

  for (const key of ["openai", "gemini", "claude"] as const) {
    const lookup = resolveCredential(key, repoRoot ?? undefined, env);
    checks.push({
      name: `cred:${key}`,
      status: lookup.found ? "OK" : "WARN",
      detail: lookup.found ? `configured via ${lookup.source}` : "not configured",
    });
  }

  const ghToken = await resolveGitHubToken(env);
  checks.push({
    name: "cred:github",
    status: ghToken ? "OK" : "WARN",
    detail: ghToken ? "configured (env or gh auth)" : "not configured",
  });

  const baseDir = repoRoot ?? cwd;
  const rulesPath = existsSync(join(baseDir, ".ikigai", "rules.md"))
    ? join(baseDir, ".ikigai", "rules.md")
    : existsSync(join(baseDir, ".jev", "rules.md"))
      ? join(baseDir, ".jev", "rules.md")
      : null;

  if (rulesPath === null) {
    checks.push({
      name: "rules",
      status: "WARN",
      detail: "No .ikigai/rules.md (or .jev/rules.md) found; run `ikigai init`",
    });
  } else {
    const parsed = parseRules(readFileSync(rulesPath, "utf8"));
    const invalidCount = parsed.filter((r) => r.status === "INVALID").length;
    checks.push({
      name: "rules",
      status: invalidCount === 0 ? "OK" : "FAIL",
      detail: `${parsed.length} rule block(s), ${invalidCount} invalid (${rulesPath})`,
    });
  }

  const configPath = existsSync(join(baseDir, ".ikigai", "config.yaml"))
    ? join(baseDir, ".ikigai", "config.yaml")
    : existsSync(join(baseDir, ".jev", "config.yaml"))
      ? join(baseDir, ".jev", "config.yaml")
      : null;

  if (configPath === null) {
    checks.push({ name: "config", status: "OK", detail: "Using built-in defaults" });
  } else {
    const cfg = parsePolicyConfig(readFileSync(configPath, "utf8"));
    checks.push({
      name: "config",
      status: cfg.status === "PARSED" ? "OK" : "FAIL",
      detail: cfg.status === "PARSED" ? `Valid (${configPath})` : cfg.message,
    });
  }

  return {
    ok: !checks.some((c) => c.status === "FAIL"),
    repoRoot,
    checks,
  };
}

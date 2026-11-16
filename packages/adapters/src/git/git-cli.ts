import { execFile } from "node:child_process";
import type { CommandRunnerPort, PolicySourcePort, VerificationCommandResult } from "@ikigai/core";

const MAX_DIFF_BUFFER = 16 * 1024 * 1024;

export async function runGit(
  args: readonly string[],
  cwd: string,
): Promise<{ readonly ok: boolean; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, maxBuffer: MAX_DIFF_BUFFER, timeout: 30_000, windowsHide: true },
      (err, stdout, stderr) => {
        resolve({
          ok: err === null,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        });
      },
    );
  });
}

export async function findRepoRoot(cwd: string): Promise<string | null> {
  const res = await runGit(["rev-parse", "--show-toplevel"], cwd);
  if (!res.ok) {
    return null;
  }
  const trimmed = res.stdout.trim();
  return trimmed === "" ? null : trimmed;
}

export async function getStagedDiff(repoRoot: string): Promise<string | null> {
  const res = await runGit(["diff", "--cached", "--no-color", "--no-ext-diff"], repoRoot);
  return res.ok ? res.stdout : null;
}

export async function getRangeDiff(repoRoot: string, range: string): Promise<string | null> {
  if (!/^[A-Za-z0-9._/~^-]+(?:\.{2,3}[A-Za-z0-9._/~^-]+)?$/.test(range)) {
    return null;
  }
  const res = await runGit(["diff", "--no-color", "--no-ext-diff", range], repoRoot);
  return res.ok ? res.stdout : null;
}

export async function readFileAtGitRef(
  repoRoot: string,
  ref: string,
  relPath: string,
): Promise<string | null> {
  if (!/^[A-Za-z0-9._/-]+$/.test(ref) || relPath.includes("..")) {
    return null;
  }
  const res = await runGit(["show", `${ref}:${relPath}`], repoRoot);
  return res.ok ? res.stdout : null;
}

/**
 * Reads `.ikigai/rules.md` and `.ikigai/config.yaml` strictly from a protected
 * base git ref so untrusted PR branches cannot weaken policy rules.
 */
export function createGitRefPolicySource(repoRoot: string, baseRef: string): PolicySourcePort {
  return {
    async readRules(): Promise<string | null> {
      return (
        (await readFileAtGitRef(repoRoot, baseRef, ".ikigai/rules.md")) ??
        (await readFileAtGitRef(repoRoot, baseRef, ".jev/rules.md"))
      );
    },
    async readConfig(): Promise<string | null> {
      return (
        (await readFileAtGitRef(repoRoot, baseRef, ".ikigai/config.yaml")) ??
        (await readFileAtGitRef(repoRoot, baseRef, ".jev/config.yaml"))
      );
    },
  };
}

export function createSafeCommandRunner(): CommandRunnerPort {
  return {
    async runVerification(command: string, cwd: string): Promise<VerificationCommandResult> {
      const parts = command.trim().split(/\s+/).filter(Boolean);
      const bin = parts[0];
      if (!bin) {
        return { ok: false, exitCode: 2, summary: "Empty verification command." };
      }
      const allowedBins = new Set(["pnpm", "npm", "npx", "node", "vitest", "cargo", "pytest"]);
      if (!allowedBins.has(bin)) {
        return {
          ok: false,
          exitCode: 2,
          summary: `Verification binary "${bin}" is not in the allowlist.`,
        };
      }

      const resolvedBin =
        process.platform === "win32" && (bin === "pnpm" || bin === "npm" || bin === "npx")
          ? `${bin}.cmd`
          : bin;

      return new Promise((resolve) => {
        execFile(
          resolvedBin,
          parts.slice(1),
          {
            cwd,
            timeout: 120_000,
            maxBuffer: 4 * 1024 * 1024,
            windowsHide: true,
          },
          (err, stdout, stderr) => {
            const exitCode =
              err && "code" in err && typeof err.code === "number" ? err.code : err ? 1 : 0;
            const summary = (stderr || stdout || "").trim().slice(0, 400);
            resolve({ ok: err === null, exitCode, summary });
          },
        );
      });
    },
  };
}

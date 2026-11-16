import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAnimatedKatIntro, runLintFixerCli } from "../src/index.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("lintfixer CLI & animated Kat-Brackets fallback", () => {
  it("completes non-TTY / --no-anim intro cleanly and executes CLI help and vault status", async () => {
    await runAnimatedKatIntro({
      title: "Test",
      noAnim: true,
      steps: [{ label: "Check A", action: () => "ok" }],
    });

    const helpCode = await runLintFixerCli(["--help"]);
    expect(helpCode).toBe(0);

    const vaultCode = await runLintFixerCli(["vault", "status", "--json"]);
    expect(vaultCode).toBe(0);
  });

  it("computes real Git Score deterministically on a git repository commit", async () => {
    const repo = mkdtempSync(join(tmpdir(), "lf-score-"));
    tempDirs.push(repo);

    execFileSync("git", ["init", "-b", "main"], { cwd: repo, windowsHide: true });
    execFileSync("git", ["config", "user.name", "Tester"], { cwd: repo, windowsHide: true });
    execFileSync("git", ["config", "user.email", "t@example.com"], {
      cwd: repo,
      windowsHide: true,
    });

    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "app.ts"), "export const ok = 1;\n", "utf8");
    writeFileSync(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    execFileSync("git", ["add", "-A"], { cwd: repo, windowsHide: true });
    execFileSync("git", ["commit", "-m", "feat(core): add initial app module"], {
      cwd: repo,
      windowsHide: true,
    });

    const prevCwd = process.cwd();
    process.chdir(repo);
    try {
      const code = await runLintFixerCli(["score", "HEAD", "--json"]);
      expect(code).toBe(0);
    } finally {
      process.chdir(prevCwd);
    }
  });
});

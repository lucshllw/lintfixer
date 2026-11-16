import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startLintFixerDaemon } from "../src/server/daemon.ts";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    await fn?.();
  }
});

describe("lintfixer loopback daemon security & API", () => {
  it("enforces session token authorization and refuses exposing decrypted secrets", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "lf-daemon-"));
    const vaultDir = mkdtempSync(join(tmpdir(), "lf-daemon-vault-"));
    mkdirSync(join(tmpDir, "examples"), { recursive: true });
    writeFileSync(
      join(tmpDir, "examples", "calibration-corpus.json"),
      JSON.stringify({
        version: 1,
        threshold: 0.7,
        cases: [
          {
            fixtureId: "c1",
            ruleId: "ARCH-001",
            authorLabel: "VIOLATION",
            task: "Add SQL query",
            diff: "+db.query('select 1')",
            precomputedProbability: 0.92,
            precomputedConfidence: 0.95,
            sliceProbabilities: [0.92],
          },
        ],
      }),
      "utf8",
    );
    cleanups.push(() => rmSync(tmpDir, { recursive: true, force: true }));
    cleanups.push(() => rmSync(vaultDir, { recursive: true, force: true }));

    const daemon = await startLintFixerDaemon({
      cwd: tmpDir,
      port: 0,
      env: { ...process.env, LINTFIXER_VAULT_DIR: vaultDir },
    });
    cleanups.push(daemon.close);

    const origin = `http://127.0.0.1:${daemon.port}`;

    // Unauthorized request must fail closed
    const unauthRes = await fetch(`${origin}/api/bootstrap`);
    expect(unauthRes.status).toBe(401);

    // Authorized secret save -> masked metadata only, never plaintext secret!
    const secretVal = "AIzaSy-loopback-synthetic-secret-4321";
    const saveRes = await fetch(`${origin}/api/vault/secret`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-lintfixer-token": daemon.sessionToken,
      },
      body: JSON.stringify({ namespace: "llm.gemini", secret: secretVal }),
    });
    expect(saveRes.status).toBe(200);

    const bootRes = await fetch(`${origin}/api/bootstrap`, {
      headers: { "x-lintfixer-token": daemon.sessionToken },
    });
    expect(bootRes.status).toBe(200);
    const bootText = await bootRes.text();
    expect(bootText).not.toContain(secretVal);
    expect(bootText).toContain("••••4321");

    // Offline calibration endpoint returns metrics cleanly
    const calRes = await fetch(`${origin}/api/calibrate/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-lintfixer-token": daemon.sessionToken,
      },
      body: JSON.stringify({ corpusKey: "calibration-corpus", repeats: 1, threshold: 0.7 }),
    });
    expect(calRes.status).toBe(200);
    const calJson = (await calRes.json()) as { ok: boolean; summary: { f1: number } };
    expect(calJson.ok).toBe(true);
    expect(calJson.summary.f1).toBe(1);

    // Serves Kat-Brackets ICO asset cleanly
    const icoRes = await fetch(`${origin}/kat-brackets.ico`);
    expect(icoRes.status).toBe(200);
  }, 15_000);
});

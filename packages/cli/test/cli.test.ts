import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "@ikigai/cli";
import type { ProviderPort } from "@ikigai/core";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) {
      rmSync(d, { recursive: true, force: true });
    }
  }
});

describe("ikigai CLI", () => {
  it("supports init, check --diff --json, calibrate --json, and doctor --json", async () => {
    const repo = makeTempDir("ikigai-cli-");
    const dataDir = join(repo, ".appdata");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      XDG_DATA_HOME: dataDir,
      XDG_CONFIG_HOME: dataDir,
    };
    const out: string[] = [];
    const err: string[] = [];

    const io = (stdin = "") => ({
      cwd: repo,
      env,
      stdinText: async () => stdin,
      stdout: (t: string) => out.push(t),
      stderr: (t: string) => err.push(t),
    });

    expect(await runCli(["init", "--json"], io())).toBe(0);

    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "ctrl.ts"), "export const x = db.query('SELECT 1');\n", "utf8");
    const diffPath = join(repo, "change.diff");
    writeFileSync(
      diffPath,
      [
        "diff --git a/src/ctrl.ts b/src/ctrl.ts",
        "--- a/src/ctrl.ts",
        "+++ b/src/ctrl.ts",
        "@@ -1,1 +1,1 @@",
        "-export const x = 0;",
        "+export const x = db.query('SELECT 1');",
      ].join("\n"),
      "utf8",
    );

    const fakeProvider: ProviderPort = {
      async judgeRuleSlice() {
        return {
          status: "OK",
          judgment: {
            violationProbability: 0.9,
            confidence: 0.92,
            evidenceHunk: {
              file: "src/ctrl.ts",
              startLine: 1,
              endLine: 1,
              quote: "db.query('SELECT 1')",
            },
            rationale: "Controller executes SQL directly.",
          },
          telemetry: { provider: "openai", modelId: "gpt-5-mini", latencyMs: 5 },
        };
      },
      async judgeBuiltInBatch() {
        return {
          status: "OK",
          telemetry: { provider: "openai", modelId: "gpt-5-mini", latencyMs: 5 },
          answers: {
            "SCOPE-CREEP": {
              status: "OK",
              telemetry: { provider: "openai", modelId: "gpt-5-mini", latencyMs: 5 },
              judgment: {
                violationProbability: 0.1,
                confidence: 0.9,
                evidenceHunk: null,
                rationale: "OK",
              },
            },
            COMPLEXITY: {
              status: "OK",
              telemetry: { provider: "openai", modelId: "gpt-5-mini", latencyMs: 5 },
              judgment: {
                violationProbability: 0.1,
                confidence: 0.9,
                evidenceHunk: null,
                rationale: "OK",
              },
            },
            "TEST-ADEQUACY": {
              status: "OK",
              telemetry: { provider: "openai", modelId: "gpt-5-mini", latencyMs: 5 },
              judgment: {
                violationProbability: 0.1,
                confidence: 0.9,
                evidenceHunk: null,
                rationale: "OK",
              },
            },
          },
        };
      },
    };

    out.length = 0;
    const checkCode = await runCli(
      ["check", "--diff", diffPath, "--task", "Update controller", "--json"],
      io(),
      fakeProvider,
    );
    expect(checkCode).toBe(1);
    const checkJson = JSON.parse(out[0] ?? "{}");
    expect(checkJson.aggregateOutcome).toBe("FAIL");

    // Feedback on the recorded FAIL
    out.length = 0;
    expect(await runCli(["feedback", "1", "wrong", "--json"], io())).toBe(0);
    out.length = 0;
    expect(await runCli(["report", "--json"], io())).toBe(0);
    const reportJson = JSON.parse(out[0] ?? "{}");
    expect(reportJson.feedback.wrong).toBe(1);

    // Offline calibration corpus
    const corpusPath = join(repo, "corpus.json");
    writeFileSync(
      corpusPath,
      JSON.stringify({
        version: 1,
        threshold: 0.7,
        cases: [
          {
            fixtureId: "c1",
            ruleId: "ARCH-001",
            authorLabel: "VIOLATION",
            task: "Add db query",
            diff: "+db.query()",
            precomputedProbability: 0.91,
          },
          {
            fixtureId: "c2",
            ruleId: "ARCH-001",
            authorLabel: "NO_VIOLATION",
            task: "Health check",
            diff: "+return { ok: true }",
            precomputedProbability: 0.75,
            scopedPath: "src/health.ts",
            rationale: "Health check incorrectly flagged",
          },
        ],
      }),
      "utf8",
    );

    out.length = 0;
    expect(await runCli(["calibrate", "--corpus", corpusPath, "--json"], io())).toBe(0);
    const calJson = JSON.parse(out[0] ?? "{}");
    expect(calJson.metrics.recall).toBe(1);
    expect(calJson.allowedSuggestions).toHaveLength(1);

    // Doctor check
    out.length = 0;
    await runCli(["doctor", "--json"], io());
    const docJson = JSON.parse(out[0] ?? "{}");
    expect(docJson.checks.some((c: { name: string }) => c.name === "rules")).toBe(true);
    expect(readFileSync(join(repo, ".ikigai", "rules.md"), "utf8")).toContain("ARCH-001");
  });
});

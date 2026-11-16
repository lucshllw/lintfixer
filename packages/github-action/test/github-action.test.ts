import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderPort } from "@ikigai/core";
import { runGitHubPrBot } from "@ikigai/github-action";

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

describe("GitHub PR Bot Action", () => {
  it("approves clean internal PRs and downgrades fork PRs to COMMENT even on FAIL", async () => {
    const dir = makeTempDir("ikigai-gh-");
    const eventPath = join(dir, "event.json");
    writeFileSync(
      eventPath,
      JSON.stringify({
        pull_request: {
          number: 12,
          title: "feat: clean handler",
          body: "Delegates to service",
          base: { ref: "main", repo: { full_name: "acme-org/lintfixer-demo" } },
          head: {
            sha: "deadbeef1234",
            repo: { full_name: "acme-org/lintfixer-demo", fork: false },
          },
        },
      }),
      "utf8",
    );

    const sampleDiff = [
      "diff --git a/src/ctrl.ts b/src/ctrl.ts",
      "--- a/src/ctrl.ts",
      "+++ b/src/ctrl.ts",
      "@@ -1,1 +1,1 @@",
      "-export const clean = null;",
      "+export const clean = service.run();",
    ].join("\n");

    const passProvider: ProviderPort = {
      async judgeRuleSlice() {
        return {
          status: "OK",
          judgment: {
            violationProbability: 0.05,
            confidence: 0.95,
            evidenceHunk: null,
            rationale: "Delegates properly.",
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
                violationProbability: 0.05,
                confidence: 0.95,
                evidenceHunk: null,
                rationale: "OK",
              },
            },
            COMPLEXITY: {
              status: "OK",
              telemetry: { provider: "openai", modelId: "gpt-5-mini", latencyMs: 5 },
              judgment: {
                violationProbability: 0.05,
                confidence: 0.95,
                evidenceHunk: null,
                rationale: "OK",
              },
            },
            "TEST-ADEQUACY": {
              status: "OK",
              telemetry: { provider: "openai", modelId: "gpt-5-mini", latencyMs: 5 },
              judgment: {
                violationProbability: 0.05,
                confidence: 0.95,
                evidenceHunk: null,
                rationale: "OK",
              },
            },
          },
        };
      },
    };

    const postedEvents: string[] = [];
    const res = await runGitHubPrBot({
      repository: "acme-org/lintfixer-demo",
      eventPath,
      githubToken: "ghs_fake",
      workspaceDir: dir,
      policySourceOverride: {
        readRules: async () =>
          "## ARCH-001\nseverity: error\nscope: src/**\n### Rule\nDelegate.\n### Violation\nInline DB.\n",
        readConfig: async () => null,
      },
      providerOverride: passProvider,
      githubClientOverride: {
        fetchPullRequest: async () => {
          throw new Error("unused");
        },
        fetchPullRequestDiff: async () => sampleDiff,
        submitReview: async (_o, _r, _p, _s, plan) => {
          postedEvents.push(plan.action);
          return {
            ok: true,
            statusCode: 200,
            url: "https://github.com/acme-org/lintfixer-demo/pull/12",
          };
        },
      },
    });

    expect(res.exitCode).toBe(0);
    expect(res.posted).toBe(true);
    expect(res.plan?.action).toBe("APPROVE");
    expect(postedEvents).toEqual(["APPROVE"]);

    const forkEventPath = join(dir, "fork-event.json");
    writeFileSync(
      forkEventPath,
      JSON.stringify({
        pull_request: {
          number: 13,
          title: "feat: fork change",
          body: "Inline query",
          base: { ref: "main", repo: { full_name: "acme-org/lintfixer-demo" } },
          head: { sha: "cafebabe5678", repo: { full_name: "forker/lintfixer-demo", fork: true } },
        },
      }),
      "utf8",
    );

    const failDiff = [
      "diff --git a/src/ctrl.ts b/src/ctrl.ts",
      "--- a/src/ctrl.ts",
      "+++ b/src/ctrl.ts",
      "@@ -1,1 +1,1 @@",
      "-export const clean = service.run();",
      "+export const clean = db.query('SELECT 1');",
    ].join("\n");

    const failProvider: ProviderPort = {
      async judgeRuleSlice() {
        return {
          status: "OK",
          judgment: {
            violationProbability: 0.94,
            confidence: 0.96,
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
        return passProvider.judgeBuiltInBatch(
          {} as Parameters<ProviderPort["judgeBuiltInBatch"]>[0],
        );
      },
    };

    const forkRes = await runGitHubPrBot({
      repository: "acme-org/lintfixer-demo",
      eventPath: forkEventPath,
      githubToken: "ghs_fake",
      workspaceDir: dir,
      policySourceOverride: {
        readRules: async () =>
          "## ARCH-001\nseverity: error\nscope: src/**\n### Rule\nDelegate.\n### Violation\nInline DB.\n",
        readConfig: async () => null,
      },
      providerOverride: failProvider,
      githubClientOverride: {
        fetchPullRequest: async () => {
          throw new Error("unused");
        },
        fetchPullRequestDiff: async () => failDiff,
        submitReview: async (_o, _r, _p, _s, plan) => {
          postedEvents.push(plan.action);
          return {
            ok: true,
            statusCode: 200,
            url: "https://github.com/acme-org/lintfixer-demo/pull/13",
          };
        },
      },
    });

    expect(forkRes.exitCode).toBe(1);
    expect(forkRes.plan?.action).toBe("COMMENT");
    expect(forkRes.plan?.forkDowngraded).toBe(true);
    expect(postedEvents).toEqual(["APPROVE", "COMMENT"]);
  });
});

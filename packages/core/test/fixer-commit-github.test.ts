import { describe, expect, it } from "vitest";
import {
  buildPrReviewPlan,
  DEFAULT_POLICY_CONFIG,
  lintCommit,
  type ProviderPort,
  type ReviewResult,
  runAutoFix,
  verifyProposedPatch,
} from "@ikigai/core";

describe("safe auto-fix, commit lint, and GitHub PR bot", () => {
  it("blocks proposed patches targeting protected tests or out-of-scope paths", () => {
    const targetFiles = new Map([
      ["packages/core/test/sample.test.ts", "expect(1).toBe(1);\n"],
      ["src/ctrl.ts", "export function run() {\n  return db.query('x');\n}\n"],
    ]);

    const testPatch = [
      "diff --git a/packages/core/test/sample.test.ts b/packages/core/test/sample.test.ts",
      "--- a/packages/core/test/sample.test.ts",
      "+++ b/packages/core/test/sample.test.ts",
      "@@ -1,1 +1,1 @@",
      "-expect(1).toBe(1);",
      "+expect(1).toBe(2);",
    ].join("\n");

    const blocked = verifyProposedPatch(testPatch, targetFiles, {
      allowedPaths: ["packages/core/test/sample.test.ts", "src/ctrl.ts"],
      fixConfig: DEFAULT_POLICY_CONFIG.fix,
    });
    expect(blocked.status).toBe("REJECTED");
    if (blocked.status === "REJECTED") {
      expect(blocked.code).toBe("PROTECTED_TARGET_BLOCKED");
    }
  });

  it("applies verified fix and automatically rolls back when post-fix test command fails", async () => {
    let currentContent = "export function run() {\n  return db.query('x');\n}\n";
    let rolledBack = false;

    const rulesMd = `
## ARCH-001
severity: error
scope: src/**
fixable: true
### Rule
Use service layer.
### Violation
Direct db call.
`;

    const provider: ProviderPort = {
      async judgeRuleSlice() {
        return {
          status: "OK",
          judgment: {
            violationProbability: 0.1,
            confidence: 0.95,
            evidenceHunk: null,
            rationale: "Fixed.",
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
      async generateFixPatch() {
        return {
          status: "OK",
          summary: "Delegate to service.",
          patchText: [
            "diff --git a/src/ctrl.ts b/src/ctrl.ts",
            "--- a/src/ctrl.ts",
            "+++ b/src/ctrl.ts",
            "@@ -1,3 +1,3 @@",
            " export function run() {",
            "-  return db.query('x');",
            "+  return service.run();",
            " }",
          ].join("\n"),
          telemetry: { provider: "openai", modelId: "gpt-5", latencyMs: 20 },
        };
      },
    };

    const initialReview: ReviewResult = {
      turnId: "t-fix",
      aggregateOutcome: "FAIL",
      counts: { pass: 0, warn: 0, fail: 1, skipped: 0, unavailable: 0 },
      telemetry: [],
      redactedSecretsCount: 0,
      entries: [
        {
          kind: "RULE",
          id: "ARCH-001",
          severity: "error",
          fixable: true,
          outcome: "FAIL",
          violationProbability: 0.92,
          confidence: 0.95,
          scopedPaths: ["src/ctrl.ts"],
          sliceCount: 1,
          slices: [],
          evidenceHunk: { file: "src/ctrl.ts", startLine: 2, endLine: 2, quote: "db.query('x')" },
          rationale: "Direct db call.",
          reason: null,
        },
      ],
    };

    const outcome = await runAutoFix(
      {
        id: "t-fix",
        task: "Fix controller",
        source: "cli",
        files: [{ path: "src/ctrl.ts", patch: "+  return db.query('x');" }],
      },
      initialReview,
      [
        {
          id: "ARCH-001",
          severity: "error",
          scope: null,
          evidence: "code",
          fixable: true,
          description: "Use service layer.",
          violation: "Direct db call.",
          allowed: null,
          fixHint: null,
        },
      ],
      DEFAULT_POLICY_CONFIG,
      {
        policy: { readRules: async () => rulesMd, readConfig: async () => null },
        provider,
        patchApplier: {
          readTargetFiles: async () => new Map([["src/ctrl.ts", currentContent]]),
          applyValidatedPatch: async (updated) => {
            const snapshot = currentContent;
            currentContent = updated.get("src/ctrl.ts") ?? currentContent;
            return {
              rollback: async () => {
                currentContent = snapshot;
                rolledBack = true;
              },
            };
          },
        },
        commandRunner: {
          runVerification: async () => ({ ok: false, exitCode: 1, summary: "vitest failed" }),
        },
        verificationCommand: "pnpm test",
        workingDir: "/repo",
        applyChanges: true,
      },
    );

    expect(outcome.status).toBe("ROLLED_BACK");
    expect(rolledBack).toBe(true);
    expect(currentContent).toContain("db.query('x')");
  });

  it("flags dishonest commit messages and enforces fork-safe PR verdicts", async () => {
    const provider: ProviderPort = {
      async judgeRuleSlice(req) {
        const isCommitCheck = req.checkId === "COMMIT-SEMANTIC-MATCH";
        return {
          status: "OK",
          judgment: {
            violationProbability: isCommitCheck ? 0.92 : 0.1,
            confidence: 0.95,
            evidenceHunk: isCommitCheck
              ? { file: "src/auth.ts", startLine: 1, endLine: 2, quote: "bypassAuth = true" }
              : null,
            rationale: isCommitCheck ? "Commit claims typo fix but disables auth." : "OK",
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

    const commitRes = await lintCommit(
      "fix: typo in readme",
      [
        {
          path: "src/auth.ts",
          patch:
            "diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1,1 +1,1 @@\n+export const bypassAuth = true;\n",
        },
      ],
      {
        policy: {
          readRules: async () => "## R1\nseverity: warning\n### Rule\nR\n### Violation\nV\n",
          readConfig: async () => null,
        },
        provider,
      },
    );

    expect(commitRes.outcome).toBe("FAIL");
    expect(commitRes.semanticMatchOutcome).toBe("FAIL");

    const failReview: ReviewResult = {
      turnId: "pr-42",
      aggregateOutcome: "FAIL",
      counts: { pass: 0, warn: 0, fail: 1, skipped: 0, unavailable: 0 },
      telemetry: [],
      redactedSecretsCount: 0,
      entries: [
        {
          kind: "RULE",
          id: "ARCH-001",
          severity: "error",
          fixable: true,
          outcome: "FAIL",
          violationProbability: 0.88,
          confidence: 0.95,
          scopedPaths: ["src/auth.ts"],
          sliceCount: 1,
          slices: [],
          evidenceHunk: { file: "src/auth.ts", startLine: 2, endLine: 2, quote: "bypassAuth" },
          rationale: "Bypass detected.",
          reason: null,
        },
      ],
    };

    const internalPr = buildPrReviewPlan(
      failReview,
      { isFork: false, baseRef: "main", headSha: "1234567890", prNumber: 42 },
      DEFAULT_POLICY_CONFIG.github,
    );
    expect(internalPr.action).toBe("REQUEST_CHANGES");
    expect(internalPr.inlineComments).toHaveLength(1);

    const forkPr = buildPrReviewPlan(
      failReview,
      { isFork: true, baseRef: "main", headSha: "1234567890", prNumber: 42 },
      DEFAULT_POLICY_CONFIG.github,
    );
    expect(forkPr.action).toBe("COMMENT");
    expect(forkPr.forkDowngraded).toBe(true);
  });

  it("verifies unified diff patches cleanly on UTF-8 BOM files even when hunk line 1 keeps BOM", () => {
    const bomFile = `\uFEFFimport { db } from "./db";\nexport function q() {\n  return db.query("x");\n}\n`;
    const patchWithBom = [
      "diff --git a/src/ctrl.ts b/src/ctrl.ts",
      "--- a/src/ctrl.ts",
      "+++ b/src/ctrl.ts",
      "@@ -1,4 +1,3 @@",
      '-\uFEFFimport { db } from "./db";',
      " export function q() {",
      '-  return db.query("x");',
      "+  return service.get();",
      " }",
    ].join("\n");

    const res = verifyProposedPatch(patchWithBom, new Map([["src/ctrl.ts", bomFile]]), {
      allowedPaths: ["src/ctrl.ts"],
      fixConfig: DEFAULT_POLICY_CONFIG.fix,
    });
    expect(res.status).toBe("VERIFIED");
  });
});

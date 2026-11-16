import { describe, expect, it } from "vitest";
import {
  classifyCommitFiles,
  computeGitScore,
  type ParsedRule,
  type ReviewResult,
} from "../src/index.ts";

const ARCH_RULE: ParsedRule = {
  id: "ARCH-001",
  severity: "error",
  scope: { include: ["src/**"], exclude: ["src/**/*.test.ts"] },
  evidence: "code",
  fixable: true,
  description: "Keep SQL outside HTTP controllers.",
  violation: "Direct db.query inside controllers.",
  allowed: "Delegate to domain services.",
  fixHint: null,
};

describe("git score & cheap pre-filter", () => {
  it("skips lockfiles and out-of-scope files before dispatching semantic prompts", () => {
    const filter = classifyCommitFiles(
      [
        { path: "pnpm-lock.yaml", patch: "lockfileVersion: 9.0\n+very long lock" },
        { path: "README.md", patch: "+updated readme copy" },
        { path: "src/controllers/orders.ts", patch: "+const x = await db.query('select 1');" },
      ],
      [ARCH_RULE],
    );

    expect(filter.totalFiles).toBe(3);
    expect(filter.inScopeCount).toBe(1);
    expect(filter.skippedCount).toBe(2);
    expect(filter.blockedCount).toBe(0);
    expect(filter.savedRatio).toBeGreaterThan(0.4);
  });

  it("blocks sensitive paths and penalizes semantic failures with recoverable post-fix score", () => {
    const fakeReview: ReviewResult = {
      turnId: "t1",
      aggregateOutcome: "FAIL",
      counts: { pass: 0, warn: 0, fail: 1, skipped: 0, unavailable: 0 },
      entries: [
        {
          kind: "RULE",
          id: "ARCH-001",
          severity: "error",
          fixable: true,
          outcome: "FAIL",
          violationProbability: 0.94,
          confidence: 0.96,
          scopedPaths: ["src/controllers/orders.ts"],
          sliceCount: 1,
          slices: [],
          rationale: "Controller executes SQL inline.",
          reason: null,
          evidenceHunk: {
            file: "src/controllers/orders.ts",
            startLine: 10,
            endLine: 11,
            quote: "await db.query('SELECT * FROM orders')",
          },
        },
      ],
      telemetry: [],
      redactedSecretsCount: 0,
    };

    const report = computeGitScore({
      commitMessage: "feat(orders): add listOrders endpoint",
      files: [
        { path: "src/controllers/orders.ts", patch: "+await db.query('SELECT * FROM orders')" },
        { path: "test/orders.test.ts", patch: "+expect(1).toBe(1)" },
      ],
      rules: [ARCH_RULE],
      review: fakeReview,
      hasVerifiedFix: true,
    });

    expect(report.mode).toBe("semantic-verified");
    expect(report.score).toBeLessThan(80);
    expect(report.projectedPostFixScore).toBe(100);
    expect(report.segments14).toHaveLength(14);
    expect(report.segments14.some((s) => s === "fail")).toBe(true);
  });
});

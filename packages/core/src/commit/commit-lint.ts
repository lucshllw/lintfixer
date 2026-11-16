import type { Outcome, ParsedRule, ReviewResult, Turn, TurnFile } from "../domain/types.ts";
import { reviewTurn, type ReviewTurnDependencies } from "../evaluation/review-turn.ts";

const CONVENTIONAL_COMMIT_RE =
  /^(feat|fix|refactor|docs|test|chore|ci|build|perf|style|revert)(?:\(([a-z0-9._/-]+)\))?(!)?:\s+(.+)$/i;

export interface ConventionalCommitParse {
  readonly valid: boolean;
  readonly type: string | null;
  readonly scope: string | null;
  readonly breaking: boolean;
  readonly subject: string;
}

export interface CommitLintResult {
  readonly outcome: Outcome;
  readonly conventional: ConventionalCommitParse;
  readonly messageIssues: readonly string[];
  readonly semanticMatchOutcome: Outcome;
  readonly semanticMatchRationale: string | null;
  readonly review: ReviewResult | null;
}

export function parseConventionalCommit(message: string): ConventionalCommitParse {
  const firstLine = (message.split(/\r?\n/)[0] ?? "").trim();
  if (firstLine === "") {
    return { valid: false, type: null, scope: null, breaking: false, subject: "" };
  }

  const match = CONVENTIONAL_COMMIT_RE.exec(firstLine);
  if (match === null) {
    return { valid: false, type: null, scope: null, breaking: false, subject: firstLine };
  }

  return {
    valid: true,
    type: (match[1] ?? "").toLowerCase(),
    scope: match[2] ?? null,
    breaking: match[3] === "!",
    subject: (match[4] ?? "").trim(),
  };
}

/**
 * Lints a commit message (conventional syntax + semantic honesty against the staged diff)
 * and evaluates repository rules against the staged files.
 */
export async function lintCommit(
  commitMessage: string,
  stagedFiles: readonly TurnFile[],
  deps: ReviewTurnDependencies,
  commitId = "staged-commit",
): Promise<CommitLintResult> {
  const conventional = parseConventionalCommit(commitMessage);
  const messageIssues: string[] = [];

  const turn: Turn = {
    id: commitId,
    task: commitMessage.trim() || "(empty commit message)",
    files: stagedFiles,
    source: "commit",
  };

  const reviewOutput = await reviewTurn(turn, deps);

  if (reviewOutput.config.commitLint.conventionalFormat && !conventional.valid) {
    messageIssues.push("Commit header must follow Conventional Commits (`type(scope): subject`).");
  }

  let semanticMatchOutcome: Outcome = "SKIPPED";
  let semanticMatchRationale: string | null = null;

  if (reviewOutput.config.commitLint.semanticMatch && stagedFiles.length > 0) {
    const matchRule: ParsedRule = {
      id: "COMMIT-SEMANTIC-MATCH",
      severity: "error",
      scope: null,
      evidence: "any",
      fixable: false,
      description:
        "Commit message title and description must accurately describe the staged code changes.",
      violation:
        "Commit message misstates the scope or kind of change (e.g., claims `docs:` or `fix: typo` while changing business logic, security, or APIs).",
      allowed:
        "Accurate commit summaries plus minor incidental formatting or test updates directly supporting the stated change.",
      fixHint: null,
    };

    const matchSliceDiff = stagedFiles.map((f) => f.patch).join("\n");
    const call = await deps.provider.judgeRuleSlice({
      kind: "RULE",
      checkId: matchRule.id,
      ruleSummary: matchRule.description,
      violationCriteria: matchRule.violation,
      allowedCriteria: matchRule.allowed,
      task: turn.task,
      files: stagedFiles.map((f) => f.path),
      diff: matchSliceDiff.slice(0, reviewOutput.config.slicing.maxDiffLength),
      nonce: deps.nonceFactory?.() ?? "ikigai-commit-nonce",
      endpoint: reviewOutput.config.providers.judge,
    });

    if (call.status === "FAILED") {
      semanticMatchOutcome = "UNAVAILABLE";
      semanticMatchRationale = call.errorCode;
    } else {
      const p = call.judgment.violationProbability;
      semanticMatchOutcome =
        p >= reviewOutput.config.thresholds.error.fail
          ? "FAIL"
          : p >= reviewOutput.config.thresholds.error.warn
            ? "WARN"
            : "PASS";
      semanticMatchRationale = call.judgment.rationale;
    }
  }

  const outcomes: Outcome[] = [
    reviewOutput.review.aggregateOutcome,
    semanticMatchOutcome,
    ...(messageIssues.length > 0 ? (["FAIL"] as const) : []),
  ];

  const finalOutcome: Outcome = outcomes.includes("FAIL")
    ? "FAIL"
    : outcomes.includes("UNAVAILABLE")
      ? "UNAVAILABLE"
      : outcomes.includes("WARN")
        ? "WARN"
        : "PASS";

  return {
    outcome: finalOutcome,
    conventional,
    messageIssues,
    semanticMatchOutcome,
    semanticMatchRationale,
    review: reviewOutput.review,
  };
}

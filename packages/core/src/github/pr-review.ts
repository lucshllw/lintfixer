import type { GithubBotConfig, Outcome, ReviewResult } from "../domain/types.ts";

export type PrReviewAction = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export interface PrReviewInlineComment {
  readonly path: string;
  readonly line: number;
  readonly ruleId: string;
  readonly outcome: "FAIL" | "WARN";
  readonly body: string;
}

export interface PrContext {
  readonly isFork: boolean;
  readonly baseRef: string;
  readonly headSha: string;
  readonly prNumber: number;
}

export interface PrReviewPlan {
  readonly action: PrReviewAction;
  readonly summaryBody: string;
  readonly inlineComments: readonly PrReviewInlineComment[];
  readonly forkDowngraded: boolean;
}

/**
 * Converts a semantic review result (plus optional verified fix patch) into a
 * deterministic, fork-safe GitHub Pull Request review verdict.
 */
export function buildPrReviewPlan(
  review: ReviewResult,
  pr: PrContext,
  githubConfig: GithubBotConfig,
  proposedFixPatch: string | null = null,
): PrReviewPlan {
  const inlineComments: PrReviewInlineComment[] = [];

  for (const entry of review.entries) {
    if (entry.kind === "REVIEW") {
      continue;
    }
    if (entry.outcome !== "FAIL" && entry.outcome !== "WARN") {
      continue;
    }

    if (entry.evidenceHunk !== null) {
      const probPct =
        entry.violationProbability !== null
          ? `${Math.round(entry.violationProbability * 100)}%`
          : "n/a";
      const confPct = entry.confidence !== null ? `${Math.round(entry.confidence * 100)}%` : "n/a";

      inlineComments.push({
        path: entry.evidenceHunk.file,
        line: entry.evidenceHunk.endLine,
        ruleId: entry.id,
        outcome: entry.outcome,
        body: [
          `**[Ikigai ${entry.outcome}] \`${entry.id}\`** (violation: ${probPct}, confidence: ${confPct})`,
          entry.rationale ?? "Policy threshold triggered.",
        ].join("\n\n"),
      });
    }
  }

  let action: PrReviewAction = "COMMENT";
  let forkDowngraded = false;

  if (pr.isFork && githubConfig.forkPolicy === "comment-only") {
    action = "COMMENT";
    forkDowngraded = true;
  } else if (review.aggregateOutcome === "FAIL") {
    action = githubConfig.requestChangesOnFail ? "REQUEST_CHANGES" : "COMMENT";
  } else if (review.aggregateOutcome === "UNAVAILABLE") {
    // Never auto-approve when evaluation could not complete safely.
    action = "COMMENT";
  } else if (
    (review.aggregateOutcome === "PASS" ||
      review.aggregateOutcome === "WARN" ||
      review.aggregateOutcome === "SKIPPED") &&
    githubConfig.approveOnPass
  ) {
    action = "APPROVE";
  }

  const summaryBody = renderPrSummaryMarkdown(review, pr, action, forkDowngraded, proposedFixPatch);

  return {
    action,
    summaryBody,
    inlineComments,
    forkDowngraded,
  };
}

function renderPrSummaryMarkdown(
  review: ReviewResult,
  pr: PrContext,
  action: PrReviewAction,
  forkDowngraded: boolean,
  proposedFixPatch: string | null,
): string {
  const lines: string[] = [
    `## Ikigai Semantic Review — **${review.aggregateOutcome}** (\`${action}\`)`,
    "",
    `Evaluated PR #${pr.prNumber} at \`${pr.headSha.slice(0, 8)}\` against rules from protected base \`${pr.baseRef}\`.`,
    `- Counts: PASS ${review.counts.pass} · WARN ${review.counts.warn} · FAIL ${review.counts.fail} · SKIPPED ${review.counts.skipped} · UNAVAILABLE ${review.counts.unavailable}`,
  ];

  if (forkDowngraded) {
    lines.push("- Fork safety policy active: review action restricted to `COMMENT`.");
  }

  if (review.redactedSecretsCount > 0) {
    lines.push(
      `- Redacted ${review.redactedSecretsCount} secret pattern(s) prior to semantic evaluation.`,
    );
  }

  lines.push(
    "",
    "| Check | Outcome | Prob | Confidence | Summary |",
    "| --- | --- | ---: | ---: | --- |",
  );

  for (const entry of review.entries) {
    if (entry.kind === "REVIEW") {
      lines.push(`| REVIEW | ${entry.outcome} | — | — | ${escapePipe(entry.message)} |`);
      continue;
    }

    const prob =
      entry.violationProbability !== null
        ? `${Math.round(entry.violationProbability * 100)}%`
        : "—";
    const conf = entry.confidence !== null ? `${Math.round(entry.confidence * 100)}%` : "—";
    const summary = entry.rationale ?? entry.reason ?? "OK";
    lines.push(
      `| \`${entry.id}\` | ${formatOutcomeBadge(entry.outcome)} | ${prob} | ${conf} | ${escapePipe(summary)} |`,
    );
  }

  if (proposedFixPatch !== null && proposedFixPatch.trim() !== "") {
    lines.push(
      "",
      "### Verified Remediation Patch Candidate",
      "```diff",
      proposedFixPatch.trim(),
      "```",
    );
  }

  return lines.join("\n");
}

function formatOutcomeBadge(outcome: Outcome): string {
  return `**${outcome}**`;
}

function escapePipe(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

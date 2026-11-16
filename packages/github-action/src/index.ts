import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  createFsPolicySource,
  createGitHubRestClient,
  createGitRefPolicySource,
  createMultiProvider,
  createSafePatchApplier,
  type GitHubPrClient,
} from "@ikigai/adapters";
import {
  buildPrReviewPlan,
  type PolicySourcePort,
  type ProviderPort,
  type PrReviewPlan,
  parseUnifiedDiff,
  reviewTurn,
  runAutoFix,
  type Turn,
} from "@ikigai/core";

export interface GitHubActionInput {
  readonly repository: string;
  readonly eventPath: string;
  readonly githubToken: string;
  readonly workspaceDir: string;
  readonly proposeFixes?: boolean;
  readonly dryRun?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly providerOverride?: ProviderPort;
  readonly githubClientOverride?: GitHubPrClient;
  readonly policySourceOverride?: PolicySourcePort;
}

export interface GitHubActionOutcome {
  readonly exitCode: number;
  readonly plan: PrReviewPlan | null;
  readonly posted: boolean;
  readonly reason: string;
}

interface PullRequestEventPayload {
  readonly pull_request?: {
    readonly number?: number;
    readonly title?: string;
    readonly body?: string | null;
    readonly base?: { readonly ref?: string; readonly repo?: { readonly full_name?: string } };
    readonly head?: {
      readonly sha?: string;
      readonly repo?: { readonly full_name?: string; readonly fork?: boolean } | null;
    };
  };
}

/**
 * GitHub Action PR Bot runner:
 * - Evaluates PR diff against rules loaded exclusively from protected `base_ref`
 * - Enforces fork-safe COMMENT-only mode on fork PRs
 * - Optionally proposes verified remediation patches (never auto-applies to PRs)
 * - Submits deterministic APPROVE / REQUEST_CHANGES / COMMENT review
 */
export async function runGitHubPrBot(input: GitHubActionInput): Promise<GitHubActionOutcome> {
  const [owner, repo] = input.repository.split("/");
  if (!owner || !repo) {
    return { exitCode: 2, plan: null, posted: false, reason: "INVALID_GITHUB_REPOSITORY" };
  }

  let event: PullRequestEventPayload;
  try {
    event = JSON.parse(readFileSync(input.eventPath, "utf8")) as PullRequestEventPayload;
  } catch {
    return { exitCode: 2, plan: null, posted: false, reason: "INVALID_EVENT_PAYLOAD" };
  }

  const pr = event.pull_request;
  if (!pr?.number || !pr.head?.sha) {
    return { exitCode: 0, plan: null, posted: false, reason: "NOT_A_PULL_REQUEST_EVENT" };
  }

  const baseRef = pr.base?.ref ?? "main";
  const baseRepo = pr.base?.repo?.full_name ?? input.repository;
  const headRepo = pr.head.repo?.full_name ?? "";
  const isFork = Boolean(pr.head.repo?.fork) || headRepo !== baseRepo;

  const gh = input.githubClientOverride ?? createGitHubRestClient(input.githubToken);
  const rawDiff = await gh.fetchPullRequestDiff(owner, repo, pr.number);
  const parsedDiff = parseUnifiedDiff(rawDiff);

  if (parsedDiff.status === "INVALID") {
    return {
      exitCode: 2,
      plan: null,
      posted: false,
      reason: `INVALID_PR_DIFF:${parsedDiff.reason}`,
    };
  }

  const policy: PolicySourcePort =
    input.policySourceOverride ?? createProtectedPolicyWithFsFallback(input.workspaceDir, baseRef);

  const provider =
    input.providerOverride ??
    createMultiProvider({
      repoRoot: input.workspaceDir,
      workingDir: input.workspaceDir,
      ...(input.env ? { env: input.env } : {}),
    });

  const turn: Turn = {
    id: `pr-${owner}-${repo}-${pr.number}-${pr.head.sha.slice(0, 7)}`,
    task: `${pr.title ?? ""}\n\n${pr.body ?? ""}`.trim() || `PR #${pr.number}`,
    files: parsedDiff.files,
    source: "github-pr",
  };

  const reviewOut = await reviewTurn(turn, {
    policy,
    provider,
    projectScope: input.repository,
    nonceFactory: () => randomBytes(12).toString("hex"),
  });

  let proposedPatch: string | null = null;
  if (input.proposeFixes && reviewOut.review.aggregateOutcome === "FAIL") {
    const fixOut = await runAutoFix(turn, reviewOut.review, reviewOut.rules, reviewOut.config, {
      policy,
      provider,
      patchApplier: createSafePatchApplier(input.workspaceDir),
      workingDir: input.workspaceDir,
      applyChanges: false,
      nonceFactory: () => randomBytes(12).toString("hex"),
    });
    if (fixOut.status === "PROPOSED") {
      proposedPatch = fixOut.patchText;
    }
  }

  const plan = buildPrReviewPlan(
    reviewOut.review,
    {
      isFork,
      baseRef,
      headSha: pr.head.sha,
      prNumber: pr.number,
    },
    reviewOut.config.github,
    proposedPatch,
  );

  let posted = false;
  if (!input.dryRun) {
    const submitted = await gh.submitReview(owner, repo, pr.number, pr.head.sha, plan);
    posted = submitted.ok;
  }

  const exitCode =
    reviewOut.review.aggregateOutcome === "FAIL"
      ? 1
      : reviewOut.review.aggregateOutcome === "UNAVAILABLE"
        ? 2
        : 0;

  return {
    exitCode,
    plan,
    posted,
    reason: `REVIEW_${reviewOut.review.aggregateOutcome}:${plan.action}`,
  };
}

function createProtectedPolicyWithFsFallback(repoRoot: string, baseRef: string): PolicySourcePort {
  const gitPolicy = createGitRefPolicySource(repoRoot, baseRef);
  const fsPolicy = createFsPolicySource(repoRoot);
  return {
    async readRules() {
      return (await gitPolicy.readRules()) ?? fsPolicy.readRules();
    },
    async readConfig() {
      return (await gitPolicy.readConfig()) ?? fsPolicy.readConfig();
    },
  };
}

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  createFsPolicySource,
  createGitHubRestClient,
  createGitRefPolicySource,
  createLocalFeedbackStore,
  createLocalHistoryStore,
  createMemoryOutbox,
  createMultiProvider,
  createSafeCommandRunner,
  createSafePatchApplier,
  findRepoRoot,
  getRangeDiff,
  getStagedDiff,
  resolveGitHubToken,
  resolveIkigaiDataDir,
  saveCredential,
  type CredentialKeyName,
} from "@ikigai/adapters";
import {
  buildPrReviewPlan,
  type CalibrationSample,
  compareSliceAggregations,
  computeDerivedMetrics,
  computeRepeatStability,
  DEFAULT_POLICY_CONFIG,
  lintCommit,
  type Outcome,
  type ParsedRule,
  parsePolicyConfig,
  parseUnifiedDiff,
  type ProviderEndpointConfig,
  type ProviderKind,
  type ProviderPort,
  redactSecrets,
  reviewTurn,
  runAutoFix,
  suggestAllowedRefinements,
  type Turn,
} from "@ikigai/core";
import type { CalibrationFixtureFile, CliIo } from "./types.ts";

const STARTER_RULES = `# Ikigai Policy Rules

## ARCH-001

severity: error
scope: src/**
evidence: code
fixable: true

### Rule

Keep domain logic decoupled from HTTP handlers and UI presentation.

### Violation

A controller or UI component performs direct database queries or embeds domain rules inline.

### Allowed

Input validation, DTO mapping, and calling domain/application services.

## SEC-001

severity: error
scope: **
evidence: code
fixable: false

### Rule

Never commit or expose raw credentials, tokens, or private keys.

### Violation

Hardcoding API keys, secret tokens, or bypassing redaction guards.

### Allowed

Environment variable lookups and explicitly labeled synthetic test fixtures.
`;

const STARTER_CONFIG = `version: 1

thresholds:
  error:
    warn: 0.40
    fail: 0.70
  warning:
    warn: 0.60
  confidenceMin: 0.55

slicing:
  maxDiffLength: 100000
  maxSlicesPerRule: 16
  maxExtraSlicesPerTurn: 32
  aggregation: max

providers:
  judge:
    provider: openai
    model: gpt-5-mini
    mode: api
  fixer:
    provider: openai
    model: gpt-5
    mode: api

fix:
  enabled: true
  maxRecheckCycles: 1
  allowTests: false
  allowDependencies: false
  allowWorkflows: false
  allowConfigs: false

commitLint:
  conventionalFormat: true
  semanticMatch: true

github:
  approveOnPass: true
  requestChangesOnFail: true
  forkPolicy: comment-only

memory:
  emitEvents: true
  ttlDays: 90
`;

export function createNonce(): string {
  return randomBytes(12).toString("hex");
}

export async function handleInit(
  io: CliIo,
  opts: { readonly fromJev: boolean; readonly force: boolean; readonly json: boolean },
): Promise<number> {
  const repoRoot = (await findRepoRoot(io.cwd)) ?? io.cwd;
  const ikigaiDir = join(repoRoot, ".ikigai");
  mkdirSync(ikigaiDir, { recursive: true });

  const rulesDest = join(ikigaiDir, "rules.md");
  const configDest = join(ikigaiDir, "config.yaml");

  if (!opts.force && (existsSync(rulesDest) || existsSync(configDest))) {
    emitOutput(
      io,
      opts.json,
      { ok: false, error: "ALREADY_EXISTS", path: ikigaiDir },
      "`.ikigai/` already exists. Pass --force to overwrite.",
    );
    return 2;
  }

  const jevRules = join(repoRoot, ".jev", "rules.md");
  const jevConfig = join(repoRoot, ".jev", "config.yaml");

  if (opts.fromJev && existsSync(jevRules)) {
    copyFileSync(jevRules, rulesDest);
  } else {
    writeFileSync(rulesDest, STARTER_RULES, "utf8");
  }

  if (opts.fromJev && existsSync(jevConfig)) {
    copyFileSync(jevConfig, configDest);
  } else {
    writeFileSync(configDest, STARTER_CONFIG, "utf8");
  }

  emitOutput(
    io,
    opts.json,
    { ok: true, rulesPath: rulesDest, configPath: configDest },
    `Initialized Ikigai policy at ${ikigaiDir}`,
  );
  return 0;
}

export async function handleLogin(
  io: CliIo,
  opts: { readonly provider: string; readonly json: boolean },
): Promise<number> {
  const valid: readonly CredentialKeyName[] = ["openai", "gemini", "claude", "jev", "github"];
  if (!valid.includes(opts.provider as CredentialKeyName)) {
    emitOutput(
      io,
      opts.json,
      { ok: false, error: "INVALID_PROVIDER" },
      `Provider must be one of: ${valid.join(", ")}`,
    );
    return 2;
  }

  const secret = (await io.stdinText()).trim();
  if (secret === "") {
    emitOutput(
      io,
      opts.json,
      { ok: false, error: "EMPTY_SECRET" },
      "Pipe the API key via stdin (never pass secrets as CLI arguments).",
    );
    return 2;
  }

  const path = saveCredential(opts.provider as CredentialKeyName, secret, io.env);
  emitOutput(
    io,
    opts.json,
    { ok: true, provider: opts.provider, storedAt: path },
    `Saved ${opts.provider} credential in owner-only store (${path}).`,
  );
  return 0;
}

export async function handleCheck(
  io: CliIo,
  opts: {
    readonly diffPath?: string;
    readonly staged: boolean;
    readonly range?: string;
    readonly task: string;
    readonly ruleFilter?: readonly string[];
    readonly fix: boolean;
    readonly apply: boolean;
    readonly verifyCmd?: string;
    readonly allowProtectedOverride: boolean;
    readonly json: boolean;
    readonly providerOverride?: ProviderPort;
  },
): Promise<number> {
  const repoRoot = (await findRepoRoot(io.cwd)) ?? io.cwd;
  let diffText: string | null = null;

  if (opts.diffPath === "-") {
    diffText = await io.stdinText();
  } else if (opts.diffPath) {
    const abs = resolve(io.cwd, opts.diffPath);
    if (!existsSync(abs)) {
      emitOutput(
        io,
        opts.json,
        { ok: false, error: "DIFF_NOT_FOUND" },
        `Diff file not found: ${abs}`,
      );
      return 2;
    }
    diffText = readFileSync(abs, "utf8");
  } else if (opts.range) {
    diffText = await getRangeDiff(repoRoot, opts.range);
  } else {
    diffText = await getStagedDiff(repoRoot);
  }

  if (diffText === null) {
    emitOutput(io, opts.json, { ok: false, error: "DIFF_READ_FAILED" }, "Could not read git diff.");
    return 2;
  }

  const parsedDiff = parseUnifiedDiff(diffText);
  if (parsedDiff.status === "INVALID") {
    emitOutput(
      io,
      opts.json,
      { ok: false, error: "INVALID_DIFF", reason: parsedDiff.reason },
      `Invalid unified diff: ${parsedDiff.reason}`,
    );
    return 2;
  }

  const turn: Turn = {
    id: `turn-${Date.now()}`,
    task: opts.task,
    files: parsedDiff.files,
    source: opts.staged ? "git-staged" : "cli",
  };

  const policy = createFsPolicySource(repoRoot);
  const provider =
    opts.providerOverride ?? createMultiProvider({ repoRoot, workingDir: repoRoot, env: io.env });
  const dataDir = resolveIkigaiDataDir(io.env);
  const history = createLocalHistoryStore(dataDir);
  const memory = createMemoryOutbox(dataDir);

  const output = await reviewTurn(turn, {
    policy,
    provider,
    memory,
    projectScope: repoRoot,
    nonceFactory: createNonce,
    ...(opts.ruleFilter && opts.ruleFilter.length > 0 ? { ruleFilter: opts.ruleFilter } : {}),
  });

  await history.appendReview({
    timestamp: new Date().toISOString(),
    turnId: output.review.turnId,
    aggregateOutcome: output.review.aggregateOutcome,
    counts: output.review.counts,
    results: output.review.entries.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      outcome: entry.outcome,
      violationProbability: "violationProbability" in entry ? entry.violationProbability : null,
      confidence: "confidence" in entry ? entry.confidence : null,
      reason: entry.reason ?? null,
      scopedPaths: "scopedPaths" in entry ? entry.scopedPaths : [],
    })),
  });

  let fixOutcome = null;
  if (opts.fix && output.review.aggregateOutcome === "FAIL") {
    fixOutcome = await runAutoFix(turn, output.review, output.rules, output.config, {
      policy,
      provider,
      patchApplier: createSafePatchApplier(repoRoot),
      commandRunner: createSafeCommandRunner(),
      memory,
      workingDir: repoRoot,
      applyChanges: opts.apply,
      allowProtectedOverride: opts.allowProtectedOverride,
      projectScope: repoRoot,
      nonceFactory: createNonce,
      ...(opts.verifyCmd ? { verificationCommand: opts.verifyCmd } : {}),
    });
  }

  const payload = {
    turnId: output.review.turnId,
    aggregateOutcome: output.review.aggregateOutcome,
    counts: output.review.counts,
    redactedSecretsCount: output.review.redactedSecretsCount,
    entries: output.review.entries,
    fix: fixOutcome,
  };

  emitOutput(
    io,
    opts.json,
    payload,
    formatReviewText(
      output.review.aggregateOutcome,
      output.review.counts,
      output.review.entries,
      fixOutcome,
    ),
  );

  if (fixOutcome?.status === "ROLLED_BACK" || fixOutcome?.status === "FAILED") {
    return 1;
  }
  if (output.review.aggregateOutcome === "FAIL") {
    return 1;
  }
  if (output.review.aggregateOutcome === "UNAVAILABLE") {
    return 2;
  }
  return 0;
}

export async function handleCommitLint(
  io: CliIo,
  opts: {
    readonly msg?: string;
    readonly msgFile?: string;
    readonly json: boolean;
    readonly providerOverride?: ProviderPort;
  },
): Promise<number> {
  const repoRoot = (await findRepoRoot(io.cwd)) ?? io.cwd;
  let commitMessage = opts.msg ?? "";
  if (opts.msgFile) {
    commitMessage = readFileSync(resolve(io.cwd, opts.msgFile), "utf8");
  }
  if (commitMessage.trim() === "") {
    emitOutput(io, opts.json, { ok: false, error: "EMPTY_COMMIT_MSG" }, "Commit message is empty.");
    return 2;
  }

  const diffText = await getStagedDiff(repoRoot);
  if (diffText === null) {
    emitOutput(
      io,
      opts.json,
      { ok: false, error: "STAGED_DIFF_FAILED" },
      "Could not read staged diff.",
    );
    return 2;
  }

  const parsed = parseUnifiedDiff(diffText);
  if (parsed.status === "INVALID") {
    emitOutput(
      io,
      opts.json,
      { ok: false, error: "INVALID_DIFF", reason: parsed.reason },
      `Invalid staged diff: ${parsed.reason}`,
    );
    return 2;
  }

  const provider =
    opts.providerOverride ?? createMultiProvider({ repoRoot, workingDir: repoRoot, env: io.env });
  const dataDir = resolveIkigaiDataDir(io.env);

  const result = await lintCommit(commitMessage, parsed.files, {
    policy: createFsPolicySource(repoRoot),
    provider,
    memory: createMemoryOutbox(dataDir),
    projectScope: repoRoot,
    nonceFactory: createNonce,
  });

  emitOutput(
    io,
    opts.json,
    result,
    [
      `Commit Lint: ${result.outcome}`,
      `Conventional format: ${result.conventional.valid ? "OK" : "INVALID"}`,
      `Semantic message match: ${result.semanticMatchOutcome}${result.semanticMatchRationale ? ` (${result.semanticMatchRationale})` : ""}`,
      ...result.messageIssues.map((i) => `- ${i}`),
    ].join("\n"),
  );

  return result.outcome === "FAIL" ? 1 : result.outcome === "UNAVAILABLE" ? 2 : 0;
}

export async function handleCalibrate(
  io: CliIo,
  opts: {
    readonly corpusPath: string;
    readonly repeats: number;
    readonly threshold: number;
    readonly providerName?: string;
    readonly modelName?: string;
    readonly json: boolean;
    readonly providerOverride?: ProviderPort;
  },
): Promise<number> {
  const absCorpus = resolve(io.cwd, opts.corpusPath);
  if (!existsSync(absCorpus)) {
    emitOutput(
      io,
      opts.json,
      { ok: false, error: "CORPUS_NOT_FOUND" },
      `Corpus not found: ${absCorpus}`,
    );
    return 2;
  }

  const corpus = JSON.parse(
    readFileSync(absCorpus, "utf8").replace(/^\uFEFF/, ""),
  ) as CalibrationFixtureFile;
  const threshold = corpus.threshold ?? opts.threshold;
  const repoRoot = (await findRepoRoot(io.cwd)) ?? io.cwd;
  const fsPolicy = createFsPolicySource(repoRoot);
  const parsedCfg = parsePolicyConfig(await fsPolicy.readConfig());
  const baseEndpoint =
    parsedCfg.status === "PARSED"
      ? parsedCfg.config.providers.judge
      : DEFAULT_POLICY_CONFIG.providers.judge;

  const validProviders = new Set(["openai", "gemini", "claude", "cli", "jev"]);
  const selectedProvider =
    opts.providerName && validProviders.has(opts.providerName)
      ? (opts.providerName as ProviderKind)
      : baseEndpoint.provider;

  const endpoint: ProviderEndpointConfig = {
    provider: selectedProvider,
    model: opts.modelName ?? baseEndpoint.model,
    mode: selectedProvider === "cli" ? "cli" : baseEndpoint.mode,
    ...(baseEndpoint.cliCommand ? { cliCommand: baseEndpoint.cliCommand } : {}),
  };

  const provider =
    opts.providerOverride ?? createMultiProvider({ repoRoot, workingDir: repoRoot, env: io.env });
  const samples: CalibrationSample[] = [];
  const errors: string[] = [];

  for (const item of corpus.cases) {
    const repeats = item.precomputedProbability !== undefined ? 1 : Math.max(1, opts.repeats);
    for (let r = 1; r <= repeats; r += 1) {
      if (item.precomputedProbability !== undefined) {
        const prob = item.precomputedProbability;
        const outcome: Outcome = prob >= threshold ? "FAIL" : "PASS";
        samples.push({
          fixtureId: item.fixtureId,
          ruleId: item.ruleId,
          authorLabel: item.authorLabel,
          probability: prob,
          confidence: item.precomputedConfidence ?? 0.9,
          outcome,
          repeat: r,
          ...(item.sliceProbabilities ? { sliceProbabilities: item.sliceProbabilities } : {}),
          ...(item.scopedPath ? { scopedPath: item.scopedPath } : {}),
          ...(item.rationale ? { rationale: item.rationale } : {}),
        });
        continue;
      }

      const safeTask = redactSecrets(item.task);
      const safeDiff = redactSecrets(item.diff);
      if (safeTask.hasCriticalUnredacted || safeDiff.hasCriticalUnredacted) {
        errors.push(`${item.fixtureId}#${r}: UNREDACTED_SECRET`);
        samples.push({
          fixtureId: item.fixtureId,
          ruleId: item.ruleId,
          authorLabel: item.authorLabel,
          probability: null,
          confidence: null,
          outcome: "UNAVAILABLE",
          repeat: r,
          ...(item.scopedPath ? { scopedPath: item.scopedPath } : {}),
        });
        continue;
      }

      const res = await provider.judgeRuleSlice({
        kind: "RULE",
        checkId: item.ruleId,
        ruleSummary: item.ruleSummary ?? `Policy rule ${item.ruleId}`,
        violationCriteria: item.violationCriteria ?? "Change violates rule.",
        allowedCriteria: item.allowedCriteria ?? null,
        task: safeTask.text,
        files: [item.scopedPath ?? "src/unknown.ts"],
        diff: safeDiff.text,
        nonce: createNonce(),
        endpoint,
      });

      if (res.status === "FAILED") {
        errors.push(`${item.fixtureId}#${r}: ${res.errorCode}`);
      }

      samples.push({
        fixtureId: item.fixtureId,
        ruleId: item.ruleId,
        authorLabel: item.authorLabel,
        probability: res.status === "OK" ? res.judgment.violationProbability : null,
        confidence: res.status === "OK" ? res.judgment.confidence : null,
        outcome:
          res.status === "OK"
            ? res.judgment.violationProbability >= threshold
              ? "FAIL"
              : "PASS"
            : "UNAVAILABLE",
        repeat: r,
        ...(item.scopedPath ? { scopedPath: item.scopedPath } : {}),
        ...(res.status === "OK" ? { rationale: res.judgment.rationale } : {}),
      });
    }
  }

  const metrics = computeDerivedMetrics(samples, threshold);
  const stability = computeRepeatStability(samples, threshold);
  const aggregations = compareSliceAggregations(samples, threshold);
  const allowedSuggestions = suggestAllowedRefinements(samples, threshold);

  const report = {
    endpoint,
    threshold,
    totalSamples: samples.length,
    errors,
    metrics,
    stability,
    aggregations,
    allowedSuggestions,
  };

  emitOutput(
    io,
    opts.json,
    report,
    [
      `Calibration @ threshold=${threshold} (${samples.length} samples)`,
      `Precision: ${fmtPct(metrics.precision)} | Recall: ${fmtPct(metrics.recall)} | F1: ${fmtPct(metrics.f1)}`,
      `Brier: ${metrics.brierScore?.toFixed(4) ?? "n/a"} | ECE: ${metrics.ece?.toFixed(4) ?? "n/a"}`,
      `Aggregations: ${aggregations.map((a) => `${a.mode}(F1=${fmtPct(a.metrics.f1)})`).join(", ")}`,
      `Suggested Allowed refinements: ${allowedSuggestions.length}`,
    ].join("\n"),
  );
  return 0;
}

export async function handlePrReview(
  io: CliIo,
  opts: {
    readonly repo: string;
    readonly prNumber: number;
    readonly dryRun: boolean;
    readonly fix: boolean;
    readonly json: boolean;
    readonly providerOverride?: ProviderPort;
  },
): Promise<number> {
  const [owner, repo] = opts.repo.split("/");
  if (!owner || !repo) {
    emitOutput(io, opts.json, { ok: false, error: "INVALID_REPO" }, "Expected --repo owner/name.");
    return 2;
  }

  const token = await resolveGitHubToken(io.env);
  if (!token) {
    emitOutput(
      io,
      opts.json,
      { ok: false, error: "MISSING_GITHUB_TOKEN" },
      "Missing GITHUB_TOKEN (or `gh auth login`).",
    );
    return 2;
  }

  const gh = createGitHubRestClient(token);
  const meta = await gh.fetchPullRequest(owner, repo, opts.prNumber);
  const rawDiff = await gh.fetchPullRequestDiff(owner, repo, opts.prNumber);
  const parsedDiff = parseUnifiedDiff(rawDiff);

  if (parsedDiff.status === "INVALID") {
    emitOutput(
      io,
      opts.json,
      { ok: false, error: "INVALID_DIFF", reason: parsedDiff.reason },
      `PR diff failed strict parse: ${parsedDiff.reason}`,
    );
    return 2;
  }

  const repoRoot = (await findRepoRoot(io.cwd)) ?? io.cwd;
  const policy = existsSync(join(repoRoot, ".git"))
    ? createGitRefPolicySource(repoRoot, meta.baseRef)
    : createFsPolicySource(repoRoot);
  const provider =
    opts.providerOverride ?? createMultiProvider({ repoRoot, workingDir: repoRoot, env: io.env });
  const dataDir = resolveIkigaiDataDir(io.env);

  const turn: Turn = {
    id: `pr-${owner}-${repo}-${meta.number}-${meta.headSha.slice(0, 7)}`,
    task: `${meta.title}\n\n${meta.body}`.trim(),
    files: parsedDiff.files,
    source: "github-pr",
  };

  const reviewOut = await reviewTurn(turn, {
    policy,
    provider,
    memory: createMemoryOutbox(dataDir),
    projectScope: `${owner}/${repo}`,
    nonceFactory: createNonce,
  });

  let proposedFixPatch: string | null = null;
  if (opts.fix && reviewOut.review.aggregateOutcome === "FAIL") {
    const fixOut = await runAutoFix(turn, reviewOut.review, reviewOut.rules, reviewOut.config, {
      policy,
      provider,
      patchApplier: createSafePatchApplier(repoRoot),
      workingDir: repoRoot,
      applyChanges: false,
      nonceFactory: createNonce,
    });
    if (fixOut.status === "PROPOSED") {
      proposedFixPatch = fixOut.patchText;
    }
  }

  const plan = buildPrReviewPlan(
    reviewOut.review,
    {
      isFork: meta.isFork,
      baseRef: meta.baseRef,
      headSha: meta.headSha,
      prNumber: meta.number,
    },
    reviewOut.config.github,
    proposedFixPatch,
  );

  let submission: {
    readonly ok: boolean;
    readonly statusCode: number;
    readonly url: string | null;
  } | null = null;

  if (!opts.dryRun) {
    submission = await gh.submitReview(owner, repo, meta.number, meta.headSha, plan);
  }

  emitOutput(
    io,
    opts.json,
    { pr: meta, plan, submission },
    opts.dryRun
      ? plan.summaryBody
      : `Submitted ${plan.action} on PR #${meta.number}: ${submission?.url ?? submission?.statusCode}`,
  );

  return reviewOut.review.aggregateOutcome === "FAIL" ? 1 : 0;
}

export async function handleReportAndFeedback(
  io: CliIo,
  opts: {
    readonly action: "report" | "feedback";
    readonly index?: number;
    readonly decision?: "right" | "wrong";
    readonly json: boolean;
  },
): Promise<number> {
  const dataDir = resolveIkigaiDataDir(io.env);
  const history = createLocalHistoryStore(dataDir);
  const feedbackStore = createLocalFeedbackStore(dataDir);
  const reviews = await history.readReviews();

  if (opts.action === "feedback") {
    const fails: { turnId: string; ruleId: string; outcome: Outcome }[] = [];
    for (const review of reviews.slice().reverse()) {
      for (const r of review.results) {
        if (r.kind === "RULE" && r.outcome === "FAIL" && r.id) {
          fails.push({ turnId: review.turnId, ruleId: r.id, outcome: r.outcome });
        }
      }
    }

    if (opts.index === undefined || opts.decision === undefined) {
      emitOutput(
        io,
        opts.json,
        { fails },
        fails.length === 0
          ? "No FAIL findings recorded yet."
          : fails.map((f, i) => `${i + 1}. [${f.ruleId}] turn=${f.turnId}`).join("\n"),
      );
      return 0;
    }

    const picked = fails[opts.index - 1];
    if (!picked) {
      emitOutput(io, opts.json, { ok: false, error: "INVALID_INDEX" }, "Invalid FAIL index.");
      return 2;
    }

    await feedbackStore.record({
      timestamp: new Date().toISOString(),
      turnId: picked.turnId,
      ruleId: picked.ruleId,
      decision: opts.decision === "right" ? "RIGHT" : "WRONG",
    });

    emitOutput(
      io,
      opts.json,
      { ok: true, recorded: picked, decision: opts.decision },
      `Recorded ${opts.decision.toUpperCase()} feedback for ${picked.ruleId}.`,
    );
    return 0;
  }

  const feedback = await feedbackStore.readAll();
  const rightCount = feedback.filter((f) => f.decision === "RIGHT").length;
  const wrongCount = feedback.filter((f) => f.decision === "WRONG").length;

  const summary = {
    totalReviews: reviews.length,
    outcomes: reviews.reduce(
      (acc, r) => ({
        pass: acc.pass + r.counts.pass,
        warn: acc.warn + r.counts.warn,
        fail: acc.fail + r.counts.fail,
        skipped: acc.skipped + r.counts.skipped,
        unavailable: acc.unavailable + r.counts.unavailable,
      }),
      { pass: 0, warn: 0, fail: 0, skipped: 0, unavailable: 0 },
    ),
    feedback: { total: feedback.length, right: rightCount, wrong: wrongCount },
  };

  emitOutput(
    io,
    opts.json,
    summary,
    `Ikigai Report: ${summary.totalReviews} reviews | PASS ${summary.outcomes.pass} WARN ${summary.outcomes.warn} FAIL ${summary.outcomes.fail} | Feedback RIGHT=${rightCount} WRONG=${wrongCount}`,
  );
  return 0;
}

export async function handleInstallGitHooks(
  io: CliIo,
  opts: { readonly json: boolean },
): Promise<number> {
  const repoRoot = await findRepoRoot(io.cwd);
  if (!repoRoot) {
    emitOutput(
      io,
      opts.json,
      { ok: false, error: "NOT_A_GIT_REPO" },
      "Not inside a git repository.",
    );
    return 2;
  }

  const hooksDir = join(repoRoot, ".git", "hooks");
  mkdirSync(hooksDir, { recursive: true });

  const preCommit = join(hooksDir, "pre-commit");
  const commitMsg = join(hooksDir, "commit-msg");

  writeFileSync(preCommit, `#!/usr/bin/env sh\nnpx ikigai check --staged\n`, {
    encoding: "utf8",
    mode: 0o755,
  });
  writeFileSync(commitMsg, `#!/usr/bin/env sh\nnpx ikigai commit-lint --msg-file "$1"\n`, {
    encoding: "utf8",
    mode: 0o755,
  });

  try {
    chmodSync(preCommit, 0o755);
    chmodSync(commitMsg, 0o755);
  } catch {
    // Ignore on Windows filesystems.
  }

  emitOutput(
    io,
    opts.json,
    { ok: true, installed: [preCommit, commitMsg] },
    `Installed git hooks: ${preCommit} and ${commitMsg}`,
  );
  return 0;
}

function formatReviewText(
  aggregateOutcome: Outcome,
  counts: { pass: number; warn: number; fail: number; skipped: number; unavailable: number },
  entries: readonly { id: string | null; outcome: Outcome; reason?: string | null }[],
  fixOutcome: Awaited<ReturnType<typeof runAutoFix>> | null,
): string {
  const lines = [
    `Ikigai ${aggregateOutcome}`,
    `pass ${counts.pass} · warn ${counts.warn} · fail ${counts.fail} · skipped ${counts.skipped} · unavailable ${counts.unavailable}`,
  ];
  for (const e of entries) {
    if (e.outcome === "FAIL" || e.outcome === "WARN" || e.outcome === "UNAVAILABLE") {
      lines.push(`- [${e.outcome}] ${e.id ?? "REVIEW"}${e.reason ? ` (${e.reason})` : ""}`);
    }
  }
  if (fixOutcome) {
    lines.push(`Auto-Fix: ${fixOutcome.status} — ${fixOutcome.summary}`);
  }
  return lines.join("\n");
}

function fmtPct(v: number | null): string {
  return v === null ? "n/a" : `${(v * 100).toFixed(1)}%`;
}

function emitOutput(io: CliIo, json: boolean, data: unknown, humanText: string): void {
  io.stdout(json ? JSON.stringify(data, null, 2) : humanText);
}

export type { ParsedRule };

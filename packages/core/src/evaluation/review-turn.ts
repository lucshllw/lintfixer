import type {
  BuiltInReviewResult,
  MemoryEventV1,
  ParsedRule,
  PolicyConfig,
  ProviderTelemetry,
  ReviewCounts,
  ReviewEntry,
  ReviewResult,
  SliceEvaluationRecord,
  SyntheticUnavailableResult,
  Turn,
  TurnFile,
} from "../domain/types.ts";
import { DEFAULT_EVIDENCE_POLICY } from "../evidence/defaults.ts";
import { planRuleEvidence } from "../evidence/plan-slices.ts";
import { redactSecrets } from "../evidence/redact.ts";
import { checkFilePath } from "../evidence/safety.ts";
import type {
  BuiltInBatchRequest,
  JudgeCallResult,
  MemoryPort,
  PolicySourcePort,
  ProviderPort,
} from "../ports/types.ts";
import { DEFAULT_POLICY_CONFIG, parsePolicyConfig } from "../rules/parse-config.ts";
import { parseRules } from "../rules/parse-rules.ts";
import { BUILT_IN_DEFINITIONS } from "./builtins.ts";
import { aggregateSliceJudgments, combineAggregateOutcome, evaluateSingleGate } from "./gate.ts";
import { verifyEvidenceGrounding } from "./grounding.ts";

export interface ReviewTurnDependencies {
  readonly policy: PolicySourcePort;
  readonly provider: ProviderPort;
  readonly memory?: MemoryPort;
  readonly projectScope?: string;
  readonly nonceFactory?: () => string;
  readonly timestampFactory?: () => string;
  readonly ruleFilter?: readonly string[];
  readonly includeBuiltIns?: boolean;
}

export interface ReviewTurnOutput {
  readonly review: ReviewResult;
  readonly rules: readonly ParsedRule[];
  readonly config: PolicyConfig;
  readonly memoryEvents: readonly MemoryEventV1[];
}

/**
 * Orchestrates one complete semantic review over an attributed turn:
 * 1) loads and validates policy files once,
 * 2) redacts secrets (fail-closed if unredacted secret remains),
 * 3) evaluates repository rules and built-in checks concurrently,
 * 4) emits versioned MemoryEventV1 audit events for Phase 2 readiness.
 */
export async function reviewTurn(
  turn: Turn,
  deps: ReviewTurnDependencies,
): Promise<ReviewTurnOutput> {
  const [rulesText, configText] = await Promise.all([
    deps.policy.readRules(),
    deps.policy.readConfig(),
  ]);

  const configResult = parsePolicyConfig(configText);
  if (configResult.status === "INVALID") {
    const entry: SyntheticUnavailableResult = {
      kind: "REVIEW",
      id: null,
      outcome: "UNAVAILABLE",
      reason: "INVALID_CONFIG",
      message: configResult.message,
    };
    return buildUnavailableOutput(turn.id, entry, deps);
  }

  const config = configResult.config;
  const nonce = deps.nonceFactory?.() ?? "ikigai-static-nonce";
  const redaction = redactTurn(turn);

  if (redaction.hasCriticalUnredacted) {
    const entry: SyntheticUnavailableResult = {
      kind: "REVIEW",
      id: null,
      outcome: "UNAVAILABLE",
      reason: "UNREDACTED_SECRET",
      message: "Critical unredacted secret detected; refusing to dispatch prompt.",
    };
    return buildUnavailableOutput(turn.id, entry, deps, config, redaction.redactionCount);
  }

  const safeTurn = redaction.turn;
  const telemetry: ProviderTelemetry[] = [];

  const [ruleLane, builtInEntries] = await Promise.all([
    evaluateRuleLane(safeTurn, rulesText, config, nonce, deps, telemetry),
    deps.includeBuiltIns === false
      ? Promise.resolve([] as readonly BuiltInReviewResult[])
      : evaluateBuiltIns(safeTurn, config, nonce, deps.provider, telemetry),
  ]);

  const entries: ReviewEntry[] = [...ruleLane.entries, ...builtInEntries];
  const counts = countOutcomes(entries);
  const aggregateOutcome = combineAggregateOutcome(entries.map((e) => e.outcome));

  const review: ReviewResult = {
    turnId: turn.id,
    aggregateOutcome,
    counts,
    entries,
    telemetry,
    redactedSecretsCount: redaction.redactionCount,
  };

  const memoryEvents = config.memory.emitEvents
    ? toMemoryEvents(review, config, deps)
    : ([] as readonly MemoryEventV1[]);

  if (deps.memory && memoryEvents.length > 0) {
    await deps.memory.emit(memoryEvents);
  }

  return { review, rules: ruleLane.validRules, config, memoryEvents };
}

function redactTurn(turn: Turn): {
  readonly turn: Turn;
  readonly redactionCount: number;
  readonly hasCriticalUnredacted: boolean;
} {
  let redactionCount = 0;
  let hasCriticalUnredacted = false;

  const taskRes = redactSecrets(turn.task);
  redactionCount += taskRes.redactionCount;
  hasCriticalUnredacted = hasCriticalUnredacted || taskRes.hasCriticalUnredacted;

  const files: TurnFile[] = turn.files.map((file) => {
    const patchRes = redactSecrets(file.patch);
    redactionCount += patchRes.redactionCount;
    hasCriticalUnredacted = hasCriticalUnredacted || patchRes.hasCriticalUnredacted;
    return { path: file.path, patch: patchRes.text };
  });

  return {
    turn: { ...turn, task: taskRes.text, files },
    redactionCount,
    hasCriticalUnredacted,
  };
}

async function evaluateRuleLane(
  turn: Turn,
  rulesText: string | null,
  config: PolicyConfig,
  nonce: string,
  deps: ReviewTurnDependencies,
  telemetry: ProviderTelemetry[],
): Promise<{
  readonly entries: readonly ReviewEntry[];
  readonly validRules: readonly ParsedRule[];
}> {
  if (rulesText === null) {
    return {
      validRules: [],
      entries: [
        {
          kind: "REVIEW",
          id: null,
          outcome: "UNAVAILABLE",
          reason: "MISSING_POLICY",
          message: "Missing .ikigai/rules.md policy file.",
        },
      ],
    };
  }

  const parsedCandidates = parseRules(rulesText);
  const validRules: ParsedRule[] = [];
  const entries: ReviewEntry[] = [];
  let extraSlicesUsed = 0;

  for (const candidate of parsedCandidates) {
    if (candidate.status === "INVALID") {
      entries.push({
        kind: "RULE",
        id: candidate.id ?? "INVALID",
        severity: "error",
        fixable: false,
        outcome: "UNAVAILABLE",
        violationProbability: null,
        confidence: null,
        scopedPaths: [],
        sliceCount: 0,
        slices: [],
        evidenceHunk: null,
        rationale: candidate.reason,
        reason: "INVALID_RULE",
      });
      continue;
    }

    const rule = candidate.rule;
    validRules.push(rule);

    if (deps.ruleFilter && deps.ruleFilter.length > 0 && !deps.ruleFilter.includes(rule.id)) {
      continue;
    }

    const plan = planRuleEvidence(turn, rule, config.slicing, DEFAULT_EVIDENCE_POLICY);
    if (plan.status === "SKIPPED") {
      entries.push({
        kind: "RULE",
        id: rule.id,
        severity: rule.severity,
        fixable: rule.fixable,
        outcome: "SKIPPED",
        violationProbability: null,
        confidence: null,
        scopedPaths: [],
        sliceCount: 0,
        slices: [],
        evidenceHunk: null,
        rationale: null,
        reason: plan.reason,
      });
      continue;
    }

    if (plan.status === "UNAVAILABLE") {
      entries.push({
        kind: "RULE",
        id: rule.id,
        severity: rule.severity,
        fixable: rule.fixable,
        outcome: "UNAVAILABLE",
        violationProbability: null,
        confidence: null,
        scopedPaths: [],
        sliceCount: 0,
        slices: [],
        evidenceHunk: null,
        rationale: null,
        reason: plan.reason,
      });
      continue;
    }

    const extraNeeded = Math.max(0, plan.slices.length - 1);
    if (extraSlicesUsed + extraNeeded > config.slicing.maxExtraSlicesPerTurn) {
      entries.push({
        kind: "RULE",
        id: rule.id,
        severity: rule.severity,
        fixable: rule.fixable,
        outcome: "UNAVAILABLE",
        violationProbability: null,
        confidence: null,
        scopedPaths: plan.slices.flatMap((s) => s.files),
        sliceCount: plan.slices.length,
        slices: [],
        evidenceHunk: null,
        rationale: null,
        reason: "SLICE_LIMIT_EXCEEDED",
      });
      continue;
    }
    extraSlicesUsed += extraNeeded;

    const warnFloor =
      rule.severity === "error" ? config.thresholds.error.warn : config.thresholds.warning.warn;

    const sliceRecords: SliceEvaluationRecord[] = await Promise.all(
      plan.slices.map(async (slice): Promise<SliceEvaluationRecord> => {
        const res: JudgeCallResult = await deps.provider.judgeRuleSlice({
          kind: "RULE",
          checkId: rule.id,
          ruleSummary: rule.description,
          violationCriteria: rule.violation,
          allowedCriteria: rule.allowed,
          task: turn.task,
          files: slice.files,
          diff: slice.diff,
          nonce,
          endpoint: config.providers.judge,
        });

        if (res.telemetry) {
          telemetry.push(res.telemetry);
        }

        if (res.status === "FAILED") {
          return {
            sliceIndex: slice.index,
            path: slice.path,
            hunkOrdinal: slice.hunkOrdinal,
            outcome: "UNAVAILABLE",
            probability: null,
            confidence: null,
            grounded: false,
            evidenceHunk: null,
            rationale: null,
            reason: res.reason,
          };
        }

        const grounding = verifyEvidenceGrounding(res.judgment, slice.files, slice.diff, warnFloor);
        const gate = evaluateSingleGate(
          rule.severity,
          res.judgment.violationProbability,
          res.judgment.confidence,
          grounding.grounded,
          config.thresholds,
        );

        return {
          sliceIndex: slice.index,
          path: slice.path,
          hunkOrdinal: slice.hunkOrdinal,
          outcome: gate.outcome,
          probability: gate.violationProbability,
          confidence: res.judgment.confidence,
          grounded: grounding.grounded,
          evidenceHunk: res.judgment.evidenceHunk,
          rationale: res.judgment.rationale,
          reason: grounding.grounded ? null : "UNGROUNDED_EVIDENCE",
        };
      }),
    );

    const agg = aggregateSliceJudgments(
      rule.severity,
      sliceRecords,
      config.slicing.aggregation,
      config.slicing.topK,
      config.thresholds,
    );

    const bestSlice = sliceRecords
      .slice()
      .sort((a, b) => (b.probability ?? -1) - (a.probability ?? -1))[0];

    const scopedPaths = Array.from(new Set(plan.slices.flatMap((s) => s.files)));

    entries.push({
      kind: "RULE",
      id: rule.id,
      severity: rule.severity,
      fixable: rule.fixable,
      outcome: agg.outcome,
      violationProbability: agg.probability,
      confidence: agg.confidence,
      scopedPaths,
      sliceCount: sliceRecords.length,
      slices: sliceRecords,
      evidenceHunk: bestSlice?.evidenceHunk ?? null,
      rationale: bestSlice?.rationale ?? null,
      reason: agg.outcome === "UNAVAILABLE" ? (bestSlice?.reason ?? "PROVIDER_FAILURE") : null,
    });
  }

  return { entries, validRules };
}

async function evaluateBuiltIns(
  turn: Turn,
  config: PolicyConfig,
  nonce: string,
  provider: ProviderPort,
  telemetry: ProviderTelemetry[],
): Promise<readonly BuiltInReviewResult[]> {
  const nonEmpty = turn.files.filter((f) => f.patch.trim() !== "");
  if (nonEmpty.length === 0) {
    return BUILT_IN_DEFINITIONS.map((def) => ({
      kind: "BUILT_IN",
      id: def.id,
      severity: def.severity,
      outcome: "SKIPPED",
      violationProbability: null,
      confidence: null,
      scopedPaths: [],
      evidenceHunk: null,
      rationale: null,
      reason: "NO_ATTRIBUTED_PATCH",
    }));
  }

  const scopedPaths = nonEmpty.map((f) => f.path);
  if (nonEmpty.some((f) => !checkFilePath(f.path, DEFAULT_EVIDENCE_POLICY).allowed)) {
    return BUILT_IN_DEFINITIONS.map((def) => ({
      kind: "BUILT_IN",
      id: def.id,
      severity: def.severity,
      outcome: "UNAVAILABLE",
      violationProbability: null,
      confidence: null,
      scopedPaths,
      evidenceHunk: null,
      rationale: null,
      reason: "BLOCKED_EVIDENCE",
    }));
  }

  const fullDiff = nonEmpty.map((f) => f.patch).join("\n");
  if (fullDiff.length > config.slicing.maxDiffLength) {
    return BUILT_IN_DEFINITIONS.map((def) => ({
      kind: "BUILT_IN",
      id: def.id,
      severity: def.severity,
      outcome: "UNAVAILABLE",
      violationProbability: null,
      confidence: null,
      scopedPaths,
      evidenceHunk: null,
      rationale: null,
      reason: "OVERSIZED_DIFF",
    }));
  }

  const request: BuiltInBatchRequest = {
    task: turn.task,
    files: scopedPaths,
    diff: fullDiff,
    nonce,
    endpoint: config.providers.judge,
    checks: BUILT_IN_DEFINITIONS.map((def) => def.item),
  };

  const batch = await provider.judgeBuiltInBatch(request);
  if (batch.telemetry) {
    telemetry.push(batch.telemetry);
  }

  if (batch.status === "FAILED") {
    return BUILT_IN_DEFINITIONS.map((def) => ({
      kind: "BUILT_IN",
      id: def.id,
      severity: def.severity,
      outcome: "UNAVAILABLE",
      violationProbability: null,
      confidence: null,
      scopedPaths,
      evidenceHunk: null,
      rationale: null,
      reason: batch.reason,
    }));
  }

  return BUILT_IN_DEFINITIONS.map((def) => {
    const answer = batch.answers[def.id];
    if (answer.status === "FAILED") {
      return {
        kind: "BUILT_IN",
        id: def.id,
        severity: def.severity,
        outcome: "UNAVAILABLE",
        violationProbability: null,
        confidence: null,
        scopedPaths,
        evidenceHunk: null,
        rationale: null,
        reason: answer.reason,
      };
    }

    const grounding = verifyEvidenceGrounding(
      answer.judgment,
      scopedPaths,
      fullDiff,
      def.warnThreshold,
    );
    const fixedThresholds = {
      error: {
        warn: def.warnThreshold,
        fail: def.failThreshold ?? 1,
      },
      warning: { warn: def.warnThreshold },
      confidenceMin: config.thresholds.confidenceMin,
    };

    const gate = evaluateSingleGate(
      def.severity,
      answer.judgment.violationProbability,
      answer.judgment.confidence,
      grounding.grounded,
      fixedThresholds,
    );

    return {
      kind: "BUILT_IN",
      id: def.id,
      severity: def.severity,
      outcome: gate.outcome,
      violationProbability: gate.violationProbability,
      confidence: answer.judgment.confidence,
      scopedPaths,
      evidenceHunk: answer.judgment.evidenceHunk,
      rationale: answer.judgment.rationale,
      reason: grounding.grounded ? null : "UNGROUNDED_EVIDENCE",
    };
  });
}

function countOutcomes(entries: readonly ReviewEntry[]): ReviewCounts {
  let pass = 0;
  let warn = 0;
  let fail = 0;
  let skipped = 0;
  let unavailable = 0;

  for (const entry of entries) {
    switch (entry.outcome) {
      case "PASS":
        pass += 1;
        break;
      case "WARN":
        warn += 1;
        break;
      case "FAIL":
        fail += 1;
        break;
      case "SKIPPED":
        skipped += 1;
        break;
      case "UNAVAILABLE":
        unavailable += 1;
        break;
    }
  }

  return { pass, warn, fail, skipped, unavailable };
}

function toMemoryEvents(
  review: ReviewResult,
  config: PolicyConfig,
  deps: ReviewTurnDependencies,
): readonly MemoryEventV1[] {
  const timestamp = deps.timestampFactory?.() ?? new Date().toISOString();
  const projectScope = deps.projectScope ?? "default";

  return review.entries.map((entry, idx) => ({
    schemaVersion: 1,
    eventId: `${review.turnId}:${idx}`,
    timestamp,
    projectScope,
    redacted: true,
    classification: "review",
    ttlDays: config.memory.ttlDays,
    turnId: review.turnId,
    ruleId: entry.id,
    outcome: entry.outcome,
    violationProbability: "violationProbability" in entry ? entry.violationProbability : null,
    confidence: "confidence" in entry ? entry.confidence : null,
    scopedPaths: "scopedPaths" in entry ? entry.scopedPaths : [],
    rationale: "rationale" in entry ? entry.rationale : entry.message,
    decisionOrigin: "rule-check",
  }));
}

function buildUnavailableOutput(
  turnId: string,
  entry: SyntheticUnavailableResult,
  deps: ReviewTurnDependencies,
  config?: PolicyConfig,
  redactedSecretsCount = 0,
): ReviewTurnOutput {
  const finalConfig = config ?? DEFAULT_POLICY_CONFIG;

  const review: ReviewResult = {
    turnId,
    aggregateOutcome: "UNAVAILABLE",
    counts: { pass: 0, warn: 0, fail: 0, skipped: 0, unavailable: 1 },
    entries: [entry],
    telemetry: [],
    redactedSecretsCount,
  };

  return {
    review,
    rules: [],
    config: finalConfig,
    memoryEvents: finalConfig.memory.emitEvents ? toMemoryEvents(review, finalConfig, deps) : [],
  };
}

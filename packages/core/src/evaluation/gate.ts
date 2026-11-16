import type {
  ErrorThresholds,
  Outcome,
  RuleSeverity,
  SliceAggregationMode,
  SliceEvaluationRecord,
  ThresholdConfig,
  WarningThresholds,
} from "../domain/types.ts";

export interface GateDecision {
  readonly outcome: Outcome;
  readonly violationProbability: number | null;
}

/**
 * Deterministic policy gate translating raw probability + epistemic confidence
 * + citation grounding into PASS / WARN / FAIL.
 */
export function evaluateSingleGate(
  severity: RuleSeverity,
  probability: number,
  confidence: number,
  grounded: boolean,
  thresholds: ThresholdConfig,
): GateDecision {
  if (
    !Number.isFinite(probability) ||
    probability < 0 ||
    probability > 1 ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    return { outcome: "UNAVAILABLE", violationProbability: null };
  }

  // Ungrounded citations or low-confidence claims never escalate straight to FAIL.
  const rawOutcome = mapSeverityOutcome(
    severity,
    probability,
    thresholds.error,
    thresholds.warning,
  );
  if (rawOutcome === "FAIL" && (!grounded || confidence < thresholds.confidenceMin)) {
    return { outcome: "WARN", violationProbability: probability };
  }

  return { outcome: rawOutcome, violationProbability: probability };
}

function mapSeverityOutcome(
  severity: RuleSeverity,
  probability: number,
  error: ErrorThresholds,
  warning: WarningThresholds,
): "PASS" | "WARN" | "FAIL" {
  if (severity === "warning") {
    return probability < warning.warn ? "PASS" : "WARN";
  }

  if (probability < error.warn) {
    return "PASS";
  }
  if (probability < error.fail) {
    return "WARN";
  }
  return "FAIL";
}

export interface AggregatedSliceVerdict {
  readonly outcome: Outcome;
  readonly probability: number | null;
  readonly confidence: number | null;
}

/**
 * Aggregates multiple slice judgments for one rule using `max`, `topKMean`, or `noisyOr`.
 * Any failed/unavailable slice fails closed (`UNAVAILABLE`).
 */
export function aggregateSliceJudgments(
  severity: RuleSeverity,
  slices: readonly SliceEvaluationRecord[],
  mode: SliceAggregationMode,
  topK: number,
  thresholds: ThresholdConfig,
): AggregatedSliceVerdict {
  if (slices.length === 0) {
    return { outcome: "SKIPPED", probability: null, confidence: null };
  }

  const probabilities: number[] = [];
  const confidences: number[] = [];
  let allGrounded = true;

  for (const slice of slices) {
    if (
      slice.outcome === "UNAVAILABLE" ||
      slice.probability === null ||
      slice.confidence === null
    ) {
      return { outcome: "UNAVAILABLE", probability: null, confidence: null };
    }
    probabilities.push(slice.probability);
    confidences.push(slice.confidence);
    if (!slice.grounded) {
      allGrounded = false;
    }
  }

  const aggregatedProb = computeAggregateProbability(probabilities, mode, topK);
  const minConfidence = Math.min(...confidences);
  const gate = evaluateSingleGate(severity, aggregatedProb, minConfidence, allGrounded, thresholds);

  return {
    outcome: gate.outcome,
    probability: gate.violationProbability,
    confidence: minConfidence,
  };
}

export function computeAggregateProbability(
  probabilities: readonly number[],
  mode: SliceAggregationMode,
  topK: number,
): number {
  if (probabilities.length === 0) {
    return 0;
  }

  if (mode === "max") {
    return Math.max(...probabilities);
  }

  if (mode === "topKMean") {
    const k = Math.min(Math.max(1, topK), probabilities.length);
    const sorted = [...probabilities].sort((a, b) => b - a);
    const slice = sorted.slice(0, k);
    return slice.reduce((acc, v) => acc + v, 0) / slice.length;
  }

  // noisyOr: 1 - product(1 - p_i)
  let passProb = 1;
  for (const p of probabilities) {
    passProb *= 1 - p;
  }
  return 1 - passProb;
}

export function combineAggregateOutcome(outcomes: readonly Outcome[]): Outcome {
  if (outcomes.includes("FAIL")) {
    return "FAIL";
  }
  if (outcomes.includes("UNAVAILABLE")) {
    return "UNAVAILABLE";
  }
  if (outcomes.includes("WARN")) {
    return "WARN";
  }
  if (outcomes.includes("PASS")) {
    return "PASS";
  }
  return "SKIPPED";
}

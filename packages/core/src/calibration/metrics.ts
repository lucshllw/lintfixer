import type { Outcome, RuleSeverity, SliceAggregationMode } from "../domain/types.ts";
import { computeAggregateProbability } from "../evaluation/gate.ts";

export type CalibrationLabel = "VIOLATION" | "NO_VIOLATION";

export interface CalibrationSample {
  readonly fixtureId: string;
  readonly ruleId: string;
  readonly authorLabel: CalibrationLabel;
  readonly probability: number | null;
  readonly confidence: number | null;
  readonly outcome: Outcome;
  readonly repeat?: number;
  readonly sliceProbabilities?: readonly number[];
  readonly scopedPath?: string;
  readonly rationale?: string;
}

export interface ConfusionMatrix {
  readonly truePositive: number;
  readonly falsePositive: number;
  readonly trueNegative: number;
  readonly falseNegative: number;
}

export interface DerivedMetrics {
  readonly precision: number | null;
  readonly recall: number | null;
  readonly specificity: number | null;
  readonly f1: number | null;
  readonly brierScore: number | null;
  readonly ece: number | null;
}

export interface EceBin {
  readonly lower: number;
  readonly upper: number;
  readonly count: number;
  readonly avgConfidence: number | null;
  readonly empiricalRate: number | null;
}

export interface RepeatStabilitySummary {
  readonly fixtureId: string;
  readonly ruleId: string;
  readonly evaluatedCount: number;
  readonly mean: number | null;
  readonly standardDeviation: number | null;
  readonly thresholdCrossings: number;
  readonly flipRate: number | null;
}

export interface AggregationComparisonRow {
  readonly mode: SliceAggregationMode;
  readonly matrix: ConfusionMatrix;
  readonly metrics: DerivedMetrics;
}

export interface AllowedRefinementSuggestion {
  readonly ruleId: string;
  readonly falsePositiveCount: number;
  readonly affectedPaths: readonly string[];
  readonly candidateAllowedText: string;
  readonly sampleRationales: readonly string[];
}

export function computeConfusionMatrix(
  samples: readonly CalibrationSample[],
  threshold: number,
): ConfusionMatrix {
  let truePositive = 0;
  let falsePositive = 0;
  let trueNegative = 0;
  let falseNegative = 0;

  for (const sample of samples) {
    if (sample.probability === null) {
      continue;
    }
    const actual = sample.authorLabel === "VIOLATION";
    const predicted = sample.probability >= threshold;

    if (actual && predicted) {
      truePositive += 1;
    } else if (actual && !predicted) {
      falseNegative += 1;
    } else if (!actual && predicted) {
      falsePositive += 1;
    } else {
      trueNegative += 1;
    }
  }

  return { truePositive, falsePositive, trueNegative, falseNegative };
}

export function computeBrierScore(samples: readonly CalibrationSample[]): number | null {
  let sum = 0;
  let count = 0;

  for (const sample of samples) {
    if (sample.probability === null) {
      continue;
    }
    const target = sample.authorLabel === "VIOLATION" ? 1 : 0;
    sum += (sample.probability - target) ** 2;
    count += 1;
  }

  return count === 0 ? null : sum / count;
}

export function computeEce(
  samples: readonly CalibrationSample[],
  binCount = 10,
): { readonly ece: number | null; readonly bins: readonly EceBin[] } {
  const evaluated = samples.filter((s) => s.probability !== null);
  const buckets = Array.from({ length: binCount }, (_, idx) => ({
    lower: idx / binCount,
    upper: (idx + 1) / binCount,
    items: [] as { p: number; y: number }[],
  }));

  for (const sample of evaluated) {
    const p = sample.probability;
    if (p === null) {
      continue;
    }
    const idx =
      p >= 1 ? binCount - 1 : Math.max(0, Math.min(binCount - 1, Math.floor(p * binCount)));
    buckets[idx]?.items.push({
      p,
      y: sample.authorLabel === "VIOLATION" ? 1 : 0,
    });
  }

  let eceSum = 0;
  const bins: EceBin[] = buckets.map((bucket) => {
    if (bucket.items.length === 0) {
      return {
        lower: bucket.lower,
        upper: bucket.upper,
        count: 0,
        avgConfidence: null,
        empiricalRate: null,
      };
    }

    const avgP = bucket.items.reduce((acc, item) => acc + item.p, 0) / bucket.items.length;
    const empY = bucket.items.reduce((acc, item) => acc + item.y, 0) / bucket.items.length;
    eceSum += (bucket.items.length / evaluated.length) * Math.abs(avgP - empY);

    return {
      lower: bucket.lower,
      upper: bucket.upper,
      count: bucket.items.length,
      avgConfidence: avgP,
      empiricalRate: empY,
    };
  });

  return { ece: evaluated.length === 0 ? null : eceSum, bins };
}

export function computeDerivedMetrics(
  samples: readonly CalibrationSample[],
  threshold: number,
): DerivedMetrics {
  const matrix = computeConfusionMatrix(samples, threshold);
  const { truePositive, falsePositive, trueNegative, falseNegative } = matrix;

  const precision = ratio(truePositive, truePositive + falsePositive);
  const recall = ratio(truePositive, truePositive + falseNegative);
  const specificity = ratio(trueNegative, trueNegative + falsePositive);
  const f1 =
    precision === null || recall === null || precision + recall === 0
      ? null
      : (2 * precision * recall) / (precision + recall);

  return {
    precision,
    recall,
    specificity,
    f1,
    brierScore: computeBrierScore(samples),
    ece: computeEce(samples).ece,
  };
}

export function buildThresholdSweep(samples: readonly CalibrationSample[]): readonly {
  readonly threshold: number;
  readonly matrix: ConfusionMatrix;
  readonly metrics: DerivedMetrics;
}[] {
  const rows: {
    readonly threshold: number;
    readonly matrix: ConfusionMatrix;
    readonly metrics: DerivedMetrics;
  }[] = [];
  for (let step = 0; step <= 20; step += 1) {
    const threshold = step / 20;
    rows.push({
      threshold,
      matrix: computeConfusionMatrix(samples, threshold),
      metrics: computeDerivedMetrics(samples, threshold),
    });
  }
  return rows;
}

export function computeRepeatStability(
  samples: readonly CalibrationSample[],
  threshold: number,
): readonly RepeatStabilitySummary[] {
  const groups = new Map<string, CalibrationSample[]>();
  for (const sample of samples) {
    const key = `${sample.ruleId}::${sample.fixtureId}`;
    const list = groups.get(key) ?? [];
    list.push(sample);
    groups.set(key, list);
  }

  const summaries: RepeatStabilitySummary[] = [];
  for (const group of groups.values()) {
    const ordered = group.slice().sort((a, b) => (a.repeat ?? 0) - (b.repeat ?? 0));
    const probs = ordered.map((s) => s.probability).filter((p): p is number => p !== null);

    let crossings = 0;
    let pairs = 0;
    for (let i = 1; i < probs.length; i += 1) {
      const prev = probs[i - 1];
      const curr = probs[i];
      if (prev !== undefined && curr !== undefined) {
        pairs += 1;
        if (prev >= threshold !== curr >= threshold) {
          crossings += 1;
        }
      }
    }

    const avg = probs.length === 0 ? null : probs.reduce((a, b) => a + b, 0) / probs.length;
    const stdDev =
      avg === null ? null : Math.sqrt(probs.reduce((a, p) => a + (p - avg) ** 2, 0) / probs.length);

    const first = ordered[0];
    if (first === undefined) {
      continue;
    }

    summaries.push({
      fixtureId: first.fixtureId,
      ruleId: first.ruleId,
      evaluatedCount: probs.length,
      mean: avg,
      standardDeviation: stdDev,
      thresholdCrossings: crossings,
      flipRate: pairs === 0 ? null : crossings / pairs,
    });
  }

  return summaries;
}

/**
 * Compares `max` vs `topKMean` vs `noisyOr` on multi-slice fixtures offline.
 */
export function compareSliceAggregations(
  samples: readonly CalibrationSample[],
  threshold: number,
  topK = 2,
): readonly AggregationComparisonRow[] {
  const modes: readonly SliceAggregationMode[] = ["max", "topKMean", "noisyOr"];
  return modes.map((mode) => {
    const projected: CalibrationSample[] = samples.map((sample) => {
      const probs = sample.sliceProbabilities;
      if (probs === undefined || probs.length === 0) {
        return sample;
      }
      return {
        ...sample,
        probability: computeAggregateProbability(probs, mode, topK),
      };
    });

    return {
      mode,
      matrix: computeConfusionMatrix(projected, threshold),
      metrics: computeDerivedMetrics(projected, threshold),
    };
  });
}

/**
 * Clusters recurring false positives per rule and suggests candidate `### Allowed`
 * additions for human review without weakening rules automatically.
 */
export function suggestAllowedRefinements(
  samples: readonly CalibrationSample[],
  threshold: number,
  _severity: RuleSeverity = "error",
): readonly AllowedRefinementSuggestion[] {
  const fpsByRule = new Map<string, CalibrationSample[]>();
  for (const sample of samples) {
    if (
      sample.authorLabel === "NO_VIOLATION" &&
      sample.probability !== null &&
      sample.probability >= threshold
    ) {
      const list = fpsByRule.get(sample.ruleId) ?? [];
      list.push(sample);
      fpsByRule.set(sample.ruleId, list);
    }
  }

  const suggestions: AllowedRefinementSuggestion[] = [];
  for (const [ruleId, fps] of fpsByRule) {
    const affectedPaths = Array.from(
      new Set(fps.map((f) => f.scopedPath).filter((p): p is string => Boolean(p))),
    );
    const sampleRationales = Array.from(
      new Set(fps.map((f) => f.rationale).filter((r): r is string => Boolean(r))),
    ).slice(0, 5);

    const pathHint =
      affectedPaths.length > 0 ? ` in paths matching [${affectedPaths.join(", ")}]` : "";
    const reasonHint =
      sampleRationales.length > 0
        ? ` Patterns flagged falsely: ${sampleRationales.join("; ")}.`
        : "";

    suggestions.push({
      ruleId,
      falsePositiveCount: fps.length,
      affectedPaths,
      sampleRationales,
      candidateAllowedText: `Explicitly allow valid cases${pathHint} observed as false alarms.${reasonHint}`,
    });
  }

  return suggestions;
}

function ratio(num: number, den: number): number | null {
  return den === 0 ? null : num / den;
}

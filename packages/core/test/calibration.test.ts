import { describe, expect, it } from "vitest";
import {
  type CalibrationSample,
  compareSliceAggregations,
  computeBrierScore,
  computeDerivedMetrics,
  computeEce,
  computeRepeatStability,
  suggestAllowedRefinements,
} from "@ikigai/core";

describe("calibration metrics, ECE, flipRate, aggregation comparison & FP refinements", () => {
  const samples: CalibrationSample[] = [
    {
      fixtureId: "f1",
      ruleId: "ARCH-001",
      authorLabel: "VIOLATION",
      probability: 0.9,
      confidence: 0.95,
      outcome: "FAIL",
      repeat: 1,
      sliceProbabilities: [0.1, 0.92],
    },
    {
      fixtureId: "f1",
      ruleId: "ARCH-001",
      authorLabel: "VIOLATION",
      probability: 0.85,
      confidence: 0.9,
      outcome: "FAIL",
      repeat: 2,
      sliceProbabilities: [0.2, 0.85],
    },
    {
      fixtureId: "f2",
      ruleId: "ARCH-001",
      authorLabel: "NO_VIOLATION",
      probability: 0.78,
      confidence: 0.85,
      outcome: "FAIL",
      repeat: 1,
      sliceProbabilities: [0.78, 0.1, 0.05],
      scopedPath: "src/controllers/health.ts",
      rationale: "Read-only health probe flagged as business logic.",
    },
    {
      fixtureId: "f2",
      ruleId: "ARCH-001",
      authorLabel: "NO_VIOLATION",
      probability: 0.3,
      confidence: 0.8,
      outcome: "PASS",
      repeat: 2,
      sliceProbabilities: [0.3, 0.1, 0.05],
    },
  ];

  it("computes precision, recall, F1, Brier score, ECE, and repeat flipRate", () => {
    const metrics = computeDerivedMetrics(samples, 0.7);
    expect(metrics.precision).toBeCloseTo(2 / 3);
    expect(metrics.recall).toBeCloseTo(1);
    expect(computeBrierScore(samples)).not.toBeNull();
    expect(computeEce(samples).ece).toBeGreaterThanOrEqual(0);

    const stability = computeRepeatStability(samples, 0.7);
    const f2 = stability.find((s) => s.fixtureId === "f2");
    expect(f2?.thresholdCrossings).toBe(1);
    expect(f2?.flipRate).toBeCloseTo(1);
  });

  it("compares max vs topKMean vs noisyOr on multi-slice fixtures", () => {
    const rows = compareSliceAggregations(samples, 0.7, 2);
    expect(rows.map((r) => r.mode)).toEqual(["max", "topKMean", "noisyOr"]);
    const maxRow = rows.find((r) => r.mode === "max");
    const topKRow = rows.find((r) => r.mode === "topKMean");
    expect(maxRow?.matrix.falsePositive).toBe(1);
    expect(topKRow?.matrix.falsePositive).toBe(0);
  });

  it("clusters false positives to propose Allowed refinements", () => {
    const suggestions = suggestAllowedRefinements(samples, 0.7);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.ruleId).toBe("ARCH-001");
    expect(suggestions[0]?.affectedPaths).toContain("src/controllers/health.ts");
    expect(suggestions[0]?.candidateAllowedText).toContain("health probe");
  });
});

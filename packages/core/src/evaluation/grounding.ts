import type { EvidenceHunk, SemanticJudgment } from "../domain/types.ts";
import { normalizePath } from "../evidence/paths.ts";

export interface GroundingVerification {
  readonly grounded: boolean;
  readonly reason:
    | "MATCHED"
    | "NOT_REQUIRED"
    | "MISSING_EVIDENCE"
    | "FILE_NOT_IN_SLICE"
    | "QUOTE_MISMATCH";
}

/**
 * Verifies that any claimed violation citation (`evidenceHunk.quote`) literally
 * appears inside the inspected slice diff. Prevents hallucinated citations from
 * driving a FAIL outcome.
 */
export function verifyEvidenceGrounding(
  judgment: SemanticJudgment,
  sliceFiles: readonly string[],
  sliceDiff: string,
  warnThreshold: number,
): GroundingVerification {
  if (judgment.violationProbability < warnThreshold) {
    return { grounded: true, reason: "NOT_REQUIRED" };
  }

  const evidence = judgment.evidenceHunk;
  if (evidence === null) {
    return { grounded: false, reason: "MISSING_EVIDENCE" };
  }

  const normalizedFiles = sliceFiles.map(normalizePath);
  const claimedFile = normalizePath(evidence.file);
  if (!normalizedFiles.includes(claimedFile)) {
    return { grounded: false, reason: "FILE_NOT_IN_SLICE" };
  }

  if (quoteMatchesDiff(evidence, sliceDiff)) {
    return { grounded: true, reason: "MATCHED" };
  }

  return { grounded: false, reason: "QUOTE_MISMATCH" };
}

function quoteMatchesDiff(evidence: EvidenceHunk, sliceDiff: string): boolean {
  const quoteTrimmed = evidence.quote.trim();
  if (quoteTrimmed === "") {
    return false;
  }

  if (sliceDiff.includes(quoteTrimmed)) {
    return true;
  }

  const normalizedDiff = normalizeDiffLines(sliceDiff);
  const normalizedQuote = quoteTrimmed
    .split(/\r?\n/)
    .map((line) => line.replace(/^[+-]\s?/, "").trim())
    .filter(Boolean)
    .join("\n");

  return normalizedQuote !== "" && normalizedDiff.includes(normalizedQuote);
}

function normalizeDiffLines(diff: string): string {
  return diff
    .split(/\r?\n/)
    .map((line) => {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        return line.slice(1).trim();
      }
      if (line.startsWith("-") && !line.startsWith("---")) {
        return line.slice(1).trim();
      }
      return line.trim();
    })
    .join("\n");
}

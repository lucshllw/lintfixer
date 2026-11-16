import type { EvidenceSlice, ParsedRule, SlicingConfig, Turn, TurnFile } from "../domain/types.ts";
import { DEFAULT_EVIDENCE_POLICY } from "./defaults.ts";
import { HUNK_MARKER_RE } from "./parse-unified-diff.ts";
import { checkFilePath, selectApplicableFiles } from "./safety.ts";
import type { EvidencePolicy, RuleEvidencePlan } from "./types.ts";

export function assembleDiff(files: readonly TurnFile[]): string {
  return files.map((file) => file.patch).join("\n");
}

/**
 * Deterministically slices scoped evidence without truncating or dropping code.
 */
export function planRuleEvidence(
  turn: Turn,
  rule: ParsedRule,
  slicing: SlicingConfig,
  policy: EvidencePolicy = DEFAULT_EVIDENCE_POLICY,
): RuleEvidencePlan {
  if (turn.files.every((f) => f.patch.trim() === "")) {
    return { status: "SKIPPED", reason: "NO_ATTRIBUTED_PATCH" };
  }

  const applicable = selectApplicableFiles(turn.files, rule, policy);
  if (applicable.length === 0) {
    return { status: "SKIPPED", reason: "NO_SCOPE_MATCH" };
  }

  const diff = assembleDiff(applicable);
  if (diff.trim() === "") {
    return { status: "SKIPPED", reason: "NO_ATTRIBUTED_PATCH" };
  }

  if (applicable.some((file) => !checkFilePath(file.path, policy).allowed)) {
    return { status: "UNAVAILABLE", reason: "BLOCKED_EVIDENCE" };
  }

  if (diff.length <= slicing.maxDiffLength) {
    return {
      status: "PLANNED",
      slices: [
        {
          index: 0,
          kind: "WHOLE",
          path: applicable.length === 1 ? (applicable[0]?.path ?? null) : null,
          hunkOrdinal: null,
          files: applicable.map((f) => f.path),
          diff,
        },
      ],
    };
  }

  const slices: EvidenceSlice[] = [];
  for (const file of applicable) {
    if (file.patch.length <= slicing.maxDiffLength) {
      slices.push({
        index: slices.length,
        kind: "FILE",
        path: file.path,
        hunkOrdinal: null,
        files: [file.path],
        diff: file.patch,
      });
      continue;
    }

    const hunkSlices = sliceFileByHunks(slices.length, file, slicing.maxDiffLength);
    if (hunkSlices === null) {
      return { status: "UNAVAILABLE", reason: "OVERSIZED_DIFF" };
    }
    slices.push(...hunkSlices);
  }

  if (slices.length > slicing.maxSlicesPerRule) {
    return { status: "UNAVAILABLE", reason: "SLICE_LIMIT_EXCEEDED" };
  }

  return { status: "PLANNED", slices };
}

function sliceFileByHunks(
  startIndex: number,
  file: TurnFile,
  maxDiffLength: number,
): readonly EvidenceSlice[] | null {
  const starts = Array.from(file.patch.matchAll(HUNK_MARKER_RE), (m) => m.index ?? 0);
  const firstStart = starts[0];
  if (starts.length === 0 || firstStart === undefined) {
    return null;
  }

  const preamble = file.patch.slice(0, firstStart);
  const slices: EvidenceSlice[] = [];

  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i];
    if (start === undefined) {
      return null;
    }
    const end = starts[i + 1] ?? file.patch.length;
    const rendered = preamble + file.patch.slice(start, end);
    if (rendered.length > maxDiffLength) {
      return null;
    }

    slices.push({
      index: startIndex + i,
      kind: "HUNK",
      path: file.path,
      hunkOrdinal: i,
      files: [file.path],
      diff: rendered,
    });
  }

  return slices;
}

import type { EvidenceSlice, TurnFile } from "../domain/types.ts";

export interface EvidencePolicy {
  readonly maxDiffLength: number;
  readonly codeExtensions: readonly string[];
  readonly docsExtensions: readonly string[];
  readonly deniedFileNames: readonly string[];
  readonly deniedExtensions: readonly string[];
  readonly deniedDirectoryNames: readonly string[];
}

export type PathSafety =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: "DENIED_SENSITIVE_PATH" | "EXTENSION_NOT_ALLOWED" | "UNSAFE_PATH";
    };

export type ProtectedFixTargetClass = "NONE" | "TEST" | "DEPENDENCY" | "WORKFLOW" | "CONFIG";

export type DiffParseFailureReason =
  | "COMBINED_DIFF"
  | "BINARY_PATCH"
  | "QUOTED_PATH"
  | "UNSUPPORTED_PREFIX"
  | "RENAMED_PATH"
  | "MISSING_PATH"
  | "UNSAFE_PATH"
  | "TRUNCATED_HUNK"
  | "UNRECOGNIZED_DIFF";

export type DiffParseResult =
  | { readonly status: "PARSED"; readonly files: readonly TurnFile[] }
  | { readonly status: "INVALID"; readonly reason: DiffParseFailureReason };

export type RuleEvidencePlan =
  | { readonly status: "PLANNED"; readonly slices: readonly EvidenceSlice[] }
  | { readonly status: "SKIPPED"; readonly reason: "NO_ATTRIBUTED_PATCH" | "NO_SCOPE_MATCH" }
  | {
      readonly status: "UNAVAILABLE";
      readonly reason: "BLOCKED_EVIDENCE" | "OVERSIZED_DIFF" | "SLICE_LIMIT_EXCEEDED";
    };

export interface RedactionResult {
  readonly text: string;
  readonly redactionCount: number;
  readonly hasCriticalUnredacted: boolean;
}

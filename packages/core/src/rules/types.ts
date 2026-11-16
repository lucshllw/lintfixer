import type { EvidenceClass, ParsedRule, PolicyConfig, RuleSeverity } from "../domain/types.ts";

export type RuleParseErrorCode =
  | "MISSING_ID"
  | "INVALID_ID"
  | "DUPLICATE_ID"
  | "INVALID_METADATA"
  | "MISSING_SEVERITY"
  | "INVALID_SEVERITY"
  | "INVALID_SCOPE"
  | "INVALID_EVIDENCE"
  | "INVALID_FIXABLE"
  | "UNKNOWN_SECTION"
  | "DUPLICATE_SECTION"
  | "MISSING_RULE"
  | "MISSING_VIOLATION"
  | "EMPTY_SECTION"
  | "INVALID_ALLOWED";

export type RuleCandidateResult =
  | { readonly status: "PARSED"; readonly rule: ParsedRule }
  | {
      readonly status: "INVALID";
      readonly id: string | null;
      readonly code: RuleParseErrorCode;
      readonly reason: string;
    };

export interface ConfigParseSuccess {
  readonly status: "PARSED";
  readonly config: PolicyConfig;
}

export interface ConfigParseFailure {
  readonly status: "INVALID";
  readonly code: "INVALID_YAML" | "INVALID_CONFIG";
  readonly message: string;
}

export type ConfigParseResult = ConfigParseSuccess | ConfigParseFailure;

export interface RawRuleBlock {
  readonly id: string;
  readonly lines: readonly string[];
}

export interface ParsedRuleMetadata {
  readonly severity: RuleSeverity;
  readonly scopeInclude: readonly string[];
  readonly scopeExclude: readonly string[];
  readonly hasScope: boolean;
  readonly evidence: EvidenceClass;
  readonly fixable: boolean;
}

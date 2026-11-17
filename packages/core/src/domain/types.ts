export type RuleSeverity = "error" | "warning";

export type EvidenceClass = "code" | "docs" | "any";

export type Outcome = "PASS" | "WARN" | "FAIL" | "SKIPPED" | "UNAVAILABLE";

export type SliceAggregationMode = "max" | "topKMean" | "noisyOr";

export type ProviderKind = "openai" | "gemini" | "claude" | "cli" | "jev";

export type ProviderMode = "api" | "cli";

export type ForkPolicy = "comment-only" | "ignore";

export type BuiltInCheckId = "SCOPE-CREEP" | "COMPLEXITY" | "TEST-ADEQUACY";

export type SkippedReason = "NO_ATTRIBUTED_PATCH" | "NO_SCOPE_MATCH";

export type UnavailableReason =
  | "INVALID_RULE"
  | "INVALID_CONFIG"
  | "MISSING_POLICY"
  | "BLOCKED_EVIDENCE"
  | "UNREDACTED_SECRET"
  | "OVERSIZED_DIFF"
  | "SLICE_LIMIT_EXCEEDED"
  | "UNGROUNDED_EVIDENCE"
  | "PROVIDER_FAILURE"
  | "INVALID_DIFF";

export interface RuleScope {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

export interface ParsedRule {
  readonly id: string;
  readonly severity: RuleSeverity;
  readonly scope: RuleScope | null;
  readonly evidence: EvidenceClass;
  readonly fixable: boolean;
  readonly description: string;
  readonly violation: string;
  readonly allowed: string | null;
  readonly fixHint: string | null;
}

export interface ErrorThresholds {
  readonly warn: number;
  readonly fail: number;
}

export interface WarningThresholds {
  readonly warn: number;
}

export interface ThresholdConfig {
  readonly error: ErrorThresholds;
  readonly warning: WarningThresholds;
  readonly confidenceMin: number;
}

export interface SlicingConfig {
  readonly maxDiffLength: number;
  readonly maxSlicesPerRule: number;
  readonly maxExtraSlicesPerTurn: number;
  readonly aggregation: SliceAggregationMode;
  readonly topK: number;
}

export interface ProviderEndpointConfig {
  readonly provider: ProviderKind;
  readonly model: string;
  readonly mode: ProviderMode;
  readonly cliCommand?: string;
}

export interface ProvidersConfig {
  readonly judge: ProviderEndpointConfig;
  readonly tieBreaker?: ProviderEndpointConfig;
  readonly fixer: ProviderEndpointConfig;
}

export interface FixConfig {
  readonly enabled: boolean;
  readonly maxRecheckCycles: number;
  readonly allowTests: boolean;
  readonly allowDependencies: boolean;
  readonly allowWorkflows: boolean;
  readonly allowConfigs: boolean;
}

export interface CommitLintConfig {
  readonly conventionalFormat: boolean;
  readonly semanticMatch: boolean;
}

export interface GithubBotConfig {
  readonly approveOnPass: boolean;
  readonly requestChangesOnFail: boolean;
  readonly forkPolicy: ForkPolicy;
}

export interface MemoryConfig {
  readonly emitEvents: boolean;
  readonly ttlDays: number;
}

export interface PolicyConfig {
  readonly version: 1;
  readonly thresholds: ThresholdConfig;
  readonly slicing: SlicingConfig;
  readonly providers: ProvidersConfig;
  readonly fix: FixConfig;
  readonly commitLint: CommitLintConfig;
  readonly github: GithubBotConfig;
  readonly memory: MemoryConfig;
}

export interface TurnFile {
  readonly path: string;
  readonly patch: string;
}

export interface Turn {
  readonly id: string;
  readonly task: string;
  readonly files: readonly TurnFile[];
  readonly source:
    | "cli"
    | "git-staged"
    | "commit"
    | "github-pr"
    | "claude-code"
    | "opencode"
    | "codex";
}

export type SliceKind = "WHOLE" | "FILE" | "HUNK";

export interface EvidenceSlice {
  readonly index: number;
  readonly kind: SliceKind;
  readonly path: string | null;
  readonly hunkOrdinal: number | null;
  readonly files: readonly string[];
  readonly diff: string;
}

export interface EvidenceHunk {
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly quote: string;
}

export interface SemanticJudgment {
  readonly violationProbability: number;
  readonly confidence: number;
  readonly evidenceHunk: EvidenceHunk | null;
  readonly rationale: string;
}

export interface ProviderTelemetry {
  readonly provider: ProviderKind;
  readonly modelId: string;
  readonly latencyMs: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface SliceEvaluationRecord {
  readonly sliceIndex: number;
  readonly path: string | null;
  readonly hunkOrdinal: number | null;
  readonly outcome: Outcome;
  readonly probability: number | null;
  readonly confidence: number | null;
  readonly grounded: boolean;
  readonly evidenceHunk: EvidenceHunk | null;
  readonly rationale: string | null;
  readonly reason: UnavailableReason | null;
}

export interface RuleReviewResult {
  readonly kind: "RULE";
  readonly id: string;
  readonly severity: RuleSeverity;
  readonly fixable: boolean;
  readonly outcome: Outcome;
  readonly violationProbability: number | null;
  readonly confidence: number | null;
  readonly scopedPaths: readonly string[];
  readonly sliceCount: number;
  readonly slices: readonly SliceEvaluationRecord[];
  readonly evidenceHunk: EvidenceHunk | null;
  readonly rationale: string | null;
  readonly reason: SkippedReason | UnavailableReason | null;
}

export interface BuiltInReviewResult {
  readonly kind: "BUILT_IN";
  readonly id: BuiltInCheckId;
  readonly severity: RuleSeverity;
  readonly outcome: Outcome;
  readonly violationProbability: number | null;
  readonly confidence: number | null;
  readonly scopedPaths: readonly string[];
  readonly evidenceHunk: EvidenceHunk | null;
  readonly rationale: string | null;
  readonly reason: SkippedReason | UnavailableReason | null;
}

export interface SyntheticUnavailableResult {
  readonly kind: "REVIEW";
  readonly id: null;
  readonly outcome: "UNAVAILABLE";
  readonly reason: UnavailableReason;
  readonly message: string;
}

export type ReviewEntry = RuleReviewResult | BuiltInReviewResult | SyntheticUnavailableResult;

export interface ReviewCounts {
  readonly pass: number;
  readonly warn: number;
  readonly fail: number;
  readonly skipped: number;
  readonly unavailable: number;
}

export interface ReviewResult {
  readonly turnId: string;
  readonly aggregateOutcome: Outcome;
  readonly counts: ReviewCounts;
  readonly entries: readonly ReviewEntry[];
  readonly telemetry: readonly ProviderTelemetry[];
  readonly redactedSecretsCount: number;
}

export interface MemoryEventV1 {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly timestamp: string;
  readonly projectScope: string;
  readonly redacted: true;
  readonly classification: "review" | "fix" | "feedback" | "pr-verdict" | "commit-lint";
  readonly ttlDays: number;
  readonly turnId: string;
  readonly ruleId: string | null;
  readonly outcome: Outcome;
  readonly violationProbability: number | null;
  readonly confidence: number | null;
  readonly scopedPaths: readonly string[];
  readonly rationale: string | null;
  readonly decisionOrigin: "rule-check" | "auto-fix" | "human-feedback" | "github-pr" | "commit";
}

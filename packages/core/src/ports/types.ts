import type {
  BuiltInCheckId,
  MemoryEventV1,
  Outcome,
  ParsedRule,
  PolicyConfig,
  ProviderEndpointConfig,
  ProviderTelemetry,
  SemanticJudgment,
  UnavailableReason,
} from "../domain/types.ts";

export interface JudgeRequest {
  readonly kind: "RULE" | "BUILT_IN";
  readonly checkId: string;
  readonly ruleSummary: string;
  readonly violationCriteria: string;
  readonly allowedCriteria: string | null;
  readonly task: string;
  readonly files: readonly string[];
  readonly diff: string;
  readonly nonce: string;
  readonly endpoint: ProviderEndpointConfig;
}

export interface BuiltInBatchItem {
  readonly checkId: BuiltInCheckId;
  readonly ruleSummary: string;
  readonly violationCriteria: string;
  readonly allowedCriteria: string;
}

export interface BuiltInBatchRequest {
  readonly task: string;
  readonly files: readonly string[];
  readonly diff: string;
  readonly nonce: string;
  readonly endpoint: ProviderEndpointConfig;
  readonly checks: readonly BuiltInBatchItem[];
}

export type JudgeCallResult =
  | {
      readonly status: "OK";
      readonly judgment: SemanticJudgment;
      readonly telemetry: ProviderTelemetry;
    }
  | {
      readonly status: "FAILED";
      readonly reason: UnavailableReason;
      readonly errorCode: string;
      readonly telemetry?: ProviderTelemetry;
    };

export type BuiltInBatchResult =
  | {
      readonly status: "OK";
      readonly answers: Readonly<Record<BuiltInCheckId, JudgeCallResult>>;
      readonly telemetry: ProviderTelemetry;
    }
  | {
      readonly status: "FAILED";
      readonly reason: UnavailableReason;
      readonly errorCode: string;
      readonly telemetry?: ProviderTelemetry;
    };

export interface FixPromptRequest {
  readonly task: string;
  readonly diff: string;
  readonly nonce: string;
  readonly endpoint: ProviderEndpointConfig;
  readonly findings: readonly {
    readonly ruleId: string;
    readonly ruleSummary: string;
    readonly violationCriteria: string;
    readonly allowedCriteria: string | null;
    readonly fixHint: string | null;
    readonly rationale: string | null;
    readonly files: readonly string[];
  }[];
}

export type FixGenerationResult =
  | {
      readonly status: "OK";
      readonly patchText: string;
      readonly summary: string;
      readonly telemetry: ProviderTelemetry;
    }
  | {
      readonly status: "FAILED";
      readonly errorCode: string;
      readonly message: string;
      readonly telemetry?: ProviderTelemetry;
    };

export interface ProviderPort {
  judgeRuleSlice(request: JudgeRequest): Promise<JudgeCallResult>;
  judgeBuiltInBatch(request: BuiltInBatchRequest): Promise<BuiltInBatchResult>;
  generateFixPatch?(request: FixPromptRequest): Promise<FixGenerationResult>;
}

export interface PolicySourcePort {
  readRules(): Promise<string | null>;
  readConfig(): Promise<string | null>;
}

export interface MemoryPort {
  emit(events: readonly MemoryEventV1[]): Promise<void>;
}

export interface ReviewHistoryEntry {
  readonly timestamp: string;
  readonly turnId: string;
  readonly aggregateOutcome: Outcome;
  readonly counts: {
    readonly pass: number;
    readonly warn: number;
    readonly fail: number;
    readonly skipped: number;
    readonly unavailable: number;
  };
  readonly results: readonly {
    readonly id: string | null;
    readonly kind: "RULE" | "BUILT_IN" | "REVIEW";
    readonly outcome: Outcome;
    readonly violationProbability: number | null;
    readonly confidence: number | null;
    readonly reason: string | null;
    readonly scopedPaths: readonly string[];
  }[];
}

export interface HistoryPort {
  appendReview(entry: ReviewHistoryEntry): Promise<void>;
  readReviews(): Promise<readonly ReviewHistoryEntry[]>;
}

export interface VerificationCommandResult {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly summary: string;
}

export interface CommandRunnerPort {
  runVerification(command: string, cwd: string): Promise<VerificationCommandResult>;
}

export interface PatchApplierPort {
  readTargetFiles(paths: readonly string[]): Promise<ReadonlyMap<string, string>>;
  applyValidatedPatch(
    updatedFiles: ReadonlyMap<string, string>,
  ): Promise<{ readonly rollback: () => Promise<void> }>;
}

export interface PolicyLoadResult {
  readonly rulesText: string | null;
  readonly configText: string | null;
}

export interface ValidatedPolicy {
  readonly rules: readonly ParsedRule[];
  readonly config: PolicyConfig;
}

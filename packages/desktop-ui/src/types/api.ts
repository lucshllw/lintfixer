export type TabId = "github" | "diff" | "calibration" | "vault";

export type TelemetrySegmentState = "pass" | "warn" | "fail" | "empty";

export interface VaultEntryMeta {
  readonly namespace:
    | "github.oauth"
    | "github.pat"
    | "llm.jev"
    | "llm.gemini"
    | "llm.openai"
    | "llm.claude";
  readonly providerLabel: string;
  readonly endpoint: string;
  readonly status: "sealed" | "missing";
  readonly maskedPreview: string | null;
  readonly protection: string;
  readonly updatedAt: string | null;
}

export interface RepoItem {
  readonly fullName: string;
  readonly owner: string;
  readonly name: string;
  readonly description: string;
  readonly stars: number;
  readonly language: string | null;
  readonly defaultBranch: string;
  readonly isPrivate: boolean;
  readonly updatedAt: string;
  readonly htmlUrl: string;
}

export interface CommitItem {
  readonly sha: string;
  readonly shortSha: string;
  readonly messageHeadline: string;
  readonly authorLogin: string;
  readonly authorName: string;
  readonly date: string;
  readonly htmlUrl: string;
}

export interface PullItem {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly authorLogin: string;
  readonly baseRef: string;
  readonly headSha: string;
  readonly isFork: boolean;
  readonly htmlUrl: string;
}

export interface GitScoreFactor {
  readonly id: string;
  readonly label: string;
  readonly delta: number;
  readonly outcome: "pass" | "warn" | "fail";
}

export interface GitScoreReport {
  readonly score: number;
  readonly projectedPostFixScore: number | null;
  readonly grade: "A" | "B" | "C" | "D" | "F";
  readonly mode: "deterministic-filter" | "semantic-verified";
  readonly filter: {
    readonly totalFiles: number;
    readonly inScopeCount: number;
    readonly skippedCount: number;
    readonly blockedCount: number;
    readonly secretsDetectedCount: number;
    readonly totalChars: number;
    readonly dispatchedChars: number;
    readonly savedChars: number;
    readonly savedRatio: number;
    readonly files: readonly {
      readonly path: string;
      readonly category: string;
      readonly reason: string;
      readonly chars: number;
      readonly matchedRuleIds: readonly string[];
      readonly secretsRedacted: number;
    }[];
  };
  readonly segments14: readonly TelemetrySegmentState[];
  readonly factors: readonly GitScoreFactor[];
}

export interface ReviewEntryView {
  readonly kind: "RULE" | "BUILT_IN" | "REVIEW";
  readonly id: string | null;
  readonly outcome: "PASS" | "WARN" | "FAIL" | "SKIPPED" | "UNAVAILABLE";
  readonly violationProbability?: number | null;
  readonly confidence?: number | null;
  readonly rationale?: string | null;
  readonly reason?: string | null;
  readonly message?: string;
  readonly evidenceHunk?: {
    readonly file: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly quote: string;
  } | null;
}

export interface AnalysisResponse {
  readonly ok: boolean;
  readonly source: "local" | "github";
  readonly repoFullName: string;
  readonly policySource: string;
  readonly commit: CommitItem;
  readonly unifiedDiff: string;
  readonly files: readonly { readonly path: string; readonly patch: string }[];
  readonly gitScore: GitScoreReport;
  readonly review: {
    readonly aggregateOutcome: string;
    readonly entries: readonly ReviewEntryView[];
    readonly redactedSecretsCount: number;
  } | null;
  readonly fixCandidate: {
    readonly status: "VERIFIED_PATCH" | "NO_FIX_NEEDED" | "REJECTED" | "SKIPPED" | "FAILED";
    readonly unifiedPatch: string | null;
    readonly recheckOutcome: string | null;
    readonly summary: string;
  } | null;
  readonly providerError: string | null;
}

export interface CalibrationReportView {
  readonly ok: boolean;
  readonly corpusName: string;
  readonly summary: {
    readonly sampleCount: number;
    readonly repeatCount: number;
    readonly threshold: number;
    readonly matrix: {
      readonly tp: number;
      readonly fp: number;
      readonly tn: number;
      readonly fn: number;
    };
    readonly precision: number;
    readonly recall: number;
    readonly f1: number;
    readonly brierScore: number;
    readonly ece: number;
    readonly flipRate: number;
  };
  readonly aggregations: readonly {
    readonly mode: string;
    readonly precision: number;
    readonly recall: number;
    readonly f1: number;
  }[];
  readonly allowedSuggestions: readonly {
    readonly ruleId: string;
    readonly suggestion: string;
    readonly reason: string;
  }[];
}

export interface BootstrapState {
  readonly ok: boolean;
  readonly version: string;
  readonly workspacePath: string | null;
  readonly localRepoName: string | null;
  readonly vaultDir: string;
  readonly vaultProtection: string;
  readonly legacyNeedsMigration: boolean;
  readonly github: {
    readonly connected: boolean;
    readonly source: string;
    readonly login: string | null;
    readonly avatarUrl: string | null;
  };
  readonly activeProvider: {
    readonly judgeProvider: string;
    readonly judgeModel: string;
    readonly fixerProvider: string;
    readonly fixerModel: string;
    readonly hasJudgeCredential: boolean;
  };
  readonly teamHooksInstalled: boolean;
  readonly teamWorkflowInstalled: boolean;
  readonly vaultEntries: readonly VaultEntryMeta[];
}

export interface PipelineEventPayload {
  readonly stage: "IDLE" | "SCAN" | "FILTER" | "LINT" | "FIX" | "VERIFY" | "DONE" | "ERROR";
  readonly detail: string;
  readonly inScopeFiles?: number;
  readonly totalFiles?: number;
  readonly timestamp: string;
}

import type {
  MemoryEventV1,
  ParsedRule,
  PolicyConfig,
  ProviderTelemetry,
  ReviewResult,
  Turn,
  TurnFile,
} from "../domain/types.ts";
import { parseUnifiedDiff } from "../evidence/parse-unified-diff.ts";
import type {
  CommandRunnerPort,
  MemoryPort,
  PatchApplierPort,
  PolicySourcePort,
  ProviderPort,
} from "../ports/types.ts";
import { reviewTurn } from "../evaluation/review-turn.ts";
import {
  buildFixPromptRequest,
  type PatchVerificationResult,
  verifyProposedPatch,
} from "./patch-verifier.ts";

export interface AutoFixDependencies {
  readonly policy: PolicySourcePort;
  readonly provider: ProviderPort;
  readonly patchApplier: PatchApplierPort;
  readonly commandRunner?: CommandRunnerPort;
  readonly memory?: MemoryPort;
  readonly verificationCommand?: string;
  readonly workingDir: string;
  readonly applyChanges: boolean;
  readonly allowProtectedOverride?: boolean;
  readonly projectScope?: string;
  readonly nonceFactory?: () => string;
  readonly timestampFactory?: () => string;
}

export interface AutoFixOutcome {
  readonly status: "NO_FIX_NEEDED" | "PROPOSED" | "APPLIED_VERIFIED" | "ROLLED_BACK" | "FAILED";
  readonly patchText: string | null;
  readonly summary: string;
  readonly eligibleRules: readonly string[];
  readonly blockedReasons: readonly string[];
  readonly recheckReview: ReviewResult | null;
  readonly telemetry: readonly ProviderTelemetry[];
  readonly memoryEvents: readonly MemoryEventV1[];
}

/**
 * Executes Stage-2 remediation for failing fixable rules:
 * generate patch -> verify unified diff & path bounds -> apply (if `--apply`) ->
 * run verification command + Stage-1 re-check -> automatic rollback on any failure.
 */
export async function runAutoFix(
  turn: Turn,
  initialReview: ReviewResult,
  rules: readonly ParsedRule[],
  config: PolicyConfig,
  deps: AutoFixDependencies,
): Promise<AutoFixOutcome> {
  const nonce = deps.nonceFactory?.() ?? "ikigai-fix-nonce";
  const built = buildFixPromptRequest(
    initialReview,
    rules,
    turn.files,
    turn.task,
    nonce,
    config.providers.fixer,
  );

  if (built.request === null) {
    return {
      status: built.blockedReasons.length > 0 ? "FAILED" : "NO_FIX_NEEDED",
      patchText: null,
      summary:
        built.blockedReasons.length > 0
          ? `No fixable failing rules: ${built.blockedReasons.join("; ")}`
          : "No failing fixable rules.",
      eligibleRules: [],
      blockedReasons: built.blockedReasons,
      recheckReview: null,
      telemetry: [],
      memoryEvents: [],
    };
  }

  if (!deps.provider.generateFixPatch) {
    return {
      status: "FAILED",
      patchText: null,
      summary: "Configured provider does not support patch generation.",
      eligibleRules: built.eligibleRuleIds,
      blockedReasons: built.blockedReasons,
      recheckReview: null,
      telemetry: [],
      memoryEvents: [],
    };
  }

  const telemetry: ProviderTelemetry[] = [];
  const generated = await deps.provider.generateFixPatch(built.request);
  if (generated.telemetry) {
    telemetry.push(generated.telemetry);
  }

  if (generated.status === "FAILED") {
    return {
      status: "FAILED",
      patchText: null,
      summary: `${generated.errorCode}: ${generated.message}`,
      eligibleRules: built.eligibleRuleIds,
      blockedReasons: built.blockedReasons,
      recheckReview: null,
      telemetry,
      memoryEvents: [],
    };
  }

  const allowedPaths = Array.from(
    new Set(built.request.findings.flatMap((finding) => finding.files)),
  );
  const currentFiles = await deps.patchApplier.readTargetFiles(allowedPaths);

  const verification: PatchVerificationResult = verifyProposedPatch(
    generated.patchText,
    currentFiles,
    {
      allowedPaths,
      fixConfig: config.fix,
      ...(deps.allowProtectedOverride !== undefined
        ? { allowProtectedOverride: deps.allowProtectedOverride }
        : {}),
    },
  );

  if (verification.status === "REJECTED") {
    return {
      status: "FAILED",
      patchText: generated.patchText,
      summary: `${verification.code}: ${verification.reason}`,
      eligibleRules: built.eligibleRuleIds,
      blockedReasons: built.blockedReasons,
      recheckReview: null,
      telemetry,
      memoryEvents: [],
    };
  }

  if (!deps.applyChanges) {
    return {
      status: "PROPOSED",
      patchText: verification.patchText,
      summary: generated.summary,
      eligibleRules: built.eligibleRuleIds,
      blockedReasons: built.blockedReasons,
      recheckReview: null,
      telemetry,
      memoryEvents: [],
    };
  }

  const updatedMap = new Map(verification.edits.map((e) => [e.path, e.updatedContent]));
  const handle = await deps.patchApplier.applyValidatedPatch(updatedMap);

  if (deps.verificationCommand && deps.commandRunner) {
    const cmdResult = await deps.commandRunner.runVerification(
      deps.verificationCommand,
      deps.workingDir,
    );
    if (!cmdResult.ok) {
      await handle.rollback();
      return {
        status: "ROLLED_BACK",
        patchText: verification.patchText,
        summary: `Post-fix verification failed (exit ${cmdResult.exitCode}); rolled back cleanly.`,
        eligibleRules: built.eligibleRuleIds,
        blockedReasons: built.blockedReasons,
        recheckReview: null,
        telemetry,
        memoryEvents: [],
      };
    }
  }

  // Stage-1 semantic re-check on the patched diff
  const parsedFixedFiles = parseUnifiedDiff(verification.patchText);
  const recheckFiles: readonly TurnFile[] =
    parsedFixedFiles.status === "PARSED" ? parsedFixedFiles.files : turn.files;

  const recheckTurn: Turn = {
    id: `${turn.id}:recheck`,
    task: `${turn.task}\n\n[Applied verified auto-fix for: ${built.eligibleRuleIds.join(", ")}]`,
    files: recheckFiles,
    source: turn.source,
  };

  const recheck = await reviewTurn(recheckTurn, {
    policy: deps.policy,
    provider: deps.provider,
    ruleFilter: built.eligibleRuleIds,
    includeBuiltIns: true,
    ...(deps.nonceFactory !== undefined ? { nonceFactory: deps.nonceFactory } : {}),
    ...(deps.timestampFactory !== undefined ? { timestampFactory: deps.timestampFactory } : {}),
  });

  telemetry.push(...recheck.review.telemetry);

  if (
    recheck.review.aggregateOutcome === "FAIL" ||
    recheck.review.aggregateOutcome === "UNAVAILABLE"
  ) {
    await handle.rollback();
    return {
      status: "ROLLED_BACK",
      patchText: verification.patchText,
      summary: `Semantic re-check failed (${recheck.review.aggregateOutcome}); rolled back cleanly.`,
      eligibleRules: built.eligibleRuleIds,
      blockedReasons: built.blockedReasons,
      recheckReview: recheck.review,
      telemetry,
      memoryEvents: [],
    };
  }

  const event: MemoryEventV1 = {
    schemaVersion: 1,
    eventId: `${turn.id}:fix`,
    timestamp: deps.timestampFactory?.() ?? new Date().toISOString(),
    projectScope: deps.projectScope ?? "default",
    redacted: true,
    classification: "fix",
    ttlDays: config.memory.ttlDays,
    turnId: turn.id,
    ruleId: built.eligibleRuleIds[0] ?? null,
    outcome: recheck.review.aggregateOutcome,
    violationProbability: null,
    confidence: null,
    scopedPaths: allowedPaths,
    rationale: generated.summary,
    decisionOrigin: "auto-fix",
  };

  if (deps.memory && config.memory.emitEvents) {
    await deps.memory.emit([event]);
  }

  return {
    status: "APPLIED_VERIFIED",
    patchText: verification.patchText,
    summary: generated.summary,
    eligibleRules: built.eligibleRuleIds,
    blockedReasons: built.blockedReasons,
    recheckReview: recheck.review,
    telemetry,
    memoryEvents: [event],
  };
}

import {
  type BuiltInBatchRequest,
  type BuiltInBatchResult,
  buildBuiltInBatchUserPrompt,
  buildJudgeUserPrompt,
  type FixGenerationResult,
  FIXER_SYSTEM_PROMPT,
  FixPatchResponseSchema,
  type FixPromptRequest,
  JUDGE_SYSTEM_PROMPT,
  type JudgeCallResult,
  type JudgeRequest,
  parseBuiltInBatchJson,
  parseSemanticJudgmentJson,
  type ProviderEndpointConfig,
  type ProviderPort,
  wrapUntrustedBlock,
} from "@ikigai/core";
import { providerToCredentialKey, resolveCredential } from "../credentials/env-and-store.ts";
import { callLocalCliJson } from "./cli-providers.ts";
import { callProviderJsonApi, type JsonCompletionResult } from "./http-providers.ts";

export interface ProviderRouterOptions {
  readonly repoRoot?: string;
  readonly workingDir: string;
  readonly fetchImpl?: typeof fetch;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Multi-provider LLM adapter implementing strict structured output,
 * explicit model pinning, and zero silent fallback.
 */
export function createMultiProvider(options: ProviderRouterOptions): ProviderPort {
  return {
    async judgeRuleSlice(request: JudgeRequest): Promise<JudgeCallResult> {
      const userPrompt = buildJudgeUserPrompt(request);
      const raw = await dispatchJson(
        request.endpoint,
        JUDGE_SYSTEM_PROMPT,
        userPrompt,
        "semantic_judgment",
        options,
      );

      if (!raw.ok) {
        return {
          status: "FAILED",
          reason: "PROVIDER_FAILURE",
          errorCode: raw.errorCode,
          telemetry: raw.telemetry,
        };
      }

      const judgment = parseSemanticJudgmentJson(raw.payload);
      if (judgment === null) {
        return {
          status: "FAILED",
          reason: "PROVIDER_FAILURE",
          errorCode: "SCHEMA_VALIDATION_FAILED",
          telemetry: raw.telemetry,
        };
      }

      return { status: "OK", judgment, telemetry: raw.telemetry };
    },

    async judgeBuiltInBatch(request: BuiltInBatchRequest): Promise<BuiltInBatchResult> {
      const userPrompt = buildBuiltInBatchUserPrompt(request);
      const raw = await dispatchJson(
        request.endpoint,
        JUDGE_SYSTEM_PROMPT,
        userPrompt,
        "builtin_batch",
        options,
      );

      if (!raw.ok) {
        return {
          status: "FAILED",
          reason: "PROVIDER_FAILURE",
          errorCode: raw.errorCode,
          telemetry: raw.telemetry,
        };
      }

      const parsed = parseBuiltInBatchJson(raw.payload);
      if (parsed === null) {
        return {
          status: "FAILED",
          reason: "PROVIDER_FAILURE",
          errorCode: "SCHEMA_VALIDATION_FAILED",
          telemetry: raw.telemetry,
        };
      }

      const toAnswer = (judgment: (typeof parsed)["SCOPE-CREEP"]): JudgeCallResult =>
        judgment === null
          ? {
              status: "FAILED",
              reason: "PROVIDER_FAILURE",
              errorCode: "INVALID_CHECK_ANSWER",
              telemetry: raw.telemetry,
            }
          : { status: "OK", judgment, telemetry: raw.telemetry };

      return {
        status: "OK",
        telemetry: raw.telemetry,
        answers: {
          "SCOPE-CREEP": toAnswer(parsed["SCOPE-CREEP"]),
          COMPLEXITY: toAnswer(parsed.COMPLEXITY),
          "TEST-ADEQUACY": toAnswer(parsed["TEST-ADEQUACY"]),
        },
      };
    },

    async generateFixPatch(request: FixPromptRequest): Promise<FixGenerationResult> {
      const findingsText = request.findings
        .map((f) =>
          [
            `- Rule: ${f.ruleId}`,
            `  Summary: ${f.ruleSummary}`,
            `  Violation: ${f.violationCriteria}`,
            `  Allowed: ${f.allowedCriteria ?? "None"}`,
            `  FixHint: ${f.fixHint ?? "Keep minimal and preserve existing contracts."}`,
            `  Rationale: ${f.rationale ?? ""}`,
            `  Files: ${f.files.join(", ")}`,
          ].join("\n"),
        )
        .join("\n");

      const userPrompt = [
        "Generate a minimal, verifiable unified diff patch fixing ONLY the failing rules below.",
        wrapUntrustedBlock("findings", findingsText, request.nonce),
        wrapUntrustedBlock("task", request.task, request.nonce),
        wrapUntrustedBlock("failing_diff", request.diff, request.nonce),
      ].join("\n\n");

      const raw = await dispatchJson(
        request.endpoint,
        FIXER_SYSTEM_PROMPT,
        userPrompt,
        "fix_patch",
        options,
      );

      if (!raw.ok) {
        return {
          status: "FAILED",
          errorCode: raw.errorCode,
          message: `Fixer call failed (${raw.errorCode}).`,
          telemetry: raw.telemetry,
        };
      }

      const parsed = FixPatchResponseSchema.safeParse(raw.payload);
      if (!parsed.success) {
        return {
          status: "FAILED",
          errorCode: "INVALID_FIX_SCHEMA",
          message: "Fixer response did not match { summary, unifiedDiff } schema.",
          telemetry: raw.telemetry,
        };
      }

      return {
        status: "OK",
        patchText: parsed.data.unifiedDiff,
        summary: parsed.data.summary,
        telemetry: raw.telemetry,
      };
    },
  };
}

async function dispatchJson(
  endpoint: ProviderEndpointConfig,
  systemPrompt: string,
  userPrompt: string,
  schemaName: "semantic_judgment" | "builtin_batch" | "fix_patch",
  options: ProviderRouterOptions,
): Promise<JsonCompletionResult> {
  if (endpoint.mode === "cli" || endpoint.provider === "cli") {
    return callLocalCliJson(endpoint, systemPrompt, userPrompt, {
      cwd: options.workingDir,
    });
  }

  const credKey = providerToCredentialKey(endpoint.provider);
  if (credKey === null) {
    return {
      ok: false,
      errorCode: "UNSUPPORTED_PROVIDER",
      telemetry: { provider: endpoint.provider, modelId: endpoint.model, latencyMs: 0 },
    };
  }

  const cred = resolveCredential(credKey, options.repoRoot, options.env);
  if (!cred.found || cred.value === null) {
    return {
      ok: false,
      errorCode: "MISSING_CREDENTIAL",
      telemetry: { provider: endpoint.provider, modelId: endpoint.model, latencyMs: 0 },
    };
  }

  return callProviderJsonApi(
    {
      provider: endpoint.provider,
      model: endpoint.model,
      apiKey: cred.value,
      systemPrompt,
      userPrompt,
      schemaName,
    },
    options.fetchImpl,
  );
}

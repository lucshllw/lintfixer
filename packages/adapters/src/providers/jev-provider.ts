import type {
  BuiltInBatchRequest,
  BuiltInBatchResult,
  BuiltInCheckId,
  EvidenceHunk,
  JudgeCallResult,
  JudgeRequest,
  ProviderTelemetry,
} from "@ikigai/core";

const DEFAULT_TYPESAFE_BASE_URL = "https://api.typesafe.ai";
const DEFAULT_ALLOWED_CRITERION = "The change does not violate the rule's Violation criteria.";

export interface JevProviderCallOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

interface TypeSafeNoulQuestion {
  readonly type: "noul";
  readonly instructions: string;
  readonly criteria: {
    readonly true: string;
    readonly false: string;
  };
}

/**
 * Invokes TypeSafe System-1 (`jev-latest`) for single rule evaluation over HTTP `fetch`,
 * avoiding native dependencies in the standalone LintFixer bundle.
 */
export async function callJevRuleApi(
  request: JudgeRequest,
  opts: JevProviderCallOptions,
): Promise<JudgeCallResult> {
  const startedAt = Date.now();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const endpointUrl = `${opts.baseUrl ?? DEFAULT_TYPESAFE_BASE_URL}/v1/systemone`;

  const body = {
    model: request.endpoint.model,
    state: {
      task: request.task,
      rule: {
        id: request.checkId,
        description: request.ruleSummary,
        violation: request.violationCriteria,
        ...(request.allowedCriteria ? { allowed: request.allowedCriteria } : {}),
      },
      change: {
        files: [...request.files],
        diff: request.diff,
      },
    },
    questions: {
      violation: buildNoulQuestion(
        `Evaluate whether the attributed diff violates ${request.checkId}.`,
        request.violationCriteria,
        request.allowedCriteria,
      ),
    },
  };

  const res = await dispatchSystemOne(
    endpointUrl,
    opts.apiKey,
    request.endpoint.model,
    body,
    startedAt,
    fetchImpl,
  );
  if (!res.ok) {
    return {
      status: "FAILED",
      reason: "PROVIDER_FAILURE",
      errorCode: res.errorCode,
      telemetry: res.telemetry,
    };
  }

  const prob = readNoulProbability(res.answers.violation);
  if (prob === null) {
    return {
      status: "FAILED",
      reason: "PROVIDER_FAILURE",
      errorCode: "SCHEMA_VALIDATION_FAILED",
      telemetry: res.telemetry,
    };
  }

  return {
    status: "OK",
    telemetry: res.telemetry,
    judgment: {
      violationProbability: prob,
      confidence: 1,
      evidenceHunk: prob >= 0.4 ? extractSliceAnchorHunk(request.files, request.diff) : null,
      rationale: `Jev System-1 calibrated probability: ${prob.toFixed(3)}`,
    },
  };
}

/**
 * Invokes TypeSafe System-1 (`jev-latest`) for the three built-in semantic checks in one turn.
 */
export async function callJevBuiltInBatchApi(
  request: BuiltInBatchRequest,
  opts: JevProviderCallOptions,
): Promise<BuiltInBatchResult> {
  const startedAt = Date.now();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const endpointUrl = `${opts.baseUrl ?? DEFAULT_TYPESAFE_BASE_URL}/v1/systemone`;

  const byId = new Map(request.checks.map((c) => [c.checkId, c]));
  const scopeCreep = byId.get("SCOPE-CREEP");
  const complexity = byId.get("COMPLEXITY");
  const testAdequacy = byId.get("TEST-ADEQUACY");

  const body = {
    model: request.endpoint.model,
    state: {
      task: request.task,
      checks: {
        ...(scopeCreep
          ? {
              scopeCreep: {
                id: scopeCreep.checkId,
                description: scopeCreep.ruleSummary,
                violation: scopeCreep.violationCriteria,
                allowed: scopeCreep.allowedCriteria,
              },
            }
          : {}),
        ...(complexity
          ? {
              complexity: {
                id: complexity.checkId,
                description: complexity.ruleSummary,
                violation: complexity.violationCriteria,
                allowed: complexity.allowedCriteria,
              },
            }
          : {}),
        ...(testAdequacy
          ? {
              testAdequacy: {
                id: testAdequacy.checkId,
                description: testAdequacy.ruleSummary,
                violation: testAdequacy.violationCriteria,
                allowed: testAdequacy.allowedCriteria,
              },
            }
          : {}),
      },
      change: {
        files: [...request.files],
        diff: request.diff,
      },
    },
    questions: Object.fromEntries(
      request.checks.map((c) => [
        c.checkId,
        buildNoulQuestion(
          `Evaluate built-in check ${c.checkId} against the attributed diff.`,
          c.violationCriteria,
          c.allowedCriteria,
        ),
      ]),
    ),
  };

  const res = await dispatchSystemOne(
    endpointUrl,
    opts.apiKey,
    request.endpoint.model,
    body,
    startedAt,
    fetchImpl,
  );
  if (!res.ok) {
    return {
      status: "FAILED",
      reason: "PROVIDER_FAILURE",
      errorCode: res.errorCode,
      telemetry: res.telemetry,
    };
  }

  const readCheck = (id: BuiltInCheckId): JudgeCallResult => {
    const prob = readNoulProbability(res.answers[id]);
    if (prob === null) {
      return {
        status: "FAILED",
        reason: "PROVIDER_FAILURE",
        errorCode: "INVALID_CHECK_ANSWER",
        telemetry: res.telemetry,
      };
    }
    return {
      status: "OK",
      telemetry: res.telemetry,
      judgment: {
        violationProbability: prob,
        confidence: 1,
        evidenceHunk: prob >= 0.4 ? extractSliceAnchorHunk(request.files, request.diff) : null,
        rationale: `Jev System-1 calibrated probability: ${prob.toFixed(3)}`,
      },
    };
  };

  return {
    status: "OK",
    telemetry: res.telemetry,
    answers: {
      "SCOPE-CREEP": readCheck("SCOPE-CREEP"),
      COMPLEXITY: readCheck("COMPLEXITY"),
      "TEST-ADEQUACY": readCheck("TEST-ADEQUACY"),
    },
  };
}

function buildNoulQuestion(
  instructions: string,
  violation: string,
  allowed: string | null,
): TypeSafeNoulQuestion {
  return {
    type: "noul",
    instructions,
    criteria: {
      true: violation,
      false: allowed ?? DEFAULT_ALLOWED_CRITERION,
    },
  };
}

async function dispatchSystemOne(
  url: string,
  apiKey: string,
  modelId: string,
  body: unknown,
  startedAt: number,
  fetchImpl: typeof fetch,
): Promise<
  | {
      readonly ok: true;
      readonly answers: Record<string, unknown>;
      readonly telemetry: ProviderTelemetry;
    }
  | { readonly ok: false; readonly errorCode: string; readonly telemetry: ProviderTelemetry }
> {
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      return {
        ok: false,
        errorCode: `HTTP_${response.status}`,
        telemetry: { provider: "jev", modelId, latencyMs },
      };
    }

    const parsed = (await response.json()) as { answers?: unknown };
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !parsed.answers ||
      typeof parsed.answers !== "object" ||
      Array.isArray(parsed.answers)
    ) {
      return {
        ok: false,
        errorCode: "INVALID_RESPONSE",
        telemetry: { provider: "jev", modelId, latencyMs },
      };
    }

    return {
      ok: true,
      answers: parsed.answers as Record<string, unknown>,
      telemetry: { provider: "jev", modelId, latencyMs },
    };
  } catch {
    return {
      ok: false,
      errorCode: "NETWORK_OR_PARSE_ERROR",
      telemetry: { provider: "jev", modelId, latencyMs: Date.now() - startedAt },
    };
  }
}

function readNoulProbability(node: unknown): number | null {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    return null;
  }
  const rec = node as { type?: unknown; noul?: unknown };
  if (rec.type !== "noul" || typeof rec.noul !== "number" || !Number.isFinite(rec.noul)) {
    return null;
  }
  if (rec.noul < 0 || rec.noul > 1) {
    return null;
  }
  return rec.noul;
}

/**
 * Anchors calibrated Jev probabilities to a real changed line in the inspected slice diff so
 * deterministic grounding passes without inventing external prose.
 */
function extractSliceAnchorHunk(files: readonly string[], diff: string): EvidenceHunk | null {
  const firstFile = files[0];
  if (!firstFile) {
    return null;
  }

  const lines = diff.split(/\r?\n/);
  let currentLine = 1;
  for (const line of lines) {
    const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
    if (hunkMatch) {
      currentLine = Math.max(1, Number.parseInt(hunkMatch[1] ?? "1", 10) || 1);
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      const code = line.slice(1).trim();
      if (code.length > 0) {
        return {
          file: firstFile,
          startLine: currentLine,
          endLine: currentLine,
          quote: line.slice(0, 600),
        };
      }
      currentLine += 1;
      continue;
    }
    if (!line.startsWith("-") && !line.startsWith("---")) {
      currentLine += 1;
    }
  }

  return null;
}

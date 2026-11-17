import type { ProviderKind, ProviderTelemetry } from "@ikigai/core";
import {
  BUILTIN_BATCH_JSON_SCHEMA,
  FIX_PATCH_JSON_SCHEMA,
  parseLooseJsonObject,
  SEMANTIC_JUDGMENT_JSON_SCHEMA,
} from "./schema.ts";

export interface JsonCompletionRequest {
  readonly provider: Exclude<ProviderKind, "cli" | "jev">;
  readonly model: string;
  readonly apiKey: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly schemaName: "semantic_judgment" | "builtin_batch" | "fix_patch";
  readonly baseUrl?: string;
}

export interface JsonCompletionSuccess {
  readonly ok: true;
  readonly payload: unknown;
  readonly telemetry: ProviderTelemetry;
}

export interface JsonCompletionFailure {
  readonly ok: false;
  readonly errorCode: string;
  readonly telemetry: ProviderTelemetry;
}

export type JsonCompletionResult = JsonCompletionSuccess | JsonCompletionFailure;

function selectSchema(name: JsonCompletionRequest["schemaName"]): Record<string, unknown> {
  switch (name) {
    case "semantic_judgment":
      return SEMANTIC_JUDGMENT_JSON_SCHEMA;
    case "builtin_batch":
      return BUILTIN_BATCH_JSON_SCHEMA;
    case "fix_patch":
      return FIX_PATCH_JSON_SCHEMA;
  }
}

export async function callProviderJsonApi(
  req: JsonCompletionRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<JsonCompletionResult> {
  const startedAt = Date.now();

  try {
    if (req.provider === "openai") {
      return await callOpenAi(req, startedAt, fetchImpl);
    }
    if (req.provider === "gemini") {
      return await callGemini(req, startedAt, fetchImpl);
    }
    return await callAnthropic(req, startedAt, fetchImpl);
  } catch {
    return {
      ok: false,
      errorCode: "NETWORK_OR_PARSE_ERROR",
      telemetry: {
        provider: req.provider,
        modelId: req.model,
        latencyMs: Date.now() - startedAt,
      },
    };
  }
}

async function callOpenAi(
  req: JsonCompletionRequest,
  startedAt: number,
  fetchImpl: typeof fetch,
): Promise<JsonCompletionResult> {
  const endpoint = `${req.baseUrl ?? "https://api.openai.com"}/v1/chat/completions`;
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${req.apiKey}`,
    },
    body: JSON.stringify({
      model: req.model,
      temperature: 0,
      messages: [
        { role: "system", content: req.systemPrompt },
        { role: "user", content: req.userPrompt },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: req.schemaName,
          strict: true,
          schema: selectSchema(req.schemaName),
        },
      },
    }),
  });

  const latencyMs = Date.now() - startedAt;
  if (!response.ok) {
    return {
      ok: false,
      errorCode: `HTTP_${response.status}`,
      telemetry: { provider: "openai", modelId: req.model, latencyMs },
    };
  }

  const body = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const content = body.choices?.[0]?.message?.content;
  if (!content) {
    return {
      ok: false,
      errorCode: "EMPTY_RESPONSE",
      telemetry: { provider: "openai", modelId: req.model, latencyMs },
    };
  }

  return {
    ok: true,
    payload: parseLooseJsonObject(content),
    telemetry: {
      provider: "openai",
      modelId: req.model,
      latencyMs,
      ...(body.usage?.prompt_tokens !== undefined ? { inputTokens: body.usage.prompt_tokens } : {}),
      ...(body.usage?.completion_tokens !== undefined
        ? { outputTokens: body.usage.completion_tokens }
        : {}),
    },
  };
}

async function callGemini(
  req: JsonCompletionRequest,
  startedAt: number,
  fetchImpl: typeof fetch,
): Promise<JsonCompletionResult> {
  const base = req.baseUrl ?? "https://generativelanguage.googleapis.com";
  const endpoint = `${base}/v1beta/models/${encodeURIComponent(req.model)}:generateContent`;
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": req.apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: req.systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: req.userPrompt }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
        responseJsonSchema: selectSchema(req.schemaName),
      },
    }),
  });

  const latencyMs = Date.now() - startedAt;
  if (!response.ok) {
    return {
      ok: false,
      errorCode: `HTTP_${response.status}`,
      telemetry: { provider: "gemini", modelId: req.model, latencyMs },
    };
  }

  const body = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };

  const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    return {
      ok: false,
      errorCode: "EMPTY_RESPONSE",
      telemetry: { provider: "gemini", modelId: req.model, latencyMs },
    };
  }

  return {
    ok: true,
    payload: parseLooseJsonObject(text),
    telemetry: {
      provider: "gemini",
      modelId: req.model,
      latencyMs,
      ...(body.usageMetadata?.promptTokenCount !== undefined
        ? { inputTokens: body.usageMetadata.promptTokenCount }
        : {}),
      ...(body.usageMetadata?.candidatesTokenCount !== undefined
        ? { outputTokens: body.usageMetadata.candidatesTokenCount }
        : {}),
    },
  };
}

async function callAnthropic(
  req: JsonCompletionRequest,
  startedAt: number,
  fetchImpl: typeof fetch,
): Promise<JsonCompletionResult> {
  const endpoint = `${req.baseUrl ?? "https://api.anthropic.com"}/v1/messages`;
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": req.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: req.model,
      max_tokens: 2048,
      temperature: 0,
      system: req.systemPrompt,
      messages: [{ role: "user", content: req.userPrompt }],
      tools: [
        {
          name: req.schemaName,
          description: "Structured evaluation response.",
          input_schema: selectSchema(req.schemaName),
        },
      ],
      tool_choice: { type: "tool", name: req.schemaName },
    }),
  });

  const latencyMs = Date.now() - startedAt;
  if (!response.ok) {
    return {
      ok: false,
      errorCode: `HTTP_${response.status}`,
      telemetry: { provider: "claude", modelId: req.model, latencyMs },
    };
  }

  const body = (await response.json()) as {
    content?: { type?: string; input?: unknown; text?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  const toolBlock = body.content?.find((c) => c.type === "tool_use");
  const payload =
    toolBlock?.input ??
    (body.content?.[0]?.text ? parseLooseJsonObject(body.content[0].text) : null);

  if (payload === null) {
    return {
      ok: false,
      errorCode: "EMPTY_RESPONSE",
      telemetry: { provider: "claude", modelId: req.model, latencyMs },
    };
  }

  return {
    ok: true,
    payload,
    telemetry: {
      provider: "claude",
      modelId: req.model,
      latencyMs,
      ...(body.usage?.input_tokens !== undefined ? { inputTokens: body.usage.input_tokens } : {}),
      ...(body.usage?.output_tokens !== undefined
        ? { outputTokens: body.usage.output_tokens }
        : {}),
    },
  };
}

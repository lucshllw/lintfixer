export const EVIDENCE_HUNK_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["file", "startLine", "endLine", "quote"],
  properties: {
    file: { type: "string" },
    startLine: { type: "integer", minimum: 1 },
    endLine: { type: "integer", minimum: 1 },
    quote: { type: "string" },
  },
} as const;

export const SEMANTIC_JUDGMENT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["violationProbability", "confidence", "evidenceHunk", "rationale"],
  properties: {
    violationProbability: { type: "number", minimum: 0, maximum: 1 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    evidenceHunk: {
      anyOf: [EVIDENCE_HUNK_JSON_SCHEMA, { type: "null" }],
    },
    rationale: { type: "string" },
  },
} as const;

export const BUILTIN_BATCH_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["SCOPE-CREEP", "COMPLEXITY", "TEST-ADEQUACY"],
  properties: {
    "SCOPE-CREEP": SEMANTIC_JUDGMENT_JSON_SCHEMA,
    COMPLEXITY: SEMANTIC_JUDGMENT_JSON_SCHEMA,
    "TEST-ADEQUACY": SEMANTIC_JUDGMENT_JSON_SCHEMA,
  },
} as const;

export const FIX_PATCH_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "unifiedDiff"],
  properties: {
    summary: { type: "string" },
    unifiedDiff: { type: "string" },
  },
} as const;

/**
 * Extracts and parses a JSON object even when a provider or CLI wraps it in code fences.
 */
export function parseLooseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    const firstBrace = candidate.indexOf("{");
    const lastBrace = candidate.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
    }
    throw new Error("NO_JSON_OBJECT");
  }
}

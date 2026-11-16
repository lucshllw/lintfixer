import { parseAllDocuments } from "yaml";
import { z } from "zod";
import type { PolicyConfig } from "../domain/types.ts";
import type { ConfigParseResult } from "./types.ts";

export const DEFAULT_POLICY_CONFIG: PolicyConfig = {
  version: 1,
  thresholds: {
    error: { warn: 0.4, fail: 0.7 },
    warning: { warn: 0.6 },
    confidenceMin: 0.55,
  },
  slicing: {
    maxDiffLength: 100_000,
    maxSlicesPerRule: 16,
    maxExtraSlicesPerTurn: 32,
    aggregation: "max",
    topK: 2,
  },
  providers: {
    judge: { provider: "openai", model: "gpt-5-mini", mode: "api" },
    fixer: { provider: "openai", model: "gpt-5", mode: "api" },
  },
  fix: {
    enabled: true,
    maxRecheckCycles: 1,
    allowTests: false,
    allowDependencies: false,
    allowWorkflows: false,
    allowConfigs: false,
  },
  commitLint: {
    conventionalFormat: true,
    semanticMatch: true,
  },
  github: {
    approveOnPass: true,
    requestChangesOnFail: true,
    forkPolicy: "comment-only",
  },
  memory: {
    emitEvents: true,
    ttlDays: 90,
  },
};

const UnitNumberSchema = z.number().finite().min(0).max(1);

const EndpointSchema = z
  .object({
    provider: z.enum(["openai", "gemini", "claude", "cli"]),
    model: z.string().min(1),
    mode: z.enum(["api", "cli"]).default("api"),
    cliCommand: z.string().min(1).optional(),
  })
  .strict();

const ConfigInputSchema = z
  .object({
    version: z.literal(1),
    thresholds: z
      .object({
        error: z
          .object({
            warn: UnitNumberSchema.default(0.4),
            fail: UnitNumberSchema.default(0.7),
          })
          .strict()
          .default({ warn: 0.4, fail: 0.7 }),
        warning: z
          .object({
            warn: UnitNumberSchema.default(0.6),
          })
          .strict()
          .default({ warn: 0.6 }),
        confidenceMin: UnitNumberSchema.default(0.55),
      })
      .strict()
      .optional(),
    slicing: z
      .object({
        maxDiffLength: z.number().int().min(500).max(500_000).default(100_000),
        maxSlicesPerRule: z.number().int().min(1).max(64).default(16),
        maxExtraSlicesPerTurn: z.number().int().min(0).max(256).default(32),
        aggregation: z.enum(["max", "topKMean", "noisyOr"]).default("max"),
        topK: z.number().int().min(1).max(16).default(2),
      })
      .strict()
      .optional(),
    providers: z
      .object({
        judge: EndpointSchema.optional(),
        fixer: EndpointSchema.optional(),
      })
      .strict()
      .optional(),
    fix: z
      .object({
        enabled: z.boolean().default(true),
        maxRecheckCycles: z.number().int().min(0).max(3).default(1),
        allowTests: z.boolean().default(false),
        allowDependencies: z.boolean().default(false),
        allowWorkflows: z.boolean().default(false),
        allowConfigs: z.boolean().default(false),
      })
      .strict()
      .optional(),
    commitLint: z
      .object({
        conventionalFormat: z.boolean().default(true),
        semanticMatch: z.boolean().default(true),
      })
      .strict()
      .optional(),
    github: z
      .object({
        approveOnPass: z.boolean().default(true),
        requestChangesOnFail: z.boolean().default(true),
        forkPolicy: z.enum(["comment-only", "ignore"]).default("comment-only"),
      })
      .strict()
      .optional(),
    memory: z
      .object({
        emitEvents: z.boolean().default(true),
        ttlDays: z.number().int().min(1).max(3650).default(90),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * Parses `.ikigai/config.yaml` (or `.jev/config.yaml` compatible subset) using strict
 * YAML rules (single document, no anchors, no aliases, no duplicate keys, no explicit tags).
 */
export function parsePolicyConfig(yamlText: string | null): ConfigParseResult {
  const cleanText = yamlText?.replace(/^\uFEFF/, "") ?? null;
  if (cleanText === null || cleanText.trim() === "") {
    return { status: "PARSED", config: DEFAULT_POLICY_CONFIG };
  }

  const docs = parseAllDocuments(cleanText, {
    uniqueKeys: true,
    strict: true,
  });

  if (docs.length !== 1) {
    return {
      status: "INVALID",
      code: "INVALID_YAML",
      message: "Config must contain exactly one YAML document.",
    };
  }

  const doc = docs[0];
  if (doc === undefined || doc.errors.length > 0) {
    return {
      status: "INVALID",
      code: "INVALID_YAML",
      message: doc?.errors[0]?.message ?? "Invalid YAML syntax.",
    };
  }

  if (hasDisallowedYamlFeatures(cleanText)) {
    return {
      status: "INVALID",
      code: "INVALID_YAML",
      message: "YAML anchors, aliases, and explicit tags are not allowed.",
    };
  }

  const raw = doc.toJS({ maxAliasCount: 0 });
  const parsed = ConfigInputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      status: "INVALID",
      code: "INVALID_CONFIG",
      message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    };
  }

  const data = parsed.data;
  const thresholds = data.thresholds ?? DEFAULT_POLICY_CONFIG.thresholds;
  if (thresholds.error.warn >= thresholds.error.fail) {
    return {
      status: "INVALID",
      code: "INVALID_CONFIG",
      message: "thresholds.error.warn must be strictly less than thresholds.error.fail.",
    };
  }

  const judgeEndpoint = data.providers?.judge
    ? {
        provider: data.providers.judge.provider,
        model: data.providers.judge.model,
        mode: data.providers.judge.mode,
        ...(data.providers.judge.cliCommand !== undefined
          ? { cliCommand: data.providers.judge.cliCommand }
          : {}),
      }
    : DEFAULT_POLICY_CONFIG.providers.judge;

  const fixerEndpoint = data.providers?.fixer
    ? {
        provider: data.providers.fixer.provider,
        model: data.providers.fixer.model,
        mode: data.providers.fixer.mode,
        ...(data.providers.fixer.cliCommand !== undefined
          ? { cliCommand: data.providers.fixer.cliCommand }
          : {}),
      }
    : DEFAULT_POLICY_CONFIG.providers.fixer;

  return {
    status: "PARSED",
    config: {
      version: 1,
      thresholds,
      slicing: data.slicing ?? DEFAULT_POLICY_CONFIG.slicing,
      providers: {
        judge: judgeEndpoint,
        fixer: fixerEndpoint,
      },
      fix: data.fix ?? DEFAULT_POLICY_CONFIG.fix,
      commitLint: data.commitLint ?? DEFAULT_POLICY_CONFIG.commitLint,
      github: data.github ?? DEFAULT_POLICY_CONFIG.github,
      memory: data.memory ?? DEFAULT_POLICY_CONFIG.memory,
    },
  };
}

function hasDisallowedYamlFeatures(yamlText: string): boolean {
  const lines = yamlText.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    if (/^\s*&\S+|:\s+&\S+|^\s*\*\S+|:\s+\*\S+|\s!!?[A-Za-z0-9]/.test(line)) {
      return true;
    }
  }
  return false;
}

import { parseConventionalCommit } from "../commit/commit-lint.ts";
import type { ParsedRule, ReviewResult, TurnFile } from "../domain/types.ts";
import { DEFAULT_EVIDENCE_POLICY } from "../evidence/defaults.ts";
import { normalizePath, pathBasename } from "../evidence/paths.ts";
import { redactSecrets } from "../evidence/redact.ts";
import { checkFilePath, selectApplicableFiles } from "../evidence/safety.ts";

const LOCK_OR_GENERATED_RE =
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|cargo\.lock|poetry\.lock|go\.sum)$|\.min\.(js|css)$|^dist\/|^build\/|\.map$/i;

const TEST_FILE_RE = /(?:^|\/)(?:test|tests|__tests__)\/|(?:\.test|\.spec)\.[a-z0-9]+$/i;
const DOC_FILE_RE = /\.(?:md|mdx|txt|rst)$/i;

export type FileFilterCategory =
  | "in-scope"
  | "skipped-lock-or-asset"
  | "skipped-out-of-scope"
  | "blocked-sensitive";

export interface ClassifiedCommitFile {
  readonly path: string;
  readonly category: FileFilterCategory;
  readonly reason: string;
  readonly chars: number;
  readonly matchedRuleIds: readonly string[];
  readonly secretsRedacted: number;
}

export interface CommitPreFilterSummary {
  readonly totalFiles: number;
  readonly inScopeCount: number;
  readonly skippedCount: number;
  readonly blockedCount: number;
  readonly secretsDetectedCount: number;
  readonly totalChars: number;
  readonly dispatchedChars: number;
  readonly savedChars: number;
  readonly savedRatio: number;
  readonly files: readonly ClassifiedCommitFile[];
}

export type TelemetrySegmentState = "pass" | "warn" | "fail" | "empty";

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
  readonly filter: CommitPreFilterSummary;
  readonly segments14: readonly TelemetrySegmentState[];
  readonly factors: readonly GitScoreFactor[];
}

export interface ComputeGitScoreInput {
  readonly commitMessage: string;
  readonly files: readonly TurnFile[];
  readonly rules: readonly ParsedRule[];
  readonly review?: ReviewResult | null;
  readonly hasVerifiedFix?: boolean;
  readonly semanticMatchOutcome?: "PASS" | "WARN" | "FAIL" | "SKIPPED" | "UNAVAILABLE";
}

/**
 * Runs a cheap zero-LLM pre-filter across changed files before spending provider credits.
 */
export function classifyCommitFiles(
  files: readonly TurnFile[],
  rules: readonly ParsedRule[],
): CommitPreFilterSummary {
  const matchedRulesByPath = new Map<string, string[]>();
  for (const rule of rules) {
    const matched = selectApplicableFiles(files, rule, DEFAULT_EVIDENCE_POLICY);
    for (const file of matched) {
      const list = matchedRulesByPath.get(file.path) ?? [];
      list.push(rule.id);
      matchedRulesByPath.set(file.path, list);
    }
  }

  const classified: ClassifiedCommitFile[] = [];
  let inScopeCount = 0;
  let skippedCount = 0;
  let blockedCount = 0;
  let secretsDetectedCount = 0;
  let totalChars = 0;
  let dispatchedChars = 0;

  for (const file of files) {
    const normalized = normalizePath(file.path);
    const chars = file.patch.length;
    totalChars += chars;

    const redaction = redactSecrets(file.patch);
    secretsDetectedCount += redaction.redactionCount;

    const pathSafety = checkFilePath(normalized, DEFAULT_EVIDENCE_POLICY);
    if (!pathSafety.allowed && pathSafety.reason === "DENIED_SENSITIVE_PATH") {
      blockedCount += 1;
      classified.push({
        path: normalized,
        category: "blocked-sensitive",
        reason: "Arquivo sensivel bloqueado pelo filtro local",
        chars,
        matchedRuleIds: [],
        secretsRedacted: redaction.redactionCount,
      });
      continue;
    }

    if (!pathSafety.allowed && pathSafety.reason === "UNSAFE_PATH") {
      blockedCount += 1;
      classified.push({
        path: normalized,
        category: "blocked-sensitive",
        reason: "Caminho invalido ou path traversal bloqueado",
        chars,
        matchedRuleIds: [],
        secretsRedacted: redaction.redactionCount,
      });
      continue;
    }

    const base = pathBasename(normalized).toLowerCase();
    if (
      LOCK_OR_GENERATED_RE.test(normalized) ||
      base === ".ds_store" ||
      (!pathSafety.allowed && pathSafety.reason === "EXTENSION_NOT_ALLOWED") ||
      file.patch.trim() === ""
    ) {
      skippedCount += 1;
      classified.push({
        path: normalized,
        category: "skipped-lock-or-asset",
        reason: "Lockfile, build artifact ou asset fora de escopo semantico",
        chars,
        matchedRuleIds: [],
        secretsRedacted: redaction.redactionCount,
      });
      continue;
    }

    const matchedRuleIds = matchedRulesByPath.get(file.path) ?? [];
    if (rules.length > 0 && matchedRuleIds.length === 0 && redaction.redactionCount === 0) {
      skippedCount += 1;
      classified.push({
        path: normalized,
        category: "skipped-out-of-scope",
        reason: "Nenhuma regra ativa incide sobre este arquivo",
        chars,
        matchedRuleIds: [],
        secretsRedacted: 0,
      });
      continue;
    }

    inScopeCount += 1;
    dispatchedChars += chars;
    classified.push({
      path: normalized,
      category: "in-scope",
      reason:
        matchedRuleIds.length > 0
          ? `Monitorado por ${matchedRuleIds.join(", ")}`
          : "Codigo em escopo para revisao",
      chars,
      matchedRuleIds,
      secretsRedacted: redaction.redactionCount,
    });
  }

  const savedChars = Math.max(0, totalChars - dispatchedChars);
  const savedRatio = totalChars > 0 ? savedChars / totalChars : 0;

  return {
    totalFiles: files.length,
    inScopeCount,
    skippedCount,
    blockedCount,
    secretsDetectedCount,
    totalChars,
    dispatchedChars,
    savedChars,
    savedRatio,
    files: classified,
  };
}

/**
 * Computes a transparent 0-100 Git Score combining deterministic commit hygiene,
 * cheap file pre-filtering, and (when executed) grounded semantic lint outcomes.
 */
export function computeGitScore(input: ComputeGitScoreInput): GitScoreReport {
  const filter = classifyCommitFiles(input.files, input.rules);
  const factors: GitScoreFactor[] = [];
  let score = 100;

  const conventional = parseConventionalCommit(input.commitMessage);
  if (!conventional.valid) {
    score -= 10;
    factors.push({
      id: "HYGIENE-COMMIT-MSG",
      label: "Mensagem fora do padrao Conventional Commits",
      delta: -10,
      outcome: "warn",
    });
  } else {
    factors.push({
      id: "HYGIENE-COMMIT-MSG",
      label: `Commit convencional (${conventional.type ?? "ok"})`,
      delta: 0,
      outcome: "pass",
    });
  }

  if (filter.blockedCount > 0 || filter.secretsDetectedCount > 0) {
    const penalty = Math.min(35, filter.blockedCount * 15 + filter.secretsDetectedCount * 18);
    score -= penalty;
    factors.push({
      id: "FILTER-SENSITIVE",
      label: `${filter.blockedCount} arquivo(s) sensivel(is) e ${filter.secretsDetectedCount} padrao(oes) de segredo detectado(s)`,
      delta: -penalty,
      outcome: "fail",
    });
  }

  const changedCodeCount = filter.files.filter(
    (f) => f.category === "in-scope" && !TEST_FILE_RE.test(f.path) && !DOC_FILE_RE.test(f.path),
  ).length;
  const changedTestCount = input.files.filter((f) => TEST_FILE_RE.test(f.path)).length;

  if (changedCodeCount > 8) {
    const blastPenalty = Math.min(12, (changedCodeCount - 8) * 2);
    score -= blastPenalty;
    factors.push({
      id: "HYGIENE-BLAST-RADIUS",
      label: `Blast radius elevado (${changedCodeCount} arquivos de codigo no commit)`,
      delta: -blastPenalty,
      outcome: "warn",
    });
  }

  if (changedCodeCount > 0 && changedTestCount === 0 && input.review == null) {
    score -= 6;
    factors.push({
      id: "HYGIENE-TESTS",
      label: "Codigo alterado sem testes no mesmo commit",
      delta: -6,
      outcome: "warn",
    });
  }

  if (input.semanticMatchOutcome === "FAIL") {
    score -= 14;
    factors.push({
      id: "COMMIT-SEMANTIC-MATCH",
      label: "Mensagem diverge da mudanca real no diff",
      delta: -14,
      outcome: "fail",
    });
  }

  let recoverablePoints = 0;

  if (input.review != null) {
    for (const entry of input.review.entries) {
      if (entry.kind === "REVIEW") {
        if (entry.outcome === "UNAVAILABLE") {
          score -= 15;
          factors.push({
            id: entry.reason,
            label: `Avaliacao indisponivel (${entry.reason})`,
            delta: -15,
            outcome: "warn",
          });
        }
        continue;
      }

      if (entry.outcome === "FAIL") {
        const prob = entry.violationProbability ?? 0.85;
        const conf = entry.confidence ?? 0.85;
        const weight = entry.kind === "RULE" ? 26 : 16;
        const penalty = Math.max(8, Math.round(weight * (0.5 + 0.5 * prob * conf)));
        score -= penalty;
        const matchedRule = input.rules.find((r) => r.id === entry.id);
        if (matchedRule?.fixable) {
          recoverablePoints += penalty;
        }
        factors.push({
          id: entry.id,
          label: `${entry.id}: FAIL (${Math.round(prob * 100)}% prob · ${Math.round(conf * 100)}% conf)`,
          delta: -penalty,
          outcome: "fail",
        });
      } else if (entry.outcome === "WARN") {
        const penalty = entry.kind === "RULE" ? 8 : 5;
        score -= penalty;
        factors.push({
          id: entry.id,
          label: `${entry.id}: WARN`,
          delta: -penalty,
          outcome: "warn",
        });
      } else if (entry.outcome === "UNAVAILABLE") {
        score -= 10;
        factors.push({
          id: entry.id,
          label: `${entry.id}: UNAVAILABLE (${entry.reason ?? "PROVIDER"})`,
          delta: -10,
          outcome: "warn",
        });
      }
    }
  }

  const clampedScore = clampScore(score);
  const mode = input.review != null ? "semantic-verified" : "deterministic-filter";

  const projectedPostFixScore =
    recoverablePoints > 0 && input.hasVerifiedFix !== false
      ? clampScore(clampedScore + recoverablePoints)
      : null;

  return {
    score: clampedScore,
    projectedPostFixScore,
    grade: scoreToGrade(clampedScore),
    mode,
    filter,
    segments14: buildSegments14(clampedScore, factors),
    factors,
  };
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function scoreToGrade(score: number): "A" | "B" | "C" | "D" | "F" {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 65) return "C";
  if (score >= 50) return "D";
  return "F";
}

function buildSegments14(
  score: number,
  factors: readonly GitScoreFactor[],
): readonly TelemetrySegmentState[] {
  const filledCount = Math.max(1, Math.min(14, Math.round((score / 100) * 14)));
  const hasFail = factors.some((f) => f.outcome === "fail");
  const hasWarn = factors.some((f) => f.outcome === "warn");

  const segments: TelemetrySegmentState[] = [];
  for (let i = 0; i < 14; i += 1) {
    if (i >= filledCount) {
      segments.push("empty");
      continue;
    }
    if (hasFail && i >= Math.max(0, filledCount - 2)) {
      segments.push("fail");
      continue;
    }
    if ((hasWarn || hasFail) && i >= Math.max(0, filledCount - 3)) {
      segments.push("warn");
      continue;
    }
    segments.push("pass");
  }
  return segments;
}

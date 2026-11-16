import type { EvidenceClass, ParsedRule, TurnFile } from "../domain/types.ts";
import { DEFAULT_EVIDENCE_POLICY } from "./defaults.ts";
import {
  fileExtension,
  isSafeRelativeRepoPath,
  normalizePath,
  pathBasename,
  pathSegments,
} from "./paths.ts";
import { matchesRuleScope } from "./scope.ts";
import type { EvidencePolicy, PathSafety, ProtectedFixTargetClass } from "./types.ts";

const DENIED_SENSITIVE: PathSafety = { allowed: false, reason: "DENIED_SENSITIVE_PATH" };
const DENIED_EXTENSION: PathSafety = { allowed: false, reason: "EXTENSION_NOT_ALLOWED" };
const DENIED_UNSAFE: PathSafety = { allowed: false, reason: "UNSAFE_PATH" };

/**
 * Checks whether a path is safe and allowlisted to leave the machine.
 */
export function checkFilePath(
  path: string,
  policy: EvidencePolicy = DEFAULT_EVIDENCE_POLICY,
): PathSafety {
  if (!isSafeRelativeRepoPath(path)) {
    return DENIED_UNSAFE;
  }

  const basename = pathBasename(path).toLowerCase();
  if (matchesDeniedFileName(basename, policy)) {
    return DENIED_SENSITIVE;
  }

  const segments = pathSegments(path).map((seg) => seg.toLowerCase());
  if (segments.some((seg) => policy.deniedDirectoryNames.includes(seg))) {
    return DENIED_SENSITIVE;
  }

  const extension = fileExtension(path);
  if (policy.deniedExtensions.includes(extension)) {
    return DENIED_SENSITIVE;
  }

  if (!policy.codeExtensions.includes(extension) && !policy.docsExtensions.includes(extension)) {
    return DENIED_EXTENSION;
  }

  return { allowed: true };
}

export function matchesEvidenceClass(
  path: string,
  evidence: EvidenceClass,
  policy: EvidencePolicy = DEFAULT_EVIDENCE_POLICY,
): boolean {
  if (evidence === "any") {
    return true;
  }
  const extension = fileExtension(path);
  const isDoc = policy.docsExtensions.includes(extension);
  const isCode = policy.codeExtensions.includes(extension);

  if (!isDoc && !isCode) {
    // Unknown/denied paths remain retained so safety policy blocks them explicitly.
    return true;
  }

  return evidence === "docs" ? isDoc : isCode;
}

export function selectApplicableFiles(
  files: readonly TurnFile[],
  rule: Pick<ParsedRule, "scope" | "evidence">,
  policy: EvidencePolicy = DEFAULT_EVIDENCE_POLICY,
): readonly TurnFile[] {
  return files.filter((file) => {
    if (file.patch.trim() === "") {
      return false;
    }
    const inScope = rule.scope === null || matchesRuleScope(file.path, rule.scope);
    if (!inScope) {
      return false;
    }
    return matchesEvidenceClass(file.path, rule.evidence, policy);
  });
}

/**
 * Classifies protected targets that `--fix` may not modify unless explicitly opted in.
 */
export function classifyProtectedFixTarget(path: string): ProtectedFixTargetClass {
  const normalized = normalizePath(path).toLowerCase();
  const segments = pathSegments(normalized);
  const base = pathBasename(normalized);

  if (
    segments.includes(".github") &&
    (segments.includes("workflows") || segments.includes("actions"))
  ) {
    return "WORKFLOW";
  }

  if (
    segments.some((s) => s === "test" || s === "tests" || s === "__tests__") ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(base) ||
    /_test\.(rs|go|py)$/.test(base) ||
    /^test_.*\.py$/.test(base)
  ) {
    return "TEST";
  }

  if (
    base === "package.json" ||
    base === "pnpm-lock.yaml" ||
    base === "package-lock.json" ||
    base === "yarn.lock" ||
    base === "cargo.toml" ||
    base === "cargo.lock" ||
    base === "pyproject.toml" ||
    base === "requirements.txt" ||
    base === "go.mod" ||
    base === "go.sum"
  ) {
    return "DEPENDENCY";
  }

  if (
    segments.includes(".ikigai") ||
    segments.includes(".jev") ||
    base.startsWith("tsconfig") ||
    base === "biome.json" ||
    base === "biome.jsonc" ||
    base.endsWith(".config.ts") ||
    base.endsWith(".config.js") ||
    base.endsWith(".config.mjs") ||
    base.endsWith(".config.cjs") ||
    base.endsWith(".yaml") ||
    base.endsWith(".yml") ||
    base.endsWith(".toml")
  ) {
    return "CONFIG";
  }

  return "NONE";
}

function matchesDeniedFileName(basename: string, policy: EvidencePolicy): boolean {
  return policy.deniedFileNames.some((name) =>
    name.startsWith(".") ? basename === name || basename.startsWith(`${name}.`) : basename === name,
  );
}

import type { EvidenceClass, ParsedRule, RuleScope, RuleSeverity } from "../domain/types.ts";
import type {
  ParsedRuleMetadata,
  RawRuleBlock,
  RuleCandidateResult,
  RuleParseErrorCode,
} from "./types.ts";

const RULE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Parses all `## <RULE-ID>` blocks in a rules document in source order.
 * Invalid blocks fail individually without suppressing valid siblings.
 */
export function parseRules(text: string): readonly RuleCandidateResult[] {
  const blocks = collectRuleBlocks(text);
  if (blocks.length === 0) {
    return [invalid(null, "MISSING_ID", "No `## <RULE-ID>` rule headings found.")];
  }

  const duplicates = findDuplicateIds(blocks.map((block) => block.id));
  return blocks.map((block) => parseRuleBlock(block, duplicates.has(block.id)));
}

function collectRuleBlocks(text: string): readonly RawRuleBlock[] {
  const lines = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .split("\n");
  const blocks: RawRuleBlock[] = [];
  let currentId: string | null = null;
  let currentLines: string[] = [];

  for (const line of lines) {
    const match = /^##\s+(.*)$/.exec(line);
    if (match !== null) {
      if (currentId !== null) {
        blocks.push({ id: currentId, lines: currentLines });
      }
      currentId = (match[1] ?? "").trim();
      currentLines = [];
      continue;
    }

    if (currentId !== null) {
      currentLines.push(line);
    }
  }

  if (currentId !== null) {
    blocks.push({ id: currentId, lines: currentLines });
  }

  return blocks;
}

function findDuplicateIds(ids: readonly string[]): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const id of ids) {
    if (!RULE_ID_PATTERN.test(id)) {
      continue;
    }
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  const duplicates = new Set<string>();
  for (const [id, count] of counts) {
    if (count > 1) {
      duplicates.add(id);
    }
  }
  return duplicates;
}

function parseRuleBlock(block: RawRuleBlock, isDuplicate: boolean): RuleCandidateResult {
  if (block.id === "") {
    return invalid(null, "MISSING_ID", "Rule heading is missing an ID.");
  }

  if (!RULE_ID_PATTERN.test(block.id)) {
    return invalid(block.id, "INVALID_ID", `Rule ID "${block.id}" contains invalid characters.`);
  }

  if (isDuplicate) {
    return invalid(block.id, "DUPLICATE_ID", `Rule ID "${block.id}" appears more than once.`);
  }

  const firstSectionIndex = block.lines.findIndex((line) => /^###\s+/.test(line));
  const metadataLines =
    firstSectionIndex === -1 ? block.lines : block.lines.slice(0, firstSectionIndex);
  const sectionLines = firstSectionIndex === -1 ? [] : block.lines.slice(firstSectionIndex);

  const meta = parseMetadata(block.id, metadataLines);
  if ("status" in meta) {
    return meta;
  }

  const sections = parseSections(block.id, sectionLines);
  if ("status" in sections) {
    return sections;
  }

  const scope: RuleScope | null = meta.hasScope
    ? { include: meta.scopeInclude, exclude: meta.scopeExclude }
    : null;

  const rule: ParsedRule = {
    id: block.id,
    severity: meta.severity,
    scope,
    evidence: meta.evidence,
    fixable: meta.fixable,
    description: sections.rule,
    violation: sections.violation,
    allowed: sections.allowed,
    fixHint: sections.fixHint,
  };

  return { status: "PARSED", rule };
}

function parseMetadata(
  id: string,
  lines: readonly string[],
): ParsedRuleMetadata | RuleCandidateResult {
  let severity: RuleSeverity | null = null;
  let evidence: EvidenceClass | null = null;
  let fixable: boolean | null = null;
  let hasScope = false;
  const scopeInclude: string[] = [];
  const scopeExclude: string[] = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed === "") {
      continue;
    }

    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) {
      return invalid(id, "INVALID_METADATA", `Expected \`key: value\`, got "${trimmed}".`);
    }

    const key = trimmed.slice(0, colonIndex).trim();
    const value = trimmed.slice(colonIndex + 1).trim();

    if (key === "severity") {
      if (severity !== null) {
        return invalid(id, "INVALID_METADATA", "Duplicate `severity` key.");
      }
      if (value !== "error" && value !== "warning") {
        return invalid(id, "INVALID_SEVERITY", `Invalid severity "${value}".`);
      }
      severity = value;
      continue;
    }

    if (key === "scope") {
      if (value === "") {
        return invalid(id, "INVALID_SCOPE", "Empty `scope:` value is not allowed.");
      }
      hasScope = true;
      if (value.startsWith("!")) {
        const pattern = value.slice(1).trim();
        if (pattern === "") {
          return invalid(id, "INVALID_SCOPE", "Empty exclusion `scope:` value.");
        }
        scopeExclude.push(pattern);
      } else {
        scopeInclude.push(value);
      }
      continue;
    }

    if (key === "evidence") {
      if (evidence !== null) {
        return invalid(id, "INVALID_METADATA", "Duplicate `evidence` key.");
      }
      if (value !== "code" && value !== "docs" && value !== "any") {
        return invalid(id, "INVALID_EVIDENCE", `Invalid evidence "${value}".`);
      }
      evidence = value;
      continue;
    }

    if (key === "fixable") {
      if (fixable !== null) {
        return invalid(id, "INVALID_METADATA", "Duplicate `fixable` key.");
      }
      if (value !== "true" && value !== "false") {
        return invalid(id, "INVALID_FIXABLE", `Invalid fixable value "${value}".`);
      }
      fixable = value === "true";
      continue;
    }

    return invalid(id, "INVALID_METADATA", `Unknown metadata key "${key}".`);
  }

  if (severity === null) {
    return invalid(id, "MISSING_SEVERITY", "Missing required `severity` metadata.");
  }

  if (hasScope && scopeInclude.length === 0) {
    return invalid(id, "INVALID_SCOPE", "`scope:` declared without any inclusion pattern.");
  }

  return {
    severity,
    scopeInclude,
    scopeExclude,
    hasScope,
    evidence: evidence ?? "code",
    fixable: fixable ?? false,
  };
}

interface ParsedSections {
  readonly rule: string;
  readonly violation: string;
  readonly allowed: string | null;
  readonly fixHint: string | null;
}

function parseSections(id: string, lines: readonly string[]): ParsedSections | RuleCandidateResult {
  const seen = new Map<string, string>();
  let currentHeading: string | null = null;
  let currentBuffer: string[] = [];

  const flush = (): RuleCandidateResult | null => {
    if (currentHeading === null) {
      return null;
    }
    const content = currentBuffer.join("\n").trim();
    if (content === "") {
      return invalid(id, "EMPTY_SECTION", `Section \`### ${currentHeading}\` cannot be empty.`);
    }
    seen.set(currentHeading, content);
    return null;
  };

  for (const line of lines) {
    const match = /^###\s+(.*)$/.exec(line);
    if (match !== null) {
      const err = flush();
      if (err !== null) {
        return err;
      }
      const heading = (match[1] ?? "").trim();
      if (
        heading !== "Rule" &&
        heading !== "Violation" &&
        heading !== "Allowed" &&
        heading !== "FixHint"
      ) {
        return invalid(id, "UNKNOWN_SECTION", `Unknown section \`### ${heading}\`.`);
      }
      if (seen.has(heading)) {
        return invalid(id, "DUPLICATE_SECTION", `Duplicate section \`### ${heading}\`.`);
      }
      currentHeading = heading;
      currentBuffer = [];
      continue;
    }

    if (currentHeading !== null) {
      currentBuffer.push(line);
    }
  }

  const trailingError = flush();
  if (trailingError !== null) {
    return trailingError;
  }

  const rule = seen.get("Rule");
  if (rule === undefined) {
    return invalid(id, "MISSING_RULE", "Missing required `### Rule` section.");
  }

  const violation = seen.get("Violation");
  if (violation === undefined) {
    return invalid(id, "MISSING_VIOLATION", "Missing required `### Violation` section.");
  }

  const allowed = seen.get("Allowed") ?? null;
  if (allowed !== null && allowed === violation) {
    return invalid(id, "INVALID_ALLOWED", "`### Allowed` must differ from `### Violation`.");
  }

  return {
    rule,
    violation,
    allowed,
    fixHint: seen.get("FixHint") ?? null,
  };
}

function invalid(id: string | null, code: RuleParseErrorCode, reason: string): RuleCandidateResult {
  return { status: "INVALID", id, code, reason };
}

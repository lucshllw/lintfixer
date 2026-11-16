import type { BuiltInCheckId, RuleSeverity } from "../domain/types.ts";
import type { BuiltInBatchItem } from "../ports/types.ts";

export interface BuiltInDefinition {
  readonly id: BuiltInCheckId;
  readonly severity: RuleSeverity;
  readonly warnThreshold: number;
  readonly failThreshold: number | null;
  readonly item: BuiltInBatchItem;
}

export const BUILT_IN_DEFINITIONS: readonly BuiltInDefinition[] = [
  {
    id: "SCOPE-CREEP",
    severity: "error",
    warnThreshold: 0.65,
    failThreshold: 0.9,
    item: {
      checkId: "SCOPE-CREEP",
      ruleSummary:
        "Changes must stay bounded to what the task requested and supporting edits reasonably necessary to complete it.",
      violationCriteria:
        "Material functional, behavioral, architectural, dependency, configuration, or refactoring work unrelated to the task.",
      allowedCriteria:
        "Requested work, necessary tests, documentation directly needed for the task, and immaterial incidental edits.",
    },
  },
  {
    id: "COMPLEXITY",
    severity: "warning",
    warnThreshold: 0.5,
    failThreshold: null,
    item: {
      checkId: "COMPLEXITY",
      ruleSummary:
        "Complexity introduced by the change must remain proportional to the problem being solved.",
      violationCriteria:
        "Unnecessary abstractions, indirection layers without proportional gain, premature generalization, or excessive config/dependencies.",
      allowedCriteria:
        "Complexity explicitly required by the task, error handling, validation, tests, or adherence to an existing codebase abstraction.",
    },
  },
  {
    id: "TEST-ADEQUACY",
    severity: "warning",
    warnThreshold: 0.6,
    failThreshold: null,
    item: {
      checkId: "TEST-ADEQUACY",
      ruleSummary:
        "Behavioral and bug-fix code changes must arrive with proportional automated tests covering the changed contract.",
      violationCriteria:
        "Non-trivial behavioral logic, edge-case handling, or bug fixes added or changed with zero corresponding unit/integration tests or tautological assertions.",
      allowedCriteria:
        "Pure documentation/comment changes, pure formatting, type-only refactors, or behavior changes accompanied by meaningful assertions.",
    },
  },
];

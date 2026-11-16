# Glossary

## Review Unit
A bounded unit of code change evaluated together with its stated intent (`task` or commit/PR metadata) and the attributed diff.

## Policy Rule
A named, repository-versioned constraint or convention with a `severity`, optional path `scope`, `evidence` class, `fixable` permission, normative `Rule`, `Violation` condition, optional `Allowed` exception, and optional `FixHint`.

## Built-in Check
A product-owned semantic check (`SCOPE-CREEP`, `COMPLEXITY`, `TEST-ADEQUACY`) evaluated over the safe attributed change independently of repository rules.

## Evidence Slice
A complete, non-truncated segment of a scoped diff (`WHOLE`, `FILE`, or `HUNK` with file preamble) produced after path safety and secret redaction checks pass.

## Semantic Judgment
A probabilistic, evidence-grounded signal produced for one `(check, slice)` pair containing `violationProbability`, `confidence`, literal `evidenceHunk`, and a short `rationale`. It never chooses the policy outcome.

## Policy Gate
The deterministic local rule that converts slice judgments into `PASS`, `WARN`, `FAIL`, `SKIPPED`, or `UNAVAILABLE` using versioned thresholds, slice aggregation mode, confidence floor, and literal evidence verification.

## Fix Proposal
A candidate unified diff generated exclusively for `FAIL` findings, constrained to tracked, non-protected files within the failing hunks, and never written to disk unless verified.

## Commit Guard
A verification combining commit-message semantic honesty against the staged diff with repository policy evaluation.

## PR Verdict
The deterministic GitHub pull-request review action (`APPROVE`, `REQUEST_CHANGES`, or `COMMENT`) and line-anchored hunk comments derived from a `Review Unit` and repository policy.

## Calibration Corpus
A labeled set of review fixtures (`VIOLATION` / `NO_VIOLATION`) used to measure confusion metrics, Expected Calibration Error (ECE), Brier score, repeat `flipRate`, aggregation modes, and candidate `Allowed` refinements.

## Memory Event
A schema-versioned, redacted, project-scoped audit record emitted after a review, fix, or human feedback action so a future memory graph can consume policy history without reading raw secrets or unredacted diffs.

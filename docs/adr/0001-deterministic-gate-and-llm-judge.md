# ADR 0001: Deterministic Policy Gate and Evidence-Grounded LLM Judge

- **Status:** Accepted
- **Date:** 2026-11-16

## Context
Unlike JevGuard (which depended on TypeSafe's `Jev` Noul SDK), Ikigai uses general-purpose LLMs (OpenAI, Gemini, Claude via API or read-only local CLIs). General LLMs tend to drift between runs, hallucinate code citations, or overrule repository thresholds if asked directly for `PASS`/`FAIL`.

## Decision
Every provider adapter returns a strict JSON object (`violationProbability` in `[0,1]`, `confidence` in `[0,1]`, `evidenceHunk` `{ file, startLine, endLine, quote }`, and `rationale <= 240`). Core verifies `evidenceHunk.quote` literally inside the slice diff, routes low-confidence outputs to `WARN`, supports configurable slice aggregation (`max`, `topKMean`, `noisyOr`), and owns the deterministic `PASS`/`WARN`/`FAIL` thresholds.

## Consequences
- Threshold tuning, slice aggregation experiments, and calibration (ECE/Brier) run offline over stored scores without re-calling APIs.
- Hallucinated citations cannot force a `FAIL` verdict.

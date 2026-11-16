# Ikigai Specification (Phase 1)

## 1. Purpose
Ikigai is a semantic policy engine, verified auto-fixer, commit guard, and GitHub PR review bot for coding agents and human teams. It separates **probabilistic LLM judgment** from **deterministic local policy, safety, patching, calibration, and PR verdicts**, while emitting versioned `MemoryEventV1` records ready for Phase 2 (Project Memory & Graph).

## 2. Core Invariants
1. **Zero-I/O `core`:** `packages/core` imports no `node:*` runtime modules, filesystem APIs, HTTP clients, or external provider SDKs.
2. **Evidence completeness & fail-closed safety:** Denied sensitive files (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `.ssh/`, `.aws/`, etc.) and unredacted critical secrets abort rule/built-in evaluation as `UNAVAILABLE` (`BLOCKED_EVIDENCE` or `UNREDACTED_SECRET`). Oversized diffs slice deterministically (`WHOLE` -> `FILE` -> `HUNK`); nothing is silently truncated.
3. **Anti-prompt injection:** Untrusted text (PR title/body, commit messages, diff hunks, user rules) travels inside random per-run nonce boundaries with role-marker neutralization. PR rules in CI are read exclusively from the protected `base_ref`.
4. **LLM never decides outcome:** Providers return strict schema-validated JSON (`violationProbability`, `confidence`, `evidenceHunk`, `rationale`). `evidenceHunk.quote` is verified literally against the slice diff; ungrounded judgments are downgraded or rejected. Local gates decide `PASS`, `WARN`, or `FAIL`.
5. **No silent provider fallback:** Model, provider, token usage, and latency are recorded explicitly on every call; missing or failing providers surface typed errors.
6. **Safe `--fix`:** Fixes run only for `FAIL` findings on `fixable` rules, validate paths via `realpathSync` inside `repoRoot`, block edits to tests/lockfiles/deps/CI workflows/configs unless explicitly overridden, verify line context before applying, run post-fix checks + Stage 1 re-evaluation, and roll back automatically on failure.
7. **Safe PR Bot:** Runs on `pull_request` (never `pull_request_target` executing fork code), restricts fork PRs to `COMMENT`, and never emits `APPROVE` if any check is `FAIL` or `UNAVAILABLE`.
8. **Built-in semantic checks:** `SCOPE-CREEP`, `COMPLEXITY`, and `TEST-ADEQUACY`.
9. **Calibration beyond binary accuracy:** Tracks Confusion Matrix, Precision/Recall/F1, Brier Score, 10-bin ECE, repeat `flipRate`, aggregation comparison (`max` vs `topKMean` vs `noisyOr`), and clusters false positives to suggest `### Allowed` rule refinements.

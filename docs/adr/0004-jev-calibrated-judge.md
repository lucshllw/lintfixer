# ADR 0004: Calibrated System-1 Judge (`jev`), Hybrid Tie-Breaker, and Sealed `llm.jev` Vault

- **Status:** Accepted
- **Date:** 2026-11-17

## Context
Running generative LLMs directly as binary/probabilistic judges on every PR introduces latency, cost, and calibration variance (especially on smaller models returning high-confidence false positives on rule-allowed changes). Meanwhile, preliminary benchmark findings (`BENCHMARK-JEV.md`) also surfaced:
1. LLM CLI mode (`claude -p`, `codex`) dropped built-in batch responses when `buildBuiltInBatchUserPrompt` omitted explicit per-check JSON keys (`"SCOPE-CREEP"`, `"COMPLEXITY"`, `"TEST-ADEQUACY"`).
2. `jev` (`jev-latest` via TypeSafe System-1) achieves zero repeat variance and high precision, but cannot author prose reviews or code patches (`JEV_CANNOT_FIX`), and needed an optional LLM tie-breaker for borderline scores (`0.40–0.70`) plus seamless integration with LintFixer's zero-native-dependency encrypted vault.

## Decision
1. **Prompt Envelope Fix:** `buildBuiltInBatchUserPrompt` explicitly requires top-level keys `"SCOPE-CREEP"`, `"COMPLEXITY"`, and `"TEST-ADEQUACY"` so CLI runners return valid structured judgments without relying exclusively on API `responseJsonSchema`.
2. **First-Class `jev` Judge & `JEV_CANNOT_FIX` Guard:** `ProviderKind` accepts `"jev"` via a pure-`fetch` `/v1/systemone` adapter (`jev-provider.ts`) anchored to inspected diff hunks, with zero extra C++/keyring native runtime dependencies (`@napi-rs/keyring` omitted). Configuring or invoking `jev` as patch fixer fails closed with `JEV_CANNOT_FIX`.
3. **Optional Hybrid Tie-Breaker (`0.40–0.70`):** When `providers.tieBreaker` is configured in `.ikigai/config.yaml`, borderline primary judgments inside `shouldInvokeTieBreaker()` automatically escalate that slice/check to the tie-breaker endpoint (e.g., Claude Sonnet) and re-run literal `evidenceHunk` grounding before final gate resolution.
4. **Unified Encrypted Vault (`llm.jev`):** `TYPESAFE_API_KEY` is sealed locally under `llm.jev` inside LintFixer's AES-256-GCM + Windows DPAPI (`CurrentUser`) vault, surfaced directly in `lintfixer vault`, CLI `doctor`/`login`, and the Desktop UI bootstrap check (`hasJudgeCredential`).

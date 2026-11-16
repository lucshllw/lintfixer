# ADR 0003: Safe Two-Stage Patch Verification and Fork-Safe PR Bot

- **Status:** Accepted
- **Date:** 2026-11-16

## Context
Adding automatic code fixes (`--fix`) and autonomous GitHub PR approvals/rejections raises blast-radius risks: prompt injection in fork PRs, unsafe mutations to tests/dependencies/CI configs, and unverified patches that break builds or leave violations unresolved.

## Decision
1. `--fix` uses a separate strong-model stage receiving only failing hunks, validates unified diffs in `core`, blocks protected target classes (tests, lockfiles, manifests, workflows, configs) by default, checks `realpathSync` inside `repoRoot`, runs verification commands plus Stage-1 semantic re-check, and automatically restores snapshots on failure.
2. GitHub PR reviews read `.ikigai/rules.md` exclusively from `base_ref`, never run untrusted fork code under elevated tokens, restrict fork PRs to `COMMENT`, and forbid `APPROVE` whenever any rule or built-in is `FAIL` or `UNAVAILABLE`.

## Consequences
- Auto-fix cannot silently weaken tests to make a rule pass.
- Untrusted PR authors cannot rewrite `.ikigai/rules.md` in their own PR to bypass checks.

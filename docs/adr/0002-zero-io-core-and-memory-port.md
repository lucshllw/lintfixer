# ADR 0002: Zero-I/O Core and Phase-2 MemoryPort Contract

- **Status:** Accepted
- **Date:** 2026-11-16

## Context
Phase 1 focuses on semantic linting, verified fixes, commit checks, and GitHub PR reviews. Phase 2 will introduce a persistent engineering-decision memory and component graph (inspired by `xemnas`). Coupling I/O or memory storage directly into the linter now would complicate testing and force a rewrite later.

## Decision
`packages/core` stays 100% pure (zero `node:*` imports, enforced by an automated architecture test) and defines a `MemoryPort` seam emitting redacted, project-scoped `MemoryEventV1` records (`schemaVersion`, `projectScope`, `redacted: true`, `classification`, `ttlDays`). Phase 1 provides a bounded JSONL outbox/no-op adapter.

## Consequences
- Every rule review, `--fix` outcome, and human false-positive feedback already produces clean structured events ready for a future graph/memory engine.
- Core logic runs deterministically in unit tests without network, disk, or provider secrets.

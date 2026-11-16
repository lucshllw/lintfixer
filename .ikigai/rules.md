# Ikigai Repository Policy

## ARCH-001

severity: error
scope: packages/core/**
evidence: code
fixable: true

### Rule

`packages/core` must remain pure domain and evaluation logic with zero Node built-in, filesystem, network, or provider SDK imports.

### Violation

Importing `node:*`, `fs`, `child_process`, HTTP clients, or adapter packages inside `packages/core`.

### Allowed

Pure TypeScript modules, `@ikigai/core` internal imports, and schema validation libraries declared in core.

## SEC-001

severity: error
scope: packages/**
evidence: code
fixable: false

### Rule

Secrets, credentials, raw tokens, and denied sensitive files must never be logged, serialized into history, or sent unredacted to external providers.

### Violation

Sending unredacted credentials/tokens to LLM prompts, logging env secrets, or allowing `--fix` to modify `.env`, keys, tests, lockfiles, or CI workflows without explicit opt-in.

### Allowed

Redacted placeholders `[REDACTED:<type>:<hash8>]` and synthetic test fixtures clearly marked as non-secret test inputs.

## TEST-001

severity: error
scope: packages/**
evidence: code
fixable: false

### Rule

Behavioral changes to parsing, gates, redaction, patching, calibration, commit checks, or PR verdicts must include deterministic unit or contract tests.

### Violation

Modifying core decision logic or security guards without matching automated tests.

### Allowed

Documentation-only edits and type-only refactoring covered by existing behavior tests.

import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY_CONFIG, parsePolicyConfig, parseRules } from "@ikigai/core";

describe("parseRules", () => {
  it("parses valid rules with scope exclusions, evidence class, fixable flag, and FixHint", () => {
    const md = `
## ARCH-001

severity: error
scope: packages/core/**
scope: !packages/core/test/**
evidence: code
fixable: true

### Rule
Core must stay pure.

### Violation
Importing node:fs inside core.

### Allowed
Pure TypeScript utilities.

### FixHint
Extract I/O behind a port interface.

## DOC-001

severity: warning
evidence: docs

### Rule
Keep docs clear.

### Violation
Missing summary.
`;

    const results = parseRules(md);
    expect(results).toHaveLength(2);
    expect(results[0]?.status).toBe("PARSED");
    if (results[0]?.status === "PARSED") {
      expect(results[0].rule.fixable).toBe(true);
      expect(results[0].rule.scope).toEqual({
        include: ["packages/core/**"],
        exclude: ["packages/core/test/**"],
      });
      expect(results[0].rule.fixHint).toBe("Extract I/O behind a port interface.");
    }
    expect(results[1]?.status).toBe("PARSED");
  });

  it("isolates invalid and duplicate rule blocks without dropping valid siblings", () => {
    const md = `
## DUP-1
severity: error
### Rule
A
### Violation
B

## DUP-1
severity: error
### Rule
C
### Violation
D

## VALID-1
severity: warning
### Rule
Keep clean.
### Violation
Dirty code.
`;
    const results = parseRules(md);
    expect(results).toHaveLength(3);
    expect(results[0]?.status).toBe("INVALID");
    expect(results[1]?.status).toBe("INVALID");
    expect(results[2]?.status).toBe("PARSED");
  });
});

describe("parsePolicyConfig", () => {
  it("returns defaults when config is null or empty", () => {
    const res = parsePolicyConfig(null);
    expect(res.status).toBe("PARSED");
    if (res.status === "PARSED") {
      expect(res.config).toEqual(DEFAULT_POLICY_CONFIG);
    }
  });

  it("rejects warn >= fail and rejects YAML anchors", () => {
    const badThresholds = `
version: 1
thresholds:
  error:
    warn: 0.8
    fail: 0.7
`;
    expect(parsePolicyConfig(badThresholds).status).toBe("INVALID");

    const anchored = `
version: 1
base: &ref
  warn: 0.4
`;
    expect(parsePolicyConfig(anchored).status).toBe("INVALID");
  });

  it("supports jev judge + tieBreaker config and rejects jev as fixer with JEV_CANNOT_FIX", () => {
    const validHybrid = `
version: 1
providers:
  judge:
    provider: jev
    model: jev-latest
    mode: api
  tieBreaker:
    provider: claude
    model: claude-sonnet-5-5
    mode: api
  fixer:
    provider: gemini
    model: gemini-2.5-flash
    mode: api
`;
    const parsed = parsePolicyConfig(validHybrid);
    expect(parsed.status).toBe("PARSED");
    if (parsed.status === "PARSED") {
      expect(parsed.config.providers.judge.provider).toBe("jev");
      expect(parsed.config.providers.tieBreaker?.provider).toBe("claude");
    }

    const illegalFixer = `
version: 1
providers:
  judge:
    provider: jev
    model: jev-latest
    mode: api
  fixer:
    provider: jev
    model: jev-latest
    mode: api
`;
    const rejected = parsePolicyConfig(illegalFixer);
    expect(rejected.status).toBe("INVALID");
    if (rejected.status === "INVALID") {
      expect(rejected.message).toContain("JEV_CANNOT_FIX");
    }
  });
});

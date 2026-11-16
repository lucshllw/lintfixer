import { describe, expect, it } from "vitest";
import {
  checkFilePath,
  classifyProtectedFixTarget,
  parseUnifiedDiff,
  planRuleEvidence,
  redactSecrets,
} from "@ikigai/core";
import { DEFAULT_POLICY_CONFIG } from "@ikigai/core";

describe("parseUnifiedDiff & redaction", () => {
  it("parses valid git diff including CRLF and rejects truncated or traversal diffs", () => {
    const valid = [
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,2 +1,3 @@",
      " export const a = 1;",
      "+export const b = 2;",
      " export const c = 3;",
    ].join("\r\n");

    const parsed = parseUnifiedDiff(`\uFEFF${valid}`);
    expect(parsed.status).toBe("PARSED");
    if (parsed.status === "PARSED") {
      expect(parsed.files).toHaveLength(1);
      expect(parsed.files[0]?.path).toBe("src/app.ts");
    }

    const truncated =
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n+x\n";
    expect(parseUnifiedDiff(truncated)).toEqual({ status: "INVALID", reason: "TRUNCATED_HUNK" });

    const traversal = [
      "diff --git a/../secret.ts b/../secret.ts",
      "--- a/../secret.ts",
      "+++ b/../secret.ts",
      "@@ -1,1 +1,1 @@",
      "-a",
      "+b",
    ].join("\n");
    expect(parseUnifiedDiff(traversal)).toEqual({ status: "INVALID", reason: "UNSAFE_PATH" });
  });

  it("redacts API keys, GitHub tokens, and URI passwords deterministically", () => {
    const sample =
      "const k = 'sk-proj-abcdefghijklmnopqrstuvwxyz123456'; const gh = 'ghp_1234567890abcdefghijklmnop'; const db = 'postgres://admin:supersecretpass@db.internal:5432/app';";
    const res = redactSecrets(sample);
    expect(res.redactionCount).toBe(3);
    expect(res.hasCriticalUnredacted).toBe(false);
    expect(res.text).not.toContain("supersecretpass");
    expect(res.text).toContain("[REDACTED:OPENAI_KEY:");
    expect(res.text).toContain("[REDACTED:GITHUB_TOKEN:");
    expect(res.text).toContain("[REDACTED:URI_CRED:");
  });

  it("blocks sensitive paths and classifies protected fix targets", () => {
    expect(checkFilePath(".env.local").allowed).toBe(false);
    expect(checkFilePath(".ssh/id_rsa").allowed).toBe(false);
    expect(checkFilePath("src/index.ts").allowed).toBe(true);

    expect(classifyProtectedFixTarget("packages/core/test/rules.test.ts")).toBe("TEST");
    expect(classifyProtectedFixTarget("package.json")).toBe("DEPENDENCY");
    expect(classifyProtectedFixTarget(".github/workflows/ci.yml")).toBe("WORKFLOW");
    expect(classifyProtectedFixTarget("biome.json")).toBe("CONFIG");
    expect(classifyProtectedFixTarget("packages/core/src/rules/parse-rules.ts")).toBe("NONE");
  });

  it("slices oversized file diffs by hunk without truncation", () => {
    const longLineA = `+const a = '${"x".repeat(450)}';`;
    const longLineB = `+const b = '${"y".repeat(450)}';`;
    const patch = [
      "diff --git a/src/big.ts b/src/big.ts",
      "--- a/src/big.ts",
      "+++ b/src/big.ts",
      "@@ -1,1 +1,2 @@",
      " const start = 0;",
      longLineA,
      "@@ -100,1 +101,2 @@",
      " const mid = 1;",
      longLineB,
    ].join("\n");

    const plan = planRuleEvidence(
      { id: "t1", task: "update", files: [{ path: "src/big.ts", patch }], source: "cli" },
      {
        id: "R1",
        severity: "error",
        scope: null,
        evidence: "code",
        fixable: false,
        description: "desc",
        violation: "viol",
        allowed: null,
        fixHint: null,
      },
      { ...DEFAULT_POLICY_CONFIG.slicing, maxDiffLength: 600 },
    );

    expect(plan.status).toBe("PLANNED");
    if (plan.status === "PLANNED") {
      expect(plan.slices).toHaveLength(2);
      expect(plan.slices[0]?.kind).toBe("HUNK");
      expect(plan.slices[0]?.diff).toContain("diff --git a/src/big.ts");
      expect(plan.slices[1]?.diff).toContain(longLineB);
    }
  });
});

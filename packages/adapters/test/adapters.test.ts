import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createGitHubRestClient,
  createLocalHistoryStore,
  createMemoryOutbox,
  createMultiProvider,
  createSafePatchApplier,
  saveCredential,
} from "@ikigai/adapters";
import type { MemoryEventV1, PrReviewPlan } from "@ikigai/core";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("adapters", () => {
  it("routes OpenAI and Gemini structured judge responses and fails explicitly without credential", async () => {
    const dir = makeTempDir("ikigai-cred-");
    const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: dir };

    const providerNoKey = createMultiProvider({
      workingDir: dir,
      env,
    });

    const missingRes = await providerNoKey.judgeRuleSlice({
      kind: "RULE",
      checkId: "ARCH-001",
      ruleSummary: "R",
      violationCriteria: "V",
      allowedCriteria: null,
      task: "T",
      files: ["a.ts"],
      diff: "+const a = 1;",
      nonce: "n1",
      endpoint: { provider: "openai", model: "gpt-5-mini", mode: "api" },
    });
    expect(missingRes.status).toBe("FAILED");
    if (missingRes.status === "FAILED") {
      expect(missingRes.errorCode).toBe("MISSING_CREDENTIAL");
    }

    saveCredential("openai", "sk-test-1234567890abcdefghij", env);

    const fakeFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  violationProbability: 0.82,
                  confidence: 0.91,
                  evidenceHunk: {
                    file: "src/a.ts",
                    startLine: 1,
                    endLine: 2,
                    quote: "const a = 1;",
                  },
                  rationale: "Direct rule breach.",
                }),
              },
            },
          ],
          usage: { prompt_tokens: 120, completion_tokens: 30 },
        }),
        { status: 200 },
      );

    const provider = createMultiProvider({
      workingDir: dir,
      env,
      fetchImpl: fakeFetch,
    });

    const okRes = await provider.judgeRuleSlice({
      kind: "RULE",
      checkId: "ARCH-001",
      ruleSummary: "R",
      violationCriteria: "V",
      allowedCriteria: null,
      task: "T",
      files: ["src/a.ts"],
      diff: "+const a = 1;",
      nonce: "n1",
      endpoint: { provider: "openai", model: "gpt-5-mini", mode: "api" },
    });

    expect(okRes.status).toBe("OK");
    if (okRes.status === "OK") {
      expect(okRes.judgment.violationProbability).toBe(0.82);
      expect(okRes.telemetry.inputTokens).toBe(120);
      expect(okRes.telemetry.modelId).toBe("gpt-5-mini");
    }

    saveCredential("gemini", "AIzaSyTestFakeKey123456789012345678901", env);
    let capturedGeminiUrl = "";
    let capturedGeminiHeaderKey = "";
    let capturedBodyText = "";

    const geminiFetch: typeof fetch = async (input, init) => {
      capturedGeminiUrl = typeof input === "string" ? input : input.toString();
      const hdrs = new Headers(init?.headers);
      capturedGeminiHeaderKey = hdrs.get("x-goog-api-key") ?? "";
      capturedBodyText = typeof init?.body === "string" ? init.body : "";
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      violationProbability: 0.91,
                      confidence: 0.94,
                      evidenceHunk: {
                        file: "src/a.ts",
                        startLine: 1,
                        endLine: 1,
                        quote: "const a = 1;",
                      },
                      rationale: "Violation detected via Gemini.",
                    }),
                  },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 95, candidatesTokenCount: 28 },
        }),
        { status: 200 },
      );
    };

    const geminiProvider = createMultiProvider({
      workingDir: dir,
      env,
      fetchImpl: geminiFetch,
    });

    const gemRes = await geminiProvider.judgeRuleSlice({
      kind: "RULE",
      checkId: "ARCH-001",
      ruleSummary: "R",
      violationCriteria: "V",
      allowedCriteria: null,
      task: "T",
      files: ["src/a.ts"],
      diff: "+const a = 1;",
      nonce: "n1",
      endpoint: { provider: "gemini", model: "gemini-4-hydrogen", mode: "api" },
    });

    expect(gemRes.status).toBe("OK");
    expect(capturedGeminiUrl).not.toContain("AIza");
    expect(capturedGeminiHeaderKey).toBe("AIzaSyTestFakeKey123456789012345678901");
    expect(capturedBodyText).toContain("responseJsonSchema");
  });

  it("confines patch application inside repoRoot and supports exact rollback", async () => {
    const repo = makeTempDir("ikigai-patch-");
    mkdirSync(join(repo, "src"), { recursive: true });
    const targetFile = join(repo, "src", "app.ts");
    writeFileSync(targetFile, "export const x = 1;\n", "utf8");

    const applier = createSafePatchApplier(repo);
    const readBack = await applier.readTargetFiles(["src/app.ts", "../outside.ts"]);
    expect(readBack.has("src/app.ts")).toBe(true);
    expect(readBack.has("../outside.ts")).toBe(false);

    const handle = await applier.applyValidatedPatch(
      new Map([["src/app.ts", "export const x = 2;\n"]]),
    );
    expect(readFileSync(targetFile, "utf8")).toBe("export const x = 2;\n");

    await handle.rollback();
    expect(readFileSync(targetFile, "utf8")).toBe("export const x = 1;\n");
  });

  it("persists reviews.jsonl and memory-events.jsonl cleanly", async () => {
    const dataDir = makeTempDir("ikigai-data-");
    const history = createLocalHistoryStore(dataDir);
    await history.appendReview({
      timestamp: "2026-11-16T12:00:00.000Z",
      turnId: "t1",
      aggregateOutcome: "PASS",
      counts: { pass: 1, warn: 0, fail: 0, skipped: 0, unavailable: 0 },
      results: [],
    });

    const reviews = await history.readReviews();
    expect(reviews).toHaveLength(1);

    const memory = createMemoryOutbox(dataDir);
    const event: MemoryEventV1 = {
      schemaVersion: 1,
      eventId: "e1",
      timestamp: "2026-11-16T12:00:00.000Z",
      projectScope: "ikigai",
      redacted: true,
      classification: "review",
      ttlDays: 90,
      turnId: "t1",
      ruleId: "ARCH-001",
      outcome: "PASS",
      violationProbability: 0.1,
      confidence: 0.9,
      scopedPaths: ["src/a.ts"],
      rationale: "Clean",
      decisionOrigin: "rule-check",
    };
    await memory.emit([event]);

    const lines = readFileSync(join(dataDir, "memory-events.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}").redacted).toBe(true);
  });

  it("detects fork PRs and submits GitHub review via REST", async () => {
    const requests: { url: string; method: string; body?: string }[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      requests.push({
        url,
        method: init?.method ?? "GET",
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      });

      if (url.endsWith("/pulls/7")) {
        return new Response(
          JSON.stringify({
            number: 7,
            title: "feat: test",
            body: "desc",
            base: { ref: "main", repo: { full_name: "org/repo" } },
            head: { sha: "abc12345", repo: { full_name: "forker/repo", fork: true } },
          }),
          { status: 200 },
        );
      }

      return new Response(
        JSON.stringify({ html_url: "https://github.com/org/repo/pull/7#review" }),
        {
          status: 200,
        },
      );
    };

    const gh = createGitHubRestClient("ghp_token", fakeFetch);
    const meta = await gh.fetchPullRequest("org", "repo", 7);
    expect(meta.isFork).toBe(true);

    const plan: PrReviewPlan = {
      action: "COMMENT",
      summaryBody: "Looks safe",
      inlineComments: [],
      forkDowngraded: true,
    };
    const res = await gh.submitReview("org", "repo", 7, meta.headSha, plan);
    expect(res.ok).toBe(true);
    expect(res.url).toContain("pull/7");
  });

  it("routes Jev System-1 rule/batch judges via TYPESAFE_API_KEY vault and refuses fix patches with JEV_CANNOT_FIX", async () => {
    const dir = makeTempDir("ikigai-jev-");
    const env: NodeJS.ProcessEnv = {
      XDG_CONFIG_HOME: makeTempDir("jev-cfg-"),
      XDG_DATA_HOME: makeTempDir("jev-data-"),
    };

    saveCredential("jev", "ts_synthetic_jev_secret_9876", env);
    let capturedAuth = "";
    let capturedUrl = "";

    const jevFetch: typeof fetch = async (input, init) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      capturedAuth = new Headers(init?.headers).get("authorization") ?? "";
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        state?: { checks?: unknown };
      };
      if (body.state?.checks) {
        return new Response(
          JSON.stringify({
            answers: {
              "SCOPE-CREEP": { type: "noul", noul: 0.12 },
              COMPLEXITY: { type: "noul", noul: 0.78 },
              "TEST-ADEQUACY": { type: "invalid" },
            },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          answers: { violation: { type: "noul", noul: 0.89 } },
        }),
        { status: 200 },
      );
    };

    const router = createMultiProvider({ workingDir: dir, env, fetchImpl: jevFetch });

    const ruleRes = await router.judgeRuleSlice({
      kind: "RULE",
      checkId: "ARCH-001",
      ruleSummary: "No SQL in controller",
      violationCriteria: "Imports SQL directly",
      allowedCriteria: null,
      task: "Add handler",
      files: ["src/ctrl.ts"],
      diff: "diff --git a/src/ctrl.ts b/src/ctrl.ts\n--- a/src/ctrl.ts\n+++ b/src/ctrl.ts\n@@ -1,1 +1,2 @@\n+db.query('SELECT 1');\n",
      nonce: "n-jev",
      endpoint: { provider: "jev", model: "jev-latest", mode: "api" },
    });

    expect(capturedUrl).toBe("https://api.typesafe.ai/v1/systemone");
    expect(capturedAuth).toBe("Bearer ts_synthetic_jev_secret_9876");
    expect(ruleRes.status).toBe("OK");
    if (ruleRes.status === "OK") {
      expect(ruleRes.judgment.violationProbability).toBe(0.89);
      expect(ruleRes.judgment.evidenceHunk?.quote).toContain("db.query('SELECT 1')");
    }

    const batchRes = await router.judgeBuiltInBatch({
      task: "Add handler",
      files: ["src/ctrl.ts"],
      diff: "@@ -1,1 +1,2 @@\n+db.query('SELECT 1');\n",
      nonce: "n-jev-b",
      endpoint: { provider: "jev", model: "jev-latest", mode: "api" },
      checks: [
        {
          checkId: "SCOPE-CREEP",
          ruleSummary: "Scope",
          violationCriteria: "Out of scope",
          allowedCriteria: "In scope",
        },
        {
          checkId: "COMPLEXITY",
          ruleSummary: "Complexity",
          violationCriteria: "Too complex",
          allowedCriteria: "Simple",
        },
        {
          checkId: "TEST-ADEQUACY",
          ruleSummary: "Tests",
          violationCriteria: "No tests",
          allowedCriteria: "Tested",
        },
      ],
    });
    expect(batchRes.status).toBe("OK");
    if (batchRes.status === "OK") {
      expect(batchRes.answers["SCOPE-CREEP"].status).toBe("OK");
      expect(batchRes.answers.COMPLEXITY.status).toBe("OK");
      expect(batchRes.answers["TEST-ADEQUACY"].status).toBe("FAILED");
    }

    const fixRes = await router.generateFixPatch?.({
      task: "Fix controller",
      diff: "+db.query('SELECT 1');",
      nonce: "n-fix",
      endpoint: { provider: "jev", model: "jev-latest", mode: "api" },
      findings: [],
    });
    expect(fixRes?.status).toBe("FAILED");
    if (fixRes?.status === "FAILED") {
      expect(fixRes.errorCode).toBe("JEV_CANNOT_FIX");
    }
  });
});

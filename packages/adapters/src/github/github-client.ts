import { execFile } from "node:child_process";
import type { PrReviewPlan } from "@ikigai/core";
import { createEncryptedVault } from "../credentials/encrypted-vault.ts";

export interface PullRequestMetadata {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly baseRef: string;
  readonly headSha: string;
  readonly isFork: boolean;
}

export interface GitHubPrClient {
  fetchPullRequest(owner: string, repo: string, prNumber: number): Promise<PullRequestMetadata>;
  fetchPullRequestDiff(owner: string, repo: string, prNumber: number): Promise<string>;
  submitReview(
    owner: string,
    repo: string,
    prNumber: number,
    headSha: string,
    plan: PrReviewPlan,
  ): Promise<{ readonly ok: boolean; readonly statusCode: number; readonly url: string | null }>;
}

export async function resolveGitHubToken(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const fromEnv = env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  try {
    const vault = createEncryptedVault({ env });
    const vaulted = vault.unsealSecret("github.oauth") ?? vault.unsealSecret("github.pat");
    if (vaulted) {
      return vaulted;
    }
  } catch {
    // Fall back to passive gh CLI lookup.
  }

  return new Promise((resolve) => {
    execFile("gh", ["auth", "token"], { timeout: 5_000, windowsHide: true }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const token = stdout.trim();
      resolve(token === "" ? null : token);
    });
  });
}

export function createGitHubRestClient(
  token: string,
  fetchImpl: typeof fetch = fetch,
  apiBase = "https://api.github.com",
): GitHubPrClient {
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "ikigai-semantic-pr-bot/0.1",
    "x-github-api-version": "2022-11-28",
  };

  return {
    async fetchPullRequest(owner, repo, prNumber): Promise<PullRequestMetadata> {
      const url = `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}`;
      const res = await fetchImpl(url, { headers });
      if (!res.ok) {
        throw new Error(`GitHub PR metadata failed: HTTP ${res.status}`);
      }
      const data = (await res.json()) as {
        number: number;
        title?: string;
        body?: string | null;
        base?: { ref?: string; repo?: { full_name?: string } };
        head?: { sha?: string; repo?: { full_name?: string; fork?: boolean } | null };
      };

      const baseFull = data.base?.repo?.full_name ?? `${owner}/${repo}`;
      const headFull = data.head?.repo?.full_name ?? "";
      const isFork = Boolean(data.head?.repo?.fork) || headFull !== baseFull;

      return {
        number: data.number,
        title: data.title ?? "",
        body: data.body ?? "",
        baseRef: data.base?.ref ?? "main",
        headSha: data.head?.sha ?? "",
        isFork,
      };
    },

    async fetchPullRequestDiff(owner, repo, prNumber): Promise<string> {
      const url = `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}`;
      const res = await fetchImpl(url, {
        headers: {
          ...headers,
          accept: "application/vnd.github.v3.diff",
        },
      });
      if (!res.ok) {
        throw new Error(`GitHub PR diff failed: HTTP ${res.status}`);
      }
      return res.text();
    },

    async submitReview(owner, repo, prNumber, headSha, plan) {
      const url = `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}/reviews`;
      const comments = plan.inlineComments.map((c) => ({
        path: c.path,
        line: c.line,
        side: "RIGHT",
        body: c.body,
      }));

      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          commit_id: headSha,
          event: plan.action,
          body: plan.summaryBody,
          comments,
        }),
      });

      if (!res.ok) {
        // Retry once without inline comments if line positions do not match PR diff view.
        const fallbackRes = await fetchImpl(url, {
          method: "POST",
          headers: {
            ...headers,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            commit_id: headSha,
            event: plan.action,
            body: plan.summaryBody,
          }),
        });
        const fallbackBody = fallbackRes.ok
          ? ((await fallbackRes.json()) as { html_url?: string })
          : null;
        return {
          ok: fallbackRes.ok,
          statusCode: fallbackRes.status,
          url: fallbackBody?.html_url ?? null,
        };
      }

      const body = (await res.json()) as { html_url?: string };
      return { ok: true, statusCode: res.status, url: body.html_url ?? null };
    },
  };
}

import { execFile } from "node:child_process";
import { parseUnifiedDiff, type Turn, type TurnFile } from "@ikigai/core";

const ALLOWED_API_ORIGIN = "https://api.github.com";
const MAX_COMMIT_FILES = 40;
const MAX_PATCH_BYTES = 250_000;

export interface GitHubRepoSummary {
  readonly fullName: string;
  readonly owner: string;
  readonly name: string;
  readonly description: string;
  readonly stars: number;
  readonly language: string | null;
  readonly defaultBranch: string;
  readonly isPrivate: boolean;
  readonly updatedAt: string;
  readonly htmlUrl: string;
}

export interface GitHubCommitSummary {
  readonly sha: string;
  readonly shortSha: string;
  readonly messageHeadline: string;
  readonly authorLogin: string;
  readonly authorName: string;
  readonly date: string;
  readonly htmlUrl: string;
}

export interface GitHubPullSummary {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly authorLogin: string;
  readonly baseRef: string;
  readonly headSha: string;
  readonly isFork: boolean;
  readonly htmlUrl: string;
}

export interface RemotePolicyBundle {
  readonly rulesText: string | null;
  readonly configText: string | null;
  readonly source: "repo-base-branch" | "lintfixer-default";
}

export interface GitHubExplorerClient {
  searchRepositories(
    query: string,
    options?: { readonly sort?: "stars" | "updated"; readonly perPage?: number },
  ): Promise<readonly GitHubRepoSummary[]>;
  listUserRepositories(perPage?: number): Promise<readonly GitHubRepoSummary[]>;
  listRepoCommits(
    owner: string,
    repo: string,
    options?: { readonly branch?: string; readonly perPage?: number },
  ): Promise<readonly GitHubCommitSummary[]>;
  fetchCommitTurn(
    owner: string,
    repo: string,
    sha: string,
  ): Promise<{
    readonly turn: Turn;
    readonly commit: GitHubCommitSummary;
    readonly unifiedDiff: string;
  }>;
  listRepoPulls(
    owner: string,
    repo: string,
    perPage?: number,
  ): Promise<readonly GitHubPullSummary[]>;
  fetchFilesAtRef(
    owner: string,
    repo: string,
    ref: string,
    paths: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;
  readProtectedBasePolicy(
    owner: string,
    repo: string,
    defaultBranch: string,
  ): Promise<RemotePolicyBundle>;
}

/**
 * Hardened GitHub REST client restricted exclusively to `https://api.github.com`
 * with `redirect: "error"` to prevent token leakage and SSRF.
 */
export function createGitHubExplorerClient(
  token: string | null,
  fetchImpl: typeof fetch = fetch,
  apiBase = ALLOWED_API_ORIGIN,
): GitHubExplorerClient {
  const origin = assertAllowedGitHubOrigin(apiBase);

  const buildHeaders = (): Record<string, string> => ({
    accept: "application/vnd.github+json",
    "user-agent": "lintfixer-desktop/0.2",
    "x-github-api-version": "2022-11-28",
    ...(token && token.trim() !== "" ? { authorization: `Bearer ${token.trim()}` } : {}),
  });

  async function requestJson<T>(pathAndQuery: string): Promise<T> {
    const targetUrl = `${origin}${pathAndQuery}`;
    const res = await fetchImpl(targetUrl, {
      method: "GET",
      redirect: "error",
      headers: buildHeaders(),
    });
    if (!res.ok) {
      throw new Error(`GITHUB_API_HTTP_${res.status}`);
    }
    return (await res.json()) as T;
  }

  async function readFileFromBranch(
    owner: string,
    repo: string,
    filePath: string,
    branch: string,
  ): Promise<string | null> {
    const cleanPath = filePath
      .split("/")
      .map((s) => encodeURIComponent(s))
      .join("/");
    const url = `${origin}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${cleanPath}?ref=${encodeURIComponent(branch)}`;
    const res = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      headers: buildHeaders(),
    });
    if (!res.ok) {
      return null;
    }
    const payload = (await res.json()) as { content?: string; encoding?: string; type?: string };
    if (payload.type !== "file" || typeof payload.content !== "string") {
      return null;
    }
    if (payload.encoding === "base64") {
      return Buffer.from(payload.content, "base64").toString("utf8");
    }
    return payload.content;
  }

  return {
    async searchRepositories(query, options = {}) {
      const cleaned = query.trim();
      if (!cleaned) {
        return [];
      }
      const sort = options.sort ?? "stars";
      const perPage = Math.max(1, Math.min(20, options.perPage ?? 12));
      const data = await requestJson<{ items?: RawGitHubRepo[] }>(
        `/search/repositories?q=${encodeURIComponent(cleaned)}&sort=${encodeURIComponent(sort)}&per_page=${perPage}`,
      );
      return (data.items ?? []).map(mapRepoSummary);
    },

    async listUserRepositories(perPage = 16) {
      if (!token?.trim()) {
        return [];
      }
      const bounded = Math.max(1, Math.min(30, perPage));
      const items = await requestJson<RawGitHubRepo[]>(
        `/user/repos?sort=updated&affiliation=owner,collaborator&per_page=${bounded}`,
      );
      return items.map(mapRepoSummary);
    },

    async listRepoCommits(owner, repo, options = {}) {
      const perPage = Math.max(1, Math.min(30, options.perPage ?? 12));
      const shaParam = options.branch ? `&sha=${encodeURIComponent(options.branch)}` : "";
      const items = await requestJson<RawGitHubCommit[]>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?per_page=${perPage}${shaParam}`,
      );
      return items.map(mapCommitSummary);
    },

    async fetchCommitTurn(owner, repo, sha) {
      const data = await requestJson<RawGitHubCommitDetail>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(sha)}`,
      );

      const files: TurnFile[] = [];
      const diffChunks: string[] = [];
      let totalChars = 0;

      for (const rawFile of (data.files ?? []).slice(0, MAX_COMMIT_FILES)) {
        const filename = rawFile.filename ?? "";
        if (!filename || filename.includes("..") || filename.startsWith("/")) {
          continue;
        }
        const patch = rawFile.patch ?? "";
        if (totalChars + patch.length > MAX_PATCH_BYTES) {
          break;
        }
        totalChars += patch.length;
        const formattedPatch = patch.startsWith("diff --git")
          ? patch
          : `diff --git a/${filename} b/${filename}\n--- a/${filename}\n+++ b/${filename}\n${patch}`;
        files.push({ path: filename, patch: formattedPatch });
        diffChunks.push(formattedPatch);
      }

      const commit = mapCommitSummary(data);
      const message =
        data.commit?.message?.trim() || commit.messageHeadline || `Commit ${commit.shortSha}`;

      return {
        turn: {
          id: `gh-${owner}-${repo}-${commit.shortSha}`,
          task: message,
          files,
          source: "commit",
        },
        commit,
        unifiedDiff: diffChunks.join("\n"),
      };
    },

    async listRepoPulls(owner, repo, perPage = 10) {
      const bounded = Math.max(1, Math.min(20, perPage));
      const items = await requestJson<RawGitHubPull[]>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=open&per_page=${bounded}`,
      );
      return items.map((p) => {
        const baseFull = p.base?.repo?.full_name ?? `${owner}/${repo}`;
        const headFull = p.head?.repo?.full_name ?? "";
        return {
          number: p.number,
          title: p.title ?? "",
          state: p.state ?? "open",
          authorLogin: p.user?.login ?? "unknown",
          baseRef: p.base?.ref ?? "main",
          headSha: p.head?.sha ?? "",
          isFork: Boolean(p.head?.repo?.fork) || headFull !== baseFull,
          htmlUrl: p.html_url ?? "",
        };
      });
    },

    async fetchFilesAtRef(owner, repo, ref, paths) {
      const out = new Map<string, string>();
      for (const p of paths.slice(0, MAX_COMMIT_FILES)) {
        if (!p || p.includes("..") || p.startsWith("/")) continue;
        const content = await readFileFromBranch(owner, repo, p, ref);
        if (content !== null) {
          out.set(p, content);
        }
      }
      return out;
    },

    async readProtectedBasePolicy(owner, repo, defaultBranch) {
      const [rulesText, configText] = await Promise.all([
        readFileFromBranch(owner, repo, ".ikigai/rules.md", defaultBranch),
        readFileFromBranch(owner, repo, ".ikigai/config.yaml", defaultBranch),
      ]);

      if (rulesText !== null || configText !== null) {
        return {
          rulesText,
          configText,
          source: "repo-base-branch",
        };
      }

      return {
        rulesText: null,
        configText: null,
        source: "lintfixer-default",
      };
    },
  };
}

export async function listLocalGitCommits(
  repoRoot: string,
  limit = 12,
): Promise<readonly GitHubCommitSummary[]> {
  const safeLimit = Math.max(1, Math.min(30, limit));
  const stdout = await execGit(
    ["log", `-n`, String(safeLimit), "--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%aI"],
    repoRoot,
  );
  if (!stdout.trim()) {
    return [];
  }
  return stdout
    .split(/\r?\n/)
    .map((line) => line.split("\x1f"))
    .filter((parts) => parts.length >= 5 && Boolean(parts[0]))
    .map((parts) => ({
      sha: parts[0] ?? "",
      shortSha: parts[1] ?? "",
      messageHeadline: parts[2] ?? "",
      authorLogin: parts[3] ?? "local",
      authorName: parts[3] ?? "Local",
      date: parts[4] ?? "",
      htmlUrl: "",
    }));
}

export async function getLocalCommitTurn(
  repoRoot: string,
  sha: string,
): Promise<{
  readonly turn: Turn;
  readonly commit: GitHubCommitSummary;
  readonly unifiedDiff: string;
}> {
  const safeSha = sha.trim();
  if (!/^[a-fA-F0-9]{4,40}$|^HEAD(?:~\d+)?$/.test(safeSha)) {
    throw new Error("INVALID_GIT_SHA");
  }

  const [metaRaw, rawDiff] = await Promise.all([
    execGit(["show", "-s", "--format=%H%x1f%h%x1f%B%x1f%an%x1f%aI", safeSha], repoRoot),
    execGit(["show", "--format=", "--unified=3", safeSha], repoRoot),
  ]);

  const parts = metaRaw.trim().split("\x1f");
  const fullMessage = (parts[2] ?? "").trim();
  const headline = (fullMessage.split(/\r?\n/)[0] ?? "").trim();
  const parsed = parseUnifiedDiff(rawDiff);
  const files = parsed.status === "PARSED" ? parsed.files : [];

  return {
    turn: {
      id: `local-${parts[1] ?? safeSha.slice(0, 7)}`,
      task: fullMessage || headline || `Commit ${safeSha}`,
      files,
      source: "commit",
    },
    commit: {
      sha: parts[0] ?? safeSha,
      shortSha: parts[1] ?? safeSha.slice(0, 7),
      messageHeadline: headline,
      authorLogin: parts[3] ?? "local",
      authorName: parts[3] ?? "Local",
      date: parts[4] ?? "",
      htmlUrl: "",
    },
    unifiedDiff: rawDiff,
  };
}

function assertAllowedGitHubOrigin(apiBase: string): string {
  const url = new URL(apiBase);
  const isMockLoopback =
    (url.hostname === "127.0.0.1" || url.hostname === "localhost") && url.protocol === "http:";
  if (url.origin !== ALLOWED_API_ORIGIN && !isMockLoopback) {
    throw new Error("SECURITY_BLOCK: Untrusted GitHub API host rejected.");
  }
  return url.origin;
}

async function execGit(args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "git",
      args,
      { cwd, timeout: 10_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          rejectPromise(new Error(stderr.trim() || err.message));
          return;
        }
        resolvePromise(stdout);
      },
    );
  });
}

interface RawGitHubRepo {
  readonly full_name?: string;
  readonly name?: string;
  readonly owner?: { readonly login?: string };
  readonly description?: string | null;
  readonly stargazers_count?: number;
  readonly language?: string | null;
  readonly default_branch?: string;
  readonly private?: boolean;
  readonly updated_at?: string;
  readonly html_url?: string;
}

interface RawGitHubCommit {
  readonly sha?: string;
  readonly html_url?: string;
  readonly author?: { readonly login?: string } | null;
  readonly commit?: {
    readonly message?: string;
    readonly author?: { readonly name?: string; readonly date?: string };
  };
}

interface RawGitHubCommitDetail extends RawGitHubCommit {
  readonly files?: readonly {
    readonly filename?: string;
    readonly status?: string;
    readonly patch?: string;
  }[];
}

interface RawGitHubPull {
  readonly number: number;
  readonly title?: string;
  readonly state?: string;
  readonly html_url?: string;
  readonly user?: { readonly login?: string } | null;
  readonly base?: { readonly ref?: string; readonly repo?: { readonly full_name?: string } };
  readonly head?: {
    readonly sha?: string;
    readonly repo?: { readonly full_name?: string; readonly fork?: boolean } | null;
  };
}

function mapRepoSummary(raw: RawGitHubRepo): GitHubRepoSummary {
  const fullName = raw.full_name ?? `${raw.owner?.login ?? ""}/${raw.name ?? ""}`;
  return {
    fullName,
    owner: raw.owner?.login ?? fullName.split("/")[0] ?? "",
    name: raw.name ?? fullName.split("/")[1] ?? "",
    description: raw.description ?? "",
    stars: raw.stargazers_count ?? 0,
    language: raw.language ?? null,
    defaultBranch: raw.default_branch ?? "main",
    isPrivate: Boolean(raw.private),
    updatedAt: raw.updated_at ?? "",
    htmlUrl: raw.html_url ?? `https://github.com/${fullName}`,
  };
}

function mapCommitSummary(raw: RawGitHubCommit): GitHubCommitSummary {
  const sha = raw.sha ?? "";
  const msg = raw.commit?.message ?? "";
  const headline = (msg.split(/\r?\n/)[0] ?? "").trim();
  const authorName = raw.commit?.author?.name ?? raw.author?.login ?? "unknown";
  return {
    sha,
    shortSha: sha.slice(0, 7),
    messageHeadline: headline,
    authorLogin: raw.author?.login ?? authorName,
    authorName,
    date: raw.commit?.author?.date ?? "",
    htmlUrl: raw.html_url ?? "",
  };
}

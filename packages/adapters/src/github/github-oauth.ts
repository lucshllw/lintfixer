import { execFile } from "node:child_process";

const GITHUB_OAUTH_ORIGIN = "https://github.com";
const GITHUB_API_ORIGIN = "https://api.github.com";

export interface DeviceFlowStartResult {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresIn: number;
  readonly interval: number;
}

export type DeviceFlowPollResult =
  | { readonly status: "authorized"; readonly accessToken: string; readonly scope: string }
  | { readonly status: "pending"; readonly retryAfterSec?: number }
  | { readonly status: "expired" | "denied" | "error"; readonly message: string };

export interface GitHubViewerProfile {
  readonly login: string;
  readonly name: string | null;
  readonly avatarUrl: string;
  readonly profileUrl: string;
}

export async function startGitHubDeviceFlow(opts: {
  readonly clientId: string;
  readonly scope?: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<DeviceFlowStartResult> {
  const clientId = opts.clientId.trim();
  if (!clientId) {
    throw new Error("GITHUB_CLIENT_ID_REQUIRED");
  }
  const fetchFn = opts.fetchImpl ?? fetch;
  const scope = opts.scope?.trim() || "read:user public_repo";

  const body = new URLSearchParams({
    client_id: clientId,
    scope,
  });

  const res = await fetchFn(`${GITHUB_OAUTH_ORIGIN}/login/device/code`, {
    method: "POST",
    redirect: "error",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "lintfixer-desktop/0.2",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`GITHUB_DEVICE_START_HTTP_${res.status}`);
  }

  const data = (await res.json()) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    expires_in?: number;
    interval?: number;
    error_description?: string;
  };

  if (!data.device_code || !data.user_code || !data.verification_uri) {
    throw new Error(data.error_description ?? "GITHUB_DEVICE_INVALID_RESPONSE");
  }

  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    expiresIn: data.expires_in ?? 900,
    interval: data.interval ?? 5,
  };
}

export async function pollGitHubDeviceFlow(opts: {
  readonly clientId: string;
  readonly deviceCode: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<DeviceFlowPollResult> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    client_id: opts.clientId.trim(),
    device_code: opts.deviceCode.trim(),
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });

  const res = await fetchFn(`${GITHUB_OAUTH_ORIGIN}/login/oauth/access_token`, {
    method: "POST",
    redirect: "error",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "lintfixer-desktop/0.2",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    return { status: "error", message: `HTTP ${res.status}` };
  }

  const data = (await res.json()) as {
    access_token?: string;
    scope?: string;
    error?: string;
    error_description?: string;
    interval?: number;
  };

  if (data.access_token) {
    return {
      status: "authorized",
      accessToken: data.access_token,
      scope: data.scope ?? "",
    };
  }

  if (data.error === "authorization_pending") {
    return { status: "pending" };
  }

  if (data.error === "slow_down") {
    return { status: "pending", retryAfterSec: data.interval ?? 10 };
  }

  if (data.error === "expired_token") {
    return { status: "expired", message: "Codigo de autorizacao expirado." };
  }

  if (data.error === "access_denied") {
    return { status: "denied", message: "Autorizacao cancelada pelo usuario." };
  }

  return {
    status: "error",
    message: data.error_description ?? data.error ?? "UNKNOWN_OAUTH_ERROR",
  };
}

export async function fetchGitHubViewer(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GitHubViewerProfile | null> {
  if (!token.trim()) {
    return null;
  }

  const res = await fetchImpl(`${GITHUB_API_ORIGIN}/user`, {
    method: "GET",
    redirect: "error",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "lintfixer-desktop/0.2",
      "x-github-api-version": "2022-11-28",
    },
  });

  if (!res.ok) {
    return null;
  }

  const data = (await res.json()) as {
    login?: string;
    name?: string | null;
    avatar_url?: string;
    html_url?: string;
  };

  if (!data.login) {
    return null;
  }

  return {
    login: data.login,
    name: data.name ?? null,
    avatarUrl: data.avatar_url ?? "",
    profileUrl: data.html_url ?? `https://github.com/${data.login}`,
  };
}

/**
 * Passively reads an authenticated token from local `gh` CLI (if logged in),
 * never touching browser cookies or invoking a shell.
 */
export async function importGhCliToken(): Promise<string | null> {
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

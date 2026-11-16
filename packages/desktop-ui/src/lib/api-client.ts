let sessionTokenCache: string | null = null;

export function bootstrapSessionToken(): string | null {
  if (sessionTokenCache) {
    return sessionTokenCache;
  }

  const params = new URLSearchParams(window.location.search);
  const urlToken = params.get("token")?.trim();
  if (urlToken) {
    sessionTokenCache = urlToken;
    params.delete("token");
    const nextSearch = params.toString();
    const cleanUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}${window.location.hash}`;
    window.history.replaceState(null, "", cleanUrl);
    return urlToken;
  }

  return null;
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = bootstrapSessionToken();
  const headers = new Headers(init.headers);
  if (token) {
    headers.set("x-lintfixer-token", token);
  }
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers,
  });

  const payload = (await res.json().catch(() => ({}))) as { error?: string } & T;
  if (!res.ok) {
    throw new Error(payload.error ?? `HTTP ${res.status}`);
  }
  return payload;
}

export function subscribePipelineEvents(
  onEvent: (event: {
    stage: "IDLE" | "SCAN" | "FILTER" | "LINT" | "FIX" | "VERIFY" | "DONE" | "ERROR";
    detail: string;
    inScopeFiles?: number;
    totalFiles?: number;
    timestamp: string;
  }) => void,
): () => void {
  const token = bootstrapSessionToken();
  const query = token ? `?token=${encodeURIComponent(token)}` : "";
  const source = new EventSource(`/api/events${query}`);

  source.addEventListener("pipeline", (ev) => {
    try {
      const parsed = JSON.parse((ev as MessageEvent<string>).data);
      onEvent(parsed);
    } catch {
      // Ignore malformed telemetry packets.
    }
  });

  return () => {
    source.close();
  };
}

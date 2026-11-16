import { describe, expect, it } from "vitest";
import {
  createGitHubExplorerClient,
  pollGitHubDeviceFlow,
  startGitHubDeviceFlow,
} from "@ikigai/adapters";

describe("GitHub explorer, OAuth Device Flow & security allowlist", () => {
  it("rejects untrusted non-GitHub API hosts", () => {
    expect(() => createGitHubExplorerClient("tok", fetch, "https://evil.example.com")).toThrow(
      /SECURITY_BLOCK/,
    );
  });

  it("searches repositories, reads commits, converts diff to Turn, and reads rules only from default branch", async () => {
    const requestedUrls: string[] = [];
    const fakeFetch: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      requestedUrls.push(url);

      if (url.includes("/search/repositories")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                full_name: "acme-org/demo-service",
                name: "demo-service",
                owner: { login: "acme-org" },
                description: "Demo validation repository",
                stargazers_count: 12,
                language: "TypeScript",
                default_branch: "main",
                private: false,
                updated_at: "2026-11-16T12:00:00Z",
                html_url: "https://github.com/acme-org/demo-service",
              },
            ],
          }),
          { status: 200 },
        );
      }

      if (url.endsWith("/commits/abc1234")) {
        return new Response(
          JSON.stringify({
            sha: "abc1234567890",
            html_url: "https://github.com/acme-org/demo-service/commit/abc1234",
            author: { login: "acme-org" },
            commit: {
              message: "feat(orders): add endpoint",
              author: { name: "Contributor", date: "2026-11-16T12:00:00Z" },
            },
            files: [
              {
                filename: "src/controllers/orders.ts",
                status: "modified",
                patch:
                  "@@ -1,2 +1,3 @@\n export function list() {\n+  return db.query('SELECT 1');\n }",
              },
            ],
          }),
          { status: 200 },
        );
      }

      if (url.includes("/contents/.ikigai/rules.md?ref=main")) {
        return new Response(
          JSON.stringify({
            type: "file",
            encoding: "base64",
            content: Buffer.from("# Rules\n\n## ARCH-001\nseverity: error\n", "utf8").toString(
              "base64",
            ),
          }),
          { status: 200 },
        );
      }

      return new Response("{}", { status: 404 });
    };

    const client = createGitHubExplorerClient("gho_test", fakeFetch);
    const repos = await client.searchRepositories("demo-service");
    expect(repos).toHaveLength(1);
    expect(repos[0]?.fullName).toBe("acme-org/demo-service");

    const turnBundle = await client.fetchCommitTurn("acme-org", "demo-service", "abc1234");
    expect(turnBundle.turn.files).toHaveLength(1);
    expect(turnBundle.turn.files[0]?.path).toBe("src/controllers/orders.ts");

    const policy = await client.readProtectedBasePolicy("acme-org", "demo-service", "main");
    expect(policy.source).toBe("repo-base-branch");
    expect(policy.rulesText).toContain("ARCH-001");
    expect(requestedUrls.some((u) => u.includes("?ref=main"))).toBe(true);
  });

  it("handles GitHub Device Flow start and polling states cleanly", async () => {
    const fakeFetch: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/login/device/code")) {
        return new Response(
          JSON.stringify({
            device_code: "dev_123",
            user_code: "CAT-9911",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 5,
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          access_token: "gho_authorized_device_token",
          scope: "read:user public_repo",
        }),
        { status: 200 },
      );
    };

    const start = await startGitHubDeviceFlow({
      clientId: "Ov23liTestClientId",
      fetchImpl: fakeFetch,
    });
    expect(start.userCode).toBe("CAT-9911");

    const poll = await pollGitHubDeviceFlow({
      clientId: "Ov23liTestClientId",
      deviceCode: start.deviceCode,
      fetchImpl: fakeFetch,
    });
    expect(poll.status).toBe("authorized");
  });
});

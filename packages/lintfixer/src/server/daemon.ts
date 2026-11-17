import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  clearMasterKeyMemoryCacheForTests,
  createEncryptedVault,
  createFsPolicySource,
  createGitHubExplorerClient,
  createGitRefPolicySource,
  createMemoryOutbox,
  createMultiProvider,
  createSafePatchApplier,
  fetchGitHubViewer,
  findRepoRoot,
  getLocalCommitTurn,
  getStagedDiff,
  importGhCliToken,
  listLocalGitCommits,
  migrateLegacyCredentialsToVault,
  pollGitHubDeviceFlow,
  resolveCredential,
  resolveGitHubToken,
  resolveIkigaiConfigDir,
  resolveIkigaiDataDir,
  startGitHubDeviceFlow,
  type VaultNamespace,
} from "@ikigai/adapters";
import {
  type CalibrationSample,
  compareSliceAggregations,
  computeConfusionMatrix,
  computeDerivedMetrics,
  computeGitScore,
  computeRepeatStability,
  DEFAULT_POLICY_CONFIG,
  lintCommit,
  type PatchApplierPort,
  type PolicyConfig,
  type PolicySourcePort,
  type ProviderPort,
  parsePolicyConfig,
  parseRules,
  parseUnifiedDiff,
  redactSecrets,
  reviewTurn,
  runAutoFix,
  suggestAllowedRefinements,
  type Turn,
  verifyProposedPatch,
} from "@ikigai/core";

const DEFAULT_STARTER_RULES = `# LintFixer Policy Rules

## ARCH-001

severity: error
scope: src/**
evidence: code
fixable: true

### Rule

Keep domain and database persistence logic decoupled from HTTP handlers and UI presentation.

### Violation

A controller or route executes raw SQL / database queries or embeds domain mutations inline.

### Allowed

Input validation, DTO mapping, and delegating business logic to domain/application services.

## SEC-001

severity: error
scope: **
evidence: code
fixable: false

### Rule

Never commit or expose raw credentials, tokens, or private keys.

### Violation

Hardcoding API keys, secret tokens, or bypassing redaction guards.

### Allowed

Environment variable lookups, OS encrypted vaults, and clearly marked synthetic fixtures.
`;

export interface DaemonOptions {
  readonly cwd: string;
  readonly port?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly providerOverride?: ProviderPort;
  readonly fetchOverride?: typeof fetch;
}

export interface RunningDaemon {
  readonly url: string;
  readonly port: number;
  readonly sessionToken: string;
  readonly close: () => Promise<void>;
}

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
};

const VALID_VAULT_NAMESPACES = new Set<VaultNamespace>([
  "github.oauth",
  "github.pat",
  "llm.jev",
  "llm.gemini",
  "llm.openai",
  "llm.claude",
]);

function resolveAssetsAndUiPaths(): { readonly uiDistDir: string; readonly assetsDir: string } {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidatesUi = [
    resolve(here, "ui"),
    resolve(here, "../dist/ui"),
    resolve(here, "../../dist/ui"),
    resolve(here, "../../../desktop-ui/dist"),
    resolve(here, "../../../../packages/desktop-ui/dist"),
  ];
  const candidatesAssets = [
    resolve(here, "../assets"),
    resolve(here, "../../assets"),
    resolve(here, "assets"),
  ];
  const fallbackUi = resolve(here, "ui");
  const fallbackAssets = resolve(here, "../assets");
  const uiDistDir = candidatesUi.find((dir) => existsSync(join(dir, "index.html"))) ?? fallbackUi;
  const assetsDir =
    candidatesAssets.find((dir) => existsSync(join(dir, "kat-brackets-badge.svg"))) ??
    fallbackAssets;
  return { uiDistDir, assetsDir };
}

export async function startLintFixerDaemon(opts: DaemonOptions): Promise<RunningDaemon> {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchOverride ?? fetch;
  const sessionToken = randomBytes(24).toString("hex");
  const { uiDistDir, assetsDir } = resolveAssetsAndUiPaths();
  const repoRoot = await findRepoRoot(opts.cwd);

  const sseClients = new Set<ServerResponse>();
  const emitPipeline = (stage: string, detail: string, extra: Record<string, unknown> = {}) => {
    const payload = JSON.stringify({
      stage,
      detail,
      ...extra,
      timestamp: new Date().toISOString(),
    });
    for (const res of sseClients) {
      res.write(`event: pipeline\ndata: ${payload}\n\n`);
    }
  };

  let boundPort = opts.port ?? 0;

  const isAuthorizedApiRequest = (req: IncomingMessage, url: URL): boolean => {
    const host = req.headers.host ?? "";
    const allowedHosts = new Set([`127.0.0.1:${boundPort}`, `localhost:${boundPort}`]);
    if (!allowedHosts.has(host)) {
      return false;
    }

    const origin = req.headers.origin;
    if (
      origin &&
      !new Set([`http://127.0.0.1:${boundPort}`, `http://localhost:${boundPort}`]).has(origin)
    ) {
      return false;
    }

    const headerToken = req.headers["x-lintfixer-token"];
    const queryToken = url.searchParams.get("token");
    const cookieHeader = req.headers.cookie ?? "";
    const cookieToken = extractCookie(cookieHeader, "lf_session");

    const candidate =
      (typeof headerToken === "string" ? headerToken : "") || cookieToken || queryToken || "";

    return safeTokenEquals(candidate, sessionToken);
  };

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((err) => {
      const message = err instanceof Error ? err.message : "Erro interno";
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: message });
      }
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawUrl = req.url ?? "/";
    const parsedUrl = new URL(rawUrl, `http://127.0.0.1:${boundPort}`);
    const pathname = parsedUrl.pathname;

    // 1. SSE Event Stream
    if (pathname === "/api/events") {
      if (!isAuthorizedApiRequest(req, parsedUrl)) {
        sendJson(res, 401, { ok: false, error: "UNAUTHORIZED_LOOPBACK_SESSION" });
        return;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(
        `event: pipeline\ndata: ${JSON.stringify({
          stage: "IDLE",
          detail: "Telemetry SSE conectada",
          timestamp: new Date().toISOString(),
        })}\n\n`,
      );
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    // 2. Authorized JSON API endpoints
    if (pathname.startsWith("/api/")) {
      if (!isAuthorizedApiRequest(req, parsedUrl)) {
        sendJson(res, 401, { ok: false, error: "UNAUTHORIZED_LOOPBACK_SESSION" });
        return;
      }

      if (pathname === "/api/health" && req.method === "GET") {
        sendJson(res, 200, { ok: true, service: "lintfixer", version: "0.2.0" });
        return;
      }

      if (pathname === "/api/bootstrap" && req.method === "GET") {
        const vault = createEncryptedVault({ env });
        const ghToken = await resolveActiveGitHubToken(env);
        const viewer = ghToken ? await fetchGitHubViewer(ghToken, fetchImpl) : null;
        const policyCfg = await readLocalPolicyConfig(repoRoot ?? opts.cwd);
        const judgeKey = providerKeyLookup(policyCfg.providers.judge.provider, env);
        const legacyPath = join(resolveIkigaiConfigDir(env), "credentials.json");
        let legacyNeedsMigration = false;
        if (existsSync(legacyPath)) {
          try {
            const rawLegacy = JSON.parse(readFileSync(legacyPath, "utf8")) as Record<
              string,
              unknown
            >;
            legacyNeedsMigration = Boolean(
              rawLegacy.gemini || rawLegacy.openai || rawLegacy.claude || rawLegacy.github,
            );
          } catch {
            legacyNeedsMigration = false;
          }
        }

        const teamHooksInstalled = Boolean(
          repoRoot &&
            existsSync(join(repoRoot, ".git", "hooks", "pre-commit")) &&
            existsSync(join(repoRoot, ".git", "hooks", "commit-msg")),
        );
        const teamWorkflowInstalled = Boolean(
          repoRoot &&
            (existsSync(join(repoRoot, ".github", "workflows", "lintfixer-pr-bot.yml")) ||
              existsSync(join(repoRoot, ".github", "workflows", "ikigai-pr-bot.yml"))),
        );

        sendJson(res, 200, {
          ok: true,
          version: "0.2.0",
          workspacePath: repoRoot,
          localRepoName: repoRoot ? dirnameBase(repoRoot) : null,
          vaultDir: vault.vaultDir,
          vaultProtection: vault.protection,
          legacyNeedsMigration,
          github: {
            connected: Boolean(viewer),
            source: viewer
              ? vault.unsealSecret("github.oauth")
                ? "oauth-dpapi"
                : "gh/env"
              : "none",
            login: viewer?.login ?? null,
            avatarUrl: viewer?.avatarUrl ?? null,
          },
          activeProvider: {
            judgeProvider: policyCfg.providers.judge.provider,
            judgeModel: policyCfg.providers.judge.model,
            fixerProvider: policyCfg.providers.fixer.provider,
            fixerModel: policyCfg.providers.fixer.model,
            hasJudgeCredential: judgeKey.found,
          },
          teamHooksInstalled,
          teamWorkflowInstalled,
          vaultEntries: vault.listMetadata(),
        });
        return;
      }

      if (pathname === "/api/local/commits" && req.method === "GET") {
        if (!repoRoot) {
          sendJson(res, 200, { ok: true, commits: [] });
          return;
        }
        const commits = await listLocalGitCommits(repoRoot, 15).catch(() => []);
        sendJson(res, 200, { ok: true, commits });
        return;
      }

      if (pathname === "/api/github/search" && req.method === "GET") {
        const q = parsedUrl.searchParams.get("q")?.trim() ?? "";
        const sortParam = parsedUrl.searchParams.get("sort");
        const sort = sortParam === "updated" ? "updated" : "stars";
        const token = await resolveActiveGitHubToken(env);
        const gh = createGitHubExplorerClient(token, fetchImpl);
        const repos = await gh.searchRepositories(q, { sort, perPage: 12 });
        sendJson(res, 200, { ok: true, repos });
        return;
      }

      if (pathname === "/api/github/user-repos" && req.method === "GET") {
        const token = await resolveActiveGitHubToken(env);
        if (!token) {
          sendJson(res, 400, {
            ok: false,
            error: "Conecte GitHub no Cofre para listar seus repositórios.",
          });
          return;
        }
        const gh = createGitHubExplorerClient(token, fetchImpl);
        const repos = await gh.listUserRepositories(18);
        sendJson(res, 200, { ok: true, repos });
        return;
      }

      if (pathname === "/api/github/repo/commits" && req.method === "GET") {
        const full = parsedUrl.searchParams.get("repo") ?? "";
        const branch = parsedUrl.searchParams.get("branch") ?? undefined;
        const [owner, name] = full.split("/");
        if (!owner || !name) {
          sendJson(res, 400, { ok: false, error: "INVALID_REPO_NAME" });
          return;
        }
        const token = await resolveActiveGitHubToken(env);
        const gh = createGitHubExplorerClient(token, fetchImpl);
        const commits = await gh.listRepoCommits(owner, name, {
          ...(branch ? { branch } : {}),
          perPage: 15,
        });
        sendJson(res, 200, { ok: true, commits });
        return;
      }

      if (pathname === "/api/github/repo/pulls" && req.method === "GET") {
        const full = parsedUrl.searchParams.get("repo") ?? "";
        const [owner, name] = full.split("/");
        if (!owner || !name) {
          sendJson(res, 400, { ok: false, error: "INVALID_REPO_NAME" });
          return;
        }
        const token = await resolveActiveGitHubToken(env);
        const gh = createGitHubExplorerClient(token, fetchImpl);
        const pulls = await gh.listRepoPulls(owner, name, 10);
        sendJson(res, 200, { ok: true, pulls });
        return;
      }

      if (pathname === "/api/analyze/commit" && req.method === "POST") {
        const body = await readJsonBody<{
          source?: "local" | "github";
          sha?: string;
          repoFullName?: string;
          defaultBranch?: string;
          runSemantic?: boolean;
          generateFix?: boolean;
        }>(req);

        const source = body.source ?? "local";
        const sha = body.sha?.trim() || "HEAD";
        emitPipeline("SCAN", `Carregando commit ${sha.slice(0, 7)}`);

        let turnBundle: { turn: Turn; commit: unknown; unifiedDiff: string };
        let policySource: PolicySourcePort;
        let policyOriginLabel = "lintfixer-default";
        let patchApplier: PatchApplierPort;
        let activeRepoLabel = repoRoot ? dirnameBase(repoRoot) : "workspace";

        if (source === "github") {
          const full = body.repoFullName?.trim() ?? "";
          const [owner, name] = full.split("/");
          if (!owner || !name) {
            sendJson(res, 400, { ok: false, error: "INVALID_GITHUB_REPO" });
            return;
          }
          activeRepoLabel = full;
          const token = await resolveActiveGitHubToken(env);
          const gh = createGitHubExplorerClient(token, fetchImpl);
          turnBundle = await gh.fetchCommitTurn(owner, name, sha);
          const remotePolicy = await gh.readProtectedBasePolicy(
            owner,
            name,
            body.defaultBranch ?? "main",
          );
          policyOriginLabel = remotePolicy.source;
          policySource = {
            readRules: async () => remotePolicy.rulesText ?? DEFAULT_STARTER_RULES,
            readConfig: async () => remotePolicy.configText,
          };
          patchApplier = {
            readTargetFiles: (paths) => gh.fetchFilesAtRef(owner, name, sha, paths),
            applyValidatedPatch: async () => {
              throw new Error("Remote GitHub files are read-only; copy or apply locally.");
            },
          };
        } else {
          if (!repoRoot) {
            sendJson(res, 400, { ok: false, error: "NO_LOCAL_GIT_WORKSPACE" });
            return;
          }
          turnBundle = await getLocalCommitTurn(repoRoot, sha);
          policySource = existsSync(join(repoRoot, ".git"))
            ? createGitRefPolicySource(repoRoot, "HEAD")
            : createFsPolicySource(repoRoot);
          policyOriginLabel = existsSync(join(repoRoot, ".ikigai", "rules.md"))
            ? "repo-base-branch"
            : "lintfixer-default";
          patchApplier = createSafePatchApplier(repoRoot);
        }

        const rulesText = (await policySource.readRules()) ?? DEFAULT_STARTER_RULES;
        const parsedRulesResult = parseRules(rulesText);
        const rules = parsedRulesResult.flatMap((r) => (r.status === "PARSED" ? [r.rule] : []));
        const configText = await policySource.readConfig();
        const cfgParsed = parsePolicyConfig(configText);
        const config = cfgParsed.status === "PARSED" ? cfgParsed.config : DEFAULT_POLICY_CONFIG;

        const detScore = computeGitScore({
          commitMessage: turnBundle.turn.task,
          files: turnBundle.turn.files,
          rules,
        });

        emitPipeline(
          "FILTER",
          `Filtro barato concluído (${detScore.filter.inScopeCount}/${detScore.filter.totalFiles} arquivos)`,
          {
            inScopeFiles: detScore.filter.inScopeCount,
            totalFiles: detScore.filter.totalFiles,
          },
        );

        let finalReview: Awaited<ReturnType<typeof reviewTurn>>["review"] | null = null;
        let fixCandidate: {
          status: "VERIFIED_PATCH" | "NO_FIX_NEEDED" | "REJECTED" | "SKIPPED" | "FAILED";
          unifiedPatch: string | null;
          recheckOutcome: string | null;
          summary: string;
        } | null = null;
        let providerError: string | null = null;

        if (body.runSemantic) {
          emitPipeline("LINT", `Executando judge semântico (${config.providers.judge.model})`);
          const provider =
            opts.providerOverride ??
            createMultiProvider({
              ...(repoRoot ? { repoRoot } : {}),
              workingDir: repoRoot ?? opts.cwd,
              env,
              fetchImpl,
            });

          const reviewOut = await reviewTurn(turnBundle.turn, {
            policy: policySource,
            provider,
            memory: createMemoryOutbox(resolveIkigaiDataDir(env)),
            projectScope: activeRepoLabel,
            nonceFactory: () => randomBytes(12).toString("hex"),
          });
          finalReview = reviewOut.review;

          const failedEntry = finalReview.entries.find((e) => e.outcome === "UNAVAILABLE");
          if (failedEntry && failedEntry.kind === "REVIEW") {
            providerError = failedEntry.message;
          } else if (failedEntry && "reason" in failedEntry && failedEntry.reason) {
            providerError = String(failedEntry.reason);
          }

          if (body.generateFix) {
            emitPipeline("FIX", `Gerando e verificando Auto-Fix seguro`);
            const fixOut = await runAutoFix(
              turnBundle.turn,
              finalReview,
              reviewOut.rules,
              reviewOut.config,
              {
                policy: policySource,
                provider,
                patchApplier,
                workingDir: repoRoot ?? opts.cwd,
                applyChanges: false,
                projectScope: activeRepoLabel,
                nonceFactory: () => randomBytes(12).toString("hex"),
              },
            );

            if (fixOut.status === "PROPOSED" || fixOut.status === "APPLIED_VERIFIED") {
              fixCandidate = {
                status: "VERIFIED_PATCH",
                unifiedPatch: fixOut.patchText,
                recheckOutcome: fixOut.recheckReview?.aggregateOutcome ?? "PASS",
                summary: fixOut.summary,
              };
            } else if (fixOut.status === "NO_FIX_NEEDED") {
              fixCandidate = {
                status: "NO_FIX_NEEDED",
                unifiedPatch: null,
                recheckOutcome: null,
                summary: fixOut.summary,
              };
            } else {
              fixCandidate = {
                status: "FAILED",
                unifiedPatch: fixOut.patchText,
                recheckOutcome: null,
                summary: fixOut.summary,
              };
              providerError = fixOut.summary;
            }
          }
        }

        const gitScore = computeGitScore({
          commitMessage: turnBundle.turn.task,
          files: turnBundle.turn.files,
          rules,
          review: finalReview,
          hasVerifiedFix: fixCandidate?.status === "VERIFIED_PATCH",
        });

        emitPipeline("DONE", `Git Score ${gitScore.score}/100 pronto`);

        sendJson(res, 200, {
          ok: true,
          source,
          repoFullName: activeRepoLabel,
          policySource: policyOriginLabel,
          commit: turnBundle.commit,
          unifiedDiff: turnBundle.unifiedDiff,
          files: turnBundle.turn.files,
          gitScore,
          review: finalReview
            ? {
                aggregateOutcome: finalReview.aggregateOutcome,
                entries: finalReview.entries,
                redactedSecretsCount: finalReview.redactedSecretsCount,
              }
            : null,
          fixCandidate,
          providerError,
        });
        return;
      }

      if (pathname === "/api/apply/fix" && req.method === "POST") {
        if (!repoRoot) {
          sendJson(res, 400, { ok: false, error: "NO_LOCAL_REPO" });
          return;
        }
        const body = await readJsonBody<{ patch?: string }>(req);
        if (!body.patch?.trim()) {
          sendJson(res, 400, { ok: false, error: "MISSING_PATCH" });
          return;
        }
        const parsedDiff = parseUnifiedDiff(body.patch);
        if (parsedDiff.status === "INVALID") {
          sendJson(res, 400, { ok: false, error: `INVALID_PATCH:${parsedDiff.reason}` });
          return;
        }
        const cfg = await readLocalPolicyConfig(repoRoot);
        const applier = createSafePatchApplier(repoRoot);
        const paths = parsedDiff.files.map((f) => f.path);
        const currentFiles = await applier.readTargetFiles(paths);
        const verification = verifyProposedPatch(body.patch, currentFiles, {
          allowedPaths: paths,
          fixConfig: cfg.fix,
        });
        if (verification.status === "REJECTED") {
          sendJson(res, 400, { ok: false, error: `${verification.code}: ${verification.reason}` });
          return;
        }
        const edits = new Map(verification.edits.map((e) => [e.path, e.updatedContent]));
        await applier.applyValidatedPatch(edits);
        sendJson(res, 200, {
          ok: true,
          message: `Patch verificado aplicado em ${verification.edits.length} arquivo(s) locais.`,
        });
        return;
      }

      if (pathname === "/api/commit-lint" && req.method === "POST") {
        if (!repoRoot) {
          sendJson(res, 400, { ok: false, error: "NO_LOCAL_REPO" });
          return;
        }
        const stagedDiff = await getStagedDiff(repoRoot);
        if (!stagedDiff) {
          sendJson(res, 200, {
            ok: true,
            summary: "Nenhum arquivo staged para validar neste momento.",
          });
          return;
        }
        const parsed = parseUnifiedDiff(stagedDiff);
        if (parsed.status === "INVALID" || parsed.files.length === 0) {
          sendJson(res, 200, {
            ok: true,
            summary: "Nenhum arquivo staged para validar neste momento.",
          });
          return;
        }
        const provider =
          opts.providerOverride ??
          createMultiProvider({ repoRoot, workingDir: repoRoot, env, fetchImpl });
        const result = await lintCommit("chore(lintfixer): staged validation", parsed.files, {
          policy: createFsPolicySource(repoRoot),
          provider,
          nonceFactory: () => randomBytes(12).toString("hex"),
        });
        sendJson(res, 200, {
          ok: true,
          summary: `Commit staged avaliado: ${result.outcome} (Match=${result.semanticMatchOutcome})`,
        });
        return;
      }

      if (pathname === "/api/team/install-hooks" && req.method === "POST") {
        if (!repoRoot || !existsSync(join(repoRoot, ".git"))) {
          sendJson(res, 400, { ok: false, error: "NOT_A_GIT_REPO" });
          return;
        }
        const hooksDir = join(repoRoot, ".git", "hooks");
        mkdirSync(hooksDir, { recursive: true });
        const preCommit = join(hooksDir, "pre-commit");
        const commitMsg = join(hooksDir, "commit-msg");
        writeFileSync(preCommit, "#!/usr/bin/env sh\nnpx lintfixer check --staged\n", {
          encoding: "utf8",
          mode: 0o755,
        });
        writeFileSync(commitMsg, '#!/usr/bin/env sh\nnpx lintfixer commit-lint --msg-file "$1"\n', {
          encoding: "utf8",
          mode: 0o755,
        });
        try {
          chmodSync(preCommit, 0o755);
          chmodSync(commitMsg, 0o755);
        } catch {
          // Windows ACL handling
        }
        sendJson(res, 200, {
          ok: true,
          message: "Hooks pre-commit e commit-msg instalados no .git/hooks (zero chaves no repo).",
        });
        return;
      }

      if (pathname === "/api/team/install-workflow" && req.method === "POST") {
        if (!repoRoot) {
          sendJson(res, 400, { ok: false, error: "NO_LOCAL_REPO" });
          return;
        }
        const wfDir = join(repoRoot, ".github", "workflows");
        mkdirSync(wfDir, { recursive: true });
        const wfPath = join(wfDir, "lintfixer-pr-bot.yml");
        writeFileSync(
          wfPath,
          `name: LintFixer Semantic PR Bot

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  lintfixer-review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: "24"
      - name: Run LintFixer PR Guard
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          GEMINI_API_KEY: \${{ secrets.GEMINI_API_KEY }}
          OPENAI_API_KEY: \${{ secrets.OPENAI_API_KEY }}
        run: npx --yes lintfixer pr review --repo "\${{ github.repository }}" --pr "\${{ github.event.pull_request.number }}" --fix --json
`,
          "utf8",
        );
        sendJson(res, 200, {
          ok: true,
          message:
            "Workflow .github/workflows/lintfixer-pr-bot.yml criado (chaves só via Secrets).",
        });
        return;
      }

      if (pathname === "/api/calibrate/run" && req.method === "POST") {
        const body = await readJsonBody<{
          corpusKey?: string;
          repeats?: number;
          threshold?: number;
        }>(req);
        const rootDir = repoRoot ?? opts.cwd;
        const corpusFileName =
          body.corpusKey === "live-gemini-corpus"
            ? "live-gemini-corpus.json"
            : "calibration-corpus.json";
        const candidatePaths = [
          join(rootDir, "examples", corpusFileName),
          resolve(dirname(fileURLToPath(import.meta.url)), "examples", corpusFileName),
          resolve(dirname(fileURLToPath(import.meta.url)), "../../examples", corpusFileName),
        ];
        const corpusFile = candidatePaths.find((p) => existsSync(p));

        if (!corpusFile) {
          sendJson(res, 404, { ok: false, error: `CORPUS_NOT_FOUND:${corpusFileName}` });
          return;
        }

        const rawCorpus = JSON.parse(readFileSync(corpusFile, "utf8")) as {
          threshold?: number;
          cases: readonly {
            fixtureId: string;
            ruleId: string;
            authorLabel: "VIOLATION" | "NO_VIOLATION";
            task: string;
            diff: string;
            ruleSummary?: string;
            violationCriteria?: string;
            allowedCriteria?: string;
            scopedPath?: string;
            precomputedProbability?: number;
            precomputedConfidence?: number;
            sliceProbabilities?: readonly number[];
            rationale?: string;
          }[];
        };

        const threshold = Number(body.threshold) || rawCorpus.threshold || 0.7;
        const repeats = Math.max(1, Math.min(3, Number(body.repeats) || 1));
        const cfg = await readLocalPolicyConfig(repoRoot ?? opts.cwd);
        const provider =
          opts.providerOverride ??
          createMultiProvider({
            ...(repoRoot ? { repoRoot } : {}),
            workingDir: rootDir,
            env,
            fetchImpl,
          });

        const samples: CalibrationSample[] = [];
        for (const item of rawCorpus.cases) {
          const itemReps = item.precomputedProbability !== undefined ? 1 : repeats;
          for (let r = 1; r <= itemReps; r += 1) {
            if (item.precomputedProbability !== undefined) {
              samples.push({
                fixtureId: item.fixtureId,
                ruleId: item.ruleId,
                authorLabel: item.authorLabel,
                probability: item.precomputedProbability,
                confidence: item.precomputedConfidence ?? 0.9,
                outcome: item.precomputedProbability >= threshold ? "FAIL" : "PASS",
                repeat: r,
                ...(item.sliceProbabilities ? { sliceProbabilities: item.sliceProbabilities } : {}),
                ...(item.scopedPath ? { scopedPath: item.scopedPath } : {}),
                ...(item.rationale ? { rationale: item.rationale } : {}),
              });
              continue;
            }
            const safeTask = redactSecrets(item.task);
            const safeDiff = redactSecrets(item.diff);
            const resJudge = await provider.judgeRuleSlice({
              kind: "RULE",
              checkId: item.ruleId,
              ruleSummary: item.ruleSummary ?? `Policy rule ${item.ruleId}`,
              violationCriteria: item.violationCriteria ?? "Change violates rule.",
              allowedCriteria: item.allowedCriteria ?? null,
              task: safeTask.text,
              files: [item.scopedPath ?? "src/sample.ts"],
              diff: safeDiff.text,
              nonce: randomBytes(12).toString("hex"),
              endpoint: cfg.providers.judge,
            });
            samples.push({
              fixtureId: item.fixtureId,
              ruleId: item.ruleId,
              authorLabel: item.authorLabel,
              probability: resJudge.status === "OK" ? resJudge.judgment.violationProbability : null,
              confidence: resJudge.status === "OK" ? resJudge.judgment.confidence : null,
              outcome:
                resJudge.status === "OK"
                  ? resJudge.judgment.violationProbability >= threshold
                    ? "FAIL"
                    : "PASS"
                  : "UNAVAILABLE",
              repeat: r,
              ...(item.scopedPath ? { scopedPath: item.scopedPath } : {}),
              ...(resJudge.status === "OK" ? { rationale: resJudge.judgment.rationale } : {}),
            });
          }
        }

        const matrix = computeConfusionMatrix(samples, threshold);
        const metrics = computeDerivedMetrics(samples, threshold);
        const stability = computeRepeatStability(samples, threshold);
        const aggs = compareSliceAggregations(samples, threshold);
        const suggestions = suggestAllowedRefinements(samples, threshold);

        const avgFlip =
          stability.length > 0
            ? stability.reduce((acc, s) => acc + (s.flipRate ?? 0), 0) / stability.length
            : 0;

        sendJson(res, 200, {
          ok: true,
          corpusName: body.corpusKey ?? "calibration-corpus",
          summary: {
            sampleCount: samples.length,
            repeatCount: repeats,
            threshold,
            matrix: {
              tp: matrix.truePositive,
              fp: matrix.falsePositive,
              tn: matrix.trueNegative,
              fn: matrix.falseNegative,
            },
            precision: metrics.precision ?? 0,
            recall: metrics.recall ?? 0,
            f1: metrics.f1 ?? 0,
            brierScore: metrics.brierScore ?? 0,
            ece: metrics.ece ?? 0,
            flipRate: avgFlip,
          },
          aggregations: aggs.map((a) => ({
            mode: a.mode,
            precision: a.metrics.precision ?? 0,
            recall: a.metrics.recall ?? 0,
            f1: a.metrics.f1 ?? 0,
          })),
          allowedSuggestions: suggestions.map((s) => ({
            ruleId: s.ruleId,
            suggestion: s.candidateAllowedText,
            reason: `${s.falsePositiveCount} falso(s) positivo(s) em ${s.affectedPaths.join(", ")}`,
          })),
        });
        return;
      }

      if (pathname === "/api/vault/secret" && (req.method === "POST" || req.method === "DELETE")) {
        const body = await readJsonBody<{ namespace?: string; secret?: string }>(req);
        if (!body.namespace || !VALID_VAULT_NAMESPACES.has(body.namespace as VaultNamespace)) {
          sendJson(res, 400, { ok: false, error: "INVALID_VAULT_NAMESPACE" });
          return;
        }
        const vault = createEncryptedVault({ env });
        const ns = body.namespace as VaultNamespace;
        if (req.method === "DELETE") {
          vault.deleteSecret(ns);
          sendJson(res, 200, { ok: true });
          return;
        }
        if (!body.secret || body.secret.trim().length < 4) {
          sendJson(res, 400, { ok: false, error: "INVALID_SECRET" });
          return;
        }
        vault.setSecret(ns, body.secret.trim());
        sendJson(res, 200, { ok: true, entry: vault.getMetadata(ns) });
        return;
      }

      if (pathname === "/api/vault/import-gh" && req.method === "POST") {
        const ghToken = await importGhCliToken();
        if (!ghToken) {
          sendJson(res, 400, {
            ok: false,
            error: "Nenhum token ativo no `gh` CLI. Execute `gh auth login` no terminal.",
          });
          return;
        }
        const viewer = await fetchGitHubViewer(ghToken, fetchImpl);
        if (!viewer) {
          sendJson(res, 400, { ok: false, error: "Token do `gh` CLI recusado pelo GitHub." });
          return;
        }
        const vault = createEncryptedVault({ env });
        vault.setSecret("github.oauth", ghToken);
        sendJson(res, 200, { ok: true, login: viewer.login });
        return;
      }

      if (pathname === "/api/vault/migrate-legacy" && req.method === "POST") {
        clearMasterKeyMemoryCacheForTests();
        const migrated = migrateLegacyCredentialsToVault(env);
        sendJson(res, 200, { ok: true, ...migrated });
        return;
      }

      if (pathname === "/api/github/device/start" && req.method === "POST") {
        const body = await readJsonBody<{ clientId?: string; scope?: string }>(req);
        const start = await startGitHubDeviceFlow({
          clientId: body.clientId ?? "",
          ...(body.scope ? { scope: body.scope } : {}),
          fetchImpl,
        });
        sendJson(res, 200, { ok: true, ...start });
        return;
      }

      if (pathname === "/api/github/device/poll" && req.method === "POST") {
        const body = await readJsonBody<{ clientId?: string; deviceCode?: string }>(req);
        const poll = await pollGitHubDeviceFlow({
          clientId: body.clientId ?? "",
          deviceCode: body.deviceCode ?? "",
          fetchImpl,
        });
        if (poll.status === "authorized") {
          const vault = createEncryptedVault({ env });
          vault.setSecret("github.oauth", poll.accessToken);
          const viewer = await fetchGitHubViewer(poll.accessToken, fetchImpl);
          sendJson(res, 200, {
            ok: true,
            status: "authorized",
            login: viewer?.login ?? "github-user",
          });
          return;
        }
        sendJson(res, 200, { ok: true, ...poll });
        return;
      }

      sendJson(res, 404, { ok: false, error: "API_ROUTE_NOT_FOUND" });
      return;
    }

    // 3. Static Asset & React SPA Serving
    if (pathname === "/favicon.ico" || pathname === "/kat-brackets.ico") {
      serveFile(res, join(assetsDir, "kat-brackets.ico"));
      return;
    }

    if (pathname.startsWith("/brand/")) {
      const safeName = pathname.slice("/brand/".length).replace(/[^a-zA-Z0-9._-]/g, "");
      const candidate = join(assetsDir, safeName);
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        serveFile(res, candidate);
        return;
      }
    }

    // Attach HttpOnly SameSite=Strict session cookie on document entry so subsequent fetches work cleanly.
    const queryToken = parsedUrl.searchParams.get("token");
    if (pathname === "/" && queryToken && safeTokenEquals(queryToken, sessionToken)) {
      res.setHeader("Set-Cookie", `lf_session=${sessionToken}; HttpOnly; SameSite=Strict; Path=/`);
    }

    const cleanRel = normalize(pathname === "/" ? "index.html" : pathname.replace(/^\/+/, ""));
    if (cleanRel.includes("..")) {
      sendJson(res, 403, { ok: false, error: "FORBIDDEN" });
      return;
    }

    const target = join(uiDistDir, cleanRel);
    if (existsSync(target) && statSync(target).isFile()) {
      serveFile(res, target);
      return;
    }

    // SPA fallback to index.html
    const indexPath = join(uiDistDir, "index.html");
    if (existsSync(indexPath)) {
      serveFile(res, indexPath);
      return;
    }

    sendJson(res, 503, {
      ok: false,
      error: "Desktop UI bundle not found. Run `pnpm --filter @ikigai/desktop-ui build`.",
    });
  }

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        boundPort = addr.port;
      }
      resolveListen();
    });
  });

  const url = `http://127.0.0.1:${boundPort}/?token=${sessionToken}`;
  return {
    url,
    port: boundPort,
    sessionToken,
    close: () =>
      new Promise<void>((resolveClose) => {
        for (const client of sseClients) {
          client.end();
        }
        sseClients.clear();
        server.close(() => resolveClose());
      }),
  };
}

async function resolveActiveGitHubToken(env: NodeJS.ProcessEnv): Promise<string | null> {
  const resolved = resolveCredential("github", undefined, env);
  if (resolved.found && resolved.value) {
    return resolved.value;
  }
  return resolveGitHubToken(env);
}

function providerKeyLookup(provider: string, env: NodeJS.ProcessEnv) {
  if (
    provider === "openai" ||
    provider === "gemini" ||
    provider === "claude" ||
    provider === "jev"
  ) {
    return resolveCredential(provider, undefined, env);
  }
  return { found: provider === "cli", source: "missing" as const, value: null };
}

async function readLocalPolicyConfig(repoRoot: string | null): Promise<PolicyConfig> {
  if (!repoRoot) return DEFAULT_POLICY_CONFIG;
  const cfgPath = join(repoRoot, ".ikigai", "config.yaml");
  if (!existsSync(cfgPath)) return DEFAULT_POLICY_CONFIG;
  const parsed = parsePolicyConfig(readFileSync(cfgPath, "utf8"));
  return parsed.status === "PARSED" ? parsed.config : DEFAULT_POLICY_CONFIG;
}

function dirnameBase(pathStr: string): string {
  const parts = pathStr.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? pathStr;
}

function extractCookie(cookieHeader: string, key: string): string | null {
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === key) {
      return rest.join("=").trim() || null;
    }
  }
  return null;
}

function safeTokenEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length === 0 || bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function serveFile(res: ServerResponse, filePath: string): void {
  const ext = extname(filePath).toLowerCase();
  const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";
  const content = readFileSync(filePath);
  res.writeHead(200, {
    "content-type": mime,
    "content-length": String(content.length),
    "cache-control":
      ext === ".ttf" || ext === ".woff2" ? "public, max-age=31536000, immutable" : "no-store",
  });
  res.end(content);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

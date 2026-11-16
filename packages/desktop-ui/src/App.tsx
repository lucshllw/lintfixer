import { Activity, BarChart3, GitCompare, KeyRound, Play, Search, Settings2 } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { BootIntroOverlay } from "./components/BootIntroOverlay.tsx";
import { GitHubExploreView } from "./components/GitHubExploreView.tsx";
import { KatBracketsLogo } from "./components/KatBracketsLogo.tsx";
import { ScoreRackStrip } from "./components/ScoreRackStrip.tsx";
import { apiRequest, bootstrapSessionToken, subscribePipelineEvents } from "./lib/api-client.ts";

const DiffFixView = lazy(() =>
  import("./components/DiffFixView.tsx").then((m) => ({ default: m.DiffFixView })),
);
const CalibrationView = lazy(() =>
  import("./components/CalibrationView.tsx").then((m) => ({ default: m.CalibrationView })),
);
const VaultView = lazy(() =>
  import("./components/VaultView.tsx").then((m) => ({ default: m.VaultView })),
);
const SetupWizardModal = lazy(() =>
  import("./components/SetupWizardModal.tsx").then((m) => ({ default: m.SetupWizardModal })),
);
import type {
  AnalysisResponse,
  BootstrapState,
  CalibrationReportView,
  CommitItem,
  PipelineEventPayload,
  PullItem,
  RepoItem,
  TabId,
  VaultEntryMeta,
} from "./types/api.ts";

const INITIAL_PIPELINE: PipelineEventPayload = {
  stage: "IDLE",
  detail: "Aguardando analise",
  timestamp: "",
};

const EMPTY_BOOTSTRAP: BootstrapState = {
  ok: true,
  version: "0.2.0",
  workspacePath: null,
  localRepoName: null,
  vaultDir: "%LOCALAPPDATA%/LintFixer/vault",
  vaultProtection: "dpapi-current-user",
  legacyNeedsMigration: false,
  github: { connected: false, source: "none", login: null, avatarUrl: null },
  activeProvider: {
    judgeProvider: "gemini",
    judgeModel: "gemini-4-hydrogen",
    fixerProvider: "gemini",
    fixerModel: "gemini-4-hydrogen",
    hasJudgeCredential: false,
  },
  teamHooksInstalled: false,
  teamWorkflowInstalled: false,
  vaultEntries: [],
};

export function App() {
  const urlParams = new URLSearchParams(window.location.search);
  const skipIntroParam = urlParams.get("no-intro") === "1";
  const openSetupParam = urlParams.get("setup") === "1";

  const [tab, setTab] = useState<TabId>("github");
  const [showIntro, setShowIntro] = useState(!skipIntroParam);
  const [setupOpen, setSetupOpen] = useState(openSetupParam);
  const [bootstrap, setBootstrap] = useState<BootstrapState>(EMPTY_BOOTSTRAP);

  const [sourceMode, setSourceMode] = useState<"local" | "github">("local");
  const [repos, setRepos] = useState<readonly RepoItem[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<RepoItem | null>(null);
  const [commits, setCommits] = useState<readonly CommitItem[]>([]);
  const [pulls, setPulls] = useState<readonly PullItem[]>([]);
  const [selectedCommitSha, setSelectedCommitSha] = useState<string | null>(null);

  const [analysis, setAnalysis] = useState<AnalysisResponse | null>(null);
  const [calibration, setCalibration] = useState<CalibrationReportView | null>(null);
  const [pipeline, setPipeline] = useState<PipelineEventPayload>(INITIAL_PIPELINE);

  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);

  const refreshBootstrap = useCallback(async () => {
    const data = await apiRequest<BootstrapState>("/api/bootstrap");
    setBootstrap(data);
    return data;
  }, []);

  const inspectCommit = useCallback(
    async (opts: {
      source: "local" | "github";
      sha: string;
      repoFullName?: string;
      defaultBranch?: string;
      runSemantic?: boolean;
      generateFix?: boolean;
    }) => {
      setBusy(true);
      setSelectedCommitSha(opts.sha);
      try {
        const res = await apiRequest<AnalysisResponse>("/api/analyze/commit", {
          method: "POST",
          body: JSON.stringify({
            source: opts.source,
            sha: opts.sha,
            repoFullName: opts.repoFullName,
            defaultBranch: opts.defaultBranch,
            runSemantic: opts.runSemantic ?? false,
            generateFix: opts.generateFix ?? false,
          }),
        });
        setAnalysis(res);
        setTab("diff");
      } catch (err) {
        setStatusNotice(err instanceof Error ? err.message : "Erro ao analisar commit");
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const loadLocalWorkspace = useCallback(async () => {
    setSourceMode("local");
    setSelectedRepo(null);
    setPulls([]);
    try {
      const data = await apiRequest<{ commits: readonly CommitItem[] }>("/api/local/commits");
      setCommits(data.commits);
      if (data.commits[0]) {
        await inspectCommit({ source: "local", sha: data.commits[0].sha });
        setTab("github");
      }
    } catch {
      setCommits([]);
    }
  }, [inspectCommit]);

  useEffect(() => {
    bootstrapSessionToken();
    const unsubscribe = subscribePipelineEvents((ev) => {
      setPipeline(ev);
    });

    void (async () => {
      try {
        const boot = await refreshBootstrap();
        if (boot.github.connected) {
          const mine = await apiRequest<{ repos: readonly RepoItem[] }>(
            "/api/github/user-repos",
          ).catch(() => ({ repos: [] as readonly RepoItem[] }));
          setRepos(mine.repos);
        }
        if (boot.localRepoName) {
          await loadLocalWorkspace();
        }
      } catch {
        // Standalone render safe guard.
      }
    })();

    return unsubscribe;
  }, [loadLocalWorkspace, refreshBootstrap]);

  const handleSearchGitHub = async (query: string) => {
    setSearching(true);
    try {
      const res = await apiRequest<{ repos: readonly RepoItem[] }>(
        `/api/github/search?q=${encodeURIComponent(query)}`,
      );
      setRepos(res.repos);
      setStatusNotice(`${res.repos.length} repositório(s) encontrado(s) no GitHub`);
    } catch (err) {
      setStatusNotice(err instanceof Error ? err.message : "Falha na busca GitHub");
    } finally {
      setSearching(false);
    }
  };

  const handleLoadMyRepos = async () => {
    setSearching(true);
    try {
      const res = await apiRequest<{ repos: readonly RepoItem[] }>("/api/github/user-repos");
      setRepos(res.repos);
      setStatusNotice(`${res.repos.length} repositório(s) da conta carregados`);
    } catch (err) {
      setStatusNotice(err instanceof Error ? err.message : "Conecte GitHub no Cofre primeiro");
    } finally {
      setSearching(false);
    }
  };

  const handleSelectRemoteRepo = async (repo: RepoItem) => {
    setSourceMode("github");
    setSelectedRepo(repo);
    setBusy(true);
    try {
      const [cRes, pRes] = await Promise.all([
        apiRequest<{ commits: readonly CommitItem[] }>(
          `/api/github/repo/commits?repo=${encodeURIComponent(repo.fullName)}&branch=${encodeURIComponent(repo.defaultBranch)}`,
        ),
        apiRequest<{ pulls: readonly PullItem[] }>(
          `/api/github/repo/pulls?repo=${encodeURIComponent(repo.fullName)}`,
        ).catch(() => ({ pulls: [] as readonly PullItem[] })),
      ]);
      setCommits(cRes.commits);
      setPulls(pRes.pulls);
      if (cRes.commits[0]) {
        const res = await apiRequest<AnalysisResponse>("/api/analyze/commit", {
          method: "POST",
          body: JSON.stringify({
            source: "github",
            sha: cRes.commits[0].sha,
            repoFullName: repo.fullName,
            defaultBranch: repo.defaultBranch,
            runSemantic: false,
            generateFix: false,
          }),
        });
        setSelectedCommitSha(cRes.commits[0].sha);
        setAnalysis(res);
      }
    } catch (err) {
      setStatusNotice(err instanceof Error ? err.message : "Erro ao abrir repositório");
    } finally {
      setBusy(false);
    }
  };

  const handleInspectCommit = async (sha: string) => {
    await inspectCommit({
      source: sourceMode,
      sha,
      ...(selectedRepo
        ? { repoFullName: selectedRepo.fullName, defaultBranch: selectedRepo.defaultBranch }
        : {}),
    });
  };

  const handleRunSemantic = async () => {
    if (!analysis) return;
    await inspectCommit({
      source: analysis.source,
      sha: analysis.commit.sha,
      ...(analysis.source === "github" && selectedRepo
        ? { repoFullName: selectedRepo.fullName, defaultBranch: selectedRepo.defaultBranch }
        : {}),
      runSemantic: true,
      generateFix: false,
    });
  };

  const handleGenerateFix = async () => {
    if (!analysis) return;
    await inspectCommit({
      source: analysis.source,
      sha: analysis.commit.sha,
      ...(analysis.source === "github" && selectedRepo
        ? { repoFullName: selectedRepo.fullName, defaultBranch: selectedRepo.defaultBranch }
        : {}),
      runSemantic: true,
      generateFix: true,
    });
  };

  const handleApplyLocalFix = async () => {
    if (!analysis?.fixCandidate?.unifiedPatch) return;
    setBusy(true);
    try {
      const res = await apiRequest<{ ok: boolean; message: string }>("/api/apply/fix", {
        method: "POST",
        body: JSON.stringify({ patch: analysis.fixCandidate.unifiedPatch }),
      });
      setStatusNotice(res.message);
      await refreshBootstrap();
    } catch (err) {
      setStatusNotice(err instanceof Error ? err.message : "Falha ao aplicar patch local");
    } finally {
      setBusy(false);
    }
  };

  const handleTestStagedCommit = async () => {
    setBusy(true);
    try {
      const res = await apiRequest<{ ok: boolean; summary: string }>("/api/commit-lint", {
        method: "POST",
        body: JSON.stringify({}),
      });
      setStatusNotice(res.summary);
    } catch (err) {
      setStatusNotice(err instanceof Error ? err.message : "Sem staged diff no workspace");
    } finally {
      setBusy(false);
    }
  };

  const handleInstallTeamHooks = async () => {
    setBusy(true);
    try {
      const res = await apiRequest<{ message: string }>("/api/team/install-hooks", {
        method: "POST",
        body: JSON.stringify({}),
      });
      setStatusNotice(res.message);
      await refreshBootstrap();
    } catch (err) {
      setStatusNotice(err instanceof Error ? err.message : "Falha ao instalar hooks");
    } finally {
      setBusy(false);
    }
  };

  const handleInstallTeamWorkflow = async () => {
    setBusy(true);
    try {
      const res = await apiRequest<{ message: string }>("/api/team/install-workflow", {
        method: "POST",
        body: JSON.stringify({}),
      });
      setStatusNotice(res.message);
      await refreshBootstrap();
    } catch (err) {
      setStatusNotice(err instanceof Error ? err.message : "Falha ao gerar workflow PR Bot");
    } finally {
      setBusy(false);
    }
  };

  const handleRunCalibration = async (corpusKey: string, repeats: number, threshold: number) => {
    setBusy(true);
    try {
      const report = await apiRequest<CalibrationReportView>("/api/calibrate/run", {
        method: "POST",
        body: JSON.stringify({ corpusKey, repeats, threshold }),
      });
      setCalibration(report);
    } catch (err) {
      setStatusNotice(err instanceof Error ? err.message : "Falha ao calibrar");
    } finally {
      setBusy(false);
    }
  };

  const handleSaveSecret = async (namespace: VaultEntryMeta["namespace"], secret: string) => {
    setBusy(true);
    try {
      await apiRequest("/api/vault/secret", {
        method: "POST",
        body: JSON.stringify({ namespace, secret }),
      });
      setStatusNotice(`Segredo ${namespace} cifrado com AES-256-GCM + DPAPI`);
      await refreshBootstrap();
    } catch (err) {
      setStatusNotice(err instanceof Error ? err.message : "Falha ao salvar no cofre");
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteSecret = async (namespace: VaultEntryMeta["namespace"]) => {
    setBusy(true);
    try {
      await apiRequest("/api/vault/secret", {
        method: "DELETE",
        body: JSON.stringify({ namespace }),
      });
      setStatusNotice(`Registro ${namespace} removido do cofre`);
      await refreshBootstrap();
    } catch (err) {
      setStatusNotice(err instanceof Error ? err.message : "Falha ao remover do cofre");
    } finally {
      setBusy(false);
    }
  };

  const handleImportGhCli = async () => {
    setBusy(true);
    try {
      const res = await apiRequest<{ login: string }>("/api/vault/import-gh", {
        method: "POST",
        body: JSON.stringify({}),
      });
      setStatusNotice(`Sessão GitHub @${res.login} selada no cofre DPAPI`);
      await refreshBootstrap();
    } catch (err) {
      setStatusNotice(err instanceof Error ? err.message : "gh CLI não autenticado");
    } finally {
      setBusy(false);
    }
  };

  const handleMigrateLegacy = async () => {
    setBusy(true);
    try {
      const res = await apiRequest<{ migratedCount: number }>("/api/vault/migrate-legacy", {
        method: "POST",
        body: JSON.stringify({}),
      });
      setStatusNotice(`${res.migratedCount} credencial(is) migrada(s) para AES-256-GCM + DPAPI`);
      await refreshBootstrap();
    } catch (err) {
      setStatusNotice(err instanceof Error ? err.message : "Falha na migração");
    } finally {
      setBusy(false);
    }
  };

  const activeRepoLabel =
    sourceMode === "github" && selectedRepo
      ? selectedRepo.fullName
      : (bootstrap.localRepoName ?? "sem repo");

  const activeScore = analysis?.gitScore.score ?? null;
  const activeFilterLabel = analysis
    ? `${analysis.gitScore.filter.inScopeCount}/${analysis.gitScore.filter.totalFiles} ARQS`
    : "0/0 ARQS";

  return (
    <>
      <BootIntroOverlay
        visible={showIntro}
        protectionLabel={bootstrap.vaultProtection}
        githubLabel={
          bootstrap.github.connected ? `@${bootstrap.github.login}` : "pronto para vincular"
        }
        onComplete={() => setShowIntro(false)}
      />

      {setupOpen ? (
        <Suspense fallback={null}>
          <SetupWizardModal
            open={setupOpen}
            bootstrap={bootstrap}
            onClose={() => setSetupOpen(false)}
            onImportGhCli={handleImportGhCli}
            onSaveGeminiKey={(key) => handleSaveSecret("llm.gemini", key)}
            onMigrateLegacy={handleMigrateLegacy}
          />
        </Suspense>
      ) : null}

      <div className="rack-shell">
        {/* Top Hardware Header */}
        <header className="topbar">
          <div className="brand-lockup">
            <KatBracketsLogo size={26} scanning={busy} />
            <h1 className="brand-title">
              <span>LintFixer</span>
              <span className="brand-sub">Rack Observatório</span>
            </h1>
          </div>

          <nav className="seg-nav" aria-label="Navegacao principal">
            <button
              type="button"
              className={`seg-tab ${tab === "github" ? "active" : ""}`}
              onClick={() => setTab("github")}
            >
              <Search size={13} aria-hidden="true" />
              <span>GitHub &amp; Git Score</span>
            </button>
            <button
              type="button"
              className={`seg-tab ${tab === "diff" ? "active" : ""}`}
              onClick={() => setTab("diff")}
            >
              <GitCompare size={13} aria-hidden="true" />
              <span>Diff × Fix</span>
            </button>
            <button
              type="button"
              className={`seg-tab ${tab === "calibration" ? "active" : ""}`}
              onClick={() => setTab("calibration")}
            >
              <BarChart3 size={13} aria-hidden="true" />
              <span>Calibração</span>
            </button>
            <button
              type="button"
              className={`seg-tab ${tab === "vault" ? "active" : ""}`}
              onClick={() => setTab("vault")}
            >
              <KeyRound size={13} aria-hidden="true" />
              <span>Cofre Criptografado</span>
            </button>
          </nav>

          <div className="topbar-meta">
            <div className="conn-pill">
              <span className={`led-dot ${bootstrap.github.connected ? "" : "warn"}`} />
              <span>
                {bootstrap.github.connected ? `@${bootstrap.github.login}` : "GitHub offline"} ·
                repo: {activeRepoLabel}
              </span>
            </div>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setShowIntro(true)}
              aria-label="Rever intro animada"
            >
              <Play size={12} aria-hidden="true" />
              <span>Intro</span>
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setSetupOpen(true)}
              aria-label="Abrir setup guiado"
            >
              <Settings2 size={12} aria-hidden="true" />
              <span>Setup</span>
            </button>
          </div>
        </header>

        {/* Live Telemetry & 14-Segment Hardware Git Score Rack */}
        <ScoreRackStrip
          score={activeScore}
          projectedScore={analysis?.gitScore.projectedPostFixScore ?? null}
          mode={analysis?.gitScore.mode ?? null}
          segments={analysis?.gitScore.segments14 ?? []}
          pipeline={pipeline}
          filterLabel={activeFilterLabel}
          canRunSemantic={Boolean(analysis)}
          canGenerateFix={Boolean(analysis)}
          busy={busy}
          onRunSemantic={() => void handleRunSemantic()}
          onGenerateFix={() => void handleGenerateFix()}
        />

        {/* Workspace Router */}
        <main className="workspace-area">
          {tab === "github" ? (
            <GitHubExploreView
              repos={repos}
              selectedRepo={selectedRepo}
              localRepoName={bootstrap.localRepoName}
              sourceMode={sourceMode}
              commits={commits}
              pulls={pulls}
              selectedCommitSha={selectedCommitSha}
              searching={searching}
              busy={busy}
              teamHooksInstalled={bootstrap.teamHooksInstalled}
              teamWorkflowInstalled={bootstrap.teamWorkflowInstalled}
              onSearchGitHub={(q) => void handleSearchGitHub(q)}
              onLoadMyRepos={() => void handleLoadMyRepos()}
              onSelectLocalRepo={() => void loadLocalWorkspace()}
              onSelectRemoteRepo={(repo) => void handleSelectRemoteRepo(repo)}
              onInspectCommit={(sha) => void handleInspectCommit(sha)}
              onInstallTeamHooks={() => void handleInstallTeamHooks()}
              onInstallTeamWorkflow={() => void handleInstallTeamWorkflow()}
            />
          ) : null}

          {tab === "diff" ? (
            <Suspense fallback={null}>
              <DiffFixView
                analysis={analysis}
                busy={busy}
                onApplyLocalFix={() => void handleApplyLocalFix()}
                onTestStagedCommit={() => void handleTestStagedCommit()}
              />
            </Suspense>
          ) : null}

          {tab === "calibration" ? (
            <Suspense fallback={null}>
              <CalibrationView
                report={calibration}
                busy={busy}
                onRunCalibration={(c, r, t) => void handleRunCalibration(c, r, t)}
              />
            </Suspense>
          ) : null}

          {tab === "vault" ? (
            <Suspense fallback={null}>
              <VaultView
                bootstrap={bootstrap}
                busy={busy}
                statusMessage={statusNotice}
                onSaveSecret={handleSaveSecret}
                onDeleteSecret={handleDeleteSecret}
                onImportGhCli={handleImportGhCli}
                onMigrateLegacy={handleMigrateLegacy}
                onStartDeviceFlow={(clientId, scope) =>
                  apiRequest("/api/github/device/start", {
                    method: "POST",
                    body: JSON.stringify({ clientId, scope }),
                  })
                }
                onPollDeviceFlow={async (clientId, deviceCode) => {
                  const res = await apiRequest<{
                    status: string;
                    login?: string;
                    message?: string;
                  }>("/api/github/device/poll", {
                    method: "POST",
                    body: JSON.stringify({ clientId, deviceCode }),
                  });
                  if (res.status === "authorized") {
                    await refreshBootstrap();
                  }
                  return res;
                }}
              />
            </Suspense>
          ) : null}
        </main>

        {/* Bottom Hardware Telemetry Strip */}
        <footer className="bottombar">
          <div className="telemetry-item">
            <span className={`led-dot ${bootstrap.github.connected ? "" : "warn"}`} />
            <span>
              GITHUB OAUTH:{" "}
              {bootstrap.github.connected
                ? `@${bootstrap.github.login} (${bootstrap.github.source})`
                : "Conecte via Cofre"}
            </span>
          </div>

          <div className="telemetry-item">
            <span
              className={`led-dot ${bootstrap.activeProvider.hasJudgeCredential ? "" : "warn"}`}
            />
            <span>
              IA ENGINE: {bootstrap.activeProvider.judgeProvider} /{" "}
              {bootstrap.activeProvider.judgeModel} ({bootstrap.vaultProtection} + AES-256-GCM)
            </span>
          </div>

          <div className="telemetry-item">
            <Activity size={13} color="#22C58B" aria-hidden="true" />
            <span>
              TIME NO COMMIT:{" "}
              {bootstrap.teamHooksInstalled || bootstrap.teamWorkflowInstalled
                ? "Hook local + PR Bot ativos"
                : (statusNotice ?? pipeline.detail)}
            </span>
          </div>
        </footer>
      </div>
    </>
  );
}

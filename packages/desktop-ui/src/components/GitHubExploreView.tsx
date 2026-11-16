import { FolderGit2, GitBranch, GitPullRequest, Search, ShieldCheck, Star } from "lucide-react";
import { useState } from "react";
import type { CommitItem, PullItem, RepoItem } from "../types/api.ts";

interface GitHubExploreViewProps {
  readonly repos: readonly RepoItem[];
  readonly selectedRepo: RepoItem | null;
  readonly localRepoName: string | null;
  readonly sourceMode: "local" | "github";
  readonly commits: readonly CommitItem[];
  readonly pulls: readonly PullItem[];
  readonly selectedCommitSha: string | null;
  readonly searching: boolean;
  readonly busy: boolean;
  readonly teamHooksInstalled: boolean;
  readonly teamWorkflowInstalled: boolean;
  readonly onSearchGitHub: (query: string) => void;
  readonly onLoadMyRepos: () => void;
  readonly onSelectLocalRepo: () => void;
  readonly onSelectRemoteRepo: (repo: RepoItem) => void;
  readonly onInspectCommit: (sha: string) => void;
  readonly onInstallTeamHooks: () => void;
  readonly onInstallTeamWorkflow: () => void;
}

export function GitHubExploreView({
  repos,
  selectedRepo,
  localRepoName,
  sourceMode,
  commits,
  pulls,
  selectedCommitSha,
  searching,
  busy,
  teamHooksInstalled,
  teamWorkflowInstalled,
  onSearchGitHub,
  onLoadMyRepos,
  onSelectLocalRepo,
  onSelectRemoteRepo,
  onInspectCommit,
  onInstallTeamHooks,
  onInstallTeamWorkflow,
}: GitHubExploreViewProps) {
  const [query, setQuery] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim()) {
      onSearchGitHub(query.trim());
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, flex: 1, minHeight: 0 }}>
      <div className="rack-split-explore">
        {/* Left: GitHub Repository Search & Workspace Switcher */}
        <section className="panel" aria-label="Pesquisa GitHub e repositorios">
          <div className="panel-head">
            <span>EXPLORADOR GITHUB &amp; WORKSPACE</span>
            <div style={{ display: "flex", gap: 6 }}>
              {localRepoName ? (
                <button
                  type="button"
                  className={sourceMode === "local" ? "btn-emerald" : "btn-ghost"}
                  style={{ padding: "4px 9px", fontSize: 11.5 }}
                  onClick={onSelectLocalRepo}
                >
                  <FolderGit2 size={12} aria-hidden="true" />
                  <span>Local</span>
                </button>
              ) : null}
              <button
                type="button"
                className="btn-ghost"
                style={{ padding: "4px 9px", fontSize: 11.5 }}
                disabled={searching}
                onClick={onLoadMyRepos}
              >
                <GitBranch size={12} aria-hidden="true" />
                <span>Meus Repos</span>
              </button>
            </div>
          </div>

          <div className="panel-body">
            <form className="input-row" onSubmit={handleSubmit}>
              <input
                type="search"
                className="rack-input"
                aria-label="Pesquisar repositorios no GitHub"
                placeholder="Buscar no GitHub (ex: owner/repo ou topic)"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <button type="submit" className="btn-secondary" disabled={searching}>
                <Search size={14} aria-hidden="true" />
                <span>{searching ? "Buscando..." : "Buscar"}</span>
              </button>
            </form>

            <div className="item-list">
              {repos.length === 0 ? (
                <p
                  className="mono"
                  style={{ fontSize: 12, color: "var(--text-muted)", padding: 8 }}
                >
                  Busque qualquer repositório público no GitHub ou clique em &quot;Meus Repos&quot;.
                </p>
              ) : (
                repos.map((repo) => {
                  const isSelected =
                    sourceMode === "github" && selectedRepo?.fullName === repo.fullName;
                  return (
                    <button
                      type="button"
                      key={repo.fullName}
                      className={`list-row ${isSelected ? "selected" : ""}`}
                      onClick={() => onSelectRemoteRepo(repo)}
                    >
                      <div className="row-top">
                        <span className="row-title">{repo.fullName}</span>
                        <span className="badge">{repo.isPrivate ? "PRIVADO" : "PÚBLICO"}</span>
                      </div>
                      {repo.description ? (
                        <span style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>
                          {repo.description}
                        </span>
                      ) : null}
                      <div className="row-meta">
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                          <Star size={11} aria-hidden="true" /> {repo.stars}
                        </span>
                        <span>{repo.language ?? "Multi"}</span>
                        <span>branch: {repo.defaultBranch}</span>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </section>

        {/* Right: Commit Feed with Filter + Team Hook / PR Bot Setup */}
        <section className="panel" aria-label="Commits e Pull Requests para Git Score">
          <div className="panel-head">
            <span>
              COMMITS ANALISÁVEIS ·{" "}
              {sourceMode === "local"
                ? (localRepoName ?? "Workspace Local")
                : (selectedRepo?.fullName ?? "Nenhum repo selecionado")}
            </span>
            <span>{commits.length} commits recentes</span>
          </div>

          <div className="panel-body">
            <div className="item-list">
              {commits.map((commit) => (
                <button
                  type="button"
                  key={commit.sha}
                  disabled={busy}
                  className={`list-row ${selectedCommitSha === commit.sha ? "selected" : ""}`}
                  onClick={() => onInspectCommit(commit.sha)}
                >
                  <div className="row-top">
                    <span className="row-title">{commit.messageHeadline}</span>
                    <span className="badge pass">{commit.shortSha}</span>
                  </div>
                  <div className="row-meta">
                    <span>autor: @{commit.authorLogin}</span>
                    <span>{commit.date ? new Date(commit.date).toLocaleString("pt-BR") : ""}</span>
                    <span>clique para Git Score &amp; Diff × Fix</span>
                  </div>
                </button>
              ))}
            </div>

            {pulls.length > 0 ? (
              <div style={{ marginTop: 6 }}>
                <div
                  className="mono"
                  style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}
                >
                  PULL REQUESTS ABERTOS ({pulls.length})
                </div>
                <div className="item-list">
                  {pulls.map((pr) => (
                    <button
                      type="button"
                      key={pr.number}
                      disabled={busy}
                      className="list-row"
                      onClick={() => onInspectCommit(pr.headSha)}
                    >
                      <div className="row-top">
                        <span
                          className="row-title"
                          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
                        >
                          <GitPullRequest size={14} aria-hidden="true" />#{pr.number} {pr.title}
                        </span>
                        <span className={`badge ${pr.isFork ? "warn" : "pass"}`}>
                          {pr.isFork ? "FORK COMMENT-ONLY" : "INTERNO PR BOT"}
                        </span>
                      </div>
                      <div className="row-meta">
                        <span>@{pr.authorLogin}</span>
                        <span>base: {pr.baseRef}</span>
                        <span>head: {pr.headSha.slice(0, 7)}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {/* Team Commit Access Provisioning without distributing keys */}
            <div
              style={{
                marginTop: "auto",
                borderTop: "1px solid var(--border-hairline)",
                paddingTop: 12,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 10,
              }}
            >
              <div style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>
                <strong style={{ color: "var(--text-bone)" }}>
                  Acesso para todo dev no Commit:
                </strong>{" "}
                hooks locais usam o cofre do dev; PR Bot usa Secrets da org sem versionar chaves.
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button type="button" className="btn-secondary" onClick={onInstallTeamHooks}>
                  <ShieldCheck size={13} aria-hidden="true" />
                  <span>
                    {teamHooksInstalled ? "Hooks Instalados ✓" : "Instalar Hooks no Repo"}
                  </span>
                </button>
                <button type="button" className="btn-secondary" onClick={onInstallTeamWorkflow}>
                  <GitPullRequest size={13} aria-hidden="true" />
                  <span>{teamWorkflowInstalled ? "PR Bot Ativo ✓" : "Gerar PR Bot GitHub"}</span>
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

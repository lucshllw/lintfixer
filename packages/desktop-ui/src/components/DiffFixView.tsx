import { Check, Copy, GitCommit, Play, ShieldAlert, ShieldCheck } from "lucide-react";
import { useState } from "react";
import type { AnalysisResponse } from "../types/api.ts";

interface DiffFixViewProps {
  readonly analysis: AnalysisResponse | null;
  readonly busy: boolean;
  readonly onApplyLocalFix: () => void;
  readonly onTestStagedCommit: () => void;
}

function renderDiffLines(diffText: string) {
  let offset = 0;
  return diffText.split(/\r?\n/).map((line) => {
    const lineKey = `off-${offset}`;
    offset += line.length + 1;
    let cls = "diff-line";
    if (line.startsWith("+") && !line.startsWith("+++")) cls += " add";
    else if (line.startsWith("-") && !line.startsWith("---")) cls += " del";
    else if (line.startsWith("@@") || line.startsWith("diff --git")) cls += " hunk";
    return (
      <span key={lineKey} className={cls}>
        {line || " "}
      </span>
    );
  });
}

export function DiffFixView({
  analysis,
  busy,
  onApplyLocalFix,
  onTestStagedCommit,
}: DiffFixViewProps) {
  const [copiedPatch, setCopiedPatch] = useState(false);

  if (!analysis) {
    return (
      <section
        className="panel"
        style={{ minHeight: 400, justifyContent: "center", alignItems: "center", padding: 32 }}
      >
        <p className="mono" style={{ color: "var(--text-secondary)" }}>
          Selecione um commit em &quot;GitHub &amp; Git Score&quot; ou inspecione o repositório
          local.
        </p>
      </section>
    );
  }

  const failingEntry = analysis.review?.entries.find(
    (e) => e.kind !== "REVIEW" && (e.outcome === "FAIL" || e.outcome === "WARN"),
  );
  const inScopeFile = analysis.gitScore.filter.files.find((f) => f.category === "in-scope")?.path;
  const evidenceFile =
    failingEntry?.evidenceHunk?.file ?? inScopeFile ?? analysis.files[0]?.path ?? "commit diff";
  const evidenceProb =
    failingEntry?.violationProbability != null
      ? `${Math.round(failingEntry.violationProbability * 100)}%`
      : "—";
  const evidenceConf =
    failingEntry?.confidence != null ? `${Math.round(failingEntry.confidence * 100)}%` : "—";

  const fixPatchText = analysis.fixCandidate?.unifiedPatch ?? null;

  const copyPatch = async () => {
    if (!fixPatchText) return;
    await navigator.clipboard.writeText(fixPatchText);
    setCopiedPatch(true);
    setTimeout(() => setCopiedPatch(false), 1800);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, flex: 1, minHeight: 0 }}>
      {/* Synchronized Split Diff & Verified Fix Panes (Proposta C Core) */}
      <div className="rack-grid-2">
        <section className="panel" aria-label="Evidencia literal do commit">
          <div className="panel-head">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <span className="led-dot warn" />
              <span>EVIDÊNCIA LITERAL · {evidenceFile}</span>
            </span>
            <span>
              PROB {evidenceProb} · CONF {evidenceConf}
            </span>
          </div>

          <div className="panel-body">
            {failingEntry?.evidenceHunk ? (
              <div
                className="mono"
                style={{
                  fontSize: 12,
                  padding: "8px 10px",
                  border: "1px solid rgba(234,108,43,0.4)",
                  background: "var(--led-orange-dim)",
                  borderRadius: 2,
                }}
              >
                <div>
                  [{failingEntry.id}] linhas {failingEntry.evidenceHunk.startLine}–
                  {failingEntry.evidenceHunk.endLine}: {failingEntry.rationale}
                </div>
              </div>
            ) : null}

            <pre className="code-well">
              <code>
                {renderDiffLines(analysis.unifiedDiff || "(sem alteracoes em arquivos de texto)")}
              </code>
            </pre>

            <div
              className="row-meta"
              style={{ justifyContent: "space-between", alignItems: "center" }}
            >
              <span>
                Politica:{" "}
                {analysis.policySource === "repo-base-branch"
                  ? "Branch base protegida"
                  : "Preset seguro LintFixer"}
              </span>
              {analysis.review?.redactedSecretsCount ? (
                <span style={{ color: "var(--led-orange)" }}>
                  {analysis.review.redactedSecretsCount} segredo(s) redigido(s) antes da IA
                </span>
              ) : (
                <span>Zero segredos vazados no diff</span>
              )}
            </div>
          </div>
        </section>

        <section className="panel" aria-label="Proposta de fix verificada">
          <div className="panel-head">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <span
                className={`led-dot ${
                  analysis.fixCandidate?.status === "VERIFIED_PATCH" ? "" : "off"
                }`}
              />
              <span>FIX VERIFICADO · ZERO REGRESSÃO</span>
            </span>
            <span
              style={{
                color:
                  analysis.fixCandidate?.status === "VERIFIED_PATCH"
                    ? "var(--led-emerald)"
                    : "var(--text-muted)",
              }}
            >
              {analysis.fixCandidate?.status === "VERIFIED_PATCH"
                ? `RE-CHECK: ${analysis.fixCandidate.recheckOutcome ?? "PASS"} (${analysis.gitScore.projectedPostFixScore ?? analysis.gitScore.score}/100)`
                : "AGUARDANDO GERAÇÃO DE FIX"}
            </span>
          </div>

          <div className="panel-body">
            {fixPatchText ? (
              <pre className="code-well">
                <code>{renderDiffLines(fixPatchText)}</code>
              </pre>
            ) : (
              <div
                className="code-well"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "center",
                  gap: 10,
                  color: "var(--text-secondary)",
                }}
              >
                <p>
                  {analysis.fixCandidate?.summary ??
                    'Clique em "Lint Semântico" e depois em "GERAR FIX VERIFICADO" para produzir e validar o patch sem regressões nem alterações em testes/configs.'}
                </p>
                {analysis.providerError ? (
                  <p style={{ color: "#f69d6b" }}>Erro do provedor: {analysis.providerError}</p>
                ) : null}
              </div>
            )}

            <div className="row-top" style={{ flexWrap: "wrap", gap: 8 }}>
              <div className="row-meta">
                <span>Trava: sem editar testes / workflows / lockfiles</span>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                {fixPatchText ? (
                  <>
                    <button type="button" className="btn-secondary" onClick={copyPatch}>
                      {copiedPatch ? (
                        <Check size={14} aria-hidden="true" />
                      ) : (
                        <Copy size={14} aria-hidden="true" />
                      )}
                      <span>{copiedPatch ? "Copiado" : "Copiar Patch"}</span>
                    </button>
                    {analysis.source === "local" ? (
                      <button
                        type="button"
                        className="btn-emerald"
                        disabled={busy}
                        onClick={onApplyLocalFix}
                      >
                        <ShieldCheck size={14} aria-hidden="true" />
                        <span>APLICAR NO REPO LOCAL</span>
                      </button>
                    ) : null}
                  </>
                ) : null}
              </div>
            </div>
          </div>
        </section>
      </div>

      {/* Rules & Filter Strip */}
      <section className="panel" aria-label="Detalhamento de regras e filtro barato">
        <div className="panel-head">
          <span>
            FILTRO BARATO ({analysis.gitScore.filter.inScopeCount}/
            {analysis.gitScore.filter.totalFiles} arquivos em escopo ·{" "}
            {Math.round(analysis.gitScore.filter.savedRatio * 100)}% tokens poupados)
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="btn-ghost"
              disabled={busy}
              onClick={onTestStagedCommit}
            >
              <GitCommit size={13} aria-hidden="true" />
              <span>Validar Commit Local Staged</span>
            </button>
          </div>
        </div>
        <div
          className="panel-body"
          style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, padding: "10px 14px" }}
        >
          {analysis.gitScore.factors.map((f) => (
            <span key={f.id} className={`badge ${f.outcome}`}>
              {f.outcome === "fail" ? (
                <ShieldAlert
                  size={11}
                  style={{ marginRight: 4, verticalAlign: -1 }}
                  aria-hidden="true"
                />
              ) : (
                <Play size={10} style={{ marginRight: 4, verticalAlign: -1 }} aria-hidden="true" />
              )}
              {f.label} ({f.delta >= 0 ? `+${f.delta}` : f.delta})
            </span>
          ))}
        </div>
      </section>
    </div>
  );
}

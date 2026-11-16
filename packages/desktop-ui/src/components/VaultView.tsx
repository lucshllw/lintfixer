import { CheckCircle2, KeyRound, Lock, RefreshCw, Shield, Trash2 } from "lucide-react";
import { useState } from "react";
import type { BootstrapState, VaultEntryMeta } from "../types/api.ts";

interface VaultViewProps {
  readonly bootstrap: BootstrapState;
  readonly busy: boolean;
  readonly statusMessage: string | null;
  readonly onSaveSecret: (namespace: VaultEntryMeta["namespace"], secret: string) => Promise<void>;
  readonly onDeleteSecret: (namespace: VaultEntryMeta["namespace"]) => Promise<void>;
  readonly onImportGhCli: () => Promise<void>;
  readonly onMigrateLegacy: () => Promise<void>;
  readonly onStartDeviceFlow: (
    clientId: string,
    scope: string,
  ) => Promise<{
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    interval: number;
  }>;
  readonly onPollDeviceFlow: (
    clientId: string,
    deviceCode: string,
  ) => Promise<{
    status: string;
    login?: string;
    message?: string;
  }>;
}

export function VaultView({
  bootstrap,
  busy,
  statusMessage,
  onSaveSecret,
  onDeleteSecret,
  onImportGhCli,
  onMigrateLegacy,
  onStartDeviceFlow,
  onPollDeviceFlow,
}: VaultViewProps) {
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [clientId, setClientId] = useState("");
  const [scope, setScope] = useState("read:user public_repo");
  const [deviceSession, setDeviceSession] = useState<{
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    statusText: string;
  } | null>(null);

  const handleSave = async (ns: VaultEntryMeta["namespace"]) => {
    const val = inputs[ns]?.trim();
    if (!val) return;
    await onSaveSecret(ns, val);
    setInputs((prev) => ({ ...prev, [ns]: "" }));
  };

  const handleStartOAuth = async () => {
    if (!clientId.trim()) return;
    const res = await onStartDeviceFlow(clientId.trim(), scope);
    setDeviceSession({
      deviceCode: res.deviceCode,
      userCode: res.userCode,
      verificationUri: res.verificationUri,
      statusText: "Aguardando autorizacao no navegador...",
    });
  };

  const handlePollOAuth = async () => {
    if (!deviceSession || !clientId.trim()) return;
    const res = await onPollDeviceFlow(clientId.trim(), deviceSession.deviceCode);
    if (res.status === "authorized") {
      setDeviceSession(null);
    } else {
      setDeviceSession((prev) =>
        prev ? { ...prev, statusText: res.message ?? `Status: ${res.status}` } : null,
      );
    }
  };

  return (
    <div className="rack-grid-2">
      {/* Left: GitHub OAuth & Account Linking */}
      <section className="panel" aria-label="Vinculacao segura GitHub">
        <div className="panel-head">
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <Shield size={14} color="#22C58B" aria-hidden="true" />
            <span>CONTA GITHUB · DEVICE FLOW OAUTH + CLI</span>
          </span>
          <span className={`badge ${bootstrap.github.connected ? "pass" : "warn"}`}>
            {bootstrap.github.connected ? `@${bootstrap.github.login}` : "DESCONECTADO"}
          </span>
        </div>

        <div className="panel-body">
          <div className="metric-cell">
            <div className="metric-label">PROTEÇÃO DO COFRE LOCAL</div>
            <div
              className="mono"
              style={{ fontSize: 12.5, marginTop: 4, color: "var(--text-bone)" }}
            >
              AES-256-GCM (IV 96-bit + AuthTag 128-bit + AAD estrito) · Chave mestra:{" "}
              <span style={{ color: "var(--led-emerald)" }}>{bootstrap.vaultProtection}</span>
            </div>
            <div
              className="mono"
              style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}
            >
              Localização isolada (fora de repo/OneDrive): {bootstrap.vaultDir}
            </div>
          </div>

          <div className="metric-cell" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontWeight: 600 }}>1. Importar Sessão Oficial `gh` CLI</div>
            <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>
              Reutiliza o keyring autenticado do GitHub CLI (`gh auth token`) e sela o token no
              cofre DPAPI local sem ler cookies do navegador.
            </p>
            <div>
              <button
                type="button"
                className="btn-emerald"
                disabled={busy}
                onClick={() => void onImportGhCli()}
              >
                <CheckCircle2 size={14} aria-hidden="true" />
                <span>Vincular &amp; Selar sessão `gh` no DPAPI</span>
              </button>
            </div>
          </div>

          <div className="metric-cell" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontWeight: 600 }}>2. GitHub OAuth Device Flow (PKCE/RFC 8628)</div>
            <div className="input-row">
              <input
                type="text"
                className="rack-input"
                aria-label="GitHub OAuth App Client ID"
                placeholder="GitHub OAuth App Client ID (ex: Ov23li...)"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
              />
              <select
                className="rack-select"
                aria-label="Escopo OAuth GitHub"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
              >
                <option value="read:user public_repo">Menor privilégio (public_repo)</option>
                <option value="read:user repo">Repos privados + públicos (repo)</option>
              </select>
              <button
                type="button"
                className="btn-secondary"
                disabled={busy || !clientId.trim()}
                onClick={() => void handleStartOAuth()}
              >
                <span>Gerar Código</span>
              </button>
            </div>

            {deviceSession ? (
              <div
                className="mono"
                style={{
                  fontSize: 12.5,
                  padding: 10,
                  background: "var(--led-emerald-dim)",
                  border: "1px solid rgba(34,197,139,0.4)",
                  borderRadius: 2,
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                <div>
                  Código do dispositivo: <strong>{deviceSession.userCode}</strong>
                </div>
                <div>
                  Abra:{" "}
                  <a
                    href={deviceSession.verificationUri}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: "var(--led-emerald)" }}
                  >
                    {deviceSession.verificationUri}
                  </a>
                </div>
                <div
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
                >
                  <span>{deviceSession.statusText}</span>
                  <button
                    type="button"
                    className="btn-emerald"
                    style={{ padding: "5px 10px" }}
                    onClick={() => void handlePollOAuth()}
                  >
                    <RefreshCw size={12} aria-hidden="true" />
                    <span>Confirmar Autorização</span>
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          {bootstrap.legacyNeedsMigration ? (
            <div
              className="metric-cell"
              style={{
                borderColor: "rgba(234,108,43,0.45)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 10,
              }}
            >
              <span style={{ fontSize: 13 }}>
                Detectamos chave legada em texto simples (`credentials.json`). Migrar e apagar
                plano?
              </span>
              <button
                type="button"
                className="btn-emerald"
                disabled={busy}
                onClick={() => void onMigrateLegacy()}
              >
                <Lock size={13} aria-hidden="true" />
                <span>Migrar para AES-256 + DPAPI</span>
              </button>
            </div>
          ) : null}
        </div>
      </section>

      {/* Right: Multi-Provider Encrypted Keys */}
      <section className="panel" aria-label="Cofre criptografado de provedores e API">
        <div className="panel-head">
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <KeyRound size={14} aria-hidden="true" />
            <span>CHAVES DE IA &amp; TOKENS SELADOS (ZERO TEXTO PLANO)</span>
          </span>
          <span className="mono">{statusMessage ?? "Segredos nunca são retornados para a UI"}</span>
        </div>

        <div className="panel-body">
          <div className="item-list">
            {bootstrap.vaultEntries.map((entry) => (
              <div
                key={entry.namespace}
                className="metric-cell"
                style={{ display: "flex", flexDirection: "column", gap: 8 }}
              >
                <div className="row-top">
                  <div>
                    <span style={{ fontWeight: 600 }}>{entry.providerLabel}</span>
                    <span
                      className="mono"
                      style={{ fontSize: 12, color: "var(--text-muted)", marginLeft: 10 }}
                    >
                      {entry.endpoint}
                    </span>
                  </div>
                  <span className={`badge ${entry.status === "sealed" ? "pass" : ""}`}>
                    {entry.status === "sealed"
                      ? `SELADO (${entry.maskedPreview})`
                      : "NÃO VINCULADO"}
                  </span>
                </div>

                <div className="input-row">
                  <input
                    type="password"
                    className="rack-input"
                    autoComplete="off"
                    aria-label={`Chave para ${entry.providerLabel}`}
                    placeholder={`Colar nova chave para ${entry.providerLabel} (nunca fica no repo)`}
                    value={inputs[entry.namespace] ?? ""}
                    onChange={(e) =>
                      setInputs((prev) => ({ ...prev, [entry.namespace]: e.target.value }))
                    }
                  />
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={busy || !(inputs[entry.namespace] ?? "").trim()}
                    onClick={() => void handleSave(entry.namespace)}
                  >
                    <Lock size={13} aria-hidden="true" />
                    <span>Cifrar &amp; Salvar</span>
                  </button>
                  {entry.status === "sealed" ? (
                    <button
                      type="button"
                      className="btn-ghost"
                      disabled={busy}
                      aria-label={`Remover chave ${entry.providerLabel}`}
                      onClick={() => void onDeleteSecret(entry.namespace)}
                    >
                      <Trash2 size={13} aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

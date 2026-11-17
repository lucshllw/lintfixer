import { CheckCircle2, KeyRound, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import type { BootstrapState } from "../types/api.ts";
import { KatBracketsLogo } from "./KatBracketsLogo.tsx";

interface SetupWizardModalProps {
  readonly open: boolean;
  readonly bootstrap: BootstrapState;
  readonly onClose: () => void;
  readonly onImportGhCli: () => Promise<void>;
  readonly onSaveGeminiKey: (key: string) => Promise<void>;
  readonly onMigrateLegacy: () => Promise<void>;
}

export function SetupWizardModal({
  open,
  bootstrap,
  onClose,
  onImportGhCli,
  onSaveGeminiKey,
  onMigrateLegacy,
}: SetupWizardModalProps) {
  const [step, setStep] = useState(1);
  const [geminiInput, setGeminiInput] = useState("");
  const [busy, setBusy] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    const el = cardRef.current;
    if (!open || !el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const ctx = gsap.context(() => {
      gsap.fromTo(
        el,
        { y: 12, autoAlpha: 0 },
        { y: 0, autoAlpha: 1, duration: 0.24, ease: "power2.out" },
      );
    }, el);
    return () => ctx.revert();
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Setup Inicial LintFixer"
    >
      <div ref={cardRef} className="modal-card">
        <div className="panel-head">
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <KatBracketsLogo size={22} decorative />
            <span>SETUP GUIADO LINTFIXER · ETAPA {step}/3</span>
          </div>
          <button type="button" className="btn-ghost" onClick={onClose} aria-label="Fechar setup">
            <X size={14} aria-hidden="true" />
          </button>
        </div>

        <div className="panel-body" style={{ padding: 20, gap: 16 }}>
          {step === 1 ? (
            <>
              <div style={{ fontSize: 16, fontWeight: 700 }}>
                Bem-vindo ao LintFixer + Cofre Criptografado
              </div>
              <p style={{ color: "var(--text-secondary)" }}>
                O LintFixer roda como daemon local em loopback (`127.0.0.1`) e sela tokens GitHub e
                chaves TypeSafe Jev / Gemini / OpenAI / Claude fora do repositório via{" "}
                <strong>AES-256-GCM + {bootstrap.vaultProtection}</strong>. Nenhuma chave entra no
                Git quando alguém do time faz commit.
              </p>
              <div className="metric-cell mono" style={{ fontSize: 12.5 }}>
                <div>Vault: {bootstrap.vaultDir}</div>
                <div style={{ marginTop: 4, color: "var(--led-emerald)" }}>
                  Provedor ativo: {bootstrap.activeProvider.judgeProvider} (
                  {bootstrap.activeProvider.judgeModel})
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button type="button" className="btn-emerald" onClick={() => setStep(2)}>
                  <span>Configurar GitHub →</span>
                </button>
              </div>
            </>
          ) : null}

          {step === 2 ? (
            <>
              <div style={{ fontSize: 16, fontWeight: 700 }}>
                Conectar Conta GitHub para Pesquisa &amp; Commits
              </div>
              <p style={{ color: "var(--text-secondary)" }}>
                Status atual:{" "}
                <strong
                  style={{
                    color: bootstrap.github.connected ? "var(--led-emerald)" : "var(--led-orange)",
                  }}
                >
                  {bootstrap.github.connected
                    ? `Conectado como @${bootstrap.github.login}`
                    : "Ainda não vinculado"}
                </strong>
              </p>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await onImportGhCli();
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <ShieldCheck size={14} aria-hidden="true" />
                  <span>Vincular sessão `gh` CLI no DPAPI</span>
                </button>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }}>
                <button type="button" className="btn-ghost" onClick={() => setStep(1)}>
                  ← Voltar
                </button>
                <button type="button" className="btn-emerald" onClick={() => setStep(3)}>
                  <span>Cofre de API IA →</span>
                </button>
              </div>
            </>
          ) : null}

          {step === 3 ? (
            <>
              <div style={{ fontSize: 16, fontWeight: 700 }}>
                Vincular Chave IA ({bootstrap.activeProvider.judgeProvider})
              </div>
              {bootstrap.legacyNeedsMigration ? (
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await onMigrateLegacy();
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <CheckCircle2 size={14} aria-hidden="true" />
                  <span>Migrar chave legada existente para DPAPI agora</span>
                </button>
              ) : null}
              <div className="input-row">
                <input
                  type="password"
                  className="rack-input"
                  placeholder="Colar Gemini API Key (opcional se já configurada)"
                  value={geminiInput}
                  onChange={(e) => setGeminiInput(e.target.value)}
                />
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={busy || !geminiInput.trim()}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await onSaveGeminiKey(geminiInput.trim());
                      setGeminiInput("");
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <KeyRound size={14} aria-hidden="true" />
                  <span>Selar Chave</span>
                </button>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }}>
                <button type="button" className="btn-ghost" onClick={() => setStep(2)}>
                  ← Voltar
                </button>
                <button type="button" className="btn-emerald" onClick={onClose}>
                  <span>Entrar no Rack Observatório ✓</span>
                </button>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

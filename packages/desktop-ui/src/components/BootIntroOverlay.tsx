import gsap from "gsap";
import { CheckCircle2, Shield } from "lucide-react";
import { useEffect, useRef } from "react";

interface BootIntroOverlayProps {
  readonly visible: boolean;
  readonly protectionLabel: string;
  readonly githubLabel: string;
  readonly onComplete: () => void;
}

export function BootIntroOverlay({
  visible,
  protectionLabel,
  githubLabel,
  onComplete,
}: BootIntroOverlayProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    const el = rootRef.current;
    if (!visible || !el) return;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      onCompleteRef.current();
      return;
    }

    const ctx = gsap.context(() => {
      const tl = gsap.timeline({
        onComplete: () => {
          onCompleteRef.current();
        },
      });

      tl.fromTo(
        ".boot-box",
        { scale: 0.96, autoAlpha: 0 },
        { scale: 1, autoAlpha: 1, duration: 0.24, ease: "power2.out" },
      )
        .fromTo(
          ".boot-cat-path",
          { strokeDashoffset: 340 },
          { strokeDashoffset: 0, duration: 0.38, ease: "power2.inOut" },
          0.05,
        )
        .fromTo(
          ".boot-check-row",
          { x: -10, autoAlpha: 0 },
          { x: 0, autoAlpha: 1, duration: 0.16, stagger: 0.08, ease: "power2.out" },
          0.18,
        )
        .to(".boot-progress-fill", { width: "100%", duration: 0.56, ease: "power2.inOut" }, 0.12)
        .to(
          el,
          {
            autoAlpha: 0,
            duration: 0.22,
            ease: "power2.in",
          },
          "+=0.08",
        );
    }, el);

    return () => ctx.revert();
  }, [visible]);

  if (!visible) return null;

  return (
    <div ref={rootRef} className="boot-overlay" role="dialog" aria-label="Inicializacao LintFixer">
      <div className="boot-box">
        <div className="boot-header">
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <svg width="42" height="42" viewBox="0 0 128 128" fill="none" aria-hidden="true">
              <path
                className="boot-cat-path"
                d="M24 22 L46 42 H82 L104 22 L108 62 C108 92 90 108 64 108 C38 108 20 92 20 62 Z"
                stroke="#ECEFF4"
                strokeWidth="5"
                strokeDasharray="340"
                strokeLinejoin="round"
              />
              <path
                d="M16 48 C10 48 10 58 6 62 C10 66 10 76 16 76"
                stroke="#22C58B"
                strokeWidth="5"
                strokeLinecap="round"
              />
              <path
                d="M112 48 C118 48 118 58 122 62 C118 66 118 76 112 76"
                stroke="#22C58B"
                strokeWidth="5"
                strokeLinecap="round"
              />
              <rect x="41" y="64" width="15" height="6" rx="2" fill="#ECEFF4" />
              <rect x="72" y="64" width="15" height="6" rx="2" fill="#ECEFF4" />
            </svg>
            <div>
              <div style={{ fontWeight: 700, fontSize: 16 }}>LintFixer</div>
              <div className="mono" style={{ fontSize: 12, color: "var(--text-muted)" }}>
                Rack Observatório · boot v0.2.0
              </div>
            </div>
          </div>
          <button type="button" className="btn-ghost" onClick={onComplete}>
            Pular
          </button>
        </div>

        <div className="boot-progress-track">
          <div className="boot-progress-fill" />
        </div>

        <div className="boot-checks">
          <div className="boot-check-row" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Shield size={14} color="#22C58B" aria-hidden="true" />
            <span>Cofre AES-256-GCM + {protectionLabel}</span>
          </div>
          <div className="boot-check-row" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <CheckCircle2 size={14} color="#22C58B" aria-hidden="true" />
            <span>GitHub Explorer: {githubLabel}</span>
          </div>
          <div className="boot-check-row" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <CheckCircle2 size={14} color="#22C58B" aria-hidden="true" />
            <span>Motor Semantico, Git Score &amp; Verificador de Patch pronto</span>
          </div>
        </div>
      </div>
    </div>
  );
}

import gsap from "gsap";
import { Play, Sparkles, Wrench } from "lucide-react";
import { useEffect, useRef } from "react";
import type { PipelineEventPayload, TelemetrySegmentState } from "../types/api.ts";

interface ScoreRackStripProps {
  readonly score: number | null;
  readonly projectedScore: number | null;
  readonly mode: "deterministic-filter" | "semantic-verified" | null;
  readonly segments: readonly TelemetrySegmentState[];
  readonly pipeline: PipelineEventPayload;
  readonly filterLabel: string;
  readonly canRunSemantic: boolean;
  readonly canGenerateFix: boolean;
  readonly busy: boolean;
  readonly onRunSemantic: () => void;
  readonly onGenerateFix: () => void;
}

const DEFAULT_SEGMENTS: readonly TelemetrySegmentState[] = Array.from(
  { length: 14 },
  () => "empty",
);
const SEGMENT_SLOTS = [
  "seg-01",
  "seg-02",
  "seg-03",
  "seg-04",
  "seg-05",
  "seg-06",
  "seg-07",
  "seg-08",
  "seg-09",
  "seg-10",
  "seg-11",
  "seg-12",
  "seg-13",
  "seg-14",
] as const;

export function ScoreRackStrip({
  score,
  projectedScore,
  mode,
  segments,
  pipeline,
  filterLabel,
  canRunSemantic,
  canGenerateFix,
  busy,
  onRunSemantic,
  onGenerateFix,
}: ScoreRackStripProps) {
  const containerRef = useRef<HTMLElement | null>(null);
  const numRef = useRef<HTMLSpanElement | null>(null);
  const activeSegments = segments.length === 14 ? segments : DEFAULT_SEGMENTS;

  useEffect(() => {
    const el = containerRef.current;
    if (!el || score === null) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      if (numRef.current) {
        numRef.current.textContent = String(score).padStart(2, "0");
      }
      return;
    }

    const ctx = gsap.context(() => {
      const counter = { value: Math.max(0, score - 18) };
      if (numRef.current) {
        gsap.to(counter, {
          value: score,
          duration: 0.55,
          ease: "power2.out",
          onUpdate: () => {
            if (numRef.current) {
              numRef.current.textContent = String(Math.round(counter.value)).padStart(2, "0");
            }
          },
        });
      }

      gsap.fromTo(
        ".led-seg",
        { scaleY: 0.72, opacity: 0.65 },
        {
          scaleY: 1,
          opacity: 1,
          duration: 0.25,
          stagger: 0.018,
          ease: "power2.out",
          transformOrigin: "bottom center",
        },
      );
    }, el);

    return () => ctx.revert();
  }, [score]);

  const stageState = (target: string): string => {
    if (pipeline.stage === target) return "stage-tag active";
    const order = ["SCAN", "FILTER", "LINT", "FIX", "VERIFY", "DONE"];
    const curIdx = order.indexOf(pipeline.stage);
    const tIdx = order.indexOf(target);
    if (pipeline.stage === "ERROR" && tIdx === curIdx) return "stage-tag warn";
    if (curIdx > tIdx) return "stage-tag pass";
    return "stage-tag";
  };

  return (
    <section ref={containerRef} className="score-rack" aria-label="Pipeline e Git Score">
      <div style={{ minWidth: 0 }}>
        <div className="score-rack-top">
          <div className="pipeline-chain">
            <span>PIPELINE TEMPO REAL:</span>
            <span className={stageState("SCAN")}>SCAN</span>
            <span>→</span>
            <span className={stageState("FILTER")}>FILTRO ({filterLabel})</span>
            <span>→</span>
            <span className={stageState("LINT")}>
              {mode === "semantic-verified" ? "LINT VERIFICADO" : "LINT"}
            </span>
            <span>→</span>
            <span className={stageState("FIX")}>FIX</span>
          </div>

          <div className="git-score-display">
            <span className="mono" style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {score === null
                ? "AGUARDANDO COMMIT"
                : mode === "semantic-verified"
                  ? "SEMÂNTICA ATIVA"
                  : "FILTRO DETERMINÍSTICO"}
            </span>
            <span className="git-score-value">
              GIT SCORE{" "}
              <span ref={numRef}>{score === null ? "--" : String(score).padStart(2, "0")}</span>/100
            </span>
            {score !== null && projectedScore !== null && projectedScore > score ? (
              <span className="projected-pill">PÓS-FIX {projectedScore}/100</span>
            ) : null}
          </div>
        </div>

        <div className="led-strip" aria-hidden="true">
          {activeSegments.map((state, idx) => (
            <div key={SEGMENT_SLOTS[idx]} className={`led-seg ${state}`} />
          ))}
        </div>
      </div>

      <div className="score-actions">
        <button
          type="button"
          className="btn-secondary"
          disabled={!canRunSemantic || busy}
          onClick={onRunSemantic}
        >
          <Sparkles size={14} aria-hidden="true" />
          <span>{busy ? "Analisando..." : "Lint Semântico"}</span>
        </button>

        <button
          type="button"
          className="btn-emerald"
          disabled={!canGenerateFix || busy}
          onClick={onGenerateFix}
        >
          {canGenerateFix ? (
            <Wrench size={14} aria-hidden="true" />
          ) : (
            <Play size={14} aria-hidden="true" />
          )}
          <span>GERAR FIX VERIFICADO</span>
        </button>
      </div>
    </section>
  );
}

import { BarChart3, Play } from "lucide-react";
import { useState } from "react";
import type { CalibrationReportView } from "../types/api.ts";

interface CalibrationViewProps {
  readonly report: CalibrationReportView | null;
  readonly busy: boolean;
  readonly onRunCalibration: (corpusKey: string, repeats: number, threshold: number) => void;
}

export function CalibrationView({ report, busy, onRunCalibration }: CalibrationViewProps) {
  const [corpusKey, setCorpusKey] = useState("calibration-corpus");
  const [repeats, setRepeats] = useState(1);
  const [threshold, setThreshold] = useState(0.7);

  return (
    <section
      className="panel"
      aria-label="Calibracao e metricas do judge semantico"
      style={{ flex: 1 }}
    >
      <div className="panel-head">
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <BarChart3 size={14} aria-hidden="true" />
          <span>CALIBRAÇÃO · MATRIZ DE CONFUSÃO, ECE, BRIER E FLIP RATE</span>
        </span>
        <div className="input-row">
          <select
            className="rack-select"
            aria-label="Corpus de calibracao"
            value={corpusKey}
            onChange={(e) => setCorpusKey(e.target.value)}
          >
            <option value="calibration-corpus">
              examples/calibration-corpus.json (offline/mini)
            </option>
            <option value="live-gemini-corpus">
              examples/live-gemini-corpus.json (2 casos Gemini)
            </option>
          </select>
          <select
            className="rack-select"
            aria-label="Repeticoes por caso"
            value={repeats}
            onChange={(e) => setRepeats(Number(e.target.value))}
          >
            <option value={1}>1 rep (econômico)</option>
            <option value={2}>2 reps</option>
            <option value={3}>3 reps</option>
          </select>
          <select
            className="rack-select"
            aria-label="Threshold de FAIL"
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
          >
            <option value={0.6}>Limiar 0.60</option>
            <option value={0.7}>Limiar 0.70</option>
            <option value={0.8}>Limiar 0.80</option>
          </select>
          <button
            type="button"
            className="btn-emerald"
            disabled={busy}
            onClick={() => onRunCalibration(corpusKey, repeats, threshold)}
          >
            <Play size={13} aria-hidden="true" />
            <span>{busy ? "Calibrando..." : "RODAR CALIBRAÇÃO"}</span>
          </button>
        </div>
      </div>

      <div className="panel-body">
        {!report ? (
          <div className="code-well" style={{ color: "var(--text-secondary)" }}>
            Execute uma calibração para medir Precision, Recall, F1, Brier Score, Expected
            Calibration Error (ECE 10 bins), Flip Rate e comparar agregadores (`max` vs `topKMean`
            vs `noisyOr`).
          </div>
        ) : (
          <>
            <div className="metrics-grid">
              <div className="metric-cell">
                <div className="metric-label">F1 SCORE</div>
                <div className="metric-val" style={{ color: "var(--led-emerald)" }}>
                  {(report.summary.f1 * 100).toFixed(1)}%
                </div>
              </div>
              <div className="metric-cell">
                <div className="metric-label">PRECISION / RECALL</div>
                <div className="metric-val">
                  {(report.summary.precision * 100).toFixed(0)}% /{" "}
                  {(report.summary.recall * 100).toFixed(0)}%
                </div>
              </div>
              <div className="metric-cell">
                <div className="metric-label">ECE (10 BINS)</div>
                <div className="metric-val">{report.summary.ece.toFixed(3)}</div>
              </div>
              <div className="metric-cell">
                <div className="metric-label">BRIER SCORE</div>
                <div className="metric-val">{report.summary.brierScore.toFixed(3)}</div>
              </div>
              <div className="metric-cell">
                <div className="metric-label">FLIP RATE</div>
                <div className="metric-val">{(report.summary.flipRate * 100).toFixed(1)}%</div>
              </div>
              <div className="metric-cell">
                <div className="metric-label">MATRIZ TP / FP / TN / FN</div>
                <div className="metric-val" style={{ fontSize: 16 }}>
                  {report.summary.matrix.tp} / {report.summary.matrix.fp} /{" "}
                  {report.summary.matrix.tn} / {report.summary.matrix.fn}
                </div>
              </div>
            </div>

            <div>
              <div
                className="mono"
                style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}
              >
                COMPARAÇÃO DE AGREGADORES DE SLICES
              </div>
              <table className="rack-table">
                <thead>
                  <tr>
                    <th>Modo</th>
                    <th>Precision</th>
                    <th>Recall</th>
                    <th>F1</th>
                  </tr>
                </thead>
                <tbody>
                  {report.aggregations.map((agg) => (
                    <tr key={agg.mode}>
                      <td>{agg.mode}</td>
                      <td>{(agg.precision * 100).toFixed(1)}%</td>
                      <td>{(agg.recall * 100).toFixed(1)}%</td>
                      <td>{(agg.f1 * 100).toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {report.allowedSuggestions.length > 0 ? (
              <div>
                <div
                  className="mono"
                  style={{ fontSize: 12, color: "var(--led-orange)", marginBottom: 6 }}
                >
                  SUGESTÕES DE EXCEÇÃO PARA FALSOS POSITIVOS (ALLOWED)
                </div>
                <div className="item-list">
                  {report.allowedSuggestions.map((s) => (
                    <div key={`${s.ruleId}-${s.suggestion}`} className="list-row">
                      <div className="row-top">
                        <span className="row-title">{s.ruleId}</span>
                        <span className="badge warn">Allowed Candidate</span>
                      </div>
                      <div
                        className="mono"
                        style={{ fontSize: 12, color: "var(--text-secondary)" }}
                      >
                        {s.suggestion} — {s.reason}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

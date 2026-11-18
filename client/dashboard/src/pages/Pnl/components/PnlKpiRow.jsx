import { Skeleton } from "./pnlUi.jsx";
import {
  DASH,
  KPI_DEFS,
  KPI_ORDER,
  deltaTone,
  formatCompact,
  formatDelta,
  formatPercent,
  isMissingValue,
  kpiPointValue,
} from "../pnlFormat.js";

function KpiCard({ metricId, kpi, points, highlight, on, onPick, loading, formatAmount }) {
  const def = KPI_DEFS[metricId];
  const isCurrency = def.type === "currency";
  const value = kpi?.value;
  const delta = isCurrency ? kpi?.changePct : kpi?.changePp;
  const hasDelta = !isMissingValue(delta);

  const vals = points.map((p) => kpiPointValue(p, metricId));
  const max = Math.max(1e-9, ...vals.map((v) => (v == null ? 0 : Math.max(0, v))));

  return (
    <button type="button" className={on ? "pnl-kpi on" : "pnl-kpi"} onClick={onPick} aria-pressed={on}>
      <span className="pnl-kpi-head">
        <span className="pnl-kpi-label">{def.label}</span>
        {on ? (
          <span className="pnl-pill" style={{ background: "var(--accent)", color: "#fff" }}>
            Charted
          </span>
        ) : null}
      </span>

      {loading ? (
        <Skeleton width={110} height={30} />
      ) : (
        <span className="pnl-kpi-value pnl-num">
          {isMissingValue(value) ? DASH : isCurrency ? formatCompact(formatAmount, value) : formatPercent(value)}
        </span>
      )}

      <span className="pnl-kpi-delta">
        {loading ? (
          <Skeleton width={120} height={14} />
        ) : hasDelta ? (
          <>
            <span style={{ fontWeight: 600, color: deltaTone(delta) }}>
              {formatDelta(delta, isCurrency ? "%" : " pp")}
            </span>
            <span className="pnl-muted">vs previous</span>
          </>
        ) : (
          <span className="pnl-muted">No comparison yet</span>
        )}
      </span>

      <span className="pnl-spark" aria-hidden="true">
        {vals.map((v, i) => (
          <span
            key={points[i]?.key || i}
            className={i === highlight ? "on" : undefined}
            style={{
              height: v == null ? "6%" : `${Math.max(8, (Math.max(0, v) / max) * 100)}%`,
              opacity: v == null ? 0.45 : 1,
            }}
          />
        ))}
      </span>
    </button>
  );
}

export default function PnlKpiRow({ kpis, points, selected, metric, onMetricChange, loading, formatAmount }) {
  // Sparklines get crowded past ~31 bars; show the most recent ones.
  const offset = Math.max(0, points.length - 31);
  const shown = points.slice(offset);
  const highlight = selected != null ? selected - offset : shown.length - 1;
  return (
    <section id="summary" aria-label="Summary" className="pnl-kpis">
      {KPI_ORDER.map((metricId) => (
        <KpiCard
          key={metricId}
          metricId={metricId}
          kpi={kpis?.[metricId]}
          points={shown}
          highlight={highlight}
          on={metric === metricId}
          onPick={() => onMetricChange(metricId)}
          loading={loading}
          formatAmount={formatAmount}
        />
      ))}
    </section>
  );
}

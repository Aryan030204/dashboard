import { useState } from "react";
import { Skeleton } from "./pnlUi.jsx";
import {
  DASH,
  KPI_DEFS,
  bucketLabels,
  formatAmountOrMissing,
  formatCompact,
  formatPercent,
  formatRange,
  kpiPointValue,
} from "../pnlFormat.js";

// Rounds a step up to 1 / 2 / 2.5 / 3 / 4 / 5 / 6 / 8 / 10 x 10^n.
function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  const m = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 3 ? 3 : f <= 4 ? 4 : f <= 5 ? 5 : f <= 6 ? 6 : f <= 8 ? 8 : 10;
  return m * p;
}

// Axis domain that always includes zero, so negative margins (a loss-making
// EBITDA is common) draw below the baseline instead of disappearing.
function domain(values) {
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const step = niceStep((max - min || 1) / 4);
  const hi = Math.ceil(max / step) * step || (min < 0 ? 0 : step);
  const lo = Math.floor(min / step) * step;
  const ticks = [];
  for (let v = hi; v >= lo - step / 2; v -= step) ticks.push(Math.round(v / step) * step);
  return { hi, lo: Math.min(lo, hi - step), ticks };
}

function Bar({ value, pos, kind }) {
  if (value == null) return <span className={kind} style={{ visibility: "hidden" }} />;
  const zero = pos(0);
  const top = pos(Math.max(value, 0));
  const height = Math.max(value === 0 ? 0 : 0.8, Math.abs(pos(value) - zero));
  return (
    <span className={kind} style={{ position: "relative", alignSelf: "stretch", background: "none" }}>
      <span
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: `${top}%`,
          height: `${height}%`,
          background: kind === "cur" ? "var(--accent-mark)" : "var(--prev)",
          borderRadius: value < 0 ? "0 0 4px 4px" : "4px 4px 0 0",
        }}
      />
    </span>
  );
}

export default function PnlTrendChart({ series, metric, selected, onSelect, loading, error, onRetry, formatAmount }) {
  const [hover, setHover] = useState(null);
  const def = KPI_DEFS[metric];
  const money = def.type === "currency";
  const current = series?.current || [];
  const previous = series?.previous || [];
  const granularity = series?.granularity || "daily";
  const n = current.length;

  const cv = current.map((p) => kpiPointValue(p, metric));
  const pv = current.map((_, i) => kpiPointValue(previous[i], metric));
  const known = [...cv, ...pv].filter((v) => v != null);
  const { hi, lo, ticks } = domain(known);
  const pos = (v) => ((hi - v) / (hi - lo)) * 100;
  const fmt = (v) => (v == null ? DASH : money ? formatAmountOrMissing(formatAmount, v) : formatPercent(v));
  const tickLabel = (v) => (money ? formatCompact(formatAmount, v) : `${Math.round(v * 10) / 10}%`);
  const every = n > 16 ? Math.ceil(n / 12) : 1;

  const title = `${def.label} by ${granularity === "monthly" ? "month" : "day"}`;

  return (
    <section id="trend" className="pnl-card pnl-trend" aria-label={title}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: "8px 16px" }}>
        <div className="pnl-stack">
          <h2 className="pnl-h2">{title}</h2>
          <span className="pnl-sub">Select a bar to filter the statement to that period.</span>
        </div>
        {series?.start ? (
          <div className="pnl-legend">
            <span>
              <span className="pnl-swatch" style={{ background: "var(--accent-mark)" }} />
              {formatRange(series.start, series.end)}
            </span>
            <span>
              <span className="pnl-swatch" style={{ background: "var(--prev)" }} />
              {formatRange(series.previousStart, series.previousEnd)}
            </span>
          </div>
        ) : null}
      </div>

      {loading ? (
        <Skeleton height={250} style={{ borderRadius: 10 }} />
      ) : (
        <div className="pnl-chart">
          <div className="pnl-yaxis" aria-hidden="true">
            {ticks.map((t) => (
              <span key={t} style={{ top: `${pos(t)}%` }}>
                {tickLabel(t)}
              </span>
            ))}
          </div>
          <div className="pnl-plot">
            <div className="pnl-grid-lines" aria-hidden="true">
              {ticks.map((t) => (
                <span key={t} className={t === 0 ? "base" : undefined} style={{ top: `${pos(t)}%` }} />
              ))}
            </div>
            <div className="pnl-bars">
              {current.map((point, i) => {
                const labels = bucketLabels(point, granularity, n);
                const prevPoint = previous[i];
                const prevLabels = prevPoint ? bucketLabels(prevPoint, granularity, n) : null;
                const on = selected === i;
                const dim = selected != null && !on;
                const edgeLeft = i === 0;
                const edgeRight = i === n - 1 && n > 1;
                return (
                  <button
                    key={point.key}
                    type="button"
                    className={on ? "pnl-col on" : "pnl-col"}
                    aria-pressed={on}
                    aria-label={`${labels.full}, ${def.label} ${fmt(cv[i])}, previous ${fmt(pv[i])}`}
                    onClick={() => onSelect(on ? null : i)}
                    onMouseEnter={() => setHover(i)}
                    onMouseLeave={() => setHover((h) => (h === i ? null : h))}
                    onFocus={() => setHover(i)}
                    onBlur={() => setHover((h) => (h === i ? null : h))}
                  >
                    <span className="pnl-col-bars" style={{ opacity: dim ? 0.4 : 1, alignItems: "stretch" }}>
                      <Bar value={pv[i]} pos={pos} kind="prev" />
                      <Bar value={cv[i]} pos={pos} kind="cur" />
                    </span>
                    <span className="pnl-col-label">{i % every === 0 || on ? labels.axis : ""}</span>
                    {hover === i ? (
                      <span
                        className="pnl-tip"
                        style={{
                          left: edgeLeft ? 0 : edgeRight ? "auto" : "50%",
                          right: edgeRight ? 0 : "auto",
                          transform: edgeLeft || edgeRight ? "none" : "translateX(-50%)",
                        }}
                      >
                        <span style={{ fontWeight: 600 }}>{labels.full}</span>
                        <span>
                          <span className="pnl-swatch" style={{ background: "var(--accent-mark)", boxShadow: "0 0 0 1px var(--tip-bg)" }} />
                          {fmt(cv[i])}
                        </span>
                        <span style={{ color: "var(--tip-ink-2)" }}>
                          <span className="pnl-swatch" style={{ background: "var(--prev)" }} />
                          {fmt(pv[i])}
                          {prevLabels ? ` on ${prevLabels.short}` : ""}
                        </span>
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
            {error ? (
              <div className="pnl-chart-empty" style={{ flexDirection: "column", gap: 10 }}>
                <span>Couldn&apos;t load the trend for this range.</span>
                {onRetry ? (
                  <button type="button" className="pnl-ctl" onClick={onRetry}>
                    Try again
                  </button>
                ) : null}
              </div>
            ) : known.length === 0 ? (
              <div className="pnl-chart-empty">No P&amp;L figures have been built for this range yet.</div>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}

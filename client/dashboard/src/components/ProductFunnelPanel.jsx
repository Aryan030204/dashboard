import { Suspense, lazy, useState } from "react";
import { Skeleton } from "@mui/material";
import { Panel, Segmented } from "./datum/index.js";

// The previous funnel chart is kept as the "Bars" view.
const FunnelChart = lazy(() => import("./charts/FunnelChart.jsx"));

const nf = new Intl.NumberFormat("en-IN");

const formatShare = (value) => {
  if (!Number.isFinite(value)) return "0%";
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
};

// Presentation of the funnel data the page already has: [{ label, value, change }].
// "% of sessions" and "from previous" are plain ratios of those same values; nothing is fetched or recalculated elsewhere.
export default function ProductFunnelPanel({ data, height = 250 }) {
  const [view, setView] = useState("steps");
  const steps = Array.isArray(data) ? data : [];
  const first = Number(steps[0]?.value) || 0;

  // Bar lengths use a log scale so later steps stay visible.
  const barWidth = (value) => {
    const v = Number(value) || 0;
    if (first <= 0 || v <= 0) return 0;
    return Math.max(2, Math.min(100, (Math.log10(v + 1) / Math.log10(first + 1)) * 100));
  };

  return (
    <Panel
      title="Funnel"
      subtitle="Share of sessions reaching each step · change vs previous day"
      actions={
        <Segmented
          ariaLabel="Funnel view"
          value={view}
          onChange={setView}
          options={[
            { value: "steps", label: "Steps" },
            { value: "bars", label: "Bars" },
          ]}
        />
      }
      flush
    >
      {view === "steps" ? (
        <>
          <div className="dz-mg" style={{ "--dz-cols": Math.max(1, steps.length) }}>
            {steps.map((step, index) => {
              const value = Number(step.value) || 0;
              const prev = index > 0 ? Number(steps[index - 1]?.value) || 0 : null;
              const change = step.change === undefined || step.change === null ? null : Number(step.change);
              const hasChange = change !== null && Number.isFinite(change);
              return (
                <div key={step.label} className="dz-mc" style={{ gap: 8, padding: "16px 18px" }}>
                  <div className="dz-ml" style={{ justifyContent: "flex-start", gap: 8 }}>
                    <span style={{ color: "var(--dz-accent)", fontSize: 11, fontWeight: 600 }}>{String(index + 1).padStart(2, "0")}</span>
                    <span>{step.label}</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                    <span className="dz-mv">{nf.format(value)}</span>
                    {hasChange ? (
                      <span className={`dz-d ${change > 0 ? "is-good" : change < 0 ? "is-bad" : "is-flat"}`} style={{ fontSize: 12 }}>
                        {change > 0 ? "↑" : change < 0 ? "↓" : ""} {Math.abs(change)}%
                      </span>
                    ) : null}
                  </div>
                  <span className="dz-track" aria-hidden="true">
                    <i style={{ width: `${barWidth(value)}%` }} />
                  </span>
                  <div className="dz-md">
                    <b style={{ color: "var(--dz-text)" }}>{index === 0 ? "100%" : formatShare(first > 0 ? (value / first) * 100 : 0)}</b>
                    <span>of sessions</span>
                  </div>
                  {prev !== null ? (
                    <div className="dz-md">
                      <span className="dz-tag">{formatShare(prev > 0 ? (value / prev) * 100 : 0)} from previous</span>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
          <div className="dz-pf" style={{ justifyContent: "flex-start" }}>
            Bar lengths on a log scale so later steps stay visible.
          </div>
        </>
      ) : (
        <div className="dz-pb">
          <Suspense fallback={<Skeleton variant="rounded" width="100%" height={height} />}>
            <FunnelChart data={steps} height={height} />
          </Suspense>
        </div>
      )}
    </Panel>
  );
}

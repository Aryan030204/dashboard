import { MetricGrid, MetricCell } from "../../../components/datum/index.js";
import { DASH, colorOf, shortDay, signed } from "../marketplaceFormat.js";

export default function KpiRow({ summary, names, asOf }) {
  const cheapest = summary.cheapest;
  return (
    <div className="dz-panel mh-kpis">
      <MetricGrid columns={5} ariaLabel="Summary">
        <MetricCell label="Products tracked" value={summary.tracked} hint={`${summary.withPrice} with a price in range`} />
        <MetricCell
          label="Listing coverage"
          value={summary.coverage === null ? DASH : `${summary.coverage}%`}
          hint={`${summary.pairs} of ${summary.possible} possible listings`}
        />
        <MetricCell
          label="Median gap vs our site"
          value={signed(summary.medianGap, "pct")}
          hint={asOf ? `Latest check, ${shortDay(asOf)}` : "No price checks yet"}
        />
        <MetricCell label="Products 15%+ below us" value={summary.deepBelow} hint="on at least one marketplace" />
        <MetricCell
          label="Cheapest marketplace now"
          value={cheapest ? <span style={{ color: colorOf(cheapest.code) }}>{names[cheapest.code]}</span> : DASH}
          hint={cheapest ? `Median ${signed(cheapest.pct, "pct")} vs our site` : "No prices yet"}
        />
      </MetricGrid>
    </div>
  );
}

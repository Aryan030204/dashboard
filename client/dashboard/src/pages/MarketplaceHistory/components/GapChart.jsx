import { useState } from "react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Panel, Segmented } from "../../../components/datum/index.js";
import { colorOf, gapRows, latestPoints, latestSentence, shortDay, signed, timeDay } from "../marketplaceFormat.js";
import { Dot } from "./Chips.jsx";

const HALF_DAY = 12 * 60 * 60 * 1000;
const tick = { fontSize: 11, fill: "var(--dz-muted)" };

function Tip({ active, payload, label, names, unit }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="mh-tip">
      <strong>{shortDay(timeDay(label))}</strong>
      {payload.filter((p) => p.value !== null).map((p) => (
        <div key={p.dataKey}><span><Dot code={p.dataKey} /> {names[p.dataKey]}</span><span>{signed(p.value, unit)}</span></div>
      ))}
    </div>
  );
}

export default function GapChart({ series, codes, names, unit }) {
  const [stat, setStat] = useState("median");
  const [basis, setBasis] = useState("listed");
  const options = { basis, stat, unit };
  const rows = gapRows(series, codes, options);
  const points = latestPoints(series, codes, options);
  const withoutBest = basis === "best" ? points.filter((p) => !p.n).map((p) => names[p.code]) : [];
  const empty = points.every((p) => !p.n);

  return (
    <Panel
      title="Brand vs marketplaces"
      subtitle={`${stat === "median" ? "Median" : "Average"} gap vs our site. 0 is our price; below 0 means the marketplace is cheaper.`}
      actions={(
        <>
          <Segmented ariaLabel="Statistic" value={stat} onChange={setStat}
            options={[{ value: "median", label: "Median" }, { value: "average", label: "Average" }]} />
          <Segmented ariaLabel="Price basis" value={basis} onChange={setBasis}
            options={[{ value: "listed", label: "Listed price" }, { value: "best", label: "Best price after offers" }]} />
        </>
      )}
    >
      <p className="mh-note" style={{ marginTop: 0 }}>{latestSentence(points, names, unit)}</p>
      {empty ? (
        <div className="dz-tbl-empty">No comparable prices in this range.</div>
      ) : (
        <div className="mh-chart">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="var(--dz-grid)" vertical={false} />
              <XAxis dataKey="time" type="number" scale="time" domain={[`dataMin - ${HALF_DAY}`, `dataMax + ${HALF_DAY}`]}
                ticks={rows.length <= 8 ? rows.map((r) => r.time) : undefined}
                tickFormatter={(t) => shortDay(timeDay(t))} tick={tick} tickLine={false} />
              <YAxis tickFormatter={(v) => (unit === "abs" ? `₹${v}` : `${v}%`)} tick={tick} tickLine={false} axisLine={false} width={52} />
              <ReferenceLine y={0} stroke="var(--dz-muted)" strokeDasharray="3 3" />
              <Tooltip content={<Tip names={names} unit={unit} />} />
              {codes.map((code) => (
                <Line key={code} dataKey={code} stroke={colorOf(code)} strokeWidth={2} isAnimationActive={false}
                  dot={rows.length <= 21 ? { r: 3, fill: colorOf(code) } : false} connectNulls={false} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
      <div className="mh-legend">
        {points.map((p) => (
          <span key={p.code}><Dot code={p.code} />{names[p.code]}: {p.n} product{p.n === 1 ? "" : "s"}{p.date ? ` on ${shortDay(p.date)}` : ""}</span>
        ))}
      </div>
      <p className="mh-note">
        Gap = (marketplace price − our price) ÷ our price, on each product&apos;s main size. Out of stock and unread checks are left out.
        {withoutBest.length ? ` Best price after offers is not available for ${withoutBest.join(", ")}.` : ""}
      </p>
    </Panel>
  );
}

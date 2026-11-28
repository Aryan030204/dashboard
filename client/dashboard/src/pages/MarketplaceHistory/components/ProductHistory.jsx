import { useEffect, useState } from "react";
import { CartesianGrid, Line, LineChart, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Switch } from "@mui/material";
import dayjs from "dayjs";
import { DataTable, MetricCell, MetricGrid, Panel, Segmented } from "../../../components/datum/index.js";
import { getMarketplaceProduct } from "../../../lib/api.js";
import {
  DASH, RANGES, band, colorOf, dayTime, gapText, money, outOfStockSpans, rangeParams, shortDay, stats, timeDay,
} from "../marketplaceFormat.js";
import Chips, { Dot } from "./Chips.jsx";

const HALF_DAY = 12 * 60 * 60 * 1000;
const OURS = "var(--dz-text)";
const tick = { fontSize: 11, fill: "var(--dz-muted)" };

function Tip({ active, payload, label, names }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="mh-tip">
      <strong>{shortDay(timeDay(label))}</strong>
      {payload.filter((p) => p.value !== null).map((p) => {
        const [code, best] = String(p.dataKey).split("_");
        return (
          <div key={p.dataKey}>
            <span>{code === "ours" ? "Our site" : names[code]}{best ? " (best)" : ""}</span>
            <span>{money(p.value)}</span>
          </div>
        );
      })}
    </div>
  );
}

const lastChecked = (value) => (value ? dayjs(value).format("D MMM, HH:mm") : DASH);
const STOCK = { in: "In stock", out: "Out of stock", unknown: "Not stated" };

function useProductHistory(brandKey, variantId, params, pincode) {
  const key = JSON.stringify([brandKey, variantId, params, pincode]);
  const [state, setState] = useState({ key: null, data: null, error: false });
  useEffect(() => {
    if (!variantId) return undefined;
    const controller = new AbortController();
    const [brand, variant, range, pin] = JSON.parse(key);
    getMarketplaceProduct({ brandKey: brand, variantId: variant, ...range, pincode: pin, signal: controller.signal }).then((res) => {
      if (res.aborted) return;
      setState({ key, data: res.error ? null : res.data, error: Boolean(res.error) });
    });
    return () => controller.abort();
  }, [key, variantId]);
  return state.key === key ? { ...state, loading: false } : { data: null, error: false, loading: true };
}

export default function ProductHistory({ brandKey, products, variantId, onSelect, preset, custom, pincode, unit }) {
  const [ownPreset, setOwnPreset] = useState(null); // null follows the page's range
  const [showBest, setShowBest] = useState(false);
  const [hidden, setHidden] = useState([]);
  const [statsFor, setStatsFor] = useState("ours");

  const params = rangeParams(ownPreset || preset, ownPreset ? null : custom);
  const { data, loading, error } = useProductHistory(brandKey, variantId, params, pincode);

  const product = products.find((p) => p.variantId === variantId || p.sizes.some((s) => s.variantId === variantId));
  const marketplaces = data?.marketplaces || [];
  const names = Object.fromEntries(marketplaces.map((m) => [m.code, m.name]));
  const codes = marketplaces.map((m) => m.code).filter((c) => !hidden.includes(c));
  const series = data?.series || [];
  const rows = series.map((point) => {
    const row = { time: dayTime(point.date), ours: point.ours };
    for (const code of codes) {
      row[code] = point.marketplaces[code]?.price ?? null;
      row[`${code}_best`] = point.marketplaces[code]?.best ?? null;
    }
    return row;
  });
  const source = statsFor !== "ours" && !names[statsFor] ? "ours" : statsFor;
  const summary = stats(series.map((p) => (source === "ours" ? p.ours : p.marketplaces[source]?.price)));
  const dots = rows.length <= 21;

  const currentRows = data
    ? [{ code: "ours", price: data.ourPrice, best: data.ourPrice }, ...data.current]
    : [];
  const columns = [
    {
      key: "code",
      header: "Marketplace",
      render: (r) => <><Dot code={r.code} color={r.code === "ours" ? OURS : undefined} /> {r.code === "ours" ? "Our site" : names[r.code]}</>,
    },
    { key: "price", header: "Current price", align: "right", render: (r) => (r.state === "unread" ? "not read" : money(r.price)) },
    { key: "best", header: "Best price", align: "right", render: (r) => (r.best === null || r.best === undefined ? <span className="mh-muted">not available</span> : money(r.best)) },
    {
      key: "delta",
      header: "Delta vs ours",
      align: "right",
      render: (r) => {
        if (r.code === "ours") return <span className="mh-muted">baseline</span>;
        if (r.state !== "ok") return DASH;
        return (
          <>
            <span className={`mh-gap is-${band(r.gap.pct)}`}>{gapText(r.gap, unit)}</span>
            {r.bestGap?.pct !== null && r.bestGap?.pct !== undefined ? <span className="mh-muted"> best {gapText(r.bestGap, unit)}</span> : null}
          </>
        );
      },
    },
    { key: "stock", header: "Stock", render: (r) => (r.code === "ours" ? DASH : STOCK[r.stock] || DASH) },
    {
      key: "checked",
      header: "Last checked",
      align: "right",
      render: (r) => (r.code === "ours" ? <span className="mh-muted">catalog price</span> : lastChecked(r.checkedAt)),
    },
    {
      key: "url",
      header: "Listing",
      align: "right",
      render: (r) => (r.url ? <a className="mh-link" href={r.url} target="_blank" rel="noopener noreferrer">Open</a> : DASH),
    },
  ];

  return (
    <Panel title="Product price history" subtitle="Our website price against each marketplace, in rupees." flush>
      <div className="dz-pb">
        <div className="mh-row">
          <label className="mh-label">
            Product
            <select className="mh-control" value={product?.variantId ?? ""} onChange={(e) => onSelect(Number(e.target.value))}>
              {products.map((p) => <option key={p.variantId} value={p.variantId}>{p.product}</option>)}
            </select>
          </label>
          {product && product.sizes.length > 1 && (
            <label className="mh-label">
              Size
              <select className="mh-control" value={variantId} onChange={(e) => onSelect(Number(e.target.value))}>
                {product.sizes.map((s) => <option key={s.variantId} value={s.variantId}>{s.label}</option>)}
              </select>
            </label>
          )}
          <label className="mh-label mh-push">
            <Switch size="small" checked={showBest} onChange={(e) => setShowBest(e.target.checked)} />
            Show best offers
          </label>
          <Segmented ariaLabel="History range" options={RANGES} value={ownPreset || (custom ? null : preset)} onChange={setOwnPreset} />
        </div>
        {marketplaces.length > 0 && (
          <div className="mh-row">
            <Chips marketplaces={marketplaces} selected={codes} onChange={(next) => setHidden(marketplaces.map((m) => m.code).filter((c) => !next.includes(c)))} />
          </div>
        )}

        {loading && <div className="dz-tbl-empty" role="status">Loading price history…</div>}
        {error && <div className="dz-tbl-empty" role="alert">Could not load this product&apos;s history.</div>}
        {data && data.available !== false && (
          <>
            {rows.length === 0 ? (
              <div className="dz-tbl-empty">No price checks in this range.</div>
            ) : (
              <div className="mh-chart">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={rows} margin={{ top: 12, right: 16, bottom: 0, left: 0 }}>
                    <defs>
                      {codes.map((code) => (
                        <pattern key={code} id={`mh-hatch-${code}`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                          <line x1="0" y1="0" x2="0" y2="6" stroke={colorOf(code)} strokeWidth="2" />
                        </pattern>
                      ))}
                    </defs>
                    <CartesianGrid stroke="var(--dz-grid)" vertical={false} />
                    <XAxis dataKey="time" type="number" scale="time" domain={[`dataMin - ${HALF_DAY}`, `dataMax + ${HALF_DAY}`]}
                      ticks={rows.length <= 8 ? rows.map((r) => r.time) : undefined}
                      tickFormatter={(t) => shortDay(timeDay(t))} tick={tick} tickLine={false} />
                    <YAxis tickFormatter={(v) => money(v)} tick={tick} tickLine={false} axisLine={false} width={64}
                      domain={[(min) => Math.floor((min * 0.95) / 10) * 10, (max) => Math.ceil((max * 1.05) / 10) * 10]} />
                    <Tooltip content={<Tip names={names} />} />
                    {codes.flatMap((code) => outOfStockSpans(series, code).map(([from, to]) => (
                      <ReferenceArea key={`${code}-${from}`} x1={from} x2={to} fill={`url(#mh-hatch-${code})`} fillOpacity={0.35} />
                    )))}
                    <Line dataKey="ours" type="stepAfter" stroke={OURS} strokeWidth={3} isAnimationActive={false}
                      dot={dots ? { r: 3, fill: OURS } : false} />
                    {codes.map((code) => (
                      <Line key={code} dataKey={code} stroke={colorOf(code)} strokeWidth={2} isAnimationActive={false}
                        dot={dots ? { r: 3, fill: colorOf(code) } : false} />
                    ))}
                    {showBest && codes.map((code) => (
                      <Line key={`${code}_best`} dataKey={`${code}_best`} stroke={colorOf(code)} strokeWidth={1.5} strokeDasharray="5 4"
                        isAnimationActive={false} dot={dots ? { r: 2, fill: colorOf(code) } : false} />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}

            <div className="mh-row" style={{ marginTop: 12 }}>
              <label className="mh-label">
                Stats for
                <select className="mh-control" value={source} onChange={(e) => setStatsFor(e.target.value)}>
                  <option value="ours">Our website</option>
                  {marketplaces.map((m) => <option key={m.code} value={m.code}>{m.name}</option>)}
                </select>
              </label>
              <span className="mh-muted">Listed price, days with a reading</span>
            </div>
            {summary ? (
              <div className="mh-stats">
                <MetricGrid columns={4} ariaLabel="Price statistics">
                  <MetricCell label="Highest" value={money(summary.highest)} hint="in this range" />
                  <MetricCell label="Average" value={money(summary.average)} hint="in this range" />
                  <MetricCell label="Lowest" value={money(summary.lowest)} hint="in this range" />
                  <MetricCell
                    label="Latest vs average"
                    value={Math.abs(summary.versusAverage) < 0.05 ? "Same" : `${Math.abs(summary.versusAverage).toFixed(1)}% ${summary.versusAverage < 0 ? "below" : "above"}`}
                    hint={`latest ${money(summary.latest)} · average ${money(summary.average)}`}
                  />
                </MetricGrid>
              </div>
            ) : (
              <p className="mh-note">No prices for this choice in this range.</p>
            )}
          </>
        )}
      </div>
      {data && data.available !== false && (
        <>
          <DataTable columns={columns} rows={currentRows} getRowKey={(r) => r.code} ariaLabel="Current prices" />
          <div className="dz-pf" style={{ justifyContent: "flex-start" }}>
            <span>Listed price is solid; best price after offers is dashed. Hatched areas are out of stock. A break in a line means no reading that day. Products are matched by name, size, pack and brand.</span>
          </div>
        </>
      )}
    </Panel>
  );
}

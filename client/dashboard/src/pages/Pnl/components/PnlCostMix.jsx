import { Skeleton } from "./pnlUi.jsx";
import { DASH, MIX_PARTS, formatCompact, formatPercent, isMissingValue } from "../pnlFormat.js";

const cost = (value) => (isMissingValue(value) ? 0 : Math.abs(value));

export default function PnlCostMix({ lines, scopeLabel, highlighted, onPick, loading, formatAmount }) {
  const net = lines.netSales?.amount;
  const hasNet = !isMissingValue(net) && net > 0;
  const ebitda = lines.ebitda?.amount;

  const parts = [
    ...MIX_PARTS.map((part) => ({
      ...part,
      value: part.keys.reduce((sum, key) => sum + cost(lines[key]?.amount), 0),
    })),
    { id: "ebitdaKept", section: "ebitda", label: "EBITDA kept", value: isMissingValue(ebitda) ? 0 : ebitda, color: "var(--s6)" },
  ];

  return (
    <section className="pnl-card pnl-mix" aria-label="Where net sales go">
      <div className="pnl-stack">
        <h2 className="pnl-h2">Where net sales go</h2>
        <span className="pnl-sub">
          Share of {hasNet ? formatCompact(formatAmount, net) : DASH} net sales, {scopeLabel}
        </span>
      </div>

      {loading ? (
        <>
          <Skeleton height={8} />
          {parts.map((p) => (
            <Skeleton key={p.id} height={28} />
          ))}
        </>
      ) : (
        <>
          <div className="pnl-mix-bar" aria-hidden="true">
            {hasNet
              ? parts
                  .filter((p) => p.value > 0)
                  .map((p) => (
                    <span key={p.id} style={{ flex: `${((p.value / net) * 100).toFixed(2)} 1 0%`, background: p.color }} />
                  ))
              : <span style={{ flex: 1, background: "var(--track)" }} />}
          </div>
          <div className="pnl-stack">
            {parts.map((p) => {
              const section = p.section || p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  className={highlighted === section ? "pnl-lg on" : "pnl-lg"}
                  aria-pressed={highlighted === section}
                  onClick={() => onPick(section)}
                >
                  <span aria-hidden="true" style={{ width: 12, height: 12, borderRadius: 3, background: p.color }} />
                  <span style={{ fontWeight: 500 }}>{p.label}</span>
                  <span className="pnl-num pnl-muted">{hasNet ? formatCompact(formatAmount, p.value) : DASH}</span>
                  <span className="pnl-num" style={{ fontWeight: 600, textAlign: "right" }}>
                    {hasNet ? formatPercent((p.value / net) * 100) : DASH}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

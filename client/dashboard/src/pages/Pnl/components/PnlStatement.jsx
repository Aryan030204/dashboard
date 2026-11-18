import { Fragment, useEffect, useState } from "react";
import dayjs from "dayjs";
import { clearPnlCostConfig, savePnlCostConfig, savePnlTotalConfig } from "../../../lib/api.js";
import { Banner, Field, Icon, Pill, Segmented, Skeleton } from "./pnlUi.jsx";
import { ICONS } from "./pnlIcons.js";
import {
  DASH,
  LINES,
  SECTIONS,
  SECTION_ORDER,
  currencyAffix,
  deltaTone,
  formatAmountOrMissing,
  formatDelta,
  formatPercent,
  isMissingValue,
  lineLabel,
} from "../pnlFormat.js";

const num = (value) => (isMissingValue(value) ? 0 : value);
const parseDraft = (draft) => Number.parseFloat(String(draft).replace(/,/g, ""));

// How a line's figure is arrived at, shown under its label.
function basisFor(row, { config, adSources, formatAmount }) {
  const meta = LINES[row.key] || {};
  if (meta.kind === "orders") return "Synced from store orders";
  if (meta.kind === "gst") return config ? `${config.gstPct}% rate, backed out of sales` : "";
  if (meta.kind === "ads") {
    if (row.isLive) return `Synced from ${meta.sourceLabel}`;
    if (adSources[meta.source]?.connected) return `${meta.sourceLabel} is connected; no spend synced for this range yet`;
    return `Connect ${meta.sourceLabel} or its spend stays out of CM2`;
  }
  if (meta.kind === "cost") {
    if (!config) return "";
    const line = config.costs?.[meta.config];
    if (!line) return "Not set";
    return line.valueType === "percentage"
      ? `${line.value}% of net sales`
      : `${formatAmountOrMissing(formatAmount, line.value)} / month`;
  }
  return "";
}

function badgeFor(row, { adSources, saved }) {
  if (saved[row.key] === "just") return { tone: "good", text: "Saved" };
  if (saved[row.key] === "pending") return { tone: "edit", text: "Pending rebuild" };
  const meta = LINES[row.key] || {};
  if (meta.kind === "ads") {
    if (row.isLive) return { tone: "good", text: "Synced" };
    const status = adSources[meta.source];
    if (status && !status.connected) return { tone: "warn", text: "Not connected" };
    if (status?.connected) return { tone: "warn", text: "Not synced" };
  }
  return null;
}

function PreviewBlock({ label, value }) {
  return (
    <div className="pnl-edit-preview">
      <span className="pnl-muted">{label}</span>
      <span style={{ fontWeight: 600 }}>{value}</span>
      <span className="pnl-hint">Saved settings apply when the nightly rebuild runs.</span>
    </div>
  );
}

function EditButtons({ onCancel, onSave, saveDisabled, saving, extra }) {
  return (
    <div className="pnl-edit-actions">
      {extra}
      <button type="button" className="pnl-ctl" onClick={onCancel} disabled={saving}>
        Cancel
      </button>
      <button type="button" className="pnl-btn" onClick={onSave} disabled={saveDisabled || saving}>
        {saving ? "Saving…" : "Save"}
      </button>
    </div>
  );
}

function CostEditor({ row, field, line, ctx, onSaved, onCancel }) {
  const { brandKey, net, ebitda, days, scopeLabel, formatAmount } = ctx;
  const amount = isMissingValue(row.amount) ? null : Math.abs(row.amount);

  const draftFor = (mode) => {
    if (line?.valueType === mode) return String(line.value);
    if (amount == null) return "";
    if (mode === "percentage") return net ? String(Math.round((amount / net) * 1000) / 10) : "";
    return String(Math.round(((amount / Math.max(1, days)) * 30) / 100) * 100);
  };

  const [mode, setMode] = useState(line?.valueType || "percentage");
  const [draft, setDraft] = useState(() => draftFor(line?.valueType || "percentage"));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const value = parseDraft(draft);
  const valid = Number.isFinite(value) && value >= 0 && (mode !== "percentage" || value <= 100);
  const label = lineLabel(row);

  let preview = mode === "percentage" ? "Enter a percentage from 0 to 100" : "Enter an amount, 0 or more";
  if (valid) {
    const next = mode === "percentage" ? (num(net) * value) / 100 : (value * days) / 30;
    preview = formatAmountOrMissing(formatAmount, -next);
    if (net > 0 && !isMissingValue(ebitda)) {
      const nextEbitda = ebitda + (amount || 0) - next;
      preview += ` · EBITDA ${formatPercent((ebitda / net) * 100)} → ${formatPercent((nextEbitda / net) * 100)}`;
    }
  }

  const run = async (request, fallback) => {
    setSaving(true);
    setError("");
    const result = await request();
    setSaving(false);
    if (result.error) {
      setError(result.data?.error || fallback);
      return;
    }
    onSaved(result.data?.config, row.key);
  };
  const save = () =>
    run(() => savePnlCostConfig({ brand_key: brandKey, category: field, value, value_type: mode }), "Failed to save");

  return (
    <div className="pnl-edit">
      <div className="pnl-label">
        <span className="pnl-label-text">How {label} is calculated</span>
        <Segmented
          label={`How ${label} is calculated`}
          value={mode}
          onChange={(m) => {
            setMode(m);
            setDraft(draftFor(m));
          }}
          options={[
            { value: "percentage", label: "% of net sales" },
            { value: "flat", label: `${currencyAffix(formatAmount)} per month` },
          ]}
        />
      </div>
      <Field
        label={mode === "percentage" ? "Percent of net sales" : "Amount per month"}
        prefix={mode === "flat" ? currencyAffix(formatAmount) : null}
        suffix={mode === "flat" ? "/ month" : "%"}
      >
        <input
          type="text"
          inputMode="decimal"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && valid && !saving && save()}
          style={{ width: 110 }}
          aria-invalid={!valid}
          autoFocus
        />
      </Field>
      <PreviewBlock label={`Estimate for ${scopeLabel}`} value={error ? <span style={{ color: "var(--bad)" }}>{error}</span> : preview} />
      <EditButtons
        saving={saving}
        saveDisabled={!valid}
        onCancel={onCancel}
        onSave={save}
        extra={
          line ? (
            <button
              type="button"
              className="pnl-ctl pnl-danger"
              disabled={saving}
              onClick={() => run(() => clearPnlCostConfig({ brand_key: brandKey, category: field }), "Failed to clear")}
            >
              Remove setting
            </button>
          ) : null
        }
      />
    </div>
  );
}

function GstEditor({ gstPct, lines, ctx, onSaved, onCancel }) {
  const { brandKey, scopeLabel, formatAmount } = ctx;
  const [draft, setDraft] = useState(String(gstPct ?? 18));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const rate = parseDraft(draft);
  const valid = Number.isFinite(rate) && rate >= 0 && rate <= 100;

  const taxable =
    num(lines.grossSales?.amount) - Math.abs(num(lines.discounts?.amount)) - Math.abs(num(lines.cancellations?.amount));
  const preview = valid
    ? `GST ${formatAmountOrMissing(formatAmount, -(Math.max(0, taxable) * rate) / (100 + rate))}`
    : "Enter a rate from 0 to 100";

  const save = async () => {
    setSaving(true);
    setError("");
    const result = await savePnlTotalConfig({ brand_key: brandKey, gst_pct: rate });
    setSaving(false);
    if (result.error) {
      setError(result.data?.error || "Failed to save");
      return;
    }
    onSaved(result.data?.config, "gst");
  };

  return (
    <div className="pnl-edit">
      <Field label="GST rate" suffix="%">
        <input
          type="text"
          inputMode="decimal"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && valid && !saving && save()}
          style={{ width: 110 }}
          aria-invalid={!valid}
          autoFocus
        />
      </Field>
      <PreviewBlock
        label={`Estimate for ${scopeLabel}`}
        value={error ? <span style={{ color: "var(--bad)" }}>{error}</span> : preview}
      />
      <EditButtons saving={saving} saveDisabled={!valid} onCancel={onCancel} onSave={save} />
    </div>
  );
}

function AdsPanel({ meta, connected, onOpenSource, onCancel }) {
  return (
    <div className="pnl-edit col">
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "10px 16px" }}>
        <span className="pnl-sub">
          <strong style={{ fontWeight: 600, color: "var(--ink)" }}>{meta.label}</strong> is the spend synced from{" "}
          {meta.sourceLabel}, day by day — it isn&apos;t set by hand.{" "}
          {connected ? "Manage the connected account in Data sources." : `Connect ${meta.sourceLabel} to fill it in.`}
        </span>
        <div className="pnl-edit-actions">
          <button type="button" className="pnl-ctl" onClick={onCancel}>
            Close
          </button>
          <button type="button" className="pnl-btn" onClick={() => onOpenSource(meta.source)}>
            {connected ? "Go to Data sources" : `Connect ${meta.sourceLabel}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function TotalPanel({ row, kids, ctx, onEdit, onCancel }) {
  return (
    <div className="pnl-edit col">
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "10px 16px" }}>
        <span className="pnl-sub">
          <strong style={{ fontWeight: 600, color: "var(--ink)" }}>{lineLabel(row)}</strong> is calculated:{" "}
          {SECTIONS[row.section]?.formula}. Edit the lines that feed it.
        </span>
        <button type="button" className="pnl-ctl" onClick={onCancel}>
          Close
        </button>
      </div>
      <div className="pnl-edit-actions">
        {kids.map((kid) => {
          const editable = LINES[kid.key]?.kind && LINES[kid.key].kind !== "orders";
          return (
            <button
              key={kid.key}
              type="button"
              className="pnl-ctl pnl-part"
              onClick={() => editable && onEdit(kid)}
              disabled={!editable}
            >
              <span>{lineLabel(kid)}</span>
              <span className="pnl-part-basis">{basisFor(kid, ctx) || DASH}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function PctCell({ value, cost, missing }) {
  const width = missing ? 0 : Math.max(0, Math.min(100, Math.abs(num(value))));
  return (
    <span className="pnl-pct">
      <span className="pnl-pct-track" aria-hidden="true">
        <span style={{ width: `${width}%`, background: cost ? "var(--prev)" : "var(--accent-mark)" }} />
      </span>
      <span className="pnl-pct-val">{missing ? DASH : formatPercent(value)}</span>
    </span>
  );
}

export default function PnlStatement({
  brandKey,
  rows,
  loading,
  scopeLabel,
  prevLabel,
  hasSelection,
  onClearSelection,
  collapsed,
  onCollapsedChange,
  highlighted,
  config,
  configError,
  onConfigSaved,
  adSources,
  onOpenSource,
  days,
  formatAmount,
}) {
  const [editKey, setEditKey] = useState(null);
  const [saved, setSaved] = useState({}); // key -> "just" | "pending"

  // A "Saved" badge turns into "Pending rebuild" after a moment.
  useEffect(() => {
    const just = Object.keys(saved).filter((k) => saved[k] === "just");
    if (!just.length) return undefined;
    const t = setTimeout(
      () => setSaved((cur) => Object.fromEntries(Object.entries(cur).map(([k, v]) => [k, v === "just" ? "pending" : v]))),
      2600,
    );
    return () => clearTimeout(t);
  }, [saved]);

  useEffect(() => {
    setEditKey(null);
    setSaved({});
  }, [brandKey]);

  const lines = Object.fromEntries(rows.map((r) => [r.key, r]));
  const net = lines.netSales?.amount;
  const ctx = {
    brandKey,
    config,
    adSources,
    saved,
    formatAmount,
    scopeLabel,
    days,
    net: isMissingValue(net) ? 0 : net,
    ebitda: lines.ebitda?.amount,
  };

  const allCollapsed = SECTION_ORDER.every((s) => collapsed[s]);
  const toggleAll = () => {
    onCollapsedChange(Object.fromEntries(SECTION_ORDER.map((s) => [s, !allCollapsed])));
    setEditKey(null);
  };
  const openEdit = (row) => {
    if (editKey === row.key) {
      setEditKey(null);
      return;
    }
    if (!row.isSubtotal && collapsed[row.section]) onCollapsedChange({ ...collapsed, [row.section]: false });
    setEditKey(row.key);
  };
  const handleSaved = (nextConfig, key) => {
    onConfigSaved(nextConfig);
    setSaved((cur) => ({ ...cur, [key]: "just" }));
    setEditKey(null);
  };

  const renderEditor = (row) => {
    if (editKey !== row.key) return null;
    const meta = LINES[row.key] || {};
    const cancel = () => setEditKey(null);
    if (row.isSubtotal) {
      const kids = rows.filter((r) => r.section === row.section && !r.isSubtotal);
      return <TotalPanel row={row} kids={kids} ctx={ctx} onEdit={openEdit} onCancel={cancel} />;
    }
    if (meta.kind === "gst")
      return <GstEditor gstPct={config?.gstPct} lines={lines} ctx={ctx} onSaved={handleSaved} onCancel={cancel} />;
    if (meta.kind === "ads")
      return (
        <AdsPanel
          meta={meta}
          connected={!!adSources[meta.source]?.connected}
          onOpenSource={(source) => {
            setEditKey(null);
            onOpenSource(source);
          }}
          onCancel={cancel}
        />
      );
    if (meta.kind === "cost")
      return (
        <CostEditor
          key={`${row.key}:${JSON.stringify(config?.costs?.[meta.config] || null)}`}
          row={row}
          field={meta.config}
          line={config?.costs?.[meta.config] || null}
          ctx={ctx}
          onSaved={handleSaved}
          onCancel={cancel}
        />
      );
    return null;
  };

  const renderRow = (row) => {
    const meta = LINES[row.key] || {};
    const label = lineLabel(row);
    const missing = isMissingValue(row.amount);
    const editing = editKey === row.key;
    const hl = highlighted === row.section;
    // Deductions arrive negated, so their changePct runs backwards: flip it
    // to the change in the cost itself, where going up is bad.
    const change = row.isDeduction && !isMissingValue(row.changePct) ? -row.changePct : row.changePct;
    const changeCell = (
      <span className="pnl-r" style={{ fontWeight: 600, color: deltaTone(change, !row.isDeduction) }}>
        {formatDelta(change)}
      </span>
    );
    const editable = row.isSubtotal || (meta.kind && meta.kind !== "orders");
    const pen = editable ? (
      <button
        type="button"
        className="pnl-pen"
        onClick={() => openEdit(row)}
        aria-label={`Edit ${label}`}
        aria-expanded={editing}
      >
        <Icon d={ICONS.pen} size={17} stroke={1.8} />
      </button>
    ) : (
      <span />
    );

    if (row.isSubtotal) {
      const closed = !!collapsed[row.section];
      const count = rows.filter((r) => r.section === row.section && !r.isSubtotal).length;
      return (
        <div className={`pnl-tr pnl-row tot${hl ? " hl" : ""}`}>
          <button
            type="button"
            className="pnl-tot-toggle"
            onClick={() => onCollapsedChange({ ...collapsed, [row.section]: !closed })}
            aria-expanded={!closed}
          >
            <Icon d={closed ? ICONS.chevRight : ICONS.chevDown} stroke={2.2} />
            <span>{label}</span>
            {closed ? <span className="pnl-tot-count">{count} lines hidden</span> : null}
          </button>
          <span className="pnl-r">{formatAmountOrMissing(formatAmount, row.amount)}</span>
          <PctCell value={row.pctOfNetSales} missing={isMissingValue(row.pctOfNetSales)} />
          <span className="pnl-r pnl-muted">{formatAmountOrMissing(formatAmount, row.previousAmount)}</span>
          {changeCell}
          {pen}
        </div>
      );
    }

    const badge = badgeFor(row, ctx);
    const basis = basisFor(row, ctx);
    return (
      <div className={`pnl-tr pnl-row${hl ? " hl" : ""}`}>
        <div className="pnl-line-label">
          <span className="pnl-line-name">
            <span>{label}</span>
            {badge ? <Pill tone={badge.tone}>{badge.text}</Pill> : null}
          </span>
          {basis ? <span className="pnl-basis">{basis}</span> : null}
        </div>
        <span className="pnl-r">{formatAmountOrMissing(formatAmount, row.amount)}</span>
        <PctCell value={row.pctOfNetSales} cost={row.isDeduction} missing={missing || isMissingValue(row.pctOfNetSales)} />
        <span className="pnl-r pnl-muted">{formatAmountOrMissing(formatAmount, row.previousAmount)}</span>
        {changeCell}
        {pen}
      </div>
    );
  };

  return (
    <section id="statement" className="pnl-card pnl-statement" aria-label="P&L statement">
      <div className="pnl-statement-head">
        <div className="pnl-stack">
          <h2 className="pnl-h2">P&amp;L statement</h2>
          <span className="pnl-sub">
            {scopeLabel} compared with {prevLabel}
            {config?.updatedAt
              ? ` · Costs last saved ${dayjs(config.updatedAt).format("DD MMM YYYY, HH:mm")}${config.updatedByEmail ? ` by ${config.updatedByEmail}` : ""}`
              : ""}
          </span>
        </div>
        <div className="pnl-filters">
          {hasSelection ? (
            <button type="button" className="pnl-ctl" onClick={onClearSelection} style={{ padding: "0 12px", fontSize: 13 }}>
              <span>Show full range</span>
              <Icon d={ICONS.close} size={14} stroke={2.2} />
            </button>
          ) : null}
          <button type="button" className="pnl-ctl" onClick={toggleAll} style={{ fontSize: 13 }}>
            {allCollapsed ? "Expand all" : "Collapse all"}
          </button>
        </div>
      </div>

      {configError ? (
        <div style={{ padding: "0 20px 14px" }}>
          <Banner tone="bad">{configError} Line settings can still be saved.</Banner>
        </div>
      ) : null}

      <div className="pnl-scroll">
        <div className="pnl-table">
          <div className="pnl-tr pnl-th">
            <span>Line item</span>
            <span className="pnl-r">Amount</span>
            <span className="pnl-r">% of net sales</span>
            <span className="pnl-r">Previous</span>
            <span className="pnl-r">Change</span>
            <span className="pnl-c">Edit</span>
          </div>

          {loading ? (
            Array.from({ length: 10 }, (_, i) => (
              <div key={i} className="pnl-tr pnl-row" style={{ minHeight: 50 }}>
                <Skeleton width="60%" height={14} style={{ marginLeft: 24 }} />
                <Skeleton height={14} />
                <Skeleton height={14} />
                <Skeleton height={14} />
                <Skeleton height={14} />
                <span />
              </div>
            ))
          ) : rows.length === 0 ? (
            <div className="pnl-empty-row">No P&amp;L data for this range.</div>
          ) : (
            SECTION_ORDER.map((section) => {
              const sectionRows = rows.filter((r) => r.section === section);
              return (
                <Fragment key={section}>
                  {sectionRows.map((row) =>
                    !row.isSubtotal && collapsed[section] ? null : (
                      <Fragment key={row.key}>
                        {renderRow(row)}
                        {renderEditor(row)}
                      </Fragment>
                    ),
                  )}
                </Fragment>
              );
            })
          )}
        </div>
      </div>
    </section>
  );
}

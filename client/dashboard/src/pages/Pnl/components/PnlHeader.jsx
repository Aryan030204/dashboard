import { useCallback, useEffect, useState } from "react";
import dayjs from "dayjs";
import { Field, Icon, Segmented } from "./pnlUi.jsx";
import { ICONS, useDismiss } from "./pnlIcons.js";
import { ISO, PRESETS, formatRange } from "../pnlFormat.js";

function FilterMenu({ id, label, value, openId, setOpenId, disabled, title, children }) {
  const open = openId === id;
  const close = useCallback(() => setOpenId((cur) => (cur === id ? null : cur)), [id, setOpenId]);
  const ref = useDismiss(open, close);
  return (
    <div className="pnl-filter" ref={ref}>
      <button
        type="button"
        className="pnl-ctl"
        onClick={() => setOpenId(open ? null : id)}
        aria-expanded={open}
        aria-haspopup="true"
        disabled={disabled}
        title={title}
      >
        <span className="pnl-filter-label">{label}</span>
        <span className="pnl-filter-value">{value}</span>
        <Icon d={ICONS.chevDown} />
      </button>
      {open ? <div className="pnl-menu">{children}</div> : null}
    </div>
  );
}

function Option({ selected, onPick, children }) {
  return (
    <button type="button" className={selected ? "pnl-opt on" : "pnl-opt"} onClick={onPick}>
      <span>{children}</span>
      {selected ? <Icon d={ICONS.check} stroke={2.6} label="Selected" /> : null}
    </button>
  );
}

function CustomRange({ start, end, onApply }) {
  const [draftStart, setDraftStart] = useState(start);
  const [draftEnd, setDraftEnd] = useState(end);
  useEffect(() => {
    setDraftStart(start);
    setDraftEnd(end);
  }, [start, end]);
  const today = dayjs().format(ISO);
  const valid = draftStart && draftEnd && draftStart <= draftEnd && draftEnd <= today;
  return (
    <div className="pnl-menu-custom">
      <Field label="From">
        <input type="date" value={draftStart} max={today} onChange={(e) => setDraftStart(e.target.value)} />
      </Field>
      <Field label="To">
        <input type="date" value={draftEnd} max={today} onChange={(e) => setDraftEnd(e.target.value)} />
      </Field>
      <button type="button" className="pnl-btn" disabled={!valid} onClick={() => onApply(draftStart, draftEnd)}>
        Apply range
      </button>
    </div>
  );
}

export default function PnlHeader({ granularity, onGranularityChange, preset, range, onPresetChange, onCustomRange }) {
  const [openId, setOpenId] = useState(null);
  const presets = PRESETS[granularity];
  const presetLabel =
    preset === "custom" ? formatRange(range.start, range.end) : presets.find((p) => p.id === preset)?.label;

  return (
    <header className="pnl-header">
      <div className="pnl-stack" style={{ gap: 4, minWidth: 0 }}>
        <span className="pnl-crumb">Finance / P&amp;L</span>
        <h1 className="pnl-title">Profit &amp; Loss</h1>
        <p style={{ fontSize: 14, color: "var(--muted)" }}>
          Gross Sales to EBITDA, line by line. Rebuilt nightly through yesterday.
        </p>
      </div>

      <div className="pnl-filters">
        <FilterMenu id="range" label="Range" value={presetLabel} openId={openId} setOpenId={setOpenId}>
          {presets.map((p) => (
            <Option
              key={p.id}
              selected={p.id === preset}
              onPick={() => {
                setOpenId(null);
                onPresetChange(p.id);
              }}
            >
              {p.label}
            </Option>
          ))}
          <div className="pnl-menu-sep" />
          <CustomRange
            start={range.start}
            end={range.end}
            onApply={(start, end) => {
              setOpenId(null);
              onCustomRange(start, end);
            }}
          />
        </FilterMenu>

        <FilterMenu
          id="channel"
          label="Channel"
          value="All channels"
          openId={openId}
          setOpenId={setOpenId}
          disabled
          title="Channel-level breakdown is coming soon"
        />
        <FilterMenu
          id="product"
          label="Products"
          value="All products"
          openId={openId}
          setOpenId={setOpenId}
          disabled
          title="Product-level breakdown is coming soon"
        />

        <Segmented
          label="Granularity"
          value={granularity}
          onChange={onGranularityChange}
          options={[
            { value: "daily", label: "Daily" },
            { value: "monthly", label: "Monthly" },
          ]}
        />
      </div>
    </header>
  );
}

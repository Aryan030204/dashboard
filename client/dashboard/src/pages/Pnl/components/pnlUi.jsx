import { ICONS } from "./pnlIcons.js";

export function Icon({ d, size = 16, stroke = 2, label, style }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
      style={{ flex: "0 0 auto", ...style }}
    >
      <path d={d} />
    </svg>
  );
}


export function Segmented({ options, value, onChange, label }) {
  return (
    <div className="pnl-seg" role="group" aria-label={label}>
      {options.map((option) => {
        const on = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            className={on ? "pnl-md on" : "pnl-md"}
            aria-pressed={on}
            onClick={() => !on && onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function Pill({ tone = "good", children, style }) {
  return (
    <span className={`pnl-pill ${tone}`} style={style}>
      {children}
    </span>
  );
}

// tone: "warn" (default) | "bad" | "good" | "info"
export function Banner({ tone = "warn", title, children, action, onAction, onDismiss }) {
  return (
    <div className={`pnl-banner ${tone === "warn" ? "" : tone}`} role={tone === "bad" ? "alert" : "status"}>
      <Icon d={tone === "warn" || tone === "bad" ? ICONS.warn : tone === "good" ? ICONS.check : ICONS.info} size={18} stroke={1.9} />
      <span className="pnl-banner-text">
        {title ? <strong>{title}</strong> : null}
        {title && children ? " " : null}
        {children}
      </span>
      {action ? (
        <button type="button" className="pnl-ghost" onClick={onAction}>
          {action}
        </button>
      ) : null}
      {onDismiss ? (
        <button type="button" className="pnl-ghost icon" onClick={onDismiss} aria-label="Dismiss">
          <Icon d={ICONS.close} />
        </button>
      ) : null}
    </div>
  );
}

export function Field({ label, prefix, suffix, hint, children, style }) {
  return (
    <label className="pnl-label" style={style}>
      {label ? <span className="pnl-label-text">{label}</span> : null}
      <span className="pnl-field">
        {prefix ? <span className="pnl-field-affix">{prefix}</span> : null}
        {children}
        {suffix ? <span className="pnl-field-affix">{suffix}</span> : null}
      </span>
      {hint ? <span className="pnl-hint">{hint}</span> : null}
    </label>
  );
}

export function Skeleton({ width = "100%", height = 16, style }) {
  return <span className="pnl-skel" aria-hidden="true" style={{ width, height, ...style }} />;
}

// Multi-select list of { id, label, detail } with checkboxes.
export function Checklist({ label, options, value, onChange }) {
  const selected = new Set(value);
  return (
    <div className="pnl-label">
      {label ? <span className="pnl-label-text">{label}</span> : null}
      <div className="pnl-checklist" role="group" aria-label={label}>
        {options.map((option) => (
          <label key={option.id} className="pnl-check">
            <input
              type="checkbox"
              checked={selected.has(option.id)}
              onChange={(e) =>
                onChange(e.target.checked ? [...value, option.id] : value.filter((id) => id !== option.id))
              }
            />
            <span className="pnl-stack" style={{ minWidth: 0 }}>
              <span style={{ fontWeight: 600 }}>{option.label}</span>
              {option.detail ? <span className="pnl-hint">{option.detail}</span> : null}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

// A data-source card: name, status pill, then whatever the card holds.
export function SourceCard({ id, name, status, tone, children }) {
  return (
    <div className="pnl-source" id={id}>
      <div className="pnl-source-head">
        <h3>{name}</h3>
        {status ? (
          <Pill tone={tone} style={{ fontSize: 11.5, padding: "2px 9px" }}>
            {status}
          </Pill>
        ) : null}
      </div>
      {children}
    </div>
  );
}

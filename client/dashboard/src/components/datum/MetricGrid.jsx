// Presentation only: connected metric cells. Receives already-formatted values;
// it never calculates, rounds or formats a metric.
export function MetricGrid({ columns = 4, keepThreeOnPhone = false, ariaLabel, children, className = "" }) {
  return (
    <div
      className={`dz-mg${keepThreeOnPhone ? " is-keep3" : ""} ${className}`.trim()}
      style={{ "--dz-cols": columns }}
      role={ariaLabel ? "group" : undefined}
      aria-label={ariaLabel}
    >
      {children}
    </div>
  );
}

// tone: "good" | "bad" | "flat" is decided by the caller from its own existing logic.
export function Delta({ tone = "flat", children }) {
  return <span className={`dz-d is-${tone}`}>{children}</span>;
}

export function MetricCell({ label, value, unit, delta, deltaTone = "flat", hint, selected = false, onClick, extra = null, ariaLabel }) {
  const body = (
    <>
      <div className="dz-ml"><span>{label}</span>{extra}</div>
      <div className="dz-mv">{value}{unit ? <small>{unit}</small> : null}</div>
      {(delta != null && delta !== "") || hint ? (
        <div className="dz-md">
          {delta != null && delta !== "" ? <Delta tone={deltaTone}>{delta}</Delta> : null}
          {hint ? <span>{hint}</span> : null}
        </div>
      ) : null}
    </>
  );
  const cls = `dz-mc${selected ? " is-sel" : ""}`;
  return onClick ? (
    <button type="button" className={cls} onClick={onClick} aria-pressed={selected} aria-label={ariaLabel}>{body}</button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export default MetricGrid;

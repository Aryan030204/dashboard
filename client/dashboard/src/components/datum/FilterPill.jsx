// Presentation only: visual trigger for a filter. It never opens anything itself;
// `onClick` is the caller's existing handler (which opens the existing popover/state).
// With `readOnly` it renders a non-interactive chip that merely displays current state.
const Chevron = () => (
  <svg className="dz-pill-chev" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 9l6 6 6-6" />
  </svg>
);

export default function FilterPill({ label, value, onClick, active = false, disabled = false, readOnly = false, chevron = true, ariaLabel, ...rest }) {
  const content = (
    <>
      {label ? <span className="dz-pill-k">{label}</span> : null}
      <span>{value}</span>
      {!readOnly && chevron ? <Chevron /> : null}
    </>
  );
  const cls = `dz-pill${active ? " is-on" : ""}${readOnly ? " is-static" : ""}`;
  if (readOnly) {
    return <span className={cls} aria-label={ariaLabel} {...rest}>{content}</span>;
  }
  return (
    <button type="button" className={cls} onClick={onClick} disabled={disabled} aria-label={ariaLabel} {...rest}>
      {content}
    </button>
  );
}

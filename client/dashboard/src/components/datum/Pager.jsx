// Presentation + callback only. Works for page-based and cursor-based paging:
// the caller supplies the label and the prev/next handlers; nothing is computed here.
const Chev = ({ d }) => (
  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

export default function Pager({ label, onPrev, onNext, prevDisabled = false, nextDisabled = false, leading = null, className = "" }) {
  return (
    <div className={`dz-pager ${className}`.trim()}>
      {leading}
      {label ? <span className="dz-num">{label}</span> : null}
      <button type="button" aria-label="Previous page" onClick={onPrev} disabled={prevDisabled}><Chev d="M15 6l-6 6 6 6" /></button>
      <button type="button" aria-label="Next page" onClick={onNext} disabled={nextDisabled}><Chev d="M9 6l6 6-6 6" /></button>
    </div>
  );
}

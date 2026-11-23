// Presentation only: layout wrapper for filter pills/controls. Owns no filter state.
export default function FilterBar({ children, ariaLabel = "Filters", className = "" }) {
  return (
    <div className={`dz-fbar ${className}`.trim()} role="group" aria-label={ariaLabel}>
      {children}
    </div>
  );
}

export const FilterBarSeparator = () => <span className="dz-fbar-sep" aria-hidden="true" />;

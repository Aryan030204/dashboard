// Presentation + callback only: a controlled button group (value/onChange come from the caller).
export default function Segmented({ options, value, onChange, ariaLabel, disabled = false }) {
  return (
    <div className="dz-seg" role="group" aria-label={ariaLabel}>
      {options.map((opt) => {
        const o = typeof opt === "object" ? opt : { value: opt, label: opt };
        return (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={value === o.value}
            disabled={disabled || o.disabled}
            title={o.title}
            onClick={() => onChange?.(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

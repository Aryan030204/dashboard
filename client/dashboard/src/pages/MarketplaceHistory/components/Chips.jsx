import { colorOf } from "../marketplaceFormat.js";

export const Dot = ({ code, color }) => (
  <i className="mh-dot" style={{ "--mh-color": color || colorOf(code) }} aria-hidden="true" />
);

// Toggle chips; at least one marketplace always stays selected.
export default function Chips({ marketplaces, selected, onChange }) {
  const toggle = (code) => {
    const next = selected.includes(code) ? selected.filter((c) => c !== code) : [...selected, code];
    if (next.length) onChange(next);
  };
  return (
    <div className="mh-row" role="group" aria-label="Marketplaces">
      {marketplaces.map((m) => (
        <button
          key={m.code}
          type="button"
          className="mh-chip"
          style={{ "--mh-color": colorOf(m.code) }}
          aria-pressed={selected.includes(m.code)}
          onClick={() => toggle(m.code)}
        >
          <Dot code={m.code} />
          {m.name}
        </button>
      ))}
    </div>
  );
}

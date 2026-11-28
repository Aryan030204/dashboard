import { Panel, Segmented } from "../../../components/datum/index.js";
import { RANGES, rangeParams } from "../marketplaceFormat.js";
import Chips from "./Chips.jsx";

export default function FilterRow({
  preset, custom, onPreset, onCustom, unit, onUnit, marketplaces, selected, onSelected, pincodes, pincode, onPincode,
}) {
  const shown = rangeParams(preset, custom);
  // Both dates are needed; choosing one keeps the other as it is shown.
  const change = (key) => (event) => {
    const value = event.target.value;
    if (!value) return;
    const next = { start: shown.start || value, end: shown.end || value, [key]: value };
    if (next.start <= next.end) onCustom(next);
  };
  return (
    <Panel ariaLabel="Filters">
      <div className="mh-row">
        <Segmented ariaLabel="Date range" options={RANGES} value={custom ? null : preset} onChange={onPreset} />
        <label className="mh-label">
          <input type="date" className="mh-control" aria-label="From" value={shown.start || ""} onChange={change("start")} />
          to
          <input type="date" className="mh-control" aria-label="To" value={shown.end || ""} onChange={change("end")} />
        </label>
        <div className="mh-push">
          <Segmented
            ariaLabel="Gap unit"
            options={[{ value: "pct", label: "% gap" }, { value: "abs", label: "₹ gap" }]}
            value={unit}
            onChange={onUnit}
          />
        </div>
      </div>
      {marketplaces.length > 0 && (
        <div className="mh-row">
          <Chips marketplaces={marketplaces} selected={selected} onChange={onSelected} />
          {pincodes.length > 0 && selected.includes("BLINKIT") && (
            <label className="mh-label mh-push">
              Blinkit pincode
              <select className="mh-control" value={pincode} onChange={(e) => onPincode(e.target.value)}>
                {pincodes.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
          )}
        </div>
      )}
    </Panel>
  );
}

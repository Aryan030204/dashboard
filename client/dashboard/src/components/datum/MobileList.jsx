// Presentation only. Renders the SAME page-owned rows as DataTable in a compact list.
// The page chooses between DataTable and MobileList with its own existing breakpoint check,
// so exactly one is rendered. mapRow(row) -> { title, subtitle: [node...], value, delta }.
export default function MobileList({ rows, getRowKey, mapRow, empty = null, emptyLabel = "No data", ariaLabel }) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return empty || <div className="dz-tbl-empty">{emptyLabel}</div>;
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0 }} aria-label={ariaLabel}>
      {list.map((row, i) => {
        const m = mapRow(row, i) || {};
        return (
          <li key={getRowKey ? getRowKey(row, i) : i} className="dz-mrow">
            <div className="dz-mrow-l">
              <div className="dz-mrow-t">{m.title}</div>
              {m.subtitle && m.subtitle.length ? (
                <div className="dz-mrow-s">
                  {m.subtitle.map((s, j) => (
                    <span key={j}>{s}</span>
                  ))}
                </div>
              ) : null}
            </div>
            {m.value != null || m.delta != null ? (
              <div className="dz-mrow-r">
                {m.value != null ? <div className="dz-mrow-v">{m.value}</div> : null}
                {m.delta != null ? <div>{m.delta}</div> : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

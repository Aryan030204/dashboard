// Presentation only. The page owns rows, sorting, filtering, pagination, search and any Redux/API work.
// columns: [{ key, header, align: "left"|"right", render?(row, index), className?, sortable? }]
// sort (optional): { key, direction: "asc"|"desc" } is only displayed; clicking a sortable header calls onSort(key).
const Arrow = ({ dir }) => (
  <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d={dir === "asc" ? "M12 19V5M6 11l6-6 6 6" : "M12 5v14M6 13l6 6 6-6"} />
  </svg>
);

export default function DataTable({ columns, rows, getRowKey, caption, ariaLabel, dense = false, sort, onSort, empty = null, emptyLabel = "No data", rowProps }) {
  const list = Array.isArray(rows) ? rows : [];
  return (
    <div className="dz-tw">
      <table className={`dz-tbl${dense ? " is-dense" : ""}`} aria-label={ariaLabel}>
        {caption ? <caption style={{ position: "absolute", left: -9999 }}>{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((c) => {
              const active = sort && sort.key === c.key;
              const ariaSort = active ? (sort.direction === "asc" ? "ascending" : "descending") : undefined;
              return (
                <th key={c.key} scope="col" className={c.align === "right" ? "is-r" : undefined} aria-sort={ariaSort}>
                  {c.sortable && onSort ? (
                    <button type="button" onClick={() => onSort(c.key)}>
                      {c.header}
                      {active ? <Arrow dir={sort.direction} /> : null}
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {list.map((row, i) => (
            <tr key={getRowKey ? getRowKey(row, i) : i} {...(rowProps ? rowProps(row, i) : {})}>
              {columns.map((c) => {
                const cls = [c.align === "right" ? "is-r" : "", c.className || ""].join(" ").trim();
                return (
                  <td key={c.key} className={cls || undefined}>
                    {c.render ? c.render(row, i) : row[c.key]}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {list.length === 0 ? empty || <div className="dz-tbl-empty">{emptyLabel}</div> : null}
    </div>
  );
}

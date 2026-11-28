import { useMemo, useState } from "react";
import { useMediaQuery } from "@mui/material";
import { toast } from "react-toastify";
import { DataTable, MobileList, Panel, Tag } from "../../../components/datum/index.js";
import { DASH, band, cheapest, gapText, money, shortDay, toCsv } from "../marketplaceFormat.js";
import { Dot } from "./Chips.jsx";

function Cell({ cell, unit }) {
  if (!cell || cell.state === "unlisted") return <span className="mh-muted" title="Not listed on this marketplace">n/a</span>;
  if (cell.state === "unread") return <span className="mh-muted" title="Listed, but no price was read in this range">not read</span>;
  const old = cell.stale ? <small title="Not read on the latest check">as of {shortDay(cell.day)}</small> : null;
  if (cell.state === "oos") return <span className="mh-cell"><span className="mh-oos">Out of stock</span>{old}</span>;
  return (
    <span className="mh-cell">
      <span className={`mh-gap is-${band(cell.gap?.pct)}`}>{gapText(cell.gap, unit)}</span>
      <small>{money(cell.price)}</small>
      {old}
    </span>
  );
}

export default function ProductTable({ rows, marketplaces, unit, selectedVariant, onSelect }) {
  const isMobile = useMediaQuery("(max-width:900px)");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState({ key: "rank", direction: "asc" });
  const codes = marketplaces.map((m) => m.code);
  const names = Object.fromEntries(marketplaces.map((m) => [m.code, m.name]));

  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const value = {
      rank: (r) => r.rank ?? Infinity,
      product: (r) => r.product.toLowerCase(),
      ourPrice: (r) => r.ourPrice ?? Infinity,
    }[sort.key];
    const direction = sort.direction === "asc" ? 1 : -1;
    return rows
      .filter((r) => !needle || r.product.toLowerCase().includes(needle))
      .sort((a, b) => (value(a) < value(b) ? -direction : value(a) > value(b) ? direction : 0));
  }, [rows, search, sort]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(toCsv(shown, marketplaces));
      toast.success(`Copied ${shown.length} rows as CSV`);
    } catch {
      toast.error("Could not copy to the clipboard");
    }
  };

  const onSort = (key) => setSort((s) => ({ key, direction: s.key === key && s.direction === "asc" ? "desc" : "asc" }));
  const low = (row) => cheapest(row, codes);
  const pill = (row) => {
    const best = low(row);
    return best ? <Tag><Dot code={best.code} />{names[best.code]}</Tag> : <span className="mh-muted">{DASH}</span>;
  };

  const columns = [
    { key: "product", header: "Product", sortable: true, render: (r) => <span className="mh-product">{r.product}</span> },
    { key: "size", header: "Size", align: "right", render: (r) => r.size || DASH },
    { key: "ourPrice", header: "Our SP", align: "right", sortable: true, render: (r) => money(r.ourPrice) },
    { key: "mrp", header: "MRP", align: "right", className: "is-m", render: (r) => money(r.mrp) },
    ...marketplaces.map((m) => ({
      key: m.code,
      header: <><Dot code={m.code} /> {m.name}</>,
      align: "right",
      render: (r) => <Cell cell={r.cells[m.code]} unit={unit} />,
    })),
    { key: "lowest", header: "Lowest price", align: "right", render: (r) => money(low(r)?.price) },
    { key: "cheapest", header: "Cheapest on", render: pill },
    { key: "rank", header: "Order rank", align: "right", sortable: true, render: (r) => (r.rank ? <Tag>#{r.rank}</Tag> : DASH) },
  ];

  const open = (row) => ({
    className: `mh-click${row.variantId === selectedVariant ? " is-selected" : ""}`,
    tabIndex: 0,
    onClick: () => onSelect(row.variantId),
    onKeyDown: (e) => { if (e.key === "Enter") onSelect(row.variantId); },
  });

  return (
    <Panel
      title="Product by marketplace"
      subtitle="Latest price read. Select a product to see its price history below."
      flush
      actions={(
        <>
          <input className="mh-control" type="search" placeholder="Search product" aria-label="Search product" value={search}
            onChange={(e) => setSearch(e.target.value)} />
          <button type="button" className="dz-pill" onClick={copy} disabled={!shown.length}>Copy CSV</button>
        </>
      )}
    >
      {isMobile ? (
        <MobileList
          rows={shown}
          getRowKey={(r) => r.variantId}
          emptyLabel="No products"
          mapRow={(r) => ({
            title: (
              <button type="button" className="mh-click" onClick={() => onSelect(r.variantId)}
                style={{ all: "unset", cursor: "pointer" }}>
                {r.product}
              </button>
            ),
            subtitle: [r.size, `Ours ${money(r.ourPrice)}`, ...codes.filter((c) => r.cells[c]?.state === "ok")
              .map((c) => `${names[c]} ${gapText(r.cells[c].gap, unit)}`)].filter(Boolean),
            value: money(low(r)?.price),
            delta: pill(r),
          })}
        />
      ) : (
        <DataTable columns={columns} rows={shown} getRowKey={(r) => r.variantId} rowProps={open} sort={sort} onSort={onSort}
          ariaLabel="Product prices by marketplace" emptyLabel="No products" />
      )}
      <div className="dz-pf" style={{ justifyContent: "flex-start" }}>
        <span><span className="mh-gap is-deep">▼ 15%</span> or more below our price</span>
        <span><span className="mh-gap is-below">▼</span> below</span>
        <span><strong>at par</strong> within 1%</span>
        <span><span className="mh-gap is-above">▲</span> above our price</span>
        <span>n/a not listed</span>
        <span>Shows each product&apos;s main size; other sizes are in the history below.</span>
      </div>
    </Panel>
  );
}

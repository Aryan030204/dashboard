import { useMemo, useState } from "react";
import {
  Alert,
  Card,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel,
  Typography,
} from "@mui/material";
import { MISSING, formatCount, formatPct, formatRoas, isMissing } from "../adsFormat.js";

const COLUMNS = [
  { id: "spend", label: "Ad spend", type: "currency" },
  { id: "metaSpend", label: "Meta spend", type: "currency" },
  { id: "googleSpend", label: "Google spend", type: "currency" },
  { id: "sales", label: "Paid-traffic sales", type: "currency" },
  { id: "orders", label: "Orders", type: "count" },
  { id: "roas", label: "ROAS", type: "roas" },
  { id: "metaRoas", label: "Meta ROAS", type: "roas" },
  { id: "googleRoas", label: "Google ROAS", type: "roas" },
];

function formatCell(type, value, formatAmount) {
  if (type === "currency") return isMissing(value) ? MISSING : formatAmount(value);
  if (type === "roas") return formatRoas(value);
  return formatCount(value);
}

export default function AdsProductTable({ data, loading, formatAmount }) {
  const [sort, setSort] = useState({ key: "spend", direction: "desc" });
  const rows = useMemo(() => {
    const products = data?.products || [];
    const sorted = products
      .filter((p) => !p.unattributed)
      .sort((a, b) => {
        const av = a[sort.key];
        const bv = b[sort.key];
        if (isMissing(av) && isMissing(bv)) return 0;
        if (isMissing(av)) return 1;
        if (isMissing(bv)) return -1;
        return sort.direction === "asc" ? av - bv : bv - av;
      });
    // The unattributed bucket always sits last, whatever the sort.
    const rest = products.find((p) => p.unattributed);
    return rest ? [...sorted, rest] : sorted;
  }, [data, sort]);

  const toggleSort = (key) =>
    setSort((prev) => (prev.key === key ? { key, direction: prev.direction === "desc" ? "asc" : "desc" } : { key, direction: "desc" }));

  return (
    <Stack spacing={1.5}>
      <Alert severity="info" variant="outlined">
        Spend is placed on a product from the ad itself: a Meta ad whose destination is <code>/products/…</code>, or a Google
        Shopping / Performance Max item. Sales are that product's orders from Meta or Google traffic (UTM source).
        {data?.totals?.attributedShare !== null && data?.totals?.attributedShare !== undefined
          ? ` ${formatPct(data.totals.attributedShare)} of spend in this range is tied to a single product; the rest (catalog, collection, Search ads) is in the last row.`
          : ""}
      </Alert>
      <Card variant="outlined">
        <TableContainer sx={{ maxHeight: 640 }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell>Product</TableCell>
                {COLUMNS.map((col) => (
                  <TableCell key={col.id} align="right">
                    <TableSortLabel
                      active={sort.key === col.id}
                      direction={sort.key === col.id ? sort.direction : "desc"}
                      onClick={() => toggleSort(col.id)}
                    >
                      {col.label}
                    </TableSortLabel>
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {loading ? (
                [0, 1, 2].map((i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={COLUMNS.length + 1}>
                      <Skeleton />
                    </TableCell>
                  </TableRow>
                ))
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={COLUMNS.length + 1}>
                    <Typography variant="body2" color="text.secondary" sx={{ py: 2, textAlign: "center" }}>
                      No product-level spend for this range.
                    </Typography>
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((product) => (
                  <TableRow key={product.productId} hover sx={product.unattributed ? { "& td": { color: "text.secondary", fontStyle: "italic" } } : undefined}>
                    <TableCell sx={{ maxWidth: 320 }}>
                      <Typography variant="body2" noWrap title={product.title} sx={{ fontWeight: product.unattributed ? 400 : 500 }}>
                        {product.title}
                      </Typography>
                      {product.path ? (
                        <Typography variant="caption" color="text.secondary" noWrap component="div">
                          {product.path}
                        </Typography>
                      ) : null}
                    </TableCell>
                    {COLUMNS.map((col) => (
                      <TableCell key={col.id} align="right">
                        {formatCell(col.type, product[col.id], formatAmount)}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Card>
    </Stack>
  );
}

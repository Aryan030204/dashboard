import { useMemo } from "react";
import {
  Box,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  ToggleButton,
  ToggleButtonGroup,
} from "@mui/material";
import { SectionCard } from "./shared.jsx";
import {
  TOP_PRODUCT_TABS,
  formatCount,
  formatPct,
} from "./intentFunnelUtils.js";

export default function TopProductsByIntent({
  products = [],
  sortBy,
  onSortByChange,
  limit = 5,
}) {
  const rows = useMemo(
    () => [...products].sort((a, b) => b[sortBy] - a[sortBy]).slice(0, limit),
    [products, sortBy, limit],
  );

  return (
    <SectionCard
      title="Top Products by Intent"
      info="Products ranked by the selected intent signal."
      action={
        <ToggleButtonGroup
          size="small"
          exclusive
          value={sortBy}
          onChange={(_, value) => value && onSortByChange(value)}
          sx={{
            "& .MuiToggleButton-root": {
              textTransform: "none",
              fontSize: 12,
              px: 1,
              py: 0.25,
            },
          }}
        >
          {TOP_PRODUCT_TABS.map((tab) => (
            <ToggleButton key={tab.value} value={tab.value}>
              {tab.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      }
    >
      <TableContainer sx={{ overflowX: "auto" }}>
        <Table size="small" sx={{ minWidth: 420 }}>
          <TableHead>
            <TableRow>
              <TableCell sx={{ width: 28 }}>#</TableCell>
              <TableCell>Product</TableCell>
              <TableCell align="right">Views</TableCell>
              <TableCell align="right">Add to Cart</TableCell>
              <TableCell align="right">Checkouts</TableCell>
              <TableCell align="right">CVR</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row, idx) => (
              <TableRow key={row.id} hover>
                <TableCell>{idx + 1}</TableCell>
                <TableCell>
                  <Box sx={{ fontWeight: 500 }}>{row.name}</Box>
                </TableCell>
                <TableCell align="right">{formatCount(row.views)}</TableCell>
                <TableCell align="right">{formatCount(row.addToCart)}</TableCell>
                <TableCell align="right">{formatCount(row.checkouts)}</TableCell>
                <TableCell align="right">{formatPct(row.cvr)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </SectionCard>
  );
}

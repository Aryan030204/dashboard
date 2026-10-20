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
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import { SectionCard } from "./shared.jsx";
import {
  TOP_PRODUCT_TABS,
  formatCount,
  formatPct,
} from "./intentFunnelUtils.js";

const STATS = [
  { key: "views", label: "Views", format: formatCount },
  { key: "addToCart", label: "Add to Cart", format: formatCount },
  { key: "checkouts", label: "Checkouts", format: formatCount },
  { key: "cvr", label: "CVR", format: formatPct },
];

// Phones get one card per product instead of a six column table that would scroll sideways.
function ProductCards({ rows }) {
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
      {rows.map((row, idx) => (
        <Box
          key={row.id}
          sx={{
            p: 1.25,
            borderRadius: 1.5,
            border: "1px solid",
            borderColor: "divider",
            minWidth: 0,
          }}
        >
          <Box sx={{ display: "flex", gap: 1, alignItems: "baseline", mb: 0.75 }}>
            <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
              #{idx + 1}
            </Typography>
            <Typography variant="body2" sx={{ fontWeight: 600, overflowWrap: "anywhere", minWidth: 0 }}>
              {row.name}
            </Typography>
          </Box>
          <Box sx={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 0.75 }}>
            {STATS.map((stat) => (
              <Box key={stat.key} sx={{ minWidth: 0 }}>
                <Typography variant="caption" color="text.secondary" sx={{ display: "block", lineHeight: 1.2 }}>
                  {stat.label}
                </Typography>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  {stat.format(row[stat.key])}
                </Typography>
              </Box>
            ))}
          </Box>
        </Box>
      ))}
    </Box>
  );
}

export default function TopProductsByIntent({
  products = [],
  sortBy,
  onSortByChange,
  limit = 5,
}) {
  const theme = useTheme();
  const phone = useMediaQuery(theme.breakpoints.down("sm"));
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
            width: { xs: "100%", sm: "auto" },
            "& .MuiToggleButton-root": {
              flex: { xs: 1, sm: "none" },
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
      {phone ? (
        <ProductCards rows={rows} />
      ) : (
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
      )}
    </SectionCard>
  );
}

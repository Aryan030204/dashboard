import { useEffect, useMemo, useState } from "react";
import dayjs from "dayjs";
import {
  Box,
  Button,
  Skeleton,
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
import { alpha } from "@mui/material/styles";
import { getIntentTopProducts } from "../../lib/api.js";
import { SectionCard } from "./shared.jsx";
import {
  INTENT_COLORS,
  TOP_PRODUCT_INTENTS,
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

// "All" is the page's own list. A level (high / medium / low) is fetched on its own, so the rest of the page
// does not reload; the figures come from the pipeline's product_intent_daily rollup on the page's basis.
export default function TopProductsByIntent({
  brandKey,
  start,
  end,
  basis = "behavior",
  allProducts = [],
  limit = 5,
}) {
  const theme = useTheme();
  const phone = useMediaQuery(theme.breakpoints.down("sm"));
  const [intent, setIntent] = useState("all");
  const [result, setResult] = useState(null);
  const [status, setStatus] = useState("ready"); // loading | ready | error | unavailable
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (intent === "all" || !brandKey || !start || !end) return undefined;
    const controller = new AbortController();
    setStatus("loading");
    getIntentTopProducts(
      { brand_key: brandKey, start, end, intent, basis },
      { signal: controller.signal },
    ).then((res) => {
      if (res.aborted) return;
      if (res.error) {
        // 404: a backend without this endpoint yet
        setStatus(res.status === 404 ? "unavailable" : "error");
        return;
      }
      setResult(res.data);
      setStatus(res.data?.meta?.available === false ? "unavailable" : "ready");
    });
    return () => controller.abort();
  }, [intent, brandKey, start, end, basis, reloadKey]);

  const showingAll = intent === "all";
  const rows = useMemo(
    () => (showingAll ? allProducts : result?.topProducts || []).slice(0, limit),
    [showingAll, allProducts, result, limit],
  );
  const firstDate = result?.meta?.partial ? result.meta.firstDate : null;
  const loading = !showingAll && status === "loading";

  let body;
  if (!showingAll && status === "error") {
    body = (
      <Box sx={{ py: 4, display: "flex", flexDirection: "column", alignItems: "center", gap: 1.5 }}>
        <Typography variant="body2" color="text.secondary">
          Couldn&apos;t load the products for this intent level.
        </Typography>
        <Button size="small" variant="outlined" onClick={() => setReloadKey((n) => n + 1)}>
          Retry
        </Button>
      </Box>
    );
  } else if (!showingAll && status === "unavailable") {
    body = (
      <Typography variant="body2" color="text.secondary" sx={{ py: 4, textAlign: "center" }}>
        Products by intent level aren&apos;t available for this brand yet.
      </Typography>
    );
  } else if (!showingAll && status === "loading" && !result) {
    body = <Skeleton variant="rounded" height={200} />;
  } else if (rows.length === 0) {
    body = (
      <Typography variant="body2" color="text.secondary" sx={{ py: 4, textAlign: "center" }}>
        No {showingAll ? "" : `${intent} intent `}product activity for the selected dates.
      </Typography>
    );
  } else if (phone) {
    body = <ProductCards rows={rows} />;
  } else {
    body = (
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
    );
  }

  return (
    <SectionCard
      title="Top Products by Intent"
      info="Products ranked by views. Pick High, Medium or Low to see the products viewed in sessions at that intent level (on the Behaviour / Score switch above); All is every session."
      action={
        <ToggleButtonGroup
          size="small"
          exclusive
          value={intent}
          onChange={(_, value) => value && setIntent(value)}
          aria-label="Intent level"
          sx={{
            width: { xs: "100%", sm: "auto" },
            "& .MuiToggleButton-root": {
              flex: { xs: 1, sm: "none" },
              textTransform: "none",
              fontSize: 12,
              px: 1.25,
              py: 0.25,
            },
            ...Object.fromEntries(
              ["high", "medium", "low"].map((level) => [
                `& .MuiToggleButton-root[value="${level}"].Mui-selected`,
                {
                  color: INTENT_COLORS[level],
                  bgcolor: alpha(INTENT_COLORS[level], 0.16),
                  "&:hover": { bgcolor: alpha(INTENT_COLORS[level], 0.24) },
                },
              ]),
            ),
          }}
        >
          {TOP_PRODUCT_INTENTS.map((option) => (
            <ToggleButton key={option.value} value={option.value}>
              {option.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      }
    >
      <Box sx={{ opacity: loading ? 0.6 : 1, transition: "opacity 0.2s ease" }}>{body}</Box>
      {!showingAll && firstDate ? (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1.5 }}>
          Intent data for products starts on {dayjs(firstDate).format("D MMM YYYY")}, so earlier days in this range
          are not included.
        </Typography>
      ) : null}
    </SectionCard>
  );
}

import { useMemo, useState } from "react";
import {
  Box,
  Card,
  Chip,
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
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import { MISSING, formatCount, formatPct, formatRoas, formatSeconds, isMissing } from "../adsFormat.js";

// Status colors carry an icon + label, never color alone.
const SPEED_STATUS = {
  good: { label: "Good", color: "success", icon: <CheckCircleOutlineIcon /> },
  needs_improvement: { label: "Needs work", color: "warning", icon: <WarningAmberIcon /> },
  poor: { label: "Poor", color: "error", icon: <ErrorOutlineIcon /> },
};

const COLUMNS = [
  { id: "spend", label: "Spend", type: "currency" },
  { id: "linkClicks", label: "Link clicks", type: "count" },
  { id: "landingPageViews", label: "LPVs", type: "count" },
  { id: "lpvRate", label: "LC → LPV", type: "pct" },
  { id: "lostClicks", label: "Lost clicks", type: "count" },
  { id: "lcp", label: "LCP", type: "seconds" },
  { id: "performance", label: "Perf. score", type: "count" },
  { id: "roas", label: "ROAS", type: "roas" },
];

function formatCell(type, value, formatAmount) {
  if (type === "currency") return isMissing(value) ? MISSING : formatAmount(value);
  if (type === "pct") return formatPct(value);
  if (type === "seconds") return formatSeconds(value);
  if (type === "roas") return formatRoas(value);
  return formatCount(value);
}

function SpeedBucketCard({ bucket }) {
  const status = SPEED_STATUS[bucket.id];
  return (
    <Card variant="outlined" sx={{ p: 2, flex: 1, minWidth: 200 }}>
      <Chip size="small" icon={status.icon} label={bucket.label} color={status.color} variant="outlined" />
      <Typography variant="h5" sx={{ fontWeight: 700, mt: 1 }}>
        {formatPct(bucket.lpvRate)}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        LC → LPV across {bucket.pages} page{bucket.pages === 1 ? "" : "s"} · {formatCount(bucket.linkClicks)} link clicks
      </Typography>
    </Card>
  );
}

export default function AdsLandingPagesPanel({ data, loading, formatAmount }) {
  const [sort, setSort] = useState({ key: "lostClicks", direction: "desc" });

  const rows = useMemo(
    () =>
      [...(data?.pages || [])].sort((a, b) => {
        const av = a[sort.key];
        const bv = b[sort.key];
        if (isMissing(av) && isMissing(bv)) return 0;
        if (isMissing(av)) return 1;
        if (isMissing(bv)) return -1;
        return sort.direction === "asc" ? av - bv : bv - av;
      }),
    [data, sort],
  );

  const toggleSort = (key) =>
    setSort((prev) => (prev.key === key ? { key, direction: prev.direction === "desc" ? "asc" : "desc" } : { key, direction: "desc" }));

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          Does page speed cost us clicks?
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Link clicks that never become a landing page view usually bounced before the page loaded. Meta ads grouped by
          destination page, with that page's Largest Contentful Paint from Web Vitals for the same range.
        </Typography>
      </Box>

      <Stack direction={{ xs: "column", md: "row" }} spacing={1.5}>
        {loading
          ? [0, 1, 2].map((i) => <Skeleton key={i} variant="rounded" height={100} sx={{ flex: 1 }} />)
          : (data?.speedBuckets || []).map((bucket) => <SpeedBucketCard key={bucket.id} bucket={bucket} />)}
      </Stack>
      {data?.unmeasuredPages ? (
        <Typography variant="caption" color="text.secondary">
          {data.unmeasuredPages} landing page{data.unmeasuredPages === 1 ? " has" : "s have"} no Web Vitals reading in this
          range and {data.unmeasuredPages === 1 ? "is" : "are"} left out of the bands above.
        </Typography>
      ) : null}

      <Card variant="outlined">
        <TableContainer sx={{ maxHeight: 640 }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell>Landing page</TableCell>
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
                      No Meta link-click data for this range.
                    </Typography>
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((page) => {
                  const status = SPEED_STATUS[page.speedBucket];
                  return (
                    <TableRow key={page.landingPath || "unknown"} hover>
                      <TableCell sx={{ maxWidth: 320 }}>
                        <Stack direction="row" spacing={1} alignItems="center">
                          <Typography variant="body2" noWrap title={page.landingPath || ""}>
                            {page.landingPath || "Unknown destination (catalog / instant experience)"}
                          </Typography>
                          {status ? <Chip size="small" icon={status.icon} label={status.label} color={status.color} variant="outlined" sx={{ height: 22 }} /> : null}
                        </Stack>
                        <Typography variant="caption" color="text.secondary">
                          {page.ads} ad{page.ads === 1 ? "" : "s"}
                        </Typography>
                      </TableCell>
                      {COLUMNS.map((col) => (
                        <TableCell key={col.id} align="right">
                          {formatCell(col.type, page[col.id], formatAmount)}
                        </TableCell>
                      ))}
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Card>
    </Stack>
  );
}

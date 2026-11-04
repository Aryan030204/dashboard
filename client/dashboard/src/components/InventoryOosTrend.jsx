import { memo, useCallback, useEffect, useMemo, useState } from "react";
import dayjs from "dayjs";
import {
  Box,
  Card,
  CardContent,
  Chip,
  FormControl,
  MenuItem,
  Select,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
  useMediaQuery,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { getInventoryOosTrend } from "../lib/api.js";
import { FunnelDateRangePicker } from "./DailyFunnelPanel.jsx";
import {
  MAX_RANGE_DAYS,
  clampRange,
  defaultRange,
  formatBucketTitle,
  formatDuration,
  formatInstant,
  formatTick,
  hourlyAllowed,
  resolveGranularity,
  suggestGranularity,
} from "../lib/oosTrend.js";

const COLORS = {
  oos: "#f59e0b",
  newOos: "#ef4444",
  restocked: "#10b981",
};
const SERIES = [
  { key: "oos_count", name: "Out of stock", color: COLORS.oos },
  { key: "new_oos", name: "Went out of stock", color: COLORS.newOos },
  { key: "restocked", name: "Back in stock", color: COLORS.restocked },
];
const nfInt = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

function Stat({ label, value, hint }) {
  return (
    <Box sx={{ minWidth: 120, flex: "1 1 120px" }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: "block", fontWeight: 600 }}>
        {label}
      </Typography>
      <Typography variant="h6" sx={{ fontWeight: 700, lineHeight: 1.2 }}>
        {value}
      </Typography>
      {hint ? (
        <Typography variant="caption" color="text.secondary">
          {hint}
        </Typography>
      ) : null}
    </Box>
  );
}

function TrendTooltip({ active, payload, granularity }) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  return (
    <Box
      sx={{
        bgcolor: "background.paper",
        border: "1px solid",
        borderColor: "divider",
        borderRadius: 2,
        boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
        p: 1.5,
        minWidth: 200,
      }}
    >
      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1, fontWeight: 600 }}>
        {formatBucketTitle(point.label, granularity)}
      </Typography>
      {point.future ? (
        <Typography variant="body2" color="text.secondary">
          Not reached yet
        </Typography>
      ) : (
        <>
          {SERIES.map((series) => (
            <Box key={series.key} sx={{ display: "flex", alignItems: "center", gap: 1, mb: 0.5 }}>
              <Box sx={{ width: 8, height: 8, borderRadius: 2, bgcolor: series.color }} />
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {series.name}
              </Typography>
              <Typography variant="body2" sx={{ fontWeight: 700, ml: "auto" }}>
                {nfInt.format(point[series.key] || 0)}
              </Typography>
            </Box>
          ))}
          {point.restocked > 0 ? (
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>
              {nfInt.format(point.restock_qty || 0)} units restocked
            </Typography>
          ) : null}
        </>
      )}
    </Box>
  );
}

function EpisodeList({ episodes, timezone }) {
  if (!episodes.length) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
        No stock-outs for this product in the selected range.
      </Typography>
    );
  }
  return (
    <TableContainer sx={{ maxHeight: 320 }}>
      <Table size="small" stickyHeader>
        <TableHead>
          <TableRow>
            <TableCell>Variant</TableCell>
            <TableCell>Went out of stock</TableCell>
            <TableCell>Back in stock</TableCell>
            <TableCell align="right">Out for</TableCell>
            <TableCell align="right">Came back with</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {episodes.map((episode) => (
            <TableRow key={episode.id}>
              <TableCell>{episode.sku || episode.variant_id}</TableCell>
              <TableCell>{formatInstant(episode.out_of_stock_at, timezone)}</TableCell>
              <TableCell>
                {episode.is_open ? (
                  <Chip size="small" color="warning" variant="outlined" label="Still out of stock" />
                ) : (
                  formatInstant(episode.back_in_stock_at, timezone)
                )}
              </TableCell>
              <TableCell align="right">{formatDuration(episode.duration_minutes)}</TableCell>
              <TableCell align="right">
                {episode.recovery_quantity === null || episode.recovery_quantity === undefined
                  ? "-"
                  : `${nfInt.format(episode.recovery_quantity)} units`}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function InventoryOosTrend({ brandKey, selectedProduct = null, onClearProduct }) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("sm"));
  const today = dayjs().format("YYYY-MM-DD");
  const [range, setRange] = useState(() => defaultRange(today));
  const [preferredGranularity, setPreferredGranularity] = useState(() => {
    const initial = defaultRange(today);
    return suggestGranularity(initial.start, initial.end);
  });
  const [hidden, setHidden] = useState([]);
  const [state, setState] = useState({ status: "idle", data: null });

  const granularity = resolveGranularity(preferredGranularity, range.start, range.end);
  const productId = selectedProduct?.productId || null;

  useEffect(() => {
    if (!brandKey) return undefined;
    const controller = new AbortController();
    setState((prev) => ({ status: "loading", data: prev.data }));
    getInventoryOosTrend(
      { brand_key: brandKey, start: range.start, end: range.end, granularity, product_id: productId },
      { signal: controller.signal },
    ).then((resp) => {
      if (resp.aborted) return;
      if (resp.error) setState({ status: "failed", data: null });
      else setState({ status: "succeeded", data: resp });
    });
    return () => controller.abort();
  }, [brandKey, range.start, range.end, granularity, productId]);

  const handleRange = useCallback((startDay, endDay) => {
    const next = clampRange(startDay.format("YYYY-MM-DD"), endDay.format("YYYY-MM-DD"), MAX_RANGE_DAYS);
    setRange(next);
    setPreferredGranularity(suggestGranularity(next.start, next.end));
  }, []);

  const toggleSeries = useCallback((key) => {
    setHidden((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }, []);

  const data = state.data;
  const chartData = useMemo(() => (data?.buckets || []).map((b) => ({ ...b })), [data]);
  const timezone = data?.timezone;

  // A brand whose database has no out-of-stock history has nothing to show: no empty card.
  if (data && data.available === false) return null;

  const summary = data?.summary;
  const hasAnyEvent = chartData.some((b) => b.new_oos > 0 || b.restocked > 0 || b.oos_count > 0);

  return (
    <Card variant="outlined" sx={{ mt: 2 }}>
      <CardContent sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <Stack direction={{ xs: "column", md: "row" }} spacing={1.5} justifyContent="space-between" alignItems={{ md: "center" }}>
          <Box>
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              Out-of-stock trend
            </Typography>
            <Typography variant="caption" color="text.secondary">
              When variants went out of stock and when they came back{timezone ? ` (${timezone})` : ""}.
            </Typography>
          </Box>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            {selectedProduct ? (
              <Chip
                color="primary"
                variant="outlined"
                label={`Product: ${selectedProduct.title || selectedProduct.productId}`}
                onDelete={onClearProduct}
                sx={{ maxWidth: 260 }}
              />
            ) : null}
            <FunnelDateRangePicker startDate={range.start} endDate={range.end} onApply={handleRange} />
            <FormControl size="small">
              <Select
                value={granularity}
                onChange={(event) => setPreferredGranularity(event.target.value)}
                inputProps={{ "aria-label": "Trend granularity" }}
                sx={{
                  borderRadius: 2,
                  height: 36,
                  fontSize: 13,
                  fontWeight: 500,
                  bgcolor: alpha(theme.palette.action.active, 0.04),
                  "& .MuiOutlinedInput-notchedOutline": { border: "none" },
                }}
              >
                <MenuItem value="hourly" disabled={!hourlyAllowed(range.start, range.end)}>
                  Hourly
                </MenuItem>
                <MenuItem value="daily">Daily</MenuItem>
              </Select>
            </FormControl>
          </Stack>
        </Stack>

        {state.status === "failed" ? (
          <Typography variant="body2" color="error">
            Failed to load the out-of-stock trend.
          </Typography>
        ) : (
          <>
            <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
              <Stat
                label="Out of stock now"
                value={summary ? nfInt.format(summary.currently_out_of_stock) : "-"}
                hint={productId ? "variants of this product" : "variants"}
              />
              <Stat label="Went out of stock" value={summary ? nfInt.format(summary.stock_outs_in_range) : "-"} hint="in range" />
              <Stat
                label="Back in stock"
                value={summary ? nfInt.format(summary.restocks_in_range) : "-"}
                hint={summary && summary.units_restocked ? `${nfInt.format(summary.units_restocked)} units` : "in range"}
              />
              <Stat
                label="Average time out"
                value={summary ? formatDuration(summary.avg_duration_minutes) : "-"}
                hint="for restocked variants"
              />
            </Stack>

            {state.status === "loading" && !data ? (
              <Skeleton variant="rounded" width="100%" height={260} />
            ) : !hasAnyEvent ? (
              <Box sx={{ height: 120, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Typography variant="body2" color="text.secondary">
                  No stock-outs in this range.
                </Typography>
              </Box>
            ) : (
              <Box sx={{ width: "100%", height: 280, opacity: state.status === "loading" ? 0.5 : 1, transition: "opacity 0.2s" }}>
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={chartData} margin={{ top: 10, right: 12, left: 0, bottom: 5 }}>
                    <CartesianGrid vertical={false} strokeDasharray="3 3" stroke={alpha(theme.palette.divider, 0.5)} />
                    <XAxis
                      dataKey="label"
                      tickLine={false}
                      axisLine={false}
                      tickMargin={10}
                      minTickGap={isMobile ? 18 : 12}
                      interval="preserveStartEnd"
                      tickFormatter={(label) => formatTick(label, granularity)}
                      tick={{ fontSize: 11, fill: theme.palette.text.secondary }}
                    />
                    <YAxis
                      yAxisId="state"
                      allowDecimals={false}
                      tickLine={false}
                      axisLine={false}
                      width={44}
                      tick={{ fontSize: 11, fill: theme.palette.text.secondary }}
                    />
                    <YAxis yAxisId="events" orientation="right" allowDecimals={false} hide />
                    <Tooltip
                      cursor={{ fill: alpha(theme.palette.divider, 0.2) }}
                      content={<TrendTooltip granularity={granularity} />}
                    />
                    <Legend
                      onClick={(entry) => toggleSeries(entry.dataKey)}
                      wrapperStyle={{ cursor: "pointer", fontSize: 12 }}
                      formatter={(value, entry) => (
                        <span style={{ opacity: hidden.includes(entry.dataKey) ? 0.4 : 1 }}>{value}</span>
                      )}
                    />
                    <Bar
                      yAxisId="events"
                      dataKey="new_oos"
                      name="Went out of stock"
                      fill={COLORS.newOos}
                      hide={hidden.includes("new_oos")}
                      maxBarSize={18}
                      radius={[3, 3, 0, 0]}
                    />
                    <Bar
                      yAxisId="events"
                      dataKey="restocked"
                      name="Back in stock"
                      fill={COLORS.restocked}
                      hide={hidden.includes("restocked")}
                      maxBarSize={18}
                      radius={[3, 3, 0, 0]}
                    />
                    <Line
                      yAxisId="state"
                      dataKey="oos_count"
                      name="Out of stock"
                      type="stepAfter"
                      stroke={COLORS.oos}
                      strokeWidth={2.5}
                      dot={false}
                      connectNulls={false}
                      hide={hidden.includes("oos_count")}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </Box>
            )}

            {productId ? <EpisodeList episodes={data?.episodes || []} timezone={timezone} /> : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default memo(InventoryOosTrend);

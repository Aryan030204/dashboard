import { memo, useCallback, useEffect, useMemo, useState } from "react";
import dayjs from "dayjs";
import {
  Autocomplete,
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
  TextField,
  Tooltip,
  Typography,
  useMediaQuery,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { getInventoryOosOptions, getInventoryOosTrend } from "../lib/api.js";
import { FunnelDateRangePicker } from "./DailyFunnelPanel.jsx";
import {
  MAX_RANGE_DAYS,
  buildFilterOptions,
  clampRange,
  defaultRange,
  filterOptions,
  formatBucketTitle,
  formatDuration,
  formatInstant,
  formatTick,
  hourlyAllowed,
  optionForSelection,
  optionText,
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

// One cell of the summary strip: small label, the figure, and a one-line note.
function Stat({ label, value, hint }) {
  return (
    <Box sx={{ flex: "1 1 130px", minWidth: 0, px: 2, py: 1.25 }}>
      <Typography variant="caption" color="text.secondary" noWrap sx={{ display: "block", fontWeight: 600 }}>
        {label}
      </Typography>
      <Typography sx={{ fontWeight: 700, fontSize: 20, lineHeight: 1.3 }}>{value}</Typography>
      {hint ? (
        <Typography variant="caption" color="text.secondary" noWrap sx={{ display: "block", fontSize: 11 }}>
          {hint}
        </Typography>
      ) : null}
    </Box>
  );
}

// A small caption above a chart panel: coloured dot(s) and what the panel shows.
function PanelTitle({ items }) {
  return (
    <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 0.5, pl: 0.5 }}>
      {items.map((item) => (
        <Stack key={item.label} direction="row" spacing={0.75} alignItems="center">
          <Box sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: item.color }} />
          <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
            {item.label}
          </Typography>
        </Stack>
      ))}
    </Stack>
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
    <TableContainer
      sx={{
        maxHeight: 320,
        border: "1px solid",
        borderColor: "divider",
        borderRadius: 2,
        "& .MuiTableCell-root": { borderColor: "divider", py: 0.9 },
        "& .MuiTableCell-head": {
          bgcolor: "transparent",
          color: "text.secondary",
          fontSize: 11,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: 0.4,
        },
        "& .MuiTableBody-root .MuiTableRow-root:last-of-type .MuiTableCell-root": { borderBottom: 0 },
      }}
    >
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

// Product / variant filter. `selection` is { productId, title, variantId?, variantLabel? } or null (all products).
// Rows: a product (name, and how many variants or its SKU) followed by its variants, indented; counts and an
// "out now" marker on the right. The list opens directly under the input at the same width (MUI default placement),
// so it cannot drift away from it; long names are cut with an ellipsis and show in full on hover.
function ProductFilter({ options, loading, selection, onChange }) {
  const theme = useTheme();
  const value = useMemo(() => optionForSelection(selection, options), [selection, options]);
  const listed = useMemo(() => {
    if (!value || options.some((o) => o.key === value.key)) return options;
    return [value, ...options];
  }, [options, value]);
  return (
    <Autocomplete
      size="small"
      sx={{ width: "100%", maxWidth: 520 }}
      options={listed}
      value={value}
      loading={loading}
      loadingText="Loading products..."
      noOptionsText="No product went out of stock in this range"
      getOptionLabel={optionText}
      isOptionEqualToValue={(a, b) => a.key === b.key}
      filterOptions={(all, state) => filterOptions(all, state.inputValue)}
      onChange={(_event, option) =>
        onChange(
          option
            ? {
                productId: option.productId,
                title: option.title,
                variantId: option.variantId,
                variantLabel: option.variantId ? option.label : null,
              }
            : null,
        )
      }
      slotProps={{
        paper: {
          sx: {
            bgcolor: "background.paper",
            backgroundImage: "none",
            border: "1px solid",
            borderColor: "divider",
            borderRadius: 2,
            boxShadow: "0 12px 32px rgba(0, 0, 0, 0.45)",
            mt: 0.5,
          },
        },
        listbox: { sx: { py: 0.5, maxHeight: 300 } },
      }}
      renderInput={(params) => <TextField {...params} placeholder="All products and variants" />}
      renderOption={(props, option) => {
        const { key: _ignored, ...rest } = props;
        const isVariant = option.kind === "variant";
        return (
          <Box
            component="li"
            key={option.key}
            {...rest}
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 1.5,
              py: isVariant ? 0.5 : 0.75,
              pl: isVariant ? 4 : 2,
              pr: 2,
              borderTop: !isVariant ? `1px solid ${alpha(theme.palette.divider, 0.5)}` : "none",
              "&:first-of-type": { borderTop: "none" },
            }}
          >
            <Tooltip
              arrow
              enterDelay={250}
              placement="top-start"
              title={
                <Box>
                  <Typography variant="caption" sx={{ display: "block", fontWeight: 700 }}>
                    {option.title}
                  </Typography>
                  {isVariant ? (
                    <Typography variant="caption" sx={{ display: "block" }}>
                      {option.label}
                    </Typography>
                  ) : option.subtitle ? (
                    <Typography variant="caption" sx={{ display: "block" }}>
                      {option.subtitle}
                    </Typography>
                  ) : null}
                </Box>
              }
            >
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, minWidth: 0 }}>
                  <Typography
                    variant="body2"
                    noWrap
                    sx={{ minWidth: 0, fontWeight: isVariant ? 400 : 600, fontSize: isVariant ? 13 : 14 }}
                  >
                    {option.label}
                  </Typography>
                  {/* The OOS tag sits right after the name; the name is what gets cut when space is short. */}
                  {option.outNow ? (
                    <Box
                      component="span"
                      sx={{
                        flexShrink: 0,
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        height: 18,
                        px: 0.75,
                        borderRadius: "9px",
                        border: "1px solid",
                        borderColor: "warning.main",
                        color: "warning.main",
                        fontSize: 10.5,
                        fontWeight: 700,
                        letterSpacing: 0.3,
                        lineHeight: 1,
                      }}
                    >
                      OOS
                    </Box>
                  ) : null}
                </Box>
                {option.subtitle ? (
                  <Typography variant="caption" color="text.secondary" noWrap sx={{ display: "block" }}>
                    {option.subtitle}
                  </Typography>
                ) : null}
              </Box>
            </Tooltip>
            {/* The count has a fixed column on the right so the numbers line up in every row. */}
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ width: 30, flexShrink: 0, textAlign: "right", lineHeight: 1, alignSelf: "center" }}
            >
              {option.count > 0 ? `${nfInt.format(option.count)}x` : ""}
            </Typography>
          </Box>
        );
      }}
    />
  );
}

function InventoryOosTrend({ brandKey, selectedProduct = null, onSelectProduct, onClearProduct }) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("sm"));
  const today = dayjs().format("YYYY-MM-DD");
  const [range, setRange] = useState(() => defaultRange(today));
  const [preferredGranularity, setPreferredGranularity] = useState(() => {
    const initial = defaultRange(today);
    return suggestGranularity(initial.start, initial.end);
  });
  const [state, setState] = useState({ status: "idle", data: null });
  const [filterList, setFilterList] = useState({ loading: false, options: [] });

  const granularity = resolveGranularity(preferredGranularity, range.start, range.end);
  const productId = selectedProduct?.productId || null;
  const variantId = selectedProduct?.variantId || null;

  useEffect(() => {
    if (!brandKey) return undefined;
    const controller = new AbortController();
    setState((prev) => ({ status: "loading", data: prev.data }));
    getInventoryOosTrend(
      { brand_key: brandKey, start: range.start, end: range.end, granularity, product_id: productId, variant_id: variantId },
      { signal: controller.signal },
    ).then((resp) => {
      if (resp.aborted) return;
      if (resp.error) setState({ status: "failed", data: null });
      else setState({ status: "succeeded", data: resp });
    });
    return () => controller.abort();
  }, [brandKey, range.start, range.end, granularity, productId, variantId]);

  // The products and variants that went out of stock in the range, for the filter.
  useEffect(() => {
    if (!brandKey) return undefined;
    const controller = new AbortController();
    setFilterList((prev) => ({ ...prev, loading: true }));
    getInventoryOosOptions({ brand_key: brandKey, start: range.start, end: range.end }, { signal: controller.signal }).then((resp) => {
      if (resp.aborted) return;
      setFilterList({ loading: false, options: resp.error ? [] : buildFilterOptions(resp.products) });
    });
    return () => controller.abort();
  }, [brandKey, range.start, range.end]);

  const handleRange = useCallback((startDay, endDay) => {
    const next = clampRange(startDay.format("YYYY-MM-DD"), endDay.format("YYYY-MM-DD"), MAX_RANGE_DAYS);
    setRange(next);
    setPreferredGranularity(suggestGranularity(next.start, next.end));
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
        {/* Title on the left; date range and granularity stay together on the right and move below the title when there is no room. */}
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1.5, alignItems: "center", justifyContent: "space-between" }}>
          <Box sx={{ flex: "1 1 240px", minWidth: 0 }}>
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              Out-of-stock trend
            </Typography>
            <Typography variant="caption" color="text.secondary">
              When variants went out of stock and when they came back{timezone ? ` (${timezone})` : ""}.
            </Typography>
          </Box>
          <Box
            sx={{
              display: "flex",
              flexWrap: { xs: "wrap", sm: "nowrap" },
              gap: 1,
              alignItems: "center",
              justifyContent: "flex-end",
              flex: { xs: "1 1 100%", sm: "0 1 auto" },
              minWidth: 0,
              maxWidth: "100%",
              "& > *": { flexShrink: 0 },
            }}
          >
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
          </Box>
        </Box>

        {/* The filter has a row of its own: names and SKUs need the width, and the header keeps just date and granularity. */}
        <ProductFilter
          options={filterList.options}
          loading={filterList.loading}
          selection={selectedProduct}
          onChange={(selection) => (selection ? onSelectProduct?.(selection) : onClearProduct?.())}
        />

        {state.status === "failed" ? (
          <Typography variant="body2" color="error">
            Failed to load the out-of-stock trend.
          </Typography>
        ) : (
          <>
            <Box
              sx={{
                display: "flex",
                flexWrap: "wrap",
                border: "1px solid",
                borderColor: "divider",
                borderRadius: 2,
                "& > *:not(:first-of-type)": { borderLeft: { sm: "1px solid" }, borderColor: "divider" },
              }}
            >
              <Stat
                label="Out of stock now"
                value={summary ? nfInt.format(summary.currently_out_of_stock) : "-"}
                hint={variantId ? "this variant" : productId ? "variants of this product" : "variants"}
              />
              <Stat
                label="Went out of stock"
                value={summary ? nfInt.format(summary.stock_outs_in_range) : "-"}
                hint={variantId ? "times, this variant" : productId ? "times, this product" : "in range"}
              />
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
            </Box>

            {state.status === "loading" && !data ? (
              <Skeleton variant="rounded" width="100%" height={260} />
            ) : !hasAnyEvent ? (
              <Box sx={{ height: 120, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Typography variant="body2" color="text.secondary">
                  No stock-outs in this range.
                </Typography>
              </Box>
            ) : (
              <Box sx={{ opacity: state.status === "loading" ? 0.5 : 1, transition: "opacity 0.2s" }}>
                {/* Two panels on the same time axis: how many are out of stock, then what happened in each bucket. */}
                <PanelTitle items={[{ label: "Variants out of stock", color: COLORS.oos }]} />
                <Box sx={{ width: "100%", height: 110 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chartData} syncId="inventory-oos" margin={{ top: 6, right: 12, left: 0, bottom: 0 }}>
                      <CartesianGrid vertical={false} strokeDasharray="3 3" stroke={alpha(theme.palette.divider, 0.5)} />
                      <XAxis dataKey="label" hide />
                      <YAxis
                        allowDecimals={false}
                        domain={[0, (max) => Math.max(1, max)]}
                        tickLine={false}
                        axisLine={false}
                        width={36}
                        tick={{ fontSize: 11, fill: theme.palette.text.secondary }}
                      />
                      <ChartTooltip
                        cursor={{ stroke: theme.palette.divider, strokeDasharray: "4 4" }}
                        content={<TrendTooltip granularity={granularity} />}
                      />
                      <Area
                        type="stepAfter"
                        dataKey="oos_count"
                        stroke={COLORS.oos}
                        strokeWidth={2}
                        fill={COLORS.oos}
                        fillOpacity={0.14}
                        dot={false}
                        connectNulls={false}
                        isAnimationActive={false}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </Box>

                <Box sx={{ mt: 1.5 }}>
                  <PanelTitle
                    items={[
                      { label: "Went out of stock", color: COLORS.newOos },
                      { label: "Back in stock", color: COLORS.restocked },
                    ]}
                  />
                </Box>
                <Box sx={{ width: "100%", height: 150 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData} syncId="inventory-oos" margin={{ top: 6, right: 12, left: 0, bottom: 0 }} barGap={2}>
                      <CartesianGrid vertical={false} strokeDasharray="3 3" stroke={alpha(theme.palette.divider, 0.5)} />
                      <XAxis
                        dataKey="label"
                        tickLine={false}
                        axisLine={false}
                        tickMargin={8}
                        minTickGap={isMobile ? 18 : 12}
                        interval="preserveStartEnd"
                        tickFormatter={(label) => formatTick(label, granularity)}
                        tick={{ fontSize: 11, fill: theme.palette.text.secondary }}
                      />
                      <YAxis
                        allowDecimals={false}
                        domain={[0, (max) => Math.max(1, max)]}
                        tickLine={false}
                        axisLine={false}
                        width={36}
                        tick={{ fontSize: 11, fill: theme.palette.text.secondary }}
                      />
                      <ChartTooltip
                        cursor={{ fill: alpha(theme.palette.divider, 0.2) }}
                        content={<TrendTooltip granularity={granularity} />}
                      />
                      <Bar dataKey="new_oos" fill={COLORS.newOos} maxBarSize={16} radius={[3, 3, 0, 0]} isAnimationActive={false} />
                      <Bar dataKey="restocked" fill={COLORS.restocked} maxBarSize={16} radius={[3, 3, 0, 0]} isAnimationActive={false} />
                    </BarChart>
                  </ResponsiveContainer>
                </Box>
              </Box>
            )}

            {productId || variantId ? <EpisodeList episodes={data?.episodes || []} timezone={timezone} /> : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default memo(InventoryOosTrend);

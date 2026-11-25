import { Segmented } from "./datum/index.js";
import { memo, useEffect, useMemo, useState } from "react";
import {
  Card,
  CardContent,
  Typography,
  Skeleton,
  Box,
  FormControl,
  Select,
  MenuItem,
  Stack,
  useMediaQuery,
  Checkbox,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import {
  BarChart,
  Bar,
  LabelList,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useInrCurrency } from "../lib/currency.js";
import { useDashboardPaymentSplitTrendData } from "../features/dashboard/widgetDataHooks.js";

// Series colors are CSS variables (they change with light/dark), which MUI's alpha() cannot parse.
// color-mix gives the same transparency and works with variables and hex alike.
const tint = (color, opacity) => `color-mix(in srgb, ${color} ${Math.round(opacity * 100)}%, transparent)`;

const MAIN_COLOR = "var(--dz-series)";
const COLORS = {
  prepaid: "var(--dz-pay1)",
  cod: "var(--dz-pay2)",
  partial: "var(--dz-pay3)",
};
const TOOLTIP_VALUE_COLORS = [
  "#ff6b6b",
  "#ffd166",
  "#4cc9f0",
  "#f72585",
  "#72efdd",
  "#c77dff",
];
const nfInt0 = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 0,
});
const nfCompactInt = new Intl.NumberFormat("en-IN", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const nfPercent1 = new Intl.NumberFormat(undefined, {
  style: "percent",
  maximumFractionDigits: 1,
});

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const WEEKLY_LABEL_THRESHOLD = 60;
const WEEK_SIZE_DAYS = 7;

function buildMetricConfig(formatConvertedAmount) {
  return {
    orders: {
      label: "Order count",
      formatter: (value) => nfInt0.format(value || 0),
      compactFormatter: (value) => nfCompactInt.format(value || 0),
    },
    sales: {
      label: "Sales",
      formatter: (value) =>
        formatConvertedAmount(value || 0, { maximumFractionDigits: 0 }),
      compactFormatter: (value) =>
        formatConvertedAmount(value || 0, {
          notation: "compact",
          maximumFractionDigits: 1,
        }),
    },
  };
}

const SERIES = [
  { key: "Prepaid", currentKey: "currentPrepaid", comparisonKey: "comparisonPrepaid", currentPctKey: "currentPrepaidPct", comparisonPctKey: "comparisonPrepaidPct", color: COLORS.prepaid },
  { key: "COD", currentKey: "currentCod", comparisonKey: "comparisonCod", currentPctKey: "currentCodPct", comparisonPctKey: "comparisonCodPct", color: COLORS.cod },
  { key: "Partially paid", currentKey: "currentPartial", comparisonKey: "comparisonPartial", currentPctKey: "currentPartialPct", comparisonPctKey: "comparisonPartialPct", color: COLORS.partial },
];

function formatPercent(value) {
  return nfPercent1.format((Number(value || 0)) / 100);
}

function buildDateRange(start, end) {
  if (!start || !end) return [];
  const dates = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(endDate.getTime())) {
    return dates;
  }
  while (cursor <= endDate) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function getInclusiveDayCount(start, end) {
  if (!start || !end) return 0;
  const startDate = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return 0;
  }
  return (
    Math.floor(
      (endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000),
    ) + 1
  );
}

function getPercentAxisMax(chartData, selectedSeries, visibleBars) {
  const percentKeys = [];

  if (visibleBars.includes("comparison")) {
    percentKeys.push(...selectedSeries.map((series) => series.comparisonPctKey));
  }
  if (visibleBars.includes("primary")) {
    percentKeys.push(...selectedSeries.map((series) => series.currentPctKey));
  }

  if (percentKeys.length === 0 || !Array.isArray(chartData) || chartData.length === 0) {
    return 100;
  }

  let maxPercent = 0;
  for (const point of chartData) {
    for (const key of percentKeys) {
      const value = Number(point?.[key] || 0);
      if (Number.isFinite(value) && value > maxPercent) {
        maxPercent = value;
      }
    }
  }

  return Math.max(1, Math.ceil(maxPercent));
}

function resolveComparisonRange(start, end, compareStart, compareEnd) {
  if (compareStart && compareEnd) {
    return { start: compareStart, end: compareEnd };
  }
  if (!start || !end) return null;

  const startDate = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return null;
  }

  const dayCount =
    Math.floor((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000)) +
    1;
  const prevEnd = new Date(startDate.getTime());
  prevEnd.setUTCDate(prevEnd.getUTCDate() - 1);
  const prevStart = new Date(prevEnd.getTime());
  prevStart.setUTCDate(prevStart.getUTCDate() - (dayCount - 1));

  return {
    start: prevStart.toISOString().slice(0, 10),
    end: prevEnd.toISOString().slice(0, 10),
  };
}

function formatRangeLabel(range) {
  if (!range?.start || !range?.end) return "";

  const startDate = new Date(`${range.start}T00:00:00Z`);
  const endDate = new Date(`${range.end}T00:00:00Z`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return "";
  }

  const sMonth = MONTH_NAMES[startDate.getUTCMonth()] || "";
  const eMonth = MONTH_NAMES[endDate.getUTCMonth()] || "";
  const sDay = startDate.getUTCDate();
  const eDay = endDate.getUTCDate();
  const sYear = startDate.getUTCFullYear();
  const eYear = endDate.getUTCFullYear();

  if (range.start === range.end) {
    return `${sMonth} ${sDay}, ${sYear}`;
  }

  if (sYear === eYear) {
    if (startDate.getUTCMonth() === endDate.getUTCMonth()) {
      return `${sMonth} ${sDay}-${eDay}, ${sYear}`;
    }
    return `${sMonth} ${sDay} - ${eMonth} ${eDay}, ${sYear}`;
  }

  return `${sMonth} ${sDay}, ${sYear} - ${eMonth} ${eDay}, ${eYear}`;
}

function formatDayLabel(date) {
  const dt = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(dt.getTime())) return date;
  return `${MONTH_NAMES[dt.getUTCMonth()]} ${dt.getUTCDate()}`;
}

function formatHourLabel(hour) {
  const normalized = hour % 12 === 0 ? 12 : hour % 12;
  return `${normalized}${hour >= 12 ? "pm" : "am"}`;
}

function getTimezoneParts(date, timezone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date).reduce((acc, part) => {
    if (part.type !== "literal") acc[part.type] = part.value;
    return acc;
  }, {});
  const hour = Number(parts.hour || 0);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: hour === 24 ? 0 : hour,
  };
}

function getHourlyCutoffForTodayRange(start, end, timezone) {
  if (!start || !end) return null;

  const nowLocal = getTimezoneParts(new Date(), timezone);
  const includesToday = start <= nowLocal.date && end >= nowLocal.date;

  if (!includesToday) return null;

  return Math.max(0, nowLocal.hour - 1);
}

function buildWeeklyPaymentBuckets(points = []) {
  const bucketCount = Math.ceil(points.length / WEEK_SIZE_DAYS);

  return Array.from({ length: bucketCount }, (_, index) => {
    const startIdx = index * WEEK_SIZE_DAYS;
    const endIdx = startIdx + WEEK_SIZE_DAYS;
    const currentBucket = points.slice(startIdx, endIdx);
    const previousBucket = points.slice(startIdx, endIdx);

    const sumBucket = (bucket, key) =>
      bucket.reduce((sum, point) => sum + Number(point?.[key] || 0), 0);

    const currentPrepaid = sumBucket(currentBucket, "currentPrepaid");
    const currentCod = sumBucket(currentBucket, "currentCod");
    const currentPartial = sumBucket(currentBucket, "currentPartial");
    const currentTotal = sumBucket(currentBucket, "currentTotal");
    const comparisonPrepaid = sumBucket(previousBucket, "comparisonPrepaid");
    const comparisonCod = sumBucket(previousBucket, "comparisonCod");
    const comparisonPartial = sumBucket(previousBucket, "comparisonPartial");
    const comparisonTotal = sumBucket(previousBucket, "comparisonTotal");

    return {
      label: `Week ${index + 1}`,
      currentPrepaid,
      currentCod,
      currentPartial,
      currentTotal,
      currentPrepaidPct: currentTotal > 0 ? (currentPrepaid / currentTotal) * 100 : 0,
      currentCodPct: currentTotal > 0 ? (currentCod / currentTotal) * 100 : 0,
      currentPartialPct: currentTotal > 0 ? (currentPartial / currentTotal) * 100 : 0,
      comparisonPrepaid,
      comparisonCod,
      comparisonPartial,
      comparisonTotal,
      comparisonPrepaidPct:
        comparisonTotal > 0 ? (comparisonPrepaid / comparisonTotal) * 100 : 0,
      comparisonCodPct:
        comparisonTotal > 0 ? (comparisonCod / comparisonTotal) * 100 : 0,
      comparisonPartialPct:
        comparisonTotal > 0 ? (comparisonPartial / comparisonTotal) * 100 : 0,
    };
  });
}

function buildTooltipRows(payload = [], chartMode, formatter) {
  return payload
    .filter((entry) => Number(entry.value || 0) > 0)
    .map((entry, index) => {
      const dataKey = String(entry.dataKey || "");
      const bucket = dataKey.startsWith("comparison") ? "Previous" : "Current";
      const isPrepaid = dataKey.toLowerCase().includes("prepaid");
      const isCod = dataKey.toLowerCase().includes("cod") && !dataKey.toLowerCase().includes("partial");
      const name = isPrepaid ? "Prepaid" : isCod ? "COD" : "Partially paid";
      const rawKey = dataKey.includes("Pct")
        ? dataKey.replace("Pct", "")
        : dataKey;
      const rawValue = Number(entry.payload?.[rawKey] || 0);
      // Share of this point's total (orders/sales) contributed by this category.
      const totalKey = bucket === "Previous" ? "comparisonTotal" : "currentTotal";
      const bucketTotal = Number(entry.payload?.[totalKey] || 0);
      const sharePct = bucketTotal > 0 ? (rawValue / bucketTotal) * 100 : null;
      return {
        color: entry.color || entry.fill || entry.stroke,
        name,
        bucket,
        valueColor: TOOLTIP_VALUE_COLORS[index % TOOLTIP_VALUE_COLORS.length],
        displayValue: formatter(rawValue),
        shareLabel: sharePct == null ? "" : `(${nfPercent1.format(sharePct / 100)})`,
      };
    });
}

const TrendTooltip = ({ active, payload, label, formatter, chartMode }) => {
  if (!active || !payload?.length) return null;

  const rows = buildTooltipRows(payload, chartMode, formatter);

  const currentRows = rows.filter((row) => row.bucket === "Current");
  const previousRows = rows.filter((row) => row.bucket === "Previous");

  const renderRows = (title, items) => {
    if (!items.length) return null;
    return (
      <Box sx={{ mt: 1 }}>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: "block", mb: 0.5, fontWeight: 600 }}
        >
          {title}
        </Typography>
        {items.map((row, index) => (
          <Box
            key={`${title}-${index}`}
            sx={{ display: "flex", alignItems: "center", gap: 1, mb: 0.5 }}
          >
            <Box
              sx={{
                width: 8,
                height: 8,
                borderRadius: 2,
                bgcolor: row.color,
              }}
            />
            <Typography variant="body2" color="text.primary" sx={{ fontWeight: 600 }}>
              {row.name}
            </Typography>
            <Typography
              variant="body2"
              sx={{ fontWeight: 700, ml: "auto", color: row.valueColor }}
            >
              {row.displayValue}
            </Typography>
            {row.shareLabel ? (
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ fontWeight: 600 }}
              >
                {row.shareLabel}
              </Typography>
            ) : null}
          </Box>
        ))}
      </Box>
    );
  };

  return (
    <Box
      sx={{
        bgcolor: "background.paper",
        border: "1px solid",
        borderColor: "divider",
        borderRadius: 2,
        boxShadow:
          "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
        p: 1.5,
        minWidth: 180,
      }}
    >
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: "block", mb: 1, fontWeight: 500 }}
      >
        {label}
      </Typography>
      {renderRows("Current", currentRows)}
      {renderRows("Previous", previousRows)}
    </Box>
  );
};

export default memo(function PaymentSplitTrend({ query }) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("sm"));
  const [metric, setMetric] = useState("orders");
  const [viewMode, setViewMode] = useState("daily");
  const [chartMode, setChartMode] = useState("line");
  const [selectedSeriesKeys, setSelectedSeriesKeys] = useState(["Prepaid"]);
  const [visibleBars, setVisibleBars] = useState(["primary", "comparison"]);

  const start = query?.start;
  const end = query?.end;
  const brandKey = query?.brand_key;
  const refreshKey = query?.refreshKey;
  const utmSource = query?.utm_source;
  const utmMedium = query?.utm_medium;
  const utmCampaign = query?.utm_campaign;
  const salesChannel = query?.sales_channel;
  const deviceType = query?.device_type;
  const productId = query?.product_id;
  const discountCode = query?.discount_code;
  const { convertAmount, formatConvertedAmount } = useInrCurrency(brandKey, end);
  const metricConfig = useMemo(
    () => buildMetricConfig(formatConvertedAmount),
    [formatConvertedAmount],
  );

  const config = metricConfig[metric] || metricConfig.orders;
  const selectedSeries = SERIES.filter((series) =>
    selectedSeriesKeys.includes(series.key),
  );
  const selectedDayCount = getInclusiveDayCount(start, end);
  const canUseHourly = selectedDayCount === 1;
  const useWeeklyBuckets = selectedDayCount > WEEKLY_LABEL_THRESHOLD;
  const showBarPercentLabels = isMobile
    ? selectedDayCount <= 8
    : selectedDayCount <= 15;
  const { loading, chartData, rangeLabels } = useDashboardPaymentSplitTrendData({
    query,
    metric,
    viewMode,
    canUseHourly,
    useWeeklyBuckets,
    convertAmount,
  });
  const shouldTiltDateLabels = chartData.length > 30;
  const percentAxisMax = getPercentAxisMax(
    chartData,
    selectedSeries,
    visibleBars,
  );

  useEffect(() => {
    if (!canUseHourly && viewMode === "hourly") {
      setViewMode("daily");
    }
  }, [canUseHourly, viewMode]);

  const toggleBar = (bar) => {
    setVisibleBars((prev) =>
      prev.includes(bar) ? prev.filter((item) => item !== bar) : [...prev, bar],
    );
  };

  const toggleSeries = (seriesKey) => {
    setSelectedSeriesKeys((prev) => {
      if (prev.includes(seriesKey)) {
        const next = prev.filter((key) => key !== seriesKey);
        return next.length > 0 ? next : prev;
      }
      return [...prev, seriesKey];
    });
  };

  const renderBarPercentLabel = (dataKey) => (
    <LabelList
      dataKey={dataKey}
      position="top"
      offset={10}
      fill={theme.palette.text.primary}
      fontSize={10}
      fontWeight={700}
      formatter={(value) => {
        const percent = Number(value || 0);
        return Number.isFinite(percent) && percent > 0 ? `${Math.round(percent)}%` : "";
      }}
    />
  );
  const showWeeklyBarPercentLabels = showBarPercentLabels && !useWeeklyBuckets;

  return (
    <Card
      elevation={0}
      sx={{
        borderRadius: "12px",
        minHeight: isMobile ? 320 : 310,
        overflow: "visible",
        position: "relative",
        zIndex: 3,
      }}
    >
      <CardContent
        sx={{
          minHeight: 260,
          display: "flex",
          flexDirection: "column",
          px: 2,
          py: 3,
          overflow: "visible",
          position: "relative",
          zIndex: 3,
        }}
      >
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            mb: 3,
            gap: 2,
            flexWrap: "wrap",
          }}
        >
          <Stack spacing={1}>
            <Typography
              variant="subtitle2"
              color="text.primary"
              sx={{ fontWeight: 600, fontSize: "14.5px", letterSpacing: "-0.01em" }}
            >
              {viewMode === "hourly" ? "Hour-wise trend" : "Day-wise trend"} - Mode of Payment {config.label}
            </Typography>

            <Stack
              direction="row"
              spacing={isMobile ? 1.5 : 3}
              alignItems="center"
              sx={{ flexWrap: "wrap", gap: isMobile ? 1 : 0 }}
            >
              <Stack
                direction="row"
                spacing={1}
                alignItems="center"
                onClick={() => toggleBar("primary")}
                sx={{ cursor: "pointer", "&:hover": { opacity: 0.8 } }}
              >
                <Box
                  sx={{
                    width: 14,
                    height: 14,
                    borderRadius: "3px",
                    bgcolor: visibleBars.includes("primary")
                      ? MAIN_COLOR
                      : "transparent",
                    border: "1px solid",
                    borderColor: MAIN_COLOR,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {visibleBars.includes("primary") && (
                    <Box
                      sx={{
                        width: 6,
                        height: 6,
                        bgcolor: "white",
                        borderRadius: "1px",
                      }}
                    />
                  )}
                </Box>
                <Typography
                  variant="caption"
                  sx={{
                    fontWeight: 600,
                    color: visibleBars.includes("primary")
                      ? "text.primary"
                      : "text.secondary",
                  }}
                >
                  {rangeLabels.current}
                </Typography>
              </Stack>

              {rangeLabels.previous && (
                <Stack
                  direction="row"
                  spacing={1}
                  alignItems="center"
                  onClick={() => toggleBar("comparison")}
                  sx={{ cursor: "pointer", "&:hover": { opacity: 0.8 } }}
                >
                  <Box
                    sx={{
                      width: 14,
                      height: 14,
                      borderRadius: "3px",
                      border: "1px solid",
                      borderColor: MAIN_COLOR,
                      bgcolor: visibleBars.includes("comparison")
                        ? "color-mix(in srgb, var(--dz-series) 45%, transparent)"
                        : "transparent",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    {visibleBars.includes("comparison") && (
                      <Box
                        sx={{
                          width: 6,
                          height: 6,
                          bgcolor: "white",
                          borderRadius: "1px",
                        }}
                      />
                    )}
                  </Box>
                  <Typography
                    variant="caption"
                    sx={{
                      fontWeight: 600,
                      color: visibleBars.includes("comparison")
                        ? "text.secondary"
                        : alpha(theme.palette.text.secondary, 0.5),
                    }}
                  >
                    {rangeLabels.previous}
                  </Typography>
                </Stack>
              )}
            </Stack>

            <Stack direction="row" spacing={1.5} sx={{ flexWrap: "wrap" }}>
              {SERIES.map((series) => (
                <Stack
                  key={series.key}
                  direction="row"
                  spacing={0.5}
                  alignItems="center"
                  sx={{ cursor: "pointer" }}
                  onClick={() => toggleSeries(series.key)}
                >
                  <Checkbox
                    checked={selectedSeriesKeys.includes(series.key)}
                    onChange={() => toggleSeries(series.key)}
                    size="small"
                    onClick={(e) => e.stopPropagation()}
                    sx={{
                      color: tint(series.color, 0.7),
                      "&.Mui-checked": {
                        color: series.color,
                      },
                      py: 0.25,
                      px: 0.5,
                    }}
                  />
                  <Typography variant="caption" sx={{ fontWeight: 600 }}>
                    {series.key}
                  </Typography>
                </Stack>
              ))}
            </Stack>
          </Stack>

          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <Segmented
              ariaLabel="Payment split view mode"
              value={viewMode}
              onChange={setViewMode}
              options={[
                { value: "hourly", label: "Hourly", disabled: !canUseHourly },
                { value: "daily", label: "Daily" },
              ]}
            />
            <Segmented
              ariaLabel="Payment split chart mode"
              value={chartMode}
              onChange={setChartMode}
              options={[
                { value: "line", label: "Line" },
                { value: "bar", label: "Bar" },
              ]}
            />
            <Segmented
              ariaLabel="Payment split metric"
              value={metric}
              onChange={setMetric}
              options={[
                { value: "orders", label: "Order count" },
                { value: "sales", label: "Sales" },
              ]}
            />
          </Stack>
        </Box>

        {loading ? (
          <Skeleton variant="rounded" width="100%" height={200} />
        ) : chartData.length === 0 ? (
          <Box
            sx={{
              flexGrow: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Typography variant="body2" color="text.secondary">
              No data available.
            </Typography>
          </Box>
        ) : (
          <Box
            sx={{
              width: "100%",
              height: 200,
              overflow: "visible",
              position: "relative",
              zIndex: 4,
            }}
          >
            <ResponsiveContainer width="100%" height="100%">
              {chartMode === "line" ? (
                <LineChart
                  data={chartData}
                  margin={{ top: 25, right: 20, left: 15, bottom: shouldTiltDateLabels ? 28 : 5 }}
                >
                  <CartesianGrid
                    vertical={false}
                    strokeDasharray="3 3"
                    stroke={alpha(theme.palette.divider, 0.5)}
                  />
                  <XAxis
                    dataKey="label"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={12}
                    minTickGap={isMobile ? 15 : 0}
                    interval={isMobile ? "preserveStartEnd" : 0}
                    tick={
                      shouldTiltDateLabels
                        ? { fontSize: 10, fill: theme.palette.text.secondary, angle: -24, textAnchor: "end", dy: 8 }
                        : { fontSize: 10, fill: theme.palette.text.secondary }
                    }
                    height={shouldTiltDateLabels ? 42 : undefined}
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    tickFormatter={formatPercent}
                    tick={{ fontSize: 12, fill: theme.palette.text.secondary }}
                    width={60}
                    domain={[0, percentAxisMax]}
                  />
                  <Tooltip
                    allowEscapeViewBox={{ x: true, y: true }}
                    reverseDirection={{ x: true, y: false }}
                    cursor={{ stroke: theme.palette.divider, strokeWidth: 1, strokeDasharray: "4 4" }}
                    content={<TrendTooltip formatter={config.formatter} chartMode="line" />}
                    wrapperStyle={{ zIndex: 1000, pointerEvents: "none" }}
                  />
                  {selectedSeries.map((series) => (
                    <Line
                      key={`comparison-${series.key}`}
                      type="monotone"
                      hide={!visibleBars.includes("comparison")}
                      dataKey={series.comparisonPctKey}
                      name={series.key}
                      stroke={tint(series.color, 0.6)}
                      strokeDasharray="5 5"
                      strokeWidth={2}
                      dot={{ r: 3, fill: "white", stroke: tint(series.color, 0.7), strokeWidth: 1.5 }}
                      activeDot={{ r: 5, fill: tint(series.color, 0.7), stroke: "white", strokeWidth: 2 }}
                    />
                  ))}
                  {selectedSeries.map((series) => (
                    <Line
                      key={`current-${series.key}`}
                      type="monotone"
                      hide={!visibleBars.includes("primary")}
                      dataKey={series.currentPctKey}
                      name={series.key}
                      stroke={series.color}
                      strokeWidth={2.5}
                      dot={{ r: 3, fill: "white", stroke: series.color, strokeWidth: 1.5 }}
                      activeDot={{ r: 6, fill: series.color, stroke: "white", strokeWidth: 3 }}
                    />
                  ))}
                </LineChart>
              ) : (
                <BarChart
                  data={chartData}
                  margin={{ top: 40, right: 32, left: 32, bottom: shouldTiltDateLabels ? 28 : 5 }}
                  barGap={0}
                >
                  <CartesianGrid
                    vertical={false}
                    strokeDasharray="3 3"
                    stroke={alpha(theme.palette.divider, 0.5)}
                  />
                  <XAxis
                    dataKey="label"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={12}
                    minTickGap={isMobile ? 15 : 0}
                    interval={isMobile ? "preserveStartEnd" : 0}
                    tick={
                      shouldTiltDateLabels
                        ? { fontSize: 10, fill: theme.palette.text.secondary, angle: -24, textAnchor: "end", dy: 8 }
                        : { fontSize: 10, fill: theme.palette.text.secondary }
                    }
                    height={shouldTiltDateLabels ? 42 : undefined}
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    tickFormatter={formatPercent}
                    tick={{ fontSize: 12, fill: theme.palette.text.secondary }}
                    width={60}
                    domain={[0, percentAxisMax]}
                  />
                  <Tooltip
                    allowEscapeViewBox={{ x: true, y: true }}
                    reverseDirection={{ x: true, y: false }}
                    cursor={{ fill: alpha(theme.palette.divider, 0.2) }}
                    content={<TrendTooltip formatter={config.formatter} chartMode="bar" />}
                    wrapperStyle={{ zIndex: 1000, pointerEvents: "none" }}
                  />
                  {selectedSeries.map((series) => (
                    <Bar
                      key={`comparison-${series.key}`}
                      hide={!visibleBars.includes("comparison")}
                      dataKey={series.comparisonPctKey}
                      name={series.key}
                      fill={tint(series.color, 0.45)}
                      radius={[4, 4, 0, 0]}
                      maxBarSize={28}
                    >
                      {showWeeklyBarPercentLabels &&
                        renderBarPercentLabel(series.comparisonPctKey)}
                    </Bar>
                  ))}
                  {selectedSeries.map((series) => (
                    <Bar
                      key={`current-${series.key}`}
                      hide={!visibleBars.includes("primary")}
                      dataKey={series.currentPctKey}
                      name={series.key}
                      fill={series.color}
                      radius={[4, 4, 0, 0]}
                      maxBarSize={28}
                    >
                      {showWeeklyBarPercentLabels &&
                        renderBarPercentLabel(series.currentPctKey)}
                    </Bar>
                  ))}
                </BarChart>
              )}
            </ResponsiveContainer>
          </Box>
        )}
      </CardContent>
    </Card>
  );
});

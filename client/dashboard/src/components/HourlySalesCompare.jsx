import { Fragment, useEffect, useMemo, useRef, useState, memo } from "react";
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
} from "@mui/material";
import { useTheme, alpha } from "@mui/material/styles";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useInrCurrency } from "../lib/currency.js";
import { useDashboardDataApi } from "../features/dashboard/DashboardDataProvider.jsx";

const nfInt0 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const nfPercent1 = new Intl.NumberFormat(undefined, {
  style: "percent",
  maximumFractionDigits: 2,
});
const nfCompactInt = new Intl.NumberFormat("en-IN", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const nfFloat2 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const nfCompactFloat = new Intl.NumberFormat(undefined, {
  notation: "compact",
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

function formatHourLabel(hour) {
  const normalized = hour % 12 === 0 ? 12 : hour % 12;
  return `${normalized}${hour >= 12 ? "pm" : "am"}`;
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

function formatRangeLabel(range) {
  if (!range || !range.start || !range.end) return "";
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

function aggregateMetrics(points = []) {
  return points.reduce((acc, point) => {
    const metrics = point?.metrics || {};
    Object.entries(metrics).forEach(([key, value]) => {
      const numericValue = Number(value || 0);
      acc[key] = (acc[key] || 0) + numericValue;
    });
    return acc;
  }, {});
}

function buildWeeklyBuckets(points = [], comparisonPoints = []) {
  const bucketCount = Math.ceil(points.length / WEEK_SIZE_DAYS);

  return Array.from({ length: bucketCount }, (_, index) => {
    const startIdx = index * WEEK_SIZE_DAYS;
    const endIdx = startIdx + WEEK_SIZE_DAYS;

    return {
      label: `Week ${index + 1}`,
      metrics: aggregateMetrics(points.slice(startIdx, endIdx)),
      comparisonMetrics: aggregateMetrics(comparisonPoints.slice(startIdx, endIdx)),
      isInProgressHour: false,
      hour: null,
    };
  });
}

function buildMetricConfig(convertAmount, formatConvertedAmount) {
  return {
    aov: {
      id: "aov",
      label: "Avg Order Value",
      unitKind: "currency",
      axisGroup: "currency",
      color: "#8b5cf6",
      strokeDasharray: "2 0",
      accessor: (metrics) => {
        const sales = convertAmount(metrics?.sales || 0);
        const orders = Number(metrics?.orders || 0);
        return orders > 0 ? sales / orders : 0;
      },
      formatter: (value) =>
        formatConvertedAmount(value || 0, { maximumFractionDigits: 2 }),
      compactFormatter: (value) =>
        formatConvertedAmount(value || 0, {
          notation: "compact",
          maximumFractionDigits: 1,
        }),
    },
    orders: {
      id: "orders",
      label: "Total Orders",
      unitKind: "count",
      axisGroup: "count",
      color: "#2563eb",
      strokeDasharray: "2 0",
      accessor: (metrics) => Number(metrics?.orders || 0),
      formatter: (value) => nfInt0.format(value || 0),
      compactFormatter: (value) => nfCompactInt.format(value || 0),
    },
    sales: {
      id: "sales",
      label: "Total Revenue",
      unitKind: "currency",
      axisGroup: "currency",
      color: "#10b981",
      strokeDasharray: "2 0",
      accessor: (metrics) => convertAmount(metrics?.sales ?? 0),
      formatter: (value) =>
        formatConvertedAmount(value || 0, { maximumFractionDigits: 0 }),
      compactFormatter: (value) =>
        formatConvertedAmount(value || 0, {
          notation: "compact",
          maximumFractionDigits: 1,
        }),
    },
    gross_revenue: {
      id: "gross_revenue",
      label: "Gross Revenue",
      unitKind: "currency",
      axisGroup: "currency",
      color: "#10b981",
      strokeDasharray: "2 0",
      accessor: (metrics) => convertAmount(metrics?.sales ?? 0),
      formatter: (value) =>
        formatConvertedAmount(value || 0, { maximumFractionDigits: 0 }),
      compactFormatter: (value) =>
        formatConvertedAmount(value || 0, {
          notation: "compact",
          maximumFractionDigits: 1,
        }),
    },
    net_revenue: {
      id: "net_revenue",
      label: "Net Revenue",
      unitKind: "currency",
      axisGroup: "currency",
      color: "#3b82f6",
      strokeDasharray: "6 3",
      accessor: (metrics) => convertAmount(metrics?.sales ?? 0) / 1.18,
      formatter: (value) =>
        formatConvertedAmount(value || 0, { maximumFractionDigits: 0 }),
      compactFormatter: (value) =>
        formatConvertedAmount(value || 0, {
          notation: "compact",
          maximumFractionDigits: 1,
        }),
    },
    sessions: {
      id: "sessions",
      label: "Total Sessions",
      unitKind: "count",
      axisGroup: "count",
      color: "#0f766e",
      strokeDasharray: "8 4",
      accessor: (metrics) => Number(metrics?.sessions || 0),
      formatter: (value) => nfInt0.format(value || 0),
      compactFormatter: (value) => nfCompactInt.format(value || 0),
    },
    cvr: {
      id: "cvr",
      label: "Conversion Rate",
      unitKind: "percent",
      axisGroup: "percent",
      color: "#f97316",
      strokeDasharray: "4 3",
      accessor: (metrics) => Number(metrics?.cvr_ratio || 0),
      formatter: (value) => nfPercent1.format(value || 0),
      compactFormatter: (value) => nfPercent1.format(value || 0),
    },
    atc: {
      id: "atc",
      label: "ATC Sessions",
      unitKind: "count",
      axisGroup: "count",
      color: "#eab308",
      strokeDasharray: "6 3",
      accessor: (metrics) => Number(metrics?.atc || 0),
      formatter: (value) => nfInt0.format(value || 0),
      compactFormatter: (value) => nfCompactInt.format(value || 0),
    },
    atc_sessions: {
      id: "atc_sessions",
      label: "ATC Sessions",
      unitKind: "count",
      axisGroup: "count",
      color: "#eab308",
      strokeDasharray: "6 3",
      accessor: (metrics) => Number(metrics?.atc || 0),
      formatter: (value) => nfInt0.format(value || 0),
      compactFormatter: (value) => nfCompactInt.format(value || 0),
    },
    ci_events: {
      id: "ci_events",
      label: "Checkout Initiated Events",
      unitKind: "count",
      axisGroup: "count",
      color: "#3b82f6",
      strokeDasharray: "3 2",
      accessor: (metrics) => Number(metrics?.ci_events || 0),
      formatter: (value) => nfInt0.format(value || 0),
      compactFormatter: (value) => nfCompactInt.format(value || 0),
    },
    checkout_rate: {
      id: "checkout_rate",
      label: "Checkout Rate",
      unitKind: "percent",
      axisGroup: "percent",
      color: "#14b8a6",
      strokeDasharray: "10 4",
      accessor: (metrics) => {
        const ciEvents = Number(metrics?.ci_events || 0);
        const sessions = Number(metrics?.sessions || 0);
        return sessions > 0 ? ciEvents / sessions : 0;
      },
      formatter: (value) => nfPercent1.format(value || 0),
      compactFormatter: (value) => nfPercent1.format(value || 0),
    },
    atc_rate: {
      id: "atc_rate",
      label: "ATC Rate",
      unitKind: "percent",
      axisGroup: "percent",
      color: "#f59e0b",
      strokeDasharray: "5 3",
      accessor: (metrics) => {
        const atc = Number(metrics?.atc || 0);
        const sessions = Number(metrics?.sessions || 0);
        return sessions > 0 ? atc / sessions : 0;
      },
      formatter: (value) => nfPercent1.format(value || 0),
      compactFormatter: (value) => nfPercent1.format(value || 0),
    },
    high_intent: {
      id: "high_intent",
      label: "High Intent",
      unitKind: "percent",
      axisGroup: "percent",
      color: "#22c55e",
      strokeDasharray: "2 0",
      // Backend sends intent pct on a 0-100 scale (matching the KPI card),
      // but nfPercent1 is an Intl percent formatter expecting a 0-1 fraction.
      accessor: (metrics) => Number(metrics?.high_intent_pct || 0) / 100,
      formatter: (value) => nfPercent1.format(value || 0),
      compactFormatter: (value) => nfPercent1.format(value || 0),
    },
    medium_intent: {
      id: "medium_intent",
      label: "Medium Intent",
      unitKind: "percent",
      axisGroup: "percent",
      color: "#f59e0b",
      strokeDasharray: "6 2",
      accessor: (metrics) => Number(metrics?.medium_intent_pct || 0) / 100,
      formatter: (value) => nfPercent1.format(value || 0),
      compactFormatter: (value) => nfPercent1.format(value || 0),
    },
    low_intent: {
      id: "low_intent",
      label: "Low Intent",
      unitKind: "percent",
      axisGroup: "percent",
      color: "#ef4444",
      strokeDasharray: "1 3",
      accessor: (metrics) => Number(metrics?.low_intent_pct || 0) / 100,
      formatter: (value) => nfPercent1.format(value || 0),
      compactFormatter: (value) => nfPercent1.format(value || 0),
    },
    high_intent_sessions: {
      id: "high_intent_sessions",
      label: "High Intent",
      unitKind: "count",
      axisGroup: "count",
      color: "#22c55e",
      strokeDasharray: "2 0",
      accessor: (metrics) => Number(metrics?.high_intent_sessions || 0),
      formatter: (value) => nfInt0.format(value || 0),
      compactFormatter: (value) => nfCompactInt.format(value || 0),
    },
    medium_intent_sessions: {
      id: "medium_intent_sessions",
      label: "Medium Intent",
      unitKind: "count",
      axisGroup: "count",
      color: "#f59e0b",
      strokeDasharray: "6 2",
      accessor: (metrics) => Number(metrics?.medium_intent_sessions || 0),
      formatter: (value) => nfInt0.format(value || 0),
      compactFormatter: (value) => nfCompactInt.format(value || 0),
    },
    low_intent_sessions: {
      id: "low_intent_sessions",
      label: "Low Intent",
      unitKind: "count",
      axisGroup: "count",
      color: "#ef4444",
      strokeDasharray: "1 3",
      accessor: (metrics) => Number(metrics?.low_intent_sessions || 0),
      formatter: (value) => nfInt0.format(value || 0),
      compactFormatter: (value) => nfCompactInt.format(value || 0),
    },
    performance: {
      id: "performance",
      label: "Web Performance(Avg)",
      unitKind: "score",
      axisGroup: "score",
      color: "#06b6d4",
      strokeDasharray: "2 0",
      accessor: (metrics) => {
        const value = Number(metrics?.performance);
        return Number.isFinite(value) ? value : null;
      },
      formatter: (value) => nfFloat2.format(value || 0),
      compactFormatter: (value) => nfCompactFloat.format(value || 0),
    },
    payment_orders: {
      id: "payment_orders",
      label: "Mode of Payment - Order count",
      compositeDefs: [
        {
          id: "payment_orders_prepaid",
          parentId: "payment_orders",
          label: "Prepaid Orders",
          unitKind: "count",
          axisGroup: "count",
          color: "#2cc995",
          strokeDasharray: "2 0",
          accessor: (metrics) => Number(metrics?.payment_orders_prepaid || 0),
          formatter: (value) => nfInt0.format(value || 0),
          compactFormatter: (value) => nfCompactInt.format(value || 0),
        },
        {
          id: "payment_orders_cod",
          parentId: "payment_orders",
          label: "COD Orders",
          unitKind: "count",
          axisGroup: "count",
          color: "#1f5748",
          strokeDasharray: "4 3",
          accessor: (metrics) => Number(metrics?.payment_orders_cod || 0),
          formatter: (value) => nfInt0.format(value || 0),
          compactFormatter: (value) => nfCompactInt.format(value || 0),
        },
        {
          id: "payment_orders_partial",
          parentId: "payment_orders",
          label: "Partially Paid Orders",
          unitKind: "count",
          axisGroup: "count",
          color: "#8da399",
          strokeDasharray: "6 3",
          accessor: (metrics) => Number(metrics?.payment_orders_partial || 0),
          formatter: (value) => nfInt0.format(value || 0),
          compactFormatter: (value) => nfCompactInt.format(value || 0),
        },
      ],
    },
    payment_sales: {
      id: "payment_sales",
      label: "Mode of Payment - Sales",
      compositeDefs: [
        {
          id: "payment_sales_prepaid",
          parentId: "payment_sales",
          label: "Prepaid Sales",
          unitKind: "currency",
          axisGroup: "currency",
          color: "#2cc995",
          strokeDasharray: "2 0",
          accessor: (metrics) => Number(metrics?.payment_sales_prepaid || 0),
          formatter: (value) =>
            formatConvertedAmount(value || 0, { maximumFractionDigits: 0 }),
          compactFormatter: (value) =>
            formatConvertedAmount(value || 0, {
              notation: "compact",
              maximumFractionDigits: 1,
            }),
        },
        {
          id: "payment_sales_cod",
          parentId: "payment_sales",
          label: "COD Sales",
          unitKind: "currency",
          axisGroup: "currency",
          color: "#1f5748",
          strokeDasharray: "4 3",
          accessor: (metrics) => Number(metrics?.payment_sales_cod || 0),
          formatter: (value) =>
            formatConvertedAmount(value || 0, { maximumFractionDigits: 0 }),
          compactFormatter: (value) =>
            formatConvertedAmount(value || 0, {
              notation: "compact",
              maximumFractionDigits: 1,
            }),
        },
        {
          id: "payment_sales_partial",
          parentId: "payment_sales",
          label: "Partially Paid Sales",
          unitKind: "currency",
          axisGroup: "currency",
          color: "#8da399",
          strokeDasharray: "6 3",
          accessor: (metrics) => Number(metrics?.payment_sales_partial || 0),
          formatter: (value) =>
            formatConvertedAmount(value || 0, { maximumFractionDigits: 0 }),
          compactFormatter: (value) =>
            formatConvertedAmount(value || 0, {
              notation: "compact",
              maximumFractionDigits: 1,
            }),
        },
      ],
    },
  };
}

function computeAxisDomain(values, unitKind) {
  const numericValues = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));

  if (numericValues.length === 0) return [0, 1];

  let min = Math.min(...numericValues);
  let max = Math.max(...numericValues);

  if (min === max) {
    const basePad =
      unitKind === "percent"
        ? 0.01
        : unitKind === "count"
          ? Math.max(1, Math.abs(max) * 0.15)
          : Math.max(1, Math.abs(max) * 0.08);
    return [min - basePad, max + basePad];
  }

  const spread = max - min;
  const pad = spread * (unitKind === "percent" ? 0.12 : 0.08);
  min -= pad;
  max += pad;

  return [min, max];
}

function SeriesLegend({
  entries,
  compareMode = false,
  hiddenKeys,
  onToggle,
  hoveredKey,
  onHover,
}) {
  return (
    <Stack direction="row" spacing={1.25} sx={{ flexWrap: "wrap", rowGap: 1 }}>
      {entries.map((entry) => {
        const hidden = hiddenKeys.includes(entry.id);
        const muted = hoveredKey && hoveredKey !== entry.id;
        return (
          <Box
            key={entry.id}
            component="button"
            type="button"
            onClick={() => onToggle(entry.id)}
            onMouseEnter={() => onHover(entry.id)}
            onMouseLeave={() => onHover(null)}
            sx={{
              display: "inline-flex",
              alignItems: "center",
              gap: 1,
              px: 0,
              py: 0,
              border: "none",
              bgcolor: "transparent",
              cursor: "pointer",
              opacity: hidden ? 0.45 : muted ? 0.5 : 1,
              transition: "opacity 0.18s ease",
              color: "inherit",
              font: "inherit",
            }}
          >
            <Box
              sx={{
                width: 14,
                height: 14,
                borderRadius: compareMode ? "3px" : "999px",
                border: "1px solid",
                borderColor: entry.color,
                bgcolor: hidden ? "transparent" : entry.color,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {!hidden && (
                <Box
                  sx={{
                    width: compareMode ? 6 : 7,
                    height: compareMode ? 6 : 2,
                    bgcolor: "#fff",
                    borderRadius: compareMode ? "2px" : "999px",
                  }}
                />
              )}
            </Box>
            <Typography
              variant="caption"
              sx={{
                fontWeight: entry.active ? 700 : 600,
                color: hidden ? "text.secondary" : "text.primary",
              }}
            >
              {entry.label}
            </Typography>
          </Box>
        );
      })}
    </Stack>
  );
}

// Share of one payment mode in its group (prepaid / COD / partially paid) at a chart point.
// Hidden series still count in the total, so the shares of a point add up to 100%.
export function getPaymentShareLabel(def, metricValues = {}, selectedDefs = []) {
  if (!def?.parentId || !String(def.parentId).startsWith("payment_")) return "";
  const siblings = selectedDefs.filter((item) => item.parentId === def.parentId);
  const total = siblings.reduce((sum, item) => sum + Number(metricValues[item.id] || 0), 0);
  if (!(total > 0)) return "";
  return nfPercent1.format(Number(metricValues[def.id] || 0) / total);
}

function CustomTooltip({
  active,
  label,
  compareMode = false,
  selectedDefs = [],
  rangeLabels,
  compareFormatter,
  compareValue,
  currentValue,
  metricValues = {},
  hiddenMetricIds = [],
  visibleRangeLines = ["primary"],
}) {
  if (!active) return null;

  return (
    <Box
      sx={{
        bgcolor: "background.paper",
        border: "1px solid",
        borderColor: "divider",
        borderRadius: 2,
        boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
        p: 1.5,
        minWidth: 180,
      }}
    >
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: "block", mb: 1, fontWeight: 600 }}
      >
        {label}
      </Typography>
      {compareMode ? (
        <>
          {visibleRangeLines.includes("primary") && (
            <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 0.75 }}>
              <Box
                sx={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  bgcolor: "#10b981",
                }}
              />
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {rangeLabels.current || "Current"}
              </Typography>
              <Typography variant="body2" sx={{ fontWeight: 600, ml: "auto" }}>
                {compareFormatter(currentValue)}
              </Typography>
            </Box>
          )}
          {visibleRangeLines.includes("comparison") &&
            rangeLabels.previous &&
            compareValue != null && (
              <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                <Box
                  sx={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    bgcolor: alpha("#10b981", 0.5),
                  }}
                />
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  {rangeLabels.previous}
                </Typography>
                <Typography variant="body2" sx={{ fontWeight: 600, ml: "auto" }}>
                  {compareFormatter(compareValue)}
                </Typography>
              </Box>
            )}
        </>
      ) : (
        selectedDefs
          .filter((def) => !hiddenMetricIds.includes(def.id))
          .map((def) => (
            <Box
              key={def.id}
              sx={{ display: "flex", alignItems: "center", gap: 1, mb: 0.5 }}
            >
              <Box
                sx={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  bgcolor: def.color,
                }}
              />
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {def.label}
              </Typography>
              <Typography variant="body2" sx={{ fontWeight: 600, ml: "auto" }}>
                {def.formatter(metricValues[def.id])}
                {getPaymentShareLabel(def, metricValues, selectedDefs) && (
                  <Box component="span" sx={{ ml: 0.75, fontWeight: 500, color: "text.secondary" }}>
                    ({getPaymentShareLabel(def, metricValues, selectedDefs)})
                  </Box>
                )}
              </Typography>
            </Box>
          ))
      )}
    </Box>
  );
}

export default memo(function HourlySalesCompare({
  query,
  selectedMetrics = [],
  activeMetric = null,
  isLongRange = false,
}) {
  const {
    getHourlyTrend,
    getDailyTrend,
    getMonthlyTrend,
    getWebPerformanceSummary,
    getOrderSplit,
    getPaymentSalesSplit,
  } = useDashboardDataApi();
  const [loading, setLoading] = useState(true);
  const [chartData, setChartData] = useState([]);
  const [viewMode, setViewMode] = useState("hourly");
  const [chartMode, setChartMode] = useState("line");
  const [rangeLabels, setRangeLabels] = useState({ current: "", previous: "" });
  const [hiddenMetricIds, setHiddenMetricIds] = useState([]);
  const [visibleRangeLines, setVisibleRangeLines] = useState(["primary", "comparison"]);
  const [hoveredMetric, setHoveredMetric] = useState(null);

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
  const productType = query?.product_type;
  // mv_product_type_funnel_daily has no hourly grain — Hourly view is
  // disabled while a Product Type filter is active (see Division filters).
  const hasActiveProductTypeFilter = Array.isArray(productType) && productType.length > 0;
  const compare = query?.compare;
  const compareStart = query?.compare_start;
  const compareEnd = query?.compare_end;
  const { convertAmount, formatConvertedAmount } = useInrCurrency(brandKey, end);
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("sm"));
  const metricConfig = useMemo(
    () => buildMetricConfig(convertAmount, formatConvertedAmount),
    [convertAmount, formatConvertedAmount],
  );

  const requestedMetricIds = useMemo(
    () => (Array.isArray(selectedMetrics) ? selectedMetrics.filter(Boolean) : []),
    [selectedMetrics],
  );
  const effectiveMetricIds = useMemo(() => {
    if (requestedMetricIds.length > 0) return requestedMetricIds;
    return activeMetric ? [activeMetric] : [];
  }, [activeMetric, requestedMetricIds]);
  const activeMetricId = useMemo(() => {
    if (activeMetric && effectiveMetricIds.includes(activeMetric)) return activeMetric;
    return effectiveMetricIds[effectiveMetricIds.length - 1] || null;
  }, [activeMetric, effectiveMetricIds]);
  const selectedDefs = useMemo(
    () =>
      effectiveMetricIds.flatMap((metricId) => {
        const def = metricConfig[metricId];
        if (!def) return [];
        if (Array.isArray(def.compositeDefs)) return def.compositeDefs;
        return [def];
      }),
    [effectiveMetricIds, metricConfig],
  );
  const activeDef = activeMetricId ? metricConfig[activeMetricId] : null;
  const hasPerformanceSelected = effectiveMetricIds.includes("performance");
  const hasPaymentCompositeSelected = effectiveMetricIds.some((metricId) =>
    ["payment_orders", "payment_sales"].includes(metricId),
  );
  // high_intent_pct/medium_intent_pct/low_intent_pct come from
  // daily_user_intent_summary, a daily-only table — no hourly grain exists.
  const hasIntentSelected = effectiveMetricIds.some((metricId) =>
    ["high_intent", "medium_intent", "low_intent"].includes(metricId),
  );

  const daysInRange = useMemo(() => {
    if (!start || !end) return 0;
    const s = new Date(start);
    const e = new Date(end);
    return Math.ceil((e - s) / (1000 * 60 * 60 * 24)) + 1;
  }, [start, end]);
  const useWeeklyBuckets =
    viewMode === "daily" &&
    daysInRange > WEEKLY_LABEL_THRESHOLD &&
    !hasPerformanceSelected;
  const canUseHourlyPaymentTrend = daysInRange === 1;
  // Bar readability depends on bar count, not raw days spanned: a wide date
  // range collapses to just a few bars in the monthly view, so it's never
  // too crowded there the way a daily bar chart over the same range would be.
  const canUseBarChart = viewMode === "monthly" ? true : daysInRange <= 31;
  const hasComparisonData = useMemo(
    () =>
      chartData.some(
        (point) =>
          point.comparisonMetrics &&
          Object.keys(point.comparisonMetrics).length > 0,
      ) || Boolean(rangeLabels.previous),
    [chartData, rangeLabels.previous],
  );
  const shouldShowCompare =
    hasComparisonData &&
    effectiveMetricIds.length <= 1 &&
    !hasPaymentCompositeSelected;

  useEffect(() => {
    if (
      (isLongRange ||
        hasPerformanceSelected ||
        hasActiveProductTypeFilter ||
        (hasPaymentCompositeSelected && !canUseHourlyPaymentTrend)) &&
      viewMode === "hourly"
    ) {
      setViewMode("daily");
    }
  }, [
    canUseHourlyPaymentTrend,
    hasActiveProductTypeFilter,
    hasPaymentCompositeSelected,
    hasPerformanceSelected,
    isLongRange,
    viewMode,
  ]);

  // Intent metrics (high/medium/low) only have a daily grain
  // (daily_user_intent_summary) — no hourly or monthly rollup exists, so
  // selecting one always forces the trend chart into the daily view,
  // regardless of which view it's currently switching away from.
  useEffect(() => {
    if (hasIntentSelected && viewMode !== "daily") {
      setViewMode("daily");
    }
  }, [hasIntentSelected, viewMode]);

  useEffect(() => {
    setHiddenMetricIds((prev) =>
      prev.filter((metricId) => selectedDefs.some((def) => def.id === metricId)),
    );
  }, [selectedDefs]);

  useEffect(() => {
    setVisibleRangeLines((prev) =>
      prev.filter((entry) => ["primary", "comparison"].includes(entry)),
    );
  }, [shouldShowCompare]);

  useEffect(() => {
    if (!canUseBarChart && chartMode === "bar") {
      setChartMode("line");
    }
  }, [canUseBarChart, chartMode]);

  // Default to Daily + Bar the moment the selected range grows to 3+ days
  // (only on that transition, so a manual override made while already in a
  // 3+ day range isn't fought on every subsequent render). Ranges over 8
  // days still fall back to Line via the canUseBarChart effect above.
  const isMultiDayRange = daysInRange >= 3;
  const wasMultiDayRangeRef = useRef(isMultiDayRange);
  useEffect(() => {
    if (isMultiDayRange && !wasMultiDayRangeRef.current) {
      setViewMode("daily");
      setChartMode("bar");
    }
    wasMultiDayRangeRef.current = isMultiDayRange;
  }, [isMultiDayRange]);

  useEffect(() => {
    let cancelled = false;
    if (!start || !end) {
      setChartData([]);
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    if (viewMode === "monthly" && daysInRange < 30) {
      setViewMode("daily");
    }
    setLoading(true);

    const loadData = async () => {
      const utmParams = {
        utm_source: utmSource,
        utm_medium: utmMedium,
        utm_campaign: utmCampaign,
        sales_channel: salesChannel,
        device_type: deviceType,
        product_id: productId,
        discount_code: discountCode,
        city: query?.city,
        product_type: productType,
      };
      const fetcher =
        viewMode === "monthly"
          ? getMonthlyTrend
          : viewMode === "daily"
            ? getDailyTrend
            : getHourlyTrend;
      const base =
        viewMode === "daily" || viewMode === "monthly"
          ? {
              start,
              end,
              compare,
              compare_start: compareStart,
              compare_end: compareEnd,
              ...utmParams,
            }
          : {
              start,
              end,
              compare,
              compare_start: compareStart,
              compare_end: compareEnd,
              aggregate: "avg-by-hour",
              ...utmParams,
            };
      const params = brandKey ? { ...base, brand_key: brandKey } : base;

      try {
        const [res, performanceSummary] = await Promise.all([
          fetcher(params),
          hasPerformanceSelected
            ? getWebPerformanceSummary(params)
            : Promise.resolve(null),
        ]);
        if (cancelled) return;
        if (res?.error) throw new Error("Fetch failed");
        if (performanceSummary?.__error) {
          throw new Error("Performance fetch failed");
        }

        let points = [];
        let comparisonPoints = [];

        if (viewMode === "daily") {
          points = Array.isArray(res.days) ? res.days : [];
          comparisonPoints = Array.isArray(res?.comparison?.days)
            ? res.comparison.days
            : [];
        } else if (viewMode === "monthly") {
          points = Array.isArray(res.points) ? res.points : [];
          comparisonPoints = Array.isArray(res?.comparison?.points)
            ? res.comparison.points
            : [];
        } else {
          points = Array.isArray(res.points) ? res.points : [];
          const timezone = res.timezone || "Asia/Kolkata";
          const todayInStoreTimezone = new Date().toLocaleDateString("en-CA", {
            timeZone: timezone,
          });
          const isCurrentStoreDay = start === todayInStoreTimezone;
          let currentHour = null;

          if (start === todayInStoreTimezone) {
            currentHour = Number.parseInt(
              new Date().toLocaleTimeString("en-US", {
                timeZone: timezone,
                hour12: false,
                hour: "numeric",
              }),
              10,
            );
            points = points.filter((point) => point.hour <= currentHour);
          }

          comparisonPoints = Array.isArray(res?.comparison?.points)
            ? res.comparison.points
            : [];
          points = points.map((point) => ({
            ...point,
            __isInProgressHour:
              isCurrentStoreDay &&
              Number.isInteger(currentHour) &&
              point?.hour === currentHour,
          }));
        }

        const buildPerformanceMap = (rows = []) => {
          if (!Array.isArray(rows) || rows.length === 0) return new Map();

          if (viewMode === "monthly") {
            const monthlyAverages = new Map();
            rows.forEach((row) => {
              if (!row?.date) return;
              const monthKey = String(row.date).slice(0, 7);
              const existing = monthlyAverages.get(monthKey) || {
                sum: 0,
                count: 0,
              };
              existing.sum += Number(row.avg_performance || 0);
              existing.count += 1;
              monthlyAverages.set(monthKey, existing);
            });

            return new Map(
              Array.from(monthlyAverages.entries()).map(([key, value]) => [
                key,
                value.count > 0 ? value.sum / value.count : null,
              ]),
            );
          }

          return new Map(
            rows.map((row) => [row.date, Number(row.avg_performance || 0)]),
          );
        };

        const currentPerformanceMap = buildPerformanceMap(
          performanceSummary?.daily_averages,
        );
        const previousPerformanceMap = buildPerformanceMap(
          performanceSummary?.previous_daily_averages,
        );
        const paymentMetricsByDate = new Map();
        const paymentMetricsByMonth = new Map();
        const paymentMetricsByHour = new Map();
        const previousPaymentMetricsByHour = new Map();

        if (hasPaymentCompositeSelected) {
          const paymentBaseParams = {
            brand_key: brandKey,
            utm_source: utmSource,
            utm_medium: utmMedium,
            utm_campaign: utmCampaign,
            sales_channel: salesChannel,
            device_type: deviceType,
            product_id: productId,
            discount_code: discountCode,
            city: query?.city,
          };
          if (viewMode === "hourly" && canUseHourlyPaymentTrend) {
            const timezoneMeta = await getOrderSplit({
              ...paymentBaseParams,
              start,
              end,
            });
            const splitTimezone = timezoneMeta?.timezone || res.timezone || "Asia/Kolkata";
            const todayInStoreTimezone = new Date().toLocaleDateString("en-CA", {
              timeZone: splitTimezone,
            });
            const hourLimit =
              start === todayInStoreTimezone
                ? Number.parseInt(
                    new Date().toLocaleTimeString("en-US", {
                      timeZone: splitTimezone,
                      hour12: false,
                      hour: "numeric",
                    }),
                    10,
                  )
                : 23;
            const hours = Array.from({ length: hourLimit + 1 }, (_, index) => index);

            const currentHourlySeries = await Promise.all(
              hours.map(async (hour) => {
                const [orders, sales] = await Promise.all([
                  getOrderSplit({ ...paymentBaseParams, start, end, hour_lte: hour }),
                  getPaymentSalesSplit({
                    ...paymentBaseParams,
                    start,
                    end,
                    hour_lte: hour,
                  }),
                ]);
                return { hour, orders, sales };
              }),
            );

            const previousHourlySeries =
              compareStart && compareEnd
                ? await Promise.all(
                    hours.map(async (hour) => {
                      const [orders, sales] = await Promise.all([
                        getOrderSplit({
                          ...paymentBaseParams,
                          start: compareStart,
                          end: compareEnd,
                          hour_lte: hour,
                        }),
                        getPaymentSalesSplit({
                          ...paymentBaseParams,
                          start: compareStart,
                          end: compareEnd,
                          hour_lte: hour,
                        }),
                      ]);
                      return { hour, orders, sales };
                    }),
                  )
                : [];

            currentHourlySeries.forEach((point, index) => {
              const previousPoint = index > 0 ? currentHourlySeries[index - 1] : null;
              const currentValues = {
                payment_orders_prepaid: Math.max(
                  0,
                  Number(point.orders?.prepaid_orders || 0) -
                    Number(previousPoint?.orders?.prepaid_orders || 0),
                ),
                payment_orders_cod: Math.max(
                  0,
                  Number(point.orders?.cod_orders || 0) -
                    Number(previousPoint?.orders?.cod_orders || 0),
                ),
                payment_orders_partial: Math.max(
                  0,
                  Number(point.orders?.partially_paid_orders || 0) -
                    Number(previousPoint?.orders?.partially_paid_orders || 0),
                ),
                payment_sales_prepaid: convertAmount(
                  Math.max(
                    0,
                    Number(point.sales?.prepaid_sales || 0) -
                      Number(previousPoint?.sales?.prepaid_sales || 0),
                  ),
                ),
                payment_sales_cod: convertAmount(
                  Math.max(
                    0,
                    Number(point.sales?.cod_sales || 0) -
                      Number(previousPoint?.sales?.cod_sales || 0),
                  ),
                ),
                payment_sales_partial: convertAmount(
                  Math.max(
                    0,
                    Number(point.sales?.partial_sales || 0) -
                      Number(previousPoint?.sales?.partial_sales || 0),
                  ),
                ),
              };
              paymentMetricsByHour.set(point.hour, currentValues);
            });

            previousHourlySeries.forEach((point, index) => {
              const previousPoint = index > 0 ? previousHourlySeries[index - 1] : null;
              const previousValues = {
                payment_orders_prepaid: Math.max(
                  0,
                  Number(point.orders?.prepaid_orders || 0) -
                    Number(previousPoint?.orders?.prepaid_orders || 0),
                ),
                payment_orders_cod: Math.max(
                  0,
                  Number(point.orders?.cod_orders || 0) -
                    Number(previousPoint?.orders?.cod_orders || 0),
                ),
                payment_orders_partial: Math.max(
                  0,
                  Number(point.orders?.partially_paid_orders || 0) -
                    Number(previousPoint?.orders?.partially_paid_orders || 0),
                ),
                payment_sales_prepaid: convertAmount(
                  Math.max(
                    0,
                    Number(point.sales?.prepaid_sales || 0) -
                      Number(previousPoint?.sales?.prepaid_sales || 0),
                  ),
                ),
                payment_sales_cod: convertAmount(
                  Math.max(
                    0,
                    Number(point.sales?.cod_sales || 0) -
                      Number(previousPoint?.sales?.cod_sales || 0),
                  ),
                ),
                payment_sales_partial: convertAmount(
                  Math.max(
                    0,
                    Number(point.sales?.partial_sales || 0) -
                      Number(previousPoint?.sales?.partial_sales || 0),
                  ),
                ),
              };
              previousPaymentMetricsByHour.set(point.hour, previousValues);
            });
          } else {
            const currentDates = buildDateRange(start, end);
            const paymentSeries = await Promise.all(
              currentDates.map(async (date) => {
                const [orders, sales] = await Promise.all([
                  getOrderSplit({ ...paymentBaseParams, start: date, end: date }),
                  getPaymentSalesSplit({
                    ...paymentBaseParams,
                    start: date,
                    end: date,
                  }),
                ]);

                return {
                  date,
                  values: {
                    payment_orders_prepaid: Number(orders?.prepaid_orders || 0),
                    payment_orders_cod: Number(orders?.cod_orders || 0),
                    payment_orders_partial: Number(orders?.partially_paid_orders || 0),
                    payment_sales_prepaid: convertAmount(sales?.prepaid_sales || 0),
                    payment_sales_cod: convertAmount(sales?.cod_sales || 0),
                    payment_sales_partial: convertAmount(sales?.partial_sales || 0),
                  },
                };
              }),
            );

            paymentSeries.forEach(({ date, values }) => {
              paymentMetricsByDate.set(date, values);
              const monthKey = String(date).slice(0, 7);
              const existing = paymentMetricsByMonth.get(monthKey) || {
                payment_orders_prepaid: 0,
                payment_orders_cod: 0,
                payment_orders_partial: 0,
                payment_sales_prepaid: 0,
                payment_sales_cod: 0,
                payment_sales_partial: 0,
              };

              Object.entries(values).forEach(([key, value]) => {
                existing[key] = Number(existing[key] || 0) + Number(value || 0);
              });

              paymentMetricsByMonth.set(monthKey, existing);
            });
          }
        }

        const normalizedPoints = points.map((point) => {
          let label = point.date;
          if (viewMode === "hourly") {
            label = formatHourLabel(point.hour);
          } else if (point.date) {
            const dt = new Date(`${point.date}T00:00:00Z`);
            if (!Number.isNaN(dt.getTime())) {
              label =
                viewMode === "monthly"
                  ? MONTH_NAMES[dt.getUTCMonth()]
                  : `${MONTH_NAMES[dt.getUTCMonth()]} ${dt.getUTCDate()}`;
            }
          }

          let performanceValue = null;
          if (hasPerformanceSelected && point.date) {
            performanceValue =
              viewMode === "monthly"
                ? currentPerformanceMap.get(String(point.date).slice(0, 7))
                : currentPerformanceMap.get(point.date);
          }

          const paymentMetricValues =
            hasPaymentCompositeSelected
              ? viewMode === "hourly"
                ? paymentMetricsByHour.get(point.hour) || {}
                : point.date
                  ? viewMode === "monthly"
                    ? paymentMetricsByMonth.get(String(point.date).slice(0, 7)) || {}
                    : paymentMetricsByDate.get(point.date) || {}
                  : {}
              : {};

          return {
            label,
            date: point.date || null,
            hour: typeof point.hour === "number" ? point.hour : null,
            isInProgressHour: Boolean(point.__isInProgressHour),
            metrics: hasPerformanceSelected || hasPaymentCompositeSelected
              ? {
                  ...(point.metrics || {}),
                  performance: performanceValue,
                  ...paymentMetricValues,
                }
              : point.metrics || {},
          };
        });

        const normalizedComparisonPoints = comparisonPoints.map((point) => {
          let performanceValue = null;
          if (hasPerformanceSelected && point.date) {
            performanceValue =
              viewMode === "monthly"
                ? previousPerformanceMap.get(String(point.date).slice(0, 7))
                : previousPerformanceMap.get(point.date);
          }

          return {
            date: point.date || null,
            metrics: hasPerformanceSelected || hasPaymentCompositeSelected
              ? {
                  ...(point.metrics || {}),
                  performance: performanceValue,
                  ...(viewMode === "hourly"
                    ? previousPaymentMetricsByHour.get(point.hour) || {}
                    : {}),
                }
              : point.metrics || {},
          };
        });

        const data = useWeeklyBuckets
          ? buildWeeklyBuckets(normalizedPoints, normalizedComparisonPoints)
          : normalizedPoints.map((point, index) => ({
              ...point,
              comparisonMetrics:
                normalizedComparisonPoints[index]?.metrics || null,
            }));

        setRangeLabels({
          current: formatRangeLabel(res.range),
          previous: formatRangeLabel(res?.comparison?.range),
        });
        setChartData(data);
        setLoading(false);
      } catch {
        if (!cancelled) {
          setChartData([]);
          setLoading(false);
        }
      }
    };

    loadData();
    return () => {
      cancelled = true;
    };
  }, [
    brandKey,
    compare,
    compareEnd,
    compareStart,
    daysInRange,
    deviceType,
    discountCode,
    end,
    getDailyTrend,
    getHourlyTrend,
    getMonthlyTrend,
    getOrderSplit,
    getPaymentSalesSplit,
    getWebPerformanceSummary,
    productId,
    query?.city,
    refreshKey,
    salesChannel,
    start,
    useWeeklyBuckets,
    utmCampaign,
    utmMedium,
    utmSource,
    viewMode,
    convertAmount,
    canUseHourlyPaymentTrend,
    hasPerformanceSelected,
    hasPaymentCompositeSelected,
  ]);

  const processedChartData = useMemo(() => {
    if (selectedDefs.length === 0) return [];

    const mapped = chartData.map((point) => {
      const nextPoint = {
        label: point.label,
        hour: point.hour,
        isInProgressHour: point.isInProgressHour,
      };

      selectedDefs.forEach((def) => {
        const value = def.accessor(point.metrics || {});
        nextPoint[def.id] = value;
        nextPoint[`${def.id}PrimaryValue`] =
          point.isInProgressHour && viewMode === "hourly" ? null : value;
        nextPoint[`${def.id}PrimaryTailValue`] =
          point.isInProgressHour && viewMode === "hourly" ? value : null;
      });

      if (shouldShowCompare && activeDef) {
        const currentValue = activeDef.accessor(point.metrics || {});
        nextPoint.currentValue = currentValue;
        nextPoint.comparisonValue = point.comparisonMetrics
          ? activeDef.accessor(point.comparisonMetrics)
          : null;
        nextPoint.currentPrimaryValue =
          point.isInProgressHour && viewMode === "hourly" ? null : currentValue;
        nextPoint.currentTailValue =
          point.isInProgressHour && viewMode === "hourly" ? currentValue : null;
      }

      return nextPoint;
    });

    if (viewMode !== "hourly") {
      return mapped;
    }

    const tailIndex = mapped.findIndex((point) => point.isInProgressHour);
    if (tailIndex <= 0) {
      return mapped;
    }

    const previousIndex = tailIndex - 1;
    const enriched = mapped.map((point, index) => {
      const nextPoint = { ...point };

      selectedDefs.forEach((def) => {
        if (index === previousIndex || index === tailIndex) {
          nextPoint[`${def.id}PrimaryTailValue`] = point[def.id];
          if (index === tailIndex) {
            nextPoint[`${def.id}PrimaryValue`] = null;
          }
        } else {
          nextPoint[`${def.id}PrimaryTailValue`] = null;
        }
      });

      if (shouldShowCompare && activeDef) {
        if (index === previousIndex || index === tailIndex) {
          nextPoint.currentTailValue = point.currentValue;
          if (index === tailIndex) {
            nextPoint.currentPrimaryValue = null;
          }
        } else {
          nextPoint.currentTailValue = null;
        }
      }

      return nextPoint;
    });

    return enriched;
  }, [activeDef, chartData, selectedDefs, shouldShowCompare, viewMode]);

  const showHourlyTail = useMemo(() => {
    if (viewMode !== "hourly" || processedChartData.length < 2) return false;
    return Boolean(processedChartData[processedChartData.length - 1]?.isInProgressHour);
  }, [processedChartData, viewMode]);

  const visibleDefs = useMemo(
    () => selectedDefs.filter((def) => !hiddenMetricIds.includes(def.id)),
    [hiddenMetricIds, selectedDefs],
  );

  const axisGroups = useMemo(() => {
    const groups = new Map();

    // One axis per selected metric (keyed by the metric, not by unit kind) so
    // that e.g. two percent metrics each get their own scale. Composite series
    // (Mode of Payment split) still share their parent metric's axis.
    visibleDefs.forEach((def) => {
      const key = def.parentId || def.id;
      if (!groups.has(key)) {
        groups.set(key, {
          axisGroup: key,
          unitKind: def.unitKind,
          defs: [],
        });
      }
      groups.get(key).defs.push(def);
    });

    return Array.from(groups.values()).map((group, index) => {
      const highlightedDef =
        group.defs.find(
          (def) => def.id === activeMetricId || def.parentId === activeMetricId,
        ) || group.defs[0];
      const values = processedChartData.flatMap((point) =>
        group.defs.map((def) => point[def.id]),
      );

      return {
        ...group,
        color: highlightedDef.color,
        // Alternate sides so a 3rd axis lands on the left instead of stacking a
        // second axis on the right (where it was being clipped and hidden).
        orientation: index % 2 === 0 ? "left" : "right",
        domain: computeAxisDomain(values, group.unitKind),
      };
    });
  }, [activeMetricId, processedChartData, visibleDefs]);

  const compareAxisDomain = useMemo(
    () =>
      computeAxisDomain(
        processedChartData.flatMap((point) => [
          point.currentValue,
          point.comparisonValue,
        ]),
        activeDef?.unitKind || "count",
      ),
    [activeDef, processedChartData],
  );

  const shouldTiltDateLabels = processedChartData.length > 30;
  const useBarChart = chartMode === "bar";
  const multiChartTitle = activeDef
    ? `${
        viewMode === "daily"
          ? "Day-wise trend"
          : viewMode === "monthly"
            ? "Month-wise trend"
            : "Hour-wise trend"
      } · ${activeDef.label}`
    : "Trend";

  const selectedLegendEntries = useMemo(
    () =>
      selectedDefs.map((def) => ({
        id: def.id,
        label: def.label,
        color: def.color,
        active: def.id === activeMetricId || def.parentId === activeMetricId,
      })),
    [activeMetricId, selectedDefs],
  );

  const activeAxisGroups = isMobile
    ? axisGroups.filter(
        (group) =>
          group.defs.some(
            (def) => def.id === activeMetricId || def.parentId === activeMetricId,
          ) || axisGroups.length === 1,
      )
    : axisGroups;

  const leftAxisCount = activeAxisGroups.filter(
    (group) => group.orientation === "left",
  ).length;
  const rightAxisCount = activeAxisGroups.length - leftAxisCount;
  // Narrower ticks when a side stacks two axes, so the plot area stays usable.
  const axisWidth = activeAxisGroups.length > 2 ? 58 : 70;
  const chartMarginLeft =
    leftAxisCount > 1 ? 16 : leftAxisCount > 0 ? 12 : 0;
  const chartMarginRight =
    rightAxisCount > 1 ? 16 : rightAxisCount > 0 ? 28 : 12;

  return (
    <Card
      elevation={0}
      sx={{
        borderRadius: isMobile ? 2 : 3,
        height: isMobile ? "auto" : "380px",
        minHeight: isMobile ? "340px" : "380px",
      }}
    >
      <CardContent
        sx={{
          minHeight: 330,
          display: "flex",
          flexDirection: "column",
          px: 2,
          py: 3,
        }}
      >
        <Box
          sx={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            mb: 3,
            gap: 2,
          }}
        >
          <Stack spacing={1}>
            <Typography
              variant="subtitle2"
              color="text.secondary"
              sx={{ fontWeight: 500 }}
            >
              {multiChartTitle}
            </Typography>

            {shouldShowCompare ? (
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
                  onClick={() =>
                    setVisibleRangeLines((prev) =>
                      prev.includes("primary")
                        ? prev.filter((entry) => entry !== "primary")
                        : [...prev, "primary"],
                    )
                  }
                  sx={{ cursor: "pointer", "&:hover": { opacity: 0.8 } }}
                >
                  <Box
                    sx={{
                      width: 14,
                      height: 14,
                      borderRadius: "3px",
                      bgcolor: visibleRangeLines.includes("primary")
                        ? "#10b981"
                        : "transparent",
                      border: "1px solid",
                      borderColor: "#10b981",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    {visibleRangeLines.includes("primary") && (
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
                      color: visibleRangeLines.includes("primary")
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
                    onClick={() =>
                      setVisibleRangeLines((prev) =>
                        prev.includes("comparison")
                          ? prev.filter((entry) => entry !== "comparison")
                          : [...prev, "comparison"],
                      )
                    }
                    sx={{ cursor: "pointer", "&:hover": { opacity: 0.8 } }}
                  >
                    <Box
                      sx={{
                        width: 14,
                        height: 14,
                        borderRadius: "3px",
                        border: "1px solid",
                        borderColor: "#10b981",
                        bgcolor: visibleRangeLines.includes("comparison")
                          ? "#10b981"
                          : "transparent",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      {visibleRangeLines.includes("comparison") && (
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
                        color: visibleRangeLines.includes("comparison")
                          ? "text.secondary"
                          : alpha(theme.palette.text.secondary, 0.5),
                      }}
                    >
                      {rangeLabels.previous}
                    </Typography>
                  </Stack>
                )}
              </Stack>
            ) : (
              <SeriesLegend
                entries={selectedLegendEntries}
                hiddenKeys={hiddenMetricIds}
                onToggle={(metricId) =>
                  setHiddenMetricIds((prev) =>
                    prev.includes(metricId)
                      ? prev.filter((entry) => entry !== metricId)
                      : [...prev, metricId],
                  )
                }
                hoveredKey={hoveredMetric}
                onHover={setHoveredMetric}
              />
            )}
          </Stack>

          <Stack direction="row" spacing={1}>
            <FormControl size="small" sx={{ minWidth: 110 }}>
              <Select
                value={viewMode}
                onChange={(event) => setViewMode(event.target.value)}
                displayEmpty
                inputProps={{ "aria-label": "View mode" }}
                sx={{
                  borderRadius: 2,
                  height: 30,
                  fontSize: 13,
                  fontWeight: 500,
                  bgcolor: alpha(theme.palette.action.active, 0.04),
                  "& .MuiOutlinedInput-notchedOutline": { border: "none" },
                }}
              >
                <MenuItem
                  value="hourly"
                  disabled={
                    isLongRange ||
                    hasPerformanceSelected ||
                    hasActiveProductTypeFilter ||
                    hasIntentSelected ||
                    (hasPaymentCompositeSelected && !canUseHourlyPaymentTrend)
                  }
                >
                  Hourly
                </MenuItem>
                <MenuItem value="daily">Daily</MenuItem>
                {daysInRange >= 30 && <MenuItem value="monthly">Monthly</MenuItem>}
              </Select>
            </FormControl>
            <FormControl size="small" sx={{ minWidth: 100 }}>
              <Select
                value={chartMode}
                onChange={(event) => setChartMode(event.target.value)}
                displayEmpty
                inputProps={{ "aria-label": "Chart mode" }}
                sx={{
                  borderRadius: 2,
                  height: 30,
                  fontSize: 13,
                  fontWeight: 500,
                  bgcolor: alpha(theme.palette.action.active, 0.04),
                  "& .MuiOutlinedInput-notchedOutline": { border: "none" },
                }}
              >
                <MenuItem value="line">Line</MenuItem>
                <MenuItem value="bar" disabled={!canUseBarChart}>
                  Bar
                </MenuItem>
              </Select>
            </FormControl>
          </Stack>
        </Box>

        {loading ? (
          <Skeleton variant="rounded" width="100%" height={270} />
        ) : selectedDefs.length === 0 ? (
          <Box
            sx={{
              flexGrow: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Typography variant="body2" color="text.secondary">
              Select up to 3 KPIs to view the trend.
            </Typography>
          </Box>
        ) : processedChartData.length === 0 ? (
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
          <Box sx={{ width: "100%", height: 270, flexGrow: 1 }}>
            <ResponsiveContainer width="100%" height="100%">
              {useBarChart ? (
                <BarChart
                  data={processedChartData}
                  margin={{
                    top: 24,
                    right: chartMarginRight,
                    left: chartMarginLeft,
                    bottom: shouldTiltDateLabels ? 28 : 5,
                  }}
                  barGap={8}
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
                        ? {
                            fontSize: 10,
                            fill: theme.palette.text.secondary,
                            angle: -24,
                            textAnchor: "end",
                            dy: 8,
                          }
                        : { fontSize: 10, fill: theme.palette.text.secondary }
                    }
                    height={shouldTiltDateLabels ? 42 : undefined}
                  />

                  {shouldShowCompare ? (
                    <YAxis
                      tickLine={false}
                      axisLine={false}
                      tickMargin={8}
                      tickFormatter={activeDef?.compactFormatter}
                      tick={{ fontSize: 12, fill: theme.palette.text.secondary }}
                      width={70}
                      domain={compareAxisDomain}
                    />
                  ) : (
                    activeAxisGroups.map((group) => (
                      <YAxis
                        key={group.axisGroup}
                        yAxisId={group.axisGroup}
                        orientation={group.orientation}
                        tickLine={false}
                        axisLine={false}
                        tickMargin={8}
                        tickFormatter={group.defs[0]?.compactFormatter}
                        tick={{
                          fontSize: 12,
                          fill: group.color,
                          opacity:
                            hoveredMetric &&
                            !group.defs.some((def) => def.id === hoveredMetric)
                              ? 0.4
                              : 1,
                        }}
                        width={axisWidth}
                        domain={group.domain}
                      />
                    ))
                  )}

                  <Tooltip
                    cursor={{ fill: alpha(theme.palette.divider, 0.2) }}
                    content={({ active, label, payload }) => {
                      if (!active || !payload?.length) return null;
                      const point = payload[0]?.payload || {};
                      return (
                        <CustomTooltip
                          active={active}
                          label={label}
                          compareMode={shouldShowCompare}
                          selectedDefs={selectedDefs}
                          rangeLabels={rangeLabels}
                          compareFormatter={
                            activeDef?.formatter || ((value) => String(value ?? 0))
                          }
                          compareValue={point.comparisonValue}
                          currentValue={point.currentValue}
                          metricValues={point}
                          hiddenMetricIds={hiddenMetricIds}
                          visibleRangeLines={visibleRangeLines}
                        />
                      );
                    }}
                  />

                  {shouldShowCompare ? (
                    <>
                      <Bar
                        hide={!visibleRangeLines.includes("comparison")}
                        dataKey="comparisonValue"
                        name={rangeLabels.previous || "Previous"}
                        fill={alpha("#10b981", 0.45)}
                        radius={[4, 4, 0, 0]}
                        maxBarSize={26}
                        onMouseEnter={() => setHoveredMetric("previous")}
                        onMouseLeave={() => setHoveredMetric(null)}
                      />
                      <Bar
                        hide={!visibleRangeLines.includes("primary")}
                        dataKey="currentValue"
                        name={rangeLabels.current || "Current"}
                        fill="#10b981"
                        radius={[4, 4, 0, 0]}
                        maxBarSize={26}
                        onMouseEnter={() => setHoveredMetric("current")}
                        onMouseLeave={() => setHoveredMetric(null)}
                      />
                    </>
                  ) : (
                    visibleDefs.map((def) => {
                      const muted = hoveredMetric && hoveredMetric !== def.id;
                      return (
                        <Bar
                          key={def.id}
                          yAxisId={def.parentId || def.id}
                          dataKey={`${def.id}PrimaryValue`}
                          name={def.label}
                          fill={def.color}
                          radius={[4, 4, 0, 0]}
                          maxBarSize={22}
                          opacity={muted ? 0.28 : 1}
                          animationDuration={180}
                          onMouseEnter={() => setHoveredMetric(def.id)}
                          onMouseLeave={() => setHoveredMetric(null)}
                        />
                      );
                    })
                  )}
                </BarChart>
              ) : (
                <LineChart
                  data={processedChartData}
                  margin={{
                    top: 18,
                    right: chartMarginRight,
                    left: chartMarginLeft,
                    bottom: shouldTiltDateLabels ? 28 : 5,
                  }}
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
                      ? {
                          fontSize: 10,
                          fill: theme.palette.text.secondary,
                          angle: -24,
                          textAnchor: "end",
                          dy: 8,
                        }
                      : { fontSize: 10, fill: theme.palette.text.secondary }
                  }
                  height={shouldTiltDateLabels ? 42 : undefined}
                />

                {shouldShowCompare ? (
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    tickFormatter={activeDef?.compactFormatter}
                    tick={{ fontSize: 12, fill: theme.palette.text.secondary }}
                    width={70}
                    domain={computeAxisDomain(
                      processedChartData.flatMap((point) => [
                        point.currentValue,
                        point.comparisonValue,
                      ]),
                      activeDef?.unitKind || "count",
                    )}
                  />
                ) : (
                  activeAxisGroups.map((group) => (
                    <YAxis
                      key={group.axisGroup}
                      yAxisId={group.axisGroup}
                      orientation={group.orientation}
                      tickLine={false}
                      axisLine={false}
                      tickMargin={8}
                      tickFormatter={group.defs[0]?.compactFormatter}
                      tick={{
                        fontSize: 12,
                        fill: group.color,
                        opacity:
                          hoveredMetric &&
                          !group.defs.some((def) => def.id === hoveredMetric)
                            ? 0.4
                            : 1,
                      }}
                      width={axisWidth}
                      domain={group.domain}
                    />
                  ))
                )}

                <Tooltip
                  cursor={{
                    stroke: theme.palette.divider,
                    strokeWidth: 1,
                    strokeDasharray: "4 4",
                  }}
                  content={({ active, label, payload }) => {
                    if (!active || !payload?.length) return null;
                    const point = payload[0]?.payload || {};
                    return (
                      <CustomTooltip
                        active={active}
                        label={label}
                        compareMode={shouldShowCompare}
                        selectedDefs={selectedDefs}
                        rangeLabels={rangeLabels}
                        compareFormatter={
                          activeDef?.formatter || ((value) => String(value ?? 0))
                        }
                        compareValue={point.comparisonValue}
                        currentValue={point.currentValue}
                        metricValues={point}
                        hiddenMetricIds={hiddenMetricIds}
                        visibleRangeLines={visibleRangeLines}
                      />
                    );
                  }}
                />

                {shouldShowCompare ? (
                  <>
                    <Line
                      type="monotone"
                      hide={!visibleRangeLines.includes("comparison")}
                      dataKey="comparisonValue"
                      name={rangeLabels.previous || "Previous"}
                      stroke={alpha("#10b981", 0.55)}
                      strokeWidth={2}
                      strokeDasharray="6 4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      dot={false}
                      connectNulls={false}
                      activeDot={{ r: 4 }}
                      onMouseEnter={() => setHoveredMetric("previous")}
                      onMouseLeave={() => setHoveredMetric(null)}
                    />
                    <Line
                      type="monotone"
                      hide={!visibleRangeLines.includes("primary")}
                      dataKey="currentPrimaryValue"
                      name={rangeLabels.current || "Current"}
                      stroke="#10b981"
                      strokeWidth={3}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      dot={false}
                      connectNulls={true}
                      activeDot={{ r: 5 }}
                      onMouseEnter={() => setHoveredMetric("current")}
                      onMouseLeave={() => setHoveredMetric(null)}
                    />
                    <Line
                      type="monotone"
                      hide={
                        !visibleRangeLines.includes("primary") || !showHourlyTail
                      }
                      dataKey="currentTailValue"
                      name={`${rangeLabels.current || "Current"} (In progress)`}
                      stroke="#10b981"
                      strokeDasharray="4 4"
                      strokeWidth={3}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      dot={false}
                      connectNulls={false}
                      activeDot={{ r: 5 }}
                      onMouseEnter={() => setHoveredMetric("current")}
                      onMouseLeave={() => setHoveredMetric(null)}
                    />
                  </>
                ) : (
                  visibleDefs.map((def) => {
                    const muted = hoveredMetric && hoveredMetric !== def.id;
                    return (
                      <Fragment key={def.id}>
                        <Line
                          yAxisId={def.parentId || def.id}
                          type="monotone"
                          dataKey={`${def.id}PrimaryValue`}
                          name={def.label}
                          stroke={def.color}
                          strokeWidth={
                            def.id === activeMetricId || def.parentId === activeMetricId
                              ? 3.5
                              : 2.4
                          }
                          strokeDasharray={def.strokeDasharray}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          dot={false}
                          activeDot={{
                            r:
                              def.id === activeMetricId ||
                              def.parentId === activeMetricId
                                ? 5
                                : 4,
                          }}
                          opacity={muted ? 0.28 : 1}
                          connectNulls={true}
                          animationDuration={180}
                          onMouseEnter={() => setHoveredMetric(def.id)}
                          onMouseLeave={() => setHoveredMetric(null)}
                        />
                        <Line
                          yAxisId={def.parentId || def.id}
                          type="monotone"
                          dataKey={`${def.id}PrimaryTailValue`}
                          name={`${def.label} (In progress)`}
                          stroke={def.color}
                          strokeWidth={
                            def.id === activeMetricId || def.parentId === activeMetricId
                              ? 3.5
                              : 2.4
                          }
                          strokeDasharray="4 4"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          dot={false}
                          activeDot={{
                            r:
                              def.id === activeMetricId ||
                              def.parentId === activeMetricId
                                ? 5
                                : 4,
                          }}
                          opacity={muted ? 0.28 : 1}
                          connectNulls={false}
                          animationDuration={180}
                          hide={!showHourlyTail}
                          onMouseEnter={() => setHoveredMetric(def.id)}
                          onMouseLeave={() => setHoveredMetric(null)}
                        />
                      </Fragment>
                    );
                  })
                )}
                </LineChart>
              )}
            </ResponsiveContainer>
          </Box>
        )}
      </CardContent>
    </Card>
  );
});

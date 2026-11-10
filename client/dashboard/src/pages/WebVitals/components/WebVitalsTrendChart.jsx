import { useMemo, useState } from "react";
import {
  Box,
  Card,
  FormControl,
  MenuItem,
  Select,
  Skeleton,
  Stack,
  Typography,
  useTheme,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
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
import { METRIC_DEFS, trendAxis, trendTitle } from "../webVitalsFormat.js";
import { FunnelRangeOrDatePicker } from "../../../components/DailyFunnelPanel.jsx";

const ALL_PAGES = "__all__";

function ChartTooltip({ active, label, payload, def }) {
  if (!active || !Array.isArray(payload) || payload.length === 0) return null;
  const value = payload[0]?.value;
  if (value === null || value === undefined) return null;
  return (
    <Box
      sx={{
        bgcolor: "background.paper",
        border: "1px solid",
        borderColor: "divider",
        borderRadius: 2,
        boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
        p: 1.25,
        minWidth: 140,
      }}
    >
      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 0.5, fontWeight: 600 }}>
        {label}
      </Typography>
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
        <Box sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: def.color }} />
        <Typography variant="caption" sx={{ flex: 1 }}>
          {def.shortLabel}
        </Typography>
        <Typography variant="caption" sx={{ fontWeight: 600 }}>
          {def.format(value)}
        </Typography>
      </Box>
    </Box>
  );
}

// The daily trend of one metric (picked with the KPI cards) for the whole brand or one page (picked here or by
// clicking a row of the table below).
export default function WebVitalsTrendChart({
  points,
  loading,
  rangeStart,
  rangeEnd,
  onRangeChange,
  metricId = "performance",
  pageOptions = [],
  selectedPageUrl = null,
  onSelectPage = () => {},
}) {
  const theme = useTheme();
  const [chartMode, setChartMode] = useState("bar");
  const def = METRIC_DEFS[metricId] || METRIC_DEFS.performance;

  const gridStroke = alpha(theme.palette.divider, 0.5);
  const tickStyle = { fontSize: 10, fill: theme.palette.text.secondary };

  const selectedPage = pageOptions.find((option) => option.url === selectedPageUrl) || null;
  // a page picked from the table can be missing from the list for another date: keep it selectable
  const options = selectedPageUrl && !selectedPage ? [{ url: selectedPageUrl, label: selectedPageUrl }, ...pageOptions] : pageOptions;
  const pageLabel = (selectedPage || options.find((option) => option.url === selectedPageUrl))?.label || null;

  const hasValues = useMemo(() => points.some((point) => point[metricId] !== null && point[metricId] !== undefined), [points, metricId]);
  const axis = useMemo(() => trendAxis(metricId, points.map((point) => point[metricId])), [points, metricId]);
  const yAxisProps = {
    domain: axis.domain,
    tickLine: false,
    axisLine: false,
    tickMargin: 8,
    tick: { fontSize: 12, fill: theme.palette.text.secondary },
    width: metricId === "performance" ? 32 : 44,
    tickFormatter: metricId === "performance" ? undefined : (value) => def.format(value),
  };
  const xAxis = <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={12} tick={tickStyle} />;
  const margin = { top: 18, right: 12, left: 0, bottom: 5 };

  const emptyMessage = selectedPageUrl
    ? "No history for this page in the selected range."
    : "No web vitals data for this range.";

  return (
    <Card variant="outlined" sx={{ p: 2.5 }}>
      <Stack
        direction={{ xs: "column", md: "row" }}
        alignItems={{ xs: "flex-start", md: "center" }}
        justifyContent="space-between"
        spacing={1.5}
        sx={{ mb: 2 }}
      >
        <Typography variant="h6" sx={{ fontWeight: 600, minWidth: 0, wordBreak: "break-word" }}>
          {trendTitle(metricId, pageLabel)}
        </Typography>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <FormControl size="small" sx={{ minWidth: 160, maxWidth: 260 }}>
            <Select
              value={selectedPageUrl || ALL_PAGES}
              onChange={(event) => onSelectPage(event.target.value === ALL_PAGES ? null : event.target.value)}
              inputProps={{ "aria-label": "Page" }}
              MenuProps={{ PaperProps: { sx: { maxWidth: 360 } } }}
            >
              <MenuItem value={ALL_PAGES}>All pages (brand average)</MenuItem>
              {options.map((option) => (
                <MenuItem key={option.url} value={option.url} sx={{ whiteSpace: "normal", wordBreak: "break-word" }}>
                  {option.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ minWidth: 90 }}>
            <Select
              value={chartMode}
              onChange={(event) => setChartMode(event.target.value)}
              inputProps={{ "aria-label": "Chart type" }}
            >
              <MenuItem value="line">Line</MenuItem>
              <MenuItem value="bar">Bar</MenuItem>
            </Select>
          </FormControl>
          <FunnelRangeOrDatePicker
            compact
            startDate={rangeStart}
            endDate={rangeEnd}
            onApply={onRangeChange}
          />
        </Stack>
      </Stack>

      <Box sx={{ height: 300 }}>
        {loading ? (
          <Skeleton variant="rounded" width="100%" height="100%" />
        ) : !points.length || !hasValues ? (
          <Box sx={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Typography variant="body2" color="text.secondary">
              {emptyMessage}
            </Typography>
          </Box>
        ) : chartMode === "bar" ? (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={points} margin={margin}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" stroke={gridStroke} />
              {xAxis}
              <YAxis {...yAxisProps} />
              <Tooltip
                cursor={{ fill: alpha(theme.palette.divider, 0.2) }}
                content={(props) => <ChartTooltip {...props} def={def} />}
              />
              <Bar
                dataKey={metricId}
                name={def.label}
                fill={def.color}
                radius={[4, 4, 0, 0]}
                maxBarSize={26}
                animationDuration={180}
              />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={points} margin={margin}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" stroke={gridStroke} />
              {xAxis}
              <YAxis {...yAxisProps} />
              <Tooltip
                cursor={{ stroke: theme.palette.divider, strokeWidth: 1, strokeDasharray: "4 4" }}
                content={(props) => <ChartTooltip {...props} def={def} />}
              />
              <Line
                type="monotone"
                dataKey={metricId}
                name={def.label}
                stroke={def.color}
                strokeWidth={3}
                strokeLinecap="round"
                strokeLinejoin="round"
                dot={{ r: 3 }}
                activeDot={{ r: 5 }}
                connectNulls={false}
                animationDuration={180}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </Box>
    </Card>
  );
}

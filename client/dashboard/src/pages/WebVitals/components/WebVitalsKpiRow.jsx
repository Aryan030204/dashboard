import { Box, Card, Skeleton, Typography } from "@mui/material";
import TrendingUpIcon from "@mui/icons-material/TrendingUp";
import TrendingDownIcon from "@mui/icons-material/TrendingDown";
import { METRIC_DEFS, METRIC_ORDER, getStatusMeta } from "../webVitalsFormat.js";

const GOOD_COLOR = "#10b981";
const BAD_COLOR = "#ef4444";

function KpiCard({ metricId, current, previous, loading, selected, onSelect }) {
  const def = METRIC_DEFS[metricId];
  const value = current?.value ?? null;
  const previousValue = previous?.value ?? null;
  const statusMeta = getStatusMeta(current?.status, metricId);

  const hasDelta = value !== null && previousValue !== null;
  const diff = hasDelta ? value - previousValue : null;
  const direction = !hasDelta || diff === 0 ? "flat" : diff > 0 ? "up" : "down";
  const isImprovement =
    hasDelta && diff !== 0
      ? def.higherIsBetter
        ? diff > 0
        : diff < 0
      : null;
  const deltaColor =
    isImprovement === null ? "text.secondary" : isImprovement ? GOOD_COLOR : BAD_COLOR;

  return (
    <Card
      variant="outlined"
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`Show the ${def.label} trend`}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      sx={{
        p: 2,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        gap: 0.75,
        cursor: "pointer",
        borderColor: selected ? GOOD_COLOR : undefined,
        boxShadow: selected ? `0 0 0 1px ${GOOD_COLOR}, 0 0 14px rgba(16, 185, 129, 0.25)` : "none",
        transition: "border-color 0.15s, box-shadow 0.15s",
        "&:hover": { borderColor: selected ? GOOD_COLOR : "text.secondary" },
        "&:focus-visible": { outline: `2px solid ${GOOD_COLOR}`, outlineOffset: 2 },
      }}
    >
      <Typography
        variant="body2"
        color="text.secondary"
        sx={{ fontWeight: 500, minHeight: "2.5em", lineHeight: 1.25 }}
      >
        {def.label}
      </Typography>

      {loading ? (
        <Skeleton variant="text" width={80} height={40} />
      ) : (
        <Typography variant="h5" sx={{ fontWeight: 700 }}>
          {def.format(value)}
          {metricId === "performance" && value !== null ? (
            <Typography component="span" variant="body2" color="text.secondary" sx={{ ml: 0.5 }}>
              /100
            </Typography>
          ) : null}
        </Typography>
      )}

      {statusMeta ? (
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
          <Box
            sx={{
              width: 8,
              height: 8,
              borderRadius: "999px",
              bgcolor: statusMeta.color,
              flexShrink: 0,
            }}
          />
          <Typography variant="caption" sx={{ color: statusMeta.color, fontWeight: 600 }}>
            {statusMeta.label}
          </Typography>
        </Box>
      ) : (
        <Typography variant="caption" color="text.secondary">
          No data
        </Typography>
      )}

      {hasDelta ? (
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.4, mt: 0.25 }}>
          {direction === "up" ? (
            <TrendingUpIcon sx={{ fontSize: 15, color: deltaColor }} />
          ) : direction === "down" ? (
            <TrendingDownIcon sx={{ fontSize: 15, color: deltaColor }} />
          ) : null}
          <Typography variant="caption" sx={{ color: deltaColor, fontWeight: 600 }}>
            {def.formatDelta(diff)} vs yesterday
          </Typography>
        </Box>
      ) : (
        <Typography variant="caption" color="text.secondary" sx={{ mt: 0.25 }}>
          No comparison available
        </Typography>
      )}
    </Card>
  );
}

export default function WebVitalsKpiRow({ snapshot, loading, selectedMetric = "performance", onSelectMetric = () => {} }) {
  const metrics = snapshot?.metrics || {};
  const previousMetrics = snapshot?.previousMetrics || {};

  return (
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: {
          xs: "repeat(2, 1fr)",
          sm: "repeat(3, 1fr)",
          md: "repeat(6, 1fr)",
        },
        gap: 1.5,
      }}
    >
      {METRIC_ORDER.map((metricId) => (
        <KpiCard
          key={metricId}
          metricId={metricId}
          current={metrics[metricId]}
          previous={previousMetrics[metricId]}
          loading={loading}
          selected={metricId === selectedMetric}
          onSelect={() => onSelectMetric(metricId)}
        />
      ))}
    </Box>
  );
}

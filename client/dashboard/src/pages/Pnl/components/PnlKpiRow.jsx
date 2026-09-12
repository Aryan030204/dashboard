import { Box, Card, Skeleton, Typography } from "@mui/material";
import TrendingUpIcon from "@mui/icons-material/TrendingUp";
import TrendingDownIcon from "@mui/icons-material/TrendingDown";
import { KPI_DEFS, KPI_ORDER, formatPercent, formatSignedPercent, formatSignedPoints } from "../pnlFormat.js";

const GOOD_COLOR = "#10b981";
const BAD_COLOR = "#ef4444";

function KpiCard({ metricId, kpi, loading, formatAmount }) {
  const def = KPI_DEFS[metricId];
  const value = kpi?.value ?? null;
  const isCurrency = def.type === "currency";
  const delta = isCurrency ? kpi?.changePct : kpi?.changePp;
  const hasDelta = delta !== null && delta !== undefined && !Number.isNaN(delta);
  const direction = !hasDelta || delta === 0 ? "flat" : delta > 0 ? "up" : "down";
  const deltaColor = !hasDelta || delta === 0 ? "text.secondary" : delta > 0 ? GOOD_COLOR : BAD_COLOR;

  return (
    <Card
      variant="outlined"
      sx={{ p: 2, height: "100%", display: "flex", flexDirection: "column", gap: 0.75 }}
    >
      <Typography variant="body2" color="text.secondary" sx={{ fontWeight: 500 }}>
        {def.label}
      </Typography>

      {loading ? (
        <Skeleton variant="text" width={100} height={40} />
      ) : (
        <Typography variant="h5" sx={{ fontWeight: 700 }}>
          {value === null ? "—" : isCurrency ? formatAmount(value) : formatPercent(value)}
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
            {isCurrency ? formatSignedPercent(delta) : formatSignedPoints(delta)} vs previous period
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

export default function PnlKpiRow({ kpis, loading, formatAmount }) {
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
      {KPI_ORDER.map((metricId) => (
        <KpiCard
          key={metricId}
          metricId={metricId}
          kpi={kpis?.[metricId]}
          loading={loading}
          formatAmount={formatAmount}
        />
      ))}
    </Box>
  );
}

import { Box, Typography, useTheme } from "@mui/material";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { SectionCard } from "./shared.jsx";
import {
  INTENT_COLORS,
  INTENT_LABELS,
  formatCount,
  formatPct,
} from "./intentFunnelUtils.js";

const SCORE_INFO =
  "Share of scored users classified as high, medium or low intent by score percentile. Sessions that are still being scored or were excluded are not included.";
const BEHAVIOR_INFO =
  "Share of sessions by what the visitor did. Low: under 5 seconds, or no clicks and no scrolls. Medium: over 5 seconds with some interaction. High: over 5 seconds with clicks and a product view, add to cart or checkout. Every closed session is counted; bots are left out.";

// `metric` picks what the donut counts: "users" (score basis) or "sessions" (behaviour basis).
export default function IntentDistributionDonut({ distribution, metric = "users", basis = "score" }) {
  const theme = useTheme();
  const bySessions = metric === "sessions";
  const items = distribution?.items || [];
  const total = (bySessions ? distribution?.totalSessions : distribution?.total) || 0;
  const valueKey = bySessions ? "sessions" : "users";
  const pctKey = bySessions ? "sessionsPct" : "pct";
  const botsExcluded = distribution?.botsExcluded || 0;

  return (
    <SectionCard
      title="Intent Distribution"
      info={basis === "behavior" ? BEHAVIOR_INFO : SCORE_INFO}
    >
      <Box
        sx={{
          display: "flex",
          flexDirection: { xs: "column", sm: "row", lg: "column", xl: "row" },
          alignItems: "center",
          justifyContent: "center",
          gap: 2,
        }}
      >
        <Box sx={{ position: "relative", width: 190, height: 190, flexShrink: 0 }}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={items}
                dataKey={valueKey}
                nameKey="level"
                innerRadius={58}
                outerRadius={88}
                paddingAngle={1}
                stroke="none"
              >
                {items.map((item) => (
                  <Cell key={item.level} fill={INTENT_COLORS[item.level]} />
                ))}
              </Pie>
              <Tooltip
                formatter={(value, name) => [
                  formatCount(value),
                  INTENT_LABELS[name] || name,
                ]}
                contentStyle={{
                  background: theme.palette.background.paper,
                  border: `1px solid ${theme.palette.divider}`,
                  borderRadius: 8,
                  fontSize: 12,
                }}
              />
            </PieChart>
          </ResponsiveContainer>
          <Box
            sx={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              pointerEvents: "none",
            }}
          >
            <Typography sx={{ fontWeight: 700, fontSize: 20, lineHeight: 1.1 }}>
              {formatCount(total)}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {bySessions ? "Sessions" : "Users"}
            </Typography>
          </Box>
        </Box>
        <Box sx={{ display: "flex", flexDirection: "column", gap: 1.25 }}>
          {items.map((item) => (
            <Box
              key={item.level}
              sx={{ display: "flex", gap: 1, alignItems: "flex-start" }}
            >
              <Box
                sx={{
                  width: 10,
                  height: 10,
                  mt: 0.6,
                  borderRadius: "50%",
                  bgcolor: INTENT_COLORS[item.level],
                  flexShrink: 0,
                }}
              />
              <Box>
                <Typography variant="body2" sx={{ lineHeight: 1.2 }}>
                  {INTENT_LABELS[item.level]}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {formatCount(item[valueKey])} ({formatPct(item[pctKey])})
                </Typography>
              </Box>
            </Box>
          ))}
          {bySessions && botsExcluded > 0 ? (
            <Typography variant="caption" color="text.secondary">
              {formatCount(botsExcluded)} bot sessions excluded
            </Typography>
          ) : null}
        </Box>
      </Box>
    </SectionCard>
  );
}

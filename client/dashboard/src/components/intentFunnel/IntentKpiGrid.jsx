import { useState } from "react";
import { Box, Card, Tooltip, Typography, useTheme } from "@mui/material";
import { alpha } from "@mui/material/styles";
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  CreditCard,
  Eye,
  Gauge,
  LayoutGrid,
  ShoppingCart,
  Target,
  TrendingUp,
  Users,
} from "lucide-react";
import {
  INTENT_COLORS,
  formatCount,
  toneBackground,
} from "./intentFunnelUtils.js";

const KPI_ICONS = {
  visitors: Users,
  high: Target,
  medium: Gauge,
  low: TrendingUp,
  productViews: Eye,
  pageViews: LayoutGrid,
  addToCart: ShoppingCart,
  checkouts: CreditCard,
};

function DeltaLine({ delta }) {
  if (delta == null || !Number.isFinite(delta)) {
    return (
      <Typography variant="caption" color="text.secondary">
        No previous data
      </Typography>
    );
  }
  const positive = delta >= 0;
  const Icon = positive ? ArrowUpRight : ArrowDownRight;
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, flexWrap: "wrap" }}>
      <Box
        sx={{
          display: "inline-flex",
          alignItems: "center",
          gap: 0.25,
          color: positive ? "success.main" : "error.main",
          fontWeight: 600,
          fontSize: 12,
        }}
      >
        <Icon size={14} />
        {Math.abs(delta).toFixed(1)}%
      </Box>
      <Typography variant="caption" color="text.secondary">
        vs previous period
      </Typography>
    </Box>
  );
}

// Small U / S pill shown on every card, same look as the Dashboard KPI toggle.
function ModeToggle({ mode, onChange }) {
  const options = [
    { value: "U", title: "Users" },
    { value: "S", title: "Sessions" },
  ];
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        bgcolor: "background.default",
        borderRadius: 12,
        p: 0.375,
        border: "1px solid",
        borderColor: "divider",
        boxShadow: "inset 0 1px 3px rgba(0,0,0,0.1)",
        flexShrink: 0,
      }}
    >
      {options.map((option) => {
        const active = mode === option.value;
        return (
          <Tooltip key={option.value} title={option.title} arrow>
            <Box
              component="button"
              type="button"
              aria-pressed={active}
              aria-label={option.title}
              onClick={() => onChange(option.value)}
              sx={{
                px: 0.875,
                py: 0.125,
                borderRadius: 10,
                border: 0,
                cursor: "pointer",
                fontSize: "0.65rem",
                fontWeight: 600,
                lineHeight: 1.4,
                bgcolor: active ? "primary.main" : "transparent",
                color: active ? "primary.contrastText" : "text.secondary",
              }}
            >
              {option.value}
            </Box>
          </Tooltip>
        );
      })}
    </Box>
  );
}

// Sessions that started in the period (every visit counts from its first event), shown across the
// full width above the other cards. The cards below only count sessions that have already closed.
function SessionsStartedCard({ sessions }) {
  return (
    <Card sx={{ p: { xs: 1.25, md: 1.75 }, minWidth: 0, gridColumn: "1 / -1" }}>
      <Box
        sx={{
          display: "flex",
          flexDirection: { xs: "column", sm: "row" },
          alignItems: { xs: "flex-start", sm: "center" },
          justifyContent: "space-between",
          gap: { xs: 0.75, sm: 2 },
        }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 0.5 }}>
            <Box sx={{ color: "primary.main", display: "inline-flex", flexShrink: 0 }}>
              <Activity size={18} />
            </Box>
            <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.2 }}>
              {sessions.label}
            </Typography>
          </Box>
          <Typography sx={{ fontSize: { xs: 24, md: 30 }, fontWeight: 700, lineHeight: 1.2, mb: 0.5 }}>
            {formatCount(sessions.value)}
          </Typography>
          <DeltaLine delta={sessions.delta} />
        </Box>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ maxWidth: { sm: 360 }, textAlign: { xs: "left", sm: "right" } }}
        >
          Every visit counts from its first page view. Analysed: {formatCount(sessions.closed)} finished
          {sessions.live != null ? ` + ${formatCount(sessions.live)} live (counted at their current level)` : ""}
          {sessions.other > 0 ? ` · ${formatCount(sessions.other)} not yet analysed or without a visitor id` : ""}.
          {" "}Covered: {(sessions.coveredPct ?? sessions.closedPct).toFixed(1)}%.
        </Typography>
      </Box>
    </Card>
  );
}

export default function IntentKpiGrid({ kpis = [], sessionsStarted = null }) {
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const [modes, setModes] = useState({});

  return (
    <Box
      sx={{
        display: "grid",
        gap: { xs: 1, md: 1.5 },
        gridTemplateColumns: {
          xs: "repeat(2, minmax(0, 1fr))",
          md: "repeat(4, minmax(0, 1fr))",
        },
      }}
    >
      {sessionsStarted ? <SessionsStartedCard sessions={sessionsStarted} /> : null}
      {kpis.map((kpi) => {
        const Icon = KPI_ICONS[kpi.id] || Users;
        const accent = INTENT_COLORS[kpi.tone] || theme.palette.primary.main;
        const mode = modes[kpi.id] || "U";
        const isSessions = mode === "S";
        return (
          <Card
            key={kpi.id}
            sx={{
              p: { xs: 1.25, md: 1.75 },
              minWidth: 0,
              position: "relative",
              // Tint is layered over the theme's card background so the glass
              // look is kept in dark mode.
              ...(kpi.tone !== "neutral"
                ? {
                    borderColor: alpha(accent, 0.45),
                    backgroundImage: `linear-gradient(${toneBackground(kpi.tone, isDark)}, ${toneBackground(kpi.tone, isDark)})`,
                  }
                : {}),
            }}
          >
            <Box
              sx={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                flexWrap: { xs: "wrap", sm: "nowrap" },
                gap: { xs: 0.5, md: 1 },
                mb: 0.75,
              }}
            >
              <Box
                sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 0 }}
              >
                <Box sx={{ color: accent, display: "inline-flex", flexShrink: 0 }}>
                  <Icon size={18} />
                </Box>
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{ lineHeight: 1.2, minWidth: 0, fontSize: { xs: 12, md: 14 }, overflowWrap: "anywhere" }}
                >
                  {kpi.label}
                </Typography>
              </Box>
              <ModeToggle
                mode={mode}
                onChange={(next) =>
                  setModes((prev) => ({ ...prev, [kpi.id]: next }))
                }
              />
            </Box>
            <Typography
              sx={{
                fontSize: { xs: 22, md: 28 },
                fontWeight: 700,
                lineHeight: 1.2,
                mb: 0.5,
              }}
            >
              {formatCount(isSessions ? kpi.sessions : kpi.value)}
            </Typography>
            <DeltaLine delta={isSessions ? kpi.sessionsDelta : kpi.delta} />
          </Card>
        );
      })}
    </Box>
  );
}

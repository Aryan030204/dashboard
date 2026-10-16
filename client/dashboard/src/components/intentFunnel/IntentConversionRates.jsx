import { Box, Typography, useTheme } from "@mui/material";
import { alpha } from "@mui/material/styles";
import { Gauge, Target, TrendingUp } from "lucide-react";
import { SectionCard } from "./shared.jsx";
import {
  INTENT_COLORS,
  INTENT_LABELS,
  formatCount,
  formatPct,
} from "./intentFunnelUtils.js";

const ICONS = { high: Target, medium: Gauge, low: TrendingUp };

export default function IntentConversionRates({ conversionRates = [] }) {
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";

  return (
    <SectionCard
      title="Intent Conversion Rates"
      info="Share of scored users in each intent level who reached checkout."
    >
      <Box sx={{ display: "flex", flexDirection: "column", gap: 1.25 }}>
        {conversionRates.map((row) => {
          const color = INTENT_COLORS[row.level];
          const Icon = ICONS[row.level];
          return (
            <Box
              key={row.level}
              sx={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1.2fr) auto minmax(0, 1fr)",
                alignItems: "center",
                gap: 1.5,
                p: 1.25,
                borderRadius: 1.5,
                border: "1px solid",
                borderColor: alpha(color, 0.3),
                bgcolor: alpha(color, isDark ? 0.14 : 0.08),
              }}
            >
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 0.75,
                  color,
                  minWidth: 0,
                }}
              >
                <Icon size={18} />
                <Typography variant="body2" sx={{ color, fontWeight: 600 }}>
                  {INTENT_LABELS[row.level]}
                </Typography>
              </Box>
              <Typography
                sx={{ color, fontWeight: 700, fontSize: { xs: 20, md: 24 } }}
              >
                {formatPct(row.rate)}
              </Typography>
              <Box sx={{ textAlign: "right" }}>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  {formatCount(row.users)} → {formatCount(row.checkouts)}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Users → Checkouts
                </Typography>
              </Box>
            </Box>
          );
        })}
      </Box>
    </SectionCard>
  );
}

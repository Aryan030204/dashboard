import { Box, Typography, useTheme } from "@mui/material";
import { alpha } from "@mui/material/styles";
import { SectionCard } from "./shared.jsx";
import { STEP_COLORS, formatCount, formatPct } from "./intentFunnelUtils.js";

const STEP_COLOR_BY_ID = {
  product_views: STEP_COLORS.productViews,
  add_to_cart: STEP_COLORS.addToCart,
  checkouts: STEP_COLORS.checkouts,
};

export default function IntentFunnelBars({ funnel = [] }) {
  const theme = useTheme();
  const max = Math.max(1, ...funnel.map((step) => step.users));

  return (
    <SectionCard
      sx={{ borderRadius: "8px" }}
      title="Intent Funnel"
      info="Users progressing from product views to add to cart to checkout. Percentages are relative to Product Views."
    >
      <Box sx={{ display: "flex", flexDirection: "column", gap: 2, pt: 0.5 }}>
        {funnel.map((step) => {
          const color = STEP_COLOR_BY_ID[step.id] || theme.palette.primary.main;
          const width = Math.max(4, (step.users / max) * 100);
          return (
            <Box
              key={step.id}
              sx={{
                display: "grid",
                gridTemplateColumns: {
                  xs: "84px minmax(0, 1fr) 64px",
                  sm: "110px minmax(0, 1fr) 72px",
                },
                alignItems: "center",
                gap: { xs: 1, sm: 1.5 },
              }}
            >
              <Typography variant="body2" sx={{ textAlign: "right" }}>
                {step.label}
              </Typography>
              <Box
                sx={{
                  height: 34,
                  borderRadius: 1,
                  bgcolor: alpha(theme.palette.text.primary, 0.05),
                  overflow: "hidden",
                }}
              >
                <Box
                  sx={{
                    height: "100%",
                    width: `${width}%`,
                    bgcolor: color,
                    borderRadius: 1,
                    transition: "width 0.4s ease",
                  }}
                />
              </Box>
              <Box sx={{ textAlign: "right" }}>
                <Typography variant="body2" sx={{ fontWeight: 700 }}>
                  {formatCount(step.users)}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {formatPct(step.pct)}
                </Typography>
              </Box>
            </Box>
          );
        })}
      </Box>
    </SectionCard>
  );
}

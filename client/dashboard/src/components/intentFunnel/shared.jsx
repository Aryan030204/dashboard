import { Box, Card, Tooltip, Typography } from "@mui/material";
import { Info } from "lucide-react";

// Uses MUI Card so the app theme's glass / depth styling applies in dark mode
// (same as the Web Vitals panel). The hover lift is disabled for large cards.
export function SectionCard({ title, subtitle, info, action, children, sx = {} }) {
  return (
    <Card
      sx={{
        p: { xs: 1.5, md: 2 },
        height: "100%",
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        "&:hover": { transform: "none" },
        ...sx,
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 1,
          mb: 1.5,
        }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, minWidth: 0 }}>
            <Typography
              variant="subtitle1"
              sx={{ fontWeight: 700, fontSize: { xs: "0.95rem", sm: "1rem" }, lineHeight: 1.3 }}
            >
              {title}
            </Typography>
            {info && (
              <Tooltip title={info} arrow>
                <Box
                  component="span"
                  sx={{ display: "inline-flex", color: "text.secondary" }}
                >
                  <Info size={14} />
                </Box>
              </Tooltip>
            )}
          </Box>
          {subtitle ? (
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", lineHeight: 1.3 }}>
              {subtitle}
            </Typography>
          ) : null}
        </Box>
        {action ? <Box sx={{ minWidth: 0, maxWidth: "100%" }}>{action}</Box> : null}
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>{children}</Box>
    </Card>
  );
}

import { Box, Tooltip } from "@mui/material";
import { Info } from "lucide-react";

// Section container for the Intent Funnel page. Presentation only: same props as before
// (title, subtitle, info tooltip, header action, sx). Uses the shared "dz-panel" look.
export function SectionCard({ title, subtitle, info, action, children, sx = {} }) {
  return (
    <Box
      component="section"
      className="dz-panel"
      sx={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        ...sx,
      }}
    >
      <div className="dz-ph">
        <div style={{ minWidth: 0 }}>
          <h2 className="dz-pt" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {title}
            {info && (
              <Tooltip title={info} arrow>
                <Box component="span" sx={{ display: "inline-flex", color: "text.secondary" }}>
                  <Info size={14} />
                </Box>
              </Tooltip>
            )}
          </h2>
          {subtitle ? <p className="dz-ps">{subtitle}</p> : null}
        </div>
        {action ? <div style={{ minWidth: 0, maxWidth: "100%" }}>{action}</div> : null}
      </div>
      <div className="dz-pb" style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </Box>
  );
}

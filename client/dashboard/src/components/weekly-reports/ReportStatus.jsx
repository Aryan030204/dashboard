import { Box, Chip, LinearProgress, Typography } from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import CheckIcon from "@mui/icons-material/Check";
import { PROCESSING_STEPS, STATUS_META, processingInfo } from "./reportUi.js";

// Tonal chip: tinted background + readable text in both light and dark themes, instead of the
// solid filled colors that clashed with the dark surfaces.
export function StatusChip({ status }) {
  const theme = useTheme();
  const meta = STATUS_META[status] || { label: status, color: "default" };
  const palette = meta.color === "default" ? null : theme.palette[meta.color];
  const base = palette ? palette.main : theme.palette.text.secondary;
  const text = palette ? (theme.palette.mode === "dark" ? palette.light : palette.dark) : theme.palette.text.secondary;
  return (
    <Chip
      size="small"
      label={meta.label}
      sx={{
        fontWeight: 600,
        color: text,
        bgcolor: alpha(base, theme.palette.mode === "dark" ? 0.18 : 0.12),
        border: `1px solid ${alpha(base, 0.4)}`,
      }}
    />
  );
}

// Step trail + live counts for a report that is still processing.
function ProcessingProgress({ report }) {
  const theme = useTheme();
  const info = processingInfo(report);
  return (
    <Box sx={{ mt: 1, minWidth: 0 }} aria-live="polite">
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, flexWrap: "wrap", mb: 0.75 }}>
        {PROCESSING_STEPS.map((step, i) => {
          const done = i < info.stepIndex;
          const active = i === info.stepIndex;
          return (
            <Box key={step.id} sx={{ display: "inline-flex", alignItems: "center", gap: 0.5 }}>
              <Box
                sx={{
                  width: 18, height: 18, borderRadius: "50%", display: "grid", placeItems: "center", fontSize: 11, fontWeight: 700,
                  color: done || active ? theme.palette.primary.contrastText : theme.palette.text.secondary,
                  bgcolor: done || active ? theme.palette.primary.main : "transparent",
                  border: `1px solid ${done || active ? theme.palette.primary.main : theme.palette.divider}`,
                }}
              >
                {done ? <CheckIcon sx={{ fontSize: 12 }} /> : i + 1}
              </Box>
              <Typography variant="caption" sx={{ color: active ? "text.primary" : "text.secondary", fontWeight: active ? 700 : 400 }}>
                {step.label}
              </Typography>
              {i < PROCESSING_STEPS.length - 1 && (
                <Box sx={{ width: 14, height: 1, bgcolor: "divider", mx: 0.25 }} />
              )}
            </Box>
          );
        })}
      </Box>

      <Typography variant="body2" sx={{ fontWeight: 600, color: "text.primary" }}>{info.title}</Typography>
      <Typography variant="caption" sx={{ color: "text.secondary" }}>{info.detail}</Typography>
      <LinearProgress
        variant={info.percent === null ? "indeterminate" : "determinate"}
        value={info.percent ?? 0}
        sx={{ mt: 0.75, height: 6, borderRadius: 3 }}
      />
    </Box>
  );
}

// One place that decides what a report's status line looks like.
export default function ReportStatus({ report }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <StatusChip status={report.status} />
      {report.status === "PROCESSING" && <ProcessingProgress report={report} />}
      {report.status === "FAILED" && (
        <Typography variant="caption" sx={{ display: "block", mt: 0.5, color: "error.main" }}>
          {report.error_detail || "Processing failed. Upload the file again."}
        </Typography>
      )}
      {report.slide_count > 0 && report.status !== "PROCESSING" && report.status !== "FAILED" && (
        <Typography variant="caption" sx={{ display: "block", mt: 0.5, color: "text.secondary" }}>
          {report.slide_count} slides
        </Typography>
      )}
    </Box>
  );
}

import { useEffect, useState } from "react";
import { Box, Button, LinearProgress, Paper, Typography } from "@mui/material";
import { alpha } from "@mui/material/styles";
import PauseIcon from "@mui/icons-material/Pause";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import {
  formatElapsed,
  isFailedStatus,
  isInFlight,
  isLive,
  processingSteps,
} from "../nddSlaFormat.js";

// Live status of one report: one compact card with the headline, a thin progress bar, the four steps inline, and the
// pause / resume / cancel controls. It renders only what the API reports; the page polls while a run is live.
export default function ProcessingStatus({ run, ready, canControl = false, busy = false, onControl, onUploadAgain }) {
  const { steps, percent, indeterminate, headline, detail, paused, cancelled } = processingSteps(run);
  const failed = isFailedStatus(run.status);
  const live = isLive(run);
  const working = isInFlight(run.status) && !paused;
  const [confirmCancel, setConfirmCancel] = useState(false);

  // Seconds this panel has seen the run working in its current state (stops while paused).
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    setSeconds(0);
    if (!working) return undefined;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [run.id, run.status, working]);
  useEffect(() => setConfirmCancel(false), [run.id, run.status, paused]);

  const tone = failed ? "error" : cancelled ? "text" : paused ? "warning" : "primary";
  const dotColor = (theme) => (tone === "text" ? theme.palette.text.disabled : theme.palette[tone].main);

  return (
    <Paper variant="outlined" role="status" aria-live="polite" sx={{ p: { xs: 1.5, md: 2 }, borderColor: failed ? "error.main" : undefined }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.25, flexWrap: "wrap" }}>
        <Box
          sx={{
            width: 10,
            height: 10,
            borderRadius: "50%",
            flexShrink: 0,
            bgcolor: dotColor,
            ...(working ? { animation: "nddPulse 1.4s ease-in-out infinite", "@keyframes nddPulse": { "50%": { opacity: 0.35 } } } : {}),
          }}
        />
        <Box sx={{ flex: 1, minWidth: 180 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 700, lineHeight: 1.3 }}>
            {headline}
            {failed && run.error?.code ? <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 0.75 }}>{run.error.code}</Typography> : null}
          </Typography>
          {detail ? <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>{detail}</Typography> : null}
        </Box>
        {working ? (
          <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: "tabular-nums" }}>{formatElapsed(seconds)}</Typography>
        ) : null}
        {canControl && live && !run.cancelRequested ? (
          <Box sx={{ display: "flex", gap: 0.75, ml: "auto" }}>
            {paused ? (
              <Button size="small" variant="contained" startIcon={<PlayArrowIcon />} disabled={busy} onClick={() => onControl?.("resume")}>Resume</Button>
            ) : (
              <Button size="small" variant="outlined" color="inherit" startIcon={<PauseIcon />} disabled={busy} onClick={() => onControl?.("pause")}>Pause</Button>
            )}
            {confirmCancel ? (
              <>
                <Button size="small" color="error" variant="contained" disabled={busy} onClick={() => onControl?.("cancel")}>Cancel report</Button>
                <Button size="small" color="inherit" disabled={busy} onClick={() => setConfirmCancel(false)}>Keep</Button>
              </>
            ) : (
              <Button size="small" color="error" disabled={busy} onClick={() => setConfirmCancel(true)}>Cancel</Button>
            )}
          </Box>
        ) : null}
      </Box>

      <LinearProgress
        variant={indeterminate && percent < 100 ? "buffer" : "determinate"}
        value={percent}
        valueBuffer={Math.min(100, percent + 12)}
        color={failed ? "error" : paused ? "warning" : "primary"}
        sx={{ height: 4, borderRadius: 2, my: 1.5, bgcolor: (theme) => alpha(theme.palette.text.primary, 0.08), "& .MuiLinearProgress-dashed": { display: "none" } }}
        aria-label="Report processing progress"
        aria-valuenow={percent}
      />

      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr 1fr", sm: "repeat(4, 1fr)" }, gap: 1 }}>
        {steps.map((step) => (
          <Box key={step.id} sx={{ display: "flex", alignItems: "center", gap: 0.75, minWidth: 0 }}>
            <Box
              sx={{
                width: 18,
                height: 18,
                borderRadius: "50%",
                flexShrink: 0,
                display: "grid",
                placeItems: "center",
                fontSize: 11,
                fontWeight: 700,
                color: step.state === "pending" ? "text.disabled" : "common.white",
                bgcolor: (theme) =>
                  step.state === "done" ? theme.palette.success.main
                    : step.state === "error" ? theme.palette.error.main
                      : step.state === "active" ? (paused ? theme.palette.warning.main : theme.palette.primary.main)
                        : alpha(theme.palette.text.primary, 0.1),
              }}
            >
              {step.state === "done" ? "✓" : step.state === "error" ? "!" : step.id + 1}
            </Box>
            <Typography
              variant="caption"
              noWrap
              sx={{ color: step.state === "pending" ? "text.disabled" : "text.primary", fontWeight: step.state === "active" ? 600 : 400 }}
              title={step.label}
            >
              {step.label}
            </Typography>
          </Box>
        ))}
      </Box>

      {failed || cancelled ? (
        <Box sx={{ mt: 1.5 }}>
          {failed && run.error?.detail ? <Typography variant="body2" sx={{ mb: 0.5 }}>{run.error.detail}</Typography> : null}
          <Typography variant="caption" color="text.secondary">
            {ready ? "Showing the last successful data for this report." : "No data is available for this report."}
          </Typography>
          {onUploadAgain ? <Button size="small" sx={{ ml: 1 }} onClick={onUploadAgain}>Upload files again</Button> : null}
        </Box>
      ) : null}
      {!failed && !cancelled && live && ready ? (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1.25 }}>
          A new run is in progress. The last completed data stays visible below until it is ready.
        </Typography>
      ) : null}
    </Paper>
  );
}

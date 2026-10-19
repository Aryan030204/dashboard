import { useCallback, useEffect, useState } from "react";
import { Alert, Box, Button, CircularProgress, Paper, Typography } from "@mui/material";
import SlideshowOutlinedIcon from "@mui/icons-material/SlideshowOutlined";
import { listWeeklyReports } from "../../lib/api.js";
import PresentationViewer from "./PresentationViewer.jsx";
import { describeFailure, formatDate } from "./reportUi.js";

async function fetchState(brandKey) {
  const res = await listWeeklyReports(brandKey);
  if (res.error) return { status: "error", reports: [], error: describeFailure(res, "Could not load the reports.") };
  return { status: "ready", reports: res.data?.reports || [], error: "" };
}

// Non-admin view: the published presentations of the selected brand, preview only. The service
// returns nothing else (no drafts, no history, no internal fields), so there is nothing to hide
// here. There is no download, share, upload or delete control.
export default function PublishedReports({ brandKey }) {
  const [state, setState] = useState({ status: "loading", reports: [], error: "" });
  const [viewing, setViewing] = useState(null);

  const load = useCallback(async () => {
    setState({ status: "loading", reports: [], error: "" });
    setState(await fetchState(brandKey));
  }, [brandKey]);

  useEffect(() => {
    let cancelled = false;
    fetchState(brandKey).then((next) => {
      if (!cancelled) setState(next); // a newer brand selection supersedes this response
    });
    return () => { cancelled = true; };
  }, [brandKey]);

  if (state.status === "loading") {
    return (
      <Paper variant="outlined" sx={{ p: 3, display: "flex", justifyContent: "center" }}>
        <CircularProgress size={24} aria-label="Loading reports" />
      </Paper>
    );
  }

  if (state.status === "error") {
    return (
      <Alert severity="error" action={<Button color="inherit" size="small" onClick={load}>Retry</Button>}>
        {state.error}
      </Alert>
    );
  }

  if (!state.reports.length) {
    return (
      <Paper variant="outlined" sx={{ p: { xs: 3, md: 5 }, textAlign: "center" }}>
        <SlideshowOutlinedIcon sx={{ fontSize: 36, color: "text.secondary", mb: 1 }} />
        <Typography sx={{ color: "text.primary", fontWeight: 600 }}>No presentations yet</Typography>
        <Typography sx={{ color: "text.secondary", fontSize: 14 }}>
          Nothing has been published for {brandKey}. New weekly reports appear here once they are published.
        </Typography>
      </Paper>
    );
  }

  return (
    <>
      <Box sx={{ display: "grid", gap: 1.5, gridTemplateColumns: { xs: "1fr", md: "repeat(2, 1fr)" } }}>
        {state.reports.map((r) => (
          <Paper key={r.id} variant="outlined" sx={{ p: { xs: 2, md: 2.5 }, display: "flex", flexDirection: "column", gap: 1.5 }}>
            <Box sx={{ minWidth: 0 }}>
              <Typography sx={{ color: "text.primary", fontWeight: 700, fontSize: 17, overflowWrap: "anywhere" }}>{r.title}</Typography>
              <Typography sx={{ color: "text.secondary", fontSize: 14 }}>
                {r.reporting_week}
                {r.slide_count ? ` · ${r.slide_count} slides` : ""}
              </Typography>
              <Typography sx={{ color: "text.secondary", fontSize: 13 }}>Published {formatDate(r.published_at)}</Typography>
            </Box>
            <Button
              variant="contained"
              disableElevation
              onClick={() => setViewing(r)}
              disabled={!r.slide_count}
              sx={{ alignSelf: { xs: "stretch", sm: "flex-start" } }}
            >
              Preview
            </Button>
          </Paper>
        ))}
      </Box>
      {viewing && <PresentationViewer brandKey={brandKey} report={viewing} onClose={() => setViewing(null)} />}
    </>
  );
}

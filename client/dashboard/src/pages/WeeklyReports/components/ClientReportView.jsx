import { useState } from "react";
import { Alert, Box, Button, Chip, Paper, Stack, Typography } from "@mui/material";
import { EmptyStateCard, SectionFallback } from "../../../routes/shared/RouteUi.jsx";
import { formatReportDate, formatWeekLabel } from "../weeklyReportsFormat.js";
import { SlideViewerDialog } from "./SlideViewer.jsx";

// The API already returns only published reports to non-admins; the status check just keeps this
// safe if that ever changes. Newest published first.
function publishedReports(reports) {
  return reports
    .filter((report) => !report.status || report.status === "PUBLISHED")
    .sort((a, b) => new Date(b.published_at || 0).getTime() - new Date(a.published_at || 0).getTime());
}

function ReportTile({ report, onPreview }) {
  const week = formatWeekLabel(report.reporting_week);
  const publishedOn = formatReportDate(report.published_at);
  const canPreview = Number(report.slide_count) > 0;

  return (
    <Paper
      variant="outlined"
      sx={{
        p: 2,
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        gap: 2,
        minWidth: 0,
      }}
    >
      <Box sx={{ minWidth: 0 }}>
        <Typography
          variant="subtitle1"
          fontWeight={700}
          color="text.primary"
          title={report.title}
          sx={{
            overflow: "hidden",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflowWrap: "anywhere",
            // Always reserve two lines, so a one-line title does not pull the rows below it up and
            // the week, date and button line up across every tile in the row.
            lineHeight: 1.4,
            minHeight: "2.8em",
          }}
        >
          {report.title}
        </Typography>

        <Box sx={{ mt: 1.25, display: "flex", alignItems: "center", flexWrap: "wrap", columnGap: 1.25, rowGap: 0.75 }}>
          {week && (
            <Chip
              size="small"
              variant="outlined"
              color="primary"
              label={week}
              sx={{ fontWeight: 600, maxWidth: "100%" }}
            />
          )}
          {publishedOn && (
            <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: "nowrap" }}>
              Published {publishedOn}
            </Typography>
          )}
        </Box>
      </Box>
      <Button
        variant="contained"
        disableElevation
        disabled={!canPreview}
        onClick={() => onPreview(report)}
        aria-label={`Preview ${report.title}`}
        sx={{ alignSelf: { xs: "stretch", sm: "flex-start" } }}
      >
        Preview
      </Button>
    </Paper>
  );
}

export default function ClientReportView({ brandKey, reports, loading, error, onRetry }) {
  const [previewReport, setPreviewReport] = useState(null);

  if (loading) return <SectionFallback count={1} height={360} />;

  if (error) {
    return (
      <Alert
        severity="error"
        action={
          <Button color="inherit" size="small" onClick={onRetry}>
            Retry
          </Button>
        }
      >
        {error}
      </Alert>
    );
  }

  const published = publishedReports(reports);
  if (!published.length) {
    return <EmptyStateCard message="No report has been published for this brand yet." />;
  }

  return (
    <Stack spacing={2} sx={{ color: "text.primary" }}>
      <div>
        <Typography variant="h5" fontWeight={700} color="text.primary">
          Weekly Reports
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {published.length} {published.length === 1 ? "presentation" : "presentations"} for {brandKey}
        </Typography>
      </div>

      <Box
        sx={{
          display: "grid",
          gap: 2,
          gridTemplateColumns: {
            xs: "minmax(0, 1fr)",
            sm: "repeat(2, minmax(0, 1fr))",
            lg: "repeat(3, minmax(0, 1fr))",
          },
        }}
      >
        {published.map((report) => (
          <ReportTile key={report.id} report={report} onPreview={setPreviewReport} />
        ))}
      </Box>

      <SlideViewerDialog
        report={previewReport}
        brandKey={brandKey}
        onClose={() => setPreviewReport(null)}
      />
    </Stack>
  );
}

import { Alert, Button, Stack, Typography } from "@mui/material";
import { EmptyStateCard, SectionFallback } from "../../../routes/shared/RouteUi.jsx";
import { formatReportDate, formatWeekLabel } from "../weeklyReportsFormat.js";
import { SlideViewer } from "./SlideViewer.jsx";

function latestPublished(reports) {
  return [...reports].sort(
    (a, b) => new Date(b.published_at || 0).getTime() - new Date(a.published_at || 0).getTime(),
  )[0];
}

export default function ClientReportView({ brandKey, reports, loading, error, onRetry }) {
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

  const latest = latestPublished(reports);
  if (!latest) {
    return <EmptyStateCard message="No report has been published for this brand yet." />;
  }

  const meta = [
    formatWeekLabel(latest.reporting_week),
    latest.published_at ? `published ${formatReportDate(latest.published_at)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Stack spacing={1.5}>
      <div>
        <Typography variant="h5" fontWeight={700}>
          Weekly Reports
        </Typography>
        {meta && (
          <Typography variant="body2" color="text.secondary">
            {meta}
          </Typography>
        )}
      </div>
      <SlideViewer key={latest.id} report={latest} brandKey={brandKey} />
    </Stack>
  );
}

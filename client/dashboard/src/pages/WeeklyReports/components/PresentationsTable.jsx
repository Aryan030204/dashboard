import {
  Alert,
  Box,
  Button,
  Chip,
  LinearProgress,
  Paper,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import {
  formatReportDate,
  formatSlideCount,
  formatWeekLabel,
  getExpiryNote,
  getStageLabel,
  getStatusMeta,
  hasSlides,
} from "../weeklyReportsFormat.js";

function StatusDetail({ report }) {
  if (report.status === "PROCESSING") {
    const total = Number(report.slides_total);
    const done = Number(report.slides_done);
    const determinate = total > 0 && Number.isFinite(done);
    return (
      <Box sx={{ mt: 0.75, minWidth: 140, maxWidth: 200 }}>
        <LinearProgress
          variant={determinate ? "determinate" : "indeterminate"}
          value={determinate ? Math.min(100, Math.round((done / total) * 100)) : undefined}
        />
        <Typography variant="caption" color="text.secondary">
          {getStageLabel(report.stage)}
          {determinate ? ` · ${done} / ${total}` : "…"}
        </Typography>
      </Box>
    );
  }

  if (report.status === "FAILED") {
    return (
      <Typography variant="caption" color="error" sx={{ mt: 0.75, display: "block", maxWidth: 260 }}>
        {report.error_detail || "Conversion failed. Delete it and upload again."}
      </Typography>
    );
  }

  const slides = formatSlideCount(report.slide_count);
  const expiry = getExpiryNote(report);
  return (
    <>
      {slides && (
        <Typography variant="caption" color="text.secondary" sx={{ mt: 0.75, display: "block" }}>
          {slides}
        </Typography>
      )}
      {expiry && (
        <Typography variant="caption" sx={{ color: expiry.color, display: "block" }}>
          {expiry.text}
        </Typography>
      )}
    </>
  );
}

function RowActions({ report, busy, onPreview, onAction }) {
  const { status } = report;
  const canPreview = hasSlides(report);
  return (
    <Stack direction="row" spacing={1} justifyContent="flex-end" flexWrap="wrap" useFlexGap>
      {canPreview && (
        <Button size="small" variant="outlined" disabled={busy} onClick={() => onPreview(report)}>
          Preview
        </Button>
      )}
      {(status === "READY" || status === "UNPUBLISHED") && (
        <Button
          size="small"
          variant="outlined"
          color="success"
          disabled={busy}
          onClick={() => onAction("publish", report)}
        >
          Publish
        </Button>
      )}
      {status === "PUBLISHED" && (
        <Button
          size="small"
          variant="outlined"
          disabled={busy}
          onClick={() => onAction("unpublish", report)}
        >
          Unpublish
        </Button>
      )}
      {status === "PROCESSING" && (
        <Button
          size="small"
          variant="outlined"
          color="inherit"
          disabled={busy}
          onClick={() => onAction("cancel", report)}
        >
          Cancel
        </Button>
      )}
      {(status === "READY" || status === "UNPUBLISHED" || status === "FAILED") && (
        <Button
          size="small"
          variant="outlined"
          color="error"
          disabled={busy}
          onClick={() => onAction("delete", report)}
        >
          Delete
        </Button>
      )}
    </Stack>
  );
}

export default function PresentationsTable({
  reports,
  loading,
  error,
  busyId,
  onRetry,
  onPreview,
  onAction,
}) {
  return (
    <Paper variant="outlined" sx={{ p: { xs: 2, md: 2.5 }, borderRadius: 2 }}>
      <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1.5 }}>
        Presentations
      </Typography>

      {error ? (
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
      ) : loading ? (
        <Stack spacing={1}>
          {[0, 1, 2].map((key) => (
            <Skeleton key={key} variant="rounded" height={52} />
          ))}
        </Stack>
      ) : reports.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ py: 3, textAlign: "center" }}>
          No presentations yet. Upload one above to get started.
        </Typography>
      ) : (
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Presentation</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {reports.map((report) => {
                const meta = getStatusMeta(report.status);
                const subline = [
                  formatWeekLabel(report.reporting_week),
                  report.version ? `v${report.version}` : "",
                  report.uploaded_at ? `uploaded ${formatReportDate(report.uploaded_at)}` : "",
                ]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <TableRow key={report.id} hover>
                    <TableCell sx={{ verticalAlign: "top", minWidth: 200 }}>
                      <Typography variant="subtitle2" fontWeight={700}>
                        {report.title}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {subline}
                      </Typography>
                    </TableCell>
                    <TableCell sx={{ verticalAlign: "top" }}>
                      <Chip size="small" label={meta.label} color={meta.color} variant="outlined" />
                      <StatusDetail report={report} />
                    </TableCell>
                    <TableCell align="right" sx={{ verticalAlign: "top" }}>
                      <RowActions
                        report={report}
                        busy={busyId === report.id}
                        onPreview={onPreview}
                        onAction={onAction}
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Paper>
  );
}

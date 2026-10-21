import { useState } from "react";
import { Box, Stack, Typography } from "@mui/material";
import { toast } from "react-toastify";
import {
  cancelWeeklyReport,
  deleteWeeklyReport,
  publishWeeklyReport,
  unpublishWeeklyReport,
  weeklyReportErrorMessage,
} from "../../lib/api.js";
import useWeeklyReports from "./hooks/useWeeklyReports.js";
import UploadCard from "./components/UploadCard.jsx";
import PresentationsTable from "./components/PresentationsTable.jsx";
import ConfirmDialog from "./components/ConfirmDialog.jsx";
import ClientReportView from "./components/ClientReportView.jsx";
import { SlideViewerDialog } from "./components/SlideViewer.jsx";

const ACTIONS = {
  publish: {
    run: publishWeeklyReport,
    success: "Published. Users can now see this report.",
    failure: "Couldn't publish this report.",
    confirmLabel: "Publish",
    confirmColor: "success",
    title: "Publish this report?",
  },
  unpublish: {
    run: unpublishWeeklyReport,
    success: "Unpublished. Users can no longer see this report.",
    failure: "Couldn't unpublish this report.",
    confirmLabel: "Unpublish",
    confirmColor: "primary",
    title: "Unpublish this report?",
    message: "Users will no longer be able to see it. You can publish it again later.",
  },
  cancel: {
    run: cancelWeeklyReport,
    success: "Processing cancelled.",
    failure: "Couldn't cancel processing.",
    confirmLabel: "Cancel processing",
    confirmColor: "error",
    title: "Cancel processing?",
    message: "The upload will be discarded.",
  },
  delete: {
    run: deleteWeeklyReport,
    success: "Deleted.",
    failure: "Couldn't delete this report.",
    confirmLabel: "Delete",
    confirmColor: "error",
    title: "Delete this report?",
    message: "This permanently deletes the presentation and its slides. It can't be undone.",
  },
};

function ManagerView({ brandKey, reports, loading, error, refresh, reload }) {
  const [previewReport, setPreviewReport] = useState(null);
  const [pending, setPending] = useState(null); // { type, report }
  const [busyId, setBusyId] = useState(null);

  const runAction = async (type, report) => {
    const action = ACTIONS[type];
    setBusyId(report.id);
    const res = await action.run({ brandKey, id: report.id });
    if (res.error) {
      toast.error(weeklyReportErrorMessage(res, action.failure));
    } else {
      toast.success(action.success);
    }
    await refresh();
    setBusyId(null);
  };

  const handleAction = (type, report) => {
    // Publishing is safe on its own unless another report is already live.
    if (type === "publish" && !reports.some((r) => r.status === "PUBLISHED" && r.id !== report.id)) {
      runAction(type, report);
      return;
    }
    setPending({ type, report });
  };

  const confirmPending = async () => {
    const { type, report } = pending;
    setPending(null);
    await runAction(type, report);
  };

  const pendingAction = pending ? ACTIONS[pending.type] : null;
  const pendingMessage =
    pending?.type === "publish"
      ? "Another report is already published for this brand. Users will see the newest published report."
      : pendingAction?.message;

  return (
    // index.css sets a near-black body color, so text outside a Paper/Card (like this title) would be
    // dark on dark. Setting the theme's text color on the page root keeps it readable in both modes.
    <Stack spacing={2} sx={{ color: "text.primary" }}>
      <Box>
        <Typography variant="h5" fontWeight={700} color="text.primary">
          Weekly Reports
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Upload, publish and manage the weekly presentations for {brandKey}.
        </Typography>
      </Box>

      <UploadCard key={brandKey} brandKey={brandKey} onUploaded={refresh} />

      <PresentationsTable
        reports={reports}
        loading={loading}
        error={error}
        busyId={busyId}
        onRetry={reload}
        onPreview={setPreviewReport}
        onAction={handleAction}
      />

      <SlideViewerDialog
        report={previewReport}
        brandKey={brandKey}
        onClose={() => setPreviewReport(null)}
      />

      <ConfirmDialog
        open={Boolean(pending)}
        title={pendingAction?.title}
        message={pendingMessage}
        confirmLabel={pendingAction?.confirmLabel}
        confirmColor={pendingAction?.confirmColor}
        onConfirm={confirmPending}
        onClose={() => setPending(null)}
      />
    </Stack>
  );
}

export default function WeeklyReportsPage({ brandKey, isManager = false }) {
  const { reports, loading, error, refresh, reload } = useWeeklyReports(brandKey);

  if (isManager) {
    return (
      <ManagerView
        brandKey={brandKey}
        reports={reports}
        loading={loading}
        error={error}
        refresh={refresh}
        reload={reload}
      />
    );
  }

  return (
    <ClientReportView
      brandKey={brandKey}
      reports={reports}
      loading={loading}
      error={error}
      onRetry={reload}
    />
  );
}

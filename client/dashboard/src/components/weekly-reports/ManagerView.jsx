import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
  useMediaQuery,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import { toast } from "react-toastify";
import {
  deleteWeeklyReport,
  listWeeklyReports,
  publishWeeklyReport,
  unpublishWeeklyReport,
} from "../../lib/api.js";
import ReportUploader from "./ReportUploader.jsx";
import ReportStatus from "./ReportStatus.jsx";
import PresentationViewer from "./PresentationViewer.jsx";
import { describeFailure, formatDate } from "./reportUi.js";

const POLL_MS = 2000;

const canPreview = (r) => ["READY", "PUBLISHED", "UNPUBLISHED"].includes(r.status) && r.slide_count > 0;
const canPublish = (r) => r.status === "READY" || r.status === "UNPUBLISHED";
const canDelete = (r) => ["READY", "UNPUBLISHED", "FAILED"].includes(r.status);

// Management view for elevated roles: upload, preview, publish, unpublish, delete, history.
// Every action is also enforced by the service; hiding a button here is only convenience.
export default function ManagerView({ brandKey }) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("md"));
  const [reports, setReports] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [confirm, setConfirm] = useState(null); // { kind, report }
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    const res = await listWeeklyReports(brandKey);
    if (!alive.current) return;
    if (res.error) {
      setLoadError(describeFailure(res, "Could not load reports."));
      return;
    }
    setLoadError("");
    setReports(res.data?.reports || []);
  }, [brandKey]);

  useEffect(() => {
    alive.current = true;
    refresh();
    return () => { alive.current = false; };
  }, [refresh]);

  // Poll only while something is converting, so the progress counts move in near real time.
  const anyProcessing = Boolean(reports?.some((r) => r.status === "PROCESSING"));
  useEffect(() => {
    if (!anyProcessing) return undefined;
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [anyProcessing, refresh]);

  const run = async (report, action, okMessage) => {
    setBusyId(report.id);
    const res = await action(brandKey, report.id);
    setBusyId(null);
    if (res.error) toast.error(describeFailure(res, "That did not work. Please try again."));
    else toast.success(okMessage);
    await refresh();
  };

  const onConfirm = async () => {
    const { kind, report } = confirm;
    setConfirm(null);
    if (kind === "publish") await run(report, publishWeeklyReport, "Published. Clients can now preview it.");
    if (kind === "unpublish") await run(report, unpublishWeeklyReport, "Unpublished. Clients can no longer see it.");
    if (kind === "delete") await run(report, deleteWeeklyReport, "Report deleted.");
  };

  const actions = (r) => (
    <Box sx={{ display: "flex", gap: 0.75, flexWrap: "wrap", justifyContent: { xs: "stretch", md: "flex-end" }, "& > button": { flex: { xs: "1 1 auto", md: "0 0 auto" } } }}>
      {canPreview(r) && (
        <Button size="small" variant="outlined" onClick={() => setViewing(r)} disabled={busyId === r.id}>Preview</Button>
      )}
      {canPublish(r) && (
        <Button size="small" variant="contained" disableElevation onClick={() => setConfirm({ kind: "publish", report: r })} disabled={busyId === r.id}>
          Publish
        </Button>
      )}
      {r.status === "PUBLISHED" && (
        <Button size="small" variant="outlined" onClick={() => setConfirm({ kind: "unpublish", report: r })} disabled={busyId === r.id}>Unpublish</Button>
      )}
      {canDelete(r) && (
        <Button size="small" variant="outlined" color="error" onClick={() => setConfirm({ kind: "delete", report: r })} disabled={busyId === r.id}>Delete</Button>
      )}
    </Box>
  );

  const titleCell = (r) => (
    <>
      <Typography sx={{ color: "text.primary", fontWeight: 600, fontSize: 15, overflowWrap: "anywhere" }}>{r.title}</Typography>
      <Typography sx={{ color: "text.secondary", fontSize: 13 }}>
        {r.reporting_week} · v{r.version} · uploaded {formatDate(r.uploaded_at)}
      </Typography>
    </>
  );

  return (
    <Stack spacing={2.5}>
      <ReportUploader brandKey={brandKey} onUploaded={() => { toast.info("Uploaded. Conversion has started."); refresh(); }} />

      <Paper variant="outlined" sx={{ p: { xs: 1.5, md: 2.5 } }}>
        <Typography component="h2" sx={{ color: "text.primary", fontWeight: 700, fontSize: 17, mb: 1.5 }}>
          Presentations
        </Typography>

        {loadError && (
          <Alert severity="error" action={<Button color="inherit" size="small" onClick={refresh}>Retry</Button>} sx={{ mb: 1.5 }}>
            {loadError}
          </Alert>
        )}
        {reports === null && !loadError && <CircularProgress size={22} aria-label="Loading presentations" />}
        {reports && reports.length === 0 && !loadError && (
          <Typography sx={{ color: "text.secondary" }}>No presentation has been uploaded for {brandKey} yet.</Typography>
        )}

        {reports && reports.length > 0 && isMobile && (
          <Stack spacing={1.25}>
            {reports.map((r) => (
              <Paper key={r.id} variant="outlined" sx={{ p: 1.5, display: "flex", flexDirection: "column", gap: 1.25 }}>
                <Box>{titleCell(r)}</Box>
                <ReportStatus report={r} />
                {actions(r)}
              </Paper>
            ))}
          </Stack>
        )}

        {reports && reports.length > 0 && !isMobile && (
          <TableContainer>
            <Table size="small" sx={{ "& td, & th": { borderColor: "divider" } }}>
              <TableHead>
                <TableRow>
                  <TableCell sx={{ color: "text.secondary", fontWeight: 600 }}>Presentation</TableCell>
                  <TableCell sx={{ color: "text.secondary", fontWeight: 600, width: "34%" }}>Status</TableCell>
                  <TableCell align="right" sx={{ color: "text.secondary", fontWeight: 600 }}>Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {reports.map((r) => (
                  <TableRow key={r.id} hover>
                    <TableCell sx={{ maxWidth: 320, verticalAlign: "top" }}>{titleCell(r)}</TableCell>
                    <TableCell sx={{ verticalAlign: "top" }}><ReportStatus report={r} /></TableCell>
                    <TableCell align="right" sx={{ verticalAlign: "top", whiteSpace: "nowrap" }}>{actions(r)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Paper>

      {viewing && <PresentationViewer brandKey={brandKey} report={viewing} onClose={() => setViewing(null)} />}

      <Dialog open={Boolean(confirm)} onClose={() => setConfirm(null)} fullWidth maxWidth="xs">
        {confirm && (
          <>
            <DialogTitle sx={{ color: "text.primary" }}>
              {confirm.kind === "publish" && "Publish this presentation?"}
              {confirm.kind === "unpublish" && "Unpublish this presentation?"}
              {confirm.kind === "delete" && "Delete this presentation?"}
            </DialogTitle>
            <DialogContent>
              <DialogContentText sx={{ color: "text.secondary" }}>
                {confirm.kind === "publish" &&
                  `Users of ${brandKey} with preview access will be able to preview "${confirm.report.title}" (v${confirm.report.version}). Other published presentations are not affected.`}
                {confirm.kind === "unpublish" && `Users will stop seeing "${confirm.report.title}". You can publish it again later.`}
                {confirm.kind === "delete" && `"${confirm.report.title}" (v${confirm.report.version}) will be removed from the list.`}
              </DialogContentText>
            </DialogContent>
            <DialogActions sx={{ px: 3, pb: 2 }}>
              <Button onClick={() => setConfirm(null)}>Cancel</Button>
              <Button onClick={onConfirm} variant="contained" color={confirm.kind === "delete" ? "error" : "primary"} disableElevation autoFocus>
                {confirm.kind === "publish" ? "Publish" : confirm.kind === "unpublish" ? "Unpublish" : "Delete"}
              </Button>
            </DialogActions>
          </>
        )}
      </Dialog>
    </Stack>
  );
}

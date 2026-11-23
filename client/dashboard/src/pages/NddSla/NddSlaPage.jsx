import { PageHeader, FilterBar } from "../../components/datum/index.js";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  IconButton,
  LinearProgress,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Paper,
  Popover,
  Select,
  Skeleton,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tabs,
  Tooltip,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import DownloadIcon from "@mui/icons-material/Download";
import RefreshIcon from "@mui/icons-material/Refresh";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import ReplayIcon from "@mui/icons-material/Replay";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import dayjs from "dayjs";
import { toast } from "react-toastify";
import ProcessingStatus from "./components/ProcessingStatus.jsx";
import { FunnelSingleDatePicker } from "../../components/DailyFunnelPanel.jsx";
import {
  controlNddSlaRun,
  deleteNddSlaRun,
  downloadNddSlaExport,
  getNddSlaReport,
  listNddSlaOrders,
  listNddSlaRuns,
  nddSlaErrorMessage,
  requeueNddSlaReport,
  uploadNddSlaReports,
} from "../../lib/api.js";
import {
  DASH,
  exportFilename,
  formatCount,
  formatHour,
  formatPct,
  formatReportDate,
  formatUtcAsLocal,
  formatWall,
  isLive,
  locationLabel,
  pickDefaultDate,
  runOptionLabel,
  saveBlob,
  statusInfo,
} from "./nddSlaFormat.js";

const PAGE_SIZE = 50;
const POLL_MS = 3000; // while a report is being processed
const POLL_WAIT_MS = 30000; // while waiting for the GoKwik email
const LOCATIONS = ["AJMAL_SONS", "EMIZA_GGN"];
const ISO_DAY = "YYYY-MM-DD";

const tabular = { fontVariantNumeric: "tabular-nums" };
const compactSelect = { fontSize: "0.8125rem" };

// ---- small pieces ---------------------------------------------------------------------------------------------------

function SlaChip({ sla }) {
  const met = sla === "MET";
  return (
    <Chip
      size="small"
      label={met ? "Met" : "Breached"}
      sx={{
        height: 20,
        fontSize: 11,
        fontWeight: 600,
        color: met ? "success.main" : "error.main",
        bgcolor: (theme) => alpha(met ? theme.palette.success.main : theme.palette.error.main, 0.12),
      }}
    />
  );
}

// Totals in one strip instead of three cards, with a slim met/breached bar underneath.
function StatStrip({ totals, reportDate }) {
  const items = [
    { label: "Total orders", value: totals.total, hint: formatReportDate(reportDate) },
    { label: "SLA Met", value: totals.met, hint: formatPct(totals.metPct), color: "success.main" },
    { label: "SLA Breached", value: totals.breached, hint: formatPct(totals.breachedPct), color: "error.main" },
  ];
  return (
    <Paper variant="outlined" sx={{ overflow: "hidden" }}>
      <Box sx={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)" }}>
        {items.map((item, i) => (
          <Box key={item.label} sx={{ p: { xs: 1.25, sm: 2 }, borderLeft: i ? "1px solid" : "none", borderColor: "divider" }}>
            <Typography variant="caption" color="text.secondary">{item.label}</Typography>
            <Typography sx={{ ...tabular, fontWeight: 700, color: item.color || "text.primary", fontSize: { xs: "1.25rem", sm: "1.75rem" }, lineHeight: 1.2 }}>
              {formatCount(item.value)}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={tabular}>{item.hint}</Typography>
          </Box>
        ))}
      </Box>
      <Box sx={{ display: "flex", height: 4, bgcolor: (theme) => alpha(theme.palette.text.primary, 0.08) }} aria-hidden="true">
        <Box sx={{ width: `${totals.metPct || 0}%`, bgcolor: "success.main" }} />
        <Box sx={{ width: `${totals.breachedPct || 0}%`, bgcolor: "error.main" }} />
      </Box>
    </Paper>
  );
}

function DetailRow({ label, children }) {
  return (
    <Box sx={{ display: "flex", justifyContent: "space-between", gap: 2, py: 0.5 }}>
      <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>{label}</Typography>
      <Typography variant="caption" sx={{ textAlign: "right", wordBreak: "break-word", ...tabular }}>{children}</Typography>
    </Box>
  );
}

// Everything that used to sit under the heading and in the footer line, kept in one popover.
function RunDetails({ run }) {
  const c = run.counts || {};
  const source = run.source;
  const excluded = [
    ["Other client / channel", c.wrongClient],
    ["Excluded status", c.wrongStatus],
    ["Outside its window", c.outOfWindow],
    ["Duplicate reference", c.duplicate],
    ["Invalid", c.invalid],
  ];
  return (
    <Box sx={{ p: 2, width: 340, maxWidth: "calc(100vw - 32px)" }}>
      <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 0.5 }}>Report details</Typography>
      <DetailRow label="Report date">{formatReportDate(run.reportDate)} · #{run.reportSeq || 1}</DetailRow>
      <DetailRow label="Status">{run.paused ? "Paused" : statusInfo(run.status).label}</DetailRow>
      <DetailRow label="NDD orders">{formatWall(run.windows.ndd.start)} → {formatWall(run.windows.ndd.end)}</DetailRow>
      <DetailRow label="Other orders">{formatWall(run.windows.other.start)} → {formatWall(run.windows.other.end)}</DetailRow>
      <DetailRow label="Timezone">{run.windows.timezone}</DetailRow>
      <Divider sx={{ my: 1 }} />
      <DetailRow label="Source">{source ? (source.mode === "MANUAL" ? "Manual upload" : "Automated") : DASH}</DetailRow>
      {source?.filename ? <DetailRow label="GoKwik file">{source.filename}</DetailRow> : null}
      {source?.easycomFilename ? <DetailRow label="EasyCom file">{source.easycomFilename}</DetailRow> : null}
      {run.completedAt ? <DetailRow label="Completed">{formatUtcAsLocal(run.completedAt)}</DetailRow> : null}
      <Divider sx={{ my: 1 }} />
      <DetailRow label="Rows read">{formatCount(c.rowsIn)}</DetailRow>
      <DetailRow label="Orders kept">{formatCount(c.kept)}</DetailRow>
      {excluded.map(([label, value]) => <DetailRow key={label} label={`Excluded: ${label.toLowerCase()}`}>{formatCount(value)}</DetailRow>)}
      <DetailRow label="Not found in EasyCom">{formatCount(c.unmatchedInEasycom)} (counted as breached)</DetailRow>
    </Box>
  );
}

// ---- manual upload --------------------------------------------------------------------------------------------------

function FilePick({ label, file, onPick, disabled }) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, minWidth: 0 }}>
      <Button component="label" variant="outlined" size="small" startIcon={<UploadFileIcon />} disabled={disabled} sx={{ flexShrink: 0, minWidth: 170 }}>
        {label}
        <input hidden type="file" accept=".csv,.gz,text/csv" onChange={(e) => onPick(e.target.files?.[0] || null)} />
      </Button>
      <Typography variant="caption" color="text.secondary" noWrap title={file?.name}>{file ? file.name : "No file chosen"}</Typography>
    </Box>
  );
}

// Every upload is added as a NEW report for its date; nothing already there is replaced.
function UploadDialog({ open, onClose, onSubmit, defaultDate, busy, phase }) {
  const [date, setDate] = useState(defaultDate || "");
  const [gokwik, setGokwik] = useState(null);
  const [easycom, setEasycom] = useState(null);

  useEffect(() => {
    if (open) {
      setDate(defaultDate || "");
      setGokwik(null);
      setEasycom(null);
    }
  }, [open, defaultDate]);

  const ready = Boolean(date && gokwik && easycom) && !busy;
  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="xs">
      <DialogTitle sx={{ pb: 0.5 }}>Upload reports</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            Choose the date the reporting window ends on and add the GoKwik and EasyCom files (.csv or .csv.gz). The upload is added as a new report for that date.
          </Typography>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
            <Typography variant="caption" color="text.secondary" sx={{ minWidth: 80 }}>Report date</Typography>
            <FunnelSingleDatePicker date={date} compact onApply={(d) => setDate(dayjs(d).format(ISO_DAY))} />
          </Box>
          <FilePick label="GoKwik report" file={gokwik} onPick={setGokwik} disabled={busy} />
          <FilePick label="EasyCom report" file={easycom} onPick={setEasycom} disabled={busy} />
          {busy ? (
            <Box role="status" aria-live="polite">
              <LinearProgress />
              <Typography variant="caption" color="text.secondary">
                {phase === "compressing" ? "Compressing the files…" : "Uploading the files…"} Keep this window open.
              </Typography>
            </Box>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy} color="inherit">Close</Button>
        <Button variant="contained" disabled={!ready} onClick={() => onSubmit({ date, gokwikFile: gokwik, easycomFile: easycom })}>
          {busy ? "Uploading…" : "Upload and process"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function LoadingBlock() {
  return (
    <Stack spacing={1.5} aria-busy="true" aria-label="Loading NDD / SLA report">
      <Skeleton variant="rounded" height={84} />
      <Skeleton variant="rounded" height={140} />
      <Skeleton variant="rounded" height={220} />
    </Stack>
  );
}

// ---- report tables --------------------------------------------------------------------------------------------------

function BreakdownTable({ locations }) {
  return (
    <TableContainer component={Paper} variant="outlined">
      <Table size="small" aria-label="SLA by client location">
        <TableHead>
          <TableRow>
            <TableCell>Client location</TableCell>
            <TableCell align="right">Orders</TableCell>
            <TableCell align="right">SLA Met</TableCell>
            <TableCell align="right">Met %</TableCell>
            <TableCell align="right">SLA Breached</TableCell>
            <TableCell align="right">Breached %</TableCell>
          </TableRow>
        </TableHead>
        <TableBody sx={{ "& td": tabular }}>
          {locations.map((l) => (
            <TableRow key={l.location}>
              <TableCell>{l.label || locationLabel(l.location)}</TableCell>
              <TableCell align="right">{formatCount(l.total)}</TableCell>
              <TableCell align="right">{formatCount(l.met)}</TableCell>
              <TableCell align="right">{formatPct(l.metPct)}</TableCell>
              <TableCell align="right">{formatCount(l.breached)}</TableCell>
              <TableCell align="right">{formatPct(l.breachedPct)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function BreachedCell({ pct }) {
  return (
    <Box sx={{ display: "inline-flex", alignItems: "center", gap: 1, justifyContent: "flex-end" }}>
      <Box sx={{ width: 44, height: 4, borderRadius: 2, bgcolor: (theme) => alpha(theme.palette.text.primary, 0.08), overflow: "hidden", display: { xs: "none", sm: "block" } }} aria-hidden="true">
        <Box sx={{ width: `${Math.min(100, pct || 0)}%`, height: "100%", bgcolor: "error.main" }} />
      </Box>
      <span>{formatPct(pct)}</span>
    </Box>
  );
}

function HourlyTable({ locations }) {
  const [active, setActive] = useState(locations[0]?.location);
  const current = locations.find((l) => l.location === active) || locations[0];
  if (!current) return null;
  return (
    <Paper variant="outlined">
      <Tabs value={current.location} onChange={(_e, v) => setActive(v)} aria-label="Hourly breakdown location" variant="scrollable" scrollButtons="auto" sx={{ minHeight: 40, "& .MuiTab-root": { minHeight: 40, textTransform: "none" } }}>
        {locations.map((l) => <Tab key={l.location} value={l.location} label={l.label || locationLabel(l.location)} />)}
      </Tabs>
      <Divider />
      <TableContainer sx={{ maxHeight: 420 }}>
        <Table size="small" stickyHeader aria-label="Hourly SLA breakdown">
          <TableHead>
            <TableRow>
              <TableCell>Order date</TableCell>
              <TableCell>Hour</TableCell>
              <TableCell align="right">Orders</TableCell>
              <TableCell align="right">Met</TableCell>
              <TableCell align="right">Met %</TableCell>
              <TableCell align="right">Breached</TableCell>
              <TableCell align="right">Breached %</TableCell>
            </TableRow>
          </TableHead>
          <TableBody sx={{ "& td": tabular }}>
            {current.hourly.map((h) => (
              <TableRow key={`${h.orderDate}-${h.orderHour}`} hover>
                <TableCell>{formatReportDate(h.orderDate)}</TableCell>
                <TableCell>{formatHour(h.orderHour)}</TableCell>
                <TableCell align="right">{formatCount(h.total)}</TableCell>
                <TableCell align="right">{formatCount(h.met)}</TableCell>
                <TableCell align="right">{formatPct(h.metPct)}</TableCell>
                <TableCell align="right">{formatCount(h.breached)}</TableCell>
                <TableCell align="right"><BreachedCell pct={h.breachedPct} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Paper>
  );
}

// Order-level data, one page at a time from the API (keyset cursor). `cursors[i]` is the cursor that fetches page i.
function OrdersSection({ brandKey, runId, ready }) {
  const [location, setLocation] = useState("");
  const [sla, setSla] = useState("");
  const [cursors, setCursors] = useState([undefined]);
  const [pageIndex, setPageIndex] = useState(0);
  const [state, setState] = useState({ rows: [], next: null, loading: false, error: "" });
  const filterKey = `${brandKey}|${runId}|${location}|${sla}`;

  useEffect(() => {
    setCursors([undefined]);
    setPageIndex(0);
  }, [filterKey]);

  useEffect(() => {
    if (!ready) return undefined;
    const controller = new AbortController();
    setState((prev) => ({ ...prev, loading: true, error: "" }));
    listNddSlaOrders({ brandKey, runId, location, sla, cursor: cursors[pageIndex], limit: PAGE_SIZE, signal: controller.signal }).then((res) => {
      if (res.aborted) return;
      if (res.error) {
        setState({ rows: [], next: null, loading: false, error: nddSlaErrorMessage(res, "Couldn't load orders.") });
        return;
      }
      setState({ rows: res.data?.orders || [], next: res.data?.nextCursor || null, loading: false, error: "" });
    });
    return () => controller.abort();
  }, [brandKey, runId, location, sla, cursors, pageIndex, ready]);

  const goNext = () => {
    if (!state.next) return;
    setCursors((prev) => (prev.length > pageIndex + 1 ? prev : [...prev, state.next]));
    setPageIndex((i) => i + 1);
  };

  return (
    <Stack spacing={1}>
      <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between" flexWrap="wrap" useFlexGap>
        <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>Orders</Typography>
        <Stack direction="row" spacing={1}>
          <FormControl size="small" sx={{ minWidth: 150 }}>
            <Select displayEmpty value={location} onChange={(e) => setLocation(e.target.value)} inputProps={{ "aria-label": "Client location" }} sx={compactSelect}>
              <MenuItem value="">All locations</MenuItem>
              {LOCATIONS.map((l) => <MenuItem key={l} value={l}>{locationLabel(l)}</MenuItem>)}
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ minWidth: 120 }}>
            <Select displayEmpty value={sla} onChange={(e) => setSla(e.target.value)} inputProps={{ "aria-label": "SLA" }} sx={compactSelect}>
              <MenuItem value="">All SLA</MenuItem>
              <MenuItem value="MET">Met</MenuItem>
              <MenuItem value="BREACHED">Breached</MenuItem>
            </Select>
          </FormControl>
        </Stack>
      </Stack>

      {state.error ? <Alert severity="error">{state.error}</Alert> : null}
      <TableContainer component={Paper} variant="outlined" sx={{ opacity: state.loading ? 0.6 : 1 }}>
        <Table size="small" aria-label="Orders">
          <TableHead>
            <TableRow>
              <TableCell>Reference code</TableCell>
              <TableCell>Client location</TableCell>
              <TableCell>Order time</TableCell>
              <TableCell>Courier</TableCell>
              <TableCell>NDD</TableCell>
              <TableCell>Shipment picked at</TableCell>
              <TableCell>SLA</TableCell>
            </TableRow>
          </TableHead>
          <TableBody sx={{ "& td": tabular }}>
            {state.rows.map((o) => (
              <TableRow key={o.referenceCode} hover>
                <TableCell>{o.referenceCode}</TableCell>
                <TableCell>{locationLabel(o.location)}</TableCell>
                <TableCell>{formatWall(o.orderAt)}</TableCell>
                <TableCell>{o.courier || DASH}</TableCell>
                <TableCell>{o.isNdd ? "Yes" : "No"}</TableCell>
                <TableCell sx={o.shipmentPickedAt ? undefined : { color: "text.secondary" }}>{o.shipmentPickedAt ? formatWall(o.shipmentPickedAt) : "Not picked up"}</TableCell>
                <TableCell><SlaChip sla={o.sla} /></TableCell>
              </TableRow>
            ))}
            {!state.rows.length && !state.loading && !state.error ? (
              <TableRow><TableCell colSpan={7} align="center">No orders match these filters.</TableCell></TableRow>
            ) : null}
          </TableBody>
        </Table>
      </TableContainer>
      <Stack direction="row" spacing={1} alignItems="center" justifyContent="flex-end">
        {state.loading ? <CircularProgress size={14} /> : null}
        <Typography variant="caption" color="text.secondary">Page {pageIndex + 1}</Typography>
        <Button size="small" color="inherit" disabled={pageIndex === 0 || state.loading} onClick={() => setPageIndex((i) => Math.max(0, i - 1))}>Previous</Button>
        <Button size="small" color="inherit" disabled={!state.next || state.loading} onClick={goNext}>Next</Button>
      </Stack>
    </Stack>
  );
}

// ---- page -----------------------------------------------------------------------------------------------------------

export default function NddSlaPage({ brandKey, isManager = false, canUpload = false }) {
  const [init, setInit] = useState({ loading: true, error: "" });
  const [initTick, setInitTick] = useState(0);
  const [date, setDate] = useState(""); // YYYY-MM-DD, the report date being viewed
  const [day, setDay] = useState({ list: [], loading: false, error: "" }); // every report of that date
  const [runId, setRunId] = useState(null);
  const [report, setReport] = useState({ data: null, loading: false, error: "", key: "" });
  const [tick, setTick] = useState(0); // refresh the day's list and the report
  const [liveTick, setLiveTick] = useState(0); // refresh only the report (cheap poll while it is processing)
  const [exporting, setExporting] = useState("");
  const [requeuing, setRequeuing] = useState(false);
  const [controlBusy, setControlBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadPhase, setUploadPhase] = useState("");
  const [menuAnchor, setMenuAnchor] = useState(null);
  const [infoAnchor, setInfoAnchor] = useState(null);
  const dateTouched = useRef(false);
  const lastRunKey = useRef("");

  // First load per brand: find the newest report date to open on.
  useEffect(() => {
    dateTouched.current = false;
    setDate("");
    setRunId(null);
    if (!brandKey) return undefined;
    const controller = new AbortController();
    setInit({ loading: true, error: "" });
    listNddSlaRuns({ brandKey, signal: controller.signal }).then((res) => {
      if (res.aborted) return;
      if (res.error) {
        setInit({ loading: false, error: nddSlaErrorMessage(res, "Couldn't load reports.") });
        return;
      }
      if (!dateTouched.current) setDate(pickDefaultDate(res.data) || dayjs().format(ISO_DAY));
      setInit({ loading: false, error: "" });
    });
    return () => controller.abort();
  }, [brandKey, initTick]);

  // Reports of the chosen date (several can exist: the automated one and every upload).
  useEffect(() => {
    if (!brandKey || !date) return undefined;
    const controller = new AbortController();
    setDay((prev) => ({ ...prev, loading: true, error: "" }));
    listNddSlaRuns({ brandKey, from: date, to: date, signal: controller.signal }).then((res) => {
      if (res.aborted) return;
      if (res.error) {
        setDay({ list: [], loading: false, error: nddSlaErrorMessage(res, "Couldn't load reports.") });
        return;
      }
      setDay({ list: res.data, loading: false, error: "" });
      setRunId((prev) => (res.data.some((r) => r.id === prev) ? prev : (res.data.find((r) => r.ready) || res.data[0])?.id ?? null));
    });
    return () => controller.abort();
  }, [brandKey, date, tick]);

  useEffect(() => {
    if (!brandKey || !runId) {
      setReport({ data: null, loading: false, error: "", key: "" });
      return undefined;
    }
    const controller = new AbortController();
    const key = `${brandKey}|${runId}`;
    // A refresh of the same report keeps what is on screen (no flicker while polling); another report shows the loader.
    setReport((prev) => (prev.key === key ? { ...prev, error: "" } : { data: null, loading: true, error: "", key }));
    getNddSlaReport({ brandKey, runId, signal: controller.signal }).then((res) => {
      if (res.aborted) return;
      if (res.error) {
        setReport({ data: null, loading: false, error: nddSlaErrorMessage(res, "Couldn't load this report."), key });
        return;
      }
      setReport({ data: res.data, loading: false, error: "", key });
    });
    return () => controller.abort();
  }, [brandKey, runId, tick, liveTick]);

  const run = report.data?.run;
  const ready = Boolean(run?.ready);
  const live = isLive(run);

  // Poll only the open report while it is being processed (or waiting for the GoKwik email, slowly).
  useEffect(() => {
    if (!live) return undefined;
    const waiting = run.status === "SCHEDULED" || run.status === "WAITING_FOR_GOKWIK";
    const id = setTimeout(() => setLiveTick((t) => t + 1), waiting ? POLL_WAIT_MS : POLL_MS);
    return () => clearTimeout(id);
  }, [live, run, liveTick]);

  // When the open report changes state, refresh the date's list so the selector shows the new status.
  useEffect(() => {
    if (!run) return;
    const key = `${run.id}:${run.status}:${run.paused}`;
    const [prevId] = lastRunKey.current.split(":");
    if (lastRunKey.current && lastRunKey.current !== key && prevId === String(run.id)) setTick((t) => t + 1);
    lastRunKey.current = key;
  }, [run]);

  const pickDate = (value) => {
    dateTouched.current = true;
    setDate(dayjs(value).format(ISO_DAY));
    setRunId(null);
  };

  const handleExport = useCallback(async (type) => {
    setMenuAnchor(null);
    setExporting(type);
    const res = await downloadNddSlaExport({ brandKey, runId, type });
    setExporting("");
    if (res.error) {
      toast.error(nddSlaErrorMessage(res, "Couldn't download this report."));
      return;
    }
    saveBlob(res.blob, exportFilename(type, run?.reportDate || date, run?.reportSeq));
  }, [brandKey, runId, run, date]);

  const handleUpload = useCallback(async ({ date: uploadDate, gokwikFile, easycomFile }) => {
    setUploading(true);
    const res = await uploadNddSlaReports({ brandKey, date: uploadDate, gokwikFile, easycomFile, onPhase: setUploadPhase });
    setUploading(false);
    setUploadPhase("");
    if (res.error) {
      toast.error(nddSlaErrorMessage(res, "Couldn't upload the reports."));
      return;
    }
    setUploadOpen(false);
    toast.success("Files received. The report is being built.");
    dateTouched.current = true;
    setDate(uploadDate);
    setRunId(res.data?.runId ?? null);
    setTick((t) => t + 1);
  }, [brandKey]);

  const handleRequeue = useCallback(async () => {
    setMenuAnchor(null);
    setRequeuing(true);
    const res = await requeueNddSlaReport({ brandKey, runId });
    setRequeuing(false);
    if (res.error) {
      toast.error(nddSlaErrorMessage(res, "Couldn't queue a re-run."));
      return;
    }
    toast.success("Re-run queued. The current data stays available until the new report is ready.");
    setTick((t) => t + 1);
  }, [brandKey, runId]);

  const handleControl = useCallback(async (action) => {
    setControlBusy(true);
    const res = await controlNddSlaRun({ brandKey, runId, action });
    setControlBusy(false);
    if (res.error) {
      toast.error(nddSlaErrorMessage(res, `Couldn't ${action} this report.`));
    } else if (action === "cancel") {
      toast.info("Cancelling. It stops at the next safe point.");
    }
    setTick((t) => t + 1);
  }, [brandKey, runId]);

  const handleDelete = useCallback(async () => {
    setDeleting(true);
    const res = await deleteNddSlaRun({ brandKey, runId });
    setDeleting(false);
    if (res.error) {
      toast.error(nddSlaErrorMessage(res, "Couldn't delete this report."));
      return;
    }
    setDeleteOpen(false);
    toast.success("Report deleted.");
    lastRunKey.current = "";
    setRunId(null);
    setTick((t) => t + 1);
  }, [brandKey, runId]);

  const uploadDialog = (
    <UploadDialog open={uploadOpen} onClose={() => setUploadOpen(false)} onSubmit={handleUpload} defaultDate={date} busy={uploading} phase={uploadPhase} />
  );

  if (init.loading) return <LoadingBlock />;
  if (init.error) {
    return <Alert severity="error" action={<Button color="inherit" size="small" onClick={() => setInitTick((t) => t + 1)}>Retry</Button>}>{init.error}</Alert>;
  }

  const options = day.list;
  const showReport = run && !report.loading;
  const canExport = ready && !exporting;

  return (
    <Stack spacing={1.5}>
      <PageHeader
        title="NDD / SLA report"
        description="Next-day-delivery orders checked against pickup SLA"
        meta={[
          run ? (
            <Tooltip title="Report details">
              <IconButton size="small" aria-label="Report details" onClick={(e) => setInfoAnchor(e.currentTarget)}>
                <InfoOutlinedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          ) : null,
        ]}
        actions={
          <>
            <Tooltip title="Refresh">
              <IconButton size="small" aria-label="Refresh" onClick={() => setTick((t) => t + 1)}><RefreshIcon fontSize="small" /></IconButton>
            </Tooltip>
            {canUpload ? (
              <Button size="small" variant="contained" disableElevation startIcon={<UploadFileIcon />} onClick={() => setUploadOpen(true)}>Upload</Button>
            ) : null}
            <IconButton size="small" aria-label="More actions" aria-haspopup="menu" onClick={(e) => setMenuAnchor(e.currentTarget)}><MoreVertIcon fontSize="small" /></IconButton>
          </>
        }
      />

      <FilterBar ariaLabel="Report filters">
        <FunnelSingleDatePicker date={date} compact onApply={pickDate} />
        {options.length > 1 ? (
          <FormControl size="small" sx={{ minWidth: 220, maxWidth: "100%" }}>
            <Select value={runId ?? ""} onChange={(e) => setRunId(e.target.value)} inputProps={{ "aria-label": "Report" }} sx={compactSelect}>
              {options.map((r) => <MenuItem key={r.id} value={r.id} sx={compactSelect}>{runOptionLabel(r)}</MenuItem>)}
            </Select>
          </FormControl>
        ) : options.length === 1 ? (
          <Chip size="small" variant="outlined" label={runOptionLabel(options[0])} sx={{ maxWidth: "100%" }} />
        ) : null}
      </FilterBar>

      <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={() => setMenuAnchor(null)}>
        <MenuItem disabled={!canExport} onClick={() => handleExport("orders")}>
          <ListItemIcon><DownloadIcon fontSize="small" /></ListItemIcon>
          <ListItemText>{exporting === "orders" ? "Preparing…" : "Export orders"}</ListItemText>
        </MenuItem>
        <MenuItem disabled={!canExport} onClick={() => handleExport("summary")}>
          <ListItemIcon><DownloadIcon fontSize="small" /></ListItemIcon>
          <ListItemText>{exporting === "summary" ? "Preparing…" : "Export summary"}</ListItemText>
        </MenuItem>
        {isManager ? (
          <MenuItem disabled={requeuing || !run || (run.reportSeq || 1) > 1 || live} onClick={handleRequeue}>
            <ListItemIcon><ReplayIcon fontSize="small" color="warning" /></ListItemIcon>
            <ListItemText>Re-run{run && (run.reportSeq || 1) > 1 ? " (uploads cannot be re-run)" : ""}</ListItemText>
          </MenuItem>
        ) : null}
        {canUpload ? <Divider /> : null}
        {canUpload ? (
          <MenuItem disabled={!run || live} onClick={() => { setMenuAnchor(null); setDeleteOpen(true); }}>
            <ListItemIcon><DeleteOutlineIcon fontSize="small" color="error" /></ListItemIcon>
            <ListItemText>Delete report{live ? " (cancel it first)" : ""}</ListItemText>
          </MenuItem>
        ) : null}
      </Menu>
      <Dialog open={deleteOpen} onClose={deleting ? undefined : () => setDeleteOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ pb: 0.5 }}>Delete this report?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">
            {run ? `Report #${run.reportSeq || 1} for ${formatReportDate(run.reportDate)}` : "This report"} and all of its orders and hourly figures will be permanently removed.
            {run && (run.reportSeq || 1) === 1 && run.source?.mode !== "MANUAL" ? " This is the automated report, so it will be built again from the GoKwik email." : ""}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button color="inherit" disabled={deleting} onClick={() => setDeleteOpen(false)}>Keep</Button>
          <Button color="error" variant="contained" disableElevation disabled={deleting} onClick={handleDelete}>{deleting ? "Deleting…" : "Delete"}</Button>
        </DialogActions>
      </Dialog>
      <Popover open={Boolean(infoAnchor) && Boolean(run)} anchorEl={infoAnchor} onClose={() => setInfoAnchor(null)} anchorOrigin={{ vertical: "bottom", horizontal: "left" }}>
        {run ? <RunDetails run={run} /> : null}
      </Popover>

      {day.error ? <Alert severity="error">{day.error}</Alert> : null}
      {report.loading || (day.loading && !options.length) ? <LoadingBlock /> : null}
      {report.error ? <Alert severity="error">{report.error}</Alert> : null}

      {!day.loading && !day.error && !options.length ? (
        <Paper variant="outlined" sx={{ p: 3, textAlign: "center" }}>
          <Typography variant="body2" color="text.secondary">
            No reports for {formatReportDate(date)}.
            {canUpload ? " Upload the two files to build one." : " Reports appear once the GoKwik file for the day has been received."}
          </Typography>
          {canUpload ? <Button sx={{ mt: 1.5 }} variant="contained" disableElevation size="small" startIcon={<UploadFileIcon />} onClick={() => setUploadOpen(true)}>Upload</Button> : null}
        </Paper>
      ) : null}

      {showReport ? (
        <>
          {run.status !== "COMPLETED" ? (
            <ProcessingStatus
              run={run}
              ready={ready}
              canControl={canUpload}
              busy={controlBusy}
              onControl={handleControl}
              onUploadAgain={canUpload ? () => setUploadOpen(true) : undefined}
            />
          ) : null}

          {ready && report.data.totals ? (
            <>
              <StatStrip totals={report.data.totals} reportDate={run.reportDate} />
              {report.data.totals.total === 0 ? (
                <Alert severity="warning">This report contains no qualifying orders.</Alert>
              ) : (
                <>
                  <BreakdownTable locations={report.data.locations} />
                  <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>Hourly breakdown</Typography>
                  <HourlyTable key={run.id} locations={report.data.locations} />
                  <OrdersSection brandKey={brandKey} runId={run.id} ready={ready} />
                </>
              )}
            </>
          ) : null}
        </>
      ) : null}
      {uploadDialog}
    </Stack>
  );
}

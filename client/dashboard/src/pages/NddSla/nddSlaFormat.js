// Display helpers for the NDD / SLA page. Nothing here computes report figures: counts and percentages arrive from the
// API (derived server-side from the persisted snapshot); these functions only format them.

export const DASH = "—";

export const LOCATION_LABELS = {
  AJMAL_SONS: "AJMAL & SONS",
  EMIZA_GGN: "Emiza Gurgaon",
};

export const locationLabel = (code) => LOCATION_LABELS[code] || code || DASH;

export function formatCount(value) {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-IN") : DASH;
}

export function formatPct(value) {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(1)}%` : DASH;
}

// "2026-11-18 12:00:00" -> "18 Nov, 12:00 PM"; anything unparseable is returned unchanged.
export function formatWall(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(text || ""));
  if (!m) return text || DASH;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const hour = Number(m[4]);
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${Number(m[3])} ${months[Number(m[2]) - 1]}, ${h12}:${m[5]} ${hour < 12 ? "AM" : "PM"}`;
}

export function formatHour(hour) {
  if (typeof hour !== "number") return DASH;
  const next = (hour + 1) % 24;
  const label = (h) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "AM" : "PM"}`;
  return `${label(hour)} – ${label(next)}`;
}

export function formatReportDate(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ""));
  if (!m) return date || DASH;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${Number(m[3])} ${months[Number(m[2]) - 1]} ${m[1]}`;
}

const STATUS = {
  SCHEDULED: { label: "Scheduled", tone: "info" },
  WAITING_FOR_GOKWIK: { label: "Waiting for GoKwik report", tone: "info" },
  GOKWIK_RECEIVED: { label: "GoKwik report received", tone: "info" },
  EASYCOM_FETCHING: { label: "Fetching EasyCom shipments", tone: "info" },
  PROCESSING: { label: "Processing", tone: "info" },
  COMPLETED: { label: "Completed", tone: "success" },
  GOKWIK_TIMEOUT: { label: "GoKwik report never arrived", tone: "error" },
  EASYCOM_FAILED: { label: "EasyCom fetch failed", tone: "error" },
  PROCESSING_FAILED: { label: "Processing failed", tone: "error" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
};

export function statusInfo(status) {
  return STATUS[status] || { label: status || DASH, tone: "info" };
}

export const isFailedStatus = (status) => statusInfo(status).tone === "error";

// "2026-11-20 13:12:25" (UTC, as stored) -> "20 Nov, 6:42 PM" in the viewer's own timezone.
export function formatUtcAsLocal(text) {
  const m = /^(d{4})-(d{2})-(d{2})[ T](d{2}):(d{2}):?(d{2})?/.exec(String(text || ""));
  if (!m) return text || DASH;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0)));
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const hour = d.getHours();
  return `${d.getDate()} ${months[d.getMonth()]}, ${hour % 12 === 0 ? 12 : hour % 12}:${String(d.getMinutes()).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

// A run that is still waiting for, or working on, its report (and can therefore be paused or cancelled).
export const isLive = (run) => Boolean(run) && (isInFlight(run.status) || isWaiting(run.status));

// What the report selector shows for one of the date's reports: "#2 · gokwik OG.csv · 20 Nov, 6:42 PM · Processing".
export function runOptionLabel(run) {
  const parts = [`#${run.reportSeq || 1}`];
  const name = run.source?.filename;
  parts.push(name ? (name.length > 28 ? `${name.slice(0, 25)}…` : name) : run.source?.mode === "MANUAL" ? "Upload" : "Automated");
  const when = run.completedAt || run.createdAt || run.startedAt;
  if (when) parts.push(formatUtcAsLocal(when));
  const done = run.ready && run.status === "COMPLETED";
  if (!done) parts.push(run.paused ? "Paused" : statusInfo(run.status).label);
  return parts.join(" · ");
}

// The newest report that can actually be shown; falls back to the newest run so its status is visible.
export function pickDefaultDate(runs) {
  if (!Array.isArray(runs) || !runs.length) return "";
  const ready = runs.find((r) => r.ready);
  return (ready || runs[0]).reportDate;
}

export function exportFilename(type, date, seq = 1) {
  return `ndd-sla-${type}-${date}${seq > 1 ? `-r${seq}` : ""}.csv`;
}

// Saves a Blob through a temporary link, like the other CSV downloads in the dashboard.
export function saveBlob(blob, filename, doc = document, urlApi = URL) {
  const url = urlApi.createObjectURL(blob);
  const link = doc.createElement("a");
  link.href = url;
  link.download = filename;
  doc.body.appendChild(link);
  link.click();
  doc.body.removeChild(link);
  urlApi.revokeObjectURL(url);
}

// ---- processing progress ----------------------------------------------------------------------------------------------
// Pure description of how far a run has got, derived from the run status the API returns. The UI only renders this.
const IN_FLIGHT = ["GOKWIK_RECEIVED", "EASYCOM_FETCHING", "PROCESSING"];
export const isInFlight = (status) => IN_FLIGHT.includes(status);
export const isWaiting = (status) => status === "SCHEDULED" || status === "WAITING_FOR_GOKWIK";

const ACTIVE_INDEX = { SCHEDULED: 0, WAITING_FOR_GOKWIK: 0, GOKWIK_RECEIVED: 1, EASYCOM_FETCHING: 2, PROCESSING: 3, COMPLETED: 4 };

function stepLabels(manual) {
  return [
    manual ? "Files received" : "GoKwik report received",
    "Reading GoKwik orders",
    "Matching EasyCom pickups",
    "Building the report",
  ];
}

function failedIndexFor(run) {
  if (run.status === "GOKWIK_TIMEOUT") return 0;
  if (run.status === "EASYCOM_FAILED") return 2;
  return /^(CSV_|FILE_)/.test(run.error?.code || "") ? 1 : 3; // PROCESSING_FAILED
}

export function processingSteps(run) {
  const manual = run?.source?.mode === "MANUAL";
  const labels = stepLabels(manual);
  const failed = isFailedStatus(run?.status);
  const cancelled = run?.status === "CANCELLED";
  const failedAt = failed ? failedIndexFor(run) : -1;
  const activeIndex = failed ? failedAt : (ACTIVE_INDEX[run?.status] ?? 0);
  const complete = run?.status === "COMPLETED";

  const steps = labels.map((label, i) => {
    let state = "pending";
    if (cancelled) state = "pending";
    else if (complete || i < activeIndex) state = "done";
    else if (i === activeIndex) state = failed ? "error" : "active";
    return { id: i, label: i === 0 && !manual && isWaiting(run?.status) ? "Waiting for the GoKwik report" : label, state };
  });

  const waiting = isWaiting(run?.status);
  const percent = complete ? 100 : failed ? Math.round((failedAt / labels.length) * 100) : waiting ? 0 : Math.round(((activeIndex + 0.5) / labels.length) * 100);
  const c = run?.counts || {};
  const p = run?.progress || {};
  let detail = "";
  if (run?.status === "GOKWIK_RECEIVED") detail = "Reading the GoKwik file and keeping only the orders that belong in this report…";
  else if (run?.status === "EASYCOM_FETCHING") detail = `${formatCount(c.rowsIn)} rows read, ${formatCount(c.kept)} orders kept. Checking shipment pickups…`;
  else if (run?.status === "PROCESSING") detail = `${formatCount(p.easycomFetched)} shipments checked. Saving ${formatCount(c.kept)} orders and the hourly summary…`;
  else if (run?.status === "WAITING_FOR_GOKWIK") detail = "Waiting for the GoKwik email to arrive. This page refreshes on its own.";
  else if (run?.status === "SCHEDULED") detail = "Queued. Processing starts shortly.";
  let headline = statusInfo(run?.status).label;
  if (cancelled) detail = run?.error?.code === "PAUSE_TIMEOUT" ? "It stayed paused too long and was cancelled." : "Stopped before it finished. Nothing from this attempt was saved.";
  else if (run?.cancelRequested) { headline = "Cancelling…"; detail = "Stopping at the next safe point."; }
  else if (run?.paused) { headline = "Paused"; detail = "Held in place. Resume to continue, or cancel. It is cancelled automatically if left paused too long."; }
  const stopped = cancelled || Boolean(run?.paused);
  return { steps, percent: cancelled ? 0 : percent, indeterminate: !stopped && (waiting || isInFlight(run?.status)), headline, detail, paused: Boolean(run?.paused), cancelled };
}

// 75 -> "1:15", 5 -> "0:05"
export function formatElapsed(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

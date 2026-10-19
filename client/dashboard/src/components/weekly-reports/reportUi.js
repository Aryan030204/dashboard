import dayjs from "dayjs";

// Must match the service default (MAX_UPLOAD_BYTES). The server is authoritative; this only
// saves a round trip for an obviously oversized file.
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const ACCEPTED_EXTENSIONS = [".pptx", ".ppt"];

export const STATUS_META = {
  PROCESSING: { label: "Processing", color: "warning" },
  READY: { label: "Ready to publish", color: "info" },
  PUBLISHED: { label: "Published", color: "success" },
  UNPUBLISHED: { label: "Unpublished", color: "default" },
  FAILED: { label: "Failed", color: "error" },
};

// The steps a report goes through after the file is uploaded. `stage` comes from the service.
export const PROCESSING_STEPS = [
  { id: "QUEUED", label: "Queued" },
  { id: "CONVERTING", label: "Converting" },
  { id: "SAVING_SLIDES", label: "Preparing slides" },
];

export function formatDate(value) {
  if (!value) return "";
  const d = dayjs(value);
  return d.isValid() ? d.format("DD MMM YYYY") : "";
}

export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function hasAcceptedExtension(name) {
  const lower = String(name || "").toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// "Week 42" for the current week, as a starting value the user can edit.
export function defaultReportingWeek(now = dayjs()) {
  const start = now.startOf("year");
  const week = Math.ceil((now.diff(start, "day") + start.day() + 1) / 7);
  return `Week ${week}`;
}

export function titleFromFilename(name) {
  return String(name || "")
    .replace(/\.(pptx?|PPTX?)$/, "")
    .replace(/[_]+/g, " ")
    .trim()
    .slice(0, 200);
}

// What to show for a report that is still processing: which step it is on and, once the
// conversion has produced the slides, how many are done and how many remain.
export function processingInfo(report) {
  const stage = PROCESSING_STEPS.some((s) => s.id === report?.stage) ? report.stage : "QUEUED";
  const stepIndex = PROCESSING_STEPS.findIndex((s) => s.id === stage);
  const total = Number(report?.slides_total) || 0;
  const done = Math.min(total, Number(report?.slides_done) || 0);
  const remaining = Math.max(0, total - done);

  if (stage === "SAVING_SLIDES" && total > 0) {
    return {
      stage, stepIndex, total, done, remaining,
      title: `Preparing slides: ${done} of ${total}`,
      detail: remaining === 0 ? "Finishing up..." : `${remaining} remaining`,
      percent: Math.round((done / total) * 100),
    };
  }
  if (stage === "CONVERTING") {
    return { stage, stepIndex, total: 0, done: 0, remaining: 0, title: "Converting presentation", detail: "Reading the slides. This can take a minute or two.", percent: null };
  }
  return { stage, stepIndex, total: 0, done: 0, remaining: 0, title: "Waiting in the queue", detail: "The file is uploaded. Conversion starts shortly.", percent: null };
}

// Turns an upload/API failure into one plain sentence. Server messages are already written for
// users; the rest cover proxy-level failures that return no JSON.
export function describeFailure(result, fallback = "Something went wrong. Please try again.") {
  if (!result) return fallback;
  const message = result.data?.error;
  if (message && result.status !== 401) return message;
  switch (result.status) {
    case 0:
      return "Could not reach Datum. Check your connection and try again.";
    case 401:
      return "Your session expired. Sign in again.";
    case 403:
      return "You do not have permission to do that.";
    case 413:
      return "File is larger than 50 MB.";
    case 502:
    case 503:
    case 504:
      return "Weekly Reports is temporarily unavailable. Try again in a minute.";
    default:
      return fallback;
  }
}

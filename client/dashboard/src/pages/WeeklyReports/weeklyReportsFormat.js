import dayjs from "dayjs";

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const ACCEPTED_EXTENSIONS = [".ppt", ".pptx", ".pdf"];
export const ACCEPT_ATTRIBUTE = [
  ".ppt",
  ".pptx",
  ".pdf",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/pdf",
].join(",");
export const UNSUPPORTED_FORMAT_MESSAGE =
  "Unsupported format. Please upload a PPT, PPTX or PDF file.";
export const MAX_TITLE_LENGTH = 200;
export const MIN_WEEK = 1;
export const MAX_WEEK = 53;

function getFileExtension(name) {
  const value = (name || "").toString();
  const dot = value.lastIndexOf(".");
  return dot === -1 ? "" : value.slice(dot).toLowerCase();
}

// Returns an error message, or "" when the file can be uploaded.
export function validatePresentationFile(file) {
  if (!file) return "";
  if (!ACCEPTED_EXTENSIONS.includes(getFileExtension(file.name))) {
    return UNSUPPORTED_FORMAT_MESSAGE;
  }
  if (!file.size) return "The file is empty.";
  if (file.size > MAX_UPLOAD_BYTES) return "File is larger than 50 MB.";
  return "";
}

export function titleFromFileName(name) {
  const value = (name || "").toString();
  const dot = value.lastIndexOf(".");
  const base = dot > 0 ? value.slice(0, dot) : value;
  return base.replace(/[_]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_LENGTH);
}

export function isValidWeek(value) {
  const text = (value ?? "").toString().trim();
  if (!/^\d+$/.test(text)) return false;
  const week = Number(text);
  return week >= MIN_WEEK && week <= MAX_WEEK;
}

export function formatFileSize(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) return "";
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatReportDate(value) {
  if (!value) return "";
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format("D MMM YYYY") : "";
}

export function formatSlideCount(count) {
  const n = Number(count);
  if (!Number.isFinite(n) || n <= 0) return "";
  return `${n} ${n === 1 ? "slide" : "slides"}`;
}

export function formatWeekLabel(value) {
  const text = (value ?? "").toString().trim();
  if (!text) return "";
  return /^\d+$/.test(text) ? `Week ${text}` : text;
}

export const STATUS_META = {
  PROCESSING: { label: "Processing", color: "info" },
  READY: { label: "Ready", color: "warning" },
  PUBLISHED: { label: "Published", color: "success" },
  UNPUBLISHED: { label: "Unpublished", color: "default" },
  FAILED: { label: "Failed", color: "error" },
};

const STAGE_LABELS = {
  QUEUED: "Queued",
  CONVERTING: "Converting",
  SAVING_SLIDES: "Saving slides",
};

export function getStatusMeta(status) {
  return STATUS_META[status] || { label: status || "Unknown", color: "default" };
}

export function getStageLabel(stage) {
  return STAGE_LABELS[stage] || "Processing";
}

export function hasSlides(report) {
  return (
    (report?.status === "READY" ||
      report?.status === "PUBLISHED" ||
      report?.status === "UNPUBLISHED") &&
    Number(report?.slide_count) > 0
  );
}

// The backend does not expose an expiry yet. Once it returns `expires_at` on a
// report, this gives the row a "Expires in N days" note; until then it is null.
export function getExpiryNote(report) {
  if (!report?.expires_at) return null;
  const expires = dayjs(report.expires_at);
  if (!expires.isValid()) return null;
  const days = Math.ceil(expires.diff(dayjs(), "hour", true) / 24);
  if (days <= 0) return { text: "Expires today", color: "error.main" };
  const text = `Expires in ${days} ${days === 1 ? "day" : "days"}`;
  if (days <= 1) return { text, color: "error.main" };
  if (days <= 2) return { text, color: "warning.main" };
  return { text, color: "text.secondary" };
}

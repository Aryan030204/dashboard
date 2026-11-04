// Rules and formatting for the Inventory panel's out-of-stock trend. Pure functions so they can be tested
// without React. Dates are plain YYYY-MM-DD strings (the brand's calendar days).

export const MAX_RANGE_DAYS = 31;
export const MAX_HOURLY_RANGE_DAYS = 7;
export const DEFAULT_RANGE_DAYS = 7;

const DAY_MS = 24 * 3600 * 1000;
const pad2 = (n) => String(n).padStart(2, "0");

function toUtcMs(day) {
  const [y, m, d] = String(day).split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromUtcMs(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export function shiftDay(day, delta) {
  return fromUtcMs(toUtcMs(day) + delta * DAY_MS);
}

export function daysInRange(start, end) {
  return Math.round((toUtcMs(end) - toUtcMs(start)) / DAY_MS) + 1;
}

// The last `days` days ending today (today = the caller's calendar day, YYYY-MM-DD).
export function defaultRange(today, days = DEFAULT_RANGE_DAYS) {
  return { start: shiftDay(today, -(days - 1)), end: today };
}

// A range can be at most MAX_RANGE_DAYS long: a longer pick keeps its start and stops at the limit.
export function clampRange(start, end, maxDays = MAX_RANGE_DAYS) {
  let from = start;
  let to = end;
  if (to < from) [from, to] = [to, from];
  if (daysInRange(from, to) > maxDays) to = shiftDay(from, maxDays - 1);
  return { start: from, end: to };
}

export function hourlyAllowed(start, end) {
  return daysInRange(start, end) <= MAX_HOURLY_RANGE_DAYS;
}

// Keeps the chosen granularity if it is allowed for the range, otherwise falls back to daily.
export function resolveGranularity(preferred, start, end) {
  if (preferred === "hourly" && !hourlyAllowed(start, end)) return "daily";
  return preferred === "hourly" ? "hourly" : "daily";
}

// A sensible first choice for a range: hourly for one or two days, daily beyond that.
export function suggestGranularity(start, end) {
  return daysInRange(start, end) <= 2 ? "hourly" : "daily";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Axis tick for a bucket label ("2026-11-04" daily, "2026-11-04 09:00" hourly).
export function formatTick(label, granularity) {
  const [day, time] = String(label || "").split(" ");
  const [, m, d] = String(day).split("-").map(Number);
  if (!m || !d) return String(label || "");
  const dayText = `${MONTHS[m - 1]} ${d}`;
  if (granularity !== "hourly") return dayText;
  return time === "00:00" ? `${dayText} 00:00` : time;
}

export function formatBucketTitle(label, granularity) {
  const [day, time] = String(label || "").split(" ");
  const [y, m, d] = String(day).split("-").map(Number);
  if (!m || !d) return String(label || "");
  const dayText = `${MONTHS[m - 1]} ${d}, ${y}`;
  return granularity === "hourly" && time ? `${dayText}, ${time}` : dayText;
}

// 759 -> "12h 39m", 45 -> "45m", 1500 -> "1d 1h"
export function formatDuration(minutes) {
  if (minutes === null || minutes === undefined || !Number.isFinite(Number(minutes))) return "-";
  const total = Math.max(0, Math.round(Number(minutes)));
  if (total < 60) return `${total}m`;
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const mins = total % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

// An ISO instant shown in the brand's timezone, e.g. "4 Nov, 9:55 am".
export function formatInstant(isoString, timezone) {
  if (!isoString) return "-";
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return "-";
  try {
    return new Intl.DateTimeFormat("en-IN", {
      timeZone: timezone || "Asia/Kolkata",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

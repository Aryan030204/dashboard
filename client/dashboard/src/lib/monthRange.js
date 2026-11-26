// Month arithmetic for the monthly conversion funnel. Months are "YYYY-MM" strings; `today` is "YYYY-MM-DD".

export const MAX_FUNNEL_MONTHS = 6;

const pad = (n) => String(n).padStart(2, "0");
const NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function addMonths(month, delta) {
  const total = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + delta;
  return `${Math.floor(total / 12)}-${pad((total % 12) + 1)}`;
}

export const monthLabel = (month) => `${NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

export const daysInMonth = (month) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();

// The current month and the five before it.
export function defaultMonthRange(today) {
  const to = today.slice(0, 7);
  return { from: addMonths(to, 1 - MAX_FUNNEL_MONTHS), to };
}

const earlier = (a, b) => (a < b ? a : b);
const later = (a, b) => (a > b ? a : b);

// Changing one end moves the other when needed, so the range stays in order and at most 6 months long.
export function withFrom(range, from, today) {
  const latest = earlier(addMonths(from, MAX_FUNNEL_MONTHS - 1), today.slice(0, 7));
  return { from, to: later(from, earlier(range.to, latest)) };
}

export function withTo(range, to) {
  const earliest = addMonths(to, 1 - MAX_FUNNEL_MONTHS);
  return { from: earlier(to, later(range.from, earliest)), to };
}

// Newest first; no future months.
export function monthOptions(today, count = 24) {
  const current = today.slice(0, 7);
  return Array.from({ length: count }, (_, i) => addMonths(current, -i));
}

// The request dates of a month range: whole months, except that the current month ends today.
export function monthRangeDates({ from, to }, today) {
  const end = to === today.slice(0, 7) ? today : `${to}-${pad(daysInMonth(to))}`;
  return { start: `${from}-01`, end };
}

// A finished month with fewer days of data than the calendar has.
export function isPartialMonth(date, daysWithData, today) {
  const month = date.slice(0, 7);
  return month < today.slice(0, 7) && Number(daysWithData) < daysInMonth(month);
}

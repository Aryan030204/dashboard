// Weekly view of the conversion funnel. A week is Monday to Sunday. Dates are "YYYY-MM-DD" strings.

const DAY_MS = 24 * 60 * 60 * 1000;
const NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const toMs = (date) => Date.parse(`${date}T00:00:00Z`);
const addDays = (date, days) => new Date(toMs(date) + days * DAY_MS).toISOString().slice(0, 10);
const weekday = (date) => (new Date(toMs(date)).getUTCDay() + 6) % 7; // Monday = 0

// Splits a date range into its complete weeks and the leftover days. Today is still running, so a week counts only once
// its Sunday is before today.
export function completeWeeks(start, end, today) {
  const weeks = [];
  const excluded = [];
  if (!start || !end || start > end) return { weeks, excluded };
  const lastFullDay = end < today ? end : addDays(today, -1);
  const firstMonday = addDays(start, (7 - weekday(start)) % 7);
  for (let monday = firstMonday; addDays(monday, 6) <= lastFullDay; monday = addDays(monday, 7)) {
    weeks.push({ start: monday, end: addDays(monday, 6) });
  }
  const leftover = (from, to) => {
    if (from <= to) excluded.push({ start: from, end: to, running: to >= today });
  };
  if (!weeks.length) leftover(start, end);
  else {
    leftover(start, addDays(weeks[0].start, -1));
    leftover(addDays(weeks[weeks.length - 1].end, 1), end);
  }
  return { weeks, excluded };
}

// Daily funnel rows summed into the given weeks (newest first); a row's `date` is the week's Monday.
export function sumRowsByWeek(dailyRows, weeks) {
  const byDate = new Map(dailyRows.map((row) => [row.date, row]));
  return weeks
    .map((week) => {
      const total = { date: week.start, days_with_data: 0 };
      const scores = []; // performance is a score: averaged, not added up
      let hasPerformance = false;
      for (let i = 0; i < 7; i += 1) {
        const day = byDate.get(addDays(week.start, i));
        if (!day) continue;
        if (Number(day.sessions) > 0 || Number(day.orders) > 0) total.days_with_data += 1;
        for (const [key, value] of Object.entries(day)) {
          if (key !== "date" && key !== "performance") total[key] = (total[key] || 0) + Number(value || 0);
        }
        if (day.performance !== undefined) {
          hasPerformance = true;
          if (day.performance !== null) scores.push(Number(day.performance));
        }
      }
      if (hasPerformance) total.performance = scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null;
      return total;
    })
    .sort((left, right) => right.date.localeCompare(left.date));
}

const parts = (date) => ({ day: Number(date.slice(8, 10)), month: NAMES[Number(date.slice(5, 7)) - 1], year: date.slice(0, 4) });

// "5 – 11 Oct 2026", "29 Jun – 5 Jul 2026", "28 Dec 2026 – 3 Jan 2027", or one day.
export function spanLabel(start, end) {
  const a = parts(start);
  const b = parts(end);
  if (start === end) return `${b.day} ${b.month} ${b.year}`;
  if (a.year !== b.year) return `${a.day} ${a.month} ${a.year} – ${b.day} ${b.month} ${b.year}`;
  if (a.month !== b.month) return `${a.day} ${a.month} – ${b.day} ${b.month} ${b.year}`;
  return `${a.day} – ${b.day} ${b.month} ${b.year}`;
}

export const weekLabel = (monday) => spanLabel(monday, addDays(monday, 6));

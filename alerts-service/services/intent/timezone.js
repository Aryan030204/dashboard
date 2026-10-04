// store_timezone looks like "(GMT+05:30) Asia/Kolkata" — returns the IANA name.
function parseIanaTimezone(storeTimezone) {
  if (!storeTimezone) return null;
  const match = String(storeTimezone).match(/\)\s*(.+)$/);
  return match ? match[1].trim() : null;
}

// Reinterprets a real UTC instant's wall-clock time in the store's timezone
// as if it were UTC, for display on the `occurred_at` field only. Internal
// logic (session gaps, cursor, ordering) must keep using the true instant.
function toStoreLocalOccurredAt(date, ianaTimezone) {
  if (!ianaTimezone) return date;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: ianaTimezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(date);
    const get = (type) => parts.find((p) => p.type === type)?.value;
    const year = Number(get("year"));
    const month = Number(get("month"));
    const day = Number(get("day"));
    let hour = Number(get("hour"));
    if (hour === 24) hour = 0; // some locales report midnight as 24
    const minute = Number(get("minute"));
    const second = Number(get("second"));
    return new Date(
      Date.UTC(year, month - 1, day, hour, minute, second, date.getUTCMilliseconds()),
    );
  } catch {
    return date;
  }
}

module.exports = { parseIanaTimezone, toStoreLocalOccurredAt };

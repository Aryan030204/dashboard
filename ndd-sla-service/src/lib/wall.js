// Conversions between real instants and "wall-clock" strings ("YYYY-MM-DD HH:mm:ss") in the report timezone.
// Everything the processor compares is a naive wall string; instants only appear at the edges (Gmail timestamps,
// scheduling), and are converted here with Intl so the host timezone never matters.

const pad2 = (n) => String(n).padStart(2, "0");

function partsInZone(ms, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = {};
  for (const { type, value } of fmt.formatToParts(new Date(ms))) p[type] = value;
  return p;
}

function toWall(ms, timeZone) {
  const p = partsInZone(ms, timeZone);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

function wallToParts(wall) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(String(wall));
  if (!m) throw new Error(`not a wall-clock string: ${wall}`);
  return m.slice(1).map(Number);
}

// Wall string in `timeZone` -> epoch ms. Two passes handle DST offsets; ambiguous/skipped times resolve to the
// earlier valid instant, which is irrelevant for IST (no DST).
function wallToEpochMs(wall, timeZone) {
  const [y, mo, d, h, mi, s] = wallToParts(wall);
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  let guess = asUtc;
  for (let i = 0; i < 2; i += 1) {
    const shown = wallToParts(toWall(guess, timeZone));
    const shownUtc = Date.UTC(shown[0], shown[1] - 1, shown[2], shown[3], shown[4], shown[5]);
    guess += asUtc - shownUtc;
  }
  return guess;
}

function addHoursWall(wall, hours) {
  const [y, mo, d, h, mi, s] = wallToParts(wall);
  const ms = Date.UTC(y, mo - 1, d, h, mi, s) + hours * 3600 * 1000;
  const x = new Date(ms);
  return `${x.getUTCFullYear()}-${pad2(x.getUTCMonth() + 1)}-${pad2(x.getUTCDate())} ${pad2(x.getUTCHours())}:${pad2(x.getUTCMinutes())}:${pad2(x.getUTCSeconds())}`;
}

function addDaysDate(date, days) {
  return addHoursWall(`${date} 00:00:00`, days * 24).slice(0, 10);
}

module.exports = { toWall, wallToEpochMs, addHoursWall, addDaysDate };
